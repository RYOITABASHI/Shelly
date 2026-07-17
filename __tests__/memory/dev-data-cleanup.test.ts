import * as fs from 'fs';
import * as path from 'path';

import {
  cleanupStalePlaintextMemoryFiles,
  isPreEncryptionRecordFile,
} from '@/lib/memory/dev-data-cleanup';
import { MEMORY_SCHEMA_VERSION, MemoryRecord } from '@/lib/memory';
import { makeNodeFsPort, makeTmpDir } from '../support/node-fs-port';

function plaintextRecord(key: string): MemoryRecord {
  return {
    namespace: 'ns',
    key,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'fact',
    text: 'pre-encryption note',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('isPreEncryptionRecordFile', () => {
  it('recognizes a pre-Track-A plaintext MemoryRecord JSON blob', () => {
    expect(isPreEncryptionRecordFile(JSON.stringify(plaintextRecord('k')))).toBe(true);
  });

  it('does not recognize a Track-A EncryptedEnvelope as plaintext', () => {
    const envelope = { v: 1, iv: 'aaaa', ciphertext: 'bbbb' };
    expect(isPreEncryptionRecordFile(JSON.stringify(envelope))).toBe(false);
  });

  it('does not recognize an envelope that also happens to carry a keyId', () => {
    const envelope = { v: 1, keyId: 'shelly_memory_v2_dek', iv: 'aaaa', ciphertext: 'bbbb' };
    expect(isPreEncryptionRecordFile(JSON.stringify(envelope))).toBe(false);
  });

  it('does not recognize corrupt JSON', () => {
    expect(isPreEncryptionRecordFile('{ not json')).toBe(false);
  });

  it('does not recognize an unrelated well-formed JSON object', () => {
    expect(isPreEncryptionRecordFile(JSON.stringify({ hello: 'world' }))).toBe(false);
  });
});

describe('cleanupStalePlaintextMemoryFiles', () => {
  let root: string;
  beforeEach(() => {
    root = path.join(makeTmpDir(), 'memory-v2');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('deletes a stale pre-encryption plaintext file and leaves a well-formed envelope untouched', async () => {
    const nsDir = path.join(root, 'ns');
    fs.mkdirSync(nsDir, { recursive: true });
    const staleFile = path.join(nsDir, 'stale.json');
    const envelopeFile = path.join(nsDir, 'current.json');
    fs.writeFileSync(staleFile, JSON.stringify(plaintextRecord('stale')));
    fs.writeFileSync(
      envelopeFile,
      JSON.stringify({ v: 1, iv: 'iviviviviviviviviviviviviviviv', ciphertext: 'deadbeef' })
    );

    const result = await cleanupStalePlaintextMemoryFiles(makeNodeFsPort(), root);

    // cleanupStalePlaintextMemoryFiles joins paths with '/' (mirroring
    // storage-json.ts's own joinPath), while path.join uses the OS-native
    // separator ('\' on Windows) — both resolve to the same file on disk, so
    // normalize before comparing the returned path string.
    expect(result.removed.map((p) => p.replace(/\\/g, '/'))).toEqual([staleFile.replace(/\\/g, '/')]);
    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(envelopeFile)).toBe(true);
  });

  it('leaves corrupt/unrecognized files alone instead of deleting them', async () => {
    const nsDir = path.join(root, 'ns');
    fs.mkdirSync(nsDir, { recursive: true });
    const garbageFile = path.join(nsDir, 'garbage.json');
    fs.writeFileSync(garbageFile, '{ not json');

    const result = await cleanupStalePlaintextMemoryFiles(makeNodeFsPort(), root);

    expect(result.removed).toEqual([]);
    expect(fs.existsSync(garbageFile)).toBe(true);
  });

  it('is a no-op (never throws) when the root does not exist yet', async () => {
    const missingRoot = path.join(root, 'does-not-exist');
    const result = await cleanupStalePlaintextMemoryFiles(makeNodeFsPort(), missingRoot);
    expect(result).toEqual({ scanned: 0, removed: [] });
  });

  it('scans multiple namespaces independently', async () => {
    const nsA = path.join(root, 'A');
    const nsB = path.join(root, 'B');
    fs.mkdirSync(nsA, { recursive: true });
    fs.mkdirSync(nsB, { recursive: true });
    fs.writeFileSync(path.join(nsA, 'stale.json'), JSON.stringify(plaintextRecord('stale-a')));
    fs.writeFileSync(path.join(nsB, 'stale.json'), JSON.stringify(plaintextRecord('stale-b')));

    const result = await cleanupStalePlaintextMemoryFiles(makeNodeFsPort(), root);

    expect(result.removed.map((p) => p.replace(/\\/g, '/')).sort()).toEqual(
      [path.join(nsA, 'stale.json'), path.join(nsB, 'stale.json')].map((p) => p.replace(/\\/g, '/')).sort()
    );
  });
});
