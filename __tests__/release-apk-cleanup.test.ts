import {
  cleanupLegacyUpdateDirs,
  deleteApkFiles,
  isReleaseApkFileName,
  legacyDirContentsRemovable,
  releaseApkVersionCode,
  selectStaleApksBeforeDownload,
  selectStaleApksOnStartup,
  selectStaleLegacyUpdateDirs,
  type CleanupFs,
} from '@/lib/release-apk-cleanup';

const DIR = '/storage/emulated/0/Android/data/dev.shelly.terminal/files/Download';
const apk = (vc: number, ver = '6.0.0') => `Shelly-android-v${ver}-${vc}-27992037105-1-102ef615eb13.apk`;

describe('release APK name parsing', () => {
  it('recognizes release asset names only', () => {
    expect(isReleaseApkFileName(apk(2700))).toBe(true);
    expect(isReleaseApkFileName('Shelly-android-anything.apk')).toBe(true);
    expect(isReleaseApkFileName('packs')).toBe(false);
    expect(isReleaseApkFileName('other.apk')).toBe(false);
    expect(isReleaseApkFileName('Shelly-2700-new-signing-key.apk')).toBe(false);
    expect(isReleaseApkFileName('Shelly-android-x.apk.part')).toBe(false);
    expect(isReleaseApkFileName('../Shelly-android-x.apk')).toBe(false);
    expect(isReleaseApkFileName('sub/Shelly-android-x.apk')).toBe(false);
  });

  it('extracts the versionCode', () => {
    expect(releaseApkVersionCode(apk(2700))).toBe(2700);
    expect(releaseApkVersionCode(apk(1388, '5.3.8'))).toBe(1388);
    expect(releaseApkVersionCode('Shelly-android-anything.apk')).toBeNull();
  });
});

describe('selectStaleApksBeforeDownload', () => {
  it('deletes every other release APK but keeps the target', () => {
    const names = [apk(2600), apk(2650), apk(2700), 'packs', 'notes.txt', 'ShellyModels'];
    expect(selectStaleApksBeforeDownload(names, apk(2700))).toEqual([apk(2600), apk(2650)]);
  });

  it('keeps protected (handed-off / in-flight) files, given as paths', () => {
    const names = [apk(2600), apk(2650), apk(2700)];
    expect(selectStaleApksBeforeDownload(names, apk(2700), [`${DIR}/${apk(2650)}`, null, undefined])).toEqual([
      apk(2600),
    ]);
  });
});

describe('selectStaleApksOnStartup', () => {
  it('deletes APKs at or below the installed versionCode only', () => {
    const names = [apk(2600), apk(2700), apk(2701), 'Shelly-android-odd.apk', 'packs'];
    expect(selectStaleApksOnStartup(names, 2700)).toEqual([apk(2600), apk(2700)]);
  });

  it('respects protected paths and refuses an unknown installed version', () => {
    const names = [apk(2600), apk(2650)];
    expect(selectStaleApksOnStartup(names, 2700, [`${DIR}/${apk(2600)}`])).toEqual([apk(2650)]);
    expect(selectStaleApksOnStartup(names, NaN)).toEqual([]);
    expect(selectStaleApksOnStartup(names, 0)).toEqual([]);
  });
});

describe('legacy shelly-update dirs', () => {
  it('selects only old shelly-update-* dirs', () => {
    const names = ['shelly-update-1500', 'shelly-update-android-latest-2600', 'shelly-update-2800', 'shelly-apk', 'ShellyModels', 'shelly-update-'];
    expect(selectStaleLegacyUpdateDirs(names, 2700)).toEqual(['shelly-update-1500', 'shelly-update-android-latest-2600']);
  });

  it('only removes dirs that hold nothing but apk files', () => {
    expect(legacyDirContentsRemovable([{ name: 'a.apk', isDirectory: false }])).toBe(true);
    expect(legacyDirContentsRemovable([])).toBe(true);
    expect(legacyDirContentsRemovable([{ name: 'a.apk', isDirectory: false }, { name: 'x.txt', isDirectory: false }])).toBe(false);
    expect(legacyDirContentsRemovable([{ name: 'sub.apk', isDirectory: true }])).toBe(false);
  });
});

function fakeFs(tree: Record<string, 'file' | 'dir'>): CleanupFs & { deleted: string[] } {
  const strip = (uri: string) => uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
  const deleted: string[] = [];
  return {
    deleted,
    async readDirectoryAsync(uri) {
      const d = strip(uri);
      if (tree[d] !== 'dir') throw new Error('not a dir');
      return Object.keys(tree)
        .filter((p) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes('/'))
        .map((p) => p.slice(d.length + 1));
    },
    async getInfoAsync(uri) {
      const kind = tree[strip(uri)];
      return { exists: !!kind, isDirectory: kind === 'dir' };
    },
    async deleteAsync(uri) {
      const p = strip(uri);
      deleted.push(p);
      delete tree[p];
    },
  };
}

describe('deleteApkFiles', () => {
  it('deletes only plain release-APK files and ignores unsafe names', async () => {
    const fs = fakeFs({
      [DIR]: 'dir',
      [`${DIR}/${apk(2600)}`]: 'file',
      [`${DIR}/Shelly-android-dir.apk`]: 'dir',
      [`${DIR}/packs`]: 'dir',
    });
    const out = await deleteApkFiles(fs, DIR, [apk(2600), 'Shelly-android-dir.apk', 'packs', '../x.apk']);
    expect(out).toEqual([apk(2600)]);
    expect(fs.deleted).toEqual([`${DIR}/${apk(2600)}`]);
  });
});

describe('cleanupLegacyUpdateDirs', () => {
  it('removes old apk-only dirs and leaves everything else', async () => {
    const pub = '/sdcard/Download';
    const fs = fakeFs({
      [pub]: 'dir',
      [`${pub}/shelly-update-1500`]: 'dir',
      [`${pub}/shelly-update-1500/${apk(1500)}`]: 'file',
      [`${pub}/shelly-update-1600`]: 'dir',
      [`${pub}/shelly-update-1600/keep.txt`]: 'file',
      [`${pub}/shelly-update-2800`]: 'dir',
      [`${pub}/shelly-update-2800/${apk(2800)}`]: 'file',
      [`${pub}/ShellyModels`]: 'dir',
      [`${pub}/user.apk`]: 'file',
    });
    const removed = await cleanupLegacyUpdateDirs(fs, pub, 2700);
    expect(removed).toEqual(['shelly-update-1500']);
    expect(fs.deleted).toEqual([`${pub}/shelly-update-1500/${apk(1500)}`, `${pub}/shelly-update-1500`]);
  });
});
