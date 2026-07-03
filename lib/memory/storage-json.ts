// MEMORY-001 memory layer — JSON file storage adapter (FS-001 scoped.fs jailed).
//
// Durable backend: one JSON file per record under <root>/<namespace>/<key>.json,
// written atomically through an injected FsPort (node-fs in host tests,
// expo-file-system on device via a deferred fs-expo). Imports no fs/expo directly.
//
// Every read/write/delete/list path is checked through classifyFsAccess (the
// FS-001 lexical root-jail) BEFORE any I/O: a namespace or key that resolves
// outside the declared root is denied and nothing is touched. Device symlink
// hardening (realpath) is the broker's job, exactly as capability-fs.ts documents.

import { classifyFsAccess, FsOperation } from '@/lib/capability-fs';
import {
  FsPort,
  MemoryHit,
  MemoryRecord,
  MemoryStorageAdapter,
  ResolvedQuery,
} from './types';
import { rankHits } from './ranking';

const FILE_SUFFIX = '.json';

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

// encodeURIComponent is injective and emits no path separator, so distinct
// namespaces/keys never collide and a crafted key cannot inject a '/'. Note it
// does NOT neutralize a bare '..' segment (dots are unreserved), so a namespace
// like '..' becomes <root>/.. — that escape is caught by assertWithinRoot's
// canonicalization, not the encoder. Both defenses run; the guard is authoritative.
function segment(value: string): string {
  return encodeURIComponent(value);
}

// FS-001 root-jail: canonicalize `path` against `root` and throw if it escapes.
// The segment encoder above is the primary escape defense; this is defense in
// depth that also catches any future code path that builds an unencoded path.
// Exported so the jail is unit-testable without reaching into the adapter.
export function assertWithinRoot(root: string, op: FsOperation, path: string): void {
  const verdict = classifyFsAccess({ op, path, roots: [root], cwd: root });
  if (verdict.decision !== 'allow') {
    throw new Error(`scoped.fs denied ${op}: ${verdict.reason}`);
  }
}

function isWellFormed(value: unknown): value is MemoryRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.namespace === 'string' &&
    typeof r.key === 'string' &&
    typeof r.kind === 'string' &&
    typeof r.text === 'string' &&
    Array.isArray(r.tags) &&
    typeof r.createdAt === 'number' &&
    typeof r.updatedAt === 'number'
    // kind is an open union — presence of the string fields above is enough.
  );
}

export interface JsonFileMemoryStorageOptions {
  root: string;
}

export class JsonFileMemoryStorage implements MemoryStorageAdapter {
  private readonly fs: FsPort;
  private readonly root: string;

  constructor(fs: FsPort, opts: JsonFileMemoryStorageOptions) {
    this.fs = fs;
    this.root = opts.root;
  }

  // Root-jail gate: deny anything that escapes the declared root before I/O.
  private guard(op: FsOperation, path: string): void {
    assertWithinRoot(this.root, op, path);
  }

  private nsDir(namespace: string): string {
    return joinPath(this.root, segment(namespace));
  }

  private fileFor(namespace: string, key: string): string {
    return joinPath(this.nsDir(namespace), `${segment(key)}${FILE_SUFFIX}`);
  }

  async put(record: MemoryRecord): Promise<void> {
    const dir = this.nsDir(record.namespace);
    const file = this.fileFor(record.namespace, record.key);
    this.guard('write', file);
    await this.fs.ensureDir(dir);
    await this.fs.writeFileAtomic(file, JSON.stringify(record));
  }

  async get(namespace: string, key: string): Promise<MemoryRecord | null> {
    const file = this.fileFor(namespace, key);
    this.guard('read', file);
    const raw = await this.fs.readFile(file);
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isWellFormed(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async loadNamespace(namespace: string): Promise<MemoryRecord[]> {
    const dir = this.nsDir(namespace);
    this.guard('list', dir);
    await this.fs.ensureDir(dir);
    const names = await this.fs.listFiles(dir);
    const out: MemoryRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue;
      const raw = await this.fs.readFile(joinPath(dir, name));
      if (raw === null) continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        // Tolerate one corrupt/foreign file instead of bricking the namespace.
        if (isWellFormed(parsed)) out.push(parsed);
      } catch {
        continue;
      }
    }
    return out;
  }

  async query(namespace: string, q: ResolvedQuery): Promise<MemoryHit[]> {
    return rankHits(await this.loadNamespace(namespace), q);
  }

  async delete(namespace: string, key: string): Promise<void> {
    const file = this.fileFor(namespace, key);
    this.guard('write', file);
    await this.fs.deleteFile(file);
  }

  async list(namespace: string): Promise<MemoryRecord[]> {
    return this.loadNamespace(namespace);
  }
}
