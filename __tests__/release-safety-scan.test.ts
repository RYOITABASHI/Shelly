/**
 * Tests for scripts/release-safety-scan.js. All "secrets" are FAKE and built
 * at runtime by concatenation so this file never contains a real-looking
 * token literal (GitHub push protection).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const scanner = require('../scripts/release-safety-scan.js');

const rnd = (n: number) => 'a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ'.repeat(3).slice(0, n);
const FAKES: Record<string, string> = {
  github: 'gh' + 'p_' + rnd(36),
  anthropic: 'sk' + '-ant-' + 'api03-' + rnd(30),
  openai: 'sk' + '-' + rnd(40),
  google: 'AI' + 'za' + rnd(35),
  slack: 'xo' + 'xb-' + '1234567890-' + rnd(12),
  aws: 'AK' + 'IA' + 'Q7ZK3MXP4VBN9T2W',
  groq: 'gs' + 'k_' + rnd(48),
  perplexity: 'pp' + 'lx-' + rnd(40),
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rss-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string | Buffer): string {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function scan(p: string, allowlist?: string) {
  const al = allowlist ?? path.join(dir, 'none.txt');
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    return scanner.run([p], al);
  } finally {
    log.mockRestore();
  }
}

// Minimal zip writer (deflate) for APK-like fixtures.
function makeZip(entries: Record<string, Buffer>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const local = Buffer.concat([lh, nameBuf, comp]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, nameBuf]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

describe('release-safety-scan', () => {
  it.each(Object.keys(FAKES))('detects %s token', (k) => {
    const r = scan(write(`${k}.txt`, `config: ${FAKES[k]}\n`));
    expect(r.code).toBe(1);
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it('detects a private key block with body, ignores a bare marker string', () => {
    const marker = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
    expect(scan(write('k.pem', `${marker}\n${rnd(40)}\n`)).code).toBe(1);
    expect(scan(write('lib.txt', `error: expected ${marker} header`)).code).toBe(0);
  });

  it('detects .env-style secrets but not placeholders', () => {
    expect(scan(write('.env', 'MY_API_KEY=' + 'Zq8' + rnd(20) + '\n')).code).toBe(1);
    expect(scan(write('ok.env', 'MY_API_KEY=your-key-here\nDB_PASSWORD=${DB_PASSWORD}\nX_TOKEN=\n')).code).toBe(0);
  });

  it('detects keystore files and signing passwords', () => {
    expect(scan(write('release.jks', 'x')).findings[0].rule).toBe('keystore-file');
    expect(scan(write('gradle.properties', 'storePass' + 'word="hunter2hunter2"\n')).code).toBe(1);
  });

  it('allows bare 64-hex SHA-256 checksums', () => {
    const sha = require('crypto').createHash('sha256').update('x').digest('hex');
    expect(scan(write('latest.json', JSON.stringify({ sha256: sha }))).code).toBe(0);
  });

  it('reads zip (APK) entries in memory and reports the entry', () => {
    const apk = makeZip({
      'assets/clean.txt': Buffer.from('hello'),
      'assets/leak.json': Buffer.from(`{"k":"${FAKES.github}"}`),
    });
    const r = scan(write('app.apk', apk));
    expect(r.stats.entries).toBe(2);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].entry).toBe('assets/leak.json');
  });

  it('redacts: no finding output contains the full secret', () => {
    const r = scan(write('a.txt', FAKES.anthropic));
    const out = JSON.stringify(r.findings.map((f: any) => f.redacted));
    expect(out).not.toContain(FAKES.anthropic);
  });

  it('honors path+substring and exact-string allowlist entries', () => {
    const p = write('docs/example.md', `${FAKES.github}\n`);
    const al1 = write('al1.txt', '# c\n**/docs/example.md :: ' + FAKES.github.slice(0, 10) + '\n');
    expect(scan(p, al1).code).toBe(0);
    const al2 = write('al2.txt', FAKES.github + '\n');
    expect(scan(p, al2).code).toBe(0);
    const al3 = write('al3.txt', '**/other.md :: *\n');
    expect(scan(p, al3).code).toBe(1);
  });

  it('exits 2 for a missing path', () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(scanner.run([path.join(dir, 'nope')], '').code).toBe(2);
    err.mockRestore();
  });
});
