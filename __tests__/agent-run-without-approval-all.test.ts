/**
 * "承認なしで実行（すべて）" — the "all" level of lib/agent-run-without-approval.ts
 * (2026-11-01, on-device rehearsal build 2772).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  __setRunWithoutApprovalStorageForTests,
  ALL_LEVEL_CONDITIONAL_REASONS,
  ALL_LEVEL_SOFT_REASONS,
  decideActionAutoApproval,
  detectRunWithoutApprovalIntent,
  detectRunWithoutApprovalLevel,
  entryLevel,
  escalationAutoApprovable,
  getRunWithoutApprovalSetting,
  isRunWithoutApprovalEnabled,
  loadRunWithoutApproval,
  runWithoutApprovalAllAllowedFor,
  runWithoutApprovalAuditKey,
  runWithoutApprovalDefinitionHash,
  setRunWithoutApproval,
  stripRunWithoutApprovalPhrases,
  type EscalationAutoApproveOpts,
} from '@/lib/agent-run-without-approval';
import { classifyProposedCommand } from '@/lib/agent-boundary-policy';
import { parseAgentNL, detectAutonomousIntent } from '@/lib/agent-nl-parser';
import { draftToConfirmedAgentDraft, summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const HOME = '/data/user/0/dev.shelly.terminal/files/home';
const HOME_PATHS = [HOME, '/data/data/dev.shelly.terminal/files/home'];
const WS = `${HOME}/demo`;

function memoryStorage(initial: string | null = null) {
  let value = initial;
  return {
    get: jest.fn(async () => value),
    set: jest.fn(async (v: string) => { value = v; }),
    peek: () => value,
  };
}

const agent = {
  id: 'agent-all',
  prompt: 'build two brick breaker games',
  schedule: null,
  tool: { type: 'cli', cli: 'codex' },
  workspaceRoot: WS,
  outputPath: '$HOME/.shelly/agents/a/output.md',
};

beforeEach(() => __setRunWithoutApprovalStorageForTests(memoryStorage()));
afterAll(() => __setRunWithoutApprovalStorageForTests(null));

/** A gray escalation exactly as the gate would file it for `command` with
 *  the driver's cwd / root `root`. */
function gateRequest(command: string, root = WS) {
  const verdict = classifyProposedCommand(command, { workspaceRoot: root, level: 'L2' });
  return { verdict, request: { command, signals: verdict.signals, reason: verdict.reason, cwd: root, workspaceRoot: root } };
}

const allOpts: EscalationAutoApproveOpts = {
  enabled: true,
  trustedWorkspaceRoot: WS,
  homePaths: HOME_PATHS,
  level: 'all',
  attended: true,
};
const standardOpts: EscalationAutoApproveOpts = { ...allOpts, level: 'standard' };

describe('storage: levels and backward compatibility', () => {
  it('an entry written before levels existed (no `level`) reads as standard', async () => {
    const legacy = [{ agentId: agent.id, enabledAt: 1, via: 'chat', definitionHash: runWithoutApprovalDefinitionHash(agent) }];
    __setRunWithoutApprovalStorageForTests(memoryStorage(JSON.stringify(legacy)));
    expect(await getRunWithoutApprovalSetting(agent)).toBe('standard');
    expect(await isRunWithoutApprovalEnabled(agent)).toBe(true);
  });

  it('setRunWithoutApproval(true) = standard, written without a level field (byte-compatible)', async () => {
    const store = memoryStorage();
    __setRunWithoutApprovalStorageForTests(store);
    await setRunWithoutApproval(agent, true, 'detail');
    expect(await getRunWithoutApprovalSetting(agent)).toBe('standard');
    expect(JSON.parse(store.peek() as string)[0]).not.toHaveProperty('level');
  });

  it("'all' is stored and read back; 'off' / false removes the entry", async () => {
    await setRunWithoutApproval(agent, 'all', 'chat');
    expect(await getRunWithoutApprovalSetting(agent)).toBe('all');
    await setRunWithoutApproval(agent, 'standard', 'detail');
    expect(await getRunWithoutApprovalSetting(agent)).toBe('standard');
    await setRunWithoutApproval(agent, 'off', 'detail');
    expect(await getRunWithoutApprovalSetting(agent)).toBe('off');
    await setRunWithoutApproval(agent, 'all', 'detail');
    await setRunWithoutApproval(agent, false, 'detail');
    expect(await loadRunWithoutApproval()).toEqual([]);
  });

  it('a malformed level never raises it above standard', async () => {
    const hash = runWithoutApprovalDefinitionHash(agent);
    __setRunWithoutApprovalStorageForTests(memoryStorage(JSON.stringify([
      { agentId: agent.id, enabledAt: 1, via: 'chat', definitionHash: hash, level: 'ALL' },
    ])));
    expect(await getRunWithoutApprovalSetting(agent)).toBe('standard');
    expect(entryLevel({ level: 'everything' as never })).toBe('standard');
    expect(entryLevel(null)).toBe('standard');
  });

  it("'all' is bound to the definition hash like the standard level (an edited agent reads OFF)", async () => {
    await setRunWithoutApproval(agent, 'all', 'chat');
    expect(await getRunWithoutApprovalSetting({ ...agent, workspaceRoot: `${HOME}/other` })).toBe('off');
    expect(await getRunWithoutApprovalSetting({ ...agent, prompt: 'rm everything' })).toBe('off');
  });

  it('the level lives only in SecureStore: the Agent type never carries it', () => {
    expect(read('store/types.ts')).not.toMatch(/runWithoutApproval/);
    expect(read('lib/agent-run-without-approval.ts')).toMatch(/require\('expo-secure-store'\)/);
  });
});

describe('the rehearsal asks (build 2772)', () => {
  const CS = `${HOME}/projects/shelly-content-studio`;
  const run = (command: string, root: string, trusted: string) => {
    const { verdict, request } = gateRequest(command, root);
    expect(verdict.decision).toBe('gray');
    return {
      std: escalationAutoApprovable(request, { ...standardOpts, trustedWorkspaceRoot: trusted }),
      all: escalationAutoApprovable(request, { ...allOpts, trustedWorkspaceRoot: trusted }),
    };
  };

  it('file writes into ~/demo (workspace still the content project): standard refuses, all allows', () => {
    for (const command of [
      "bash -lc 'mkdir -p ~/demo && tee ~/demo/claude.html < /dev/null'",
      "bash -lc 'rm -rf ~/demo/old-build'",
    ]) {
      const { std, all } = run(command, CS, CS);
      expect([command, std.ok]).toEqual([command, false]);
      expect([command, all]).toEqual([command, { ok: true, kind: 'all' }]);
    }
  });

  const HEREDOC_GAME = "bash -lc \"cat > ~/demo/codex.html <<'EOF'\n<html><body><canvas id=c></canvas><script>document.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') x -= dx; label.textContent = 'score ${score}'; });</script></body></html>\nEOF\"";

  it('a heredoc into ~/demo: allowed when ~/demo is the workspace, asks when it is not', () => {
    // (Backticks in a QUOTED heredoc body no longer carry indirect-exec —
    // see the BACKTICK_GAME tests below; an unquoted body still does.)
    expect(run(HEREDOC_GAME, CS, WS).all).toEqual({ ok: true, kind: 'all' });
    expect(run(HEREDOC_GAME, CS, CS).all.ok).toBe(false);
  });

  // 2026-11-02 rehearsal (m): codex's shlex-joined argv, body with JS
  // template literals and `$(` — literal data in a QUOTED heredoc.
  const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
  const BACKTICK_GAME = `bash -lc ${sq("cat > ~/demo/codex.html <<'EOF'\n<html><body><script>const label = `score ${score}`; const el = $('#c');</script></body></html>\nEOF")}`;

  it('a quoted heredoc body with backticks / $( no longer carries indirect-exec: all allows it into the workspace', () => {
    const { verdict } = gateRequest(BACKTICK_GAME, CS);
    expect(verdict.signals).not.toContain('indirect-exec');
    expect(run(BACKTICK_GAME, CS, WS).all).toEqual({ ok: true, kind: 'all' });
    // Outside the trusted workspace the body is not skipped: it asks.
    expect(run(BACKTICK_GAME, CS, CS).all.ok).toBe(false);
  });

  it('an UNQUOTED heredoc body with backticks still carries indirect-exec and asks', () => {
    const cmd = `bash -lc ${sq('cat > ~/demo/codex.html <<EOF\n<script>const label = `score`;</script>\nEOF')}`;
    const { verdict } = gateRequest(cmd, CS);
    expect(verdict.signals).toContain('indirect-exec');
    expect(run(cmd, CS, WS).all).toMatchObject({ ok: false, reason: 'signal:indirect-exec' });
  });

  it("a split delimiter word (<<'EO'F = EOF to bash) is not read as EO: the command after the real terminator is judged", () => {
    for (const script of [
      "cat > ~/demo/a.txt <<'EO'F\nhello\nEOF\nrm -rf ~/bin",
      "cat > ~/demo/a.txt <<'E'O\"F\"\nhello\nEOF\nrm -rf ~/bin",
      "cat > ~/demo/a.txt <<E'OF'\nhello\nEOF\nrm -rf ~/bin",
    ]) {
      const cmd = `bash -lc ${sq(script)}`;
      expect([script, run(cmd, CS, WS).all.ok]).toEqual([script, false]);
    }
    // The plain shape still writes.
    expect(run(`bash -lc ${sq("cat > ~/demo/a.txt <<'EOF'\nhello\nEOF")}`, CS, WS).all).toEqual({ ok: true, kind: 'all' });
  });

  it('a substitution after the quoted heredoc still carries indirect-exec and asks', () => {
    const cmd = `bash -lc ${sq("cat > ~/demo/a.html <<'EOF'\n`x`\nEOF\nrm -rf $(echo ~/bin)")}`;
    const { verdict } = gateRequest(cmd, CS);
    expect(verdict.signals).toContain('indirect-exec');
    expect(run(cmd, CS, WS).all.ok).toBe(false);
  });

  it('read-only syntax checks of workspace files are allowed (workspace ~/demo)', () => {
    for (const command of [
      "bash -lc 'node --check game.js'",
      "bash -lc 'node -c ~/demo/game.js'",
      "bash -lc 'python3 -m py_compile a.py b.py'",
      "bash -lc 'bash -n build.sh'",
      "bash -lc 'node --check game.js 2>&1'",
    ]) {
      const { verdict, request } = gateRequest(command, WS);
      if (verdict.decision !== 'gray') continue; // the gate allows it outright
      expect([command, escalationAutoApprovable(request, allOpts)]).toEqual([command, { ok: true, kind: 'all' }]);
    }
  });

  it('bare version probes are allowed: node|python3|python|git|bash --version, nothing else', () => {
    let reachedGray = 0;
    for (const command of [
      "bash -lc 'node --version'",
      "bash -lc 'python3 --version'",
      "bash -lc 'python --version'",
      "bash -lc 'git --version'",
      "bash -lc 'bash --version'",
    ]) {
      const { verdict, request } = gateRequest(command, WS);
      if (verdict.decision !== 'gray') continue; // the gate allows it outright
      reachedGray += 1;
      expect([command, escalationAutoApprovable(request, allOpts)]).toEqual([command, { ok: true, kind: 'all' }]);
    }
    expect(reachedGray).toBeGreaterThan(0);
    const refused: Array<[string, string]> = [
      ["bash -lc 'node --version --inspect'", 'signal:opaque-script-exec'],
      ["bash -lc 'node --version x.js'", 'signal:opaque-script-exec'],
      ["bash -lc 'python3 --version -c 1'", 'signal:opaque-script-exec'],
      ["bash -lc 'node --version | tee out'", 'signal:opaque-script-exec'],
      ["bash -lc 'node --version > out'", 'signal:opaque-script-exec'],
      ["bash -lc 'perl --version'", 'signal:opaque-script-exec'],
      ["bash -lc 'node --version && node build.js'", 'signal:opaque-script-exec'],
    ];
    for (const [command, reason] of refused) {
      const { verdict, request } = gateRequest(command, WS);
      if (verdict.decision !== 'gray') continue; // never reaches a human
      expect([command, escalationAutoApprovable(request, allOpts)]).toEqual([command, { ok: false, reason }]);
    }
  });

  it('H1: running code still asks — node -e, python -c, a script the agent wrote, $(…)', () => {
    const cases: Array<[string, string]> = [
      ["bash -lc \"python3 -c 'import html.parser; html.parser.HTMLParser().feed(open(\\\"codex.html\\\").read())'\"", 'signal:opaque-script-exec'],
      ["bash -lc 'node -e \"require(1)\"'", 'signal:opaque-script-exec'],
      ["bash -lc 'node build.js'", 'signal:opaque-script-exec'],
      ["bash -lc 'python3 tool.py'", 'signal:opaque-script-exec'],
      ["bash -lc 'bash run.sh'", 'signal:opaque-script-exec'],
      ["bash -lc 'chmod +x run.sh && ./run.sh'", 'script-exec'],
      ["bash -lc 'node --check game.js | tee out'", 'signal:opaque-script-exec'],
      ["bash -lc 'node --check --inspect game.js'", 'signal:opaque-script-exec'],
      ["bash -lc 'node --check ~/notes/game.js'", 'signal:opaque-script-exec'], // outside the workspace
      ["bash -lc 'python3 -m pip install x'", 'signal:opaque-script-exec'],
      ["bash -lc 'tmp=$(mktemp -d); cp codex.html \"$tmp\"/; rm -rf \"$tmp\"'", 'signal:indirect-exec'],
    ];
    for (const [command, reason] of cases) {
      const { verdict, request } = gateRequest(command);
      if (verdict.decision !== 'gray') continue; // never reaches a human
      expect([command, escalationAutoApprovable(request, allOpts)]).toEqual([command, { ok: false, reason }]);
    }
  });

  it('H1: a script written then run in one command still asks', () => {
    const command = "bash -lc 'cat > x.sh <<EOF\ncat ~/.bashrc\nEOF\nbash x.sh'";
    const { request } = gateRequest(command);
    expect(escalationAutoApprovable(request, allOpts).ok).toBe(false);
  });
});

function isSoftLike(reason: string): boolean {
  return ALL_LEVEL_SOFT_REASONS.has(reason) || ALL_LEVEL_CONDITIONAL_REASONS.has(reason) || /^(?:tool|option):/.test(reason);
}

describe('standard vs all — per reason', () => {
  /** Only a GRAY gate verdict reaches a human (and this module) at all. */
  const allow = (command: string, opts: Partial<EscalationAutoApproveOpts> = {}) => {
    const { verdict, request } = gateRequest(command);
    if (verdict.decision !== 'gray') return { ok: false, reason: `gate:${verdict.decision}` };
    return escalationAutoApprovable(request, { ...allOpts, ...opts });
  };

  it('soft reasons are lifted under all (destructive HIGH, home-path, glob, parent, dir-change, heredoc)', () => {
    for (const command of [
      "bash -lc 'rm -rf build'",                       // signal:destructive (HIGH)
      "bash -lc 'cp a.html ~/notes/a.html'",           // home-path / write-outside-root (inside home)
      "bash -lc 'rm -f ~/notes/*.tmp'",                // glob
      "bash -lc 'cp a.html ../backup/a.html'",         // parent-path (stays in home)
      "bash -lc 'cd ~/notes && touch x'",              // dir-change-write
      "bash -lc 'chmod 644 ~/notes/a.md'",             // tool:chmod (a file tool)
      "bash -lc 'cat > notes.md <<EOF\nhello </b> http://x.test/a\nEOF'", // indirect (heredoc into the workspace)
      "bash -lc \"cat > a.js <<'EOF'\nconst s = '${x}';\nEOF\"", // quoted heredoc: ${…} is literal
    ]) {
      const { request } = gateRequest(command);
      const std = escalationAutoApprovable(request, standardOpts);
      expect([command, std.ok]).toEqual([command, false]);
      if (std.ok === false) expect([command, isSoftLike(std.reason)]).toEqual([command, true]);
      expect([command, allow(command)]).toEqual([command, { ok: true, kind: 'all' }]);
    }
  });

  it('heredoc: unquoted body with $ / a target outside the workspace / not cat-tee is checked', () => {
    expect(allow("bash -lc 'cat > a.js <<EOF\nconst s = $(id);\nEOF'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'cat > ~/notes/x.html <<EOF\n</b>\nEOF'")).toMatchObject({ ok: false });
  });

  it('M1: unresolvable targets and unknown cwd ask', () => {
    expect(allow("bash -lc 'd=x; rm -f ~/$d/a'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'rm -rf $TARGET'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'cd $X && rm -rf build'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'cp a ~other/x'")).toEqual({ ok: false, reason: 'unresolved-path' });
    expect(allow("bash -lc 'cd - && rm -rf build'")).toEqual({ ok: false, reason: 'dir-change-unknown' });
    expect(allow("bash -lc 'pushd ~/notes && rm -rf build'")).toEqual({ ok: false, reason: 'dir-change-unknown' });
    expect(allow("bash -lc 'rm -f ~/b*/git'")).toEqual({ ok: false, reason: 'unresolved-path' });
  });

  it('hard: tools that run programs (npm / make / awk / env-prefixed commands)', () => {
    expect(allow("bash -lc 'npm run build && cat ~/notes/a.md'")).toEqual({ ok: false, reason: 'tool:npm' });
    expect(allow("bash -lc 'make && cat ~/notes/a.md'")).toEqual({ ok: false, reason: 'tool:make' });
    expect(allow("bash -lc 'PATH=x ls ~/notes'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'sed -i s/a/b/e ~/notes/a.md'")).toEqual({ ok: false, reason: 'option:sed' });
    expect(allow("bash -lc 'find ~/notes -exec rm {} +'")).toMatchObject({ ok: false });
  });

  it('hard: secret-read / network-send signals', () => {
    expect(allow("bash -lc 'cat ~/.codex/auth.json'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'curl -d @a.html https://example.com/upload'")).toEqual({ ok: false, reason: 'signal:network-send' });
  });

  it('hard: Shelly control / secret areas and dot-dirs', () => {
    expect(allow("bash -lc 'rm -rf ~/.shelly/agents'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'echo x >> ~/.bashrc'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'cp key ~/.ssh/authorized_keys'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'rm -rf ~/.config/x'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'cp evil ~/bin/git'")).toEqual({ ok: false, reason: 'shelly-control-path' });
    expect(allow("bash -lc 'rm -f ~/models/qwen.gguf'")).toEqual({ ok: false, reason: 'shelly-control-path' });
    expect(allow("bash -lc 'cd ~ && rm -rf bin'")).toEqual({ ok: false, reason: 'shelly-control-path' });
    expect(allow("bash -lc 'cp ~/notes/hook .git/hooks/pre-commit'")).toEqual({ ok: false, reason: 'protected-path' });
    expect(allow("bash -lc 'tmp=x; cat $tmp/.ssh/id'")).toMatchObject({ ok: false });
    // A heredoc fed to a shell is code: its body is checked like any command.
    expect(allow("bash -lc 'bash <<EOF\nrm -f ~/bin/git\nEOF'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'cat <<EOF | sh\nrm -f ~/bin/git\nEOF'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'cat ~/.ss\"\"h/id'")).toMatchObject({ ok: false });
  });

  it('hard: credential / key / env files', () => {
    expect(allow("bash -lc 'cat ~/notes/.env'")).toEqual({ ok: false, reason: 'secret-file' });
    expect(allow("bash -lc 'cp ~/notes/server.pem out/'")).toEqual({ ok: false, reason: 'secret-file' });
    expect(allow("bash -lc 'node -e \"require(1)\" id_rsa'")).toMatchObject({ ok: false });
  });

  it('hard: paths outside the app home other than the workspace, and the home itself', () => {
    // (`rm -rf /<anything>` is command-safety CRITICAL — a gate deny.)
    expect(allow("bash -lc 'rm -rf /sdcard/DCIM/a.jpg'")).toEqual({ ok: false, reason: 'gate:deny' });
    expect(allow("bash -lc 'rm -f /sdcard/DCIM/a.jpg'")).toEqual({ ok: false, reason: 'outside-home' });
    expect(allow("bash -lc 'cp a.html /sdcard/Download/a.html'")).toEqual({ ok: false, reason: 'outside-home' });
    expect(allow("bash -lc 'chmod -R 755 ~'")).toEqual({ ok: false, reason: 'home-root' });
    expect(allow("bash -lc 'rm -f ~/*.log'")).toMatchObject({ ok: false });
    // A workspace outside the home (validated by validateWorkspaceRoot) is allowed by name.
    const sd = '/sdcard/Documents/site';
    const { request } = gateRequest("bash -lc 'cp ~/notes/out.html /sdcard/Documents/site/index.html'", sd);
    expect(escalationAutoApprovable(request, { ...allOpts, trustedWorkspaceRoot: sd })).toEqual({ ok: true, kind: 'all' });
  });

  it('hard: system tools and network git / publish', () => {
    expect(allow("bash -lc 'settings put global x 1 && touch ~/notes/a'")).toEqual({ ok: false, reason: 'system-tool:settings' });
    expect(allow("bash -lc 'am start -a x; touch ~/notes/a'")).toEqual({ ok: false, reason: 'system-tool:am' });
    expect(allow("bash -lc 'pkill -9 node; touch a'")).toMatchObject({ ok: false });
    expect(allow("bash -lc 'git add ~/notes/a && git push origin main'")).toEqual({ ok: false, reason: 'network-tool' });
    expect(allow("bash -lc 'node x.js && npm publish'")).toEqual({ ok: false, reason: 'network-tool' });
  });

  it('hard: the existing hard reasons stay hard (policy-ask, not-live, not-boundary-gray, no-signals)', () => {
    const { request } = gateRequest("bash -lc 'rm -rf build'");
    expect(escalationAutoApprovable(request, { ...allOpts, policyBlocksAutoAccept: true })).toEqual({ ok: false, reason: 'policy-ask' });
    expect(escalationAutoApprovable({ ...request, state: 'queued' }, allOpts)).toEqual({ ok: false, reason: 'not-live' });
    expect(escalationAutoApprovable({ ...request, reason: 'policy: ask rule' }, allOpts)).toEqual({ ok: false, reason: 'not-boundary-gray' });
    expect(escalationAutoApprovable({ ...request, signals: [] }, allOpts)).toEqual({ ok: false, reason: 'no-signals' });
    expect(escalationAutoApprovable(request, { ...allOpts, enabled: false })).toEqual({ ok: false, reason: 'flag-off' });
  });

  it('hard: command-safety CRITICAL (defence in depth — the gate denies it first)', () => {
    const command = "bash -lc 'rm -rf ~'";
    expect(classifyProposedCommand(command, { workspaceRoot: WS, level: 'L2' }).decision).not.toBe('allow');
    const request = { command, signals: ['destructive', 'leaves-root', 'write-or-exec'], reason: 'boundary: destructive, leaves-root, write-or-exec', cwd: WS, workspaceRoot: WS };
    const v = escalationAutoApprovable(request, allOpts);
    expect(v.ok).toBe(false);
  });

  it('opaque-script-exec / indirect-exec / expansion are not soft', () => {
    expect(ALL_LEVEL_SOFT_REASONS.has('signal:opaque-script-exec')).toBe(false);
    expect(ALL_LEVEL_SOFT_REASONS.has('signal:indirect-exec')).toBe(false);
    expect(ALL_LEVEL_SOFT_REASONS.has('expansion')).toBe(false);
  });

  it('every soft reason in the table is a reason the standard path can actually produce or a gate signal', () => {
    const lib = read('lib/agent-run-without-approval.ts');
    for (const reason of ALL_LEVEL_SOFT_REASONS) {
      if (reason.startsWith('signal:') || reason.startsWith('safety:')) continue;
      expect([reason, lib.includes(`'${reason}'`)]).toEqual([reason, true]);
    }
  });
});

describe('H2: untrusted input → no "all" level', () => {
  it('runWithoutApprovalAllAllowedFor', () => {
    expect(runWithoutApprovalAllAllowedFor(agent)).toBe(true);
    expect(runWithoutApprovalAllAllowedFor({ ...agent, tool: { type: 'perplexity' } })).toBe(false);
    expect(runWithoutApprovalAllAllowedFor({ ...agent, prompt: 'summarize https://example.com/a' })).toBe(false);
    expect(runWithoutApprovalAllAllowedFor({ ...agent, orchestration: { steps: [{ instruction: 'search the web for brick breaker ideas' }, 'build it'] } })).toBe(false);
    expect(runWithoutApprovalAllAllowedFor({ ...agent, orchestration: { steps: [{ instruction: 'collect ideas', tool: { type: 'perplexity' } }, 'build it'] } })).toBe(false);
    expect(runWithoutApprovalAllAllowedFor({ ...agent, orchestrationSteps: ['research news online', 'write it'] })).toBe(false);
    expect(runWithoutApprovalAllAllowedFor({ ...agent, notificationTrigger: { packageNames: ['x'] } })).toBe(false);
    expect(runWithoutApprovalAllAllowedFor({ ...agent, action: { type: 'browser-pane' } })).toBe(false);
    expect(runWithoutApprovalAllAllowedFor(null)).toBe(false);
  });

  it('a stored "all" reads as standard for a web agent, and the writer stores standard', async () => {
    const web = { ...agent, id: 'agent-web', orchestration: { steps: [{ instruction: 'x', tool: { type: 'perplexity' } }, 'y'] } };
    __setRunWithoutApprovalStorageForTests(memoryStorage(JSON.stringify([
      { agentId: web.id, enabledAt: 1, via: 'chat', definitionHash: runWithoutApprovalDefinitionHash(web), level: 'all' },
    ])));
    expect(await getRunWithoutApprovalSetting(web)).toBe('standard');
    const store = memoryStorage();
    __setRunWithoutApprovalStorageForTests(store);
    await setRunWithoutApproval(web, 'all', 'detail');
    expect(JSON.parse(store.peek() as string)[0]).not.toHaveProperty('level');
    expect(await getRunWithoutApprovalSetting(web)).toBe('standard');
  });

  it('NL: "all" + a web research step → confirm text says it falls back; confirmed draft is standard', () => {
    const draft = parseAgentNL('@agent run fully without approval. First search the web for brick breaker tips with Perplexity, then build ~/demo/a.html with Codex');
    expect(draft.runWithoutApprovalLevel).toBe('all');
    const summary = summarizeAgentDraftAsText(draft);
    expect(summary).toMatch(/not available for this agent|「すべて」は使えません/);
    expect(summary).not.toMatch(/Run without approval \(all\): ON|承認なしで実行（すべて）: ON/);
    const confirmed = draftToConfirmedAgentDraft(draft);
    expect(confirmed.runWithoutApproval).toBe(true);
    expect(confirmed.runWithoutApprovalLevel).toBeUndefined();
  });

  it('only the typed utterance counts: team registration / terminal request / inbound drafts never carry it', () => {
    const draft = parseAgentNL('@agent run fully without approval. build ~/demo/a.html with Codex');
    expect(draftToConfirmedAgentDraft({ ...draft, monitorTeamToken: 'tok' }).runWithoutApproval).toBeUndefined();
    expect(draftToConfirmedAgentDraft({ ...draft, terminalRequestId: 'req-1' } as typeof draft).runWithoutApproval).toBeUndefined();
    expect(read('hooks/use-ai-pane-dispatch.ts')).toMatch(/source === 'terminal-request'\) \{\s*draft = \{ \.\.\.draft, runWithoutApproval: undefined, runWithoutApprovalLevel: undefined \};/);
    expect(read('components/panes/AIPane.tsx')).toMatch(/runWithoutApproval: undefined,\s*runWithoutApprovalLevel: undefined,/);
    // The LLM fallback / slot-fill / patch never write the flag.
    for (const rel of ['lib/agent-llm-fallback.ts', 'lib/agent-conversational-registration.ts', 'lib/agent-draft-patch.ts', 'lib/agent-slot-fill.ts', 'lib/monitor-team-registration.ts']) {
      expect([rel, /runWithoutApproval/.test(read(rel))]).toEqual([rel, false]);
    }
  });
});

describe('unattended / proactive runs never get the all level', () => {
  it('attended=false falls back to the standard rules', () => {
    const { request } = gateRequest("bash -lc 'rm -rf build'");
    expect(escalationAutoApprovable(request, allOpts)).toEqual({ ok: true, kind: 'all' });
    expect(escalationAutoApprovable(request, { ...allOpts, attended: false })).toEqual({ ok: false, reason: 'signal:destructive' });
    expect(escalationAutoApprovable(request, { ...allOpts, attended: undefined })).toEqual({ ok: false, reason: 'signal:destructive' });
  });

  it('a proactive run (policyBlocksAutoAccept) is refused at either level', () => {
    const { request } = gateRequest("bash -lc 'cat ~/demo/a.html'");
    expect(escalationAutoApprovable(request, { ...allOpts, attended: false, policyBlocksAutoAccept: true })).toEqual({ ok: false, reason: 'policy-ask' });
  });

  it('the unattended driver declines every gray verdict itself (nothing to answer)', () => {
    const driver = read('scripts/shelly-agent-driver.js');
    expect(driver).toMatch(/if \(gateResults\.some\(\(result\) => result\.answer === 'n'\)\) \{\s*finalDecision = 'decline';/);
  });

  it('_layout passes attended from RN\'s own registry for BOTH the drained and the minted copy', () => {
    const layout = read('app/_layout.tsx');
    const fn = layout.slice(layout.indexOf('const autoApproveEscalation = async'), layout.indexOf('const drainAgentEscalationRequests = async'));
    expect(fn).toMatch(/attended: userStarted,/);
    expect(fn).toMatch(/const mintedAttended = registeredRunOrigin\(minted\.agentId\) === 'user';/);
    expect(fn).toMatch(/attended: mintedAttended && userStarted,/);
    expect(fn).toMatch(/level: mintedSetting === 'all' && setting === 'all' \? \('all' as const\) : \('standard' as const\),/);
    expect(fn).toMatch(/getRunWithoutApprovalSetting\(agentFor\(minted\.agentId\)\)/);
    // One options object for the verdict AND the link probe (2026-11-02).
    expect(fn).toMatch(/const mintedOpts = \{/);
    expect(fn).toMatch(/escalationAutoApprovable\(minted, mintedOpts\)/);
    expect(fn).toMatch(/allLevelLinkProbe\(minted, mintedOpts\)/);
    expect(fn).toMatch(/resolveAgentEscalationAutoApproval\(minted\.runId, minted\.reqId, requestSha256, actionNonce\)/);
    expect(fn).toMatch(/t\(runWithoutApprovalAuditKey\(mintedSetting\)/);
    expect(fn).toMatch(/level=\$\{mintedSetting\} reason=\$\{verdict\.reason\}/);
  });
});

describe('action approvals are unchanged by the level', () => {
  const req = { runId: 'r1', agentId: agent.id, actionType: 'draft', requestSha256: 'a'.repeat(64), actionNonce: 'n', origin: 'user' };
  it('draft/notify auto, webhook / review-required still ask — the decision takes no level at all', async () => {
    const opts = { enabled: true, policyBlocksAutoAccept: false, originOf: () => 'user' as const, readMinted: async () => req };
    expect((await decideActionAutoApproval(req, opts)).ok).toBe(true);
    const webhook = { ...req, actionType: 'webhook' };
    expect(await decideActionAutoApproval(webhook, { ...opts, readMinted: async () => webhook })).toEqual({ ok: false, reason: 'not-local-only' });
    const cli = { ...req, actionType: 'cli' };
    expect(await decideActionAutoApproval(cli, { ...opts, readMinted: async () => cli })).toEqual({ ok: false, reason: 'review-required' });
  });

  it('audit lines name the level', () => {
    expect(runWithoutApprovalAuditKey('all')).toBe('agent_run_without_approval.auto_approved_all');
    expect(runWithoutApprovalAuditKey('standard')).toBe('agent_run_without_approval.auto_approved');
    expect(read('lib/i18n/locales/ja.ts')).toMatch(/'agent_run_without_approval\.auto_approved_all': '承認なしで実行（すべて）: 自動許可 \{\{command\}\}'/);
    expect(read('lib/i18n/locales/en.ts')).toMatch(/'agent_run_without_approval\.auto_approved_all': 'Run without approval \(all\): auto-allowed \{\{command\}\}'/);
  });
});

describe('NL: detection, stripping, negation', () => {
  it('JA "all" phrases', () => {
    for (const s of ['すべて承認なしで実行して', '全て承認なしで動かして', '全部承認なしで実行', '完全に承認なしで走らせて', '一切の確認なしで実行して']) {
      expect([s, detectRunWithoutApprovalLevel(s)]).toEqual([s, 'all']);
    }
  });

  it('EN "all" phrases', () => {
    for (const s of ['Run fully without approval.', 'run it completely without approvals', 'Run this without any approvals at all', 'run entirely without any approval']) {
      expect([s, detectRunWithoutApprovalLevel(s)]).toEqual([s, 'all']);
    }
  });

  it('the standard phrases stay standard', () => {
    expect(detectRunWithoutApprovalLevel('承認なしで実行して')).toBe('standard');
    expect(detectRunWithoutApprovalLevel('Right now, run without approval.')).toBe('standard');
    expect(detectRunWithoutApprovalLevel('run it without any approval')).toBe('standard');
  });

  it('negated / quoted / unrelated text is off', () => {
    for (const s of [
      "don't run fully without approval",
      'never run it without any approvals at all',
      'すべて承認なしで実行しないで',
      '「すべて承認なしで実行」という設定について教えて',
      'notify me if there is no approval at all',
      'summarize the news',
    ]) {
      expect([s, detectRunWithoutApprovalLevel(s)]).toEqual([s, 'off']);
      expect(detectRunWithoutApprovalIntent(s)).toBe(false);
    }
  });

  it('the phrase is stripped from the task text (including the すべて / fully / at all parts)', () => {
    expect(stripRunWithoutApprovalPhrases('すべて承認なしで実行して。~/demo/a.html にゲームを作って')).toBe('~/demo/a.html にゲームを作って');
    expect(stripRunWithoutApprovalPhrases('Run fully without approval. Build a game in ~/demo/a.html')).toBe('Build a game in ~/demo/a.html');
    expect(stripRunWithoutApprovalPhrases('Build a game, and run it without any approvals at all.')).toBe('Build a game');
  });

  it('detectAutonomousIntent does not treat the "all" phrase as autonomy', () => {
    expect(detectAutonomousIntent('すべて承認なしで実行して、ブロック崩しを作って')).toBe(false);
    expect(detectAutonomousIntent('Run fully without approval and build a brick breaker')).toBe(false);
    expect(detectAutonomousIntent('Run without any approvals at all and build a brick breaker')).toBe(false);
  });

  it('parseAgentNL: the all level reaches the draft, the summary and the confirmed draft', () => {
    const draft = parseAgentNL('@agent Right now, run fully without approval. At the same time: build a brick breaker in ~/demo/codex.html with Codex, build one in ~/demo/claude.html with Claude Code, and finally list both file paths');
    expect(draft.runWithoutApproval).toBe(true);
    expect(draft.runWithoutApprovalLevel).toBe('all');
    expect(draft.autonomous).toBeFalsy();
    expect(draft.workspaceRoot).toBe('~/demo');
    expect(`${draft.name}\n${draft.prompt}`).not.toMatch(/without approval|fully/i);
    const summary = summarizeAgentDraftAsText(draft);
    expect(summary).toMatch(/Run without approval \(all\)|承認なしで実行（すべて）/);
    expect(summary).toMatch(/Still asks you|引き続き確認/);
    const confirmed = draftToConfirmedAgentDraft(draft);
    expect(confirmed.runWithoutApproval).toBe(true);
    expect(confirmed.runWithoutApprovalLevel).toBe('all');
  });

  it('parseAgentNL: the standard phrase never yields the all level', () => {
    const draft = parseAgentNL('@agent Right now, run without approval. build a brick breaker in ~/demo/codex.html with Codex');
    expect(draft.runWithoutApproval).toBe(true);
    expect(draft.runWithoutApprovalLevel).toBeUndefined();
    expect(draftToConfirmedAgentDraft(draft).runWithoutApprovalLevel).toBeUndefined();
  });

  it('the chat confirm writes the level the summary named', () => {
    const src = read('hooks/use-ai-pane-dispatch.ts');
    expect(src).toMatch(/setRunWithoutApproval\(created, confirmed\.runWithoutApprovalLevel === 'all' \? 'all' : 'standard', 'chat'\)/);
  });
});

describe('agent detail popup: OFF / 標準 / すべて', () => {
  it('offers one button per level the agent is not at, writing via setRunWithoutApproval', () => {
    const src = read('components/layout/Sidebar.tsx');
    expect(src).toMatch(/getRunWithoutApprovalSetting\(agent\)/);
    expect(src).toMatch(/key: `run-without-approval-\$\{option\.level\}`/);
    expect(src).toMatch(/setRunWithoutApproval\(agent, option\.level, 'detail'\)/);
    expect(src).toMatch(/'agent_detail\.run_without_approval_all'/);
    for (const locale of ['en', 'ja']) {
      const text = read(`lib/i18n/locales/${locale}.ts`);
      for (const key of [
        'sidebar.agent_run_without_approval_enable_all',
        'sidebar.agent_run_without_approval_state_all',
        'agent_detail.run_without_approval_all',
        'agent_run_without_approval.enabled_all_line',
        'agentplan.run_without_approval_all_note',
      ]) {
        expect([locale, key, text.includes(`'${key}':`)]).toEqual([locale, key, true]);
      }
    }
  });
});
