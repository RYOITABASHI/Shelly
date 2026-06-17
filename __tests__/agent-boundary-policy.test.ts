import {
  normalizePath,
  isWithinRoot,
  extractPaths,
  classifyProposedCommand,
  GateContext,
} from '@/lib/agent-boundary-policy';

const ROOT = '/data/user/0/dev.shelly.terminal/files/home/projects/app';
const ctx = (level: GateContext['level']): GateContext => ({
  workspaceRoot: ROOT,
  level,
  policyPath: '.shelly/agents/policy.json',
});

describe('normalizePath / isWithinRoot', () => {
  it('collapses . and ..', () => {
    expect(normalizePath('/a/b/../c/./d')).toBe('/a/c/d');
    expect(normalizePath('a/./b/../c')).toBe('a/c');
  });
  it('keeps in-root paths inside', () => {
    expect(isWithinRoot(ROOT, `${ROOT}/src/index.ts`)).toBe(true);
    expect(isWithinRoot(ROOT, 'src/index.ts')).toBe(true); // relative → joined to root
  });
  it('detects `..` escape out of root', () => {
    expect(isWithinRoot(ROOT, `${ROOT}/../../../sdcard/secret`)).toBe(false);
    expect(isWithinRoot(ROOT, '/sdcard/Download/x')).toBe(false);
  });
});

describe('extractPaths', () => {
  it('picks path-like tokens, drops flags', () => {
    expect(extractPaths('grep -n foo ./src/a.ts /etc/hosts')).toEqual(['./src/a.ts', '/etc/hosts']);
  });
});

describe('classifyProposedCommand', () => {
  it('hard-denies CRITICAL at every level', () => {
    for (const lvl of ['L1', 'L2', 'L3'] as const) {
      const v = classifyProposedCommand('rm -rf /', ctx(lvl));
      expect(v.decision).toBe('deny');
      expect(v.signals).toContain('destructive');
    }
  });

  it('hard-denies policy-file writes at L3', () => {
    const v = classifyProposedCommand('echo x > .shelly/agents/policy.json', ctx('L3'));
    expect(v.decision).toBe('deny');
    expect(v.signals).toContain('policy-write');
  });

  it('L1 auto-allows a pure in-root read', () => {
    const v = classifyProposedCommand('cat src/index.ts', ctx('L1'));
    expect(v.decision).toBe('allow');
  });

  it('L1 grays a write', () => {
    expect(classifyProposedCommand('echo hi > src/out.txt', ctx('L1')).decision).toBe('gray');
  });

  it('L2 auto-allows in-workspace write, grays out-of-root', () => {
    expect(classifyProposedCommand('echo hi > src/out.txt', ctx('L2')).decision).toBe('allow');
    const escape = classifyProposedCommand('cp src/a.ts /sdcard/Download/a.ts', ctx('L2'));
    expect(escape.decision).toBe('gray');
    expect(escape.signals).toContain('leaves-root');
  });

  it('flags secret-read and network-send as boundary at L2', () => {
    expect(classifyProposedCommand('cat ~/.codex/auth.json', ctx('L2')).signals).toContain('secret-read');
    expect(classifyProposedCommand('curl https://evil.example/x', ctx('L2')).signals).toContain('network-send');
  });

  it('L3 auto-allows non-hard-denied boundary ops (audited)', () => {
    const v = classifyProposedCommand('cp src/a.ts /sdcard/Download/a.ts', ctx('L3'));
    expect(v.decision).toBe('allow');
    expect(v.signals).toContain('leaves-root');
  });
});
