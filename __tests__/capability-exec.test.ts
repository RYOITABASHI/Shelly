import { buildExecAudit, classifyWorkspaceExec } from '@/lib/capability-exec';

describe('capability-exec pure core', () => {
  it('allows a curated command inside a workspace root', () => {
    const verdict = classifyWorkspaceExec({
      command: 'pwd',
      cwd: '/home/shelly/projects/shelly-content-studio',
      roots: ['/home/shelly/projects/shelly-content-studio'],
    });
    expect(verdict.decision).toBe('allow');
    expect(verdict.signals).toContain('inside-root');
    expect(verdict.command?.template).toBe('pwd');
  });

  it('denies cwd traversal outside roots', () => {
    const verdict = classifyWorkspaceExec({
      command: 'printf ok',
      cwd: '/home/shelly/projects/shelly-content-studio/../../outside',
      roots: ['/home/shelly/projects/shelly-content-studio'],
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.signals).toContain('outside-root');
  });

  it('hard-denies CRITICAL commands even inside a root', () => {
    const verdict = classifyWorkspaceExec({
      command: 'rm -rf /',
      cwd: '/home/shelly/projects/shelly-content-studio',
      roots: ['/home/shelly/projects/shelly-content-studio'],
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.signals).toContain('critical-command');
    expect(verdict.dangerLevel).toBe('CRITICAL');
  });

  it('denies commands outside the curated template allowlist', () => {
    const verdict = classifyWorkspaceExec({
      command: 'bash -lc cat /tmp/secret.txt',
      cwd: '/home/shelly/projects/shelly-content-studio',
      roots: ['/home/shelly/projects/shelly-content-studio'],
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.signals).toContain('unsupported-command');
  });

  it('denies curated path arguments outside roots', () => {
    const verdict = classifyWorkspaceExec({
      command: 'cat /tmp/secret.txt',
      cwd: '/home/shelly/projects/shelly-content-studio',
      roots: ['/home/shelly/projects/shelly-content-studio'],
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.signals).toContain('outside-root');
  });

  it('denies shell expansion syntax', () => {
    const verdict = classifyWorkspaceExec({
      command: 'printf ${GEMINI_API_KEY}',
      cwd: '/home/shelly/projects/shelly-content-studio',
      roots: ['/home/shelly/projects/shelly-content-studio'],
    });
    expect(verdict.decision).toBe('deny');
    expect(verdict.signals).toContain('unsafe-shell-syntax');
  });

  it('does not include command text in exec audit entries', () => {
    const verdict = classifyWorkspaceExec({
      command: 'printf "$GEMINI_API_KEY"',
      cwd: '/home/shelly/projects/shelly-content-studio',
      roots: ['/home/shelly/projects/shelly-content-studio'],
    });
    const audit = buildExecAudit({ ts: '2026-07-01T00:00:00.000Z', verdict, timeoutSeconds: 1 });
    expect(JSON.stringify(audit)).not.toContain('GEMINI_API_KEY');
  });
});
