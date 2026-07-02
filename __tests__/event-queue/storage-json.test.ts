import * as fs from 'fs';
import * as path from 'path';

import { JsonFileQueueStorage } from '@/lib/event-queue/storage-json';
import {
  EVENT_QUEUE_SCHEMA_VERSION,
  QueueRecord,
} from '@/lib/event-queue/types';
import { makeNodeFsPort, makeTmpDir } from '../support/node-fs-port';

function record(id: string): QueueRecord {
  return {
    id,
    schemaVersion: EVENT_QUEUE_SCHEMA_VERSION,
    topic: 't',
    source: 'manual',
    payload: { id },
    state: 'ready',
    visibleAt: 0,
    enqueuedAt: 0,
    attempts: 0,
    maxAttempts: 5,
  };
}

describe('JsonFileQueueStorage', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(makeTmpDir(), 'event-queue');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it('round-trips put/loadAll/delete over the node FsPort', async () => {
    const store = new JsonFileQueueStorage(makeNodeFsPort(), dir);
    await store.put(record('a'));
    await store.put(record('b'));
    expect((await store.loadAll()).map((r) => r.id).sort()).toEqual(['a', 'b']);
    await store.delete('a');
    expect((await store.loadAll()).map((r) => r.id)).toEqual(['b']);
  });

  it('returns [] for a missing directory rather than throwing', async () => {
    const store = new JsonFileQueueStorage(makeNodeFsPort(), path.join(dir, 'nope'));
    expect(await store.loadAll()).toEqual([]);
  });

  it('skips a single corrupt file instead of failing the whole load', async () => {
    const store = new JsonFileQueueStorage(makeNodeFsPort(), dir);
    await store.put(record('good'));
    fs.writeFileSync(path.join(dir, 'garbage.json'), '{ not json');
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.id)).toEqual(['good']);
  });

  it('writes atomically (no leftover tmp files after put)', async () => {
    const store = new JsonFileQueueStorage(makeNodeFsPort(), dir);
    await store.put(record('a'));
    const names = fs.readdirSync(dir);
    expect(names).toEqual(['a.json']);
  });

  it('maps distinct ids with special chars to distinct files (no collision)', async () => {
    const store = new JsonFileQueueStorage(makeNodeFsPort(), dir);
    // Under a non-injective sanitizer these three would all clobber "a_b.json".
    const ids = ['a/b', 'a b', 'a+b', 'a%b'];
    for (const id of ids) await store.put(record(id));
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.id).sort()).toEqual([...ids].sort());
    // deleting one leaves the others intact
    await store.delete('a/b');
    expect((await store.loadAll()).map((r) => r.id).sort()).toEqual(
      ['a b', 'a+b', 'a%b'].sort(),
    );
  });

  it('drops a parseable but malformed record (bad state) instead of admitting it', async () => {
    const store = new JsonFileQueueStorage(makeNodeFsPort(), dir);
    await store.put(record('good'));
    // valid JSON, valid id, but no/garbage state — would stall + NaN-poison stats.
    fs.writeFileSync(
      path.join(dir, 'bad.json'),
      JSON.stringify({ id: 'bad', topic: 't', attempts: 0 }),
    );
    const loaded = await store.loadAll();
    expect(loaded.map((r) => r.id)).toEqual(['good']);
  });
});
