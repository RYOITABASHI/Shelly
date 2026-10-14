jest.mock('@noble/ciphers/aes.js', () => require('./support/backup-noble-node').nobleAes);
jest.mock('@noble/hashes/scrypt.js', () => require('./support/backup-noble-node').nobleScrypt);
jest.mock('expo-secure-store', () => ({}));

import * as crypto from 'crypto';
import { BackupDecryptError } from '@/lib/backup/crypto';
import { runBackup, runRestore, type BackupDeps, BackupError } from '@/lib/backup/service';
import { nodeRandomBytes } from './support/backup-noble-node';

const HOME_URI = 'file:///data/user/0/dev.shelly.terminal/files/home/';
const PASS = 'Tr0mb0ne-Kettle-Navy-91-backup';
const API_SECRET = 'sk-API-SECRET-VALUE-9f8e7d6c5b4a';
const DEK_SECRET = 'DEK-SECRET-BASE64-AAAAAAAAAAAAAAAAAAAAAA=';
const AUTH_SECRET = '{"tokens":{"access_token":"CODEX-AUTH-SECRET-TOKEN-xyz"}}';
const SSH_SECRET = '-----BEGIN OPENSSH PRIVATE KEY-----\nSSH-PRIVATE-SECRET\n-----END OPENSSH PRIVATE KEY-----\n';
const SECRETS = [API_SECRET, DEK_SECRET, AUTH_SECRET, SSH_SECRET, 'CODEX-AUTH-SECRET-TOKEN-xyz', 'SSH-PRIVATE-SECRET', PASS];

type World = {
  home: Map<string, Buffer>; // rel → content
  tmp: Map<string, Buffer>; // uri → content (anything under homeUri that is not a home file we model)
  sdcard: Map<string, Buffer>; // abs path → content
  commands: string[];
  fsWrites: Array<{ uri: string; data: Buffer }>;
  extracted: string[];
  chmods: string[];
};

function newWorld(): World {
  return { home: new Map(), tmp: new Map(), sdcard: new Map(), commands: [], fsWrites: [], extracted: [], chmods: [] };
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const TMP_REL = '.shelly-backup-tmp/';

function makeDeps(w: World, storage: Map<string, string>, secure: Map<string, string>, extra: Partial<BackupDeps> = {}): BackupDeps {
  const relOf = (uri: string) => (uri.startsWith(HOME_URI) ? uri.slice(HOME_URI.length) : null);
  const readBuf = (uri: string): Buffer => {
    const rel = relOf(uri);
    if (rel !== null && rel.startsWith(TMP_REL)) {
      const b = w.tmp.get(rel);
      if (!b) throw new Error('ENOENT ' + rel);
      return b;
    }
    if (rel !== null && w.home.has(rel)) return w.home.get(rel)!;
    throw new Error('ENOENT ' + uri);
  };
  const tmpPathFromShell = (s: string) => s.replace(/^"\$HOME"\/\.shelly-backup-tmp\//, TMP_REL);
  return {
    homeUri: HOME_URI,
    appVersion: '5.9.0',
    now: () => new Date(2026, 9, 14, 9, 5, 7),
    randomBytes: nodeRandomBytes,
    kdf: { N: 16, r: 1, p: 1 },
    minN: 16,
    fs: {
      async readAsStringAsync(uri, opts) {
        const b = readBuf(uri);
        return opts?.encoding === 'base64' ? b.toString('base64') : b.toString('utf8');
      },
      async writeAsStringAsync(uri, data, opts) {
        const b = opts?.encoding === 'base64' ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
        w.fsWrites.push({ uri, data: b });
        const rel = relOf(uri)!;
        if (rel.startsWith(TMP_REL)) w.tmp.set(rel, b);
        else w.home.set(rel, b);
      },
      async getInfoAsync(uri) {
        const rel = relOf(uri);
        const b = rel !== null ? w.home.get(rel) : undefined;
        return b ? { exists: true, size: b.length, isDirectory: false } : { exists: false };
      },
      async makeDirectoryAsync() {},
      async deleteAsync(uri) {
        if (uri === HOME_URI + TMP_REL) w.tmp.clear();
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
      if (cmd.includes('/system/bin/find')) {
        const all = [...w.home.keys()].map((k) => `./${k}`).join('\n') + '\n';
        const large = [...w.home.entries()].filter(([, b]) => b.length > 1000).map(([k]) => `./${k}`).join('\n');
        w.tmp.set(TMP_REL + 'all.txt', Buffer.from(all));
        w.tmp.set(TMP_REL + 'large.txt', Buffer.from(large));
        return ok();
      }
      let m: RegExpExecArray | null;
      if ((m = /\/system\/bin\/tar -cf '([^']+)' -T '([^']+)'/.exec(cmd))) {
        const list = w.tmp.get(m[2])!.toString('utf8').split('\n').filter(Boolean);
        const archive = list.map((n) => `${n}\0${w.home.get(n.replace(/^\.\//, ''))!.toString('base64')}`).join('\n');
        w.sdcard.set(m[1], Buffer.from(archive));
        return ok();
      }
      if ((m = /sha256sum '([^']+)'/.exec(cmd))) {
        const b = w.sdcard.get(m[1]);
        if (!b) return { stdout: '', stderr: 'no such file', exitCode: 1 };
        return ok(`${sha(b)}  ${m[1]}\n${b.length}\n`);
      }
      if ((m = /\/system\/bin\/tar -t(v?)f '([^']+)'/.exec(cmd))) {
        const names = w.sdcard.get(m[2])!.toString('utf8').split('\n').map((l) => l.split('\0')[0]);
        return ok(names.map((n) => (m![1] ? `-rw------- u0/u0 1 2026-10-14 09:05 ${n}` : n)).join('\n') + '\n');
      }
      if ((m = /\/system\/bin\/tar -xf '([^']+)'/.exec(cmd))) {
        for (const line of w.sdcard.get(m[1])!.toString('utf8').split('\n')) {
          const [n, b64] = line.split('\0');
          const rel = n.replace(/^\.\//, '');
          w.home.set(rel, Buffer.from(b64, 'base64'));
          w.extracted.push(rel);
        }
        return ok();
      }
      if ((m = /\/system\/bin\/cp ("\$HOME"\/\.shelly-backup-tmp\/\S+) '([^']+)'/.exec(cmd))) {
        w.sdcard.set(m[2], w.tmp.get(tmpPathFromShell(m[1]))!);
        return ok();
      }
      if ((m = /\/system\/bin\/cp '([^']+)' ("\$HOME"\/\.shelly-backup-tmp\/\S+)/.exec(cmd))) {
        const b = w.sdcard.get(m[1]);
        if (!b) return { stdout: '', stderr: 'no such file', exitCode: 1 };
        w.tmp.set(tmpPathFromShell(m[2]), b);
        return ok();
      }
      if (cmd.includes('/system/bin/chmod')) {
        w.chmods.push(cmd);
        return ok();
      }
      if (cmd.includes('mkdir -p')) return ok();
      return { stdout: '', stderr: 'unexpected command', exitCode: 127 };
    },
    ...extra,
  };
}

function seedOldInstall() {
  const w = newWorld();
  w.home.set('.shelly/agents/daily.json', Buffer.from('{"id":"daily"}'));
  w.home.set('.shelly/agents/policy.json', Buffer.from('{}'));
  w.home.set('.shelly/workflows/w.json', Buffer.from('{}'));
  w.home.set('.codex/config.toml', Buffer.from('model = "gpt"'));
  w.home.set('.codex/auth.json', Buffer.from(AUTH_SECRET));
  w.home.set('.ssh/id_ed25519', Buffer.from(SSH_SECRET));
  w.home.set('projects/app/node_modules/x/index.js', Buffer.from('module.exports=1'));
  w.home.set('projects/app/src/main.ts', Buffer.from('console.log(1)'));
  w.home.set('models/q.gguf', Buffer.from('GGUF'));
  w.home.set('bin/bash', Buffer.from('#!wrapper'));
  w.home.set('projects/huge.bin', Buffer.alloc(2000, 1)); // "large" in the fake find
  const storage = new Map<string, string>([
    ['shelly_settings', '{"theme":"nord"}'],
    ['shelly_android_update_download', '{"id":42}'],
    ['shelly_social_connectors', JSON.stringify([{ id: 'my-x', platform: 'x', label: 'X' }])],
  ]);
  const secure = new Map<string, string>([
    ['shelly_geminiApiKey', API_SECRET],
    ['shelly_memory_v2_dek', DEK_SECRET],
    ['shelly_policy_file_seal', 'abc123'],
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

describe('backup service', () => {
  it('backs up and restores end-to-end without leaking secrets anywhere', async () => {
    const { w, storage, secure } = seedOldInstall();
    const con = spyConsole();
    let result;
    try {
      result = await runBackup(makeDeps(w, storage, secure), { passphrase: PASS, includeCodexAuth: true, includeLarge: false });
    } finally {
      con.restore();
    }
    expect(result.bundlePath).toBe('/sdcard/Download/shelly-backup-20261014-090507.shellybak');
    expect(result.tarPath).toBe('/sdcard/Download/shelly-backup-20261014-090507.tar');
    expect(result.credentialFiles.sort()).toEqual(['.codex/auth.json', '.ssh/id_ed25519']);
    expect(result.skippedLargeFiles).toBe(1);
    expect(result.counts.agents).toBe(1);

    // tar content: only non-secret includes
    const tar = w.sdcard.get(result.tarPath!)!.toString('utf8');
    const tarNames = tar.split('\n').map((l) => l.split('\0')[0]).sort();
    expect(tarNames).toEqual([
      './.codex/config.toml',
      './.shelly/agents/daily.json',
      './.shelly/agents/policy.json',
      './.shelly/workflows/w.json',
      './projects/app/src/main.ts',
    ]);

    // no plaintext secret in: console, any shell command, any file written, anything on /sdcard
    assertNoSecrets('console', con.calls.map((c) => c.map(String).join(' ')));
    assertNoSecrets('exec', w.commands);
    assertNoSecrets('fs write', w.fsWrites.map((f) => f.data.toString('latin1')));
    assertNoSecrets('sdcard', [...w.sdcard.values()].map((b) => b.toString('latin1')));
    expect(w.tmp.size).toBe(0); // temp dir cleaned

    // ── restore on a fresh install ──
    const fresh = newWorld();
    fresh.sdcard = new Map(w.sdcard);
    const storage2 = new Map<string, string>();
    const secure2 = new Map<string, string>();
    const setSeal = jest.fn(async () => undefined);
    const con2 = spyConsole();
    let summary;
    try {
      summary = await runRestore(makeDeps(fresh, storage2, secure2, { setNativePolicySeal: setSeal }), {
        bundlePath: result.bundlePath,
        tarPath: result.tarPath,
        passphrase: PASS,
      });
    } finally {
      con2.restore();
    }
    assertNoSecrets('restore console', con2.calls.map((c) => c.map(String).join(' ')));
    assertNoSecrets('restore exec', fresh.commands);

    expect(storage2.get('shelly_settings')).toBe('{"theme":"nord"}');
    expect(storage2.has('shelly_android_update_download')).toBe(false);
    expect(summary.skippedSettingsKeys).toEqual(['shelly_android_update_download']);
    expect(secure2.get('shelly_geminiApiKey')).toBe(API_SECRET);
    expect(secure2.get('shelly_memory_v2_dek')).toBe(DEK_SECRET);
    expect(secure2.get('shelly_social-connector.my-x.refreshToken')).toBe('X-REFRESH');
    expect(secure2.get('shelly_policy_file_seal')).toBe('abc123');
    expect(setSeal).toHaveBeenCalledWith('abc123');
    expect(summary.apiKeys).toEqual(expect.arrayContaining(['geminiApiKey', 'memory_v2_dek', 'connector my-x (refreshToken)']));
    expect(fresh.home.get('.codex/auth.json')!.toString()).toBe(AUTH_SECRET);
    expect(fresh.home.get('.ssh/id_ed25519')!.toString()).toBe(SSH_SECRET);
    expect(fresh.chmods.some((c) => c.includes(`chmod 600 "$HOME"/'.codex/auth.json'`))).toBe(true);
    expect(fresh.chmods.some((c) => c.includes(`chmod 700 "$HOME"/'.ssh'`))).toBe(true);
    expect(fresh.home.get('.shelly/agents/daily.json')!.toString()).toBe('{"id":"daily"}');
    expect(summary.homeFilesRestored).toBe(5);
    expect(fresh.tmp.size).toBe(0);
  });

  it('skips Codex login when not selected and the policy seal when no native bridge', async () => {
    const { w, storage, secure } = seedOldInstall();
    const r = await runBackup(makeDeps(w, storage, secure), { passphrase: PASS, includeCodexAuth: false, includeLarge: false });
    expect(r.credentialFiles).toEqual(['.ssh/id_ed25519']);
    expect(r.skippedSecretFiles).toEqual([{ path: '.codex/auth.json', reason: 'codex_login_not_selected' }]);
    const fresh = newWorld();
    fresh.sdcard = new Map(w.sdcard);
    const secure2 = new Map<string, string>();
    const s = await runRestore(makeDeps(fresh, new Map(), secure2), { bundlePath: r.bundlePath, tarPath: r.tarPath, passphrase: PASS });
    expect(secure2.has('shelly_policy_file_seal')).toBe(false);
    expect(s.skippedSecureKeys).toEqual([{ name: 'policy_file_seal', reason: 'device_bound' }]);
    expect(fresh.home.has('.codex/auth.json')).toBe(false);
  });

  it('includeLarge puts large files in the tar', async () => {
    const { w, storage, secure } = seedOldInstall();
    const r = await runBackup(makeDeps(w, storage, secure), { passphrase: PASS, includeCodexAuth: true, includeLarge: true });
    expect(w.sdcard.get(r.tarPath!)!.toString()).toContain('./projects/huge.bin');
    expect(w.sdcard.get(r.tarPath!)!.toString()).not.toContain('q.gguf');
  });

  it('wrong passphrase fails before anything is restored', async () => {
    const { w, storage, secure } = seedOldInstall();
    const r = await runBackup(makeDeps(w, storage, secure), { passphrase: PASS, includeCodexAuth: true, includeLarge: false });
    const fresh = newWorld();
    fresh.sdcard = new Map(w.sdcard);
    const storage2 = new Map<string, string>();
    await expect(
      runRestore(makeDeps(fresh, storage2, new Map()), { bundlePath: r.bundlePath, tarPath: r.tarPath, passphrase: 'Wrong-Passphrase-Entirely-77' }),
    ).rejects.toBeInstanceOf(BackupDecryptError);
    expect(storage2.size).toBe(0);
    expect(fresh.extracted).toEqual([]);
  });

  it('refuses a tampered tar (hash mismatch) and never extracts it', async () => {
    const { w, storage, secure } = seedOldInstall();
    const r = await runBackup(makeDeps(w, storage, secure), { passphrase: PASS, includeCodexAuth: true, includeLarge: false });
    const fresh = newWorld();
    fresh.sdcard = new Map(w.sdcard);
    const evil = `./bin/bash\0${Buffer.from('evil').toString('base64')}`;
    fresh.sdcard.set(r.tarPath!, Buffer.concat([fresh.sdcard.get(r.tarPath!)!, Buffer.from('\n' + evil)]));
    await expect(
      runRestore(makeDeps(fresh, new Map(), new Map()), { bundlePath: r.bundlePath, tarPath: r.tarPath, passphrase: PASS }),
    ).rejects.toMatchObject({ code: 'tar_mismatch' });
    expect(fresh.commands.some((c) => c.includes('tar -xf'))).toBe(false);
  });

  it('restores settings/keys only when no tar is selected', async () => {
    const { w, storage, secure } = seedOldInstall();
    const r = await runBackup(makeDeps(w, storage, secure), { passphrase: PASS, includeCodexAuth: true, includeLarge: false });
    const fresh = newWorld();
    fresh.sdcard = new Map(w.sdcard);
    const s = await runRestore(makeDeps(fresh, new Map(), new Map()), { bundlePath: r.bundlePath, tarPath: null, passphrase: PASS });
    expect(s.tarSkippedReason).toBe('tar_not_selected');
    expect(s.homeFilesRestored).toBe(0);
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
