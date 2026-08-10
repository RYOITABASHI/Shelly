jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));

import { prepareRollbackWorkspace, type RollbackRunCommand } from '@/lib/agent-rollback';

const ROOT = '/home/test/agent-output';

describe('initial rollback workspace secret scan', () => {
  it('falls back before git add or commit when a secret exists before the first commit', async () => {
    const calls: string[] = [];
    const run: RollbackRunCommand = async (cmd) => {
      calls.push(cmd);
      if (/^test -e .*\/\.git$/.test(cmd)) return { stdout: '', exitCode: 1 };
      if (/ls-files --others --modified --exclude-standard/.test(cmd)) {
        return { stdout: 'draft.md\n', exitCode: 0 };
      }
      if (/head -n 501/.test(cmd)) {
        return { stdout: 'api_key="sk-abcdefghijklmnopqrstuvwxyz"\n', exitCode: 0 };
      }
      return { stdout: '', exitCode: 0 };
    };

    await expect(prepareRollbackWorkspace(ROOT, run)).resolves.toBe(false);
    expect(calls.some((cmd) => /git -C .* init/.test(cmd))).toBe(true);
    expect(calls.some((cmd) => /git -C .* add -A/.test(cmd))).toBe(false);
    expect(calls.some((cmd) => /git -C .* commit/.test(cmd))).toBe(false);
  });
});
