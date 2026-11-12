/**
 * Shelly's Codex comes from Termux's official package. scripts/codex-termux-apt.js
 * proves that through apt's chain (pinned key -> signed InRelease -> Packages hash
 * -> .deb hash); a workflow is only verified on GitHub, so the logic lives there.
 * The InRelease fixture is a real one, signed by Termux on 2026-11-07.
 */
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

const root = path.resolve(__dirname, '..');
const apt = require('../scripts/codex-termux-apt.js');

const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const sha256 = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');
const inRelease = fs.readFileSync(path.join(root, '__tests__/fixtures/termux-InRelease.txt'));
const FIXTURE_NOW = Date.parse('2026-11-07T04:00:00Z');
const hasGpgv = spawnSync('gpgv', ['--version']).status === 0;
const withGpgv = hasGpgv ? describe : describe.skip;

const PACKAGES_PATH = 'main/binary-aarch64/Packages.gz';

function stanza(fields: Record<string, string | number>) {
  return Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n');
}

const HASH = 'a'.repeat(64);
const entryText = (version: string, extra: Record<string, string | number> = {}) => stanza({
  Package: 'codex',
  Architecture: 'aarch64',
  Version: version,
  Filename: `pool/main/c/codex/codex_${version}_aarch64.deb`,
  Size: 1234,
  SHA256: HASH,
  ...extra,
});

const pin = (version = '0.167.0', hash = HASH, upstream = version.split('-')[0]) => ({
  package: 'codex',
  version,
  upstreamVersion: upstream,
  filename: `pool/main/c/codex/codex_${version}_aarch64.deb`,
  size: 1234,
  sha256: hash,
});

describe('Debian versions', () => {
  it('separates the upstream version from the packaging revision', () => {
    expect(apt.parseDebVersion('0.167.0').upstream).toBe('0.167.0');
    expect(apt.parseDebVersion('0.167.0-2').upstream).toBe('0.167.0');
  });

  it('orders by version, then revision, numerically', () => {
    const cmp = (a: string, b: string) => apt.compareDebVersions(apt.parseDebVersion(a), apt.parseDebVersion(b));
    expect(cmp('0.167.0', '0.99.0')).toBeGreaterThan(0);
    expect(cmp('0.167.0-1', '0.167.0')).toBeGreaterThan(0);
    expect(cmp('0.167.0-10', '0.167.0-9')).toBeGreaterThan(0);
    expect(cmp('0.167.0', '0.167.0')).toBe(0);
  });

  it('rejects anything else, like the fork tags and prereleases', () => {
    for (const bad of ['v0.163.0-termux.3', '0.167.0-alpha.1', '1:0.167.0', '0.167', '', undefined]) {
      expect(apt.parseDebVersion(bad)).toBeNull();
    }
  });
});

withGpgv('verifyInRelease with the pinned key', () => {
  it('accepts the real signed index and returns only the signed text', () => {
    const clear = apt.verifyInRelease(inRelease);
    expect(clear).toContain('Origin: termux-main stable');
    expect(clear).not.toContain('BEGIN PGP');
  });

  it('refuses a changed index', () => {
    const tampered = Buffer.from(inRelease.toString('utf8').replace('Suite: stable', 'Suite: stablf'));
    expect(() => apt.verifyInRelease(tampered)).toThrow(apt.SignatureError);
  });

  it('refuses a file with no signature', () => {
    expect(() => apt.verifyInRelease(Buffer.from('Suite: stable\n'))).toThrow(apt.SignatureError);
  });

  it('never returns text placed around the signed block', () => {
    const padded = Buffer.concat([Buffer.from('SHA256:\n aaaa 1 main/binary-aarch64/Packages.gz\n\n'), inRelease]);
    let out = '';
    try {
      out = apt.verifyInRelease(padded);
    } catch (error) {
      expect(error).toBeInstanceOf(apt.TrustError);
    }
    expect(out).not.toContain(' aaaa 1 main/binary-aarch64');
  });

  it('refuses a good signature from a key that is not pinned', () => {
    expect(() => apt.verifyInRelease(inRelease, { fingerprints: ['0'.repeat(40)] })).toThrow(/not signed by a pinned key/);
  });

  it('reads the Packages hash from the real index', () => {
    const { fields, sha256Files } = apt.parseInRelease(apt.verifyInRelease(inRelease));
    expect(() => apt.checkReleaseFields(fields, FIXTURE_NOW)).not.toThrow();
    const listed = sha256Files.get(PACKAGES_PATH);
    expect(listed.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(listed.size).toBeGreaterThan(0);
  });
});

describe('verifyInRelease failure modes', () => {
  it('fails closed when gpgv cannot run', () => {
    expect(() => apt.verifyInRelease(inRelease, { gpgv: 'no-such-gpgv-binary' })).toThrow(/cannot run gpgv/);
  });

  it('pins the key that signs termux-main', () => {
    expect(apt.TERMUX_SIGNING_FINGERPRINTS).toEqual(['CC72CF8BA7DBFA0182877D045A897D96E57CF20C']);
    expect(fs.statSync(path.join(root, 'scripts/termux-autobuilds.gpg')).size).toBe(2458);
  });
});

describe('checkReleaseFields', () => {
  const good = { Origin: 'termux-main stable', Suite: 'stable', Codename: 'stable', Date: 'Sat, 7 Nov 2026 03:00:30 UTC' };

  it('accepts a fresh stable index', () => {
    expect(() => apt.checkReleaseFields(good, FIXTURE_NOW)).not.toThrow();
  });

  it('refuses a replayed old index, there being no Valid-Until', () => {
    expect(() => apt.checkReleaseFields(good, FIXTURE_NOW + 15 * 86400000)).toThrow(/older than/);
  });

  it('refuses another suite, origin, a future date and a bad date', () => {
    expect(() => apt.checkReleaseFields({ ...good, Suite: 'testing' }, FIXTURE_NOW)).toThrow(/suite/);
    expect(() => apt.checkReleaseFields({ ...good, Origin: 'termux-x11' }, FIXTURE_NOW)).toThrow(/origin/);
    expect(() => apt.checkReleaseFields(good, FIXTURE_NOW - 3 * 86400000)).toThrow(/future/);
    expect(() => apt.checkReleaseFields({ ...good, Date: 'soon' }, FIXTURE_NOW)).toThrow(/date/);
  });
});

describe('newestPackage', () => {
  const parse = (...blocks: string[]) => apt.parsePackages(blocks.join('\n\n'));

  it('picks the highest aarch64 version and ignores other packages', () => {
    const entry = apt.newestPackage(parse(
      stanza({ Package: 'codex-extra', Version: '9.0.0' }),
      entryText('0.166.0'),
      entryText('0.167.0'),
      entryText('0.170.0', { Architecture: 'arm' }),
    ));
    expect(entry).toEqual(pin('0.167.0'));
  });

  it('keeps the revision in version and drops it from upstreamVersion', () => {
    expect(apt.newestPackage(parse(entryText('0.167.0-2'))).upstreamVersion).toBe('0.167.0');
  });

  it('fails on a missing package, a strange version, or a bad path or hash', () => {
    expect(() => apt.newestPackage(parse(stanza({ Package: 'git', Version: '1.0.0' })))).toThrow(/no aarch64/);
    expect(() => apt.newestPackage(parse(entryText('0.167.0-rc1')))).toThrow(/unrecognized/);
    expect(() => apt.newestPackage(parse(entryText('0.167.0', { Filename: '../../etc/passwd.deb' })))).toThrow(/Filename/);
    expect(() => apt.newestPackage(parse(entryText('0.167.0', { SHA256: 'abc' })))).toThrow(/SHA256/);
  });
});

describe('decideBump', () => {
  it('moves up on a new version or revision', () => {
    expect(apt.decideBump(pin('0.167.0'), pin('0.168.0'))).toBe(true);
    expect(apt.decideBump(pin('0.167.0'), pin('0.167.0-1'))).toBe(true);
  });

  it('stays put on the same version and hash', () => {
    expect(apt.decideBump(pin('0.167.0'), pin('0.167.0'))).toBe(false);
  });

  it('refuses a downgrade and a re-pointed hash', () => {
    expect(() => apt.decideBump(pin('0.167.0'), pin('0.166.0'))).toThrow(apt.TrustError);
    expect(() => apt.decideBump(pin('0.167.0'), pin('0.167.0', 'b'.repeat(64)))).toThrow(/changed hash/);
  });
});

describe('the pin', () => {
  const repoPin = JSON.parse(read('.ci-versions/codex-termux-deb.json'));

  it('is valid and agrees with codex.txt', () => {
    expect(apt.validatePin(repoPin)).toBe(repoPin);
    expect(() => apt.checkPinMatchesCodexTxt(repoPin, read('.ci-versions/codex.txt'))).not.toThrow();
  });

  it('compares the upstream part, so a Termux revision does not fail the build', () => {
    expect(() => apt.checkPinMatchesCodexTxt(pin('0.167.0-1'), '0.167.0\n')).not.toThrow();
  });

  it('fails the build when codex.txt drifts', () => {
    expect(() => apt.checkPinMatchesCodexTxt(pin('0.167.0'), '0.166.0')).toThrow(/codex\.txt/);
  });

  it('rejects a broken pin', () => {
    expect(() => apt.validatePin({ ...pin(), package: 'git' })).toThrow();
    expect(() => apt.validatePin({ ...pin(), sha256: 'x' })).toThrow();
    expect(() => apt.validatePin({ ...pin(), size: 0 })).toThrow();
    expect(() => apt.validatePin({ ...pin(), filename: 'pool/main/c/codex/../../x.deb' })).toThrow();
    expect(() => apt.validatePin({ ...pin(), upstreamVersion: '0.1.0' })).toThrow();
  });

  // The channel starts on the bundled package and the Bump job then moves it
  // ahead on its own (bundled pin stays put), so it is never behind the bundle.
  it('keeps the channel on or ahead of the bundled package', () => {
    const channel = apt.validatePin(JSON.parse(read('.ci-versions/codex-termux-channel.json')));
    expect(channel.package).toBe(repoPin.package);
    expect(apt.compareDebVersions(channel.version, repoPin.version)).toBeGreaterThanOrEqual(0);
    if (channel.version === repoPin.version) expect(channel.sha256).toBe(repoPin.sha256);
  });

  it('left the fork pins behind', () => {
    expect(fs.existsSync(path.join(root, '.ci-versions/codex-termux.txt'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.ci-versions/codex-termux.integrity'))).toBe(false);
  });
});

describe('resolveLatest', () => {
  const packagesGz = zlib.gzipSync(entryText('0.167.0'));
  const clear = (gz: Buffer) => [
    'Origin: termux-main stable', 'Suite: stable', 'Codename: stable', 'Date: Sat, 7 Nov 2026 03:00:30 UTC',
    'SHA256:', ` ${sha256(gz)} ${gz.length} ${PACKAGES_PATH}`, '',
  ].join('\n');
  const options = (get: (url: string) => Promise<Buffer>, gz = packagesGz) => ({
    mirrors: ['https://one.test', 'https://two.test'],
    now: FIXTURE_NOW,
    get,
    verify: () => clear(gz),
  });
  const silence = () => jest.spyOn(console, 'log').mockImplementation(() => {});
  afterEach(() => jest.restoreAllMocks());

  it('walks InRelease to Packages to the entry', async () => {
    silence();
    const entry = await apt.resolveLatest(options(async (url) => (url.endsWith('.gz') ? packagesGz : Buffer.from('signed'))));
    expect(entry.version).toBe('0.167.0');
  });

  it('refuses a Packages file that does not match the signed hash, without trying another mirror', async () => {
    silence();
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      return url.endsWith('.gz') ? zlib.gzipSync(entryText('0.168.0')) : Buffer.from('signed');
    };
    await expect(apt.resolveLatest(options(get))).rejects.toBeInstanceOf(apt.TrustError);
    expect(urls.filter((url) => url.startsWith('https://two.test'))).toEqual([]);
  });

  it('moves to the next mirror on a network failure', async () => {
    silence();
    const get = async (url: string) => {
      if (url.startsWith('https://one.test')) throw new Error('HTTP 503');
      return url.endsWith('.gz') ? packagesGz : Buffer.from('signed');
    };
    expect((await apt.resolveLatest(options(get))).version).toBe('0.167.0');
  });
});

describe('fetching the .deb', () => {
  const body = Buffer.from('the real deb');
  const realPin = { ...pin(), size: body.length, sha256: sha256(body) };
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it('uses Shelly\'s own copy when the pool dropped the file, and only on a hash match', async () => {
    const urls: string[] = [];
    const get = async (url: string) => {
      urls.push(url);
      if (url.startsWith('https://pool.test')) throw new Error('HTTP 404');
      return body;
    };
    const out = await apt.fetchDeb(realPin, { mirrors: ['https://pool.test'], archiveBase: 'https://release.test/tag/', get });
    expect(out).toBe(body);
    expect(urls[1]).toBe('https://release.test/tag/codex_0.167.0_aarch64.deb');
  });

  it('never returns bytes that do not match the pin', async () => {
    const options = { mirrors: ['https://a.test', 'https://b.test'], get: async () => Buffer.from('evil deb bytes') };
    await expect(apt.fetchDeb(realPin, options)).rejects.toThrow(/does not match the pin/);
  });

});

describe('confirmPinAgainstIndex: an APK build never depends on the live index', () => {
  const packagesFor = (version: string, hash = HASH) => zlib.gzipSync(entryText(version, { SHA256: hash }));
  const options = (gz: Buffer, { date = 'Sat, 7 Nov 2026 03:00:30 UTC', now = FIXTURE_NOW } = {}) => ({
    mirrors: ['https://one.test'],
    now,
    get: async (url: string) => (url.endsWith('.gz') ? gz : Buffer.from('signed')),
    verify: () => [
      'Origin: termux-main stable', 'Suite: stable', 'Codename: stable', `Date: ${date}`,
      'SHA256:', ` ${sha256(gz)} ${gz.length} ${PACKAGES_PATH}`, '',
    ].join('\n'),
  });
  let log: jest.SpyInstance;
  beforeEach(() => { log = jest.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => jest.restoreAllMocks());
  const warned = () => log.mock.calls.some(([line]) => String(line).startsWith('::warning'));

  it('confirms a pin the index still lists', async () => {
    await expect(apt.confirmPinAgainstIndex(pin(), options(packagesFor('0.167.0')))).resolves.toBe('confirmed');
    expect(warned()).toBe(false);
  });

  it('accepts an index that has moved on', async () => {
    await expect(apt.confirmPinAgainstIndex(pin(), options(packagesFor('0.170.0')))).resolves.toBe('moved');
  });

  it('only warns when the index is stale', async () => {
    const stale = options(packagesFor('0.167.0'), { now: FIXTURE_NOW + 30 * 86400000 });
    await expect(apt.confirmPinAgainstIndex(pin(), stale)).resolves.toBe('unconfirmed');
    expect(warned()).toBe(true);
  });

  it('only warns when the index is older than the pin', async () => {
    await expect(apt.confirmPinAgainstIndex(pin('0.170.0'), options(packagesFor('0.167.0')))).resolves.toBe('unconfirmed');
    expect(warned()).toBe(true);
  });

  it('only warns when Termux is down', async () => {
    const down = { mirrors: ['https://one.test'], get: async () => { throw new Error('HTTP 503'); } };
    await expect(apt.confirmPinAgainstIndex(pin(), down)).resolves.toBe('unconfirmed');
  });

  it('stops on a failed signature', async () => {
    const forged = {
      ...options(packagesFor('0.167.0')),
      verify: () => { throw new apt.SignatureError('bad signature'); },
    };
    await expect(apt.confirmPinAgainstIndex(pin(), forged)).rejects.toBeInstanceOf(apt.SignatureError);
  });
});

describe('needsPublish', () => {
  const published = { source: 'termux-apt', codexTermuxVersion: '0.167.0', debSha256: HASH };

  it('is false only when the channel holds exactly the pinned package', () => {
    expect(apt.needsPublish(published, pin())).toBe(false);
  });

  it('is true for no manifest, the old fork manifest, another version or another build', () => {
    expect(apt.needsPublish(null, pin())).toBe(true);
    expect(apt.needsPublish({ version: '0.163.0', codexTermuxVersion: 'v0.163.0-termux.3' }, pin())).toBe(true);
    expect(apt.needsPublish({ ...published, codexTermuxVersion: '0.166.0' }, pin())).toBe(true);
    expect(apt.needsPublish({ ...published, debSha256: 'b'.repeat(64) }, pin())).toBe(true);
  });
});

describe('runtimeManifest', () => {
  it('reports the version --version prints, not the Debian revision', () => {
    const manifest = apt.runtimeManifest({ pin: pin('0.167.0-1'), assetName: 'a.tar.gz', tarballUrl: 'https://x', sha256: HASH });
    expect(manifest.version).toBe('0.167.0');
    expect(manifest.codexVersion).toBe('0.167.0');
    expect(manifest.codexTermuxVersion).toBe('0.167.0-1');
    expect(manifest.source).toBe('termux-apt');
    expect(manifest.channel).toBe('codex-runtime-latest');
  });
});

/** A minimal ELF64: one PT_LOAD over the file, PT_INTERP, PT_DYNAMIC, version tables. */
function elf({
  type = 3, machine = 183, interp = '/system/bin/linker64', needed = ['libc.so'],
  requires = {} as Record<string, string[]>, defines = [] as string[],
} = {}) {
  const buf = Buffer.alloc(4096);
  buf.writeUInt32BE(0x7f454c46, 0);
  buf[4] = 2;
  buf[5] = 1;
  buf.writeUInt16LE(type, 16);
  buf.writeUInt16LE(machine, 18);
  buf.writeBigUInt64LE(64n, 32);
  buf.writeUInt16LE(56, 54);
  buf.writeUInt16LE(3, 56);
  const header = (at: number, kind: number, offset: number, filesz: number) => {
    buf.writeUInt32LE(kind, at);
    buf.writeBigUInt64LE(BigInt(offset), at + 8);
    buf.writeBigUInt64LE(BigInt(offset), at + 16);
    buf.writeBigUInt64LE(BigInt(filesz), at + 32);
  };
  header(64, 1, 0, buf.length);
  const interpAt = 300;
  buf.write(`${interp}\0`, interpAt, 'latin1');
  header(120, 3, interpAt, interp.length + 1);
  const strtab = 400;
  let cursor = 1;
  const str = (name: string) => {
    const at = cursor;
    buf.write(`${name}\0`, strtab + at, 'latin1');
    cursor += name.length + 1;
    return at;
  };
  const dynamic = 1200;
  let entry = dynamic;
  const tag = (kind: bigint, value: number) => {
    buf.writeBigInt64LE(kind, entry);
    buf.writeBigUInt64LE(BigInt(value), entry + 8);
    entry += 16;
  };
  for (const name of needed) tag(1n, str(name));
  tag(5n, strtab);
  const libraries = Object.entries(requires);
  let table = 2000;
  if (libraries.length > 0) {
    tag(0x6ffffffen, table);
    tag(0x6fffffffn, libraries.length);
    libraries.forEach(([library, names], i) => {
      buf.writeUInt16LE(1, table);
      buf.writeUInt16LE(names.length, table + 2);
      buf.writeUInt32LE(str(library), table + 4);
      buf.writeUInt32LE(16, table + 8);
      const size = 16 + names.length * 16;
      buf.writeUInt32LE(i === libraries.length - 1 ? 0 : size, table + 12);
      names.forEach((name, j) => {
        const aux = table + 16 + j * 16;
        buf.writeUInt32LE(str(name), aux + 8);
        buf.writeUInt32LE(j === names.length - 1 ? 0 : 16, aux + 12);
      });
      table += size;
    });
  }
  if (defines.length > 0) {
    // The BASE entry first, as a real library has it.
    const all = ['libthing.so', ...defines];
    tag(0x6ffffffcn, table);
    tag(0x6ffffffdn, all.length);
    all.forEach((name, i) => {
      buf.writeUInt16LE(1, table);
      buf.writeUInt16LE(i === 0 ? 1 : 0, table + 2);
      buf.writeUInt32LE(20, table + 12);
      buf.writeUInt32LE(i === all.length - 1 ? 0 : 28, table + 16);
      buf.writeUInt32LE(str(name), table + 20);
      table += 28;
    });
  }
  tag(0n, 0);
  header(176, 2, dynamic, entry - dynamic);
  return buf;
}

describe('checkAndroidBinary', () => {
  const bundled = { 'libssl.so.3': ['OPENSSL_3.0.0'], 'libcrypto.so.3': ['OPENSSL_3.0.0', 'OPENSSL_3.2.0'] };

  it('reads the loader and libraries the way the Termux binaries declare them', () => {
    const info = apt.checkAndroidBinary(elf({ needed: ['libssl.so.3', 'libcrypto.so.3', 'libdl.so', 'libm.so', 'libc.so'] }), 'codex', bundled);
    expect(info.interp).toBe('/system/bin/linker64');
    expect(info.needed).toEqual(['libssl.so.3', 'libcrypto.so.3', 'libdl.so', 'libm.so', 'libc.so']);
  });

  it('refuses what cannot run under Shelly', () => {
    expect(() => apt.checkAndroidBinary(elf({ type: 2 }), 'x', bundled)).toThrow(/not PIE/);
    expect(() => apt.checkAndroidBinary(elf({ machine: 62 }), 'x', bundled)).toThrow(/aarch64/);
    expect(() => apt.checkAndroidBinary(elf({ interp: '/lib/ld-musl-aarch64.so.1' }), 'x', bundled)).toThrow(/interpreter/);
    expect(() => apt.checkAndroidBinary(elf({ needed: ['libsqlite3.so'] }), 'x', bundled)).toThrow(/libsqlite3/);
    expect(() => apt.checkAndroidBinary(Buffer.from('#!/bin/sh'), 'x', bundled)).toThrow();
  });

  it('allows only libraries that exist on a device', () => {
    const extractor = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/LibExtractor.kt');
    const bionic = new Set(['libc.so', 'libdl.so', 'libm.so', 'liblog.so']);
    for (const name of apt.ALLOWED_NEEDED) {
      if (!bionic.has(name)) expect(extractor).toContain(`to "${name}"`);
    }
  });

  it('accepts required versions the bundled OpenSSL defines', () => {
    const binary = elf({
      needed: ['libssl.so.3', 'libcrypto.so.3', 'libc.so'],
      requires: { 'libssl.so.3': ['OPENSSL_3.0.0'], 'libcrypto.so.3': ['OPENSSL_3.0.0', 'OPENSSL_3.2.0'], 'libc.so': ['LIBC'] },
    });
    expect(apt.checkAndroidBinary(binary, 'codex', bundled).requiredVersions['libcrypto.so.3']).toEqual(['OPENSSL_3.0.0', 'OPENSSL_3.2.0']);
  });

  it('refuses a newer OPENSSL_3.x than the bundled copy, though the name loads', () => {
    const binary = elf({ needed: ['libcrypto.so.3', 'libc.so'], requires: { 'libcrypto.so.3': ['OPENSSL_3.0.0', 'OPENSSL_3.5.0'] } });
    expect(() => apt.checkAndroidBinary(binary, 'codex', bundled)).toThrow(/OPENSSL_3\.5\.0 from libcrypto\.so\.3/);
  });

  it('reads verdefs and leaves out the BASE entry', () => {
    expect(apt.readElfInfo(elf({ defines: ['OPENSSL_3.0.0', 'OPENSSL_3.3.0'] })).definedVersions).toEqual(['OPENSSL_3.0.0', 'OPENSSL_3.3.0']);
  });

  it('reads the real bundled libraries, which provide what Codex 0.167.0 asks for', () => {
    const versions = apt.bundledLibraryVersions();
    expect(versions['libssl.so.3']).toContain('OPENSSL_3.0.0');
    expect(versions['libcrypto.so.3']).toContain('OPENSSL_3.0.0');
  });
});

describe('arMembers', () => {
  const member = (name: string, body: Buffer) => {
    const header = Buffer.alloc(60, 0x20);
    header.write(`${name}/`, 0, 'latin1');
    header.write(String(body.length), 48, 'latin1');
    header.write('`\n', 58, 'latin1');
    return Buffer.concat([header, body, Buffer.alloc(body.length % 2, 0x0a)]);
  };

  it('splits an archive, including odd-sized padding', () => {
    const archive = Buffer.concat([
      Buffer.from('!<arch>\n'),
      member('debian-binary', Buffer.from('2.0\n')),
      member('control.tar.xz', Buffer.from('abc')),
      member('data.tar.xz', Buffer.from('xyz1')),
    ]);
    const members = apt.arMembers(archive);
    expect(members.get('control.tar.xz').toString()).toBe('abc');
    expect(members.get('data.tar.xz').toString()).toBe('xyz1');
  });

  it('rejects other files and truncated members', () => {
    expect(() => apt.arMembers(Buffer.from('not an archive'))).toThrow(/ar archive/);
    const truncated = Buffer.concat([Buffer.from('!<arch>\n'), member('a', Buffer.from('abcd'))]).subarray(0, 70);
    expect(() => apt.arMembers(truncated)).toThrow(/bad ar member/);
  });
});

describe('runBump', () => {
  let dir: string;
  let args: Record<string, string>;
  const candidate = () => JSON.parse(fs.readFileSync(args.candidate, 'utf8'));
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bump-'));
    args = { pin: path.join(dir, 'pin.json'), candidate: path.join(dir, 'candidate.json'), 'github-output': path.join(dir, 'out') };
    fs.writeFileSync(args.pin, JSON.stringify(pin('0.167.0')));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes a candidate and leaves the pin for after verification', async () => {
    const before = fs.readFileSync(args.pin, 'utf8');
    await apt.runBump(args, { resolve: async () => pin('0.168.0-1') });
    expect(candidate().version).toBe('0.168.0-1');
    expect(fs.readFileSync(args.pin, 'utf8')).toBe(before);
    expect(fs.readFileSync(args['github-output'], 'utf8')).toContain('changed=true');
  });

  it('hands on the pin itself when nothing moved, so a behind channel can still publish', async () => {
    await apt.runBump(args, { resolve: async () => pin('0.167.0') });
    expect(candidate().version).toBe('0.167.0');
    expect(fs.readFileSync(args['github-output'], 'utf8')).toContain('changed=false');
  });

  it('stops on a downgrade, and on a stale index, since nothing is pinned to fall back on', async () => {
    await expect(apt.runBump(args, { resolve: async () => pin('0.166.0') })).rejects.toBeInstanceOf(apt.TrustError);
    expect(fs.existsSync(args.candidate)).toBe(false);
  });
});

describe('runPromote', () => {
  let dir: string;
  let args: Record<string, string>;
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-promote-'));
    args = { channel: path.join(dir, 'c.json'), pin: path.join(dir, 'p.json'), 'codex-txt': path.join(dir, 't') };
    fs.writeFileSync(args.channel, JSON.stringify(pin('0.168.0-1')));
    fs.writeFileSync(args.pin, JSON.stringify(pin('0.167.0')));
    fs.writeFileSync(args['codex-txt'], '0.167.0\n');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('moves the bundled pin and codex.txt together', () => {
    apt.runPromote(args, { hasNpm: () => true });
    expect(() => apt.checkPinMatchesCodexTxt(JSON.parse(fs.readFileSync(args.pin, 'utf8')), fs.readFileSync(args['codex-txt'], 'utf8'))).not.toThrow();
    expect(fs.readFileSync(args['codex-txt'], 'utf8')).toBe('0.168.0\n');
  });

  it('refuses a version whose npm dispatcher the APK build could not install', () => {
    expect(() => apt.runPromote(args, { hasNpm: () => false })).toThrow(/npm/);
    expect(JSON.parse(fs.readFileSync(args.pin, 'utf8')).version).toBe('0.167.0');
  });
});

describe('workflows', () => {
  const android = read('.github/workflows/build-android.yml');
  const bump = read('.github/workflows/bump-codex-runtime.yml');

  it('have no fork left', () => {
    for (const yml of [android, bump]) {
      expect(yml).not.toContain('DioNanos');
      expect(yml).not.toContain('mmmbuto');
      expect(yml).not.toContain('codex.bin');
      expect(yml).not.toContain('codex-termux.txt');
      expect(yml).not.toMatch(/-termux\.(\d|\*)/);
    }
  });

  it('checks the pin instead of matching npm to a fork tag', () => {
    expect(android).toContain('codex-termux-apt.js check-pin');
    expect(android).not.toContain('must match codex-termux');
  });

  it('bundles through the verifying script, into the names LibExtractor reads', () => {
    expect(android).toContain('codex-termux-apt.js fetch');
    expect(android).toContain('"${JNILIBS}/libcodex_tui.so"');
    expect(android).toContain('"${JNILIBS}/libcodex_code_mode_host.so"');
  });

  it('does not publish the runtime from the APK build any more', () => {
    expect(android).not.toContain('CODEX_RUNTIME_TAG');
    expect(android).not.toContain('codex-runtime.tar.gz');
  });

  const stepOf = (name: string) => {
    const at = bump.indexOf(`- name: ${name}`);
    expect(at).toBeGreaterThan(0);
    const next = bump.indexOf('\n      - name:', at + 1);
    return bump.slice(at, next < 0 ? undefined : next);
  };

  it('never moves what the APK bundles and agents run', () => {
    expect(bump).toContain('PIN: .ci-versions/codex-termux-channel.json');
    expect(bump).not.toContain('CODEX_TXT');
    const commit = stepOf('Commit the new channel pin to main');
    expect(commit).toContain('git add "$PIN"\n');
    expect(commit).not.toContain('BUNDLED_PIN');
    expect(commit).not.toContain('codex.txt');
    expect(android).not.toContain('codex-termux-channel');
  });

  it('verifies and scans the candidate before any commit or upload', () => {
    const verify = bump.indexOf('- name: Verify the candidate');
    const commit = bump.indexOf('- name: Commit the new channel pin to main');
    const publish = bump.indexOf('- name: Publish the verified runtime');
    expect(verify).toBeGreaterThan(0);
    expect(verify).toBeLessThan(commit);
    expect(commit).toBeLessThan(publish);
    const step = stepOf('Verify the candidate');
    expect(step).toContain('codex-termux-apt.js fetch --pin "$candidate"');
    expect(step).toContain('release-safety-scan.js');
    expect(step).not.toContain('git ');
    expect(step).not.toContain('gh release');
    expect(bump.slice(0, verify)).not.toContain('git commit');
    expect(bump.slice(0, verify)).not.toContain('gh release upload');
  });

  it('commits and publishes only from main', () => {
    for (const name of ['Commit the new channel pin to main', 'Publish the verified runtime', 'Keep a copy of the bundled .deb']) {
      expect(stepOf(name)).toContain("github.ref == 'refs/heads/main'");
    }
  });

  it('publishes without an APK build, manifest last', () => {
    expect(bump).not.toContain('gh workflow run');
    const step = stepOf('Publish the verified runtime');
    const deb = step.indexOf('"$WORK/$DEB_NAME" --clobber');
    const tarball = step.indexOf('"$WORK/$ASSET"');
    const manifest = step.indexOf('"$WORK/out/$RUNTIME_MANIFEST" --clobber');
    expect(deb).toBeGreaterThan(0);
    expect(deb).toBeLessThan(tarball);
    expect(tarball).toBeLessThan(manifest);
  });

  it('decides on the channel, so a failed run heals, and verifies whenever it will commit or publish', () => {
    expect(stepOf('Compare the channel with the candidate')).toContain('codex-termux-apt.js published');
    expect(stepOf('Verify the candidate')).toContain("steps.resolve.outputs.changed == 'true' || steps.channel.outputs.state == 'behind'");
  });

  it('keeps the .deb of the bundled pin, which can sit behind the channel', () => {
    const step = stepOf('Keep a copy of the bundled .deb');
    expect(step).toContain('--pin "$BUNDLED_PIN"');
    expect(bump).not.toContain('gh release delete-asset');
  });

  it('leaves codex-runtime.json alone, which old APKs read', () => {
    expect(bump).toContain('RUNTIME_MANIFEST: codex-runtime-termux.json');
    expect(read('components/layout/BuildsModal.tsx')).toContain("CODEX_RUNTIME_MANIFEST_ASSET = 'codex-runtime-termux.json'");
    expect(android).not.toContain('codex-runtime.json');
  });
});

describe('reading the installed Termux revision on the Builds screen', () => {
  const hasBash = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim() === 'ok';
  (hasBash ? it : it.skip)('gets codexTermuxVersion out of a real manifest through the shell string', () => {
    const line = read('components/layout/BuildsModal.tsx').split(/\r?\n/).find((l) => l.includes('termux="$(/system/bin/toybox sed'));
    const shell: string = eval(line!.trim().replace(/,$/, ''));
    const command = shell.match(/termux="(\$\(.*\))"; fi$/)![1].split('/system/bin/toybox ').join('');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-manifest-'));
    try {
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: '0.167.0', codexTermuxVersion: '0.167.0-1' }, null, 2));
      const out = spawnSync('bash', ['-c', `runtime=.; echo ${command}`], { cwd: dir, encoding: 'utf8' });
      expect(out.stdout.trim()).toBe('0.167.0-1');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stale fork text', () => {
  it('is gone from the in-app assistant and the READMEs', () => {
    expect(read('lib/ask-context.ts')).not.toContain('DioNanos');
    expect(read('README.md')).not.toContain('does not use Termux\n  packages');
    expect(read('README.ja.md')).not.toContain('Termux のパッケージも、');
  });
});

describe('device install', () => {
  const modal = read('components/layout/BuildsModal.tsx');
  const updater = read('modules/terminal-emulator/android/src/main/assets/shelly-runtime-update.js');

  it('requires the host and the worker-facing commands before promoting', () => {
    expect(modal).toContain('for name in codex_tui codex-code-mode-host;');
    expect(modal.indexOf('app-server --help)')).toBeGreaterThan(0);
    expect(modal.indexOf('app-server --help)')).toBeLessThan(modal.indexOf('final_dir="$versions_dir/$install_id"'));
    expect(modal.indexOf('mcp list --json)')).toBeLessThan(modal.indexOf('"$toybox" mv "$next_link" "$current_link"'));
    expect(updater).toContain("['codex_tui', 'codex-code-mode-host']");
    expect(updater.indexOf("['mcp', 'list', '--json']")).toBeLessThan(updater.indexOf('fs.renameSync(nextLink, currentLink)'));
  });

  it('probes with a throwaway CODEX_HOME, never the user\'s', () => {
    expect(modal).toContain('CODEX_HOME="$probe_home"');
    expect(updater).toContain('codexHome: probeHome');
  });

  it('keeps the on-device layout: codex_tui, manifest.json, .healthy under versions/', () => {
    for (const marker of ['"$staging/manifest.json"', '> "$staging/.healthy"', 'final_dir="$versions_dir/$install_id"']) {
      expect(modal).toContain(marker);
    }
    expect(read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/LibExtractor.kt'))
      .toContain('"lib/arm64-v8a/libcodex_tui.so" to "codex_tui"');
  });
});

describe('doctor', () => {
  it('probes Codex with the launchers\' environment', () => {
    const doctor = read('modules/terminal-emulator/android/src/main/assets/shelly-doctor.js');
    expect(doctor).toContain("LD_PRELOAD: path.join(LIB, 'libexec_wrapper.so')");
    const probe = doctor.slice(doctor.indexOf('function runVersion'), doctor.indexOf('function securityReport'));
    expect(probe).not.toContain('delete env.LD_PRELOAD');
  });
});

describe('codexRuntimeUpdateAvailable', () => {
  const { codexRuntimeUpdateAvailable: available } = require('../lib/codex-runtime-update');
  const channel = (version: string, codexTermuxVersion = version) => ({ version, codexTermuxVersion });

  it('offers a newer upstream version and never an older one', () => {
    expect(available(channel('0.168.0'), { version: '0.167.0', source: 'runtime' })).toBe(true);
    expect(available(channel('0.166.0-3'), { version: '0.167.0', source: 'runtime' })).toBe(false);
  });

  it('offers a Termux revision although --version is unchanged', () => {
    expect(available(channel('0.167.0', '0.167.0-1'), { version: '0.167.0', source: 'runtime', termuxVersion: '0.167.0' })).toBe(true);
    expect(available(channel('0.167.0', '0.167.0-10'), { version: '0.167.0', source: 'runtime', termuxVersion: '0.167.0-9' })).toBe(true);
  });

  it('stays quiet on the same revision', () => {
    expect(available(channel('0.167.0', '0.167.0-1'), { version: '0.167.0', source: 'runtime', termuxVersion: '0.167.0-1' })).toBe(false);
    expect(available(channel('0.167.0'), { version: '0.167.0', source: 'bundled' })).toBe(false);
  });

  it('treats a bundled Codex as revision 0, and ignores a broken runtime manifest', () => {
    expect(available(channel('0.167.0', '0.167.0-1'), { version: '0.167.0', source: 'bundled' })).toBe(true);
    expect(available(channel('0.167.0', '0.167.0-1'), { version: '0.167.0', source: 'runtime_broken', termuxVersion: '0.167.0-1' })).toBe(true);
  });
});
