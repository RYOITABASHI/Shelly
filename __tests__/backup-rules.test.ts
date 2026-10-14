import {
  EXCLUDED_DIR_NAMES,
  EXCLUDED_HOME_PATHS,
  LARGE_FILE_BYTES,
  SECRET_HOME_DIRS,
  SECRET_HOME_FILES,
  backupBaseName,
  buildHomeListScript,
  buildPruneExpression,
  buildTarCreateCommand,
  buildTarExtractCommand,
  classifyHomePath,
  countHomeData,
  normalizeHomeRelPath,
  shQuote,
  validateTarEntries,
} from '@/lib/backup/rules';
import { resolveInAppQueueLine, resolveQueueLine } from '@/lib/deep-link-queue-policy';

jest.mock('expo-secure-store', () => ({}));
import { pairBackupCandidates, siblingTarPath } from '@/lib/backup/service';

describe('classifyHomePath', () => {
  it.each([
    ['.codex/auth.json', 'secret'],
    ['.codex/config.toml', 'include'],
    ['.codex/AGENTS.md', 'include'],
    ['.shelly/agents/daily-digest.json', 'include'],
    ['.shelly/agents/.env', 'secret'],
    ['.shelly/workflows/deploy.json', 'include'],
    ['.ssh/id_ed25519', 'secret'],
    ['.ssh/config', 'secret'],
    ['.git-credentials', 'secret'],
    ['.config/gh/hosts.yml', 'secret'],
    ['.shelly-cs/token', 'secret'],
    ['.shelly/pending-connector-secret-updates/x-refreshToken-1.json', 'secret'],
    ['projects/app/src/index.ts', 'include'],
    ['projects/app/node_modules/react/index.js', 'exclude'],
    ['node_modules/x/y.js', 'exclude'],
    ['projects/py/__pycache__/m.pyc', 'exclude'],
    ['models/Qwen3.5-2B-Q4_K_M.gguf', 'exclude'],
    ['projects/ml/weights.gguf', 'exclude'],
    ['projects/ml/model.safetensors', 'exclude'],
    ['bin/bash', 'exclude'],
    ['.shelly-runtime/codex/current/codex', 'exclude'],
    ['.shelly-agent-driver.js', 'exclude'],
    ['.shelly-local-llm-ensure.sh', 'exclude'],
    ['.bashrc', 'exclude'],
    ['.profile', 'exclude'],
    ['.cache/pip/x', 'exclude'],
    ['.npm/_cacache/x', 'exclude'],
    ['.shelly-deep-link-queue', 'exclude'],
    ['.shelly-deep-link-queue.123.abc.spool', 'exclude'],
    ['.shelly-backup-tmp/all.txt', 'exclude'],
    ['.vimrc', 'include'],
    ['notes.md', 'include'],
  ])('%s → %s', (p, cls) => {
    expect(classifyHomePath(p, 10)).toBe(cls);
  });

  it('excludes >100MB files unless includeLarge', () => {
    expect(classifyHomePath('projects/big.bin', LARGE_FILE_BYTES + 1)).toBe('exclude');
    expect(classifyHomePath('projects/big.bin', LARGE_FILE_BYTES + 1, { includeLarge: true })).toBe('include');
    expect(classifyHomePath('projects/big.bin', LARGE_FILE_BYTES)).toBe('include');
    // includeLarge never re-admits models, runtimes or secrets
    expect(classifyHomePath('models/m.gguf', LARGE_FILE_BYTES + 1, { includeLarge: true })).toBe('exclude');
    expect(classifyHomePath('.codex/auth.json', LARGE_FILE_BYTES + 1, { includeLarge: true })).toBe('secret');
  });

  it('accepts ./ prefixes and rejects unsafe paths', () => {
    expect(classifyHomePath('./.codex/config.toml', 1)).toBe('include');
    expect(normalizeHomeRelPath('./a/b')).toBe('a/b');
    expect(normalizeHomeRelPath('../x')).toBeNull();
    expect(normalizeHomeRelPath('/etc/x')).toBeNull();
    expect(normalizeHomeRelPath('a/\nb')).toBeNull();
    expect(classifyHomePath('a/../../x', 1)).toBe('exclude');
  });
});

describe('shell builders stay consistent with the JS predicate', () => {
  const script = buildHomeListScript('.shelly-backup-tmp');

  it('every pruned subtree is classified exclude by the JS predicate', () => {
    for (const p of EXCLUDED_HOME_PATHS) {
      expect(script).toContain(`-path '${'./' + p}'`);
      expect(classifyHomePath(`${p}/some/file`, 1)).toBe('exclude');
    }
    for (const n of EXCLUDED_DIR_NAMES) {
      expect(script).toContain(`-name '${n}'`);
      expect(classifyHomePath(`projects/a/${n}/f`, 1)).toBe('exclude');
    }
  });

  it('secret dirs are NOT pruned (they must be listed so they reach the bundle)', () => {
    for (const d of [...SECRET_HOME_DIRS, ...SECRET_HOME_FILES]) {
      expect(buildPruneExpression()).not.toContain(`'./${d}'`);
    }
  });

  it('lists only regular files and splits the large ones', () => {
    expect(script).toContain('cd "$HOME"');
    expect(script).toContain('-type f -print > \'.shelly-backup-tmp/all.txt\'');
    expect(script).toContain(`-size +${LARGE_FILE_BYTES}c -print > '.shelly-backup-tmp/large.txt'`);
    expect(script).not.toMatch(/-type l/);
  });

  it('shell-quotes paths', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(buildTarCreateCommand("/sdcard/Download/a b'c.tar", 'l.txt')).toContain(`'/sdcard/Download/a b'\\''c.tar'`);
    expect(buildTarExtractCommand('/sdcard/x;rm -rf ~.tar')).toContain(`'/sdcard/x;rm -rf ~.tar'`);
  });
});

describe('validateTarEntries', () => {
  it('accepts a normal backup tar', () => {
    const r = validateTarEntries(['./.shelly/agents/a.json', './projects/x/README.md'], ['-rw------- u/u 1 2026-10-14 12:00 ./.shelly/agents/a.json']);
    expect(r).toEqual({ ok: true, entries: ['.shelly/agents/a.json', 'projects/x/README.md'] });
  });
  it.each([['../x'], ['/etc/x'], ['a/../../x'], ['./.codex/auth.json'], ['bin/evil'], ['./.bashrc'], ['.ssh/authorized_keys']])('rejects %s', (n) => {
    expect(validateTarEntries([n]).ok).toBe(false);
  });
  it('rejects symlinks and hardlinks', () => {
    expect(validateTarEntries(['./a'], ['lrwxrwxrwx u/u 0 2026-10-14 12:00 ./a -> /etc']).ok).toBe(false);
    expect(validateTarEntries(['./a'], ['hrw-r--r-- u/u 0 2026-10-14 12:00 ./a link to ./b']).ok).toBe(false);
  });
});

describe('misc helpers', () => {
  it('counts agents / workflows / memory / skills', () => {
    expect(
      countHomeData([
        '.shelly/agents/a.json',
        '.shelly/agents/b.json',
        '.shelly/agents/policy.json',
        '.shelly/agents/a.sh',
        '.shelly/workflows/w.json',
        '.shelly/memory/n1.json',
        '.shelly/skills/s/recipe.md',
        'projects/x',
      ]),
    ).toEqual({ agents: 2, workflows: 1, memory: 1, skills: 1, files: 8 });
  });

  it('names and pairs backups newest first', () => {
    expect(backupBaseName(new Date(2026, 9, 14, 9, 5, 7))).toBe('shelly-backup-20261014-090507');
    const c = pairBackupCandidates([
      'shelly-backup-20261013-120000.shellybak',
      'shelly-backup-20261014-090507.shellybak',
      'shelly-backup-20261014-090507.tar',
      'other.txt',
    ]);
    expect(c.map((x) => x.stamp)).toEqual(['20261014-090507', '20261013-120000']);
    expect(c[0].tarPath).toBe('/sdcard/Download/shelly-backup-20261014-090507.tar');
    expect(c[1].tarPath).toBeNull();
    expect(siblingTarPath('/sdcard/x/shelly-backup-20261014-090507.shellybak')).toBe('/sdcard/x/shelly-backup-20261014-090507.tar');
    expect(siblingTarPath('/sdcard/x/foo.shellybak')).toBeNull();
  });

  it('queue accepts exactly shelly://backup and shelly://restore', () => {
    expect(resolveInAppQueueLine('shelly://backup')).toBe('backup');
    expect(resolveInAppQueueLine(' shelly://restore \n')).toBe('restore');
    expect(resolveInAppQueueLine('shelly://backup?x=1')).toBeNull();
    expect(resolveInAppQueueLine('shelly://browser?url=x')).toBeNull();
    // the http(s) policy still rejects other shelly:// lines
    expect(resolveQueueLine('shelly://backup').entry).toBeNull();
  });
});

describe('backup i18n', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const en: Record<string, string> = require('@/lib/i18n/locales/en').default;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ja: Record<string, string> = require('@/lib/i18n/locales/ja').default;
  it('en and ja define the same backup.* keys, covering every key the UI uses', () => {
    const enKeys = Object.keys(en).filter((k) => k.startsWith('backup.')).sort();
    const jaKeys = Object.keys(ja).filter((k) => k.startsWith('backup.')).sort();
    expect(jaKeys).toEqual(enKeys);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fsm = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pathm = require('path') as typeof import('path');
    const root = pathm.resolve(__dirname, '..');
    const src = ['components/settings/BackupRestoreModal.tsx', 'components/layout/SettingsDropdown.tsx']
      .map((f) => fsm.readFileSync(pathm.join(root, f), 'utf8'))
      .join('\n');
    const used = new Set<string>();
    for (const m of src.matchAll(/t\('(backup\.[a-z_.]+)'/g)) used.add(m[1]);
    for (const r of ['too_short', 'all_same', 'sequential', 'repeated_pattern', 'common_pattern', 'low_entropy']) used.add(`backup.weak.${r}`);
    for (const p of ['listing', 'tar', 'hashing', 'collecting', 'kdf', 'writing', 'reading', 'verifying', 'extracting', 'restoring']) used.add(`backup.phase.${p}`);
    for (const r of ['device_bound', 'unknown_key', 'codex_login_not_selected', 'too_large', 'not_a_credential_path', 'install_specific']) used.add(`backup.skip_reason.${r}`);
    expect(used.size).toBeGreaterThan(40);
    for (const k of used) expect(enKeys).toContain(k);
  });
});
