/**
 * Shared temp-dir tracking for Jest tests.
 *
 * Tests create scratch homes/run dirs with `fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-...'))`
 * all over `__tests__/`, and most never removed them (tens of thousands of `shelly-*` dirs piled
 * up in %TEMP% on the dev PC). Rather than hand-adding cleanup to every call site, this module
 * (loaded via `setupFilesAfterEnv` in jest.config.cjs) wraps `fs.mkdtempSync` / `fs.mkdtemp` /
 * `fs.promises.mkdtemp` for the duration of each test file, records every directory created under
 * `os.tmpdir()`, and removes them all in `afterAll`. Test semantics are unchanged: the dirs live
 * for the whole file exactly as before, they are just deleted when the file finishes.
 *
 * New tests can also call `makeTmpDir(prefix)` explicitly; it is tracked the same way.
 */
// `require` (not `import * as`) so we patch the real, mutable core-module object. Test files'
// `import * as fs` namespaces are live getters over this same object, so they see the wrapper.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs: typeof import('fs') = require('fs');
import * as os from 'os';
import * as path from 'path';

// State lives on the per-test-file Jest global, so even if this module is evaluated twice in one
// file (e.g. after jest.resetModules()), there is exactly one tracker and one fs wrapper.
interface TmpTrackerState {
  tracked: Set<string>;
  installed: boolean;
}
const g = globalThis as { __shellyTmpTracker?: TmpTrackerState };
const state: TmpTrackerState = (g.__shellyTmpTracker ??= { tracked: new Set(), installed: false });
const tracked = state.tracked;

function isUnderTmp(dir: string): boolean {
  const root = path.resolve(os.tmpdir());
  const resolved = path.resolve(dir);
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function trackTmpDir(dir: string): string {
  if (typeof dir === 'string' && isUnderTmp(dir)) tracked.add(dir);
  return dir;
}

export function makeTmpDir(prefix = 'shelly-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTmpDir(dir: string): void {
  try {
    // force: ignore ENOENT; maxRetries/retryDelay: ride out transient EBUSY/EPERM on Windows
    // (e.g. a just-exited child process still holding a handle).
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    // Cleanup must never fail a test run.
    // eslint-disable-next-line no-console
    console.warn(`[tmp-cleanup] could not remove ${dir}: ${(error as Error)?.message ?? error}`);
  }
}

export function cleanupTrackedTmpDirs(): void {
  // Remove deepest paths first so nested mkdtemp roots don't race their parents.
  const dirs = Array.from(tracked).sort((a, b) => b.length - a.length);
  tracked.clear();
  for (const dir of dirs) removeTmpDir(dir);
}

type MkdtempSync = typeof fs.mkdtempSync;

const realMkdtempSync = fs.mkdtempSync;
const realMkdtemp = fs.mkdtemp;
const realPromisesMkdtemp = fs.promises.mkdtemp;

function installTracking(): void {
  (fs as { mkdtempSync: MkdtempSync }).mkdtempSync = function trackedMkdtempSync(
    this: unknown,
    ...args: Parameters<MkdtempSync>
  ) {
    const dir = (realMkdtempSync as (...a: unknown[]) => unknown).apply(fs, args);
    if (typeof dir === 'string') trackTmpDir(dir);
    return dir;
  } as MkdtempSync;

  (fs as { mkdtemp: unknown }).mkdtemp = function trackedMkdtemp(...args: unknown[]) {
    const cb = args[args.length - 1];
    if (typeof cb === 'function') {
      args[args.length - 1] = (err: unknown, dir: unknown) => {
        if (!err && typeof dir === 'string') trackTmpDir(dir);
        (cb as (...a: unknown[]) => void)(err, dir);
      };
    }
    return (realMkdtemp as (...a: unknown[]) => unknown).apply(fs, args);
  };

  (fs.promises as { mkdtemp: unknown }).mkdtemp = async function trackedPromisesMkdtemp(
    ...args: unknown[]
  ) {
    const dir = await (realPromisesMkdtemp as (...a: unknown[]) => Promise<unknown>).apply(
      fs.promises,
      args,
    );
    if (typeof dir === 'string') trackTmpDir(dir);
    return dir;
  };
}

function uninstallTracking(): void {
  (fs as { mkdtempSync: MkdtempSync }).mkdtempSync = realMkdtempSync;
  (fs as { mkdtemp: unknown }).mkdtemp = realMkdtemp;
  (fs.promises as { mkdtemp: unknown }).mkdtemp = realPromisesMkdtemp;
}

// Only auto-install when loaded inside a Jest test file context, and only once per file.
if (typeof afterAll === 'function' && !state.installed) {
  state.installed = true;
  installTracking();
  afterAll(() => {
    cleanupTrackedTmpDirs();
    uninstallTracking();
  });
}
