/**
 * lib/backup/service.ts — backup / restore orchestration (signing-key
 * migration: back up on the OLD install, restore on the NEW one).
 *
 * Outputs (both in /sdcard/Download, same timestamp):
 *   shelly-backup-<ts>.shellybak — encrypted (lib/backup/crypto.ts): every
 *       AsyncStorage pair, every inventoried SecureStore value, every file
 *       classifyHomePath() calls 'secret' (credentials + all of ~/.shelly,
 *       within the size caps in rules.ts), plus the SHA-256 + size of the tar
 *       so the plaintext tar is authenticated by the passphrase-protected bundle.
 *   shelly-backup-<ts>.tar — plaintext NON-secret home files only.
 *
 * Restore is two-phase so the user can see what would be re-trusted before
 * anything is written:
 *   openBackup()   — decrypt + parse + build a RestorePreview (no writes)
 *   applyRestore() — tar (private copy → verify → validate → extract), then
 *                    allowlisted AsyncStorage, SecureStore, bundle files, and
 *                    the approval group only if `restoreApprovals` is true.
 *
 * Secret-handling invariants (asserted by __tests__/backup-service.test.ts):
 *   - no secret value / passphrase is ever logged, put in a shell command, or
 *     written to disk unencrypted outside its own restored location. Bundle
 *     files are read and written with expo-file-system on the app-private home
 *     path; shell commands only ever carry file PATHS.
 *   - the only temp files are file-name lists, the ciphertext, and the private
 *     copy of the (non-secret) tar.
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
  CREDENTIAL_FILE_MAX_BYTES,
  CREDENTIAL_TOTAL_MAX_BYTES,
  LARGE_FILE_BYTES,
  STATE_FILE_MAX_BYTES,
  STATE_TOTAL_MAX_BYTES,
  backupBaseName,
  buildChmodFromListCommand,
  buildHomeListScript,
  buildSha256Command,
  buildTarCreateCommand,
  buildTarExtractCommand,
  buildTarListCommand,
  classifyHomePath,
  countHomeData,
  homeWord,
  normalizeHomeRelPath,
  secretKind,
  shQuote,
  statePriority,
  validateTarEntries,
} from './rules';
import {
  APPROVAL_SECURE_KEYS,
  CLOSEPAW_PREAPPROVAL_KEY,
  POLICY_SEAL_KEY,
  TRUST_ALLOW_SEAL_KEY,
  buildSecureStoreInventory,
  connectorsFromAsyncStorage,
  isRestorableSecureKey,
  secureKeyDisplayName,
} from './secure-store-inventory';
import { ASYNC_STORAGE_RESTORE_DENYLIST, asyncKeyDecision } from './async-storage-allowlist';
import { base64ToBytes, bytesToBase64 } from '@/lib/memory/base64';
import { emptyUserPolicy, parseUserPolicyFile, serializeUserPolicyFile } from '@/lib/agent-user-policy-store';
import { USER_POLICY_RELATIVE_PATH } from '@/lib/agent-action-policy';
import { sha256Hex } from '@/lib/sha256';

export { ASYNC_STORAGE_RESTORE_DENYLIST };

export const BACKUP_DOWNLOAD_DIR = '/sdcard/Download';
export const BACKUP_TMP_REL = '.shelly-backup-tmp';
export const BACKUP_PAYLOAD_SCHEMA = 2;
const SOCIAL_CONNECTORS_ASYNC_KEY = 'shelly_social_connectors';
export const DM_PAIRINGS_REL = '.shelly/agents/dm-pairings.json';
/** Bundle files handled by the approval step, never by the generic loop. */
const APPROVAL_FILES = new Set<string>([USER_POLICY_RELATIVE_PATH, DM_PAIRINGS_REL]);

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

export type BackupCounts = { agents: number; workflows: number; memory: number; skills: number; files: number };

export type BackupPayload = {
  schema: 2;
  createdAt: string;
  appVersion?: string;
  asyncStorage: Record<string, string>;
  secureStore: Record<string, string>;
  files: Record<string, string>;
  tar: { name: string; sha256: string; bytes: number } | null;
  counts: BackupCounts;
};

export type SkippedFile = { path: string; reason: string };

export type BackupResult = {
  bundlePath: string;
  tarPath: string | null;
  tarFileCount: number;
  asyncStorageKeys: number;
  secureKeys: string[];
  credentialFiles: string[];
  stateFiles: number;
  skippedSecretFiles: SkippedFile[];
  skippedLargeFiles: number;
  counts: BackupCounts;
};

export type ApprovalPreview = {
  closePawAgents: string[];
  trustAllows: string[];
  policyRules: string[];
  policyRuleCount: number;
  dmPairings: number;
  hasAny: boolean;
};

export type RestorePreview = {
  createdAt: string;
  appVersion?: string;
  counts: BackupCounts;
  hasTar: boolean;
  approvals: ApprovalPreview;
};

export type OpenedBackup = {
  /** In-memory decrypted payload — holds secrets; drop the reference when done. */
  payload: BackupPayload;
  preview: RestorePreview;
};

export type RestoreApplyOptions = {
  tarPath: string | null;
  /** Default false: re-trust ClosePaw pre-approvals, trust allows, the exact
   *  policy.json (re-sealed) and DM pairings from the bundle. */
  restoreApprovals?: boolean;
  onProgress?: ProgressFn;
};

export type RestoreOptions = {
  bundlePath: string;
  tarPath: string | null;
  passphrase: string;
  restoreApprovals?: boolean;
  onProgress?: ProgressFn;
};

export type PolicyRestoreOutcome =
  | { state: 'none' }
  | { state: 'rules_only'; ruleCount: number }
  | { state: 'with_approvals'; ruleCount: number }
  | { state: 'skipped'; reason: 'invalid' | 'seal_unavailable' | 'write_failed' };

export type RestoreSummary = {
  settingsKeys: string[];
  skippedSettingsKeys: { key: string; reason: string }[];
  apiKeys: string[];
  skippedSecureKeys: { name: string; reason: string }[];
  credentialFiles: string[];
  stateFiles: number;
  skippedFiles: SkippedFile[];
  homeFilesRestored: number;
  tarSkippedReason: string | null;
  approvalsRestored: boolean;
  approvalsAvailable: boolean;
  policy: PolicyRestoreOutcome;
  counts: BackupCounts;
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
const tmpRel = (name: string) => `${BACKUP_TMP_REL}/${name}`;

async function resetTmp(deps: BackupDeps): Promise<void> {
  await deps.fs.deleteAsync(tmpUri(deps), { idempotent: true }).catch(() => undefined);
  await deps.fs.makeDirectoryAsync(tmpUri(deps), { intermediates: true });
}
async function cleanupTmp(deps: BackupDeps): Promise<void> {
  await deps.fs.deleteAsync(tmpUri(deps), { idempotent: true }).catch(() => undefined);
}

async function sha256AndSize(deps: BackupDeps, fileWord: string): Promise<{ sha256: string; bytes: number }> {
  const out = lines(await run(deps, buildSha256Command(fileWord), 30 * 60_000, 'sha256sum'));
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
    // 1. list home files (names only). Paths are relative to $HOME (the scripts cd there).
    progress('listing');
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
      await run(deps, buildTarCreateCommand(tarPath, tmpRel('tar-list.txt')), 60 * 60_000, 'tar');
      progress('hashing');
      const h = await sha256AndSize(deps, shQuote(tarPath));
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

    const { files, skipped: skippedSecretFiles, credentialFiles, stateFiles } = await collectBundleFiles(deps, secrets, opts.includeCodexAuth);

    const counts = countHomeData([...includes, ...Object.keys(files)]);
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
    await run(deps, `/system/bin/mkdir -p ${shQuote(downloadDir)} && /system/bin/cp ${homeWord(tmpRel('out.shellybak'))} ${shQuote(bundlePath)}`, 120_000, 'copy bundle');

    return {
      bundlePath,
      tarPath: tar ? tarPath : null,
      tarFileCount: includes.length,
      asyncStorageKeys: Object.keys(asyncStorage).length,
      secureKeys: Object.keys(secureStore).map(secureKeyDisplayName),
      credentialFiles,
      stateFiles,
      skippedSecretFiles,
      skippedLargeFiles: skippedLarge,
      counts,
    };
  } finally {
    await cleanupTmp(deps);
  }
}

/** Read 'secret' files into memory within the per-file / total caps.
 *  Anything over a cap is skipped and reported — never tarred. */
async function collectBundleFiles(
  deps: BackupDeps,
  secrets: string[],
  includeCodexAuth: boolean,
): Promise<{ files: Record<string, string>; skipped: SkippedFile[]; credentialFiles: string[]; stateFiles: number }> {
  const skipped: SkippedFile[] = [];
  const sized: { rel: string; kind: 'credential' | 'state'; size: number }[] = [];
  for (const rel of secrets) {
    if (rel === CODEX_AUTH_PATH && !includeCodexAuth) {
      skipped.push({ path: rel, reason: 'codex_login_not_selected' });
      continue;
    }
    const info = await deps.fs.getInfoAsync(deps.homeUri + rel, { size: true });
    if (!info.exists || info.isDirectory) continue;
    sized.push({ rel, kind: secretKind(rel), size: info.size ?? 0 });
  }
  // credentials keep listing order; state is kept by priority, then smallest first
  const creds = sized.filter((s) => s.kind === 'credential');
  const state = sized
    .filter((s) => s.kind === 'state')
    .sort((a, b) => statePriority(a.rel) - statePriority(b.rel) || a.size - b.size || (a.rel < b.rel ? -1 : 1));
  const files: Record<string, string> = {};
  const credentialFiles: string[] = [];
  let stateFiles = 0;
  const take = async (list: typeof sized, perFile: number, total: number, onTake: (rel: string) => void) => {
    let used = 0;
    for (const s of list) {
      if (s.size > perFile) {
        skipped.push({ path: s.rel, reason: 'too_large' });
        continue;
      }
      if (used + s.size > total) {
        skipped.push({ path: s.rel, reason: 'bundle_full' });
        continue;
      }
      files[s.rel] = await deps.fs.readAsStringAsync(deps.homeUri + s.rel, { encoding: 'base64' });
      used += s.size;
      onTake(s.rel);
    }
  };
  await take(creds, CREDENTIAL_FILE_MAX_BYTES, CREDENTIAL_TOTAL_MAX_BYTES, (rel) => credentialFiles.push(rel));
  await take(state, STATE_FILE_MAX_BYTES, STATE_TOTAL_MAX_BYTES, () => { stateFiles++; });
  return { files, skipped, credentialFiles, stateFiles };
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
    throw new BackupError('bad_payload', 'Unsupported backup contents (made by a different Shelly version?)');
  }
  if (o.tar !== null && o.tar !== undefined) {
    const t = o.tar as BackupPayload['tar'];
    if (!t || typeof t.name !== 'string' || !/^[0-9a-f]{64}$/.test(t.sha256) || typeof t.bytes !== 'number') {
      throw new BackupError('bad_payload', 'Unsupported backup contents');
    }
  }
  return {
    schema: BACKUP_PAYLOAD_SCHEMA,
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : '',
    appVersion: typeof o.appVersion === 'string' ? o.appVersion : undefined,
    asyncStorage: o.asyncStorage,
    secureStore: o.secureStore,
    files: o.files,
    tar: o.tar ?? null,
    counts: o.counts ?? { agents: 0, workflows: 0, memory: 0, skills: 0, files: 0 },
  };
}

function bundleFileText(payload: BackupPayload, rel: string): string | null {
  const b64 = payload.files[rel];
  if (typeof b64 !== 'string') return null;
  try {
    return utf8Decode(base64ToBytes(b64));
  } catch {
    return null;
  }
}

function safeJson(text: string | null | undefined): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Pure: what the approval opt-in would re-trust (names only, no secrets). */
export function buildApprovalPreview(payload: BackupPayload): ApprovalPreview {
  const closePawRaw = safeJson(payload.secureStore[CLOSEPAW_PREAPPROVAL_KEY]);
  const agentIds = Array.isArray(closePawRaw)
    ? [...new Set(closePawRaw.map((s) => (s && typeof s.agentId === 'string' ? s.agentId : null)).filter((x): x is string => !!x))]
    : [];
  const closePawAgents = agentIds.map((id) => {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) return id.slice(0, 40);
    const def = safeJson(bundleFileText(payload, `.shelly/agents/${id}.json`)) as { name?: unknown } | null;
    return def && typeof def.name === 'string' && def.name.trim() ? `${def.name.trim().slice(0, 60)} (${id})` : id;
  });

  const policyText = bundleFileText(payload, USER_POLICY_RELATIVE_PATH);
  const policy = policyText ? parseUserPolicyFile(policyText) : null;
  const sealedTrustKeysRaw = safeJson(payload.secureStore[TRUST_ALLOW_SEAL_KEY]);
  const sealedTrustKeys = new Set(Array.isArray(sealedTrustKeysRaw) ? sealedTrustKeysRaw.filter((k): k is string => typeof k === 'string') : []);
  const trustAllows =
    policy && !policy.unavailable
      ? policy.data.trust.allows.filter((a) => sealedTrustKeys.has(a.key)).map((a) => (a.label || a.key).slice(0, 80))
      : [];
  const rules = policy && !policy.unavailable ? policy.data.rules : [];
  const policyRules = rules.slice(0, 10).map((r) => `${r.effect}: ${(r.source || '').slice(0, 80)}`);

  const dmRaw = safeJson(payload.asyncStorage['shelly_dm_pairings']) ?? safeJson(bundleFileText(payload, DM_PAIRINGS_REL));
  const dmPairings = Array.isArray(dmRaw) ? dmRaw.length : 0;

  return {
    closePawAgents,
    trustAllows,
    policyRules,
    policyRuleCount: rules.length,
    dmPairings,
    hasAny: closePawAgents.length > 0 || trustAllows.length > 0 || dmPairings > 0,
  };
}

/** Phase 1: decrypt + parse. Writes nothing outside the private tmp dir. */
export async function openBackup(
  deps: BackupDeps,
  opts: { bundlePath: string; passphrase: string; onProgress?: ProgressFn },
): Promise<OpenedBackup> {
  const progress = opts.onProgress ?? (() => undefined);
  if (!isSafeAbsolutePath(opts.bundlePath)) throw new BackupError('bad_path', 'Backup file path is not valid');
  await resetTmp(deps);
  try {
    progress('reading');
    await run(deps, `/system/bin/cp ${shQuote(opts.bundlePath)} ${homeWord(tmpRel('in.shellybak'))}`, 120_000, 'read backup file');
    const bytes = base64ToBytes(await deps.fs.readAsStringAsync(tmpUri(deps, 'in.shellybak'), { encoding: 'base64' }));
    progress('kdf', 0);
    const { plaintext } = await decryptBackup(bytes, opts.passphrase, {
      minN: deps.minN,
      onProgress: (f) => progress('kdf', f),
    });
    const payload = parsePayload(plaintext);
    plaintext.fill(0);
    return {
      payload,
      preview: {
        createdAt: payload.createdAt,
        appVersion: payload.appVersion,
        counts: payload.counts,
        hasTar: !!payload.tar,
        approvals: buildApprovalPreview(payload),
      },
    };
  } finally {
    await cleanupTmp(deps);
  }
}

async function writeBundleFile(deps: BackupDeps, rel: string, b64: string): Promise<void> {
  const uri = deps.homeUri + rel;
  const parent = uri.slice(0, uri.lastIndexOf('/'));
  await deps.fs.makeDirectoryAsync(parent, { intermediates: true }).catch(() => undefined);
  await deps.fs.writeAsStringAsync(uri, b64, { encoding: 'base64' });
}

/** Write policy.json text and seal its hash through the app's own seal path
 *  (SecureStore + native re-HMAC). Without the native bridge the executors
 *  could never verify it, so nothing is written (rules not restored). */
async function writeSealedPolicy(deps: BackupDeps, text: string): Promise<'ok' | 'seal_unavailable' | 'write_failed'> {
  if (!deps.setNativePolicySeal) return 'seal_unavailable';
  const hash = sha256Hex(text);
  try {
    await writeBundleFile(deps, USER_POLICY_RELATIVE_PATH, bytesToBase64(utf8Encode(text)));
    await deps.secureStore.setItemAsync(POLICY_SEAL_KEY, hash);
    await deps.setNativePolicySeal(hash);
    return 'ok';
  } catch {
    // Never leave an unsealed non-empty policy.json behind (that would make
    // the policy "unavailable" = escalate every side effect).
    await deps.fs.deleteAsync(deps.homeUri + USER_POLICY_RELATIVE_PATH, { idempotent: true }).catch(() => undefined);
    return 'write_failed';
  }
}

/** Phase 2: apply. */
export async function applyRestore(deps: BackupDeps, opened: OpenedBackup, opts: RestoreApplyOptions): Promise<RestoreSummary> {
  const progress = opts.onProgress ?? (() => undefined);
  const payload = opened.payload;
  const approvals = opts.restoreApprovals === true;
  if (opts.tarPath !== null && !isSafeAbsolutePath(opts.tarPath)) throw new BackupError('bad_path', 'Tar file path is not valid');

  await resetTmp(deps);
  try {
    // 1. tar: copy into app-private tmp FIRST, then hash / list / validate /
    //    extract ONLY that copy (no TOCTOU window on world-writable /sdcard).
    let homeFilesRestored = 0;
    let tarSkippedReason: string | null = null;
    if (payload.tar) {
      if (!opts.tarPath) {
        tarSkippedReason = 'tar_not_selected';
      } else {
        progress('verifying');
        const privateTar = tmpRel('in.tar');
        await run(deps, `/system/bin/cp ${shQuote(opts.tarPath)} ${homeWord(privateTar)}`, 60 * 60_000, 'copy tar');
        const h = await sha256AndSize(deps, homeWord(privateTar));
        if (h.sha256 !== payload.tar.sha256 || h.bytes !== payload.tar.bytes) {
          throw new BackupError('tar_mismatch', 'The .tar file does not match this backup (modified or from a different backup)');
        }
        const names = lines(await run(deps, buildTarListCommand(privateTar, false), 10 * 60_000, 'tar list'));
        const verbose = lines(await run(deps, buildTarListCommand(privateTar, true), 10 * 60_000, 'tar list'));
        const v = validateTarEntries(names, verbose);
        if (v.ok !== true) {
          const bad = v as Extract<typeof v, { ok: false }>;
          throw new BackupError('tar_unsafe', `Unsafe entry in tar: ${bad.reason}`);
        }
        const good = v as Extract<typeof v, { ok: true }>;
        progress('extracting');
        await run(deps, buildTarExtractCommand(privateTar), 60 * 60_000, 'tar extract');
        if (good.files.length > 0) {
          await deps.fs.writeAsStringAsync(tmpUri(deps, 'restored.txt'), good.files.map((f) => `./${f}`).join('\n') + '\n');
          await run(deps, buildChmodFromListCommand(tmpRel('restored.txt')), 10 * 60_000, 'chmod restored files');
        }
        homeFilesRestored = good.files.length;
      }
    }

    progress('restoring');
    // 2. AsyncStorage — allowlist only
    const settingsKeys: string[] = [];
    const skippedSettingsKeys: { key: string; reason: string }[] = [];
    const pairs: [string, string][] = [];
    for (const [k, v] of Object.entries(payload.asyncStorage)) {
      const d = asyncKeyDecision(k);
      if (d === 'restore' || (d === 'approval' && approvals)) {
        pairs.push([k, v]);
        settingsKeys.push(k);
      } else {
        skippedSettingsKeys.push({ key: k, reason: d === 'approval' ? 'approval_not_selected' : d === 'deny' ? 'install_specific' : 'unknown_key' });
      }
    }
    if (pairs.length) await deps.asyncStorage.multiSet(pairs);

    // 3. SecureStore — inventoried keys; approval keys only via step 5
    const apiKeys: string[] = [];
    const skippedSecureKeys: { name: string; reason: string }[] = [];
    for (const [k, v] of Object.entries(payload.secureStore)) {
      if (APPROVAL_SECURE_KEYS.includes(k)) continue;
      if (!isRestorableSecureKey(k)) {
        skippedSecureKeys.push({ name: secureKeyDisplayName(k), reason: 'unknown_key' });
        continue;
      }
      await deps.secureStore.setItemAsync(k, v);
      apiKeys.push(secureKeyDisplayName(k));
    }

    // 4. bundle files (credentials + ~/.shelly state), mode 600 / dirs 700
    const credentialFiles: string[] = [];
    const skippedFiles: SkippedFile[] = [];
    const written: string[] = [];
    let stateFiles = 0;
    for (const [rawRel, b64] of Object.entries(payload.files)) {
      const rel = normalizeHomeRelPath(rawRel);
      if (!rel || rel !== rawRel || classifyHomePath(rel, 0) !== 'secret') {
        skippedFiles.push({ path: rawRel, reason: 'not_a_bundle_path' });
        continue;
      }
      if (APPROVAL_FILES.has(rel)) continue; // step 5
      await writeBundleFile(deps, rel, b64);
      written.push(rel);
      if (secretKind(rel) === 'credential') credentialFiles.push(rel);
      else stateFiles++;
    }

    // 5. approvals group
    let policy: PolicyRestoreOutcome = { state: 'none' };
    const policyText = bundleFileText(payload, USER_POLICY_RELATIVE_PATH);
    if (policyText !== null) {
      const parsed = parseUserPolicyFile(policyText);
      if (parsed.unavailable) {
        policy = { state: 'skipped', reason: 'invalid' };
      } else if (approvals) {
        const r = await writeSealedPolicy(deps, policyText);
        policy = r === 'ok' ? { state: 'with_approvals', ruleCount: parsed.data.rules.length } : { state: 'skipped', reason: r };
      } else {
        // Rules only (ask / deny / draft_only can only tighten); trust allows
        // and counters reset → nothing is re-trusted.
        const rebuilt = serializeUserPolicyFile({ ...emptyUserPolicy(), rules: parsed.data.rules }, Date.now());
        const r = await writeSealedPolicy(deps, rebuilt);
        policy = r === 'ok' ? { state: 'rules_only', ruleCount: parsed.data.rules.length } : { state: 'skipped', reason: r };
      }
      if (policy.state === 'skipped') skippedFiles.push({ path: USER_POLICY_RELATIVE_PATH, reason: `policy_${policy.reason}` });
    }
    const dmB64 = payload.files[DM_PAIRINGS_REL];
    if (typeof dmB64 === 'string') {
      if (approvals) {
        await writeBundleFile(deps, DM_PAIRINGS_REL, dmB64);
        written.push(DM_PAIRINGS_REL);
        stateFiles++;
      } else {
        skippedFiles.push({ path: DM_PAIRINGS_REL, reason: 'approval_not_selected' });
      }
    }
    if (approvals) {
      for (const k of [CLOSEPAW_PREAPPROVAL_KEY, TRUST_ALLOW_SEAL_KEY]) {
        const v = payload.secureStore[k];
        if (typeof v !== 'string') continue;
        // Trust allows only make sense with their policy.json; ClosePaw seals
        // stand alone (bound to agent id + definition hash).
        if (k === TRUST_ALLOW_SEAL_KEY && policy.state !== 'with_approvals') {
          skippedSecureKeys.push({ name: secureKeyDisplayName(k), reason: 'policy_not_restored' });
          continue;
        }
        await deps.secureStore.setItemAsync(k, v);
        apiKeys.push(secureKeyDisplayName(k));
      }
    } else {
      for (const k of [CLOSEPAW_PREAPPROVAL_KEY, TRUST_ALLOW_SEAL_KEY]) {
        if (typeof payload.secureStore[k] === 'string') skippedSecureKeys.push({ name: secureKeyDisplayName(k), reason: 'approval_not_selected' });
      }
    }
    if (policy.state === 'with_approvals' || policy.state === 'rules_only') written.push(USER_POLICY_RELATIVE_PATH);

    if (written.length > 0) {
      await deps.fs.writeAsStringAsync(tmpUri(deps, 'bundle-files.txt'), written.map((f) => `./${f}`).join('\n') + '\n');
      const firstSegs = [...new Set(written.map((r) => r.split('/')[0]).filter((s) => s === '.ssh' || s === '.gnupg' || s === '.aws'))];
      const dirChmod = firstSegs.map((d) => ` && /system/bin/chmod 700 ${homeWord(d)}`).join('');
      await run(deps, `${buildChmodFromListCommand(tmpRel('bundle-files.txt'))}${dirChmod}`, 10 * 60_000, 'chmod');
    }

    return {
      settingsKeys,
      skippedSettingsKeys,
      apiKeys,
      skippedSecureKeys,
      credentialFiles,
      stateFiles,
      skippedFiles,
      homeFilesRestored,
      tarSkippedReason,
      approvalsRestored: approvals,
      approvalsAvailable: opened.preview.approvals.hasAny || policy.state !== 'none',
      policy,
      counts: payload.counts,
      createdAt: payload.createdAt,
    };
  } finally {
    await cleanupTmp(deps);
  }
}

/** Convenience: openBackup + applyRestore (approvals default OFF). */
export async function runRestore(deps: BackupDeps, opts: RestoreOptions): Promise<RestoreSummary> {
  if (opts.tarPath !== null && !isSafeAbsolutePath(opts.tarPath)) throw new BackupError('bad_path', 'Tar file path is not valid');
  const opened = await openBackup(deps, opts);
  return applyRestore(deps, opened, { tarPath: opts.tarPath, restoreApprovals: opts.restoreApprovals, onProgress: opts.onProgress });
}
