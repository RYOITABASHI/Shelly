/**
 * Auto-savepoint secret gate: segmented Anthropic / OpenAI keys and unquoted
 * env-file tokens are caught, and $HOME is never turned into a savepoint repo.
 */
import { isHomeDir, scanForSecrets } from '../lib/auto-savepoint';

const FAKE = 'x'.repeat(32);

function stagedRepo(files: Record<string, string>) {
  return async (cmd: string) => {
    if (cmd.includes('diff --cached --name-only')) return { stdout: Object.keys(files).join('\n'), exitCode: 0 };
    const m = /show :'([^']+)'/.exec(cmd);
    if (m && m[1] in files) return { stdout: files[m[1]], exitCode: 0 };
    return { stdout: '', exitCode: 1 };
  };
}

describe('auto-savepoint secret scan', () => {
  it('catches segmented Anthropic and OpenAI keys', async () => {
    const issues = await scanForSecrets(
      '/p',
      stagedRepo({ 'a.ts': `const k = sk-ant-oat01-${FAKE};\n`, 'b.ts': `x(sk-proj-${FAKE})\n` }),
    );
    expect(issues.map((i) => i.file).sort()).toEqual(['a.ts', 'b.ts']);
    expect(issues.every((i) => i.label === 'OpenAI/Anthropic key')).toBe(true);
  });

  it('catches unquoted env-file tokens', async () => {
    const issues = await scanForSecrets('/p', stagedRepo({ 'conf.sh': `CLAUDE_CODE_OAUTH_TOKEN=${FAKE}\n` }));
    expect(issues).toEqual([{ file: 'conf.sh', label: 'hardcoded secret', line: 1 }]);
  });

  it('does not flag ordinary code', async () => {
    const issues = await scanForSecrets(
      '/p',
      stagedRepo({ 'c.ts': 'const tokenCount = countTokens(text);\nconst task-list = 1;\n' }),
    );
    expect(issues).toEqual([]);
  });
});

describe('isHomeDir', () => {
  it('compares the resolved directory with ~ in the shell', async () => {
    const run = jest.fn(async (_cmd: string) => ({ stdout: '', exitCode: 0 }));
    expect(await isHomeDir("/data/it's/home", run)).toBe(true);
    expect(run.mock.calls[0][0]).toBe(`[ "$(cd '/data/it'\\''s/home' 2>/dev/null && pwd -P)" = "$(cd ~ && pwd -P)" ]`);
    run.mockResolvedValueOnce({ stdout: '', exitCode: 1 });
    expect(await isHomeDir('/data/project', run)).toBe(false);
  });
});
