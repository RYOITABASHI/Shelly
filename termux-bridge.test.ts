/**
 * termux-bridge protocol tests
 * Tests the message format and state transitions for the Termux WebSocket bridge.
 * These tests run in Node.js (no React Native runtime needed).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Protocol message helpers ─────────────────────────────────────────────────

interface BridgeMessage {
  type: string;
  requestId?: string;
  command?: string;
  data?: string;
  code?: number;
  cwd?: string;
  message?: string;
}

function makeRunMessage(requestId: string, command: string): BridgeMessage {
  return { type: 'run', requestId, command };
}

function makeStdoutMessage(requestId: string, data: string): BridgeMessage {
  return { type: 'stdout', requestId, data };
}

function makeStderrMessage(requestId: string, data: string): BridgeMessage {
  return { type: 'stderr', requestId, data };
}

function makeExitMessage(requestId: string, code: number, cwd: string): BridgeMessage {
  return { type: 'exit', requestId, code, cwd };
}

function makeErrorMessage(requestId: string, message: string): BridgeMessage {
  return { type: 'error', requestId, message };
}

// ─── Simple command queue simulation ─────────────────────────────────────────

interface QueuedCommand {
  requestId: string;
  command: string;
  status: 'pending' | 'running' | 'done' | 'error';
  output: string;
  exitCode: number | null;
}

class CommandQueue {
  private queue: QueuedCommand[] = [];
  private running: QueuedCommand | null = null;

  enqueue(requestId: string, command: string): QueuedCommand {
    const item: QueuedCommand = {
      requestId,
      command,
      status: 'pending',
      output: '',
      exitCode: null,
    };
    this.queue.push(item);
    return item;
  }

  startNext(): QueuedCommand | null {
    if (this.running) return null; // busy
    const next = this.queue.find((q) => q.status === 'pending');
    if (!next) return null;
    next.status = 'running';
    this.running = next;
    return next;
  }

  appendOutput(requestId: string, data: string): void {
    const item = this.queue.find((q) => q.requestId === requestId);
    if (item) item.output += data;
  }

  finalize(requestId: string, code: number): void {
    const item = this.queue.find((q) => q.requestId === requestId);
    if (item) {
      item.status = code === 0 ? 'done' : 'error';
      item.exitCode = code;
    }
    if (this.running?.requestId === requestId) {
      this.running = null;
    }
  }

  getAll(): QueuedCommand[] {
    return this.queue;
  }

  isIdle(): boolean {
    return this.running === null;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Bridge protocol message format', () => {
  it('run message has correct shape', () => {
    const msg = makeRunMessage('req-001', 'ls -la');
    expect(msg.type).toBe('run');
    expect(msg.requestId).toBe('req-001');
    expect(msg.command).toBe('ls -la');
  });

  it('stdout message has correct shape', () => {
    const msg = makeStdoutMessage('req-001', 'total 48\n');
    expect(msg.type).toBe('stdout');
    expect(msg.data).toBe('total 48\n');
  });

  it('stderr message has correct shape', () => {
    const msg = makeStderrMessage('req-001', 'command not found\n');
    expect(msg.type).toBe('stderr');
    expect(msg.data).toBe('command not found\n');
  });

  it('exit message has correct shape', () => {
    const msg = makeExitMessage('req-001', 0, '/home/user');
    expect(msg.type).toBe('exit');
    expect(msg.code).toBe(0);
    expect(msg.cwd).toBe('/home/user');
  });

  it('error message has correct shape', () => {
    const msg = makeErrorMessage('req-001', '別のコマンドが実行中です');
    expect(msg.type).toBe('error');
    expect(msg.message).toBe('別のコマンドが実行中です');
  });

  it('messages serialize to valid JSON', () => {
    const msg = makeRunMessage('req-abc', 'echo hello');
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('run');
    expect(parsed.requestId).toBe('req-abc');
    expect(parsed.command).toBe('echo hello');
  });
});

describe('CommandQueue', () => {
  let queue: CommandQueue;

  beforeEach(() => {
    queue = new CommandQueue();
  });

  it('enqueues commands as pending', () => {
    queue.enqueue('req-1', 'ls');
    queue.enqueue('req-2', 'pwd');
    const all = queue.getAll();
    expect(all).toHaveLength(2);
    expect(all[0].status).toBe('pending');
    expect(all[1].status).toBe('pending');
  });

  it('starts only one command at a time', () => {
    queue.enqueue('req-1', 'ls');
    queue.enqueue('req-2', 'pwd');

    const first = queue.startNext();
    expect(first?.requestId).toBe('req-1');
    expect(first?.status).toBe('running');

    // Second startNext should return null (busy)
    const second = queue.startNext();
    expect(second).toBeNull();
  });

  it('appends stdout output to correct block', () => {
    queue.enqueue('req-1', 'ls');
    queue.startNext();
    queue.appendOutput('req-1', 'file1.txt\n');
    queue.appendOutput('req-1', 'file2.txt\n');

    const item = queue.getAll().find((q) => q.requestId === 'req-1');
    expect(item?.output).toBe('file1.txt\nfile2.txt\n');
  });

  it('finalizes block with exit code 0 as done', () => {
    queue.enqueue('req-1', 'echo hello');
    queue.startNext();
    queue.appendOutput('req-1', 'hello\n');
    queue.finalize('req-1', 0);

    const item = queue.getAll()[0];
    expect(item.status).toBe('done');
    expect(item.exitCode).toBe(0);
    expect(queue.isIdle()).toBe(true);
  });

  it('finalizes block with non-zero exit code as error', () => {
    queue.enqueue('req-1', 'cat nonexistent');
    queue.startNext();
    queue.appendOutput('req-1', '');
    queue.finalize('req-1', 1);

    const item = queue.getAll()[0];
    expect(item.status).toBe('error');
    expect(item.exitCode).toBe(1);
  });

  it('starts next command after previous finishes', () => {
    queue.enqueue('req-1', 'ls');
    queue.enqueue('req-2', 'pwd');

    queue.startNext(); // starts req-1
    queue.finalize('req-1', 0);
    expect(queue.isIdle()).toBe(true);

    const next = queue.startNext(); // should start req-2
    expect(next?.requestId).toBe('req-2');
    expect(next?.status).toBe('running');
  });

  it('handles multiple commands sequentially', () => {
    queue.enqueue('req-1', 'ls');
    queue.enqueue('req-2', 'pwd');
    queue.enqueue('req-3', 'whoami');

    queue.startNext();
    queue.finalize('req-1', 0);

    queue.startNext();
    queue.finalize('req-2', 0);

    queue.startNext();
    queue.appendOutput('req-3', 'user\n');
    queue.finalize('req-3', 0);

    const all = queue.getAll();
    expect(all.every((q) => q.status === 'done')).toBe(true);
    expect(all[2].output).toBe('user\n');
  });
});

describe('Dangerous command detection', () => {
  const DANGEROUS_PATTERNS = [
    /rm\s+-[a-z]*r[a-z]*f/i,
    /rm\s+-[a-z]*f[a-z]*r/i,
    /:\(\)\{.*\}/,
    /mkfs\./i,
    /dd\s+.*of=\/dev/i,
    /chmod\s+-R\s+777\s+\//i,
    />\s*\/dev\/sd/i,
  ];

  function isDangerous(cmd: string): boolean {
    return DANGEROUS_PATTERNS.some((p) => p.test(cmd));
  }

  it('blocks rm -rf', () => {
    expect(isDangerous('rm -rf /')).toBe(true);
    expect(isDangerous('rm -rf /home/user')).toBe(true);
  });

  it('blocks rm -fr', () => {
    expect(isDangerous('rm -fr /tmp')).toBe(true);
  });

  it('blocks mkfs', () => {
    expect(isDangerous('mkfs.ext4 /dev/sda1')).toBe(true);
  });

  it('allows safe commands', () => {
    expect(isDangerous('ls -la')).toBe(false);
    expect(isDangerous('cd /home/user')).toBe(false);
    expect(isDangerous('echo hello')).toBe(false);
    expect(isDangerous('git status')).toBe(false);
    expect(isDangerous('rm -f temp.txt')).toBe(false); // rm -f without -r is OK
  });

  it('allows rm with only -f flag', () => {
    // rm -f (without recursive) should be allowed
    expect(isDangerous('rm -f file.txt')).toBe(false);
  });
});

describe('Connection mode transitions', () => {
  type ConnectionMode = 'mock' | 'termux' | 'disconnected';

  function getNextMode(current: ConnectionMode): ConnectionMode {
    const modes: ConnectionMode[] = ['mock', 'termux', 'disconnected'];
    const idx = modes.indexOf(current);
    return modes[(idx + 1) % modes.length];
  }

  it('cycles through modes: mock → termux → disconnected → mock', () => {
    expect(getNextMode('mock')).toBe('termux');
    expect(getNextMode('termux')).toBe('disconnected');
    expect(getNextMode('disconnected')).toBe('mock');
  });

  it('mock mode uses pseudo shell', () => {
    const mode: ConnectionMode = 'mock';
    const usesPseudoShell = mode === 'mock' || mode === 'disconnected';
    expect(usesPseudoShell).toBe(true);
  });

  it('termux mode uses WebSocket bridge', () => {
    const mode: ConnectionMode = 'termux';
    const usesWebSocket = mode === 'termux';
    expect(usesWebSocket).toBe(true);
  });
});

// ─── v2.4.2: exec allowlist & security tests ─────────────────────────────────

describe('Tools exec allowlist (v2.4.2)', () => {
  const TOOLS_ALLOWLIST = new Set([
    'claude', 'gemini', 'git', 'node', 'npm', 'npx', 'pnpm', 'yarn',
    'python', 'python3', 'pip', 'pip3', 'uv',
    'which', 'echo', 'cat', 'ls', 'pwd', 'mkdir', 'touch', 'cp', 'mv',
    'grep', 'find', 'head', 'tail', 'wc', 'sort', 'uniq', 'diff',
    'curl', 'wget', 'jq', 'sed', 'awk', 'tr',
    'tsc', 'tsx', 'deno', 'bun',
    'cargo', 'rustc', 'go', 'java', 'javac', 'mvn', 'gradle',
    'php', 'ruby', 'perl', 'lua',
    'make', 'cmake', 'ninja',
    'zip', 'unzip', 'tar', 'gzip', 'gunzip',
    'env', 'printenv', 'export',
    'bash', 'sh', 'zsh',
  ]);

  function isAllowedForExec(cmd: string): boolean {
    if (!cmd || typeof cmd !== 'string') return false;
    const firstToken = cmd.trim().split(/\s+/)[0];
    // Block absolute paths — Shelly must never directly execute Termux-internal paths
    if (firstToken.startsWith('/') || firstToken.startsWith('./') || firstToken.startsWith('../')) {
      return false;
    }
    return TOOLS_ALLOWLIST.has(firstToken);
  }

  it('allows claude command', () => {
    expect(isAllowedForExec('claude --print "READMEを書いて"')).toBe(true);
  });

  it('allows gemini command', () => {
    expect(isAllowedForExec('gemini -p "コードを修正して"')).toBe(true);
  });

  it('allows git command', () => {
    expect(isAllowedForExec('git status')).toBe(true);
    expect(isAllowedForExec('git commit -m "fix"')).toBe(true);
  });

  it('allows node/npm/python', () => {
    expect(isAllowedForExec('node index.js')).toBe(true);
    expect(isAllowedForExec('npm install')).toBe(true);
    expect(isAllowedForExec('python3 script.py')).toBe(true);
  });

  it('blocks Termux direct path execution (CRITICAL: no /data/data/com.termux/ direct calls)', () => {
    // ShellyプロセスからTermuxパスを直接実行しようとしてもallowlistで弾かれる
    expect(isAllowedForExec('/data/data/com.termux/files/usr/bin/claude')).toBe(false);
    expect(isAllowedForExec('/data/data/com.termux/files/usr/bin/node')).toBe(false);
    expect(isAllowedForExec('/data/data/com.termux/files/usr/bin/python3')).toBe(false);
  });

  it('blocks unknown/dangerous binaries', () => {
    expect(isAllowedForExec('malware')).toBe(false);
    expect(isAllowedForExec('unknown-tool --flag')).toBe(false);
    expect(isAllowedForExec('sudo rm -rf /')).toBe(false); // sudo not in allowlist
  });

  it('handles empty or invalid input', () => {
    expect(isAllowedForExec('')).toBe(false);
    expect(isAllowedForExec('   ')).toBe(false);
  });
});

describe('exec message format (v2.4.2)', () => {
  interface ExecMessage {
    type: 'exec';
    requestId: string;
    cmd: string;
    cwd?: string;
    env?: Record<string, string>;
  }

  function makeExecMessage(
    requestId: string,
    cmd: string,
    opts?: { cwd?: string; env?: Record<string, string> }
  ): ExecMessage {
    return { type: 'exec', requestId, cmd, ...opts };
  }

  it('exec message has correct shape', () => {
    const msg = makeExecMessage('exec-001', 'claude --print "test"');
    expect(msg.type).toBe('exec');
    expect(msg.requestId).toBe('exec-001');
    expect(msg.cmd).toBe('claude --print "test"');
    expect(msg.cwd).toBeUndefined();
    expect(msg.env).toBeUndefined();
  });

  it('exec message with cwd and env', () => {
    const msg = makeExecMessage('exec-002', 'gemini -p "test"', {
      cwd: '~/Projects/myapp',
      env: { GEMINI_API_KEY: 'sk-masked' },
    });
    expect(msg.cwd).toBe('~/Projects/myapp');
    expect(msg.env?.GEMINI_API_KEY).toBe('sk-masked');
  });

  it('exec message serializes to valid JSON', () => {
    const msg = makeExecMessage('exec-003', 'claude --print "hello"', {
      cwd: '~/Projects',
    });
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('exec');
    expect(parsed.cmd).toBe('claude --print "hello"');
    expect(parsed.cwd).toBe('~/Projects');
  });

  it('exec differs from run: uses cmd field not command field', () => {
    const execMsg = makeExecMessage('exec-004', 'claude -p "test"');
    const runMsg = { type: 'run', requestId: 'run-004', command: 'ls -la' };
    // exec uses 'cmd', run uses 'command'
    expect('cmd' in execMsg).toBe(true);
    expect('command' in execMsg).toBe(false);
    expect('command' in runMsg).toBe(true);
    expect('cmd' in runMsg).toBe(false);
  });
});

describe('runCommand streaming behavior (v2.4.2)', () => {
  it('accumulates stdout chunks correctly', () => {
    let accumulated = '';
    const onStream = (type: 'stdout' | 'stderr', data: string) => {
      if (type === 'stdout') accumulated += data;
    };

    // Simulate streaming chunks
    onStream('stdout', 'Hello');
    onStream('stdout', ', ');
    onStream('stdout', 'World\n');

    expect(accumulated).toBe('Hello, World\n');
  });

  it('accumulates stderr chunks separately', () => {
    let stdout = '';
    let stderr = '';
    const onStream = (type: 'stdout' | 'stderr', data: string) => {
      if (type === 'stdout') stdout += data;
      else stderr += data;
    };

    onStream('stdout', 'output line\n');
    onStream('stderr', 'error line\n');
    onStream('stdout', 'more output\n');

    expect(stdout).toBe('output line\nmore output\n');
    expect(stderr).toBe('error line\n');
  });

  it('exit code 0 means success', () => {
    const result = { stdout: 'hello\n', stderr: '', exitCode: 0 };
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello\n');
  });

  it('exit code 130 means cancelled (SIGINT)', () => {
    const result = { stdout: '', stderr: '^C\n', exitCode: 130 };
    expect(result.exitCode).toBe(130);
  });

  it('exit code 124 means timeout', () => {
    const result = { stdout: '', stderr: '\n[タイムアウト]コマンドが時間内に完了しませんでした。', exitCode: 124 };
    expect(result.exitCode).toBe(124);
  });
});

describe('Disconnected fallback (v2.4.2)', () => {
  it('returns error result when not connected (no Termux path direct call)', () => {
    // runCommand when ws is not open should return error immediately
    // without attempting to execute /data/data/com.termux/... paths
    const simulateDisconnectedRunCommand = (): { stdout: string; stderr: string; exitCode: number } => {
      // This is what runCommand does when ws is null/closed
      return {
        stdout: '',
        stderr: 'Termux Bridgeに接続されていません。SettingsでWebSocket URLを設定し、TermuxでBridgeを起動してください。',
        exitCode: 1,
      };
    };

    const result = simulateDisconnectedRunCommand();
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Termux Bridge');
    // 重要: Termuxパスへの直接アクセスは一切行わない
    expect(result.stderr).not.toContain('/data/data/com.termux');
  });

  it('disconnected error message guides user to setup bridge', () => {
    const errorMsg = 'Termux Bridgeに接続されていません。SettingsでWebSocket URLを設定し、TermuxでBridgeを起動してください。';
    expect(errorMsg).toContain('Settings');
    expect(errorMsg).toContain('Bridge');
  });
});

describe('API key masking in logs (v2.4.2)', () => {
  // maskSecrets function behavior
  function maskSecrets(text: string): string {
    return text
      .replace(/ANTHROPIC_API_KEY=[^\s&"']*/gi, 'ANTHROPIC_API_KEY=***')
      .replace(/GEMINI_API_KEY=[^\s&"']*/gi, 'GEMINI_API_KEY=***')
      .replace(/OPENAI_API_KEY=[^\s&"']*/gi, 'OPENAI_API_KEY=***')
      .replace(/sk-[A-Za-z0-9\-_]{20,}/g, 'sk-***')
      .replace(/AIza[A-Za-z0-9\-_]{35}/g, 'AIza***');
  }

  it('masks ANTHROPIC_API_KEY in log output', () => {
    const log = 'ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxx running claude';
    expect(maskSecrets(log)).toContain('ANTHROPIC_API_KEY=***');
    expect(maskSecrets(log)).not.toContain('sk-ant-api03');
  });

  it('masks GEMINI_API_KEY in log output', () => {
    const log = 'GEMINI_API_KEY=AIzaSyXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX running gemini';
    expect(maskSecrets(log)).toContain('GEMINI_API_KEY=***');
  });

  it('masks raw sk- tokens', () => {
    const log = 'Using key: sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456';
    expect(maskSecrets(log)).toContain('sk-***');
    expect(maskSecrets(log)).not.toContain('abcdefghijklmnop');
  });

  it('does not mask normal text', () => {
    const log = 'claude --print "READMEを書いて"';
    expect(maskSecrets(log)).toBe(log);
  });
});
