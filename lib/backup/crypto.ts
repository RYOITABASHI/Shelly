/**
 * lib/backup/crypto.ts — passphrase-encrypted backup container (.shellybak).
 *
 * Why this exists: the release APK is moving from the public debug signing key
 * to a private release key. Android refuses a signer change in place, so the
 * user must uninstall (wiping all app data) and reinstall. API keys often
 * cannot be re-displayed by their providers, so they are exported here,
 * encrypted with a user passphrase.
 *
 * Binary format (all integers big-endian):
 *
 *   magic   8 bytes   ASCII "SHLYBAK1"
 *   hlen    u32       byte length of the header that follows
 *   header  hlen      UTF-8 JSON: { v:1, kdf:{alg:'scrypt',N,r,p,salt(b64)},
 *                                   cipher:'aes-256-gcm', nonce(b64),
 *                                   createdAt, appVersion? }
 *   body    rest      AES-256-GCM ciphertext || 16-byte tag
 *
 * AAD = magic || hlen || header, so every header byte (KDF params, salt,
 * nonce, metadata) is authenticated by the GCM tag: flipping any byte
 * anywhere in the file makes decryption fail.
 *
 * Decrypt validates version and KDF parameter ranges BEFORE running scrypt so
 * a crafted file cannot make the app burn gigabytes of memory / minutes of CPU
 * (DoS guard).
 *
 * Nothing in this module logs. Callers must never log the passphrase, the
 * plaintext or derived keys either.
 */
import { bytesToBase64, base64ToBytes } from '@/lib/memory/base64';

// ─── Constants ──────────────────────────────────────────────────────────────

export const BACKUP_MAGIC = 'SHLYBAK1';
export const BACKUP_FORMAT_VERSION = 1;
const MAGIC_BYTES = asciiBytes(BACKUP_MAGIC);
const PREFIX_LEN = MAGIC_BYTES.length + 4;
const MAX_HEADER_BYTES = 4096;
const GCM_TAG_BYTES = 16;
export const SALT_BYTES = 16;
export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;

/** Production KDF parameters: scrypt N=2^16, r=8, p=1 (~64 MiB, the OWASP-
 *  recommended floor for scrypt), dkLen 32. Tests may pass a weaker N via the
 *  injectable `kdf` option — the default itself must stay ≥ 2^16. */
export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({ N: 2 ** 16, r: 8, p: 1 });

/** Accepted range on DECRYPT. Anything outside is rejected before scrypt. */
export const KDF_BOUNDS = Object.freeze({
  minN: 2 ** 14,
  maxN: 2 ** 20,
  minR: 1,
  maxR: 32,
  minP: 1,
  maxP: 16,
  /** 128*r*N upper bound (bytes) — 1 GiB. */
  maxMemBytes: 1024 * 1024 * 1024,
});

// ─── Types ──────────────────────────────────────────────────────────────────

export type ScryptParams = { N: number; r: number; p: number };

export type BackupHeader = {
  v: 1;
  kdf: { alg: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  nonce: string;
  createdAt: string;
  appVersion?: string;
};

export type RandomBytesFn = (n: number) => Promise<Uint8Array>;

export type EncryptOptions = {
  kdf?: ScryptParams;
  appVersion?: string;
  createdAt?: string;
  onProgress?: (fraction: number) => void;
  randomBytes?: RandomBytesFn;
};

export type DecryptOptions = {
  onProgress?: (fraction: number) => void;
  /** Test hook: lower the minimum accepted N. Never set in production. */
  minN?: number;
};

/** Malformed / unsupported container (bad magic, version, params, sizes). */
export class BackupFormatError extends Error {
  readonly code = 'BACKUP_FORMAT';
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

/** Wrong passphrase OR tampered/corrupt file — deliberately indistinguishable. */
export class BackupDecryptError extends Error {
  readonly code = 'BACKUP_DECRYPT';
  constructor() {
    super('Wrong passphrase, or the backup file is damaged or was modified.');
    this.name = 'BackupDecryptError';
  }
}

// ─── Lazy primitive loaders (ESM-only @noble modules, device CSPRNG) ─────────

type GcmFactory = (key: Uint8Array, nonce: Uint8Array, aad?: Uint8Array) => {
  encrypt(data: Uint8Array): Uint8Array;
  decrypt(data: Uint8Array): Uint8Array;
};
type ScryptAsyncFn = (
  password: Uint8Array,
  salt: Uint8Array,
  opts: { N: number; r: number; p: number; dkLen: number; maxmem?: number; onProgress?: (p: number) => void },
) => Promise<Uint8Array>;

function loadGcm(): GcmFactory {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@noble/ciphers/aes.js').gcm as GcmFactory;
}
function loadScrypt(): ScryptAsyncFn {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@noble/hashes/scrypt.js').scryptAsync as ScryptAsyncFn;
}
const defaultRandomBytes: RandomBytesFn = async (n) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ExpoCrypto = require('expo-crypto');
  return ExpoCrypto.getRandomBytesAsync(n) as Promise<Uint8Array>;
};

// ─── Small helpers ──────────────────────────────────────────────────────────

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}

export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function isPowerOfTwo(n: number): boolean {
  return Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
}

function wipe(b: Uint8Array | null | undefined): void {
  if (b) b.fill(0);
}

/** Throws BackupFormatError if the KDF params are outside the accepted range. */
export function validateKdfParams(p: { N: unknown; r: unknown; p: unknown }, minN: number = KDF_BOUNDS.minN): ScryptParams {
  const N = p.N;
  const r = p.r;
  const par = p.p;
  if (typeof N !== 'number' || !isPowerOfTwo(N) || N < minN || N > KDF_BOUNDS.maxN) {
    throw new BackupFormatError('Unsupported KDF parameter N');
  }
  if (typeof r !== 'number' || !Number.isInteger(r) || r < KDF_BOUNDS.minR || r > KDF_BOUNDS.maxR) {
    throw new BackupFormatError('Unsupported KDF parameter r');
  }
  if (typeof par !== 'number' || !Number.isInteger(par) || par < KDF_BOUNDS.minP || par > KDF_BOUNDS.maxP) {
    throw new BackupFormatError('Unsupported KDF parameter p');
  }
  if (128 * r * N > KDF_BOUNDS.maxMemBytes) {
    throw new BackupFormatError('KDF memory cost too high');
  }
  return { N, r, p: par };
}

async function deriveKey(passphrase: string, salt: Uint8Array, params: ScryptParams, onProgress?: (f: number) => void): Promise<Uint8Array> {
  const scryptAsync = loadScrypt();
  const pw = utf8Encode(canonicalizePassphrase(passphrase));
  try {
    return await scryptAsync(pw, salt, {
      N: params.N,
      r: params.r,
      p: params.p,
      dkLen: KEY_BYTES,
      // Exact budget for these params plus slack; never the library default.
      maxmem: 128 * params.r * (params.N + params.p + 2) + 1024 * 1024,
      onProgress: onProgress ? (f) => { try { onProgress(f); } catch { /* never abort KDF from UI */ } } : undefined,
    });
  } finally {
    wipe(pw);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function encryptBackup(plaintext: Uint8Array, passphrase: string, opts: EncryptOptions = {}): Promise<Uint8Array> {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new BackupFormatError('Passphrase required');
  }
  const params = opts.kdf ?? DEFAULT_SCRYPT_PARAMS;
  const randomBytes = opts.randomBytes ?? defaultRandomBytes;
  const salt = await randomBytes(SALT_BYTES);
  const nonce = await randomBytes(NONCE_BYTES);
  if (salt.length !== SALT_BYTES || nonce.length !== NONCE_BYTES) {
    throw new BackupFormatError('CSPRNG returned wrong length');
  }
  const header: BackupHeader = {
    v: BACKUP_FORMAT_VERSION,
    kdf: { alg: 'scrypt', N: params.N, r: params.r, p: params.p, salt: bytesToBase64(salt) },
    cipher: 'aes-256-gcm',
    nonce: bytesToBase64(nonce),
    createdAt: opts.createdAt ?? new Date().toISOString(),
    ...(opts.appVersion ? { appVersion: opts.appVersion } : {}),
  };
  const headerBytes = utf8Encode(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER_BYTES) throw new BackupFormatError('Header too large');
  const lenBytes = new Uint8Array(4);
  new DataView(lenBytes.buffer).setUint32(0, headerBytes.length, false);
  const aad = concat(MAGIC_BYTES, lenBytes, headerBytes);

  const key = await deriveKey(passphrase, salt, params, opts.onProgress);
  try {
    const body = loadGcm()(key, nonce, aad).encrypt(plaintext);
    return concat(aad, body);
  } finally {
    wipe(key);
  }
}

/** Parse + validate the header WITHOUT running the KDF. */
export function parseBackupHeader(bytes: Uint8Array, minN?: number): { header: BackupHeader; aad: Uint8Array; body: Uint8Array } {
  if (!(bytes instanceof Uint8Array) || bytes.length < PREFIX_LEN + 2 + GCM_TAG_BYTES) {
    throw new BackupFormatError('File too short to be a Shelly backup');
  }
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) throw new BackupFormatError('Not a Shelly backup file');
  }
  const hlen = new DataView(bytes.buffer, bytes.byteOffset + MAGIC_BYTES.length, 4).getUint32(0, false);
  if (hlen < 2 || hlen > MAX_HEADER_BYTES || PREFIX_LEN + hlen + GCM_TAG_BYTES > bytes.length) {
    throw new BackupFormatError('Invalid header length');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(bytes.subarray(PREFIX_LEN, PREFIX_LEN + hlen)));
  } catch {
    throw new BackupFormatError('Header is not valid JSON');
  }
  const h = raw as Partial<BackupHeader> | null;
  if (!h || typeof h !== 'object') throw new BackupFormatError('Header is not an object');
  if (h.v !== BACKUP_FORMAT_VERSION) throw new BackupFormatError('Unsupported backup version');
  if (h.cipher !== 'aes-256-gcm') throw new BackupFormatError('Unsupported cipher');
  if (!h.kdf || typeof h.kdf !== 'object' || h.kdf.alg !== 'scrypt') throw new BackupFormatError('Unsupported KDF');
  validateKdfParams(h.kdf, minN);
  if (typeof h.kdf.salt !== 'string' || typeof h.nonce !== 'string') throw new BackupFormatError('Missing salt/nonce');
  let salt: Uint8Array;
  let nonce: Uint8Array;
  try {
    salt = base64ToBytes(h.kdf.salt);
    nonce = base64ToBytes(h.nonce);
  } catch {
    throw new BackupFormatError('Bad salt/nonce encoding');
  }
  if (salt.length !== SALT_BYTES || nonce.length !== NONCE_BYTES) throw new BackupFormatError('Bad salt/nonce length');
  return {
    header: h as BackupHeader,
    aad: bytes.subarray(0, PREFIX_LEN + hlen),
    body: bytes.subarray(PREFIX_LEN + hlen),
  };
}

export async function decryptBackup(
  bytes: Uint8Array,
  passphrase: string,
  opts: DecryptOptions = {},
): Promise<{ plaintext: Uint8Array; header: BackupHeader }> {
  const { header, aad, body } = parseBackupHeader(bytes, opts.minN);
  const salt = base64ToBytes(header.kdf.salt);
  const nonce = base64ToBytes(header.nonce);
  const key = await deriveKey(passphrase, salt, header.kdf, opts.onProgress);
  try {
    let plaintext: Uint8Array;
    try {
      plaintext = loadGcm()(key, nonce, aad).decrypt(body);
    } catch {
      throw new BackupDecryptError();
    }
    return { plaintext, header };
  } finally {
    wipe(key);
  }
}

// ─── Passphrases ────────────────────────────────────────────────────────────

/** Unambiguous base32 alphabet: digits 2-9 + A-Z without I and O (32 chars). */
export const PASSPHRASE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PASSPHRASE_GROUPS = 6;
export const PASSPHRASE_GROUP_LEN = 5;
/** 6 × 5 × log2(32) = 150 bits. */
export const GENERATED_PASSPHRASE_BITS = PASSPHRASE_GROUPS * PASSPHRASE_GROUP_LEN * 5;

export async function generatePassphrase(randomBytes: RandomBytesFn = defaultRandomBytes): Promise<string> {
  // A uniformly random 150-bit string trips the heuristic checks below
  // (6-char sequential run, a common word) with negligible probability;
  // regenerate if it ever does so the generated value always passes.
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = await generateOnce(randomBytes);
    if (assessPassphrase(candidate).ok) return candidate;
  }
  throw new Error('passphrase generation failed');
}

async function generateOnce(randomBytes: RandomBytesFn): Promise<string> {
  const n = PASSPHRASE_GROUPS * PASSPHRASE_GROUP_LEN;
  const bytes = await randomBytes(n);
  if (bytes.length !== n) throw new Error('CSPRNG returned wrong length');
  const chars: string[] = [];
  // 256 is a multiple of 32, so `& 31` is unbiased.
  for (let i = 0; i < n; i++) chars.push(PASSPHRASE_ALPHABET[bytes[i] & 31]);
  bytes.fill(0);
  const groups: string[] = [];
  for (let g = 0; g < PASSPHRASE_GROUPS; g++) {
    groups.push(chars.slice(g * PASSPHRASE_GROUP_LEN, (g + 1) * PASSPHRASE_GROUP_LEN).join(''));
  }
  return groups.join('-');
}

/**
 * KDF input normalisation, applied identically on encrypt and decrypt:
 * Unicode NFKC, and a passphrase that has the generated shape (30 base32
 * chars in groups of 5, any case, separated by dashes/spaces or not) is
 * folded to the canonical `XXXXX-XXXXX-…` form so a user re-typing it in
 * lower case or without dashes still unlocks the backup.
 */
export function canonicalizePassphrase(p: string): string {
  const n = p.normalize('NFKC');
  const compact = n.replace(/[\s-]/g, '').toUpperCase();
  const alnumOnly = /^[A-Za-z0-9\s-]+$/.test(n);
  if (alnumOnly && compact.length === PASSPHRASE_GROUPS * PASSPHRASE_GROUP_LEN && [...compact].every((c) => PASSPHRASE_ALPHABET.includes(c))) {
    const groups: string[] = [];
    for (let i = 0; i < compact.length; i += PASSPHRASE_GROUP_LEN) groups.push(compact.slice(i, i + PASSPHRASE_GROUP_LEN));
    return groups.join('-');
  }
  return n;
}

export const MIN_PASSPHRASE_LENGTH = 14;
export const MIN_PASSPHRASE_BITS = 70;

export type PassphraseReason =
  | 'too_short'
  | 'all_same'
  | 'sequential'
  | 'repeated_pattern'
  | 'common_pattern'
  | 'low_entropy';

const COMMON_FRAGMENTS = [
  'password', 'passwort', 'passphrase', 'qwerty', 'asdfgh', 'zxcvbn', 'letmein', 'welcome',
  'iloveyou', 'admin', 'shelly', 'monkey', 'dragon', 'abc123', '123456', '654321', '111111',
  '000000', 'qazwsx', 'trustno1', 'secret',
];

function isSequentialRun(s: string, minRun: number): boolean {
  let run = 1;
  let dir = 0;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if ((d === 1 || d === -1) && (dir === 0 || d === dir)) {
      dir = d;
      run++;
      if (run >= minRun) return true;
    } else {
      run = 1;
      dir = 0;
      if (d === 1 || d === -1) {
        dir = d;
        run = 2;
      }
    }
  }
  return false;
}

function poolSize(s: string): number {
  let pool = 0;
  if (/[a-z]/.test(s)) pool += 26;
  if (/[A-Z]/.test(s)) pool += 26;
  if (/[0-9]/.test(s)) pool += 10;
  if (/[^A-Za-z0-9\u0080-￿]/.test(s)) pool += 33;
  if (/[\u0080-￿]/.test(s)) pool += 100;
  return pool;
}

/** Conservative entropy estimate: pool bits × an effective length that
 *  discounts repeated characters (each distinct char counts at most ~2×). */
export function estimatePassphraseBits(p: string): number {
  const chars = Array.from(p);
  if (chars.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
  let effLen = 0;
  for (const n of counts.values()) effLen += Math.min(n, 2);
  return effLen * Math.log2(Math.max(poolSize(p), 2));
}

export function assessPassphrase(p: string): { ok: boolean; reason?: PassphraseReason; bits: number } {
  const bits = estimatePassphraseBits(p ?? '');
  const chars = Array.from(p ?? '');
  if (chars.length < MIN_PASSPHRASE_LENGTH) return { ok: false, reason: 'too_short', bits };
  if (new Set(chars).size === 1) return { ok: false, reason: 'all_same', bits };
  const lower = p.toLowerCase();
  const compact = lower.replace(/[\s\-_.]/g, '');
  // whole string is k repetitions of a shorter unit ("abcabcabc…")
  for (let unit = 1; unit <= compact.length / 2; unit++) {
    if (compact.length % unit === 0 && compact.slice(0, unit).repeat(compact.length / unit) === compact) {
      return { ok: false, reason: 'repeated_pattern', bits };
    }
  }
  if (isSequentialRun(compact, 6)) return { ok: false, reason: 'sequential', bits };
  if (COMMON_FRAGMENTS.some((f) => compact.includes(f))) return { ok: false, reason: 'common_pattern', bits };
  if (bits < MIN_PASSPHRASE_BITS) return { ok: false, reason: 'low_entropy', bits };
  return { ok: true, bits };
}
