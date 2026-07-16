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
  EncryptedEnvelope,
  EncryptionPort,
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

// Envelope-shape guard (Track A, MEMORY-001), sibling to isWellFormed above.
// A file that parses as JSON but doesn't look like an EncryptedEnvelope is
// treated as absent/corrupt by readRecord() rather than passed to decrypt() —
// same "tolerate one corrupt/foreign file, don't brick the namespace"
// contract isWellFormed already gives the plaintext MemoryRecord shape.
function isWellFormedEnvelope(value: unknown): value is EncryptedEnvelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.v === 'number' &&
    typeof e.iv === 'string' &&
    typeof e.ciphertext === 'string' &&
    (e.keyId === undefined || typeof e.keyId === 'string')
  );
}

export interface JsonFileMemoryStorageOptions {
  root: string;
}

export class JsonFileMemoryStorage implements MemoryStorageAdapter {
  private readonly fs: FsPort;
  private readonly encryption: EncryptionPort;
  private readonly root: string;

  constructor(fs: FsPort, encryption: EncryptionPort, opts: JsonFileMemoryStorageOptions) {
    this.fs = fs;
    this.encryption = encryption;
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

  // Serializes + encrypts a record and writes the envelope. The plaintext
  // MemoryRecord JSON never touches this.fs — only JSON.stringify(envelope)
  // (base64 iv/ciphertext) does.
  private async writeRecord(file: string, record: MemoryRecord): Promise<void> {
    const envelope = await this.encryption.encrypt(JSON.stringify(record));
    await this.fs.writeFileAtomic(file, JSON.stringify(envelope));
  }

  // Reads one record file end-to-end: raw bytes -> envelope-shape guard ->
  // decrypt -> MemoryRecord-shape guard. ANY failure at any stage (missing
  // file, non-JSON, non-envelope shape, decrypt/auth-tag failure, or a
  // decrypted payload that isn't a well-formed MemoryRecord) degrades to
  // null — "absent or corrupt" — never a throw, so a single bad/tampered file
  // never bricks get() or loadNamespace().
  private async readRecord(file: string): Promise<MemoryRecord | null> {
    const raw = await this.fs.readFile(file);
    if (raw === null) return null;
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isWellFormedEnvelope(envelope)) return null;
    try {
      const plaintext = await this.encryption.decrypt(envelope);
      const parsed: unknown = JSON.parse(plaintext);
      return isWellFormed(parsed) ? parsed : null;
    } catch {
      // Covers decrypt() throwing (auth-tag mismatch / wrong key / corrupt
      // ciphertext) as well as a malformed decrypted JSON payload.
      return null;
    }
  }

  async put(record: MemoryRecord): Promise<void> {
    const dir = this.nsDir(record.namespace);
    const file = this.fileFor(record.namespace, record.key);
    this.guard('write', file);
    await this.fs.ensureDir(dir);
    await this.writeRecord(file, record);
  }

  async get(namespace: string, key: string): Promise<MemoryRecord | null> {
    const file = this.fileFor(namespace, key);
    this.guard('read', file);
    return this.readRecord(file);
  }

  private async loadNamespace(namespace: string): Promise<MemoryRecord[]> {
    const dir = this.nsDir(namespace);
    this.guard('list', dir);
    await this.fs.ensureDir(dir);
    const names = await this.fs.listFiles(dir);
    const out: MemoryRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(FILE_SUFFIX)) continue;
      // Tolerate one corrupt/foreign/undecryptable file instead of bricking
      // the namespace — readRecord() already degrades every failure to null.
      const record = await this.readRecord(joinPath(dir, name));
      if (record) out.push(record);
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
