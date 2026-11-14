/**
 * MCP ingress gate (DEFERRED.md「MCP の入口（ingress）に外部入力の印（taint）を付ける」 Inc 1):
 * run_command / write_file are judged by the agent gate before the approval
 * modal — a gate deny is refused without asking, anything else still needs
 * the tap — and write_file is checked on the real path.
 */
const mockFiles = new Map<string, string>();
const mockSettings: Record<string, unknown> = { mcpExecEnabled: true, mcpReadTerminalEnabled: false };
const mockRepoPaths: string[] = [];

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///data/home-root/',
  readDirectoryAsync: jest.fn(async (dir: string) => {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return [...mockFiles.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).filter((n) => !n.includes('/'));
  }),
  readAsStringAsync: jest.fn(async (uri: string) => {
    const v = mockFiles.get(uri);
    if (v === undefined) throw new Error('ENOENT ' + uri);
    return v;
  }),
  writeAsStringAsync: jest.fn(async (uri: string, content: string) => {
    mockFiles.set(uri, content);
  }),
  makeDirectoryAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async (uri: string) => {
    for (const k of [...mockFiles.keys()]) if (k === uri || k.startsWith(`${uri}/`)) mockFiles.delete(k);
  }),
}));
jest.mock('@/store/agent-store', () => ({ useAgentStore: { getState: () => ({ agents: [] }) } }));
jest.mock('@/store/sidebar-store', () => ({ useSidebarStore: { getState: () => ({ repoPaths: mockRepoPaths }) } }));
jest.mock('@/store/settings-store', () => ({
  useSettingsStore: { getState: () => ({ settings: mockSettings }) },
}));
jest.mock('@/store/terminal-store', () => ({
  useTerminalStore: {
    getState: () => ({ sessions: [{ id: 'session-1', nativeSessionId: 'native-1' }], activeSessionId: 'session-1' }),
  },
}));
const mockTranscript = jest.fn(async () => 'screen text');
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { getTranscriptText: (...a: unknown[]) => (mockTranscript as any)(...a) },
}));
// POLICY-001 user rules: one keyword deny rule, already loaded (sealed).
jest.mock('@/lib/agent-user-policy-store', () => ({
  getCachedUserPolicy: () => ({
    unavailable: false,
    data: {
      rules: [{ id: 'r1', effect: 'deny', match: { keywords: ['payroll-export'] }, source: 'never touch payroll', createdAt: 0 }],
      trust: { allows: [], counts: {} },
    },
  }),
  loadUserPolicy: jest.fn(),
}));
// Resolution output per write target (see resolveWriteTarget's script).
let mockResolve: (script: string) => string = () => '';
const mockExecCommand = jest.fn(async (cmd: string) => {
  if (cmd.includes('RP_ANCESTOR')) return { stdout: mockResolve(cmd), stderr: '', exitCode: 0 };
  return { stdout: 'ran', stderr: '', exitCode: 0 };
});
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: (...a: unknown[]) => (mockExecCommand as any)(...a) }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: () => {}, logError: () => {}, logWarn: () => {} }));

import { startMCPPoller, stopMCPPoller } from '@/lib/mcp-server-bridge';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import {
  GATE_HOME,
  evaluateMcpCommand,
  gateCommandWithCwd,
  gateWriteCommand,
  mapHomeForGate,
  resolveWriteTarget,
} from '@/lib/mcp-ingress-gate';

const HOME = '/data/home-root/home';
const QUEUE = `file://${HOME}/.shelly-mcp-queue`;
const REQUESTS = `${QUEUE}/requests`;
const RESULTS = `${QUEUE}/results`;

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let seq = 0;
/** Queue one call and wait for its result file (or for the approval modal). */
async function call(tool: string, args: Record<string, unknown>, opts: { approve?: boolean } = {}) {
  const callId = `c${++seq}`;
  mockFiles.set(`${REQUESTS}/${callId}.json`, JSON.stringify({ callId, tool, args }));
  startMCPPoller();
  const resultUri = `${RESULTS}/${callId}.json`;
  let shown: string | null = null;
  await waitFor(() => {
    const current = useMcpApprovalStore.getState().current;
    if (current && opts.approve !== undefined) {
      shown = current.detail;
      current.resolve(opts.approve);
      useMcpApprovalStore.setState({ current: null, queue: [] });
    }
    return mockFiles.has(resultUri);
  });
  return { result: JSON.parse(mockFiles.get(resultUri)!), shown: shown as string | null };
}

function ranExactly(command: string): boolean {
  return mockExecCommand.mock.calls.some((c) => c[0] === command);
}

/** Resolution where every existing parent is a plain directory. */
function plainResolve(script: string): string {
  const p = /^p='([^']*)'/m.exec(script)![1];
  const dir = p.slice(0, p.lastIndexOf('/'));
  const roots = [...script.matchAll(/^r(\d+)=\$\(cd -P -- '([^']*)'/gm)].map((m) => `RP_ROOT${m[1]}:${m[2]}`);
  return [`RP_ANCESTOR:${dir}`, `RP_REAL:${dir}`, ...roots].join('\n');
}

beforeEach(() => {
  mockResolve = plainResolve;
});

afterEach(() => {
  stopMCPPoller();
  mockFiles.clear();
  mockExecCommand.mockClear();
  mockTranscript.mockClear();
  mockRepoPaths.length = 0;
  mockSettings.mcpExecEnabled = true;
  mockSettings.mcpReadTerminalEnabled = false;
  useMcpApprovalStore.setState({ current: null, queue: [] });
});

describe('evaluateMcpCommand (pure)', () => {
  it('denies writes to an agent definition, shared_prefs and the MCP queue; never allows past the tap', () => {
    expect(evaluateMcpCommand(`echo '{}' > ~/.shelly/agents/x.json`, HOME, null).refused).toBe(true);
    expect(evaluateMcpCommand(`cd ~/.shelly/agents && cp /tmp/a x.json`, HOME, null).refused).toBe(true);
    expect(evaluateMcpCommand(`cp evil.xml /data/data/dev.shelly.terminal/shared_prefs/x.xml`, HOME, null).refused).toBe(true);
    expect(evaluateMcpCommand(`echo '{}' > ~/.shelly-mcp-queue/results/c9.json`, HOME, null).refused).toBe(true);
    expect(evaluateMcpCommand('rm -rf /', HOME, null).refused).toBe(true);
    const plain = evaluateMcpCommand('ls -la', HOME, null);
    expect(plain.refused).toBe(false);
    expect(plain.summary).toMatch(/^(allow|gray): /);
  });
});

describe('run_command through the RN bridge', () => {
  it('refuses a policy-write command (writing ~/.shelly/agents/x.json) without the approval modal', async () => {
    const enqueue = jest.spyOn(useMcpApprovalStore.getState(), 'enqueue');
    const command = `echo '{"id":"x"}' > ~/.shelly/agents/x.json`;
    const { result, shown } = await call('run_command', { command }, { approve: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("refused by Shelly's agent gate");
    expect(result.error).toContain('policy-write');
    expect(shown).toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(ranExactly(command)).toBe(false);
    enqueue.mockRestore();
  });

  it('refuses a `cd` into the agents dir followed by a write', async () => {
    const { result, shown } = await call('run_command', { command: 'echo {} > policy.json', cwd: `${HOME}/.shelly/agents` }, { approve: true });
    expect(result.ok).toBe(false);
    expect(shown).toBeNull();
    expect(mockExecCommand.mock.calls.some((c) => String(c[0]).includes('policy.json'))).toBe(false);
  });

  it('refuses a CRITICAL command without the approval modal', async () => {
    const { result, shown } = await call('run_command', { command: 'rm -rf /' }, { approve: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('destructive');
    expect(shown).toBeNull();
    expect(ranExactly('rm -rf /')).toBe(false);
  });

  it('refuses a command a POLICY-001 user deny rule matches', async () => {
    const { result, shown } = await call('run_command', { command: 'cat payroll-export.csv' }, { approve: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('user rule');
    expect(shown).toBeNull();
  });

  it('still asks for the tap on a command the gate does not deny, and shows the gate verdict', async () => {
    const denied = await call('run_command', { command: 'ls -la' }, { approve: false });
    expect(denied.result).toEqual({ ok: false, error: 'denied by user (or timed out waiting for a response)' });
    expect(denied.shown).toContain('ls -la');
    expect(denied.shown).toContain('Gate: ');
    expect(ranExactly('ls -la')).toBe(false);

    const approved = await call('run_command', { command: 'ls -la' }, { approve: true });
    expect(approved.result.ok).toBe(true);
    expect(ranExactly('ls -la')).toBe(true);
  });

  it('re-checks the exec setting after the tap', async () => {
    const callId = `c${++seq}`;
    mockFiles.set(`${REQUESTS}/${callId}.json`, JSON.stringify({ callId, tool: 'run_command', args: { command: 'whoami' } }));
    startMCPPoller();
    await waitFor(() => useMcpApprovalStore.getState().current !== null);
    mockSettings.mcpExecEnabled = false;
    useMcpApprovalStore.getState().current!.resolve(true);
    await waitFor(() => mockFiles.has(`${RESULTS}/${callId}.json`));
    expect(JSON.parse(mockFiles.get(`${RESULTS}/${callId}.json`)!).ok).toBe(false);
    expect(ranExactly('whoami')).toBe(false);
  });
});

describe('write_file through the RN bridge', () => {
  it('refuses a write into ~/.shelly/agents/x.json without the approval modal', async () => {
    const path = `${HOME}/.shelly/agents/x.json`;
    const { result, shown } = await call('write_file', { path, content: '{}' }, { approve: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('policy-write');
    expect(shown).toBeNull();
    expect(mockFiles.has(`file://${path}`)).toBe(false);
  });

  it('refuses a symlinked parent whose real path leaves home and the repos', async () => {
    // ~/link -> /etc
    mockResolve = (script) => plainResolve(script).replace(`RP_REAL:${HOME}/link`, 'RP_REAL:/etc');
    const { result, shown } = await call('write_file', { path: `${HOME}/link/hosts`, content: 'x' }, { approve: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('real path');
    expect(shown).toBeNull();
    expect([...mockFiles.keys()].some((k) => k.includes('/etc/'))).toBe(false);
  });

  it('refuses a symlinked parent whose real path lands in the agents dir', async () => {
    // ~/notes -> ~/.shelly/agents
    mockResolve = (script) => plainResolve(script).replace(`RP_REAL:${HOME}/notes`, `RP_REAL:${HOME}/.shelly/agents`);
    const { result, shown } = await call('write_file', { path: `${HOME}/notes/x.json`, content: '{}' }, { approve: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('policy-write');
    expect(shown).toBeNull();
  });

  it('refuses a target that is itself a symlink', async () => {
    mockResolve = () => 'RP_LEAF_LINK';
    const { result, shown } = await call('write_file', { path: `${HOME}/a.txt`, content: 'x' }, { approve: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('symlink');
    expect(shown).toBeNull();
  });

  it('refuses ".." and relative paths before running anything', async () => {
    const dotdot = await call('write_file', { path: `${HOME}/../shared_prefs/x.xml`, content: 'x' }, { approve: true });
    expect(dotdot.result.ok).toBe(false);
    const relative = await call('write_file', { path: 'a.txt', content: 'x' }, { approve: true });
    expect(relative.result.ok).toBe(false);
    expect(mockExecCommand.mock.calls.some((c) => String(c[0]).includes('RP_ANCESTOR'))).toBe(false);
  });

  it('writes an ordinary file in home after the tap, to the resolved path', async () => {
    const path = `${HOME}/notes.txt`;
    const { result, shown } = await call('write_file', { path, content: 'hello' }, { approve: true });
    expect(result).toEqual({ ok: true, data: { path, bytes: 5 } });
    expect(shown).toContain('Gate: ');
    expect(mockFiles.get(`file://${path}`)).toBe('hello');
  });

  it('refuses when the target changed while the modal was open', async () => {
    let n = 0;
    mockResolve = (script) => {
      n += 1;
      const out = plainResolve(script);
      return n === 1 ? out : out.replace(`RP_REAL:${HOME}/dir`, 'RP_REAL:/elsewhere');
    };
    mockRepoPaths.push('/elsewhere');
    const { result } = await call('write_file', { path: `${HOME}/dir/a.txt`, content: 'x' }, { approve: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('changed while waiting');
    expect([...mockFiles.keys()].some((k) => k.endsWith('/a.txt'))).toBe(false);
  });
});

describe('read_terminal_output setting', () => {
  it('is refused while mcpReadTerminalEnabled is off and served when on', async () => {
    const off = await call('read_terminal_output', {});
    expect(off.result.ok).toBe(false);
    expect(off.result.error).toContain('disabled');
    expect(mockTranscript).not.toHaveBeenCalled();

    mockSettings.mcpReadTerminalEnabled = true;
    const on = await call('read_terminal_output', {});
    expect(on.result).toEqual({ ok: true, data: 'screen text' });
  });
});

describe('resolveWriteTarget (pure)', () => {
  const run = (stdout: string) => async () => ({ stdout, exitCode: 0 });

  it('joins the real parent with the missing components', async () => {
    const res = await resolveWriteTarget(`${HOME}/new/dir/a.txt`, [HOME], run(`RP_ANCESTOR:${HOME}\nRP_REAL:${HOME}\nRP_ROOT0:${HOME}\n`));
    expect(res).toEqual({ ok: true, realPath: `${HOME}/new/dir/a.txt` });
  });

  it('refuses a path outside every root before running the script', async () => {
    const runner = jest.fn(run(''));
    const res = await resolveWriteTarget('/etc/hosts', [HOME], runner);
    expect(res.ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });

  it('refuses a dangling symlink or a non-directory parent', async () => {
    const res = await resolveWriteTarget(`${HOME}/a/b.txt`, [HOME], run('RP_PARENT_NOT_DIR\n'));
    expect(res.ok).toBe(false);
  });

  it('refuses a hardlinked target, and the script checks the link count', async () => {
    const runner = jest.fn(run('RP_LEAF_HARDLINK\n'));
    const res = await resolveWriteTarget(`${HOME}/a.txt`, [HOME], runner);
    expect(res).toEqual({ ok: false, error: 'refused: the target file has more than one hard link' });
    expect(String((runner.mock.calls as unknown[][])[0][0])).toContain('stat -c %h');
  });

  it('refuses a resolved name with control characters (script check)', async () => {
    const runner = jest.fn(run('RP_BAD\n'));
    expect((await resolveWriteTarget(`${HOME}/a.txt`, [HOME], runner)).ok).toBe(false);
    expect(String((runner.mock.calls as unknown[][])[0][0])).toContain('[[:cntrl:]]');
  });

  it('refuses output with a repeated key (a forged RP_ROOT line)', async () => {
    // A directory named "x\nRP_ROOT0:/" under the real parent would add a line.
    const forged = `RP_ANCESTOR:${HOME}\nRP_REAL:/etc\nRP_ROOT0:/\nRP_ROOT0:${HOME}\n`;
    expect((await resolveWriteTarget(`${HOME}/a.txt`, [HOME], run(forged))).ok).toBe(false);
  });

  it('refuses a real path with "." or ".." segments', async () => {
    const out = `RP_ANCESTOR:${HOME}\nRP_REAL:${HOME}/../x\nRP_ROOT0:${HOME}\n`;
    expect((await resolveWriteTarget(`${HOME}/a.txt`, [HOME], run(out))).ok).toBe(false);
  });
});

describe('the real Android home (contains "dev.shelly.terminal")', () => {
  const ANDROID_HOME = '/data/user/0/dev.shelly.terminal/files/home';
  const DATA_HOME = '/data/data/dev.shelly.terminal/files/home';

  it('maps both home aliases to the stand-in, only at a path boundary', () => {
    expect(mapHomeForGate(`cat ${ANDROID_HOME}/a ${DATA_HOME}/b`, ANDROID_HOME)).toBe(`cat ${GATE_HOME}/a ${GATE_HOME}/b`);
    expect(mapHomeForGate(`${ANDROID_HOME}x/a`, ANDROID_HOME)).toBe(`${ANDROID_HOME}x/a`);
  });

  it('does not refuse ordinary writes and cwd commands that mention "agents" or policy.json', () => {
    for (const [cmd, label] of [
      [gateWriteCommand(`${ANDROID_HOME}/proj/agents/README.md`, ANDROID_HOME), 'write agents/README.md'],
      [gateWriteCommand(`${DATA_HOME}/proj/docs/policy.json`, ANDROID_HOME), 'write docs/policy.json'],
      [gateCommandWithCwd('git commit -m "add agents"', `${ANDROID_HOME}/proj`, ANDROID_HOME), 'git commit in proj'],
    ]) {
      const res = evaluateMcpCommand(cmd, ANDROID_HOME, null);
      expect({ label, refused: res.refused }).toEqual({ label, refused: false });
    }
  });

  it('does not label `cd <home>/proj && ls` as leaving the root', () => {
    const res = evaluateMcpCommand(gateCommandWithCwd('ls', `${ANDROID_HOME}/proj`, ANDROID_HOME), ANDROID_HOME, null);
    expect(res.refused).toBe(false);
    expect(res.outcome!.verdict.signals).not.toContain('leaves-root');
  });

  it('still refuses the agents dir and its definitions under either alias', () => {
    expect(evaluateMcpCommand(gateWriteCommand(`${ANDROID_HOME}/.shelly/agents/x.json`, ANDROID_HOME), ANDROID_HOME, null).refused).toBe(true);
    expect(evaluateMcpCommand(gateWriteCommand(`${DATA_HOME}/.shelly/agents/x.json`, ANDROID_HOME), ANDROID_HOME, null).refused).toBe(true);
    expect(evaluateMcpCommand(gateCommandWithCwd('echo {} > policy.json', `${ANDROID_HOME}/.shelly/agents`, ANDROID_HOME), ANDROID_HOME, null).refused).toBe(true);
    expect(evaluateMcpCommand(gateCommandWithCwd('cp a x.json', `${ANDROID_HOME}/.shelly/agents`, ANDROID_HOME), ANDROID_HOME, null).refused).toBe(true);
  });
});
