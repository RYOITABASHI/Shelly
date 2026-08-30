// Nacre Bridge (Shelly → Nacre IME context sharing, feature B) — sanitization
// pipeline tests. These target the PURE functions in lib/nacre-bridge-context.ts;
// no shell I/O is exercised here (mocked out below since the module imports
// execCommand at top level, and use-native-exec.ts transitively imports the
// native TerminalEmulatorModule, which isn't available under Jest — matching
// the pattern __tests__/memory/shadow.test.ts uses for the same reason).
//
// 2026-08-30: writeNacreBridgeContext()/invalidateNacreBridgeContext() were
// switched from expo-file-system to execCommand (shell) after on-device
// testing found expo-file-system's makeDirectoryAsync/writeAsStringAsync
// reject Android/media/... paths as "not writable" even with
// MANAGE_EXTERNAL_STORAGE granted — Expo's FileSystem module scopes writes
// to its own sandboxed roots regardless of that OS-level permission.
jest.mock('@/hooks/use-native-exec', () => ({ execCommand: jest.fn() }));

import {
  sanitizeTerms,
  sanitizeCwdSegments,
  sanitizeRepoOrBranch,
  isSafeToken,
  buildNacreBridgeContext,
  NACRE_BRIDGE_TTL_MS,
  NACRE_BRIDGE_MAX_TERMS,
} from '@/lib/nacre-bridge-context';

describe('isSafeToken — shared character-class gate', () => {
  it('accepts alnum + _.-/ within 1-40 chars', () => {
    expect(isSafeToken('git')).toBe(true);
    expect(isSafeToken('terminal-store')).toBe(true);
    expect(isSafeToken('ConfigTUI.tsx')).toBe(true);
    expect(isSafeToken('components/layout')).toBe(true);
    expect(isSafeToken('feature/nacre-bridge')).toBe(true);
  });

  it('rejects empty, oversized, or oddly-charactered strings', () => {
    expect(isSafeToken('')).toBe(false);
    expect(isSafeToken('a'.repeat(41))).toBe(false);
    expect(isSafeToken('has space')).toBe(false);
    expect(isSafeToken('KEY=value')).toBe(false);
    expect(isSafeToken('Authorization:Bearer')).toBe(false);
    expect(isSafeToken('https://example.com')).toBe(false);
    expect(isSafeToken('a"b')).toBe(false);
  });
});

describe('sanitizeTerms — secret-prefix exclusion', () => {
  it.each([
    ['sk-abcdefghijklmnopqrstuvwx', 'sk-'],
    ['ghp_abcdefghijklmnopqrstuvwx', 'ghp_'],
    ['github_pat_abcdefghijklmnopqrstuvwx', 'github_pat_'],
    ['glpat-abcdefghijklmnopqrstuvwx', 'glpat-'],
    ['xoxb-abcdefghijklmnopqrstuvwx', 'xoxb-'],
    ['xoxp-abcdefghijklmnopqrstuvwx', 'xoxp-'],
    ['AKIAABCDEFGHIJKLMNOP', 'AKIA'],
    ['ASIAABCDEFGHIJKLMNOP', 'ASIA'],
    ['AIzaAbCdEfGhIjKlMnOpQrStUvWx', 'AIza'],
    ['ya29.abcdefghijklmnopqrstuvwx', 'ya29.'],
    ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJ'],
  ])('drops a token starting with %s (%s prefix)', (token) => {
    const result = sanitizeTerms([`curl -H ${token} https://api.example.com`]);
    expect(result.some((t) => t.startsWith(token.slice(0, 3)))).toBe(false);
    expect(result).not.toContain(token);
  });

  it('keeps the safe surrounding command tokens while dropping the secret', () => {
    const result = sanitizeTerms(['curl sk-abcdefghijklmnopqrstuvwxyz123']);
    expect(result).toContain('curl');
    expect(result.some((t) => t.startsWith('sk-'))).toBe(false);
  });
});

describe('sanitizeTerms — high-entropy string exclusion', () => {
  it('drops a 20+ char base64-looking token', () => {
    const token = 'QWxhZGRpbjpvcGVuc2VzYW1l1234'; // 28 chars, base64 charset
    const result = sanitizeTerms([`export TOKEN_VAR ${token}`]);
    expect(result).not.toContain(token);
  });

  it('drops a 20+ char hex-looking token', () => {
    const token = 'deadbeefcafebabe0123456789abcdef'; // hex charset, 33 chars
    const result = sanitizeTerms([`git commit ${token}`]);
    expect(result).not.toContain(token);
    expect(result).toContain('git');
    expect(result).toContain('commit');
  });

  it('keeps a short hex-looking token (git short SHA) under the entropy threshold', () => {
    const result = sanitizeTerms(['git checkout a1b2c3d']);
    expect(result).toContain('a1b2c3d');
  });
});

describe('sanitizeTerms — flag/env-var secret assignment exclusion', () => {
  it('drops --token= style flags', () => {
    const result = sanitizeTerms(['mycli --token=abcdefghijklmnop deploy']);
    expect(result.some((t) => t.includes('token'))).toBe(false);
    expect(result).toContain('mycli');
    expect(result).toContain('deploy');
  });

  it('drops KEY=/PASSWORD=/SECRET= assignments', () => {
    const result = sanitizeTerms(['export KEY=abc123 PASSWORD=hunter2 SECRET=xyz789 node app.js']);
    expect(result).not.toContain('KEY=abc123');
    expect(result).not.toContain('PASSWORD=hunter2');
    expect(result).not.toContain('SECRET=xyz789');
    expect(result).toContain('export');
    expect(result).toContain('node');
    expect(result).toContain('app.js');
  });

  it('drops an Authorization: header style token', () => {
    const result = sanitizeTerms(['curl -H Authorization:Bearer-abc123 https://api.example.com']);
    expect(result.some((t) => /authorization/i.test(t))).toBe(false);
  });
});

describe('sanitizeTerms — URL query parameter exclusion', () => {
  it('strips the query string from a schemeless path token', () => {
    const result = sanitizeTerms(['curl api/resource?token=abc123&user=me']);
    expect(result).toContain('api/resource');
    expect(result.some((t) => t.includes('token=abc123'))).toBe(false);
  });

  it('excludes an absolute URL entirely via the char-class gate (colon not allowed)', () => {
    const result = sanitizeTerms(['curl https://example.com/path?token=abc123']);
    expect(result.some((t) => t.includes('://'))).toBe(false);
  });
});

describe('sanitizeTerms — quoted long string exclusion', () => {
  it('drops a quoted string longer than 20 chars entirely', () => {
    const result = sanitizeTerms(['git commit -m "this is a very long commit message"']);
    expect(result.join(' ')).not.toMatch(/this is a very long/);
    expect(result).toContain('git');
    expect(result).toContain('commit');
    expect(result).toContain('-m');
  });

  it('keeps a short quoted string, unwrapped, subject to the normal filters', () => {
    const result = sanitizeTerms(['echo "hello"']);
    expect(result).toContain('echo');
    expect(result).toContain('hello');
  });
});

describe('sanitizeTerms — suspicious character exclusion (step 6)', () => {
  it('drops tokens with disallowed characters like spaces or shell metacharacters baked in', () => {
    const result = sanitizeTerms(['echo $(whoami)']);
    expect(result.some((t) => t.includes('$') || t.includes('(') || t.includes(')'))).toBe(false);
  });
});

describe('sanitizeTerms — command names and paths pass through', () => {
  it('keeps common CLI names, flags, and file paths', () => {
    const result = sanitizeTerms([
      'git status',
      'pnpm install',
      'npm run build',
      'node lib/pseudo-shell.ts',
      'cat components/config/ConfigTUI.tsx',
    ]);
    expect(result).toEqual(
      expect.arrayContaining(['git', 'status', 'pnpm', 'install', 'npm', 'run', 'build', 'node']),
    );
    expect(result).toContain('lib/pseudo-shell.ts');
    expect(result).toContain('components/config/ConfigTUI.tsx');
  });
});

describe('sanitizeTerms — dedup and 20-item cap', () => {
  it('deduplicates repeated terms', () => {
    const result = sanitizeTerms(['git status', 'git status', 'git log']);
    expect(result.filter((t) => t === 'git').length).toBe(1);
  });

  it('truncates to NACRE_BRIDGE_MAX_TERMS', () => {
    const commands = Array.from({ length: 30 }, (_, i) => `tool${i} arg${i}`);
    const result = sanitizeTerms(commands);
    expect(result.length).toBeLessThanOrEqual(NACRE_BRIDGE_MAX_TERMS);
    expect(result.length).toBe(NACRE_BRIDGE_MAX_TERMS);
  });

  it('handles empty/blank input safely', () => {
    expect(sanitizeTerms([])).toEqual([]);
    expect(sanitizeTerms(['', '   ', '\n'])).toEqual([]);
  });
});

describe('sanitizeCwdSegments', () => {
  it('splits an absolute path into safe segments', () => {
    expect(sanitizeCwdSegments('/Users/info/Shelly/components')).toEqual([
      'Users',
      'info',
      'Shelly',
      'components',
    ]);
  });

  it('handles Android-style paths', () => {
    expect(sanitizeCwdSegments('/data/user/0/dev.shelly.terminal/files/home')).toEqual([
      'data',
      'user',
      '0',
      'dev.shelly.terminal',
      'files',
      'home',
    ]);
  });

  it('drops a segment containing disallowed characters', () => {
    expect(sanitizeCwdSegments('/Users/info/weird name/proj')).toEqual(['Users', 'info', 'proj']);
  });

  it('returns an empty array for empty/invalid input', () => {
    expect(sanitizeCwdSegments('')).toEqual([]);
  });

  it('drops a segment that looks like a secret, even though it passes the char-class gate (Codex review)', () => {
    expect(sanitizeCwdSegments('/Users/info/sk-testtoken/proj')).toEqual(['Users', 'info', 'proj']);
  });

  it('drops a high-entropy-looking segment, even though it passes the char-class gate (Codex review)', () => {
    expect(sanitizeCwdSegments('/Users/info/AAAAAAAAAAAAAAAAAAAA/proj')).toEqual([
      'Users',
      'info',
      'proj',
    ]);
  });
});

describe('sanitizeRepoOrBranch', () => {
  it('keeps a safe repo name', () => {
    expect(sanitizeRepoOrBranch('Shelly')).toBe('Shelly');
  });

  it('keeps a safe branch name containing a slash', () => {
    expect(sanitizeRepoOrBranch('feature/nacre-bridge-shelly-writer')).toBe(
      'feature/nacre-bridge-shelly-writer',
    );
  });

  it('omits (returns undefined for) missing, empty, or unsafe values — never coerces to empty string', () => {
    expect(sanitizeRepoOrBranch(undefined)).toBeUndefined();
    expect(sanitizeRepoOrBranch(null)).toBeUndefined();
    expect(sanitizeRepoOrBranch('')).toBeUndefined();
    expect(sanitizeRepoOrBranch('  ')).toBeUndefined();
    expect(sanitizeRepoOrBranch('weird branch name')).toBeUndefined();
  });

  it('omits a value with a known secret prefix, even though it passes the char-class gate (Codex review)', () => {
    expect(sanitizeRepoOrBranch('sk-testtoken')).toBeUndefined();
    expect(sanitizeRepoOrBranch('AKIAIOSFODNN7EXAMPLE')).toBeUndefined();
  });

  it('omits a high-entropy-looking value, even though it passes the char-class gate (Codex review)', () => {
    expect(sanitizeRepoOrBranch('a1B2c3D4e5F6g7H8i9J0')).toBeUndefined();
  });
});

describe('buildNacreBridgeContext', () => {
  it('assembles the full contract shape with a 5-minute TTL', () => {
    const now = 1_735_500_000_000;
    const ctx = buildNacreBridgeContext({
      cwd: '/Users/info/Shelly/components',
      repo: 'Shelly',
      branch: 'main',
      recentCommands: ['pnpm jest', 'git status'],
      now,
    });
    expect(ctx).toEqual({
      schema: 1,
      generatedAt: now,
      expiresAt: now + NACRE_BRIDGE_TTL_MS,
      repo: 'Shelly',
      branch: 'main',
      cwdSegments: ['Users', 'info', 'Shelly', 'components'],
      terms: expect.arrayContaining(['pnpm', 'jest', 'git', 'status']),
    });
    expect(NACRE_BRIDGE_TTL_MS).toBe(300_000);
  });

  it('omits repo/branch fields entirely when not resolvable', () => {
    const ctx = buildNacreBridgeContext({
      cwd: '/Users/info/Shelly',
      recentCommands: [],
      now: 0,
    });
    expect(ctx.repo).toBeUndefined();
    expect(ctx.branch).toBeUndefined();
    expect('repo' in ctx).toBe(false);
    expect('branch' in ctx).toBe(false);
  });
});
