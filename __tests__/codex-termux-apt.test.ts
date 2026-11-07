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
    expect(() => apt.verifyInRelease(tampered)).toThrow(apt.TrustError);
  });

  it('refuses a file with no signature', () => {
    expect(() => apt.verifyInRelease(Buffer.from('Suite: stable\n'))).toThrow(apt.TrustError);
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

  it('lets the signed index contradict the pin, but not stop a build when it is only down or ahead', async () => {
    const resolve = (entry: unknown) => ({ mirrors: [], get: async () => Buffer.alloc(0), verify: () => '', entry });
    await expect(apt.confirmPinAgainstIndex(pin(), resolve(null))).resolves.toBe('unavailable');
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

/** A minimal ELF64: one PT_LOAD over the file, PT_INTERP, PT_DYNAMIC. */
function elf({ type = 3, machine = 183, interp = '/system/bin/linker64', needed = ['libc.so'] } = {}) {
  const buf = Buffer.alloc(1024);
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
  header(64, 1, 0, 1024);
  const interpAt = 300;
  buf.write(`${interp}\0`, interpAt, 'latin1');
  header(120, 3, interpAt, interp.length + 1);
  const strtab = 400;
  const dynamic = 700;
  let cursor = 1;
  let entry = dynamic;
  for (const name of needed) {
    buf.write(`${name}\0`, strtab + cursor, 'latin1');
    buf.writeBigInt64LE(1n, entry);
    buf.writeBigUInt64LE(BigInt(cursor), entry + 8);
    entry += 16;
    cursor += name.length + 1;
  }
  buf.writeBigInt64LE(5n, entry);
  buf.writeBigUInt64LE(BigInt(strtab), entry + 8);
  entry += 16;
  header(176, 2, dynamic, entry + 16 - dynamic);
  return buf;
}

describe('checkAndroidBinary', () => {
  it('reads the loader and libraries the way the Termux binaries declare them', () => {
    const info = apt.checkAndroidBinary(elf({ needed: ['libssl.so.3', 'libcrypto.so.3', 'libdl.so', 'libm.so', 'libc.so'] }), 'codex');
    expect(info.interp).toBe('/system/bin/linker64');
    expect(info.needed).toEqual(['libssl.so.3', 'libcrypto.so.3', 'libdl.so', 'libm.so', 'libc.so']);
  });

  it('refuses what cannot run under Shelly', () => {
    expect(() => apt.checkAndroidBinary(elf({ type: 2 }), 'x')).toThrow(/not PIE/);
    expect(() => apt.checkAndroidBinary(elf({ machine: 62 }), 'x')).toThrow(/aarch64/);
    expect(() => apt.checkAndroidBinary(elf({ interp: '/lib/ld-musl-aarch64.so.1' }), 'x')).toThrow(/interpreter/);
    expect(() => apt.checkAndroidBinary(elf({ needed: ['libsqlite3.so'] }), 'x')).toThrow(/libsqlite3/);
    expect(() => apt.checkAndroidBinary(Buffer.from('#!/bin/sh'), 'x')).toThrow();
  });

  it('allows only libraries that exist on a device', () => {
    const extractor = read('modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/LibExtractor.kt');
    const bionic = new Set(['libc.so', 'libdl.so', 'libm.so', 'liblog.so']);
    for (const name of apt.ALLOWED_NEEDED) {
      if (!bionic.has(name)) expect(extractor).toContain(`to "${name}"`);
    }
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
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-bump-'));
    args = { pin: path.join(dir, 'pin.json'), 'codex-txt': path.join(dir, 'codex.txt'), 'github-output': path.join(dir, 'out') };
    fs.writeFileSync(args.pin, JSON.stringify(pin('0.167.0')));
    fs.writeFileSync(args['codex-txt'], '0.167.0\n');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the pin and codex.txt together on a new version', async () => {
    await apt.runBump(args, { resolve: async () => pin('0.168.0-1'), hasNpm: () => true });
    expect(JSON.parse(fs.readFileSync(args.pin, 'utf8')).version).toBe('0.168.0-1');
    expect(fs.readFileSync(args['codex-txt'], 'utf8')).toBe('0.168.0\n');
    expect(fs.readFileSync(args['github-output'], 'utf8')).toContain('changed=true');
  });

  it('leaves the files alone when nothing moved', async () => {
    const before = fs.readFileSync(args.pin, 'utf8');
    await apt.runBump(args, { resolve: async () => pin('0.167.0'), hasNpm: () => true });
    expect(fs.readFileSync(args.pin, 'utf8')).toBe(before);
    expect(fs.readFileSync(args['github-output'], 'utf8')).toContain('changed=false');
  });

  it('holds the bump until the npm dispatcher of that version exists', async () => {
    await apt.runBump(args, { resolve: async () => pin('0.168.0'), hasNpm: () => false });
    expect(JSON.parse(fs.readFileSync(args.pin, 'utf8')).version).toBe('0.167.0');
    expect(fs.readFileSync(args['github-output'], 'utf8')).toContain('changed=false');
  });

  it('stops on a downgrade instead of writing it', async () => {
    await expect(apt.runBump(args, { resolve: async () => pin('0.166.0'), hasNpm: () => true })).rejects.toBeInstanceOf(apt.TrustError);
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

  it('publishes without an APK build, safety-scanned, manifest last', () => {
    expect(bump).not.toContain('gh workflow run');
    const scan = bump.indexOf('release-safety-scan.js');
    const deb = bump.indexOf('"$work/$deb_name" --clobber');
    const tarball = bump.indexOf('"$RUNTIME_TAG" --repo "$GITHUB_REPOSITORY" "$work/$asset"');
    const manifest = bump.indexOf('"$work/$RUNTIME_MANIFEST" --clobber');
    expect(scan).toBeGreaterThan(0);
    expect(scan).toBeLessThan(deb);
    expect(deb).toBeLessThan(tarball);
    expect(tarball).toBeLessThan(manifest);
  });

  it('publishes by comparing the channel with the pin, so a failed run heals', () => {
    const step = bump.slice(bump.indexOf('- name: Publish the pinned runtime'));
    expect(step.slice(0, step.indexOf('run: |'))).not.toContain('if:');
    expect(step).toContain('codex-termux-apt.js published');
  });

  it('leaves codex-runtime.json alone, which old APKs read', () => {
    expect(bump).toContain('RUNTIME_MANIFEST: codex-runtime-termux.json');
    expect(read('components/layout/BuildsModal.tsx')).toContain("CODEX_RUNTIME_MANIFEST_ASSET = 'codex-runtime-termux.json'");
    expect(android).not.toContain('codex-runtime.json');
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
