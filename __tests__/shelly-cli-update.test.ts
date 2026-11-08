/**
 * scripts/shelly-cli-update.js: the device-side installer for Claude Code and the
 * Antigravity CLI (plan 2026-11-07, sections 4 to 6).
 *
 * Everything runs against a temporary HOME with fake network and probes. The
 * real vendor files were checked by hand on 2026-11-07, which no test here can
 * repeat without the network; the keys and the reviewed pin are held below.
 */
import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const update = require('../scripts/shelly-cli-update.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const driver = require('../scripts/shelly-agent-driver.js');

const root = path.join(__dirname, '..');
const homeKt = fs.readFileSync(
  path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt'),
  'utf8',
);
const source = fs.readFileSync(path.join(root, 'scripts/shelly-cli-update.js'), 'utf8');

// ─── OpenPGP fixtures ───────────────────────────────────────────────────────

function pgpPacket(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0xc0 | tag, 0xff, 0, 0, body.length >> 8, body.length & 0xff]), body]);
}

function mpi(value: Buffer): Buffer {
  let start = 0;
  while (value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const bits = trimmed.length * 8 - Math.clz32(trimmed[0]) + 24;
  const head = Buffer.alloc(2);
  head.writeUInt16BE(bits);
  return Buffer.concat([head, trimmed]);
}

function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const body = Buffer.concat([
    Buffer.from([4, 0, 0, 0, 0, 1]),
    mpi(Buffer.from(jwk.n, 'base64url')),
    mpi(Buffer.from(jwk.e, 'base64url')),
  ]);
  const prefix = Buffer.from([0x99, body.length >> 8, body.length & 0xff]);
  const fingerprint = crypto.createHash('sha1').update(prefix).update(body).digest('hex').toUpperCase();
  return { keyBytes: pgpPacket(6, body), fingerprint, privateKey };
}

function sign(data: Buffer, key: ReturnType<typeof makeKey>, sigClass = 0, issuer = key.fingerprint): Buffer {
  const issuerSub = Buffer.concat([Buffer.from([22, 33, 4]), Buffer.from(issuer, 'hex')]);
  const head = Buffer.from([4, sigClass, 1, 10, 0, issuerSub.length]);
  const hashed = Buffer.concat([head, issuerSub]);
  const trailer = Buffer.alloc(6);
  trailer[0] = 4;
  trailer[1] = 0xff;
  trailer.writeUInt32BE(hashed.length, 2);
  const material = Buffer.concat([data, hashed, trailer]);
  const digest = crypto.createHash('sha512').update(material).digest();
  const signature = crypto.sign('sha512', material, key.privateKey);
  return pgpPacket(2, Buffer.concat([hashed, Buffer.from([0, 0]), digest.subarray(0, 2), mpi(signature)]));
}

function armor(sig: Buffer): string {
  return `-----BEGIN PGP SIGNATURE-----\n\n${sig.toString('base64')}\n=AAAA\n-----END PGP SIGNATURE-----`;
}

function clearsign(lines: string[], key: ReturnType<typeof makeKey>): string {
  const canonical = Buffer.from(lines.map((line) => line.replace(/[ \t]+$/, '')).join('\r\n'));
  const escaped = lines.map((line) => (line.startsWith('-') ? `- ${line}` : line));
  return ['-----BEGIN PGP SIGNED MESSAGE-----', 'Hash: SHA512', '', ...escaped, armor(sign(canonical, key, 1)), ''].join('\n');
}

const claudeKey = makeKey();
const termuxKey = makeKey();

// ─── Pins ───────────────────────────────────────────────────────────────────

describe('what is pinned', () => {
  it('the embedded Anthropic key has the documented fingerprint', () => {
    const key = update.parseRsaPublicKey(update.decodeArmor(update.CLAUDE_KEY));
    expect(key.fingerprint).toBe('31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE');
  });

  it('the embedded Termux key is scripts/termux-autobuilds.gpg', () => {
    const bytes = fs.readFileSync(path.join(root, 'scripts/termux-autobuilds.gpg'));
    expect(Buffer.from(update.TERMUX_KEY_BASE64, 'base64').equals(bytes)).toBe(true);
    expect(update.parseRsaPublicKey(bytes).fingerprint).toBe(update.TERMUX_KEY_FINGERPRINT);
  });

  it('the installer and the driver name the same reviewed Claude build', () => {
    expect(update.REVIEWED_CLAUDE).toEqual(driver.CLAUDE_AGENT_REVIEWED);
  });

  it('the asset is byte-identical to its scripts/ source', () => {
    const asset = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-cli-update.js'), 'utf8');
    expect(asset).toBe(source);
  });
});

// ─── Signatures ─────────────────────────────────────────────────────────────

describe('detached signatures', () => {
  const data = Buffer.from('{"version":"1.2.3"}');
  const verify = (bytes: Buffer, sig: Buffer, key = claudeKey) =>
    update.verifyDetached(bytes, sig, key.keyBytes, key.fingerprint);

  it('accepts a good signature, raw or armored', () => {
    expect(() => verify(data, sign(data, claudeKey))).not.toThrow();
    expect(() => verify(data, Buffer.from(armor(sign(data, claudeKey))))).not.toThrow();
  });

  it('rejects a corrupted signature', () => {
    const sig = sign(data, claudeKey);
    sig[sig.length - 1] ^= 1;
    expect(() => verify(data, sig)).toThrow(update.TrustError);
  });

  it('rejects changed data', () => {
    expect(() => verify(Buffer.from('{"version":"9.9.9"}'), sign(data, claudeKey))).toThrow(update.TrustError);
  });

  it('rejects a signature from another key', () => {
    expect(() => verify(data, sign(data, termuxKey), claudeKey)).toThrow(update.TrustError);
  });

  it('rejects a pinned key that does not match its fingerprint', () => {
    expect(() => update.verifyDetached(data, sign(data, claudeKey), claudeKey.keyBytes, termuxKey.fingerprint))
      .toThrow(/fingerprint/);
  });

  it('rejects anything beside the one signature packet', () => {
    const sig = sign(data, claudeKey);
    expect(() => verify(data, Buffer.concat([sig, sig]))).toThrow(/exactly one/);
  });

  it('rejects a text-mode signature over a binary file', () => {
    expect(() => verify(data, sign(data, claudeKey, 1))).toThrow(/signature type/);
  });
});

describe('clearsigned InRelease', () => {
  const lines = ['Origin: termux-glibc glibc', 'Suite: glibc', '-dashed line', 'trailing   '];
  const verify = (text: string) => update.verifyClearsigned(text, termuxKey.keyBytes, termuxKey.fingerprint);

  it('returns the signed text, undashed', () => {
    expect(verify(clearsign(lines, termuxKey)).split('\n')).toEqual(lines);
  });

  it('rejects a changed line', () => {
    expect(() => verify(clearsign(lines, termuxKey).replace('Suite: glibc', 'Suite: other'))).toThrow(update.TrustError);
  });

  it('rejects text after the signature: it would be unsigned', () => {
    expect(() => verify(`${clearsign(lines, termuxKey)}SHA256:\n evil\n`)).toThrow(/after the signature/);
  });

  it('rejects text before the block', () => {
    expect(() => verify(`Suite: evil\n${clearsign(lines, termuxKey)}`)).toThrow(/not a clearsigned/);
  });
});

// ─── Manifests ──────────────────────────────────────────────────────────────

function claudeManifest(version: string, body: Buffer, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    version,
    platforms: {
      'linux-arm64': {
        binary: 'claude',
        checksum: crypto.createHash('sha256').update(body).digest('hex'),
        size: body.length,
      },
      ...extra,
    },
  }));
}

describe('the signed Claude manifest', () => {
  const body = Buffer.from('binary');
  const read = (manifest: Buffer, version = '1.2.3') => update.readClaudeManifest(
    manifest, sign(manifest, claudeKey), version, { keyBytes: claudeKey.keyBytes, fingerprint: claudeKey.fingerprint },
  );

  it('gives the checksum and size', () => {
    expect(read(claudeManifest('1.2.3', body))).toEqual({
      sha256: crypto.createHash('sha256').update(body).digest('hex'),
      size: body.length,
    });
  });

  it('refuses a validly signed manifest for another version (replay)', () => {
    expect(() => read(claudeManifest('1.2.2', body))).toThrow(/expected 1\.2\.3/);
  });

  it('refuses a missing platform or a bad checksum', () => {
    expect(() => read(Buffer.from(JSON.stringify({ version: '1.2.3', platforms: {} })))).toThrow(/checksum/);
    expect(() => read(claudeManifest('1.2.3', body, { 'linux-arm64': { checksum: 'nothex', size: 1 } }))).toThrow(/checksum/);
  });

  it('refuses a size over the cap', () => {
    const huge = { 'linux-arm64': { checksum: 'a'.repeat(64), size: 5 * 1024 * 1024 * 1024 } };
    expect(() => read(claudeManifest('1.2.3', body, huge))).toThrow(/size/);
  });
});

describe('the Antigravity manifest', () => {
  const sha512 = 'a'.repeat(128);
  const url = 'https://storage.googleapis.com/antigravity-public/1.5.2/cli_android_arm64.tar.gz';

  it('accepts Google storage only', () => {
    expect(update.readAgyManifest(JSON.stringify({ version: '1.5.2', url, sha512 })).version).toBe('1.5.2');
    expect(() => update.readAgyManifest(JSON.stringify({ version: '1.5.2', url: 'https://evil.example/a', sha512 }))).toThrow(/URL/);
    expect(() => update.readAgyManifest(JSON.stringify({ version: '1.5.2', url: `${url}/../../x`, sha512 }))).toThrow(/URL/);
    expect(() => update.readAgyManifest(JSON.stringify({ version: '1.5.2', url: 'http://storage.googleapis.com/antigravity-public/a', sha512 }))).toThrow(/URL/);
  });

  it('judges the URL as the server would read it, not as text', () => {
    const base = 'https://storage.googleapis.com/antigravity-public';
    for (const bad of [
      `${base}/%2e%2e/other-bucket/evil`,
      `${base}/%2E%2E/%2e%2e/evil`,
      `${base}/a%2fb`,
      `${base}/.%2e/evil`,
      'https://storage.googleapis.com.evil.example/antigravity-public/a',
      'https://user@storage.googleapis.com/antigravity-public/a',
      'https://storage.googleapis.com:8443/antigravity-public/a',
      `${base}/a?x=1`,
      `${base}/a#b`,
      'https://storage.googleapis.com/antigravity-publicity/a',
      'HTTPS://STORAGE.GOOGLEAPIS.COM/antigravity-public/a',
    ]) {
      expect(() => update.readAgyManifest(JSON.stringify({ version: '1.5.2', url: bad, sha512 }))).toThrow(/URL/);
    }
    expect(() => update.readAgyManifest(JSON.stringify({ version: '1.5.2', url: 7, sha512 }))).toThrow(/URL/);
  });

  it('wants a whole SHA-512 and a plain version', () => {
    expect(() => update.readAgyManifest(JSON.stringify({ version: '1.5.2', url, sha512: 'abc' }))).toThrow(/sha512/);
    expect(() => update.readAgyManifest(JSON.stringify({ version: '../1', url, sha512 }))).toThrow(/version/);
  });
});

// ─── Archives ───────────────────────────────────────────────────────────────

function tarHeader(name: string, type: string, size: number, link = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(link, 157, 100);
  h.write('ustar\0', 257);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

function tarFile(name: string, data: string | Buffer, type = '0'): Buffer {
  const body = Buffer.from(data);
  return Buffer.concat([tarHeader(name, type, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

function tar(...parts: Buffer[]): Buffer {
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

const LIB = 'data/data/com.termux/files/usr/glibc/lib/';

describe('where the network may go', () => {
  it('allows the vendors\' hosts over https, for requests and redirects alike', () => {
    expect(update.checkFetchUrl('https://downloads.claude.ai/claude-code-releases/latest').hostname).toBe('downloads.claude.ai');
    expect(update.checkFetchUrl('https://packages-cf.termux.dev/apt/x').hostname).toBe('packages-cf.termux.dev');
  });

  it('refuses everything else', () => {
    for (const bad of [
      'http://downloads.claude.ai/x',
      'https://evil.example/x',
      'https://downloads.claude.ai.evil.example/x',
      'https://downloads.claude.ai:8443/x',
      'https://u:p@downloads.claude.ai/x',
      'https://127.0.0.1/x',
    ]) {
      expect(() => update.checkFetchUrl(bad)).toThrow(update.TrustError);
    }
  });
});

describe('redirects', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https');
  const answer = (location: string) => (_url: unknown, _options: unknown, callback: (response: unknown) => void) => {
    callback({ statusCode: 302, headers: { location }, resume() {} });
    return { setTimeout() {}, on() {}, destroy() {} };
  };
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['another host', 'https://evil.example/claude'],
    ['plain http', 'http://downloads.claude.ai/claude'],
    ['a bad location', 'https://'],
  ])('%s is a trust failure', async (_name, location) => {
    jest.spyOn(https, 'get').mockImplementation(answer(location) as never);
    await expect(update.fetchBytes('https://downloads.claude.ai/x', 1024)).rejects.toThrow(update.TrustError);
  });

  it('a redirect loop is a trust failure', async () => {
    jest.spyOn(https, 'get').mockImplementation(answer('https://downloads.claude.ai/again') as never);
    await expect(update.fetchBytes('https://downloads.claude.ai/x', 1024)).rejects.toThrow(/too many redirects/);
    await expect(update.fetchBytes('https://downloads.claude.ai/x', 1024)).rejects.toThrow(update.TrustError);
  });

  it('a download sent elsewhere installs nothing and holds the version', async () => {
    const world = makeWorld();
    try {
      world.stageLib();
      world.addClaude('2.1.320', claudeBody('320'));
      world.setChannel('latest', '2.1.320');
      (world.ctx as { downloadTo: unknown }).downloadTo = update.downloadTo;
      jest.spyOn(https, 'get').mockImplementation(answer('https://evil.example/claude') as never);
      await expect(update.install(world.ctx, 'claude')).rejects.toThrow(update.TrustError);
      expect(world.current()).toBeNull();
      expect(world.state().failed['2.1.320']).toMatchObject({ stage: 'trust', hold: true });
    } finally {
      world.cleanup();
    }
  });
});

describe('tar', () => {
  it('stops at any path that climbs out, wanted or not', () => {
    expect(() => update.readTar(tar(tarFile('../../.bashrc', 'x')))).toThrow(/unsafe path/);
    expect(() => update.readTar(tar(tarFile('./a/../../b', 'x')))).toThrow(/unsafe path/);
    expect(() => update.readTar(tar(tarFile('/etc/passwd', 'x')))).toThrow(/unsafe path/);
  });

  it('stops at a traversal hidden in a pax or GNU long name', () => {
    const record = (text: string) => {
      let len = text.length + 4;
      len = `${len} ${text}\n`.length;
      return `${len} ${text}\n`;
    };
    expect(() => update.readTar(tar(tarFile('x', record('path=../../evil'), 'x'), tarFile('fine', 'x')))).toThrow(/unsafe path/);
    expect(() => update.readTar(tar(tarFile('L', '../../evil', 'L'), tarFile('fine', 'x')))).toThrow(/unsafe path/);
  });

  it('rejects a corrupt header and a truncated entry', () => {
    const bad = tar(tarFile('a', 'x'));
    bad[0] ^= 1;
    expect(() => update.readTar(bad)).toThrow(/checksum/);
    expect(() => update.readTar(tarFile('a', Buffer.alloc(2000)).subarray(0, 1024))).toThrow(/truncated/);
  });

  it('turns a link into a copy, and refuses one that leaves the directory', () => {
    const pick = (...parts: Buffer[]) => update.selectTarFiles(update.readTar(tar(...parts)), LIB, () => true);
    const real = tarFile(`${LIB}libreal.so.1`, 'real');
    const files = pick(real, tarHeader(`${LIB}liblink.so.1`, '2', 0, 'libreal.so.1'));
    expect(files.get('liblink.so.1').toString()).toBe('real');
    expect(() => pick(real, tarHeader(`${LIB}liblink.so.1`, '2', 0, '../../../etc/passwd'))).toThrow(/leaves/);
    expect(() => pick(real, tarHeader(`${LIB}liblink.so.1`, '2', 0, '/etc/passwd'))).toThrow(/leaves/);
    expect(() => pick(real, tarHeader(`${LIB}liblink.so.1`, '1', 0, 'other/place/libreal.so.1'))).toThrow(/leaves/);
    expect(() => pick(tarHeader(`${LIB}liblink.so.1`, '2', 0, 'gone.so'))).toThrow(/dangling/);
  });
});

describe('xz', () => {
  const xz = Buffer.from(fs.readFileSync(path.join(__dirname, 'fixtures/cli-update-glibc.tar.xz.b64'), 'utf8'), 'base64');

  it('decodes real xz output', () => {
    const files = update.selectTarFiles(update.readTar(update.decodeXz(xz)), LIB, (name: string) => name.endsWith('.so.6'));
    expect([...files.keys()].sort()).toEqual(['libc.so.6', 'libm.so.6', 'libstdc++.so.6']);
    expect(files.get('libm.so.6').toString()).toContain('shelly fixture library shelly fixture library');
  });

  it('refuses other formats, truncation and a too-large output', () => {
    expect(() => update.decodeXz(Buffer.alloc(100))).toThrow(/not an xz/);
    expect(() => update.decodeXz(xz.subarray(0, 60))).toThrow(update.TrustError);
    expect(() => update.decodeXz(xz, 1000)).toThrow(/size limit/);
  });

  it('refuses a filter it does not implement', () => {
    const changed = Buffer.from(xz);
    changed[12 + 2] = 0x0a; // Block header's filter id: ARM64 BCJ.
    expect(() => update.decodeXz(changed)).toThrow(/filter/);
  });
});

function minimalElf(type: number, interp: string | null): Buffer {
  const name = interp ? Buffer.from(`${interp}\0`) : Buffer.alloc(0);
  const elf = Buffer.alloc(256 + name.length);
  elf.writeUInt32BE(0x7f454c46, 0);
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(type, 16);
  elf.writeUInt16LE(183, 18);
  elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(interp ? 1 : 0, 56);
  if (interp) {
    elf.writeUInt32LE(3, 64);
    elf.writeBigUInt64LE(256n, 72);
    elf.writeBigUInt64LE(BigInt(name.length), 96);
    name.copy(elf, 256);
  }
  return elf;
}

describe('ELF check', () => {
  it('reads the interpreter without running anything', () => {
    expect(update.elfInfo(minimalElf(3, '/system/bin/linker64'))).toEqual({ type: 3, interp: '/system/bin/linker64' });
  });

  it('refuses other machines and non-ELF data', () => {
    const x86 = minimalElf(3, null);
    x86.writeUInt16LE(62, 18);
    expect(() => update.elfInfo(x86)).toThrow(/aarch64/);
    expect(() => update.elfInfo(Buffer.alloc(100))).toThrow(/not an ELF/);
  });
});

// ─── The update decision ────────────────────────────────────────────────────

describe('decideUpdate', () => {
  const now = 1_000_000;

  it('installs a newer version, and a first install', () => {
    expect(update.decideUpdate({ target: '2.1.320', installed: '2.1.319', now }).install).toBe(true);
    expect(update.decideUpdate({ target: '2.1.320', installed: null, now }).install).toBe(true);
    expect(update.decideUpdate({ target: '2.10.0', installed: '2.9.9', now }).install).toBe(true);
  });

  it('refuses to go backwards (manifest rollback), unless a person forces it', () => {
    expect(update.decideUpdate({ target: '2.1.311', installed: '2.1.319', now })).toEqual({ install: false, reason: 'older' });
    expect(update.decideUpdate({ target: '2.1.311', installed: '2.1.319', now, force: true }).install).toBe(true);
  });

  it('holds and cools down failed versions', () => {
    const state: Record<string, never> = {};
    update.recordFailure(state, '2.1.320', 'version', 'exit 1', now);
    const failed = (state as unknown as { failed: Record<string, unknown> }).failed;
    expect(update.decideUpdate({ target: '2.1.320', installed: '2.1.319', failure: failed['2.1.320'], now }).reason).toBe('cooldown');
    expect(update.decideUpdate({ target: '2.1.320', installed: '2.1.319', failure: failed['2.1.320'], now: now + 25 * 3600 * 1000 }).install).toBe(true);
    update.recordFailure(state, '2.1.320', 'version', 'exit 1', now);
    expect(update.decideUpdate({ target: '2.1.320', installed: '2.1.319', failure: failed['2.1.320'], now: now + 48 * 3600 * 1000 }).reason).toBe('held');
    expect(update.decideUpdate({ target: '2.1.320', installed: '2.1.319', failure: failed['2.1.320'], now, force: true }).install).toBe(true);
  });

  it('holds a trust failure at once', () => {
    const state: { failed?: Record<string, { hold: boolean }> } = {};
    update.recordFailure(state, '2.1.320', 'trust', 'bad signature', now);
    expect(state.failed!['2.1.320'].hold).toBe(true);
  });

  it('selects the channel, and only known ones', () => {
    expect(update.claudeChannelUrl('latest')).toMatch(/claude-code-releases\/latest$/);
    expect(update.claudeChannelUrl('stable')).toMatch(/claude-code-releases\/stable$/);
    expect(() => update.claudeChannelUrl('nightly')).toThrow(/unknown channel/);
    expect(() => update.claudeChannelUrl('../latest')).toThrow(/unknown channel/);
  });
});

// ─── Installing, against a fake network ─────────────────────────────────────

const CLAUDE_BASE = 'https://downloads.claude.ai/claude-code-releases';
const AGY_MANIFEST = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json';

function debFor(xz: Buffer): Buffer {
  const member = (name: string, data: Buffer) => {
    const header = Buffer.alloc(60, 0x20);
    header.write(`${name}/`, 0);
    header.write(String(data.length), 48);
    header.write('`\n', 58);
    return Buffer.concat([header, data, Buffer.alloc(data.length & 1, 10)]);
  };
  return Buffer.concat([Buffer.from('!<arch>\n'), member('debian-binary', Buffer.from('2.0\n')), member('data.tar.xz', xz)]);
}

type Options = { reviewed?: { version: string; sha256: string; size: number } };

function makeWorld(options: Options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-cli-update-'));
  const routes = new Map<string, Buffer>();
  const failures = new Set<string>();
  const probes: string[] = [];
  const inUse = new Set<string>();
  let probeResult: (binary: string) => unknown = () => ({ ok: true, version: world.probeVersion });
  const world = {
    home,
    routes,
    failures,
    probes,
    inUse,
    probeVersion: '2.1.320',
    now: 1_800_000_000_000,
    setProbe(fn: (binary: string) => unknown) {
      probeResult = fn;
    },
    ctx: {} as Record<string, unknown>,
    addClaude(version: string, body: Buffer) {
      const manifest = claudeManifest(version, body);
      routes.set(`${CLAUDE_BASE}/${version}/manifest.json`, manifest);
      routes.set(`${CLAUDE_BASE}/${version}/manifest.json.sig`, sign(manifest, claudeKey));
      routes.set(`${CLAUDE_BASE}/${version}/linux-arm64/claude`, body);
    },
    setChannel(channel: string, version: string) {
      routes.set(`${CLAUDE_BASE}/${channel}`, Buffer.from(`${version}\n`));
    },
    stageLib() {
      const lib = path.join(home, '.shelly-runtime/claude-glibc/lib');
      fs.mkdirSync(lib, { recursive: true });
      for (const name of update.GLIBC_REQUIRED) fs.writeFileSync(path.join(lib, name), 'x');
    },
    paths(cli: 'claude' | 'agy') {
      return update.cliPaths(world.ctx, cli);
    },
    current(cli: 'claude' | 'agy' = 'claude') {
      const dir = update.linkedVersion(world.paths(cli), world.paths(cli).current);
      return dir ? path.basename(dir).split('-')[0] : null;
    },
    state(cli: 'claude' | 'agy' = 'claude') {
      return JSON.parse(fs.readFileSync(world.paths(cli).state, 'utf8'));
    },
    cleanup() {
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
  world.ctx = {
    home,
    lib: '/fake/lib',
    now: () => world.now,
    log: () => {},
    fetchBytes: async (url: string, cap: number) => {
      if (failures.has(url) || !routes.has(url)) throw new Error(`no route: ${url}`);
      const body = routes.get(url)!;
      if (body.length > cap) throw new update.TrustError('over the limit');
      return body;
    },
    downloadTo: async (url: string, file: string, cap: number, algorithm: string) => {
      if (!routes.has(url)) throw new Error(`no route: ${url}`);
      const body = routes.get(url)!;
      if (body.length > cap) throw new update.TrustError('over the limit');
      fs.writeFileSync(file, body);
      return { size: body.length, hash: crypto.createHash(algorithm).update(body).digest('hex') };
    },
    probeClaude: (_ctx: unknown, binary: string) => {
      probes.push(binary);
      return probeResult(binary);
    },
    freeBytes: () => 10 * 1024 ** 3,
    inUseElsewhere: (dir: string) => [...inUse].some((name) => dir.includes(name)),
    claudeKey: claudeKey.keyBytes,
    claudeFingerprint: claudeKey.fingerprint,
    termuxKey: termuxKey.keyBytes,
    termuxFingerprint: termuxKey.fingerprint,
    reviewedClaude: options.reviewed ?? update.REVIEWED_CLAUDE,
  };
  return world;
}

type World = ReturnType<typeof makeWorld>;
const claudeBody = (seed: string) => Buffer.concat([minimalElf(2, null), Buffer.from(seed)]);

describe('claude install', () => {
  let world: World;
  beforeEach(() => {
    world = makeWorld();
    world.stageLib();
    world.addClaude('2.1.320', claudeBody('320'));
    world.setChannel('latest', '2.1.320');
  });
  afterEach(() => world.cleanup());

  it('installs through staging into versions/ and current, keeping the old entry path', async () => {
    const result = await update.install(world.ctx, 'claude');
    expect(result).toMatchObject({ installed: true, version: '2.1.320' });
    expect(world.current()).toBe('2.1.320');
    const paths = world.paths('claude');
    expect(fs.readlinkSync(paths.entry).replace(/\\/g, '/')).toBe('current/claude');
    expect(fs.readFileSync(paths.entry).equals(claudeBody('320'))).toBe(true);
    expect(fs.existsSync(path.join(paths.root, '.stage'))).toBe(false);
    expect(world.probes[0]).toContain(`${path.sep}.stage${path.sep}`);
  });

  it('a bad signature installs nothing and holds the version', async () => {
    const sig = Buffer.from(world.routes.get(`${CLAUDE_BASE}/2.1.320/manifest.json.sig`)!);
    sig[sig.length - 1] ^= 1;
    world.routes.set(`${CLAUDE_BASE}/2.1.320/manifest.json.sig`, sig);
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(update.TrustError);
    expect(world.current()).toBeNull();
    expect(world.probes).toEqual([]);
    expect(world.state().failed['2.1.320']).toMatchObject({ stage: 'trust', hold: true });
  });

  it('a bad checksum keeps the previous version and holds the new one', async () => {
    await update.install(world.ctx, 'claude');
    world.addClaude('2.1.321', claudeBody('321'));
    world.routes.set(`${CLAUDE_BASE}/2.1.321/linux-arm64/claude`, claudeBody('tampered'));
    world.setChannel('latest', '2.1.321');
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/checksum mismatch/);
    expect(world.current()).toBe('2.1.320');
    expect(world.state().failed['2.1.321'].hold).toBe(true);
  });

  it('a failed probe keeps the previous version, cools down, then holds', async () => {
    await update.install(world.ctx, 'claude');
    world.addClaude('2.1.321', claudeBody('321'));
    world.setChannel('latest', '2.1.321');
    world.setProbe(() => ({ ok: false, stage: 'version', detail: 'SIGSEGV' }));
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/SIGSEGV/);
    expect(world.current()).toBe('2.1.320');
    expect(fs.readFileSync(world.paths('claude').entry).equals(claudeBody('320'))).toBe(true);
    expect(world.state().failed['2.1.321']).toMatchObject({ hold: false, count: 1 });

    await expect(update.install(world.ctx, 'claude')).resolves.toMatchObject({ installed: false, reason: 'cooldown' });

    world.now += 25 * 3600 * 1000;
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/SIGSEGV/);
    expect(world.state().failed['2.1.321'].hold).toBe(true);

    world.now += 25 * 3600 * 1000;
    world.setProbe(() => ({ ok: true, version: '2.1.321' }));
    await expect(update.install(world.ctx, 'claude')).resolves.toMatchObject({ installed: false, reason: 'held' });
    expect(world.current()).toBe('2.1.320');

    await expect(update.install(world.ctx, 'claude', { force: true })).resolves.toMatchObject({ installed: true });
    expect(world.current()).toBe('2.1.321');
    expect(world.state().failed['2.1.321']).toBeUndefined();
  });

  it('refuses a binary whose --version disagrees with the manifest', async () => {
    world.probeVersion = '2.1.300';
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/reports 2\.1\.300/);
    expect(world.current()).toBeNull();
  });

  it('a failure before a version is named holds nothing', async () => {
    await update.install(world.ctx, 'claude');
    world.routes.set(`${CLAUDE_BASE}/latest`, Buffer.from('<html>captive portal</html>'));
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/invalid version/);
    expect(world.state().failed || {}).toEqual({});
  });

  it('follows the stored channel, and refuses to go back without --force', async () => {
    await update.install(world.ctx, 'claude');
    world.addClaude('2.1.311', claudeBody('311'));
    world.setChannel('stable', '2.1.311');
    await expect(update.install(world.ctx, 'claude', { channel: 'stable' })).resolves.toMatchObject({ installed: false, reason: 'older' });
    expect(world.state().channel).toBe('stable');
    expect(update.cliStatus(world.ctx, 'claude').channel).toBe('stable');
    await expect(update.install(world.ctx, 'claude')).resolves.toMatchObject({ version: '2.1.311' });
    world.probeVersion = '2.1.311';
    await expect(update.install(world.ctx, 'claude', { force: true })).resolves.toMatchObject({ installed: true, version: '2.1.311' });
    expect(world.current()).toBe('2.1.311');
  });

  it('refuses an unknown channel before touching the network', async () => {
    await expect(update.install(world.ctx, 'claude', { channel: 'nightly' })).rejects.toThrow(/unknown channel/);
  });

  it('wants the space for the download first', async () => {
    (world.ctx as { freeBytes: () => number }).freeBytes = () => 1024;
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/free space/);
    expect(world.state().failed || {}).toEqual({});
  });

  it('refuses a runtime directory that is a link', async () => {
    const paths = world.paths('claude');
    fs.rmSync(paths.root, { recursive: true, force: true });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-elsewhere-'));
    fs.symlinkSync(elsewhere, paths.root, 'dir');
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/not a directory under HOME/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.rmSync(paths.root, { force: true, recursive: true });
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it('keeps current and previous, and never deletes what is running', async () => {
    await update.install(world.ctx, 'claude');
    for (const version of ['2.1.321', '2.1.322']) {
      world.addClaude(version, claudeBody(version));
      world.setChannel('latest', version);
      world.probeVersion = version;
      // eslint-disable-next-line no-await-in-loop
      await update.install(world.ctx, 'claude');
    }
    const names = () => fs.readdirSync(world.paths('claude').versions).map((name) => name.split('-')[0]).sort();
    expect(names()).toEqual(['2.1.321', '2.1.322']);

    world.inUse.add('2.1.321');
    for (const version of ['2.1.323', '2.1.324']) {
      world.addClaude(version, claudeBody(version));
      world.setChannel('latest', version);
      world.probeVersion = version;
      // eslint-disable-next-line no-await-in-loop
      await update.install(world.ctx, 'claude');
    }
    expect(names()).toEqual(['2.1.321', '2.1.323', '2.1.324']);
  });

  it('a live lease protects a version, a dead one does not', async () => {
    await update.install(world.ctx, 'claude');
    const paths = world.paths('claude');
    const oldest = fs.realpathSync(update.linkedVersion(paths, paths.current));
    fs.mkdirSync(paths.leases, { recursive: true });
    fs.writeFileSync(path.join(paths.leases, String(process.pid)), `${oldest}\n`);
    fs.writeFileSync(path.join(paths.leases, '999999'), `${oldest}\n`);
    for (const version of ['2.1.321', '2.1.322']) {
      world.addClaude(version, claudeBody(version));
      world.setChannel('latest', version);
      world.probeVersion = version;
      // eslint-disable-next-line no-await-in-loop
      await update.install(world.ctx, 'claude');
    }
    expect(fs.existsSync(oldest)).toBe(true);
    expect(fs.existsSync(path.join(paths.leases, '999999'))).toBe(false);
  });

  it('rollback goes to previous and holds the version left', async () => {
    await update.install(world.ctx, 'claude');
    world.addClaude('2.1.321', claudeBody('321'));
    world.setChannel('latest', '2.1.321');
    world.probeVersion = '2.1.321';
    await update.install(world.ctx, 'claude');
    expect(update.rollback(world.ctx, 'claude').version).toBe('2.1.320');
    expect(world.current()).toBe('2.1.320');
    await expect(update.install(world.ctx, 'claude', { auto: true })).resolves.toMatchObject({ installed: false, reason: 'held' });
  });

  it('a timeout under load does not count against the version', async () => {
    await update.install(world.ctx, 'claude');
    world.addClaude('2.1.321', claudeBody('321'));
    world.setChannel('latest', '2.1.321');
    world.setProbe(() => ({ ok: false, stage: 'version', transient: true, detail: 'signal SIGKILL' }));
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/could not finish/);
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/could not finish/);
    expect(world.state().failed['2.1.321']).toMatchObject({ hold: false, count: 0, timeouts: 2, retryAt: null });
    expect(world.current()).toBe('2.1.320');
    world.setProbe(() => ({ ok: true, version: '2.1.321' }));
    await expect(update.install(world.ctx, 'claude')).resolves.toMatchObject({ installed: true });
    expect(world.state().failed['2.1.321']).toBeUndefined();
  });

  it('repeated timeouts stop the downloads for a while, and never hold', async () => {
    await update.install(world.ctx, 'claude');
    world.addClaude('2.1.321', claudeBody('321'));
    world.setChannel('latest', '2.1.321');
    world.setProbe(() => ({ ok: false, stage: 'version', transient: true, detail: 'timeout' }));
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/could not finish/);
    }
    const downloads = world.probes.length;
    await expect(update.install(world.ctx, 'claude', { auto: true })).resolves.toMatchObject({ installed: false, reason: 'cooldown' });
    expect(world.probes.length).toBe(downloads);
    expect(world.state().failed['2.1.321'].hold).toBe(false);
    expect(update.cliStatus(world.ctx, 'claude').held).toEqual([]);

    world.now += 8 * 24 * 3600 * 1000;
    world.setProbe(() => ({ ok: true, version: '2.1.321' }));
    await expect(update.install(world.ctx, 'claude', { auto: true })).resolves.toMatchObject({ installed: true });
  });

  it('a timeout does not add up to a hold with one real failure', async () => {
    await update.install(world.ctx, 'claude');
    world.addClaude('2.1.321', claudeBody('321'));
    world.setChannel('latest', '2.1.321');
    world.setProbe(() => ({ ok: false, stage: 'version', transient: true, detail: 'timeout' }));
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/could not finish/);
    world.setProbe(() => ({ ok: false, stage: 'version', detail: 'SIGSEGV' }));
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/SIGSEGV/);
    expect(world.state().failed['2.1.321']).toMatchObject({ hold: false, count: 1 });
  });

  it('going back clears the hold on where it lands, and can be undone', async () => {
    await update.install(world.ctx, 'claude');
    world.addClaude('2.1.321', claudeBody('321'));
    world.setChannel('latest', '2.1.321');
    world.probeVersion = '2.1.321';
    await update.install(world.ctx, 'claude');
    update.rollback(world.ctx, 'claude');
    expect(update.cliStatus(world.ctx, 'claude').previous).toBe('2.1.321');
    update.rollback(world.ctx, 'claude');
    expect(world.current()).toBe('2.1.321');
    expect(world.state().failed['2.1.321']).toBeUndefined();
    expect(world.state().failed['2.1.320'].hold).toBe(true);
  });

  it('survives anything in state.json', async () => {
    const paths = world.paths('claude');
    for (const body of [
      'not json',
      '[]',
      '{"channel":"nightly","failed":[1,2]}',
      '{"failed":"x","lastCheckAt":"soon"}',
      '{"failed":{"2.1.320":null,"../x":{"hold":true}}}',
    ]) {
      fs.writeFileSync(paths.state, body);
      // eslint-disable-next-line no-await-in-loop
      await expect(update.install(world.ctx, 'claude', { force: true })).resolves.toMatchObject({ version: '2.1.320' });
      expect(update.cliStatus(world.ctx, 'claude').channel).toBe('latest');
      expect(update.cliStatus(world.ctx, 'claude').held).toEqual([]);
    }
  });

  describe('the lock', () => {
    const lockWith = (text: string) => fs.writeFileSync(world.paths('claude').lock, text);

    it('refuses while a live process holds it', async () => {
      lockWith(`${process.pid} `);
      await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/already running/);
      expect(fs.existsSync(world.paths('claude').lock)).toBe(true);
    });

    it('takes over from a dead holder, leaving nothing behind', async () => {
      lockWith('999999 123');
      await expect(update.install(world.ctx, 'claude')).resolves.toMatchObject({ installed: true });
      expect(fs.readdirSync(world.paths('claude').root).filter((name) => name.startsWith('.lock'))).toEqual([]);
    });

    it('an empty lock is a holder mid-write until it gets old', async () => {
      lockWith('');
      await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/already running/);
      const old = new Date(Date.now() - 5 * 60 * 1000);
      fs.utimesSync(world.paths('claude').lock, old, old);
      await expect(update.install(world.ctx, 'claude')).resolves.toMatchObject({ installed: true });
    });
  });

  it('a check that waited on the network does not erase a hold recorded meanwhile', async () => {
    await update.install(world.ctx, 'claude');
    const paths = world.paths('claude');
    const ctx = world.ctx as { fetchBytes: (url: string, cap: number) => Promise<Buffer> };
    const realFetch = ctx.fetchBytes;
    ctx.fetchBytes = async (url, cap) => {
      if (url.endsWith('/latest')) {
        fs.writeFileSync(paths.state, JSON.stringify({ failed: { '2.1.321': { hold: true, stage: 'trust', count: 1 } } }));
      }
      return realFetch(url, cap);
    };
    world.routes.set(AGY_MANIFEST, Buffer.from('{}'));
    const result = await update.check(world.ctx);
    expect(result.claude.latest).toBe('2.1.320');
    expect(world.state().failed['2.1.321'].hold).toBe(true);
    expect(world.state().lastLatest).toBe('2.1.320');
  });

  it('a check leaves state alone while an install holds the lock', async () => {
    await update.install(world.ctx, 'claude');
    const before = fs.readFileSync(world.paths('claude').state, 'utf8');
    fs.writeFileSync(world.paths('claude').lock, `${process.pid} `);
    world.setChannel('latest', '2.1.999');
    world.routes.set(AGY_MANIFEST, Buffer.from('{}'));
    await expect(update.check(world.ctx)).resolves.toMatchObject({ claude: { latest: '2.1.999' } });
    expect(fs.readFileSync(world.paths('claude').state, 'utf8')).toBe(before);
  });

  it('does not cut off the binary if an earlier adoption stopped half way', async () => {
    const paths = world.paths('claude');
    const body = claudeBody('manual');
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    fs.mkdirSync(paths.versions, { recursive: true });
    fs.writeFileSync(paths.entry, body);
    // The directory exists, with no binary in it: the old order stopped here.
    fs.mkdirSync(path.join(paths.versions, `2.1.314-${digest.slice(0, 8)}`));
    world.setProbe(() => ({ ok: true, version: '2.1.314' }));
    await update.install(world.ctx, 'claude').catch(() => {});
    expect(fs.readFileSync(paths.entry).equals(body)).toBe(true);
  });

  it('finishes an adoption cut off after the rename', async () => {
    const paths = world.paths('claude');
    const body = claudeBody('manual');
    const dir = path.join(paths.versions, '2.1.314-abcd1234');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude'), body);
    world.setProbe(() => ({ ok: true, version: '2.1.320' }));
    await update.install(world.ctx, 'claude');
    expect(world.current()).toBe('2.1.320');
    expect(update.cliStatus(world.ctx, 'claude').previous).toBe('2.1.314');
    expect(fs.readFileSync(path.join(dir, 'claude')).equals(body)).toBe(true);
  });

  it('refuses to replace a hand-staged file with a different one of the same name', async () => {
    const paths = world.paths('claude');
    const body = claudeBody('manual');
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    const dir = path.join(paths.versions, `2.1.314-${digest.slice(0, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude'), 'something else');
    fs.writeFileSync(paths.entry, body);
    world.setProbe(() => ({ ok: true, version: '2.1.314' }));
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/left alone/);
    expect(fs.readFileSync(paths.entry).equals(body)).toBe(true);
  });

  it('adopts a hand-staged binary without breaking its path', async () => {
    const paths = world.paths('claude');
    fs.writeFileSync(paths.entry, claudeBody('manual'));
    world.probeVersion = '2.1.314';
    world.setProbe(() => ({ ok: true, version: '2.1.314' }));
    await update.install(world.ctx, 'claude', { force: false }).catch(() => {});
    expect(fs.lstatSync(paths.entry).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(paths.entry).equals(claudeBody('manual'))).toBe(true);
    expect(world.current()).toBe('2.1.314');
  });
});

describe('agents stay on the reviewed build', () => {
  const reviewedBody = claudeBody('reviewed');
  const reviewed = {
    version: '2.1.314',
    sha256: crypto.createHash('sha256').update(reviewedBody).digest('hex'),
    size: reviewedBody.length,
  };
  let world: World;
  beforeEach(() => {
    world = makeWorld({ reviewed });
    world.stageLib();
    world.addClaude('2.1.320', claudeBody('320'));
    world.addClaude('2.1.314', reviewedBody);
    world.setChannel('latest', '2.1.320');
  });
  afterEach(() => world.cleanup());

  it('a plain install never creates agent-current', async () => {
    await update.install(world.ctx, 'claude');
    expect(fs.existsSync(world.paths('claude').agent)).toBe(false);
    expect(update.cliStatus(world.ctx, 'claude').agent).toEqual({ reviewed: '2.1.314', version: null, enabled: false });
  });

  it('--agent links the reviewed build and leaves current alone', async () => {
    await update.install(world.ctx, 'claude');
    world.probeVersion = '2.1.314';
    await expect(update.install(world.ctx, 'claude', { agent: true })).resolves.toMatchObject({ agent: true, version: '2.1.314' });
    expect(world.current()).toBe('2.1.320');
    expect(update.cliStatus(world.ctx, 'claude').agent.enabled).toBe(true);
  });

  it('later updates do not move it, and it survives cleanup', async () => {
    world.probeVersion = '2.1.314';
    await update.install(world.ctx, 'claude', { agent: true });
    const paths = world.paths('claude');
    const before = fs.readlinkSync(paths.agent);
    for (const version of ['2.1.320', '2.1.321', '2.1.322', '2.1.323']) {
      world.addClaude(version, claudeBody(version));
      world.setChannel('latest', version);
      world.probeVersion = version;
      // eslint-disable-next-line no-await-in-loop
      await update.install(world.ctx, 'claude');
    }
    expect(fs.readlinkSync(paths.agent)).toBe(before);
    expect(world.current()).toBe('2.1.323');
    expect(fs.existsSync(path.join(paths.root, before, 'claude'))).toBe(true);
  });

  it('refuses when the signed manifest no longer matches the reviewed hash', async () => {
    world.addClaude('2.1.314', claudeBody('something else'));
    await expect(update.install(world.ctx, 'claude', { agent: true })).rejects.toThrow(/differs from the reviewed/);
    expect(fs.existsSync(world.paths('claude').agent)).toBe(false);
  });

  it('with nothing installed it also gives the terminal a working claude', async () => {
    world.probeVersion = '2.1.314';
    await update.install(world.ctx, 'claude', { agent: true });
    expect(world.current()).toBe('2.1.314');
  });

  it('a hand-staged copy of exactly the reviewed build keeps agents working, with no download', async () => {
    const paths = world.paths('claude');
    fs.writeFileSync(paths.entry, reviewedBody);
    world.routes.delete(`${CLAUDE_BASE}/2.1.314/linux-arm64/claude`);
    await update.install(world.ctx, 'claude').catch(() => {});
    expect(update.cliStatus(world.ctx, 'claude').agent).toEqual({ reviewed: '2.1.314', version: '2.1.314', enabled: true });
    expect(fs.readFileSync(paths.agent.concat('/claude')).equals(reviewedBody)).toBe(true);
  });

  it('a hand-staged copy of anything else does not become the agents\' version', async () => {
    fs.writeFileSync(world.paths('claude').entry, claudeBody('patched 2.1.314'));
    world.setProbe(() => ({ ok: true, version: '2.1.314' }));
    await update.install(world.ctx, 'claude').catch(() => {});
    expect(fs.existsSync(world.paths('claude').agent)).toBe(false);
  });

  it('cleanup keeps the reviewed build even with no link to it yet', async () => {
    world.probeVersion = '2.1.314';
    await update.install(world.ctx, 'claude', { agent: true });
    const paths = world.paths('claude');
    fs.rmSync(paths.agent, { force: true, recursive: true });
    for (const version of ['2.1.320', '2.1.321', '2.1.322']) {
      world.addClaude(version, claudeBody(version));
      world.setChannel('latest', version);
      world.probeVersion = version;
      // eslint-disable-next-line no-await-in-loop
      await update.install(world.ctx, 'claude');
    }
    expect(fs.readdirSync(paths.versions).some((name) => name.startsWith('2.1.314-'))).toBe(true);
    expect(update.cliStatus(world.ctx, 'claude').agent.enabled).toBe(true);
  });

  it('Antigravity can never be enabled for agents', async () => {
    await expect(update.install(world.ctx, 'agy', { agent: true })).rejects.toThrow(/never an agent worker/);
  });
});

describe('glibc from Termux', () => {
  const MIRROR = 'https://packages-cf.termux.dev/apt/termux-glibc';
  const xz = Buffer.from(fs.readFileSync(path.join(__dirname, 'fixtures/cli-update-glibc.tar.xz.b64'), 'utf8'), 'base64');
  const deb = debFor(xz);
  const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest('hex');
  const stanza = (name: string) => [
    `Package: ${name}`, 'Version: 2.44', `Filename: pool/stable/g/${name}/${name}_2.44_aarch64.deb`,
    `Size: ${deb.length}`, `SHA256: ${sha256(deb)}`,
  ].join('\n');
  const packages = zlib.gzipSync(Buffer.from(`${stanza('glibc')}\n\n${stanza('gcc-libs-glibc')}\n`));
  const release = (hash: string, origin = 'termux-glibc glibc') => clearsign([
    `Origin: ${origin}`, 'Suite: glibc', 'Codename: glibc', 'SHA256:',
    ` ${hash} ${packages.length} stable/binary-aarch64/Packages.gz`,
  ], termuxKey);

  let world: World;
  beforeEach(() => {
    world = makeWorld();
    world.addClaude('2.1.320', claudeBody('320'));
    world.setChannel('latest', '2.1.320');
    world.routes.set(`${MIRROR}/dists/glibc/InRelease`, Buffer.from(release(sha256(packages))));
    world.routes.set(`${MIRROR}/dists/glibc/stable/binary-aarch64/Packages.gz`, packages);
    world.routes.set(`${MIRROR}/pool/stable/g/glibc/glibc_2.44_aarch64.deb`, deb);
    world.routes.set(`${MIRROR}/pool/stable/g/gcc-libs-glibc/gcc-libs-glibc_2.44_aarch64.deb`, deb);
  });
  afterEach(() => world.cleanup());

  it('comes through the signed chain, with links turned into plain files', async () => {
    await update.install(world.ctx, 'claude');
    const paths = world.paths('claude');
    expect(fs.lstatSync(paths.lib).isSymbolicLink()).toBe(true);
    const lib = fs.realpathSync(paths.lib);
    const names = fs.readdirSync(lib);
    for (const name of update.GLIBC_REQUIRED) expect(names).toContain(name);
    expect(fs.lstatSync(path.join(lib, 'libstdc++.so.6')).isSymbolicLink()).toBe(false);
    expect(names).not.toContain('libc.a');
    expect(names).not.toContain('ld.so');
    expect(world.current()).toBe('2.1.320');
  });

  it('a second install does not fetch it again', async () => {
    await update.install(world.ctx, 'claude');
    world.routes.delete(`${MIRROR}/dists/glibc/InRelease`);
    world.addClaude('2.1.321', claudeBody('321'));
    world.setChannel('latest', '2.1.321');
    world.probeVersion = '2.1.321';
    await expect(update.install(world.ctx, 'claude')).resolves.toMatchObject({ installed: true });
  });

  it('a failed probe leaves a hand-staged lib/ running, and the retry does not fetch again', async () => {
    const paths = world.paths('claude');
    fs.mkdirSync(paths.lib, { recursive: true });
    fs.writeFileSync(path.join(paths.lib, 'libc.so.6'), 'partial');
    let probedWith = '';
    (world.ctx as { probeClaude: unknown }).probeClaude = (_ctx: unknown, _binary: string, libDir: string) => {
      probedWith = libDir;
      return { ok: false, stage: 'version', detail: 'bad' };
    };
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/bad/);
    expect(probedWith.replace(/\\/g, '/')).toMatch(/\/glibc\/2\.44-[0-9a-f]{8}$/);
    expect(fs.lstatSync(paths.lib).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(paths.lib, 'libc.so.6'), 'utf8')).toBe('partial');

    world.routes.delete(`${MIRROR}/pool/stable/g/glibc/glibc_2.44_aarch64.deb`);
    world.routes.delete(`${MIRROR}/pool/stable/g/gcc-libs-glibc/gcc-libs-glibc_2.44_aarch64.deb`);
    world.now += 25 * 3600 * 1000;
    (world.ctx as { probeClaude: unknown }).probeClaude = () => ({ ok: true, version: '2.1.320' });
    await expect(update.install(world.ctx, 'claude')).resolves.toMatchObject({ installed: true });
    expect(fs.lstatSync(paths.lib).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(paths.root).filter((name) => name.startsWith('lib.manual.'))).toHaveLength(1);
  });

  it('a new lib proves itself on an existing build before it is switched in', async () => {
    await update.install(world.ctx, 'claude');
    const paths = world.paths('claude');
    fs.rmSync(paths.lib, { force: true, recursive: true });
    fs.rmSync(paths.glibc, { force: true, recursive: true });
    (world.ctx as { probeClaude: unknown }).probeClaude = () => ({ ok: false, stage: 'version', detail: 'bad' });
    await expect(update.install(world.ctx, 'claude', { force: true })).rejects.toThrow(/bad/);
    expect(fs.existsSync(paths.lib)).toBe(false);
  });

  it('a tampered InRelease stops it, without holding a Claude version', async () => {
    world.routes.set(`${MIRROR}/dists/glibc/InRelease`, Buffer.from(release(sha256(packages)).replace('Codename: glibc', 'Codename: other')));
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/glibc from Termux was rejected/);
    expect(world.current()).toBeNull();
    expect(world.state().failed || {}).toEqual({});
  });

  it('another repository signed by the same key is refused', async () => {
    world.routes.set(`${MIRROR}/dists/glibc/InRelease`, Buffer.from(release(sha256(packages), 'termux-main')));
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/unexpected repository/);
  });

  it('a package whose hash is not the signed one is refused', async () => {
    world.routes.set(`${MIRROR}/pool/stable/g/glibc/glibc_2.44_aarch64.deb`, debFor(Buffer.concat([xz, Buffer.from([0])])));
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/hash mismatch/);
  });

  it('an index whose hash is not the signed one is refused', async () => {
    world.routes.set(`${MIRROR}/dists/glibc/InRelease`, Buffer.from(release('0'.repeat(64))));
    await expect(update.install(world.ctx, 'claude')).rejects.toThrow(/index hash mismatch/);
  });
});

describe('Antigravity', () => {
  const elf = minimalElf(3, '/system/bin/linker64');
  const sha512 = (data: Buffer) => crypto.createHash('sha512').update(data).digest('hex');
  const url = (version: string) => `https://storage.googleapis.com/antigravity-public/${version}/cli_android_arm64.tar.gz`;

  function publish(world: World, version: string, archive: Buffer, hash = sha512(archive)) {
    world.routes.set(AGY_MANIFEST, Buffer.from(JSON.stringify({ version, url: url(version), sha512: hash })));
    world.routes.set(url(version), archive);
  }
  const archive = (...parts: Buffer[]) => zlib.gzipSync(tar(...parts));

  let world: World;
  beforeEach(() => {
    world = makeWorld();
  });
  afterEach(() => world.cleanup());

  it('installs by checksum and ELF check, and is never executed', async () => {
    publish(world, '1.5.2', archive(tarFile('antigravity', elf), tarFile('install', 'vendor step')));
    await expect(update.install(world.ctx, 'agy')).resolves.toMatchObject({ installed: true, version: '1.5.2' });
    expect(world.probes).toEqual([]);
    expect(world.current('agy')).toBe('1.5.2');
    const paths = world.paths('agy');
    expect(fs.readlinkSync(paths.entry).replace(/\\/g, '/')).toBe('current/antigravity');
    const dir = update.linkedVersion(paths, paths.current);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).probe).toBe('checksum+elf');
    expect(fs.readdirSync(dir)).not.toContain('install');
  });

  it('nothing in the script can run it: the only spawn is the Claude probe', () => {
    expect(source.match(/spawnSync|execSync|execFile|spawn\(/g)).toEqual(['spawnSync']);
    const start = source.indexOf('function probeClaude');
    const end = source.indexOf('function assertProbe');
    expect(source.indexOf('childProcess.spawnSync')).toBeGreaterThan(start);
    expect(source.indexOf('childProcess.spawnSync')).toBeLessThan(end);
    const agy = source.slice(source.indexOf('async function stageAgy'), source.indexOf('// A version is deleted only'));
    expect(agy).not.toContain('probeClaude');
  });

  it('a wrong SHA-512 installs nothing and holds the version', async () => {
    publish(world, '1.5.2', archive(tarFile('antigravity', elf)), 'a'.repeat(128));
    await expect(update.install(world.ctx, 'agy')).rejects.toThrow(/SHA-512 mismatch/);
    expect(world.current('agy')).toBeNull();
    expect(world.state('agy').failed['1.5.2'].hold).toBe(true);
  });

  it('an archive with a traversal is refused whole', async () => {
    publish(world, '1.5.2', archive(tarFile('antigravity', elf), tarFile('../../.bashrc', 'evil')));
    await expect(update.install(world.ctx, 'agy')).rejects.toThrow(/unsafe path/);
    expect(world.current('agy')).toBeNull();
    expect(fs.existsSync(path.join(world.home, '.bashrc'))).toBe(false);
  });

  it('refuses a link named antigravity, and a glibc build', async () => {
    publish(world, '1.5.2', archive(tarHeader('antigravity', '2', 0, '/system/bin/sh')));
    await expect(update.install(world.ctx, 'agy')).rejects.toThrow(/not a plain file/);
    publish(world, '1.5.3', archive(tarFile('antigravity', minimalElf(3, '/lib/ld-linux-aarch64.so.1'))));
    await expect(update.install(world.ctx, 'agy')).rejects.toThrow(/Android PIE/);
  });

  it('keeps the old version when the new one is bad, and refuses to go back', async () => {
    publish(world, '1.5.2', archive(tarFile('antigravity', elf)));
    await update.install(world.ctx, 'agy');
    publish(world, '1.5.3', archive(tarFile('notit', 'x')));
    await expect(update.install(world.ctx, 'agy')).rejects.toThrow(/missing/);
    expect(world.current('agy')).toBe('1.5.2');
    publish(world, '1.5.1', archive(tarFile('antigravity', elf)));
    await expect(update.install(world.ctx, 'agy')).resolves.toMatchObject({ installed: false, reason: 'older' });
  });

  it('adopts the file the old agy-install left', async () => {
    const paths = world.paths('agy');
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(paths.entry, elf);
    fs.writeFileSync(path.join(paths.root, 'VERSION'), '1.5.1\n');
    publish(world, '1.5.2', archive(tarFile('antigravity', elf)));
    await update.install(world.ctx, 'agy');
    expect(fs.lstatSync(paths.entry).isSymbolicLink()).toBe(true);
    expect(world.current('agy')).toBe('1.5.2');
    expect(update.cliStatus(world.ctx, 'agy').previous).toBe('1.5.1');
  });
});

describe('the app-start pass', () => {
  let world: World;
  beforeEach(() => {
    world = makeWorld();
    world.stageLib();
    world.addClaude('2.1.320', claudeBody('320'));
    world.setChannel('latest', '2.1.320');
  });
  afterEach(() => world.cleanup());

  it('skips a CLI whose install is running', async () => {
    await update.install(world.ctx, 'claude');
    world.now += 7 * 3600 * 1000;
    fs.writeFileSync(world.paths('claude').lock, `${process.pid} `);
    await expect(update.autoUpdate(world.ctx)).resolves.toMatchObject({ claude: { skipped: 'install-running' } });
  });

  it('never fetches a CLI nobody installed', async () => {
    const results = await update.autoUpdate(world.ctx);
    expect(results).toEqual({ claude: { skipped: 'not-managed' }, agy: { skipped: 'not-managed' } });
    expect(world.current()).toBeNull();
  });

  it('leaves a hand-staged binary for a person', async () => {
    fs.writeFileSync(world.paths('claude').entry, claudeBody('manual'));
    await expect(update.autoUpdate(world.ctx)).resolves.toMatchObject({ claude: { skipped: 'not-managed' } });
    expect(fs.lstatSync(world.paths('claude').entry).isSymbolicLink()).toBe(false);
  });

  it('updates what is installed, at most every 6 hours', async () => {
    await update.install(world.ctx, 'claude');
    world.addClaude('2.1.321', claudeBody('321'));
    world.setChannel('latest', '2.1.321');
    world.probeVersion = '2.1.321';
    await expect(update.autoUpdate(world.ctx)).resolves.toMatchObject({ claude: { installed: true, version: '2.1.321' } });

    world.addClaude('2.1.322', claudeBody('322'));
    world.setChannel('latest', '2.1.322');
    world.probeVersion = '2.1.322';
    world.now += 3600 * 1000;
    await expect(update.autoUpdate(world.ctx)).resolves.toMatchObject({ claude: { skipped: 'checked-recently' } });
    world.now += 6 * 3600 * 1000;
    await expect(update.autoUpdate(world.ctx)).resolves.toMatchObject({ claude: { installed: true, version: '2.1.322' } });
  });

  it('never retries a held version, and reports a failure instead of throwing', async () => {
    await update.install(world.ctx, 'claude');
    world.addClaude('2.1.321', claudeBody('321'));
    world.setChannel('latest', '2.1.321');
    world.routes.set(`${CLAUDE_BASE}/2.1.321/linux-arm64/claude`, claudeBody('tampered'));
    const first = await update.autoUpdate(world.ctx);
    expect(first.claude.error).toMatch(/checksum/);
    world.now += 24 * 3600 * 1000;
    await expect(update.autoUpdate(world.ctx)).resolves.toMatchObject({ claude: { installed: false, reason: 'held' } });
    expect(world.current()).toBe('2.1.320');
  });
});

// ─── What the agent side refuses ────────────────────────────────────────────

describe('resolveClaudeAgentRuntime', () => {
  const reviewed = { version: '2.1.314', sha256: 'x', size: 6 };
  let home: string;
  let rootDir: string;

  function stage(version: string, size = 6) {
    const dir = path.join(rootDir, 'versions', `${version}-abc`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'claude'), Buffer.alloc(size));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(dir, '.healthy'), 'ok');
    return dir;
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-agent-runtime-'));
    rootDir = path.join(home, '.shelly-runtime/claude-glibc');
    fs.mkdirSync(path.join(rootDir, 'versions'), { recursive: true });
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  it('refuses with the fix when nothing is approved', () => {
    const result = driver.resolveClaudeAgentRuntime(home, reviewed);
    expect(result.ok).toBe(false);
    expect(result.refusal).toContain('2.1.314');
    expect(result.refusal).toContain('claude-install --agent');
  });

  it('does not fall back to current', () => {
    fs.symlinkSync(path.join('versions', path.basename(stage('2.1.320'))), path.join(rootDir, 'current'), 'dir');
    expect(driver.resolveClaudeAgentRuntime(home, reviewed).ok).toBe(false);
  });

  it('accepts the reviewed build, by its real directory', () => {
    const dir = stage('2.1.314');
    fs.symlinkSync(path.join('versions', path.basename(dir)), path.join(rootDir, 'agent-current'), 'dir');
    expect(driver.resolveClaudeAgentRuntime(home, reviewed)).toEqual({ ok: true, dir: fs.realpathSync(dir), version: '2.1.314' });
  });

  it('refuses a link to any other version', () => {
    fs.symlinkSync(path.join('versions', path.basename(stage('2.1.320'))), path.join(rootDir, 'agent-current'), 'dir');
    expect(driver.resolveClaudeAgentRuntime(home, reviewed).refusal).toContain('2.1.320');
  });

  it('refuses a copy that is not the reviewed size', () => {
    fs.symlinkSync(path.join('versions', path.basename(stage('2.1.314', 7))), path.join(rootDir, 'agent-current'), 'dir');
    expect(driver.resolveClaudeAgentRuntime(home, reviewed).refusal).toContain('damaged');
  });

  it('refuses a link outside versions/', () => {
    const outside = path.join(rootDir, 'elsewhere');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(rootDir, 'agent-current'), 'dir');
    expect(driver.resolveClaudeAgentRuntime(home, reviewed).refusal).toContain('outside');
  });
});

function emitted(name: string): string {
  const lines = homeKt.split(/\r?\n/);
  const start = lines.findIndex((line) => line.includes(`sb.appendLine("${name}() {")`));
  const out: string[] = [];
  for (let i = start; i >= 0 && i < lines.length; i += 1) {
    const m = /^\s*sb\.appendLine\("(.*)"\)\s*$/.exec(lines[i]);
    if (!m) break;
    out.push(m[1].replace(/\$libDir/g, '/libdir').replace(/\\(.)/g, '$1'));
    if (m[1] === '}') break;
  }
  return out.join('\n');
}

describe('shelly-claude-glibc()', () => {
  const fn = emitted('shelly-claude-glibc');
  const hasBash = !childProcess.spawnSync('bash', ['--version']).error;

  it('stops Claude updating itself, and resolves the real directory before starting', () => {
    expect(fn).toContain('DISABLE_UPDATES=1');
    expect(fn).toContain('builtin cd -P "$__root/current"');
    expect(fn).toMatch(/"\$__ld" --library-path "\$__root\/lib" "\$__bin"/);
  });

  it('does not hand the approval variables to claude', () => {
    expect(fn).toMatch(/unset [^\n]*SHELLY_CLAUDE_AGENT_DIR __SHELLY_CLAUDE_AGENT_RUN/);
  });

  it('the runner marks itself as the agent path', () => {
    const runner = homeKt.slice(homeKt.indexOf('internal fun claudeRunnerScript'));
    expect(runner.indexOf('__SHELLY_CLAUDE_AGENT_RUN=1')).toBeGreaterThan(0);
    expect(runner.indexOf('__SHELLY_CLAUDE_AGENT_RUN=1')).toBeLessThan(runner.indexOf('appendClaudeGlibcFunction(sb, libDir)'));
  });

  (hasBash ? it : it.skip)('the agent path runs only what agent-current names, with the driver agreeing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-agent-path-'));
    const posix = (p: string) => p.replace(/\\/g, '/');
    try {
      const rt = path.join(home, '.shelly-runtime/claude-glibc');
      fs.mkdirSync(path.join(rt, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(rt, 'lib/ld-linux-aarch64.so.1'), '');
      for (const version of ['2.1.314', '2.1.320']) {
        fs.mkdirSync(path.join(rt, 'versions', version), { recursive: true });
        fs.writeFileSync(path.join(rt, 'versions', version, 'claude'), '');
      }
      fs.symlinkSync(path.join('versions', '2.1.320'), path.join(rt, 'current'), 'dir');
      // Stop right after the choice: the rest of the function is covered elsewhere.
      const pick = fn.slice(fn.indexOf('shelly-claude-glibc() {'), fn.indexOf('  if [ ! -f "$__proxy_js" ]'));
      const script = `${pick}\n  echo "BIN=$__bin"\n}\nshelly-claude-glibc`;
      const run = (env: Record<string, string>) => childProcess.spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: { ...process.env, HOME: posix(home), ...env },
      });
      const stdout = (env: Record<string, string>) => run(env).stdout.trim().replace(/\\/g, '/');

      expect(stdout({})).toContain('/versions/2.1.320/claude');

      const refused = run({ __SHELLY_CLAUDE_AGENT_RUN: '1' });
      expect(refused.status).toBe(3);
      expect(refused.stderr).toContain('claude-install --agent');

      fs.symlinkSync(path.join('versions', '2.1.314'), path.join(rt, 'agent-current'), 'dir');
      const real = childProcess.spawnSync('bash', ['-c', `cd -P "${posix(rt)}/agent-current" && pwd -P`], { encoding: 'utf8' }).stdout.trim();
      expect(run({ __SHELLY_CLAUDE_AGENT_RUN: '1', SHELLY_CLAUDE_AGENT_DIR: '/somewhere/else' }).status).toBe(3);
      expect(stdout({ __SHELLY_CLAUDE_AGENT_RUN: '1', SHELLY_CLAUDE_AGENT_DIR: real })).toContain('/versions/2.1.314/claude');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('agy()', () => {
  const fn = emitted('agy');

  it('stops the CLI updating itself, on its own command line only', () => {
    expect(fn).toContain('AGY_CLI_DISABLE_AUTO_UPDATE=true LD_PRELOAD="$SHELLY_LIB_DIR/libexec_wrapper.so" _run "$__bin" "$@"');
    expect(homeKt).not.toContain('export AGY_CLI_DISABLE_AUTO_UPDATE');
  });

  it('resolves the real directory before starting', () => {
    expect(fn).toContain('builtin cd -P "$HOME/.shelly-runtime/agy/current"');
  });
});

describe('execCommand and the Expo queue', () => {
  const module = fs.readFileSync(
    path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalEmulatorModule.kt'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const body = module.slice(module.indexOf('AsyncFunction("execCommand")'), module.indexOf('AsyncFunction("readDir")'));

  it('is a coroutine, and the blocking call leaves the queue', () => {
    expect(body).toMatch(/^AsyncFunction\("execCommand"\) Coroutine \{ command: String, timeoutMs: Int\?, lane: String\? ->/);
    expect(body).toMatch(/ExecLanes\.named\(lane\)\.withPermit \{\n\s+withContext\(Dispatchers\.IO\) \{\n\s+ShellyJNI\.execSubprocess\(/);
  });

  it('a timeout never picks the lane: only the name does', () => {
    expect(module).toContain('private val serial = Semaphore(1)');
    expect(module).toContain('private val long = Semaphore(2)');
    expect(module).toContain('if (lane == "long") long else serial');
    expect(module).not.toMatch(/timeoutMs >=|LONG_TIMEOUT/);
  });

  it('only the CLI installer asks for the long lane, and only for install and auto', () => {
    const skip = new Set(['node_modules', '.git', 'android', '__tests__', 'docs', 'assets', 'build']);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (fs.statSync(file).isDirectory()) {
          if (!skip.has(name) && !name.startsWith('.')) walk(file);
        } else if (/\.tsx?$/.test(name)) {
          const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
          for (const line of lines) {
            if (/execCommand\(.*, 'long'\)/.test(line)) hits.push(path.relative(root, file).replace(/\\/g, '/'));
          }
        }
      }
    };
    for (const dir of ['app', 'components', 'hooks', 'lib', 'store']) walk(path.join(root, dir));
    expect(hits).toEqual(['lib/managed-cli-update.ts', 'lib/managed-cli-update.ts']);
  });
});

describe('native command pipes', () => {
  const c = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/jni/shelly-exec.c'), 'utf8').replace(/\r\n/g, '\n');

  it('are close-on-exec, and the child still gets stdout and stderr', () => {
    expect(c).toContain('pipe2(stdout_pipe, O_CLOEXEC) < 0 || pipe2(stderr_pipe, O_CLOEXEC) < 0');
    expect(c).toContain('move_fd(stdout_pipe[1], STDOUT_FILENO);');
    expect(c).toContain('move_fd(stderr_pipe[1], STDERR_FILENO);');
    expect(c).toMatch(/if \(fd == target\) \{\n\s+fcntl\(fd, F_SETFD, 0\);\n\s+return;/);
  });
});

describe('helper scripts', () => {
  it('are replaced whole, never rewritten in place', () => {
    expect(homeKt).not.toMatch(/\.outputStream\(\)\.use \{ output -> input\.copyTo\(output\) \}/);
    expect(homeKt.match(/input\.copyToAtomically\(/g)).toHaveLength(19);
    expect(homeKt).toContain('input.copyToAtomically(saveDraftScript)');
    expect(homeKt).toContain('input.copyToAtomically(agentDriverScript)');
    expect(homeKt).toContain('input.copyToAtomically(gateDecideScript)');
  });

  it('are fsynced by a read-only descriptor, which a running binary allows', () => {
    const body = source.slice(source.indexOf('function syncFile'), source.indexOf('function syncTree'));
    expect(body).toContain("fs.openSync(file, 'r')");
    expect(body).not.toContain("'r+'");
  });
});

describe('the worker checks are unchanged', () => {
  const args = driver.claudeAgentArgs();

  it('keeps the allowlist, the MCP lockout and the settings deny', () => {
    expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--setting-sources', '--tools', '--permission-prompt-tool']));
    expect(args[args.indexOf('--tools') + 1]).toBe('Bash,Read,Write,Edit');
    const settings = JSON.parse(driver.claudeAgentSettingsJson());
    expect(settings.disableAllHooks).toBe(true);
    expect(settings.permissions.deny).toContain('WebFetch');
  });

  it('still fails closed on a tool outside the allowlist', () => {
    expect(driver.claudeInitToolCheck(['Bash', 'Read', 'Write', 'Edit']).ok).toBe(true);
    expect(driver.claudeInitToolCheck(['Bash', 'BrandNewTool']).ok).toBe(false);
    expect(driver.claudeInitToolCheck(undefined).ok).toBe(false);
  });
});
