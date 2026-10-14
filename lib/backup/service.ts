/**
 * lib/backup/service.ts — backup / restore orchestration (signing-key
 * migration: back up on the OLD install, restore on the NEW one).
 *
 * Outputs (both in /sdcard/Download, same timestamp):
 *   shelly-backup-<ts>.shellybak — encrypted (lib/backup/crypto.ts): every
 *       AsyncStorage pair, every inventoried SecureStore value, credential
 *       files (classifyHomePath → 'secret'), plus the SHA-256 + size of the tar
 *       so the plaintext tar is authenticated by the passphrase-protected bundle.
 *   shelly-backup-<ts>.tar — plaintext NON-secret home files only.
 *
 * Secret-handling invariants (asserted by __tests__/backup-service.test.ts):
 *   - no secret value / passphrase is ever logged, put in a shell command, or
 *     written to disk unencrypted. Credential files are read and written with
 *     expo-file-system on the app-private home path; shell commands only ever
 *     carry file PATHS (chmod, cp of ciphertext, tar of non-secret files).
 *   - the only temp files are file-name lists and the ciphertext itself.
 *
 * All platform access goes through `BackupDeps` so host tests can run the
 * whole flow with fakes.
 */
import {
  decryptBackup,
  encryptBackup,
  utf8Decode,
  utf8Encode,
  type ScryptParams,
} from './crypto';
import {
  BACKUP_FILE_RE,
  BACKUP_TAR_RE,
  CODEX_AUTH_PATH,
  SECRET_FILE_MAX_BYTES,
  LARGE_FILE_BYTES,
  backupBaseName,
  buildHomeListScript,
  buildSha256Command,
  buildTarCreateCommand,
  buildTarExtractCommand,
  buildTarListCommand,
  classifyHomePath,
  countHomeData,
  normalizeHomeRelPath,
  shQuote,
  validateTarEntries,
} from './rules';
import {
  POLICY_SEAL_KEY,
  buildSecureStoreInventory,
  connectorsFromAsyncStorage,
  isRestorableSecureKey,
  secureKeyDisplayName,
} from './secure-store-inventory';
import { base64ToBytes, bytesToBase64 } from '@/lib/memory/base64';

export const BACKUP_DOWNLOAD_DIR = '/sdcard/Download';
export const BACKUP_TMP_REL = '.shelly-backup-tmp';
export const BACKUP_PAYLOAD_SCHEMA = 1;
const SOCIAL_CONNECTORS_ASYNC_KEY = 'shelly_social_connectors';

/**
 * AsyncStorage keys NOT restored — install-specific state that would be wrong
 * on the new install:
 *   - shelly_android_update_download: in-flight DownloadManager id / APK path
 *     of the old install's self-updater (BuildsModal); stale ids would make
 *     the new install poll a download that does not exist.
 * First-launch (`@shelly/setup_wizard_complete`) IS restored: the permission
 * prompts it gates are re-checked on every launch anyway (first-launch-setup).
 */
export const ASYNC_STORAGE_RESTORE_DENYLIST: readonly string[] = Object.freeze([
  'shelly_android_update_download',
]);

export type ExecLike = (command: string, timeoutMs?: number) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export type FsLike = {
  readAsStringAsync(uri: string, opts?: { encoding?: 'utf8' | 'base64' }): Promise<string>;
  writeAsStringAsync(uri: string, data: string, opts?: { encoding?: 'utf8' | 'base64' }): Promise<void>;
  getInfoAsync(uri: string, opts?: { size?: boolean }): Promise<{ exists: boolean; size?: number; isDirectory?: boolean }>;
  makeDirectoryAsync(uri: string, opts?: { intermediates?: boolean }): Promise<void>;
  deleteAsync(uri: string, opts?: { idempotent?: boolean }): Promise<void>;
};

export type AsyncStorageLike = {
  getAllKeys(): Promise<readonly string[]>;
  multiGet(keys: readonly string[]): Promise<readonly (readonly [string, string | null])[]>;
  multiSet(pairs: [string, string][]): Promise<void>;
};

export type SecureStoreLike = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};

export type BackupDeps = {
  exec: ExecLike;
  fs: FsLike;
  asyncStorage: AsyncStorageLike;
  secureStore: SecureStoreLike;
  /** `file:///…/files/home/` — must end with '/'. Same dir as shell $HOME. */
  homeUri: string;
  appVersion?: string;
  now?: () => Date;
  randomBytes?: (n: number) => Promise<Uint8Array>;
  /** Test hook: weaker scrypt params. Production uses DEFAULT_SCRYPT_PARAMS. */
  kdf?: ScryptParams;
  /** Test hook: lower the decrypt-side minimum N. */
  minN?: number;
  /** Native policy-seal mirror (TerminalEmulator.setAgentPolicySeal). */
  setNativePolicySeal?: (value: string) => Promise<void>;
  downloadDir?: string;
};

export type BackupPhase = 'listing' | 'tar' | 'hashing' | 'collecting' | 'kdf' | 'writing' | 'reading' | 'verifying' | 'extracting' | 'restoring';
export type ProgressFn = (phase: BackupPhase, fraction?: number) => void;

export type BackupOptions = {
  passphrase: string;
  includeCodexAuth: boolean;
  includeLarge: boolean;
  onProgress?: ProgressFn;
};

export type BackupPayload = {
  schema: 1;
  createdAt: string;
  appVersion?: string;
  asyncStorage: Record<string, string>;
  secureStore: Record<string, string>;
  files: Record<string, string>;
  tar: { name: string; sha256: string; bytes: number } | null;
  counts: { agents: number; workflows: number; memory: number; skills: number; files: number };
};

export type BackupResult = {
  bundlePath: string;
  tarPath: string | null;
  tarFileCount: number;
  asyncStorageKeys: number;
  secureKeys: string[];
  credentialFiles: string[];
  skippedSecretFiles: { path: string; reason: string }[];
  skippedLargeFiles: number;
  counts: BackupPayload['counts'];
};

export type RestoreOptions = {
  bundlePath: string;
  tarPath: string | null;
  passphrase: string;
  onProgress?: ProgressFn;
};

export type RestoreSummary = {
  settingsKeys: string[];
  skippedSettingsKeys: string[];
  apiKeys: string[];
  skippedSecureKeys: { name: string; reason: string }[];
  credentialFiles: string[];
  skippedFiles: { path: string; reason: string }[];
  homeFilesRestored: number;
  tarSkippedReason: string | null;
  counts: BackupPayload['counts'];
  createdAt: string;
};

export class BackupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

function lines(s: string): string[] {
  return s.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
}

function isSafeAbsolutePath(p: string): boolean {
  // eslint-disable-next-line no-control-regex
  return typeof p === 'string' && p.startsWith('/') && !/[\u0000-\u001f\u007f]/.test(p) && !p.split('/').includes('..');
}

async function run(deps: BackupDeps, cmd: string, timeoutMs: number, what: string): Promise<string> {
  const r = await deps.exec(cmd, timeoutMs);
  if (r.exitCode !== 0) {
    throw new BackupError('exec_failed', `${what} failed (exit ${r.exitCode}): ${(r.stderr || '').slice(0, 300)}`);
  }
  return r.stdout;
}

function tmpUri(deps: BackupDeps, name = ''): string {
  return `${deps.homeUri}${BACKUP_TMP_REL}/${name}`;
}
const TMP_SHELL = `"$HOME"/${BACKUP_TMP_REL}`;

async function resetTmp(deps: BackupDeps): Promise<void> {
  await deps.fs.deleteAsync(tmpUri(deps), { idempotent: true }).catch(() => undefined);
  await deps.fs.makeDirectoryAsync(tmpUri(deps), { intermediates: true });
}
async function cleanupTmp(deps: BackupDeps): Promise<void> {
  await deps.fs.deleteAsync(tmpUri(deps), { idempotent: true }).catch(() => undefined);
}

async function sha256AndSize(deps: BackupDeps, path: string): Promise<{ sha256: string; bytes: number }> {
  const out = lines(await run(deps, buildSha256Command(path), 30 * 60_000, 'sha256sum'));
  const sha256 = (out[0] ?? '').split(/\s+/)[0]?.toLowerCase() ?? '';
  const bytes = Number(out[1]);
  if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isFinite(bytes)) {
    throw new BackupError('hash_failed', 'Could not hash the tar file');
  }
  return { sha256, bytes };
}

// ─── Backup ─────────────────────────────────────────────────────────────────

export async function runBackup(deps: BackupDeps, opts: BackupOptions): Promise<BackupResult> {
  const progress = opts.onProgress ?? (() => undefined);
  const now = (deps.now ?? (() => new Date()))();
  const base = backupBaseName(now);
  const downloadDir = deps.downloadDir ?? BACKUP_DOWNLOAD_DIR;
  const bundlePath = `${downloadDir}/${base}.shellybak`;
  const tarName = `${base}.tar`;
  const tarPath = `${downloadDir}/${tarName}`;

  await resetTmp(deps);
  try {
    // 1. list home files (names only)
    progress('listing');
    // Paths in these scripts are relative to $HOME (the scripts `cd "$HOME"`).
    await run(deps, buildHomeListScript(BACKUP_TMP_REL), 10 * 60_000, 'home listing');
    const all = lines(await deps.fs.readAsStringAsync(tmpUri(deps, 'all.txt'))).map(normalizeHomeRelPath).filter((p): p is string => p !== null);
    const large = new Set(lines(await deps.fs.readAsStringAsync(tmpUri(deps, 'large.txt'))).map(normalizeHomeRelPath).filter((p): p is string => p !== null));

    const includes: string[] = [];
    const secrets: string[] = [];
    let skippedLarge = 0;
    for (const rel of all) {
      const size = large.has(rel) ? LARGE_FILE_BYTES + 1 : 0;
      const cls = classifyHomePath(rel, size, { includeLarge: opts.includeLarge });
      if (cls === 'include') includes.push(rel);
      else if (cls === 'secret') secrets.push(rel);
      else if (large.has(rel) && classifyHomePath(rel, 0) === 'include') skippedLarge++;
    }

    // 2. tar of non-secret files, written by the shell straight to Download
    let tar: BackupPayload['tar'] = null;
    if (includes.length > 0) {
      progress('tar');
      await deps.fs.writeAsStringAsync(tmpUri(deps, 'tar-list.txt'), includes.map((p) => `./${p}`).join('\n') + '\n');
      await run(deps, `/system/bin/mkdir -p ${shQuote(downloadDir)}`, 30_000, 'mkdir');
      await run(deps, buildTarCreateCommand(tarPath, `${BACKUP_TMP_REL}/tar-list.txt`), 60 * 60_000, 'tar');
      progress('hashing');
      const h = await sha256AndSize(deps, tarPath);
      tar = { name: tarName, ...h };
    }

    // 3. collect secrets (in memory only)
    progress('collecting');
    const asyncKeys = [...(await deps.asyncStorage.getAllKeys())];
    const asyncPairs = asyncKeys.length ? await deps.asyncStorage.multiGet(asyncKeys) : [];
    const asyncStorage: Record<string, string> = {};
    for (const [k, v] of asyncPairs) if (typeof v === 'string') asyncStorage[k] = v;

    const inventory = buildSecureStoreInventory(connectorsFromAsyncStorage(asyncStorage[SOCIAL_CONNECTORS_ASYNC_KEY]));
    const secureStore: Record<string, string> = {};
    for (const key of inventory) {
      let v: string | null = null;
      try {
        v = await deps.secureStore.getItemAsync(key);
      } catch {
        v = null;
      }
      if (typeof v === 'string' && v.length > 0) secureStore[key] = v;
    }

    const files: Record<string, string> = {};
    const skippedSecretFiles: { path: string; reason: string }[] = [];
    for (const rel of secrets) {
      if (rel === CODEX_AUTH_PATH && !opts.includeCodexAuth) {
        skippedSecretFiles.push({ path: rel, reason: 'codex_login_not_selected' });
        continue;
      }
      const uri = deps.homeUri + rel;
      const info = await deps.fs.getInfoAsync(uri, { size: true });
      if (!info.exists || info.isDirectory) continue;
      if ((info.size ?? 0) > SECRET_FILE_MAX_BYTES) {
        skippedSecretFiles.push({ path: rel, reason: 'too_large' });
        continue;
      }
      files[rel] = await deps.fs.readAsStringAsync(uri, { encoding: 'base64' });
    }

    const counts = countHomeData(includes);
    const payload: BackupPayload = {
      schema: BACKUP_PAYLOAD_SCHEMA,
      createdAt: now.toISOString(),
      ...(deps.appVersion ? { appVersion: deps.appVersion } : {}),
      asyncStorage,
      secureStore,
      files,
      tar,
      counts,
    };

    // 4. encrypt + write (ciphertext only ever touches disk)
    progress('kdf', 0);
    const ciphertext = await encryptBackup(utf8Encode(JSON.stringify(payload)), opts.passphrase, {
      kdf: deps.kdf,
      appVersion: deps.appVersion,
      createdAt: payload.createdAt,
      randomBytes: deps.randomBytes,
      onProgress: (f) => progress('kdf', f),
    });
    progress('writing');
    await deps.fs.writeAsStringAsync(tmpUri(deps, 'out.shellybak'), bytesToBase64(ciphertext), { encoding: 'base64' });
    await run(deps, `/system/bin/mkdir -p ${shQuote(downloadDir)} && /system/bin/cp ${TMP_SHELL}/out.shellybak ${shQuote(bundlePath)}`, 120_000, 'copy bundle');

    return {
      bundlePath,
      tarPath: tar ? tarPath : null,
      tarFileCount: includes.length,
      asyncStorageKeys: Object.keys(asyncStorage).length,
      secureKeys: Object.keys(secureStore).map(secureKeyDisplayName),
      credentialFiles: Object.keys(files),
      skippedSecretFiles,
      skippedLargeFiles: skippedLarge,
      counts,
    };
  } finally {
    await cleanupTmp(deps);
  }
}

// ─── Candidates ─────────────────────────────────────────────────────────────

export type BackupCandidate = { bundlePath: string; tarPath: string | null; stamp: string };

/** Pure: pair bundles with tars by timestamp, newest first. */
export function pairBackupCandidates(names: string[], dir: string = BACKUP_DOWNLOAD_DIR): BackupCandidate[] {
  const tars = new Set<string>();
  for (const n of names) {
    const m = BACKUP_TAR_RE.exec(n);
    if (m) tars.add(m[1]);
  }
  const out: BackupCandidate[] = [];
  for (const n of names) {
    const m = BACKUP_FILE_RE.exec(n);
    if (!m) continue;
    out.push({ bundlePath: `${dir}/${n}`, tarPath: tars.has(m[1]) ? `${dir}/shelly-backup-${m[1]}.tar` : null, stamp: m[1] });
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
}

export async function listBackupCandidates(deps: Pick<BackupDeps, 'exec' | 'downloadDir'>): Promise<BackupCandidate[]> {
  const dir = deps.downloadDir ?? BACKUP_DOWNLOAD_DIR;
  const r = await deps.exec(`/system/bin/ls -1 ${shQuote(dir)}`, 30_000);
  if (r.exitCode !== 0) return [];
  return pairBackupCandidates(lines(r.stdout), dir);
}

/** For a manually-typed bundle path, guess the sibling tar path. */
export function siblingTarPath(bundlePath: string): string | null {
  const m = /^(.*\/)?shelly-backup-(\d{8}-\d{6})\.shellybak$/.exec(bundlePath);
  return m ? `${m[1] ?? ''}shelly-backup-${m[2]}.tar` : null;
}

// ─── Restore ────────────────────────────────────────────────────────────────

function parsePayload(plaintext: Uint8Array): BackupPayload {
  let p: unknown;
  try {
    p = JSON.parse(utf8Decode(plaintext));
  } catch {
    throw new BackupError('bad_payload', 'Backup contents are not valid');
  }
  const o = p as Partial<BackupPayload> | null;
  const isStrMap = (m: unknown): m is Record<string, string> =>
    !!m && typeof m === 'object' && !Array.isArray(m) && Object.values(m as object).every((v) => typeof v === 'string');
  if (!o || o.schema !== BACKUP_PAYLOAD_SCHEMA || !isStrMap(o.asyncStorage) || !isStrMap(o.secureStore) || !isStrMap(o.files)) {
    throw new BackupError('bad_payload', 'Unsupported backup contents');
  }
  if (o.tar !== null && o.tar !== undefined) {
    const t = o.tar as BackupPayload['tar'];
    if (!t || typeof t.name !== 'string' || !/^[0-9a-f]{64}$/.test(t.sha256) || typeof t.bytes !== 'number') {
      throw new BackupError('bad_payload', 'Unsupported backup contents');
    }
  }
  return {
    schema: 1,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    appVersion: typeof o.appVersion === 'string' ? o.appVersion : undefined,
    asyncStorage: o.asyncStorage,
    secureStore: o.secureStore,
    files: o.files,
    tar: o.tar ?? null,
    counts: o.counts ?? { agents: 0, workflows: 0, memory: 0, skills: 0, files: 0 },
  };
}

export async function runRestore(deps: BackupDeps, opts: RestoreOptions): Promise<RestoreSummary> {
  const progress = opts.onProgress ?? (() => undefined);
  if (!isSafeAbsolutePath(opts.bundlePath)) throw new BackupError('bad_path', 'Backup file path is not valid');
  if (opts.tarPath !== null && !isSafeAbsolutePath(opts.tarPath)) throw new BackupError('bad_path', 'Tar file path is not valid');

  await resetTmp(deps);
  try {
    // 1. decrypt the bundle (copy ciphertext into app-private tmp first)
    progress('reading');
    await run(deps, `/system/bin/cp ${shQuote(opts.bundlePath)} ${TMP_SHELL}/in.shellybak`, 120_000, 'read backup file');
    const bytes = base64ToBytes(await deps.fs.readAsStringAsync(tmpUri(deps, 'in.shellybak'), { encoding: 'base64' }));
    progress('kdf', 0);
    const { plaintext } = await decryptBackup(bytes, opts.passphrase, {
      minN: deps.minN,
      onProgress: (f) => progress('kdf', f),
    });
    const payload = parsePayload(plaintext);
    plaintext.fill(0);

    // 2. verify + extract the tar (only after the authenticated bundle vouches for it)
    let homeFilesRestored = 0;
    let tarSkippedReason: string | null = null;
    if (payload.tar) {
      if (!opts.tarPath) {
        tarSkippedReason = 'tar_not_selected';
      } else {
        progress('verifying');
        const h = await sha256AndSize(deps, opts.tarPath);
        if (h.sha256 !== payload.tar.sha256 || h.bytes !== payload.tar.bytes) {
          throw new BackupError('tar_mismatch', 'The .tar file does not match this backup (modified or from a different backup)');
        }
        const names = lines(await run(deps, buildTarListCommand(opts.tarPath, false), 10 * 60_000, 'tar list'));
        const verbose = lines(await run(deps, buildTarListCommand(opts.tarPath, true), 10 * 60_000, 'tar list'));
        const v = validateTarEntries(names, verbose);
        if (v.ok !== true) {
          const bad = v as Extract<typeof v, { ok: false }>;
          throw new BackupError('tar_unsafe', `Unsafe entry in tar: ${bad.reason}`);
        }
        progress('extracting');
        await run(deps, buildTarExtractCommand(opts.tarPath), 60 * 60_000, 'tar extract');
        homeFilesRestored = (v as Extract<typeof v, { ok: true }>).entries.length;
      }
    }

    progress('restoring');
    // 3. AsyncStorage
    const settingsKeys: string[] = [];
    const skippedSettingsKeys: string[] = [];
    const pairs: [string, string][] = [];
    for (const [k, v] of Object.entries(payload.asyncStorage)) {
      if (ASYNC_STORAGE_RESTORE_DENYLIST.includes(k)) {
        skippedSettingsKeys.push(k);
        continue;
      }
      pairs.push([k, v]);
      settingsKeys.push(k);
    }
    if (pairs.length) await deps.asyncStorage.multiSet(pairs);

    // 4. SecureStore
    const apiKeys: string[] = [];
    const skippedSecureKeys: { name: string; reason: string }[] = [];
    for (const [k, v] of Object.entries(payload.secureStore)) {
      if (!isRestorableSecureKey(k)) {
        skippedSecureKeys.push({ name: secureKeyDisplayName(k), reason: 'unknown_key' });
        continue;
      }
      if (k === POLICY_SEAL_KEY) {
        // Device-bound native mirror: re-seal through the app's own write path
        // so the NEW install's Keystore key HMACs it. Without the bridge the
        // executors could never verify it → skip rather than half-restore.
        if (!deps.setNativePolicySeal) {
          skippedSecureKeys.push({ name: secureKeyDisplayName(k), reason: 'device_bound' });
          continue;
        }
        await deps.secureStore.setItemAsync(k, v);
        await deps.setNativePolicySeal(v);
        apiKeys.push(secureKeyDisplayName(k));
        continue;
      }
      await deps.secureStore.setItemAsync(k, v);
      apiKeys.push(secureKeyDisplayName(k));
    }

    // 5. credential files (mode 600)
    const credentialFiles: string[] = [];
    const skippedFiles: { path: string; reason: string }[] = [];
    for (const [rawRel, b64] of Object.entries(payload.files)) {
      const rel = normalizeHomeRelPath(rawRel);
      if (!rel || rel !== rawRel || classifyHomePath(rel, 0) !== 'secret') {
        skippedFiles.push({ path: rawRel, reason: 'not_a_credential_path' });
        continue;
      }
      const uri = deps.homeUri + rel;
      const parent = uri.slice(0, uri.lastIndexOf('/'));
      await deps.fs.makeDirectoryAsync(parent, { intermediates: true }).catch(() => undefined);
      await deps.fs.writeAsStringAsync(uri, b64, { encoding: 'base64' });
      const firstSeg = rel.split('/')[0];
      const dirChmod = firstSeg === '.ssh' || firstSeg === '.gnupg' ? ` && /system/bin/chmod 700 "$HOME"/${shQuote(firstSeg)}` : '';
      await run(deps, `/system/bin/chmod 600 "$HOME"/${shQuote(rel)}${dirChmod}`, 30_000, 'chmod');
      credentialFiles.push(rel);
    }

    return {
      settingsKeys,
      skippedSettingsKeys,
      apiKeys,
      skippedSecureKeys,
      credentialFiles,
      skippedFiles,
      homeFilesRestored,
      tarSkippedReason,
      counts: payload.counts,
      createdAt: payload.createdAt,
    };
  } finally {
    await cleanupTmp(deps);
  }
}
