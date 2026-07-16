import * as fs from 'fs';
import * as path from 'path';

import { JsonFileMemoryStorage, assertWithinRoot } from '@/lib/memory/storage-json';
import { MemoryStore } from '@/lib/memory/memory-store';
import { MEMORY_SCHEMA_VERSION, MemoryRecord } from '@/lib/memory';
import { FakeClock } from '../support/event-queue-harness';
import { makeNodeFsPort, makeTmpDir } from '../support/node-fs-port';
import { makeNodeEncryptionPort } from '../support/node-encryption-port';

function record(namespace: string, key: string, text = key): MemoryRecord {
  return {
    namespace,
    key,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    kind: 'fact',
    text,
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('JsonFileMemoryStorage', () => {
  let root: string;
  beforeEach(() => {
    root = path.join(makeTmpDir(), 'memory');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });

  it('round-trips put/get/query/delete via a MemoryStore over node fs', async () => {
    const adapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(), { root });
    const store = new MemoryStore({ adapter, clock: new FakeClock(1000) });
    const rec = await store.put({ namespace: 'ns', text: 'durable note', tags: ['keep'] });
    expect((await store.get('ns', rec.key))?.text).toBe('durable note');
    expect(await store.query('ns', { text: 'durable' })).toHaveLength(1);
    await store.delete('ns', rec.key);
    expect(await store.get('ns', rec.key)).toBeNull();
  });

  it('skips a corrupt .json on load instead of failing the namespace', async () => {
    const adapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(), { root });
    await adapter.put(record('ns', 'good'));
    const nsDir = path.join(root, encodeURIComponent('ns'));
    fs.writeFileSync(path.join(nsDir, 'garbage.json'), '{ not json');
    fs.writeFileSync(path.join(nsDir, 'wrongshape.json'), JSON.stringify({ id: 'x' }));
    const loaded = await adapter.list('ns');
    expect(loaded.map((r) => r.key)).toEqual(['good']);
  });

  it('maps distinct keys/namespaces with special chars to distinct files', async () => {
    const adapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(), { root });
    const keys = ['a/b', 'a b', 'a+b'];
    for (const k of keys) await adapter.put(record('ns', k));
    expect((await adapter.list('ns')).map((r) => r.key).sort()).toEqual([...keys].sort());
    await adapter.delete('ns', 'a/b');
    expect((await adapter.list('ns')).map((r) => r.key).sort()).toEqual(['a b', 'a+b'].sort());
  });

  it('never writes above the root even for an escaping namespace/key', async () => {
    const adapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(), { root });
    // encodeURIComponent neutralizes '/', so an escaping ns/key is just a weird
    // in-root segment (a miss), never a write above root.
    expect(await adapter.get('../../etc', 'passwd')).toBeNull();
    await adapter.put(record('../../etc', 'passwd', 'nope'));
    expect(fs.existsSync(path.join(path.dirname(root), 'passwd'))).toBe(false);
    expect(fs.existsSync('/etc/passwd.shelly-test-should-not-exist')).toBe(false);
  });

  it('throws when a bare ".." namespace escapes the root via the public API', async () => {
    // encodeURIComponent('..') === '..' (dots unreserved), so <root>/.. escapes
    // and only assertWithinRoot's canonicalization catches it — proves the JAIL,
    // not the encoder, through the normal adapter API.
    const adapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(), { root });
    await expect(adapter.put(record('..', 'k'))).rejects.toThrow(/scoped\.fs denied/);
    await expect(adapter.list('..')).rejects.toThrow(/scoped\.fs denied/);
    await expect(adapter.get('..', 'k')).rejects.toThrow(/scoped\.fs denied/);
    await expect(adapter.delete('..', 'k')).rejects.toThrow(/scoped\.fs denied/);
  });

  it('isolates namespaces on disk', async () => {
    const adapter = new JsonFileMemoryStorage(makeNodeFsPort(), makeNodeEncryptionPort(), { root });
    await adapter.put(record('A', 'k', 'in A'));
    await adapter.put(record('B', 'k', 'in B'));
    expect((await adapter.list('A')).map((r) => r.text)).toEqual(['in A']);
    expect((await adapter.list('B')).map((r) => r.text)).toEqual(['in B']);
  });
});

describe('assertWithinRoot (scoped.fs root-jail, defense in depth)', () => {
  const root = '/data/memory-root';
  it('allows a path inside the root', () => {
    expect(() => assertWithinRoot(root, 'read', `${root}/ns/key.json`)).not.toThrow();
  });
  it('denies an absolute path outside the root', () => {
    expect(() => assertWithinRoot(root, 'read', '/etc/passwd')).toThrow(/scoped\.fs denied/);
  });
  it('denies a traversal that escapes the root', () => {
    expect(() => assertWithinRoot(root, 'write', `${root}/../secrets/x.json`)).toThrow(
      /scoped\.fs denied/,
    );
  });
});
