import {
  androidUserIdFromAppDataPath,
  ensureDirectory,
  fromFileUri,
  joinApkPath,
  resolveReleaseApkDir,
  toFileUri,
  type DirectoryFs,
} from '@/lib/release-apk-path';

const U0 = '/storage/emulated/0/Android/data/dev.shelly.terminal/files/Download';
const U95 = '/storage/emulated/95/Android/data/dev.shelly.terminal/files/Download';

describe('toFileUri / fromFileUri', () => {
  it('prefixes a plain absolute path', () => {
    expect(toFileUri(U0)).toBe(`file://${U0}`);
  });
  it('keeps an already-normalized URI unchanged', () => {
    expect(toFileUri(`file://${U0}`)).toBe(`file://${U0}`);
  });
  it('repairs double-prefixed and short-form URIs', () => {
    expect(toFileUri(`file://file://${U0}`)).toBe(`file://${U0}`);
    expect(toFileUri(`file:${U0}`)).toBe(`file://${U0}`);
    expect(toFileUri(`file:////${U0.slice(1)}`)).toBe(`file://${U0}`);
  });
  it('rejects relative and empty paths', () => {
    expect(() => toFileUri('Download/x.apk')).toThrow(/absolute/);
    expect(() => toFileUri('')).toThrow(/empty/);
  });
  it('round-trips to a plain path', () => {
    expect(fromFileUri(`file://${U95}/a.apk`)).toBe(`${U95}/a.apk`);
    expect(fromFileUri(`${U95}/a.apk`)).toBe(`${U95}/a.apk`);
  });
});

describe('androidUserIdFromAppDataPath', () => {
  it('reads the user id from expo documentDirectory', () => {
    expect(androidUserIdFromAppDataPath('file:///data/user/95/dev.shelly.terminal/files/')).toBe(95);
    expect(androidUserIdFromAppDataPath('file:///data/user/0/dev.shelly.terminal/files/')).toBe(0);
    expect(androidUserIdFromAppDataPath('/data/user_de/150/dev.shelly.terminal/')).toBe(150);
  });
  it('treats /data/data as user 0 and unknown shapes as null', () => {
    expect(androidUserIdFromAppDataPath('file:///data/data/dev.shelly.terminal/files/')).toBe(0);
    expect(androidUserIdFromAppDataPath('/sdcard/foo')).toBeNull();
    expect(androidUserIdFromAppDataPath(null)).toBeNull();
  });
});

describe('resolveReleaseApkDir', () => {
  it('prefers the native getExternalFilesDir path (Dual Messenger user 95)', () => {
    expect(resolveReleaseApkDir({ nativeDir: U95, appDataDir: 'file:///data/user/0/x/files/' })).toBe(U95);
    expect(resolveReleaseApkDir({ nativeDir: `file://${U95}/` })).toBe(U95);
  });
  it('derives the user from the app-data dir when native is unavailable', () => {
    expect(resolveReleaseApkDir({ nativeDir: null, appDataDir: 'file:///data/user/95/dev.shelly.terminal/files/' })).toBe(U95);
  });
  it('falls back to user 0', () => {
    expect(resolveReleaseApkDir({})).toBe(U0);
  });
  it('joins file names without doubled slashes', () => {
    expect(joinApkPath(`${U95}/`, 'a.apk')).toBe(`${U95}/a.apk`);
  });
});

describe('ensureDirectory', () => {
  function fakeFs(opts: { mkdirThrows?: boolean; exists: boolean; isDirectory?: boolean }) {
    const calls: string[] = [];
    const fs: DirectoryFs = {
      makeDirectoryAsync: jest.fn(async (uri: string) => {
        calls.push(`mkdir ${uri}`);
        if (opts.mkdirThrows) throw new Error(`Location '${uri}' isn't writable.`);
      }),
      getInfoAsync: jest.fn(async (uri: string) => {
        calls.push(`info ${uri}`);
        return { exists: opts.exists, isDirectory: opts.isDirectory ?? true };
      }),
    };
    return { fs, calls };
  }

  it('uses the same normalized file:// URI for mkdir and the existence check', async () => {
    const { fs, calls } = fakeFs({ exists: true });
    await expect(ensureDirectory(fs, U95)).resolves.toBe(`file://${U95}`);
    expect(calls).toEqual([`mkdir file://${U95}`, `info file://${U95}`]);
    expect(fs.makeDirectoryAsync).toHaveBeenCalledWith(`file://${U95}`, { intermediates: true });
  });

  it('tolerates a mkdir rejection when the directory already exists', async () => {
    const { fs } = fakeFs({ mkdirThrows: true, exists: true });
    await expect(ensureDirectory(fs, `file://${U95}`)).resolves.toBe(`file://${U95}`);
  });

  it('throws a precise error (with the mkdir reason) when the dir is not visible', async () => {
    const { fs } = fakeFs({ mkdirThrows: true, exists: false });
    await expect(ensureDirectory(fs, U0)).rejects.toThrow(
      new RegExp(`not accessible from this app: ${U0.replace(/\//g, '\\/')}: Location .* isn't writable`),
    );
  });

  it('rejects a path that exists but is a file', async () => {
    const { fs } = fakeFs({ exists: true, isDirectory: false });
    await expect(ensureDirectory(fs, U0)).rejects.toThrow(/not accessible/);
  });
});
