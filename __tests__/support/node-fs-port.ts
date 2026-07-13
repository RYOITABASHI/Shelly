// Host-only FsPort backed by node fs, for exercising the JSON storage adapter
// and crash-recovery tests. Lives under __tests__/support (not a *.test.ts) so
// jest never runs it as a suite and Metro never bundles it into the app, while
// tsc still type-checks it. Never imported by production code.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FsPort } from '@/lib/event-queue/types';

export function makeNodeFsPort(): FsPort {
  return {
    async readFile(p: string): Promise<string | null> {
      try {
        return await fs.promises.readFile(p, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    async writeFileAtomic(p: string, data: string): Promise<void> {
      const tmp = `${p}.tmp-${process.pid}`;
      await fs.promises.writeFile(tmp, data, 'utf8');
      await fs.promises.rename(tmp, p);
    },
    async deleteFile(p: string): Promise<void> {
      try {
        await fs.promises.unlink(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw err;
      }
    },
    async listFiles(dir: string): Promise<string[]> {
      try {
        return await fs.promises.readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    },
    async ensureDir(dir: string): Promise<void> {
      await fs.promises.mkdir(dir, { recursive: true });
    },
  };
}

export function makeTmpDir(prefix = 'shelly-event-queue-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
