jest.mock('@noble/ciphers/aes.js', () => require('./support/backup-noble-node').nobleAes);
jest.mock('@noble/hashes/scrypt.js', () => require('./support/backup-noble-node').nobleScrypt);
jest.mock('expo-secure-store', () => ({}));

import * as crypto from 'crypto';
import { BackupDecryptError } from '@/lib/backup/crypto';
import { applyRestore, openBackup, runBackup, runRestore, type BackupDeps, BackupError } from '@/lib/backup/service';
import { parseUserPolicyFile, serializeUserPolicyFile } from '@/lib/agent-user-policy-store';
import { sha256Hex } from '@/lib/sha256';
import { nodeRandomBytes } from './support/backup-noble-node';

const HOME_URI = 'file:///data/user/0/dev.shelly.terminal/files/home/';
const PASS = 'Tr0mb0ne-Kettle-Navy-91-backup';
const API_SECRET = 'sk-API-SECRET-VALUE-9f8e7d6c5b4a';
const DEK_SECRET = 'DEK-SECRET-BASE64-AAAAAAAAAAAAAAAAAAAAAA=';
const AUTH_SECRET = '{"tokens":{"access_token":"CODEX-AUTH-SECRET-TOKEN-xyz"}}';
const SSH_SECRET = '-----BEGIN OPENSSH PRIVATE KEY-----\nSSH-PRIVATE-SECRET\n-----END OPENSSH PRIVATE KEY-----\n';
const ENV_SECRET = 'OPENAI_API_KEY=sk-DOTENV-SECRET-123\n';
const GITCFG_SECRET = '[remote "origin"]\n\turl = https://ghp_GITREMOTE_SECRET@github.com/u/r.git\n';
const HISTORY_SECRET = 'export GROQ_API_KEY=gsk-HISTORY-SECRET-777\n';
const SECRETS = [
  API_SECRET, DEK_SECRET, AUTH_SECRET, SSH_SECRET, ENV_SECRET, GITCFG_SECRET, HISTORY_SECRET,
  'CODEX-AUTH-SECRET-TOKEN-xyz', 'SSH-PRIVATE-SECRET', 'sk-DOTENV-SECRET-123', 'ghp_GITREMOTE_SECRET', 'gsk-HISTORY-SECRET-777', PASS,
];

const TRUST_KEY = `cli|${'a'.repeat(64)}|git-push`;
const POLICY_TEXT = serializeUserPolicyFile(
  {
    rules: [{ id: 'r1', effect: 'deny', match: { domain: 'x.com' }, source: 'never post to x', createdAt: 1 }],
    trust: { counters: {}, allows: [{ id: 'a1', key: TRUST_KEY, label: 'git push', createdAt: 2 }] },
  },
  1000,
);

type World = {
  home: Map<string, Buffer>;
  tmp: Map<string, Buffer>;
  sdcard: Map<string, Buffer>;
  commands: string[];
  fsWrites: Array<{ uri: string; data: Buffer }>;
  extracted: string[];
  chmodLists: string[][];
  chmods: string[];
  /** test hook: mutate /sdcard right after the tar was copied private */
  afterTarCopy?: (w: World, sdPath: string) => void;
};

function newWorld(): World {
  return { home: new Map(), tmp: new Map(), sdcard: new Map(), commands: [], fsWrites: [], extracted: [], chmodLists: [], chmods: [] };
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const TMP_REL = '.shelly-backup-tmp/';
const HOMEWORD = /"\$HOME"\/'([^']+)'/;

function makeDeps(w: World, storage: Map<string, string>, secure: Map<string, string>, extra: Partial<BackupDeps> = {}): BackupDeps {
  const relOf = (uri: string) => (uri.startsWith(HOME_URI) ? uri.slice(HOME_URI.length) : null);
  const getRel = (rel: string): Buffer | undefined => (rel.startsWith(TMP_REL) ? w.tmp.get(rel) : w.home.get(rel));
  const setRel = (rel: string, b: Buffer) => (rel.startsWith(TMP_REL) ? w.tmp.set(rel, b) : w.home.set(rel, b));
  /** resolve a shell word: "$HOME"/'rel' or '/abs' */
  const word = (s: string): { kind: 'home'; rel: string } | { kind: 'abs'; path: string } => {
    const h = HOMEWORD.exec(s);
    if (h) return { kind: 'home', rel: h[1] };
    return { kind: 'abs', path: /^'([^']+)'$/.exec(s.trim())![1] };
  };
  const readWord = (s: string) => {
    const x = word(s);
    return x.kind === 'home' ? getRel(x.rel) : w.sdcard.get(x.path);
  };
  return {
    homeUri: HOME_URI,
    appVersion: '5.9.0',
    now: () => new Date(2026, 9, 14, 9, 5, 7),
    randomBytes: nodeRandomBytes,
    kdf: { N: 16, r: 1, p: 1 },
    minN: 16,
    fs: {
      async readAsStringAsync(uri, opts) {
        const rel = relOf(uri);
        const b = rel !== null ? getRel(rel) : undefined;
        if (!b) throw new Error('ENOENT ' + uri);
        return opts?.encoding === 'base64' ? b.toString('base64') : b.toString('utf8');
      },
      async writeAsStringAsync(uri, data, opts) {
        const b = opts?.encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
        w.fsWrites.push({ uri, data: b });
        setRel(relOf(uri)!, b);
      },
      async getInfoAsync(uri) {
        const rel = relOf(uri);
        const b = rel !== null ? getRel(rel) : undefined;
        return b ? { exists: true, size: b.length, isDirectory: false } : { exists: false };
      },
      async makeDirectoryAsync() {},
      async deleteAsync(uri) {
        if (uri === HOME_URI + TMP_REL) w.tmp.clear();
        const rel = relOf(uri);
        if (rel) w.home.delete(rel);
      },
    },
    asyncStorage: {
      async getAllKeys() { return [...storage.keys()]; },
      async multiGet(keys) { return keys.map((k) => [k, storage.get(k) ?? null] as const); },
      async multiSet(pairs) { for (const [k, v] of pairs) storage.set(k, v); },
    },
    secureStore: {
      async getItemAsync(k) { return secure.get(k) ?? null; },
      async setItemAsync(k, v) { secure.set(k, v); },
    },
    async exec(cmd) {
      w.commands.push(cmd);
      const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
      const fail = (e: string) => ({ stdout: '', stderr: e, exitCode: 1 });
      let m: RegExpExecArray | null;
      if (cmd.includes('/system/bin/find')) {
        w.tmp.set(TMP_REL + 'all.txt', Buffer.from([...w.home.keys()].map((k) => `./${k}`).join('\n') + '\n'));
        w.tmp.set(TMP_REL + 'large.txt', Buffer.from([...w.home.entries()].filter(([, b]) => b.length > 200 * 1024 * 1024).map(([k]) => `./${k}`).join('\n')));
        return ok();
      }
      if ((m = /\/system\/bin\/tar -cf '([^']+)' -T '([^']+)'/.exec(cmd))) {
        const list = w.tmp.get(m[2])!.toString('utf8').split('\n').filter(Boolean);
        w.sdcard.set(m[1], Buffer.from(list.map((n) => `${n}\0${w.home.get(n.replace(/^\.\//, ''))!.toString('base64')}`).join('\n')));
        return ok();
      }
      if ((m = /sha256sum (\S+) &&/.exec(cmd))) {
        const b = readWord(m[1]);
        return b ? ok(`${sha(b)}  x\n${b.length}\n`) : fail('no such file');
      }
      if ((m = /\/system\/bin\/tar -t(v?)f (\S+)$/.exec(cmd))) {
        const b = readWord(m[2])!;
        const names = b.toString('utf8').split('\n').map((l) => l.split('\0')[0]);
        return ok(names.map((n) => (m![1] ? `-rw------- u0/u0 1 2026-10-14 09:05 ${n}` : n)).join('\n') + '\n');
      }
      if ((m = /\/system\/bin\/tar -xo -f (\S+) -C "\$HOME"/.exec(cmd))) {
        for (const line of readWord(m[1])!.toString('utf8').split('\n')) {
          const [n, b64] = line.split('\0');
          const rel = n.replace(/^\.\//, '');
          w.home.set(rel, Buffer.from(b64, 'base64'));
          w.extracted.push(rel);
        }
        return ok();
      }
      if ((m = /^\/system\/bin\/cp (\S+) (\S+)$/.exec(cmd)) || (m = /&& \/system\/bin\/cp (\S+) (\S+)$/.exec(cmd))) {
        const src = readWord(m[1]);
        if (!src) return fail('no such file');
        const dst = word(m[2]);
        if (dst.kind === 'home') setRel(dst.rel, Buffer.from(src));
        else w.sdcard.set(dst.path, Buffer.from(src));
        if (dst.kind === 'home' && dst.rel.endsWith('in.tar')) w.afterTarCopy?.(w, (word(m[1]) as { path: string }).path);
        return ok();
      }
      if (cmd.includes('/system/bin/xargs -0 /system/bin/chmod')) {
        const lm = /< "\$HOME"\/'([^']+)'/.exec(cmd)!;
        w.chmodLists.push(getRel(lm[1])!.toString('utf8').split('\n').filter(Boolean));
        w.chmods.push(cmd);
        return ok();
      }
      if (cmd.includes('mkdir -p')) return ok();
      return { stdout: '', stderr: 'unexpected command: ' + cmd.slice(0, 60), exitCode: 127 };
    },
    ...extra,
  };
}

function seedOldInstall() {
  const w = newWorld();
  w.home.set('.shelly/agents/daily.json', Buffer.from('{"id":"daily","name":"Daily digest"}'));
  w.home.set('.shelly/agents/policy.json', Buffer.from(POLICY_TEXT));
  w.home.set('.shelly/agents/dm-pairings.json', Buffer.from('[{"id":"p1"}]'));
  w.home.set('.shelly/workflows/w.json', Buffer.from('{}'));
  w.home.set('.codex/config.toml', Buffer.from('model = "gpt"'));
  w.home.set('.codex/auth.json', Buffer.from(AUTH_SECRET));
  w.home.set('.ssh/id_ed25519', Buffer.from(SSH_SECRET));
  w.home.set('.bash_history', Buffer.from(HISTORY_SECRET));
  w.home.set('projects/app/.env', Buffer.from(ENV_SECRET));
  w.home.set('projects/app/.git/config', Buffer.from(GITCFG_SECRET));
  w.home.set('projects/app/.git/HEAD', Buffer.from('ref: refs/heads/main'));
  w.home.set('projects/app/node_modules/x/index.js', Buffer.from('module.exports=1'));
  w.home.set('projects/app/src/main.ts', Buffer.from('console.log(1)'));
  w.home.set('models/q.gguf', Buffer.from('GGUF'));
  w.home.set('bin/bash', Buffer.from('#!wrapper'));
  const storage = new Map<string, string>([
    ['shelly_settings', '{"theme":"nord"}'],
    ['shelly_android_update_download', '{"id":42}'],
    ['shelly_dm_pairings', '[{"id":"p1"}]'],
    ['some_unknown_key', 'x'],
    ['shelly_social_connectors', JSON.stringify([{ id: 'my-x', platform: 'x', label: 'X' }])],
  ]);
  const secure = new Map<string, string>([
    ['shelly_geminiApiKey', API_SECRET],
    ['shelly_memory_v2_dek', DEK_SECRET],
    ['shelly_policy_file_seal', 'b'.repeat(64)],
    ['shelly_policy_trust_allow_keys', JSON.stringify([TRUST_KEY])],
    ['shelly_closepaw_preapprovals_v1', JSON.stringify([{ agentId: 'daily', stepIndex: -1, mode: 'closepaw', goalTemplate: 'g', definitionHash: 'h', createdAt: 1, approvedVia: 'chat' }])],
    ['shelly_social-connector.my-x.refreshToken', 'X-REFRESH'],
  ]);
  return { w, storage, secure };
}

function spyConsole() {
  const calls: unknown[][] = [];
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) =>
    jest.spyOn(console, k).mockImplementation((...a: unknown[]) => { calls.push(a); }),
  );
  return { calls, restore: () => spies.forEach((s) => s.mockRestore()) };
}

function assertNoSecrets(label: string, haystacks: string[]) {
  for (const h of haystacks) {
    for (const s of SECRETS) {
      if (h.includes(s) || h.includes(Buffer.from(s).toString('base64'))) {
        throw new Error(`${label} leaked a secret: ${s.slice(0, 12)}…`);
      }
    }
  }
}

async function backup(opts: { includeCodexAuth?: boolean; includeLarge?: boolean } = {}) {
  const seeded = seedOldInstall();
  const result = await runBackup(makeDeps(seeded.w, seeded.storage, seeded.secure), {
    passphrase: PASS,
    includeCodexAuth: opts.includeCodexAuth ?? true,
    includeLarge: opts.includeLarge ?? false,
  });
  return { ...seeded, result };
}

function freshFrom(w: World) {
  const fresh = newWorld();
  fresh.sdcard = new Map(w.sdcard);
  return fresh;
}

describe('backup', () => {
  it('tar holds only non-secret files; credentials + ~/.shelly go to the bundle; nothing leaks', async () => {
    const seeded = seedOldInstall();
    const con = spyConsole();
    let result;
    try {
      result = await runBackup(makeDeps(seeded.w, seeded.storage, seeded.secure), { passphrase: PASS, includeCodexAuth: true, includeLarge: false });
    } finally {
      con.restore();
    }
    const { w } = seeded;
    expect(result.bundlePath).toBe('/sdcard/Download/shelly-backup-20261014-090507.shellybak');
    expect(result.tarPath).toBe('/sdcard/Download/shelly-backup-20261014-090507.tar');
    expect(result.credentialFiles.sort()).toEqual(['.codex/auth.json', '.codex/config.toml', '.ssh/id_ed25519', 'projects/app/.env', 'projects/app/.git/config']);
    expect(result.stateFiles).toBe(4);
    expect(result.counts.agents).toBe(1);

    const tarNames = w.sdcard.get(result.tarPath!)!.toString('utf8').split('\n').map((l) => l.split('\0')[0]).sort();
    expect(tarNames).toEqual(['./projects/app/.git/HEAD', './projects/app/src/main.ts']);

    assertNoSecrets('console', con.calls.map((c) => c.map(String).join(' ')));
    assertNoSecrets('exec', w.commands);
    assertNoSecrets('fs write', w.fsWrites.map((f) => f.data.toString('latin1')));
    assertNoSecrets('sdcard', [...w.sdcard.values()].map((b) => b.toString('latin1')));
    expect(w.tmp.size).toBe(0);
  });

  it('enforces per-file and total caps for the in-memory bundle (skipped, reported, never tarred)', async () => {
    const seeded = seedOldInstall();
    seeded.w.home.set('.ssh/huge_key', Buffer.alloc(1024 * 1024 + 1, 0x41));
    seeded.w.home.set('.shelly/agents/logs/huge.log', Buffer.alloc(8 * 1024 * 1024 + 1, 0x42));
    for (let i = 0; i < 5; i++) seeded.w.home.set(`.shelly/agents/logs/run${i}.log`, Buffer.alloc(7 * 1024 * 1024, 0x43 + i));
    const r = await runBackup(makeDeps(seeded.w, seeded.storage, seeded.secure), { passphrase: PASS, includeCodexAuth: true, includeLarge: true });
    const reasons = Object.fromEntries(r.skippedSecretFiles.map((s) => [s.path, s.reason]));
    expect(reasons['.ssh/huge_key']).toBe('too_large');
    expect(reasons['.shelly/agents/logs/huge.log']).toBe('too_large');
    expect(Object.values(reasons).filter((x) => x === 'bundle_full').length).toBeGreaterThanOrEqual(1);
    // agent definitions are prioritised over logs
    expect(reasons['.shelly/agents/daily.json']).toBeUndefined();
    const tar = seeded.w.sdcard.get(r.tarPath!)!.toString('latin1');
    expect(tar).not.toContain('.shelly/');
    expect(tar).not.toContain('huge_key');
  });

  it('skips Codex login when not selected', async () => {
    const { result } = await backup({ includeCodexAuth: false });
    expect(result.credentialFiles).not.toContain('.codex/auth.json');
    expect(result.skippedSecretFiles).toEqual([{ path: '.codex/auth.json', reason: 'codex_login_not_selected' }]);
  });
});

describe('restore', () => {
  it('default: no approvals laundered, allowlisted AsyncStorage only, rules-only policy re-sealed, private tar copy only', async () => {
    const { w, result } = await backup();
    const fresh = freshFrom(w);
    const storage2 = new Map<string, string>();
    const secure2 = new Map<string, string>();
    const setSeal = jest.fn(async (_v: string) => undefined);
    const con = spyConsole();
    let summary;
    try {
      summary = await runRestore(makeDeps(fresh, storage2, secure2, { setNativePolicySeal: setSeal }), {
        bundlePath: result.bundlePath,
        tarPath: result.tarPath,
        passphrase: PASS,
      });
    } finally {
      con.restore();
    }
    assertNoSecrets('restore console', con.calls.map((c) => c.map(String).join(' ')));
    assertNoSecrets('restore exec', fresh.commands);

    // F1: hash / list / extract only ever touch the app-private copy
    const tarCmds = fresh.commands.filter((c) => /sha256sum|tar -t|tar -x/.test(c));
    expect(tarCmds.length).toBe(4);
    for (const c of tarCmds) expect(c).not.toContain('/sdcard');
    expect(fresh.commands.some((c) => c.startsWith(`/system/bin/cp '${result.tarPath}' "$HOME"/'.shelly-backup-tmp/in.tar'`))).toBe(true);

    // AsyncStorage allowlist
    expect(storage2.get('shelly_settings')).toBe('{"theme":"nord"}');
    expect(storage2.has('shelly_android_update_download')).toBe(false);
    expect(storage2.has('shelly_dm_pairings')).toBe(false);
    expect(storage2.has('some_unknown_key')).toBe(false);
    expect(summary.skippedSettingsKeys).toEqual(expect.arrayContaining([
      { key: 'shelly_android_update_download', reason: 'install_specific' },
      { key: 'shelly_dm_pairings', reason: 'approval_not_selected' },
      { key: 'some_unknown_key', reason: 'unknown_key' },
    ]));

    // secrets restored; approvals NOT
    expect(secure2.get('shelly_geminiApiKey')).toBe(API_SECRET);
    expect(secure2.get('shelly_memory_v2_dek')).toBe(DEK_SECRET);
    expect(secure2.get('shelly_social-connector.my-x.refreshToken')).toBe('X-REFRESH');
    expect(secure2.has('shelly_closepaw_preapprovals_v1')).toBe(false);
    expect(secure2.has('shelly_policy_trust_allow_keys')).toBe(false);
    expect(summary.approvalsRestored).toBe(false);
    expect(summary.approvalsAvailable).toBe(true);

    // policy: rules kept, trust allows reset, freshly sealed (not the old seal value)
    const policyText = fresh.home.get('.shelly/agents/policy.json')!.toString('utf8');
    const parsed = parseUserPolicyFile(policyText);
    expect(parsed.unavailable).toBe(false);
    expect(parsed.data.rules.map((r) => r.id)).toEqual(['r1']);
    expect(parsed.data.trust.allows).toEqual([]);
    const hash = sha256Hex(policyText);
    expect(secure2.get('shelly_policy_file_seal')).toBe(hash);
    expect(setSeal).toHaveBeenCalledWith(hash);
    expect(summary.policy).toEqual({ state: 'rules_only', ruleCount: 1 });
    expect(fresh.home.has('.shelly/agents/dm-pairings.json')).toBe(false);

    // bundle files + modes
    expect(fresh.home.get('.codex/auth.json')!.toString()).toBe(AUTH_SECRET);
    expect(fresh.home.get('.ssh/id_ed25519')!.toString()).toBe(SSH_SECRET);
    expect(fresh.home.get('projects/app/.git/config')!.toString()).toBe(GITCFG_SECRET);
    expect(fresh.home.get('.shelly/agents/daily.json')!.toString()).toContain('Daily digest');
    expect(fresh.home.has('.bash_history')).toBe(false);
    const chmodded = fresh.chmodLists.flat();
    expect(chmodded).toEqual(expect.arrayContaining(['./.codex/auth.json', './.ssh/id_ed25519', './.shelly/agents/policy.json', './projects/app/src/main.ts']));
    expect(fresh.chmods.some((c) => c.includes(`chmod 700 "$HOME"/'.ssh'`))).toBe(true);
    expect(summary.homeFilesRestored).toBe(2);
    expect(fresh.tmp.size).toBe(0);
  });

  it('opt-in: preview lists what would be re-trusted, and applying restores exactly that', async () => {
    const { w, result } = await backup();
    const fresh = freshFrom(w);
    const storage2 = new Map<string, string>();
    const secure2 = new Map<string, string>();
    const setSeal = jest.fn(async (_v: string) => undefined);
    const deps = makeDeps(fresh, storage2, secure2, { setNativePolicySeal: setSeal });
    const opened = await openBackup(deps, { bundlePath: result.bundlePath, passphrase: PASS });
    expect(opened.preview.approvals).toEqual({
      closePawAgents: ['Daily digest (daily)'],
      trustAllows: ['git push'],
      policyRules: ['deny: never post to x'],
      policyRuleCount: 1,
      dmPairings: 1,
      hasAny: true,
    });
    // opening writes nothing
    expect(storage2.size).toBe(0);
    expect(secure2.size).toBe(0);
    expect(fresh.home.size).toBe(0);

    const summary = await applyRestore(deps, opened, { tarPath: result.tarPath, restoreApprovals: true });
    expect(summary.approvalsRestored).toBe(true);
    expect(secure2.get('shelly_closepaw_preapprovals_v1')).toContain('"agentId":"daily"');
    expect(secure2.get('shelly_policy_trust_allow_keys')).toBe(JSON.stringify([TRUST_KEY]));
    expect(fresh.home.get('.shelly/agents/policy.json')!.toString('utf8')).toBe(POLICY_TEXT);
    expect(secure2.get('shelly_policy_file_seal')).toBe(sha256Hex(POLICY_TEXT));
    expect(setSeal).toHaveBeenCalledWith(sha256Hex(POLICY_TEXT));
    expect(summary.policy).toEqual({ state: 'with_approvals', ruleCount: 1 });
    expect(storage2.get('shelly_dm_pairings')).toBe('[{"id":"p1"}]');
    expect(fresh.home.get('.shelly/agents/dm-pairings.json')!.toString()).toBe('[{"id":"p1"}]');
  });

  it('without the native seal bridge, policy.json is NOT written (never an unsealed non-empty policy)', async () => {
    const { w, result } = await backup();
    const fresh = freshFrom(w);
    const secure2 = new Map<string, string>();
    const s = await runRestore(makeDeps(fresh, new Map(), secure2), { bundlePath: result.bundlePath, tarPath: result.tarPath, passphrase: PASS, restoreApprovals: true });
    expect(s.policy).toEqual({ state: 'skipped', reason: 'seal_unavailable' });
    expect(fresh.home.has('.shelly/agents/policy.json')).toBe(false);
    expect(secure2.has('shelly_policy_file_seal')).toBe(false);
    // trust allows are meaningless without their policy.json
    expect(secure2.has('shelly_policy_trust_allow_keys')).toBe(false);
    expect(s.skippedSecureKeys).toEqual(expect.arrayContaining([{ name: 'policy_trust_allow_keys', reason: 'policy_not_restored' }]));
  });

  it('TOCTOU: swapping the /sdcard tar after the private copy has no effect on what is extracted', async () => {
    const { w, result } = await backup();
    const fresh = freshFrom(w);
    fresh.afterTarCopy = (world, sdPath) => {
      world.sdcard.set(sdPath, Buffer.from(`./.gitconfig\0${Buffer.from('[core]\n\tfsmonitor = evil').toString('base64')}`));
    };
    await runRestore(makeDeps(fresh, new Map(), new Map(), { setNativePolicySeal: async () => undefined }), {
      bundlePath: result.bundlePath,
      tarPath: result.tarPath,
      passphrase: PASS,
    });
    expect(fresh.home.has('.gitconfig')).toBe(false);
    expect(fresh.extracted.sort()).toEqual(['projects/app/.git/HEAD', 'projects/app/src/main.ts']);
  });

  it('refuses a tampered tar (hash mismatch) and never extracts it', async () => {
    const { w, result } = await backup();
    const fresh = freshFrom(w);
    const evil = `./bin/bash\0${Buffer.from('evil').toString('base64')}`;
    fresh.sdcard.set(result.tarPath!, Buffer.concat([fresh.sdcard.get(result.tarPath!)!, Buffer.from('\n' + evil)]));
    await expect(
      runRestore(makeDeps(fresh, new Map(), new Map()), { bundlePath: result.bundlePath, tarPath: result.tarPath, passphrase: PASS }),
    ).rejects.toMatchObject({ code: 'tar_mismatch' });
    expect(fresh.commands.some((c) => c.includes('tar -x'))).toBe(false);
  });

  it('wrong passphrase fails before anything is restored', async () => {
    const { w, result } = await backup();
    const fresh = freshFrom(w);
    const storage2 = new Map<string, string>();
    await expect(
      runRestore(makeDeps(fresh, storage2, new Map()), { bundlePath: result.bundlePath, tarPath: result.tarPath, passphrase: 'Wrong-Passphrase-Entirely-77' }),
    ).rejects.toBeInstanceOf(BackupDecryptError);
    expect(storage2.size).toBe(0);
    expect(fresh.extracted).toEqual([]);
  });

  it('restores settings/keys/bundle files only when no tar is selected', async () => {
    const { w, result } = await backup();
    const fresh = freshFrom(w);
    const s = await runRestore(makeDeps(fresh, new Map(), new Map(), { setNativePolicySeal: async () => undefined }), { bundlePath: result.bundlePath, tarPath: null, passphrase: PASS });
    expect(s.tarSkippedReason).toBe('tar_not_selected');
    expect(s.homeFilesRestored).toBe(0);
    expect(fresh.home.has('.shelly/agents/daily.json')).toBe(true);
  });

  it('rejects unsafe restore paths', async () => {
    const w = newWorld();
    await expect(
      runRestore(makeDeps(w, new Map(), new Map()), { bundlePath: 'relative.shellybak', tarPath: null, passphrase: PASS }),
    ).rejects.toBeInstanceOf(BackupError);
    await expect(
      runRestore(makeDeps(w, new Map(), new Map()), { bundlePath: '/sdcard/../etc/x', tarPath: null, passphrase: PASS }),
    ).rejects.toBeInstanceOf(BackupError);
  });
});
