/**
 * The optional after-draft hook, ~/.shelly/agents/after-draft-hook.js, against the
 * real executor, offline. Harness mirrors __tests__/plan-executor-digest-queue.test.ts.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { normalizeSteps } from '@/lib/agent-orchestration';
import { touchesProtectedPolicyFiles, classifyProposedCommand } from '@/lib/agent-boundary-policy';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';
import { examplePipeline, exampleDigestPipeline } from './fixtures/article-pipeline-config';

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const assetCopy = path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js');
const fixtureBroker = path.join(root, '__tests__', 'fixtures', 'fs-write-broker.js');
const broker = process.platform === 'win32' ? fixtureBroker : path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const AGENT_ID = 'agent-after-draft';
const HOOK_REL = '.shelly/agents/after-draft-hook.js';
const SOURCE_URL = 'https://example.org/doc';
const research = { content: `1. Item: 42 percent. ${SOURCE_URL}`, citations: [SOURCE_URL] };

// Records what the hook saw, in the home it was given.
const RECORDING_HOOK = `
const fs = require('fs');
const path = require('path');
const home = process.env.HOME;
const saved = process.argv[2];
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
fs.writeFileSync(path.join(home, 'seen.json'), JSON.stringify({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  draft: read(saved),
  queue: read(path.join(path.dirname(saved), '_queue.md')),
  lock: read(path.join(home, '.shelly/agents/locks/${AGENT_ID}.pid')),
  logs: fs.readdirSync(path.join(home, '.shelly/agents/logs/${AGENT_ID}')).filter((n) => /^\\d+\\.json$/.test(n)).length,
  progress: read(path.join(home, '.shelly/agents/logs/${AGENT_ID}/progress.jsonl')),
}));
`;

function tmpDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeHome(): string {
  const home = tmpDir('shelly-hook-home-');
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

function makeVault(): string {
  const vault = tmpDir('shelly-hook-vault-');
  fs.mkdirSync(path.join(vault, 'Drafts'));
  return vault;
}

function writeHook(home: string, body: string): string {
  const file = path.join(home, HOOK_REL);
  fs.writeFileSync(file, body);
  return file;
}

function chain(stream: 'example-a' | 'example-queue') {
  return normalizeSteps(examplePipeline(stream).orchestration).map((step) => {
    const { tool: _tool, toolPinned: _pinned, ...rest } = step;
    void _tool;
    void _pinned;
    return rest;
  });
}

function digestChain() {
  return normalizeSteps(exampleDigestPipeline().orchestration);
}

function writePlan(home: string, port: number, vault: string, outputDir: string, list: unknown[], longform = true): string {
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Fallback', autonomous: false, autonomyLevel: 'L2' },
    prompt: 'Base task',
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: 'draft' },
    paths: { home },
    output: { outputDir, outputNameTemplate: '{date}-x.md', slug: 'x', useGlobalOutput: false, suggestedRoots: [] },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    steps: { list, budget: { maxSteps: list.length, totalTimeoutMs: 30 * 60_000 }, ...(longform ? { longform: true } : {}) },
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(
    path.join(home, '.shelly/agents/.env'),
    `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\nOBSIDIAN_VAULT_PATH='${vault}'\n`,
  );
  return planFile;
}

function startExecutor(planFile: string, home: string, env: Record<string, string> = {}, brokerPath = broker): ChildProcess {
  return spawn(process.execPath, [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', brokerPath], {
    env: { ...process.env, HOME: home, SHELLY_TEST_LONGFORM_RETRY_WAIT_MS: '10', ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

function runExecutor(planFile: string, home: string, env: Record<string, string> = {}, brokerPath = broker): Promise<number | null> {
  return new Promise((resolve) => {
    startExecutor(planFile, home, env, brokerPath).on('close', (status) => resolve(status));
  });
}

function readRunLog(home: string): any {
  const logDir = path.join(home, `.shelly/agents/logs/${AGENT_ID}`);
  const files = fs.readdirSync(logDir).filter((n) => /^\d+\.json$/.test(n)).sort();
  return JSON.parse(fs.readFileSync(path.join(logDir, files[files.length - 1]), 'utf8'));
}

function hookAudit(home: string): any[] {
  const file = path.join(home, `.shelly/agents/logs/${AGENT_ID}/plan-executor-audit.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === 'after_draft_hook');
}

function notificationFile(home: string): string {
  return path.join(home, `.shelly/agents/logs/${AGENT_ID}/native-result-notification.json`);
}

function seen(home: string): any {
  return JSON.parse(fs.readFileSync(path.join(home, 'seen.json'), 'utf8'));
}

function symlinkOrSkip(target: string, link: string, type: 'dir' | 'file'): boolean {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch {
    return false;
  }
}

function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (check()) resolve(true);
      else if (Date.now() - started > ms) resolve(false);
      else setTimeout(tick, 50);
    };
    tick();
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the after-draft hook', () => {
  let server: http.Server;
  let port = 0;
  let prompts: string[];
  let replies: Array<string | { content: string; citations?: string[] }>;

  beforeEach((done) => {
    prompts = [];
    replies = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        prompts.push(JSON.parse(body).messages[0].content);
        const reply = replies[prompts.length - 1] ?? `RESULT#${prompts.length}`;
        const r = typeof reply === 'string' ? { content: reply } : reply;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          choices: [{ message: { content: r.content }, finish_reason: 'stop' }],
          ...(r.citations ? { citations: r.citations } : {}),
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  function goodRun(): void {
    replies = [research, '# Heading\n\nBody [1].', 'VERDICT: PASS'];
  }

  function streamPlan(home: string, vault: string): string {
    const dir = path.join(vault, 'Drafts', 'SeriesA');
    fs.mkdirSync(dir, { recursive: true });
    return writePlan(home, port, vault, dir, chain('example-a'));
  }

  function expectUnharmed(home: string, status: number | null): void {
    expect(status).toBe(0);
    expect(readRunLog(home).status).toBe('success');
    expect(fs.existsSync(notificationFile(home))).toBe(false);
    expect(fs.existsSync(path.join(home, `.shelly/agents/locks/${AGENT_ID}.pid`))).toBe(false);
  }

  it('no file: nothing runs and nothing is logged', async () => {
    const home = makeHome();
    goodRun();
    expectUnharmed(home, await runExecutor(streamPlan(home, makeVault()), home));
    expect(hookAudit(home)).toEqual([]);
  }, 30000);

  it('a hook gets the saved path as its one argument, after the run is recorded and finished', async () => {
    const home = makeHome();
    const vault = makeVault();
    writeHook(home, RECORDING_HOOK);
    goodRun();
    expectUnharmed(home, await runExecutor(streamPlan(home, vault), home));

    const s = seen(home);
    expect(s.argv).toEqual([path.join(vault, 'Drafts', 'SeriesA', path.basename(s.argv[0]))]);
    expect(s.draft).toContain('Body');
    expect(fs.realpathSync(s.cwd)).toBe(home);
    expect(s.logs).toBe(1);
    expect(String(s.lock).trim()).toMatch(/^\d+$/);
    expect(s.progress).toContain('run_end');
    expect(hookAudit(home).map((e) => e.status)).toEqual(['ok']);
    expect(Object.keys(hookAudit(home)[0]).sort()).toEqual(['agentId', 'event', 'kind', 'status', 'ts']);
  }, 30000);

  it('the environment holds no keys and none of the variables stripped from workers', async () => {
    const home = makeHome();
    writeHook(home, RECORDING_HOOK);
    goodRun();
    const fake = {
      GROQ_API_KEY: 'fake-1',
      ANTHROPIC_API_KEY: 'fake-2',
      GEMINI_API_KEY: 'fake-3',
      NODE_OPTIONS: '--no-warnings',
      BASH_ENV: '/nope',
      ENV: '/nope',
      CDPATH: '/nope',
      PROMPT_COMMAND: 'nope',
      LD_PRELOAD: '',
      SHELLY_CAP_BROKER: '1',
      TZ: 'UTC',
    };
    await runExecutor(streamPlan(home, makeVault()), home, fake);
    const { env } = seen(home);
    for (const name of Object.keys(fake)) {
      if (name !== 'TZ') expect(env[name]).toBeUndefined();
    }
    expect(env.TZ).toBe('UTC');
    expect(env.HOME).toBe(home);
    expect(JSON.stringify(env)).not.toContain('fake-');
  }, 30000);

  it('runs after the queue item is ticked', async () => {
    const home = makeHome();
    const vault = makeVault();
    const dir = path.join(vault, 'Drafts', 'SeriesB');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '_queue.md'), '- [ ] One\n- [ ] Two\n');
    writeHook(home, RECORDING_HOOK);
    goodRun();
    expectUnharmed(home, await runExecutor(writePlan(home, port, vault, dir, chain('example-queue')), home));
    expect(seen(home).queue).toBe('- [x] One\n- [ ] Two\n');
  }, 30000);

  it('an argument with shell characters arrives whole and nothing in it runs', async () => {
    const home = makeHome();
    const vault = makeVault();
    const odd = "a b;touch pwned&$(touch pwned2)'`touch pwned3`";
    const dir = path.join(vault, 'Drafts', odd);
    fs.mkdirSync(dir, { recursive: true });
    writeHook(home, RECORDING_HOOK);
    goodRun();
    expect(await runExecutor(writePlan(home, port, vault, dir, chain('example-a')), home)).toBe(0);
    expect(readRunLog(home).status).toBe('success');
    const s = seen(home);
    expect(s.argv).toHaveLength(1);
    expect(path.dirname(s.argv[0])).toBe(dir);
    for (const where of [home, path.dirname(s.argv[0]), process.cwd()]) {
      expect(fs.readdirSync(where).filter((n) => n.startsWith('pwned'))).toEqual([]);
    }
  }, 30000);

  it.each([
    ['a non-zero exit', 'process.exit(3);', 'failed'],
    ['a throw', 'throw new Error("nope");', 'failed'],
    ['a syntax error', 'this is not javascript', 'failed'],
  ])('%s does not touch the run', async (_name, body, status) => {
    const home = makeHome();
    writeHook(home, body);
    goodRun();
    expectUnharmed(home, await runExecutor(streamPlan(home, makeVault()), home));
    expect(hookAudit(home).map((e) => e.status)).toEqual([status]);
  }, 30000);

  it('a hanging hook is stopped at the limit and the run stays a success', async () => {
    const home = makeHome();
    writeHook(home, 'setInterval(() => {}, 1000);');
    goodRun();
    const planFile = streamPlan(home, makeVault());
    expectUnharmed(home, await runExecutor(planFile, home, { SHELLY_TEST_AFTER_DRAFT_HOOK_TIMEOUT_MS: '500' }));
    expect(hookAudit(home).map((e) => e.status)).toEqual(['timeout']);
  }, 30000);

  it('huge output goes nowhere', async () => {
    const home = makeHome();
    writeHook(home, `
const chunk = Buffer.alloc(1024 * 1024, 120);
let left = 64;
const pump = () => { if (left-- > 0) { process.stdout.write(chunk, pump); process.stderr.write('x'); } };
pump();
`);
    goodRun();
    expectUnharmed(home, await runExecutor(streamPlan(home, makeVault()), home));
    expect(hookAudit(home).map((e) => e.status)).toEqual(['ok']);
    expect(fs.statSync(path.join(home, `.shelly/agents/logs/${AGENT_ID}/plan-executor-audit.jsonl`)).size).toBeLessThan(64 * 1024);
  }, 60000);

  it('a symlinked hook is refused and its target does not run', async () => {
    const home = makeHome();
    const elsewhere = path.join(home, 'elsewhere.js');
    fs.writeFileSync(elsewhere, RECORDING_HOOK);
    if (!symlinkOrSkip(elsewhere, path.join(home, HOOK_REL), 'file')) return;
    goodRun();
    expectUnharmed(home, await runExecutor(streamPlan(home, makeVault()), home));
    expect(fs.existsSync(path.join(home, 'seen.json'))).toBe(false);
    expect(hookAudit(home).map((e) => e.status)).toEqual(['refused']);
  }, 30000);

  it('a hook reached through a linked agents folder is refused', async () => {
    const home = makeHome();
    const real = path.join(home, 'real-agents');
    fs.renameSync(path.join(home, '.shelly/agents'), real);
    if (!symlinkOrSkip(real, path.join(home, '.shelly/agents'), 'dir')) return;
    writeHook(home, RECORDING_HOOK);
    goodRun();
    expect(await runExecutor(streamPlan(home, makeVault()), home)).toBe(0);
    expect(fs.existsSync(path.join(home, 'seen.json'))).toBe(false);
    expect(hookAudit(home).map((e) => e.status)).toEqual(['refused']);
  }, 30000);

  it('a directory of that name is refused', async () => {
    const home = makeHome();
    fs.mkdirSync(path.join(home, HOOK_REL));
    goodRun();
    expectUnharmed(home, await runExecutor(streamPlan(home, makeVault()), home));
    expect(hookAudit(home).map((e) => e.status)).toEqual(['refused']);
  }, 30000);

  (process.platform === 'win32' ? it.skip : it)('a world-writable hook is refused on the real path', async () => {
    const home = makeHome();
    fs.chmodSync(writeHook(home, RECORDING_HOOK), 0o666);
    goodRun();
    expectUnharmed(home, await runExecutor(streamPlan(home, makeVault()), home));
    expect(fs.existsSync(path.join(home, 'seen.json'))).toBe(false);
    expect(hookAudit(home).map((e) => e.status)).toEqual(['refused']);
  }, 30000);

  it('the kill switch stops a running hook', async () => {
    const home = makeHome();
    writeHook(home, `
require('fs').writeFileSync(require('path').join(process.env.HOME, '.shelly/agents/.halted'), '1');
setInterval(() => {}, 1000);
`);
    goodRun();
    const started = Date.now();
    expect(await runExecutor(streamPlan(home, makeVault()), home)).toBe(0);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(hookAudit(home).map((e) => e.status)).toEqual(['halted']);
    expect(readRunLog(home).status).toBe('success');
    expect(fs.existsSync(notificationFile(home))).toBe(false);
  }, 90000);

  (process.platform === 'win32' ? it.skip : it)('SIGTERM from STOP-ALL ends the hook and what it started, and the run stays recorded', async () => {
    const home = makeHome();
    writeHook(home, `
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(process.env.HOME, 'pids'), process.pid + ' ' + kid.pid);
setInterval(() => {}, 1000);
`);
    goodRun();
    const child = startExecutor(streamPlan(home, makeVault()), home);
    const closed = new Promise<number | null>((resolve) => child.on('close', (status) => resolve(status)));
    const pidsFile = path.join(home, 'pids');
    expect(await waitFor(() => fs.existsSync(pidsFile) && fs.readFileSync(pidsFile, 'utf8').includes(' '), 20000)).toBe(true);
    child.kill('SIGTERM');
    expect(await closed).toBe(0);
    const pids = fs.readFileSync(pidsFile, 'utf8').split(' ').map(Number);
    expect(await waitFor(() => !pids.some(pidAlive), 3000)).toBe(true);
    expect(readRunLog(home).status).toBe('success');
    expect(hookAudit(home).map((e) => e.status)).toEqual(['halted']);
  }, 40000);

  (process.platform === 'win32' ? it.skip : it)('a timeout takes what the hook started with it', async () => {
    const home = makeHome();
    writeHook(home, `
const { spawn } = require('child_process');
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').writeFileSync(require('path').join(process.env.HOME, 'pids'), process.pid + ' ' + kid.pid);
setInterval(() => {}, 1000);
`);
    goodRun();
    await runExecutor(streamPlan(home, makeVault()), home, { SHELLY_TEST_AFTER_DRAFT_HOOK_TIMEOUT_MS: '1500' });
    const pids = fs.readFileSync(path.join(home, 'pids'), 'utf8').split(' ').map(Number);
    expect(await waitFor(() => !pids.some(pidAlive), 3000)).toBe(true);
  }, 40000);

  it('a same-day skipped run does not call it', async () => {
    const home = makeHome();
    const vault = makeVault();
    const dir = path.join(vault, 'Drafts', 'SeriesA');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, `${executor.localDateTimeStamps(new Date()).date}-x.md`), 'kept\n');
    writeHook(home, RECORDING_HOOK);
    await runExecutor(writePlan(home, port, vault, dir, chain('example-a')), home);
    expect(readRunLog(home).status).toBe('skipped');
    expect(fs.existsSync(path.join(home, 'seen.json'))).toBe(false);
    expect(hookAudit(home)).toEqual([]);
  }, 30000);

  it('a plan that is not longform does not call it', async () => {
    const home = makeHome();
    const vault = makeVault();
    const dir = path.join(vault, 'Drafts', 'SeriesA');
    fs.mkdirSync(dir);
    writeHook(home, RECORDING_HOOK);
    await runExecutor(writePlan(home, port, vault, dir, [{ instruction: 'one' }, { instruction: 'two' }], false), home);
    expect(readRunLog(home).status).toBe('success');
    expect(fs.existsSync(path.join(home, 'seen.json'))).toBe(false);
    expect(hookAudit(home)).toEqual([]);
  }, 30000);

  it('a draft that could not be saved does not call it', async () => {
    const home = makeHome();
    writeHook(home, RECORDING_HOOK);
    goodRun();
    await runExecutor(streamPlan(home, makeVault()), home, { SHELLY_TEST_FAIL_FS_WRITE: '1' }, fixtureBroker);
    expect(readRunLog(home).status).toBe('error');
    expect(fs.existsSync(path.join(home, 'seen.json'))).toBe(false);
    expect(hookAudit(home)).toEqual([]);
  }, 30000);

  it('a digest does not call it', async () => {
    const home = makeHome();
    const vault = makeVault();
    const dir = path.join(vault, 'Drafts', 'Digest');
    fs.mkdirSync(dir);
    writeHook(home, RECORDING_HOOK);
    expect(await runExecutor(writePlan(home, port, vault, dir, digestChain()), home)).toBe(0);
    expect(readRunLog(home).status).toBe('success');
    expect(JSON.parse(fs.readFileSync(notificationFile(home), 'utf8')).status).toBe('success');
    expect(fs.existsSync(path.join(home, 'seen.json'))).toBe(false);
    expect(hookAudit(home)).toEqual([]);
  }, 30000);

  it('a draft whose review never passed calls it too, for the hook to judge', async () => {
    const home = makeHome();
    writeHook(home, RECORDING_HOOK);
    replies = [research, '# Heading\n\nBody [1].', 'VERDICT: REVISE\n- a', '# Heading\n\nBody [1].', 'VERDICT: REVISE\n- b', '# Heading\n\nBody [1].'];
    expectUnharmed(home, await runExecutor(streamPlan(home, makeVault()), home));
    expect(seen(home).draft).toContain('review: unresolved');
  }, 30000);

  (process.platform === 'win32' ? it.skip : it)('what a hook started does not outlive a hook that exits on its own', async () => {
    const home = makeHome();
    writeHook(home, `
const { spawn } = require('child_process');
const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: false });
kid.unref();
require('fs').writeFileSync(require('path').join(process.env.HOME, 'pids'), String(kid.pid));
`);
    goodRun();
    expectUnharmed(home, await runExecutor(streamPlan(home, makeVault()), home));
    const pid = Number(fs.readFileSync(path.join(home, 'pids'), 'utf8'));
    expect(await waitFor(() => !pidAlive(pid), 3000)).toBe(true);
    expect(hookAudit(home).map((e) => e.status)).toEqual(['ok']);
  }, 30000);
});

describe('afterDraftHookUsable', () => {
  const stat = (over: Record<string, unknown>) => ({ isFile: () => true, nlink: 1, uid: 1000, mode: 0o100600, ...over });

  it('takes an owned regular file', () => {
    expect(executor.afterDraftHookUsable(stat({}), 1000)).toBe(true);
    expect(executor.afterDraftHookUsable(stat({ mode: 0o100644 }), 1000)).toBe(true);
  });

  it.each([
    ['a symlink as lstat reports it', { isFile: () => false, mode: 0o120777 }],
    ['another owner', { uid: 0 }],
    ['world-writable', { mode: 0o100606 }],
    ['group-writable', { mode: 0o100620 }],
    ['a second hard link', { nlink: 2 }],
  ])('refuses %s', (_name, over) => {
    expect(executor.afterDraftHookUsable(stat(over), 1000)).toBe(false);
  });
});

describe('afterDraftHookTimeoutMs', () => {
  afterEach(() => {
    delete process.env.SHELLY_TEST_AFTER_DRAFT_HOOK_TIMEOUT_MS;
  });

  it('is 120 s, and the test variable can only shorten it', () => {
    expect(executor.afterDraftHookTimeoutMs(0, 0)).toBe(120_000);
    process.env.SHELLY_TEST_AFTER_DRAFT_HOOK_TIMEOUT_MS = '999999999';
    expect(executor.afterDraftHookTimeoutMs(0, 0)).toBe(120_000);
    process.env.SHELLY_TEST_AFTER_DRAFT_HOOK_TIMEOUT_MS = '10';
    expect(executor.afterDraftHookTimeoutMs(0, 0)).toBe(10);
  });

  it('leaves the native 30-minute limit out of reach', () => {
    const minute = 60_000;
    expect(executor.afterDraftHookTimeoutMs(0, 27.5 * minute)).toBe(0.5 * minute);
    expect(executor.afterDraftHookTimeoutMs(0, 28 * minute)).toBeLessThanOrEqual(0);
  });
});

describe('the gate', () => {
  const ctx = { level: 'L2', workspaceRoot: '/root/app', policyPath: '.shelly/agents/policy.json' } as any;

  it.each([
    ['echo x > ~/.shelly/agents/after-draft-hook.js'],
    ['printf x >> "$HOME/.shelly/agents/after-draft-hook.js"'],
    ['cd ~/.shelly/agents && echo x > after-draft-hook.js'],
    ['cd ~/.shelly/agents; printf x > ./after-draft-hook.js'],
    ['tee -- /data/user/0/dev.shelly.terminal/files/home/.shelly/agents/after-draft-hook.js'],
    ['cd ~/.shelly/agents && tee after-draft-hook.js'],
    ['cp /tmp/x ~/.shelly/agents/after-draft-hook.js'],
    ['cd ~/.shelly/agents && cp /tmp/x after-draft-hook.js'],
    ['mv /tmp/x ~/.shelly/agents/after-draft-hook.js'],
    ['ln -s /tmp/x ~/.shelly/agents/after-draft-hook.js'],
    ['cd ~/.shelly/agents && ln /tmp/x after-draft-hook.js'],
    ['rm ~/.shelly/agents/after-draft-hook.js'],
    ['chmod 666 ~/.shelly/agents/after-draft-hook.js'],
    ['sed -i s/a/b/ ~/.shelly/agents/after-draft-hook.js'],
    [`node -e "require('fs').writeFileSync(process.env.HOME+'/.shelly/agents/after-draft-hook.js','')"`],
    [`cd ~/.shelly/agents && node -e "require('fs').writeFileSync('after-draft-hook.js','')"`],
    [`python3 -c "open('.shelly/agents/after-draft-hook.js','w')"`],
    ['curl -o ~/.shelly/agents/after-draft-hook.js http://127.0.0.1/x'],
    ['tar xf /tmp/a.tar -C ~/.shelly/agents after-draft-hook.js'],
    ['git show HEAD:x > ~/.shelly/agents/after-draft-hook.js'],
    ['f=after-draft-hook.js; echo x > ~/.shelly/agents/$f'],
    ['cp /tmp/x ~/.shelly/agents/after-draft-hook.j*'],
    ['tee after-draft-hook.js'],
    ['cat /tmp/x > after-draft-hook.js'],
    // The forms the driver builds from a Codex file change or a Claude Write.
    ["tee -- '/data/user/0/dev.shelly.terminal/files/home/.shelly/agents/after-draft-hook.js'"],
    ["rm -- '/data/user/0/dev.shelly.terminal/files/home/.shelly/agents/after-draft-hook.js'"],
    ["mv -- '/root/app/x.js' '/data/user/0/dev.shelly.terminal/files/home/.shelly/agents/after-draft-hook.js'"],
  ])('refuses %s', (command) => {
    expect(touchesProtectedPolicyFiles(command)).toBe(true);
    const verdict = classifyProposedCommand(command, ctx);
    expect(verdict.decision).toBe('deny');
    expect(verdict.signals).toContain('policy-write');
  });

  it.each([
    ['cat ~/.shelly/agents/after-draft-hook.js'],
    ['head -n 5 ~/.shelly/agents/after-draft-hook.js'],
    ['ls -la ~/.shelly/agents/after-draft-hook.js'],
  ])('lets %s read it', (command) => {
    expect(touchesProtectedPolicyFiles(command)).toBe(false);
  });

  it.each([
    ['cat ~/.shelly/agents/after-draft-hook.js > /tmp/x; cp /tmp/y ~/.shelly/agents/after-draft-hook.js'],
    ['cat /tmp/x | tee ~/.shelly/agents/after-draft-hook.js'],
    ['ls && tee ~/.shelly/agents/after-draft-hook.js'],
  ])('a read at the front does not pass %s', (command) => {
    expect(touchesProtectedPolicyFiles(command)).toBe(true);
  });

  it('leaves other commands alone', () => {
    expect(touchesProtectedPolicyFiles('echo x > ~/.shelly/agents/logs/a.txt')).toBe(false);
    expect(touchesProtectedPolicyFiles('tee hook.js')).toBe(false);
  });
});

describe('the executor version', () => {
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  it('is the same number everywhere, and the asset matches the script', () => {
    const script = fs.readFileSync(scriptCopy, 'utf8');
    const asset = fs.readFileSync(assetCopy, 'utf8');
    const runtime = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt');
    expect(executor.EXECUTOR_SCRIPT_VERSION).toBe(38);
    expect(/SHELLY_PLAN_EXECUTOR_SCRIPT_VERSION=(\d+)/.exec(script)![1]).toBe('38');
    expect(/^const EXECUTOR_SCRIPT_VERSION = (\d+);/m.exec(script)![1]).toBe('38');
    expect(/SHELLY_PLAN_EXECUTOR_SCRIPT_VERSION=(\d+)/.exec(asset)![1]).toBe('38');
    expect(/private const val CURRENT_EXECUTOR_VERSION = (\d+)/.exec(runtime)![1]).toBe('38');
    expect(asset).toBe(script);
  });
});
