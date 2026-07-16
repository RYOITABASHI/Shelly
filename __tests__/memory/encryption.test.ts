// Track A (envelope encryption) tests for JsonFileMemoryStorage — see
// DEFERRED.md MEMORY-001's 2026-07-16 plan. Uses the real node:crypto-backed
// fake EncryptionPort (__tests__/support/node-encryption-port.ts), never the
// device-only @noble/ciphers/expo-crypto/expo-secure-store implementation
// (lib/memory/crypto-expo.ts + encryption-key.ts), mirroring how
// storage-json.test.ts exercises FsPort via node-fs-port.ts instead of
// fs-expo.ts.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { JsonFileMemoryStorage } from '@/lib/memory/storage-json';
import { MEMORY_SCHEMA_VERSION, MemoryRecord } from '@/lib/memory';
import { makeNodeFsPort, makeTmpDir } from '../support/node-fs-port';
import { makeNodeEncryptionPort } from '../support/node-encryption-port';

const PLAINTEXT_MARKER = 'SECRET_PLAINTEXT_MARKER_do-not-leak-to-disk';

function record(namespace: string, key: string, text = key): MemoryRecord {
  return {
    namespace,
    key,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'fact',
    text,
    tags: ['tag-a'],
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('JsonFileMemoryStorage — Track A envelope encryption', () => {
  let root: string;
  beforeEach(() => {
    root = path.join(makeTmpDir(), 'memory');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('round-trips a record through envelope encryption (write then read returns the original data)', async () => {
    const adapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(), { root });
    const rec = record('ns', 'k1', PLAINTEXT_MARKER);
    await adapter.put(rec);
    const loaded = await adapter.get('ns', 'k1');
    expect(loaded).toEqual(rec);
    // list()/query() go through the same readRecord() path — round trip there too.
    expect((await adapter.list('ns')).map((r) => r.text)).toEqual([PLAINTEXT_MARKER]);
  });

  it('never writes the plaintext MemoryRecord JSON to the underlying FsPort', async () => {
    const adapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(), { root });
    await adapter.put(record('ns', 'k1', PLAINTEXT_MARKER));

    const nsDir = path.join(root, encodeURIComponent('ns'));
    const files = fs.readdirSync(nsDir).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const raw = fs.readFileSync(path.join(nsDir, files[0]), 'utf8');

    // The on-disk bytes must not contain the plaintext substring, the record's
    // namespace/key/tags, or even the JSON key names of MemoryRecord — only
    // the envelope's own field names should be visible.
    expect(raw).not.toContain(PLAINTEXT_MARKER);
    expect(raw).not.toContain('tag-a');
    expect(raw).not.toContain('"text"');
    expect(raw).not.toContain('"namespace"');

    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(
      expect.objectContaining({
        v: expect.any(Number),
        iv: expect.any(String),
        ciphertext: expect.any(String),
      })
    );
  });

  it('treats a file with a non-envelope shape as absent instead of crashing the namespace', async () => {
    const adapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(), { root });
    await adapter.put(record('ns', 'good', 'kept'));

    const nsDir = path.join(root, encodeURIComponent('ns'));
    // Valid JSON, but not an envelope shape (no v/iv/ciphertext) — must be
    // tolerated as a corrupt/foreign file, not passed to decrypt().
    fs.writeFileSync(path.join(nsDir, `${encodeURIComponent('not-an-envelope')}.json`), JSON.stringify({ foo: 'bar' }));
    // Not even JSON.
    fs.writeFileSync(path.join(nsDir, `${encodeURIComponent('not-json-at-all')}.json`), '{ not json');

    await expect(adapter.get('ns', 'not-an-envelope')).resolves.toBeNull();
    await expect(adapter.get('ns', 'not-json-at-all')).resolves.toBeNull();
    const loaded = await adapter.list('ns');
    expect(loaded.map((r) => r.key)).toEqual(['good']);
  });

  it('treats an envelope that fails to decrypt with the wrong key as absent instead of throwing', async () => {
    const writerKey = crypto.randomBytes(32);
    const readerKey = crypto.randomBytes(32); // deliberately different
    const writerAdapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(writerKey), { root });
    const readerAdapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(readerKey), { root });

    await writerAdapter.put(record('ns', 'k1', 'written with the writer key'));

    await expect(readerAdapter.get('ns', 'k1')).resolves.toBeNull();
    await expect(readerAdapter.list('ns')).resolves.toEqual([]);
    // The record IS still readable with the correct key, proving the miss
    // above is specifically a wrong-key/auth-tag failure, not data loss.
    await expect(writerAdapter.get('ns', 'k1')).resolves.not.toBeNull();
  });

  it('treats a tampered ciphertext (auth-tag mismatch) as absent instead of throwing', async () => {
    const adapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(), { root });
    await adapter.put(record('ns', 'k1', 'will be tampered with'));

    const file = path.join(root, encodeURIComponent('ns'), `${encodeURIComponent('k1')}.json`);
    const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Flip a character in the ciphertext to break GCM's auth tag.
    const ciphertextChars = envelope.ciphertext.split('');
    const flipIndex = ciphertextChars.findIndex((c: string) => /[A-Za-z0-9]/.test(c));
    ciphertextChars[flipIndex] = ciphertextChars[flipIndex] === 'A' ? 'B' : 'A';
    envelope.ciphertext = ciphertextChars.join('');
    fs.writeFileSync(file, JSON.stringify(envelope));

    await expect(adapter.get('ns', 'k1')).resolves.toBeNull();
  });
});
