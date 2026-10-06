/**
 * `shelly teach` — pure logic (lib/teach-mode.ts) and the controller's
 * start/stop/cancel/auto-stop state machine (lib/teach-controller.ts) with
 * injected file IO, converter, and workflow save.
 */
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })) },
}));
jest.mock('expo-file-system/legacy', () => ({}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/store/settings-store', () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));

import {
  TEACH_MAX_DURATION_MS,
  TEACH_MAX_STEPS,
  TEACH_NOTICE_PREFIX,
  fallbackConvert,
  isNoiseCommand,
  looksLikeSecret,
  parseTeachLlmResponse,
  parseTeachLog,
  sanitizeSteps,
  sanitizeWorkflowName,
  shouldAutoStop,
  teachConverterOrder,
  type TeachStep,
} from '@/lib/teach-mode';
import {
  __autoStopTickForTests,
  __resetTeachControllerForTests,
  handleTeachQueueLine,
  runTeachCommand,
  sweepOrphanedTeachLog,
  type TeachDeps,
  type TeachIO,
} from '@/lib/teach-controller';
import { useTeachStore } from '@/store/teach-store';

const step = (cmd: string, exitCode: number | null = 0, cwd = '/home/p', n?: number): TeachStep => ({
  n: n ?? Math.floor(Math.random() * 1e6),
  cmd,
  exitCode,
  cwd,
  ts: 0,
});

describe('parseTeachLog', () => {
  it('parses lines written by the bash hook, including escapes and multi-line commands', () => {
    // Verbatim output of __shelly_teach_capture under bash (see HomeInitializer.kt v242).
    const log = [
      '{"n":5,"cmd":"shelly teach start demo","ec":0,"cwd":"/h","ts":1}',
      '{"n":7,"cmd":"cd \\"my dir\\"","ec":0,"cwd":"/h/my dir","ts":2}',
      '{"n":9,"cmd":"echo \\"a\\\\b\\" | grep -c\\tx","ec":1,"cwd":"/h/my dir","ts":3}',
      '{"n":11,"cmd":"for i in 1 2; do\\necho $i\\ndone","ec":0,"cwd":"/h","ts":4}',
    ].join('\n');
    const steps = parseTeachLog(log);
    expect(steps.map((s) => s.cmd)).toEqual([
      'shelly teach start demo',
      'cd "my dir"',
      'echo "a\\b" | grep -c\tx',
      'for i in 1 2; do\necho $i\ndone',
    ]);
    expect(steps[2].exitCode).toBe(1);
    expect(steps[1].cwd).toBe('/h/my dir');
  });

  it('skips malformed/half-written lines, notices, and duplicate history numbers', () => {
    const log = [
      '#NOTICE something',
      '{"n":1,"cmd":"make","ec":0,"cwd":"/a","ts":1}',
      '{"n":1,"cmd":"make","ec":0,"cwd":"/a","ts":1}',
      '{"n":2,"cmd":"npm te',
      '{"n":3,"cmd":"git push","ec":null,"cwd":"/a","ts":1}',
    ].join('\n');
    const steps = parseTeachLog(log);
    expect(steps.map((s) => s.cmd)).toEqual(['make', 'git push']);
    expect(steps[1].exitCode).toBeNull();
  });
});

describe('secret filtering', () => {
  it.each([
    'export OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
    'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" https://x',
    'mysql -u root -phunter2secret db',
    'git clone https://user:pa55word@github.com/x/y.git',
    'tool login --token abcdef123456',
    'gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  ])('flags %s', (cmd) => {
    expect(looksLikeSecret(cmd)).toBe(true);
  });

  it.each(['git status', 'npm run build', 'cd ~/Projects/app', 'grep -rn token src/'])('does not flag %s', (cmd) => {
    expect(looksLikeSecret(cmd)).toBe(false);
  });

  it('drops secret steps and teach control commands, and counts secret drops', () => {
    const { steps, secretsDropped } = sanitizeSteps([
      step('shelly teach start x'),
      step('export GROQ_API_KEY=gsk_abcdefghijklmnopqrstuvwxyz'),
      step('git pull'),
      step('   '),
      step('shelly teach status'),
    ]);
    expect(steps.map((s) => s.cmd)).toEqual(['git pull']);
    expect(secretsDropped).toBe(1);
  });

  it('shifts the hook post-command $PWD to the directory each command ran in', () => {
    const { steps } = sanitizeSteps([
      step('shelly teach start', 0, '/h'),
      step('cd app', 0, '/h/app'),
      step('make', 0, '/h/app'),
    ]);
    expect(steps.map((s) => [s.cmd, s.cwd])).toEqual([
      ['cd app', '/h'],
      ['make', '/h/app'],
    ]);
  });

  it('caps at TEACH_MAX_STEPS', () => {
    const many = Array.from({ length: TEACH_MAX_STEPS + 10 }, (_, i) => step(`echo ${i}`));
    expect(sanitizeSteps(many).steps).toHaveLength(TEACH_MAX_STEPS);
  });
});

describe('fallbackConvert', () => {
  it('keeps successful commands verbatim, drops failures + noise, preserves cd', () => {
    const draft = fallbackConvert(
      [
        step('ls', 0, '/home/p'),
        step('cd app', 0, '/home/p/app'),
        step('gti status', 127, '/home/p/app'),
        step('git status', 0, '/home/p/app'),
        step('clear', 0, '/home/p/app'),
        step('npm run build', null, '/home/p/app'),
        step('npm run build', 0, '/home/p/app'),
        step('cd ..', 0, '/home/p'),
      ],
      'Build App',
    );
    expect(draft.commands).toEqual(['cd /home/p', 'cd app', 'git status', 'npm run build']);
    expect(draft.name).toBe('build-app');
    expect(draft.source).toBe('fallback');
  });

  it('does not prepend a cd when the routine already starts with one, and quotes odd paths', () => {
    expect(fallbackConvert([step('cd /x'), step('make')]).commands).toEqual(['cd /x', 'make']);
    expect(fallbackConvert([step('cd x', 0, '/h'), step('make')]).commands).toEqual(['cd /h', 'cd x', 'make']);
    expect(fallbackConvert([step('make', 0, "/h/it's here")]).commands[0]).toBe(`cd '/h/it'\\''s here'`);
  });

  it('derives a default name when none is given', () => {
    const now = new Date(2026, 9, 6, 9, 5).getTime();
    expect(fallbackConvert([step('git pull')], undefined, now).name).toBe('teach-git-20261006-0905');
  });

  it('returns no commands when everything failed or was noise', () => {
    expect(fallbackConvert([step('ls'), step('bad', 1)]).commands).toEqual([]);
  });

  it('noise detection is first-word based', () => {
    expect(isNoiseCommand('ls -la')).toBe(true);
    expect(isNoiseCommand('lsof -i')).toBe(false);
  });
});

describe('sanitizeWorkflowName', () => {
  it('strips anything unsafe for a shell path', () => {
    expect(sanitizeWorkflowName('../../etc/$(rm -rf)"x')).toBe('etc-rm-rf-x');
    expect(sanitizeWorkflowName('  Deploy Site  ')).toBe('deploy-site');
    expect(sanitizeWorkflowName(undefined)).toBe('');
  });
});

describe('parseTeachLlmResponse', () => {
  const steps = [step('cd app'), step('git add -A'), step('git commit -m "fix typo"'), step('git push')];

  it('accepts a grounded, parameterized answer (with think tags and prose around it)', () => {
    const raw =
      '<think>hmm</think>Here you go:\n{"name":"Commit And Push","description":"Commit all and push",' +
      '"commands":["cd app","git add -A","git commit -m \\"$1\\"","git push"],"params":["commit message"]}';
    const draft = parseTeachLlmResponse(raw, steps)!;
    expect(draft.name).toBe('commit-and-push');
    expect(draft.commands[2]).toBe('git commit -m "$1"');
    expect(draft.description).toContain('$1=commit message');
    expect(draft.source).toBe('local');
    expect(parseTeachLlmResponse(raw, steps, undefined, 0, 'cloud')!.source).toBe('cloud');
  });

  it('prefers the user-requested name', () => {
    const raw = '{"name":"x","description":"d","commands":["git push"]}';
    expect(parseTeachLlmResponse(raw, steps, 'ship')!.name).toBe('ship');
  });

  it.each([
    ['invented program', '{"name":"x","commands":["rm -rf ~"]}'],
    ['redaction marker', '{"name":"x","commands":["git push <redacted:token>"]}'],
    ['more commands than recorded', `{"name":"x","commands":${JSON.stringify(Array(5).fill('git push'))}}`],
    ['not JSON', 'sure! run git push'],
    ['empty commands', '{"name":"x","commands":[]}'],
  ])('rejects %s', (_label, raw) => {
    expect(parseTeachLlmResponse(raw, steps)).toBeNull();
  });
});

describe('teachConverterOrder (privacy)', () => {
  const local = { localLlmEnabled: true, localLlmUrl: 'http://127.0.0.1:8080', localLlmModel: 'q' };
  const keys = { cerebrasApiKey: 'csk-x', groqApiKey: 'gsk-x' };

  it('never uses cloud providers by default, even with API keys set', () => {
    expect(teachConverterOrder({ ...local, ...keys })).toEqual(['local']);
    expect(teachConverterOrder({ ...keys })).toEqual([]);
    expect(teachConverterOrder({ ...keys, teachAllowCloudLlm: false })).toEqual([]);
  });

  it('adds cloud providers after the local LLM only when explicitly allowed', () => {
    expect(teachConverterOrder({ ...local, ...keys, teachAllowCloudLlm: true })).toEqual(['local', 'cerebras', 'groq']);
    expect(teachConverterOrder({ groqApiKey: 'gsk-x', teachAllowCloudLlm: true })).toEqual(['groq']);
  });

  it('skips a local LLM that is not fully configured', () => {
    expect(teachConverterOrder({ ...local, localLlmEnabled: false })).toEqual([]);
    expect(teachConverterOrder({ ...local, localLlmModel: '' })).toEqual([]);
  });
});

describe('shouldAutoStop', () => {
  it('stops on step count or elapsed time', () => {
    expect(shouldAutoStop(0, 3, 1000)).toBeNull();
    expect(shouldAutoStop(0, TEACH_MAX_STEPS, 1000)).toBe('steps');
    expect(shouldAutoStop(0, 1, TEACH_MAX_DURATION_MS)).toBe('time');
  });
});

// ─── controller ─────────────────────────────────────────────────────────────

function makeIO() {
  const files = new Map<string, string>();
  const io: TeachIO = {
    homeUri: () => 'file:///home',
    read: async (u) => (files.has(u) ? files.get(u)! : null),
    write: async (u, c) => { files.set(u, c); },
    remove: async (u) => { files.delete(u); },
  };
  return { io, files };
}
const LOG_URI = 'file:///home/.shelly-teach.jsonl';
const line = (n: number, cmd: string, ec = 0) => JSON.stringify({ n, cmd, ec, cwd: '/home/p', ts: n }) + '\n';

describe('teach controller', () => {
  let now = 1_000_000;
  let saved: any[];
  let deps: TeachDeps;
  let files: Map<string, string>;

  beforeEach(() => {
    jest.useFakeTimers();
    __resetTeachControllerForTests();
    useTeachStore.setState({ recording: null, finishing: false });
    saved = [];
    const m = makeIO();
    files = m.files;
    deps = {
      io: m.io,
      convert: async (steps, name) => fallbackConvert(steps, name, now),
      save: async (d) => { saved.push(d); },
      exists: async (name) => name === 'demo',
      now: () => now,
    };
  });
  afterEach(() => {
    __resetTeachControllerForTests();
    jest.useRealTimers();
  });

  it('start creates the capture log; a second start is rejected', async () => {
    const r = await runTeachCommand('start', 'demo', deps);
    expect(r.ok).toBe(true);
    expect(files.get(LOG_URI)).toBe('');
    expect(useTeachStore.getState().recording?.name).toBe('demo');
    const again = await runTeachCommand('start', 'other', deps);
    expect(again.ok).toBe(false);
  });

  it('stop converts, de-duplicates the name, saves, deletes the log, and runs nothing', async () => {
    await runTeachCommand('start', 'demo', deps);
    files.set(LOG_URI, line(1, 'shelly teach start demo') + line(2, 'cd app') + line(3, 'make test') + line(4, 'mkae', 127));
    const r = await runTeachCommand('stop', undefined, deps);
    expect(r.ok).toBe(true);
    expect(files.has(LOG_URI)).toBe(false);
    expect(useTeachStore.getState().recording).toBeNull();
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe('demo-2'); // 'demo' already exists
    expect(saved[0].commands).toEqual(['cd /home/p', 'cd app', 'make test']);
    expect(r.lines.join('\n')).toContain('~/.shelly/workflows/demo-2.sh');
  });

  it('stop with nothing useful saves nothing', async () => {
    await runTeachCommand('start', undefined, deps);
    files.set(LOG_URI, line(1, 'ls') + line(2, 'clear'));
    const r = await runTeachCommand('stop', undefined, deps);
    expect(r.ok).toBe(true);
    expect(saved).toHaveLength(0);
  });

  it('stop/cancel without a recording fail cleanly', async () => {
    expect((await runTeachCommand('stop', undefined, deps)).ok).toBe(false);
    expect((await runTeachCommand('cancel', undefined, deps)).ok).toBe(false);
  });

  it('cancel discards the log without saving', async () => {
    await runTeachCommand('start', 'x', deps);
    files.set(LOG_URI, line(1, 'make'));
    expect((await runTeachCommand('cancel', undefined, deps)).ok).toBe(true);
    expect(files.has(LOG_URI)).toBe(false);
    expect(saved).toHaveLength(0);
  });

  it('status reports step count', async () => {
    await runTeachCommand('start', 'x', deps);
    files.set(LOG_URI, line(1, 'shelly teach start x') + line(2, 'make'));
    const r = await runTeachCommand('status', undefined, deps);
    expect(r.lines[0]).toContain('1/50');
  });

  it('auto-stops at the step limit, saves, and leaves a one-shot notice for bash', async () => {
    await runTeachCommand('start', 'big', deps);
    files.set(LOG_URI, Array.from({ length: TEACH_MAX_STEPS }, (_, i) => line(i + 1, `echo ${i}`)).join(''));
    await __autoStopTickForTests(deps);
    expect(saved).toHaveLength(1);
    expect(useTeachStore.getState().recording).toBeNull();
    expect(files.get(LOG_URI)!.startsWith(TEACH_NOTICE_PREFIX)).toBe(true);
    // A later explicit stop explains the auto-save instead of erroring.
    const r = await runTeachCommand('stop', undefined, deps);
    expect(r.ok).toBe(true);
    expect(r.lines.join('\n')).toContain('big.sh');
  });

  it('auto-stops after the time limit', async () => {
    await runTeachCommand('start', 't', deps);
    files.set(LOG_URI, line(1, 'make'));
    now += TEACH_MAX_DURATION_MS;
    await __autoStopTickForTests(deps);
    expect(saved).toHaveLength(1);
  });

  it('does not auto-stop below the limits', async () => {
    await runTeachCommand('start', 't', deps);
    files.set(LOG_URI, line(1, 'make'));
    await __autoStopTickForTests(deps);
    expect(useTeachStore.getState().recording).not.toBeNull();
  });

  it('orphan sweep removes a stale log but keeps a pending notice', async () => {
    const m = makeIO();
    m.files.set(LOG_URI, line(1, 'make'));
    await sweepOrphanedTeachLog(m.io);
    expect(m.files.has(LOG_URI)).toBe(false);
    m.files.set(LOG_URI, `${TEACH_NOTICE_PREFIX}hi\n`);
    await sweepOrphanedTeachLog(m.io);
    expect(m.files.has(LOG_URI)).toBe(true);
  });

  it('queue lines with a malformed request id are ignored', async () => {
    const m = makeIO();
    await handleTeachQueueLine('teach:../../x:start', m.io);
    expect(m.files.size).toBe(0);
  });
});
