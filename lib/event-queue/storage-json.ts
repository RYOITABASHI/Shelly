// EVENT-001 event.queue — JSON file storage adapter.
//
// Durable backend: one JSON file per record under a base directory, written
// atomically. RN/host safe because it imports no `fs`/expo directly — all I/O
// goes through an injected FsPort (node-fs in host tests, expo-file-system on
// device via the deferred fs-expo.ts). One bad/corrupt file is skipped on load
// rather than failing the whole queue.

import { FsPort, QueueRecord, QueueStorageAdapter } from './types';

const FILE_SUFFIX = '.json';

const VALID_STATES = new Set(['ready', 'leased', 'dead']);

// A record that parses as JSON but has a missing/garbage shape (truncated then
// hand-repaired, schema drift) must not enter the queue: an invalid `state`
// would be un-leasable (silent stall) and would poison stats(). Admit only
// well-formed records; drop the rest like a corrupt file.
function isWellFormed(value: unknown): value is QueueRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.topic === 'string' &&
    typeof r.state === 'string' &&
    VALID_STATES.has(r.state) &&
    typeof r.attempts === 'number' &&
    typeof r.maxAttempts === 'number' &&
    typeof r.visibleAt === 'number' &&
    typeof r.enqueuedAt === 'number'
  );
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

// Record ids are queue-generated (not user input), but encode the filename
// anyway so a future id scheme can neither escape the base dir nor collide.
// encodeURIComponent is injective and reversible and emits no path separator,
// so distinct ids always map to distinct files (no silent clobber/mis-delete).
function fileNameFor(id: string): string {
  return `${encodeURIComponent(id)}${FILE_SUFFIX}`;
}

export class JsonFileQueueStorage implements QueueStorageAdapter {
  private readonly fs: FsPort;
  private readonly dir: string;
  private ensured = false;

  constructor(fs: FsPort, dir: string) {
    this.fs = fs;
    this.dir = dir;
  }

  private async ensureDir(): Promise<void> {
    if (this.ensured) return;
    await this.fs.ensureDir(this.dir);
    this.ensured = true;
  }

  async loadAll(): Promise<QueueRecord[]> {
    await this.ensureDir();
    const names = await this.fs.listFiles(this.dir);
    const out: QueueRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue;
      const raw = await this.fs.readFile(joinPath(this.dir, name));
      if (raw === null) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isWellFormed(parsed)) {
          out.push(parsed);
        }
      } catch {
        // Tolerate a single corrupt file (partial write, manual edit) rather
        // than bricking the whole queue.
        continue;
      }
    }
    return out;
  }

  async put(record: QueueRecord): Promise<void> {
    await this.ensureDir();
    await this.fs.writeFileAtomic(
      joinPath(this.dir, fileNameFor(record.id)),
      JSON.stringify(record),
    );
  }

  async delete(id: string): Promise<void> {
    await this.ensureDir();
    await this.fs.deleteFile(joinPath(this.dir, fileNameFor(id)));
  }
}
