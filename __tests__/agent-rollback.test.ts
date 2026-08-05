/**
 * Savepoint/undo lifecycle for optimistic agent execution.
 *
 * The key safety property here is the INVERSE of the classifier's: when the
 * snapshot cannot be established, prepareRollbackWorkspace must return false so
 * the caller keeps the pre-approval gate. Running optimistically without a
 * working undo is the failure mode this guards.
 */
jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));

import {
  captureRollbackPoint,
  describeRollbackHandle,
  prepareRollbackWorkspace,
  undoAgentRun,
  type AgentRollbackHandle,
  type RollbackRunCommand,
} from '@/lib/agent-rollback';

const ROOT = '/home/test/agent-output';

/** Scriptable fake shell: match on a substring, return {stdout, exitCode}. */
function fakeShell(rules: Array<[RegExp, { stdout?: string; exitCode?: number }]>) {
  const calls: string[] = [];
  const run: RollbackRunCommand = async (cmd) => {
    calls.push(cmd);
    for (const [pattern, result] of rules) {
      if (pattern.test(cmd)) return { stdout: result.stdout ?? '', exitCode: result.exitCode ?? 0 };
    }
    return { stdout: '', exitCode: 0 };
  };
  return { run, calls };
}

describe('prepareRollbackWorkspace', () => {
  it('succeeds on an already-clean git workspace', async () => {
    const { run, calls } = fakeShell([
      [/rev-parse --git-dir/, { stdout: '.git', exitCode: 0 }],
      [/status --porcelain/, { stdout: '', exitCode: 0 }],
    ]);
    await expect(prepareRollbackWorkspace(ROOT, run)).resolves.toBe(true);
    expect(calls.some((c) => c.startsWith('mkdir -p'))).toBe(true);
  });

  it('commits pre-existing dirt so the run gets its own isolated commit', async () => {
    let statusCalls = 0;
    const run: RollbackRunCommand = async (cmd) => {
      if (/rev-parse --git-dir/.test(cmd)) return { stdout: '.git', exitCode: 0 };
      if (/status --porcelain/.test(cmd)) {
        statusCalls++;
        // dirty on the baseline check, clean once checkAndSave has committed
        return { stdout: statusCalls === 1 ? ' M old.md\n' : '', exitCode: 0 };
      }
      if (/rev-parse --short HEAD/.test(cmd)) return { stdout: 'abc1234\n', exitCode: 0 };
      return { stdout: '', exitCode: 0 };
    };
    await expect(prepareRollbackWorkspace(ROOT, run)).resolves.toBe(true);
  });

  it('REFUSES when the workspace is still dirty after the baseline save', async () => {
    // This is what a secret-scan block looks like from the outside: checkAndSave
    // returns null and leaves the tree dirty. Running optimistically here would
    // mix the user's uncommitted work into the run's commit, so undo could
    // destroy it. Must fail closed.
    const { run } = fakeShell([
      [/rev-parse --git-dir/, { stdout: '.git', exitCode: 0 }],
      [/status --porcelain/, { stdout: ' M secrets.env\n', exitCode: 0 }],
    ]);
    await expect(prepareRollbackWorkspace(ROOT, run)).resolves.toBe(false);
  });

  it('inits a repo AT the workspace root even when an ANCESTOR repo exists (2026-08-05 on-device bug)', async () => {
    // On the verification device $HOME itself is a git repo, so the old
    // ancestor-walking check (`git -C <root> rev-parse --git-dir`) succeeded,
    // `git init` was skipped, and the baseline add/commit ran against the HOME
    // repo — failing there (stale index.lock) and fail-closing the optimistic
    // path forever. The fix keys repo detection off `test -e <root>/.git`.
    const { run, calls } = fakeShell([
      [/^test -e .*\/\.git$/, { exitCode: 1 }], // no repo AT the root…
      [/rev-parse --git-dir/, { stdout: '/home/.git\n', exitCode: 0 }], // …but an ancestor repo exists
      [/status --porcelain/, { stdout: '', exitCode: 0 }],
    ]);
    await expect(prepareRollbackWorkspace(ROOT, run)).resolves.toBe(true);
    // The workspace must get its OWN repo, rooted exactly at ROOT.
    expect(calls.some((c) => c.includes(`git -C '${ROOT}' init`))).toBe(true);
    // And detection must NOT be the ancestor-walking rev-parse form.
    expect(calls.some((c) => /rev-parse --git-dir/.test(c))).toBe(false);
  });

  it('skips init when the workspace root already has its own .git', async () => {
    const { run, calls } = fakeShell([
      [/^test -e .*\/\.git$/, { exitCode: 0 }],
      [/status --porcelain/, { stdout: '', exitCode: 0 }],
    ]);
    await expect(prepareRollbackWorkspace(ROOT, run)).resolves.toBe(true);
    expect(calls.some((c) => c.includes(' init'))).toBe(false);
  });

  it('REFUSES when the workspace directory cannot be created', async () => {
    const { run } = fakeShell([[/^mkdir -p/, { exitCode: 1 }]]);
    await expect(prepareRollbackWorkspace(ROOT, run)).resolves.toBe(false);
  });

  it('REFUSES when git status itself fails', async () => {
    const { run } = fakeShell([
      [/rev-parse --git-dir/, { stdout: '.git', exitCode: 0 }],
      [/status --porcelain/, { exitCode: 128 }],
    ]);
    await expect(prepareRollbackWorkspace(ROOT, run)).resolves.toBe(false);
  });

  it('REFUSES (never throws) when the shell blows up', async () => {
    const run: RollbackRunCommand = async () => {
      throw new Error('exec failed');
    };
    await expect(prepareRollbackWorkspace(ROOT, run)).resolves.toBe(false);
  });
});

describe('captureRollbackPoint', () => {
  it('returns a handle carrying the run commit', async () => {
    const { run } = fakeShell([
      [/status --porcelain/, { stdout: '?? 2026-07-28_news.md\n', exitCode: 0 }],
      [/rev-parse --short HEAD/, { stdout: 'deadbee\n', exitCode: 0 }],
    ]);
    const handle = await captureRollbackPoint('agent-x', ROOT, run);
    expect(handle).not.toBeNull();
    expect(handle!.commitHash).toBe('deadbee');
    expect(handle!.filesCreated).toBe(1);
    expect(handle!.agentId).toBe('agent-x');
  });

  it('returns null when the run wrote nothing (no undo to offer)', async () => {
    const { run } = fakeShell([[/status --porcelain/, { stdout: '', exitCode: 0 }]]);
    await expect(captureRollbackPoint('agent-x', ROOT, run)).resolves.toBeNull();
  });

  it('returns null when the commit fails (no undo to offer)', async () => {
    const { run } = fakeShell([
      [/status --porcelain/, { stdout: '?? out.md\n', exitCode: 0 }],
      [/git -C .* commit -m/, { exitCode: 1 }],
    ]);
    await expect(captureRollbackPoint('agent-x', ROOT, run)).resolves.toBeNull();
  });

  it('returns null and reports issues when the secret scan blocks the commit', async () => {
    const onIssues = jest.fn();
    const { run } = fakeShell([
      [/status --porcelain/, { stdout: '?? leak.env\n', exitCode: 0 }],
      [/diff --cached --name-only/, { stdout: 'leak.env\n', exitCode: 0 }],
    ]);
    await expect(captureRollbackPoint('agent-x', ROOT, run, onIssues)).resolves.toBeNull();
    expect(onIssues).toHaveBeenCalled();
  });
});

describe('undoAgentRun', () => {
  const handle: AgentRollbackHandle = {
    agentId: 'agent-x',
    workspaceRoot: ROOT,
    commitHash: 'deadbee',
    message: 'Auto: Created news.md',
    filesChanged: 0,
    filesCreated: 1,
    filesDeleted: 0,
    createdAtMs: 0,
  };

  it('reverts the run’s OWN commit, not blindly HEAD', async () => {
    const { run, calls } = fakeShell([]);
    await expect(undoAgentRun(handle, run)).resolves.toBe(true);
    expect(calls.some((c) => c.includes('revert deadbee --no-edit'))).toBe(true);
    expect(calls.some((c) => c.includes('revert HEAD'))).toBe(false);
  });

  it('aborts and reports failure when the revert conflicts', async () => {
    const { run, calls } = fakeShell([[/revert deadbee/, { exitCode: 1 }]]);
    await expect(undoAgentRun(handle, run)).resolves.toBe(false);
    expect(calls.some((c) => c.includes('revert --abort'))).toBe(true);
  });

  it.each([
    '; rm -rf / #',
    '$(whoami)',
    'deadbee; id',
    '',
    'zzzz',
    'dead', // too short to be an unambiguous savepoint hash
    'DEADBEEG',
  ])('refuses the malformed commit hash %p without shelling out at all', async (bad) => {
    // Validated, not sanitized: stripping "$(whoami)" down to "a" would produce
    // a plausible short hash git might resolve to an UNRELATED commit — i.e.
    // undo would revert the wrong work. Refusing is the correct outcome.
    const { run, calls } = fakeShell([]);
    await expect(undoAgentRun({ ...handle, commitHash: bad }, run)).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('accepts a well-formed uppercase hash (normalised, not rejected)', async () => {
    const { run, calls } = fakeShell([]);
    await expect(undoAgentRun({ ...handle, commitHash: 'DEADBEE' }, run)).resolves.toBe(true);
    expect(calls.some((c) => c.includes('revert deadbee --no-edit'))).toBe(true);
  });

  it('never throws when the shell blows up', async () => {
    const run: RollbackRunCommand = async () => {
      throw new Error('boom');
    };
    await expect(undoAgentRun(handle, run)).resolves.toBe(false);
  });

  it('summarises a handle for the completion message', () => {
    expect(describeRollbackHandle(handle)).toBe('Auto: Created news.md (+1)');
  });
});
