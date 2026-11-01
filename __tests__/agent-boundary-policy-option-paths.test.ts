import { classifyProposedCommand, extractPaths, GateContext } from '@/lib/agent-boundary-policy';

// 2026-11-02: tokens starting with `-` were discarded by extractPaths, so a
// path ATTACHED to an option was never boundary-checked.
const ROOT = '/data/user/0/dev.shelly.terminal/files/home/projects/app';
const ctx = (level: GateContext['level']): GateContext => ({
  workspaceRoot: ROOT,
  level,
  policyPath: '.shelly/agents/policy.json',
});

const OUTSIDE_VIA_OPTION = [
  'cp -t/sdcard/Download a',
  'sort -o/sdcard/x f',
  'cp --target-directory=/sdcard/Download a',
  'cp "--target-directory=/sdcard/Download" a',
  "cp --target-directory='/sdcard/Download' a",
  'tee --output-error=warn /sdcard/x',
  'mv -t ~/bin x',
  'mv -t~/bin x',
  'install -D a /sdcard/x',
  'install -Dt/sdcard a',
  'ln -st/sdcard a',
  'ln -sft/sdcard a',
  'tar -xzf/sdcard/a.tgz',
  'tar -C/sdcard -xf a.tar',
  'grep --file=/secret x',
  'grep -f/secret x',
  'sort -o$HOME/x f',
  'sort --output=../escape f',
  'cp -t.. a',
  'sed -i.bak s/a/b/ /sdcard/x',
  "bash -lc 'cp -t/sdcard/Download a'",
  'bash -lc "sort -o/sdcard/x f"',
  // Redirect written without spaces (same token as its target).
  'echo hi>/sdcard/x',
  'cat a>>~/.bashrc',
  'echo hi 2>/sdcard/err',
  'echo hi&>/sdcard/x',
  'echo hi>"/sdcard/x"',
  "bash -lc 'echo hi>/sdcard/x'",
];

describe('extractPaths: option-attached values', () => {
  it.each([
    ['cp -t/sdcard/Download a', '/sdcard/Download'],
    ['cp --target-directory=/sdcard/Download a', '/sdcard/Download'],
    ['mv -t~/bin x', '~/bin'],
    ['ln -st/sdcard a', '/sdcard'],
    ['sort -o$HOME/x f', '$HOME/x'],
    ['grep --file=/secret x', '/secret'],
    ['sort -o=/sdcard/x f', '/sdcard/x'],
    ['cp "--target-directory=/sdcard" a', '/sdcard'],
  ])('%s yields %s', (cmd, expected) => {
    expect(extractPaths(cmd)).toContain(expected);
  });

  it.each([
    'ls -la',
    'git log -n1 --oneline',
    'rm -rf build',
    'grep -rn foo .',
    'ls --color=auto',
    'git log --format=%H',
    'head -n 5 a.txt',
    'sort -u a.txt',
    'git diff --stat',
    'tail -f log.txt',
    'cd -',
    'cat -- a.txt',
  ])('harmless options yield no out-of-root candidate: %s', (cmd) => {
    const paths = extractPaths(cmd);
    expect(paths.every((p) => !p.startsWith('/') && !p.startsWith('~') && !p.startsWith('$') && !p.startsWith('..'))).toBe(true);
  });

  it('a long letter run before `/` is read as one option + a relative value', () => {
    expect(extractPaths('gcc -Iinclude/foo a.c')).toEqual(['include/foo']);
  });
});

describe('classifyProposedCommand: option-attached paths', () => {
  it.each(OUTSIDE_VIA_OPTION)('L2 asks (gray, leaves-root): %s', (cmd) => {
    const v = classifyProposedCommand(cmd, ctx('L2'));
    expect(v.decision).toBe('gray');
    expect(v.signals).toContain('leaves-root');
  });

  it.each(OUTSIDE_VIA_OPTION)('L3 denies: %s', (cmd) => {
    expect(classifyProposedCommand(cmd, ctx('L3')).decision).toBe('deny');
  });

  it('secret path via option is secret-read', () => {
    for (const cmd of ['grep --file=~/.codex/auth.json x', 'grep -f~/.codex/auth.json x']) {
      expect(classifyProposedCommand(cmd, ctx('L2')).signals).toContain('secret-read');
      expect(classifyProposedCommand(cmd, ctx('L3')).decision).toBe('deny');
    }
  });

  it.each([
    'ls -la',
    'git log -n1 --oneline',
    'grep -rn foo src',
    'ls --color=auto src',
    'cp -t src/out a.ts',
    'cp -toutput/dir a.ts',
    'cp --target-directory=src/out a.ts',
    'sort -o./out.txt in.txt',
    'sort --output=out/sorted.txt in.txt',
    'sed -i.bak s/a/b/ src/a.ts',
    "bash -lc 'git log -n1 --oneline'",
    'ls src 2>/dev/null',
    'echo hi>out/a.txt',
    'make 2>&1',
  ])('in-root / harmless options stay allowed at L2 and L3: %s', (cmd) => {
    for (const lvl of ['L2', 'L3'] as const) {
      const v = classifyProposedCommand(cmd, ctx(lvl));
      expect(v.signals).not.toContain('leaves-root');
      expect(v.decision).toBe('allow');
    }
  });

  it('CRITICAL stays a hard deny at every level, with or without option paths', () => {
    for (const cmd of ['rm -rf /', 'rm -fr /', 'rm -rf /*', "bash -lc 'rm -rf /'"]) {
      for (const lvl of ['L1', 'L2', 'L3'] as const) {
        const v = classifyProposedCommand(cmd, ctx(lvl));
        expect(v.decision).toBe('deny');
        expect(v.dangerLevel).toBe('CRITICAL');
      }
    }
    // Not CRITICAL in command-safety (HIGH), but never auto-allowed.
    for (const cmd of ['rm -rf --no-preserve-root /', 'rm -rf -- /']) {
      expect(classifyProposedCommand(cmd, ctx('L2')).decision).toBe('gray');
      expect(classifyProposedCommand(cmd, ctx('L3')).decision).toBe('deny');
    }
  });

  it('a HIGH in-root delete is unaffected (no leaves-root)', () => {
    const v = classifyProposedCommand('rm -rf build', ctx('L2'));
    expect(v.signals).not.toContain('leaves-root');
  });

  it('accepted false positive: a short letter run before `/` asks', () => {
    // `-tsrc/out` could be `-t src/out` or `-tsrc` flags + `/out`; ask.
    expect(classifyProposedCommand('cp -tsrc/out a.ts', ctx('L2')).decision).toBe('gray');
  });

  it('network and policy signals are unchanged', () => {
    expect(classifyProposedCommand('curl --output=out.txt https://example.com', ctx('L2')).signals).toContain('network-send');
    expect(classifyProposedCommand('cp -t.shelly/agents/policy.json x', ctx('L2')).decision).toBe('deny');
  });
});
