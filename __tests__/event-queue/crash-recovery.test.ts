import * as fs from 'fs';
import * as path from 'path';

import { EventQueue } from '@/lib/event-queue/event-queue';
import { JsonFileQueueStorage } from '@/lib/event-queue/storage-json';
import { FakeClock, SeqIdGen } from '../support/event-queue-harness';
import { makeNodeFsPort, makeTmpDir } from '../support/node-fs-port';

describe('EventQueue crash recovery (JSON durable backend)', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(makeTmpDir(), 'event-queue');
  });
  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it('redelivers a leased record from disk after a simulated crash', async () => {
    const clock = new FakeClock(1000);
    const fsPort = makeNodeFsPort();

    // Instance A: enqueue + lease, then "crash" (discard A without ack).
    const a = new EventQueue({
      adapter: new JsonFileQueueStorage(fsPort, dir),
      clock,
      idGen: new SeqIdGen('a'),
      defaults: { leaseMs: 5000 },
    });
    await a.load();
    await a.enqueue({ topic: 't', source: 'schedule', payload: { v: 7 } });
    const leased = await a.lease();
    expect(leased).toHaveLength(1);

    // Instance B over the SAME directory, after the lease would have expired.
    clock.advance(5001);
    const b = new EventQueue({
      adapter: new JsonFileQueueStorage(fsPort, dir),
      clock,
      idGen: new SeqIdGen('b'),
      defaults: { leaseMs: 5000 },
    });
    await b.load(); // sweeps the expired lease back to ready
    const redelivered = await b.lease();
    expect(redelivered).toHaveLength(1);
    expect(redelivered[0].payload).toEqual({ v: 7 });
    expect(redelivered[0].attempts).toBe(2);

    await b.ack(redelivered[0].id, redelivered[0].leaseId!);
    expect(b.peek()).toHaveLength(0);
    // Disk is drained too.
    const remaining = new EventQueue({
      adapter: new JsonFileQueueStorage(fsPort, dir),
      clock,
      idGen: new SeqIdGen('c'),
    });
    await remaining.load();
    expect(remaining.peek()).toHaveLength(0);
  });
});
