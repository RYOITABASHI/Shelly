import {
  EXCLUDED_DIR_NAMES,
  EXCLUDED_HOME_PATHS,
  LARGE_FILE_BYTES,
  SECRET_HOME_DIRS,
  SECRET_HOME_FILES,
  backupBaseName,
  buildChmodFromListCommand,
  buildHomeListScript,
  buildPruneExpression,
  buildTarCreateCommand,
  buildTarExtractCommand,
  buildTarListCommand,
  classifyHomePath,
  countHomeData,
  normalizeHomeRelPath,
  secretKind,
  shQuote,
  statePriority,
  validateTarEntries,
} from '@/lib/backup/rules';
import * as queuePolicy from '@/lib/deep-link-queue-policy';

jest.mock('expo-secure-store', () => ({}));
import { pairBackupCandidates, siblingTarPath } from '@/lib/backup/service';

describe('classifyHomePath', () => {
  it.each([
    // credentials → encrypted bundle
    ['.codex/auth.json', 'secret'],
    ['.ssh/id_ed25519', 'secret'],
    ['.ssh/config', 'secret'],
    ['.git-credentials', 'secret'],
    ['projects/app/.git-credentials', 'secret'],
    ['.config/gh/hosts.yml', 'secret'],
    ['.shelly-cs/token', 'secret'],
    ['.claude/.credentials.json', 'secret'],
    ['.claude.json', 'secret'],
    ['.gemini/oauth_creds.json', 'secret'],
    ['.gemini/settings.json', 'secret'],
    ['.docker/config.json', 'secret'],
    ['.aws/credentials', 'secret'],
    ['.aws/config', 'secret'],
    ['.kube/config', 'secret'],
    ['.config/rclone/rclone.conf', 'secret'],
    ['.config/gcloud/application_default_credentials.json', 'secret'],
    ['projects/app/.env', 'secret'],
    ['projects/app/.env.local', 'secret'],
    ['.env', 'secret'],
    ['projects/app/.git/config', 'secret'],
    ['.shelly/agents/.env', 'secret'],
    ['.shelly/pending-connector-secret-updates/x-refreshToken-1.json', 'secret'],
    // ~/.shelly state → encrypted bundle
    ['.shelly/agents/daily-digest.json', 'secret'],
    ['.shelly/agents/policy.json', 'secret'],
    ['.shelly/agents/dm-pairings.json', 'secret'],
    ['.shelly/workflows/deploy.json', 'secret'],
    ['.shelly/agents/memory/n.md', 'secret'],
    // histories → excluded
    ['.bash_history', 'exclude'],
    ['.python_history', 'exclude'],
    ['.node_repl_history', 'exclude'],
    ['.sqlite_history', 'exclude'],
    ['.psql_history', 'exclude'],
    ['.mysql_history', 'exclude'],
    ['.zsh_history', 'exclude'],
    ['.viminfo', 'exclude'],
    ['.lesshst', 'exclude'],
    ['.local/share/fish/fish_history', 'exclude'],
    ['projects/app/.python_history', 'exclude'],
    // plain includes
    ['.codex/config.toml', 'secret'],
    ['.codex/AGENTS.md', 'secret'],
    ['projects/app/src/index.ts', 'include'],
    ['projects/app/.git/HEAD', 'include'],
    ['projects/app/docs/history', 'include'],
    ['projects/app/.env-example.md', 'include'],
    ['.vimrc', 'include'],
    ['notes.md', 'include'],
    // excludes
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
    ['.shelly/tmp/x', 'exclude'],
    ['.shelly-deep-link-queue', 'exclude'],
    ['.shelly-deep-link-queue.123.abc.spool', 'exclude'],
    ['.shelly-backup-tmp/all.txt', 'exclude'],
  ])('%s → %s', (p, cls) => {
    expect(classifyHomePath(p, 10)).toBe(cls);
  });

  it('excludes >100MB files unless includeLarge, but never re-admits models/secrets', () => {
    expect(classifyHomePath('projects/big.bin', LARGE_FILE_BYTES + 1)).toBe('exclude');
    expect(classifyHomePath('projects/big.bin', LARGE_FILE_BYTES + 1, { includeLarge: true })).toBe('include');
    expect(classifyHomePath('projects/big.bin', LARGE_FILE_BYTES)).toBe('include');
    expect(classifyHomePath('models/m.gguf', LARGE_FILE_BYTES + 1, { includeLarge: true })).toBe('exclude');
    expect(classifyHomePath('.codex/auth.json', LARGE_FILE_BYTES + 1, { includeLarge: true })).toBe('secret');
    expect(classifyHomePath('.shelly/agents/a.json', LARGE_FILE_BYTES + 1, { includeLarge: true })).toBe('secret');
  });

  it('secretKind / statePriority', () => {
    expect(secretKind('.codex/auth.json')).toBe('credential');
    expect(secretKind('.shelly/agents/.env')).toBe('credential');
    expect(secretKind('.shelly/agents/a.json')).toBe('state');
    expect(statePriority('.shelly/agents/a.json')).toBe(0);
    expect(statePriority('.shelly/agents/memory/x.md')).toBe(1);
    expect(statePriority('.shelly/agents/logs/run.log')).toBe(2);
  });

  it('accepts ./ prefixes and rejects unsafe paths', () => {
    expect(classifyHomePath('./projects/x/README.md', 1)).toBe('include');
    expect(normalizeHomeRelPath('./a/b')).toBe('a/b');
    expect(normalizeHomeRelPath('../x')).toBeNull();
    expect(normalizeHomeRelPath('/etc/x')).toBeNull();
    expect(normalizeHomeRelPath('a/\nb')).toBeNull();
    expect(classifyHomePath('a/../../x', 1)).toBe('exclude');
  });
});

describe('shell builders stay consistent with the JS predicate', () => {
  const script = buildHomeListScript('.shelly-backup-tmp');

  it('every pruned subtree is never classified include by the JS predicate', () => {
    for (const p of EXCLUDED_HOME_PATHS) {
      expect(script).toContain(`-path '${'./' + p}'`);
      expect(classifyHomePath(`${p}/some/file`, 1)).not.toBe('include');
    }
    for (const n of EXCLUDED_DIR_NAMES) {
      expect(script).toContain(`-name '${n}'`);
      expect(classifyHomePath(`projects/a/${n}/f`, 1)).toBe('exclude');
    }
  });

  it('secret dirs and ~/.shelly are NOT pruned (they must be listed so they reach the bundle)', () => {
    for (const d of [...SECRET_HOME_DIRS, ...SECRET_HOME_FILES, '.shelly', '.shelly/agents']) {
      expect(buildPruneExpression()).not.toContain(`'./${d}'`);
    }
  });

  it('lists only regular files and splits the large ones', () => {
    expect(script).toContain('cd "$HOME"');
    expect(script).toContain('-type f -print > \'.shelly-backup-tmp/all.txt\'');
    expect(script).toContain(`-size +${LARGE_FILE_BYTES}c -print > '.shelly-backup-tmp/large.txt'`);
    expect(script).not.toMatch(/-type l/);
  });

  it('shell-quotes paths; restore commands only touch $HOME-relative private paths', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
    expect(buildTarCreateCommand("/sdcard/Download/a b'c.tar", 'l.txt')).toContain(`'/sdcard/Download/a b'\\''c.tar'`);
    expect(buildTarExtractCommand('.shelly-backup-tmp/in.tar')).toBe(`cd "$HOME" && /system/bin/tar -xo -f "$HOME"/'.shelly-backup-tmp/in.tar' -C "$HOME"`);
    expect(buildTarListCommand('.shelly-backup-tmp/in.tar', true)).toBe(`/system/bin/tar -tvf "$HOME"/'.shelly-backup-tmp/in.tar'`);
    expect(buildChmodFromListCommand('.shelly-backup-tmp/r.txt')).toContain('xargs -0 /system/bin/chmod u+rwX,go-rwx');
  });
});

describe('validateTarEntries', () => {
  it('accepts a normal backup tar (files + include-area directories)', () => {
    const r = validateTarEntries(['./projects/', './projects/x/README.md', './notes.md'], ['drwx------ u/u 0 2026-10-14 12:00 ./projects/', '-rw------- u/u 1 2026-10-14 12:00 ./projects/x/README.md']);
    expect(r).toEqual({ ok: true, entries: ['projects', 'projects/x/README.md', 'notes.md'], files: ['projects/x/README.md', 'notes.md'] });
  });
  it.each([
    ['../x'],
    ['/etc/x'],
    ['a/../../x'],
    ['./'],
    ['.'],
    ['./.codex/auth.json'],
    ['./.shelly/agents/a.json'],
    ['bin/evil'],
    ['./.bashrc'],
    ['.ssh/authorized_keys'],
    ['./.bash_history'],
    ['projects/app/.git/config'],
    // directories in excluded / secret areas
    ['./.shelly/'],
    ['./.shelly/agents/'],
    ['./.ssh/'],
    ['./bin/'],
    ['projects/node_modules/'],
    ['./.aws/'],
  ])('rejects %s', (n) => {
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

  it('the shell file-queue cannot open the backup / restore flows', () => {
    expect((queuePolicy as Record<string, unknown>).resolveInAppQueueLine).toBeUndefined();
    for (const l of ['shelly://backup', 'shelly://restore', 'shelly:///restore', '{"url":"shelly://restore"}']) {
      expect(queuePolicy.resolveQueueLine(l).entry).toBeNull();
    }
    // app/_layout.tsx's drain must not special-case them either
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = (require('fs') as typeof import('fs')).readFileSync(
      (require('path') as typeof import('path')).resolve(__dirname, '..', 'app/_layout.tsx'),
      'utf8',
    );
    const drain = src.slice(src.indexOf('const drainQueue = async'), src.indexOf('const drainQueue = async') + 6000);
    expect(drain).not.toMatch(/useBackupModalStore|shelly:\/\/(backup|restore)/);
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
    for (const r of [
      'unknown_key', 'codex_login_not_selected', 'too_large', 'install_specific', 'approval_not_selected', 'bundle_full',
      'not_a_bundle_path', 'policy_invalid', 'policy_seal_unavailable', 'policy_write_failed', 'policy_not_restored',
    ]) used.add(`backup.skip_reason.${r}`);
    expect(used.size).toBeGreaterThan(50);
    for (const k of used) expect(enKeys).toContain(k);
  });
});

describe('AI CLI homes, histories and transcripts (re-review)', () => {
  it.each([
    ['.claude/history.jsonl', 'exclude'],
    ['.codex/history.jsonl', 'exclude'],
    ['.gemini/history.jsonl', 'exclude'],
    ['projects/app/history.jsonl', 'exclude'],
    ['.claude/projects/-home/abc.jsonl', 'exclude'],
    ['.claude/todos/t.json', 'exclude'],
    ['.claude/shell-snapshots/s.sh', 'exclude'],
    ['.codex/sessions/2026/10/14/rollout.jsonl', 'exclude'],
    ['.codex/archived_sessions/x.jsonl', 'exclude'],
    ['.codex/config.toml', 'secret'],
    ['.codex/auth.json', 'secret'],
    ['.claude/settings.json', 'secret'],
    ['.claude/.credentials.json', 'secret'],
    ['.gemini/settings.json', 'secret'],
    ['.gemini/oauth_creds.json', 'secret'],
    ['.docker/config.json', 'secret'],
    ['.docker/contexts/meta/x/meta.json', 'secret'],
    ['.kube/config', 'secret'],
    ['.kube/other-cluster.yaml', 'secret'],
  ] as const)('%s → %s', (p, want) => {
    expect(classifyHomePath(p, 10)).toBe(want);
    expect(classifyHomePath(p, 10, { includeLarge: true })).toBe(want);
  });

  it('never classifies anything under an AI/cloud CLI home as plain-tar content', () => {
    for (const dir of ['.claude', '.codex', '.gemini', '.docker', '.kube', '.aws']) {
      for (const leaf of ['a.json', 'sub/b.txt', 'history.jsonl', 'x.toml']) {
        expect(classifyHomePath(`${dir}/${leaf}`, 1)).not.toBe('include');
      }
    }
  });

  it('rejects AI CLI files and transcripts inside a backup tar', () => {
    for (const bad of ['./.codex/config.toml', './.claude/history.jsonl', './.codex/sessions/a.jsonl', './.claude/']) {
      expect(validateTarEntries([bad]).ok).toBe(false);
    }
  });
});
