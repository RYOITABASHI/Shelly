jest.mock('@noble/ciphers/aes.js', () => require('./support/backup-noble-node').nobleAes);
jest.mock('@noble/hashes/scrypt.js', () => require('./support/backup-noble-node').nobleScrypt);

import {
  BackupDecryptError,
  BackupFormatError,
  DEFAULT_SCRYPT_PARAMS,
  GENERATED_PASSPHRASE_BITS,
  PASSPHRASE_ALPHABET,
  assessPassphrase,
  canonicalizePassphrase,
  decryptBackup,
  encryptBackup,
  generatePassphrase,
  parseBackupHeader,
  utf8Decode,
  utf8Encode,
} from '@/lib/backup/crypto';
import { nodeRandomBytes, scryptCalls } from './support/backup-noble-node';

const KDF = { N: 16, r: 1, p: 1 };
const MIN_N = 16;
const PASS = 'correct horse battery staple 42!';
const SECRET = 'sk-live-SUPER-SECRET-0123456789abcdef';

async function enc(plain = `{"k":"${SECRET}"}`, pass = PASS) {
  return encryptBackup(utf8Encode(plain), pass, { kdf: KDF, randomBytes: nodeRandomBytes, appVersion: '9.9.9' });
}

/** Rebuild a container with an edited header (keeps body; AAD will mismatch
 *  unless the header is unchanged — used for version / KDF range tests that
 *  must fail BEFORE scrypt). */
function withHeader(bytes: Uint8Array, edit: (h: Record<string, any>) => void): Uint8Array {
  const hlen = Buffer.from(bytes).readUInt32BE(8);
  const header = JSON.parse(Buffer.from(bytes.subarray(12, 12 + hlen)).toString('utf8'));
  edit(header);
  const hb = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(hb.length, 0);
  return new Uint8Array(Buffer.concat([Buffer.from(bytes.subarray(0, 8)), len, hb, Buffer.from(bytes.subarray(12 + hlen))]));
}

describe('backup crypto container', () => {
  it('round-trips and carries an authenticated header', async () => {
    const out = await enc();
    expect(Buffer.from(out.subarray(0, 8)).toString('ascii')).toBe('SHLYBAK1');
    const { plaintext, header } = await decryptBackup(out, PASS, { minN: MIN_N });
    expect(utf8Decode(plaintext)).toBe(`{"k":"${SECRET}"}`);
    expect(header).toMatchObject({ v: 1, cipher: 'aes-256-gcm', appVersion: '9.9.9', kdf: { alg: 'scrypt', N: 16, r: 1, p: 1 } });
  });

  it('production KDF default is at least scrypt N=2^16, r=8, p=1', () => {
    expect(DEFAULT_SCRYPT_PARAMS.N).toBeGreaterThanOrEqual(2 ** 16);
    expect(DEFAULT_SCRYPT_PARAMS.r).toBe(8);
    expect(DEFAULT_SCRYPT_PARAMS.p).toBe(1);
  });

  it('default decrypt bounds reject the weak test KDF (minN guard is opt-in)', async () => {
    const out = await enc();
    await expect(decryptBackup(out, PASS)).rejects.toBeInstanceOf(BackupFormatError);
  });

  it('wrong passphrase fails with BackupDecryptError', async () => {
    const out = await enc();
    await expect(decryptBackup(out, 'correct horse battery staple 43!', { minN: MIN_N })).rejects.toBeInstanceOf(BackupDecryptError);
  });

  it('any single-byte tamper anywhere (magic, length, header, nonce, ciphertext, tag) fails', async () => {
    const out = await enc('x'.repeat(40));
    for (let i = 0; i < out.length; i++) {
      const t = new Uint8Array(out);
      t[i] ^= 0x01;
      await expect(decryptBackup(t, PASS, { minN: MIN_N })).rejects.toThrow();
    }
  });

  it('tampering the nonce value inside the header fails', async () => {
    const out = await enc();
    const t = withHeader(out, (h) => {
      const n = Buffer.from(h.nonce, 'base64');
      n[0] ^= 0xff;
      h.nonce = n.toString('base64');
    });
    await expect(decryptBackup(t, PASS, { minN: MIN_N })).rejects.toBeInstanceOf(BackupDecryptError);
  });

  it('truncated tag fails', async () => {
    const out = await enc();
    await expect(decryptBackup(out.subarray(0, out.length - 1), PASS, { minN: MIN_N })).rejects.toThrow();
  });

  it.each([
    ['unsupported version', (h: any) => { h.v = 2; }],
    ['unsupported cipher', (h: any) => { h.cipher = 'aes-128-gcm'; }],
    ['unsupported kdf', (h: any) => { h.kdf.alg = 'pbkdf2'; }],
    ['N not a power of two', (h: any) => { h.kdf.N = 65535; }],
    ['N too large', (h: any) => { h.kdf.N = 2 ** 21; }],
    ['N too small for production bounds', (h: any) => { h.kdf.N = 2 ** 10; }],
    ['r too large', (h: any) => { h.kdf.r = 64; }],
    ['r zero', (h: any) => { h.kdf.r = 0; }],
    ['p too large', (h: any) => { h.kdf.p = 1000; }],
    ['memory too large', (h: any) => { h.kdf.N = 2 ** 20; h.kdf.r = 16; }],
    ['bad salt length', (h: any) => { h.kdf.salt = Buffer.alloc(8).toString('base64'); }],
  ])('rejects %s before running scrypt', async (_name, edit) => {
    const out = await enc();
    const t = withHeader(out, edit);
    scryptCalls.length = 0;
    // default bounds (minN 2^14) for these
    await expect(decryptBackup(t, PASS)).rejects.toBeInstanceOf(BackupFormatError);
    expect(scryptCalls).toHaveLength(0);
  });

  it('rejects non-backup bytes and oversized header length before scrypt', async () => {
    scryptCalls.length = 0;
    await expect(decryptBackup(new Uint8Array(100), PASS)).rejects.toBeInstanceOf(BackupFormatError);
    const out = await enc();
    const t = new Uint8Array(out);
    Buffer.from(t.buffer, t.byteOffset).writeUInt32BE(0xffffffff, 8);
    scryptCalls.length = 0;
    await expect(decryptBackup(t, PASS)).rejects.toBeInstanceOf(BackupFormatError);
    expect(scryptCalls).toHaveLength(0);
    expect(() => parseBackupHeader(new Uint8Array(4))).toThrow(BackupFormatError);
  });

  it('output never contains the plaintext secret (utf8 or base64)', async () => {
    const out = await enc();
    const asLatin = Buffer.from(out).toString('latin1');
    const asB64 = Buffer.from(out).toString('base64');
    expect(asLatin).not.toContain(SECRET);
    expect(asB64).not.toContain(Buffer.from(SECRET).toString('base64').slice(0, 20));
    expect(asLatin).not.toContain(PASS);
  });

  it('uses a fresh salt and nonce every time', async () => {
    const a = parseBackupHeader(await enc(), MIN_N).header;
    const b = parseBackupHeader(await enc(), MIN_N).header;
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.nonce).not.toBe(b.nonce);
  });
});

describe('passphrases', () => {
  it('generated passphrases are 6x5 unambiguous base32, ≥120 bits, and pass the strength rules', async () => {
    expect(GENERATED_PASSPHRASE_BITS).toBeGreaterThanOrEqual(120);
    for (let i = 0; i < 50; i++) {
      const p = await generatePassphrase(nodeRandomBytes);
      expect(p).toMatch(/^[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){5}$/);
      for (const c of p.replace(/-/g, '')) expect(PASSPHRASE_ALPHABET).toContain(c);
      expect(assessPassphrase(p).ok).toBe(true);
    }
    expect(new Set(PASSPHRASE_ALPHABET).size).toBe(32);
    expect(PASSPHRASE_ALPHABET).not.toMatch(/[01IO]/);
  });

  it('a generated passphrase still decrypts when re-typed lower case / without dashes', async () => {
    const p = await generatePassphrase(nodeRandomBytes);
    const out = await encryptBackup(utf8Encode('hello'), p, { kdf: KDF, randomBytes: nodeRandomBytes });
    const sloppy = p.toLowerCase().replace(/-/g, ' ');
    const { plaintext } = await decryptBackup(out, sloppy, { minN: MIN_N });
    expect(utf8Decode(plaintext)).toBe('hello');
    expect(canonicalizePassphrase('Hello World')).toBe('Hello World');
  });

  it.each([
    ['short1!', 'too_short'],
    ['aaaaaaaaaaaaaaaaaaaa', 'all_same'],
    ['abcdefghijklmnopqr', 'sequential'],
    ['98765432109876x', 'sequential'],
    ['abcabcabcabcabcabc', 'repeated_pattern'],
    ['xy-Password-2024-zz', 'common_pattern'],
    ['qwertyuiop-zz-77', 'common_pattern'],
    ['aabbaabbccddeeff', 'low_entropy'],
  ])('rejects %s (%s)', (p, reason) => {
    const r = assessPassphrase(p);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(reason);
  });

  it.each(['correct horse battery staple', 'Tr0mb0ne-Kettle-Navy-91', 'ぶどう 自転車 黄色い 図書館'])('accepts %s', (p) => {
    expect(assessPassphrase(p).ok).toBe(true);
  });
});
