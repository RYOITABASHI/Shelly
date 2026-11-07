#!/usr/bin/env node
// CI only. Takes Codex from Termux's official `codex` package and proves where
// it came from through apt's own chain, so no URL is trusted:
//
//   pinned key -> signed InRelease -> hash of Packages.gz -> hash of the .deb
//
// The keyring is checked in (scripts/termux-autobuilds.gpg) and the signer must
// also match TERMUX_SIGNING_FINGERPRINTS, so a mirror cannot swap either.
//
// There are two pins, and they answer to different people:
//   .ci-versions/codex-termux-channel.json  what the runtime channel offers. The
//     Bump job moves it, for people using the TUI, after verifying the candidate.
//   .ci-versions/codex-termux-deb.json + codex.txt  what the APK bundles, which is
//     what agent workers run. Only a reviewed change moves these (`promote`).
//
// apt's index lists only the newest version, so a pin keeps the hash the chain
// proved. A later build trusts that committed hash, and can read the .deb from
// Shelly's own release if the pool has dropped it.
//
//   check-pin  --pin P --codex-txt T
//   bump       --pin CHANNEL --candidate F [--github-output F]
//   fetch      --pin P --out-dir D [--archive-base URL] [--keep-deb F]
//   manifest   --pin P --asset NAME --url URL --sha256 HEX --out F
//   published  --manifest F --pin P        prints "current" or "behind"
//   promote    --channel CHANNEL --pin P --codex-txt T
//
// Exit 0 = done, 1 = failure. Everything is fail closed: a key, hash, shape or
// library surprise stops the job instead of shipping.

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const MIRRORS = [
  'https://packages-cf.termux.dev/apt/termux-main',
  'https://packages.termux.dev/apt/termux-main',
];
const SUITE = 'stable';
const PACKAGES_PATH = 'main/binary-aarch64/Packages.gz';
const PACKAGE_NAME = 'codex';
const DEB_PREFIX = 'data/data/com.termux/files/usr';
// `termux-autobuilds.gpg` from packages/termux-keyring in termux/termux-packages.
// It is the key that signs termux-main. A rotation turns the job red on purpose:
// someone has to look at the new key and add it here and to the keyring file.
const TERMUX_SIGNING_FINGERPRINTS = ['CC72CF8BA7DBFA0182877D045A897D96E57CF20C'];
const KEYRING = path.join(__dirname, 'termux-autobuilds.gpg');
// There is no Valid-Until in Termux's InRelease, so a replayed old index would
// otherwise look fine forever.
const MAX_INDEX_AGE_DAYS = 14;
const MAX_INDEX_FUTURE_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;

const DT_VERDEF = 0x6ffffffc;
const DT_VERDEFNUM = 0x6ffffffd;
const DT_VERNEED = 0x6ffffffe;
const DT_VERNEEDNUM = 0x6fffffff;
const VER_FLG_BASE = 1;

// What the Android linker can resolve on a Shelly device: the bionic system
// libraries, plus what LibExtractor.kt puts in $SHELLY_LIB_DIR. A package that
// starts needing anything else would only fail on the device, so stop here.
const ALLOWED_NEEDED = new Set([
  'libc.so',
  'libdl.so',
  'libm.so',
  'liblog.so',
  'libc++_shared.so',
  'libssl.so.3',
  'libcrypto.so.3',
]);
const ANDROID_LINKER = '/system/bin/linker64';
// Libraries whose symbol versions we can check, because Shelly ships them. A
// binary built against a newer OPENSSL_3.x loads fine by name and dies at start,
// and the APK-bundled route has no device probe in front of it.
const JNI_LIBS = path.join(__dirname, '..', 'modules/terminal-emulator/android/src/main/jniLibs/arm64-v8a');
const BUNDLED_VERSIONED_LIBS = { 'libssl.so.3': 'libssl3.so', 'libcrypto.so.3': 'libcrypto3.so' };

// The two binaries, under the names the Shelly launchers and installers expect.
// `codex_tui` is not a Termux name: every launcher, the APK's libcodex_tui.so
// mapping and the `current/codex_tui` health check use it, and devices already
// hold that layout.
const PAYLOAD_BINARIES = [
  { from: `${DEB_PREFIX}/bin/codex`, to: 'codex_tui' },
  { from: `${DEB_PREFIX}/bin/codex-code-mode-host`, to: 'codex-code-mode-host' },
];
const PAYLOAD_NOTICES = [
  { from: `${DEB_PREFIX}/share/doc/codex/LICENSE`, to: 'LICENSE' },
  { from: `${DEB_PREFIX}/share/doc/codex/NOTICE`, to: 'NOTICE' },
];

class TrustError extends Error {}
// The signature itself failed. Nothing built on that index can be believed, so
// unlike staleness this stops every command.
class SignatureError extends TrustError {}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// Termux versions look like 0.167.0 or, with a packaging revision, 0.167.0-1.
function parseDebVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(String(text));
  if (!m) return null;
  return {
    text: String(text),
    upstream: `${m[1]}.${m[2]}.${m[3]}`,
    parts: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] || 0)],
  };
}

function compareDebVersions(a, b) {
  for (let i = 0; i < 4; i += 1) {
    if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i];
  }
  return 0;
}

// gpgv writes the cleartext even when it cannot check the signature, so its
// output means nothing until both the exit code and VALIDSIG agree. The text
// handed on is gpgv's own, never the input: anything around the signed block of
// a clearsigned file is unsigned and could say whatever it likes.
function verifyInRelease(signedText, { keyring = KEYRING, fingerprints = TERMUX_SIGNING_FINGERPRINTS, gpgv = 'gpgv' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-apt-'));
  try {
    fs.writeFileSync(path.join(dir, 'InRelease'), signedText);
    fs.copyFileSync(keyring, path.join(dir, 'keyring.gpg'));
    const result = childProcess.spawnSync(
      gpgv,
      ['--keyring', './keyring.gpg', '--status-fd', '1', '--output', 'clear', 'InRelease'],
      { cwd: dir, encoding: 'utf8' },
    );
    if (result.error) throw new SignatureError(`cannot run gpgv: ${result.error.message}`);
    if (result.status !== 0) {
      throw new SignatureError(`InRelease signature did not verify (gpgv exit ${result.status})`);
    }
    const signers = [];
    for (const line of String(result.stdout).split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields[0] === '[GNUPG:]' && fields[1] === 'VALIDSIG') {
        // Field 2 is the signing key, the last is its primary key.
        signers.push(fields[2], fields[fields.length - 1]);
      }
    }
    if (!signers.some((fingerprint) => fingerprints.includes(fingerprint))) {
      throw new SignatureError(`InRelease is not signed by a pinned key (saw ${signers.join(', ') || 'none'})`);
    }
    return fs.readFileSync(path.join(dir, 'clear'), 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function parseInRelease(text) {
  const fields = {};
  const sha256Files = new Map();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line)) {
      if (section === 'SHA256') {
        const [hash, size, name] = line.trim().split(/\s+/);
        if (hash && size && name) sha256Files.set(name, { sha256: hash, size: Number(size) });
      }
      continue;
    }
    const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
    if (m) {
      section = m[1];
      fields[m[1]] = m[2];
    }
  }
  return { fields, sha256Files };
}

function checkReleaseFields(fields, now, maxAgeDays = MAX_INDEX_AGE_DAYS) {
  if (fields.Suite !== SUITE || fields.Codename !== SUITE) {
    throw new TrustError(`unexpected suite ${fields.Suite}/${fields.Codename}`);
  }
  if (!String(fields.Origin || '').startsWith('termux-main')) {
    throw new TrustError(`unexpected origin "${fields.Origin}"`);
  }
  const date = Date.parse(fields.Date);
  if (!Number.isFinite(date)) throw new TrustError(`cannot read InRelease date "${fields.Date}"`);
  if (date > now + MAX_INDEX_FUTURE_MS) throw new TrustError(`InRelease is dated in the future (${fields.Date})`);
  if (now - date > maxAgeDays * 24 * 60 * 60 * 1000) {
    throw new TrustError(`InRelease is older than ${maxAgeDays} days (${fields.Date})`);
  }
}

function parsePackages(text) {
  const stanzas = [];
  for (const block of text.split(/\n\n+/)) {
    const stanza = {};
    for (const line of block.split('\n')) {
      const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
      if (m) stanza[m[1]] = m[2];
    }
    if (stanza.Package) stanzas.push(stanza);
  }
  return stanzas;
}

function newestPackage(stanzas, name = PACKAGE_NAME) {
  let best = null;
  for (const stanza of stanzas) {
    if (stanza.Package !== name) continue;
    const version = parseDebVersion(stanza.Version);
    if (!version) throw new TrustError(`unrecognized ${name} version "${stanza.Version}"`);
    if (stanza.Architecture !== 'aarch64') continue;
    if (!best || compareDebVersions(version, best.version) > 0) best = { stanza, version };
  }
  if (!best) throw new TrustError(`no aarch64 ${name} package in the index`);
  const { stanza, version } = best;
  const size = Number(stanza.Size);
  if (!/^[a-f0-9]{64}$/.test(String(stanza.SHA256)) || !Number.isSafeInteger(size) || size <= 0) {
    throw new TrustError(`${name} ${version.text} has no usable SHA256/Size`);
  }
  if (!/^pool\/main\/[a-z0-9]+\/[a-z0-9+.-]+\/[A-Za-z0-9+.~_-]+\.deb$/.test(String(stanza.Filename))) {
    throw new TrustError(`${name} ${version.text} has an unexpected Filename "${stanza.Filename}"`);
  }
  return {
    package: name,
    version: version.text,
    upstreamVersion: version.upstream,
    filename: stanza.Filename,
    size,
    sha256: stanza.SHA256,
  };
}

// True when the pin moves, false when it stands. Same version with another hash
// and a lower version are both attacks or accidents; neither is a bump.
function decideBump(pin, entry) {
  const pinned = parseDebVersion(pin.version);
  const latest = parseDebVersion(entry.version);
  if (!pinned || !latest) throw new TrustError(`bad versions: pin ${pin.version}, index ${entry.version}`);
  const order = compareDebVersions(latest, pinned);
  if (order < 0) throw new TrustError(`index version ${entry.version} is older than the pin ${pin.version}`);
  if (order === 0) {
    if (entry.sha256 !== pin.sha256) {
      throw new TrustError(`${entry.version} changed hash: pin ${pin.sha256}, index ${entry.sha256}`);
    }
    return false;
  }
  return true;
}

function validatePin(pin) {
  const version = parseDebVersion(pin && pin.version);
  if (!version) throw new Error(`pin has a bad version "${pin && pin.version}"`);
  if (pin.package !== PACKAGE_NAME) throw new Error(`pin is for "${pin.package}"`);
  if (pin.upstreamVersion !== version.upstream) {
    throw new Error(`pin upstreamVersion ${pin.upstreamVersion} does not match ${pin.version}`);
  }
  if (!/^[a-f0-9]{64}$/.test(String(pin.sha256))) throw new Error('pin has a bad sha256');
  if (!Number.isSafeInteger(pin.size) || pin.size <= 0) throw new Error('pin has a bad size');
  if (!String(pin.filename).startsWith('pool/main/c/codex/') || !pin.filename.endsWith('.deb') || pin.filename.includes('..')) {
    throw new Error(`pin has an unexpected filename "${pin.filename}"`);
  }
  return pin;
}

// Replaces the fork's "@openai/codex must match the tag" check: codex.txt is what
// the npm dispatcher, the freeze check and `codex_tui --version` agree on, and
// it is the upstream part of the Debian version, revision dropped.
function checkPinMatchesCodexTxt(pin, codexTxt) {
  validatePin(pin);
  const codex = String(codexTxt).trim();
  if (codex !== pin.upstreamVersion) {
    throw new Error(`.ci-versions/codex.txt says ${codex} but the Termux pin is ${pin.version} (upstream ${pin.upstreamVersion})`);
  }
}

function needsPublish(manifest, pin) {
  if (!manifest) return true;
  return !(manifest.source === 'termux-apt'
    && manifest.codexTermuxVersion === pin.version
    && manifest.debSha256 === pin.sha256);
}

function runtimeManifest({ pin, assetName, tarballUrl, sha256: tarSha, gitSha, runId, runNumber, createdAt }) {
  return {
    schemaVersion: 2,
    channel: 'codex-runtime-latest',
    source: 'termux-apt',
    // Must equal what `codex_tui --version` prints: the installers refuse a
    // mismatch, and that is the upstream version, never a Debian revision.
    version: pin.upstreamVersion,
    codexVersion: pin.upstreamVersion,
    codexTermuxVersion: pin.version,
    debSha256: pin.sha256,
    gitSha,
    runId,
    runNumber,
    createdAt,
    assetName,
    tarballUrl,
    sha256: tarSha,
  };
}

// ---- ELF ------------------------------------------------------------------

function readElfInfo(buffer) {
  if (buffer.length < 64 || buffer.readUInt32BE(0) !== 0x7f454c46) throw new Error('not an ELF file');
  if (buffer[4] !== 2 || buffer[5] !== 1) throw new Error('not a little-endian ELF64');
  const type = buffer.readUInt16LE(16);
  const machine = buffer.readUInt16LE(18);
  const phoff = Number(buffer.readBigUInt64LE(32));
  const phentsize = buffer.readUInt16LE(54);
  const phnum = buffer.readUInt16LE(56);
  const loads = [];
  let interp = null;
  let dynamic = null;
  for (let i = 0; i < phnum; i += 1) {
    const at = phoff + i * phentsize;
    const pType = buffer.readUInt32LE(at);
    const offset = Number(buffer.readBigUInt64LE(at + 8));
    const vaddr = Number(buffer.readBigUInt64LE(at + 16));
    const filesz = Number(buffer.readBigUInt64LE(at + 32));
    if (pType === 1) loads.push({ offset, vaddr, filesz });
    if (pType === 2) dynamic = { offset, filesz };
    if (pType === 3) interp = buffer.toString('latin1', offset, offset + filesz).replace(/\0+$/, '');
  }
  const toOffset = (vaddr) => {
    const load = loads.find((seg) => vaddr >= seg.vaddr && vaddr < seg.vaddr + seg.filesz);
    if (!load) throw new Error(`address 0x${vaddr.toString(16)} is not in a PT_LOAD segment`);
    return vaddr - load.vaddr + load.offset;
  };
  const neededOffsets = [];
  let strtab = null;
  let verneed = null;
  let verneedNum = 0;
  let verdef = null;
  let verdefNum = 0;
  if (dynamic) {
    for (let at = dynamic.offset; at < dynamic.offset + dynamic.filesz; at += 16) {
      const tag = Number(buffer.readBigInt64LE(at));
      const value = Number(buffer.readBigUInt64LE(at + 8));
      if (tag === 0) break;
      if (tag === 1) neededOffsets.push(value);
      if (tag === 5) strtab = toOffset(value);
      if (tag === DT_VERNEED) verneed = toOffset(value);
      if (tag === DT_VERNEEDNUM) verneedNum = value;
      if (tag === DT_VERDEF) verdef = toOffset(value);
      if (tag === DT_VERDEFNUM) verdefNum = value;
    }
  }
  const text = (offset) => {
    if (strtab === null) throw new Error('dynamic string reference without DT_STRTAB');
    const start = strtab + offset;
    return buffer.toString('latin1', start, buffer.indexOf(0, start));
  };
  const needed = neededOffsets.map(text);

  // .gnu.version_r: library -> version names this binary asks for.
  const requiredVersions = {};
  for (let i = 0, at = verneed; i < verneedNum; i += 1) {
    const library = text(buffer.readUInt32LE(at + 4));
    const names = requiredVersions[library] || (requiredVersions[library] = []);
    let aux = at + buffer.readUInt32LE(at + 8);
    for (let j = buffer.readUInt16LE(at + 2); j > 0; j -= 1) {
      names.push(text(buffer.readUInt32LE(aux + 8)));
      aux += buffer.readUInt32LE(aux + 12);
    }
    at += buffer.readUInt32LE(at + 12);
  }
  // .gnu.version_d: the version names this library defines. The BASE entry is
  // the library's own soname, not a version anything can require.
  const definedVersions = [];
  for (let i = 0, at = verdef; i < verdefNum; i += 1) {
    if ((buffer.readUInt16LE(at + 2) & VER_FLG_BASE) === 0) {
      definedVersions.push(text(buffer.readUInt32LE(at + buffer.readUInt32LE(at + 12))));
    }
    at += buffer.readUInt32LE(at + 16);
  }
  return { type, machine, interp, needed, requiredVersions, definedVersions };
}

function bundledLibraryVersions(dir = JNI_LIBS) {
  const versions = {};
  for (const [soname, file] of Object.entries(BUNDLED_VERSIONED_LIBS)) {
    versions[soname] = readElfInfo(fs.readFileSync(path.join(dir, file))).definedVersions;
    if (versions[soname].length === 0) throw new Error(`${file} defines no symbol versions`);
  }
  return versions;
}

function checkAndroidBinary(buffer, label, libraryVersions = bundledLibraryVersions()) {
  const info = readElfInfo(buffer);
  const problems = [];
  if (info.machine !== 183) problems.push(`machine ${info.machine} is not aarch64`);
  // ET_EXEC is exactly what bionic's linker refuses (`unexpected e_type: 2`).
  if (info.type !== 3) problems.push(`type ${info.type} is not PIE`);
  if (info.interp !== ANDROID_LINKER) problems.push(`interpreter ${info.interp} is not ${ANDROID_LINKER}`);
  const unknown = info.needed.filter((name) => !ALLOWED_NEEDED.has(name));
  if (unknown.length > 0) problems.push(`needs libraries Shelly does not ship: ${unknown.join(', ')}`);
  for (const [library, defined] of Object.entries(libraryVersions)) {
    const missing = (info.requiredVersions[library] || []).filter((name) => !defined.includes(name));
    if (missing.length > 0) {
      problems.push(`needs ${missing.join(', ')} from ${library}, which Shelly's copy does not define (${defined.join(', ')})`);
    }
  }
  if (problems.length > 0) throw new Error(`${label}: ${problems.join('; ')}`);
  return info;
}

// ---- .deb -----------------------------------------------------------------

function arMembers(buffer) {
  if (buffer.toString('latin1', 0, 8) !== '!<arch>\n') throw new Error('not an ar archive');
  const members = new Map();
  let at = 8;
  while (at + 60 <= buffer.length) {
    const name = buffer.toString('latin1', at, at + 16).trim().replace(/\/$/, '');
    const size = Number(buffer.toString('latin1', at + 48, at + 58).trim());
    if (!Number.isSafeInteger(size) || size < 0 || at + 60 + size > buffer.length) {
      throw new Error(`bad ar member header for "${name}"`);
    }
    members.set(name, buffer.subarray(at + 60, at + 60 + size));
    at += 60 + size + (size % 2);
  }
  return members;
}

function regularFile(root, relative) {
  const file = path.join(root, ...relative.split('/'));
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) throw new Error(`${relative} is missing from the package, or not a regular file`);
  return file;
}

// Writes the runtime payload: the two binaries under Shelly's names, the license
// texts the redistribution needs, and files.sha256.json.
function extractPayload(debBuffer, outDir) {
  const data = arMembers(debBuffer).get('data.tar.xz');
  if (!data) throw new Error('no data.tar.xz in the .deb');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-deb-'));
  try {
    fs.writeFileSync(path.join(work, 'data.tar.xz'), data);
    fs.mkdirSync(path.join(work, 'root'));
    // cwd + relative names: GNU tar reads "C:\..." as host:path.
    const result = childProcess.spawnSync('tar', ['-xJf', '../data.tar.xz'], {
      cwd: path.join(work, 'root'),
      encoding: 'utf8',
    });
    if (result.error || result.status !== 0) {
      throw new Error(`tar failed: ${result.error ? result.error.message : result.stderr}`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const hashes = {};
    for (const { from, to } of PAYLOAD_BINARIES) {
      const body = fs.readFileSync(regularFile(path.join(work, 'root'), from));
      const info = checkAndroidBinary(body, from);
      console.log(`[codex-apt] ${to}: ${body.length} bytes, needs ${info.needed.join(', ') || 'nothing'}`);
      fs.writeFileSync(path.join(outDir, to), body, { mode: 0o755 });
      hashes[to] = sha256(body);
    }
    for (const { from, to } of PAYLOAD_NOTICES) {
      const body = fs.readFileSync(regularFile(path.join(work, 'root'), from));
      fs.writeFileSync(path.join(outDir, to), body, { mode: 0o644 });
      hashes[to] = sha256(body);
    }
    const sorted = Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(path.join(outDir, 'files.sha256.json'), `${JSON.stringify(sorted, null, 2)}\n`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---- network --------------------------------------------------------------

async function httpGet(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Shelly-CI' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Walks the chain on one mirror. TrustError means a mirror served something
// wrong and stops everything; a plain Error (network, 404) tries the next one.
async function resolveLatest({ mirrors = MIRRORS, now = Date.now(), get = httpGet, verify = verifyInRelease } = {}) {
  let lastError = null;
  for (const base of mirrors) {
    try {
      const inRelease = await get(`${base}/dists/${SUITE}/InRelease`);
      const { fields, sha256Files } = parseInRelease(verify(inRelease));
      checkReleaseFields(fields, now);
      const listed = sha256Files.get(PACKAGES_PATH);
      if (!listed) throw new TrustError(`${PACKAGES_PATH} is not in InRelease`);
      const packagesGz = await get(`${base}/dists/${SUITE}/${PACKAGES_PATH}`);
      if (packagesGz.length !== listed.size || sha256(packagesGz) !== listed.sha256) {
        throw new TrustError(`${PACKAGES_PATH} does not match InRelease`);
      }
      const entry = newestPackage(parsePackages(zlib.gunzipSync(packagesGz).toString('utf8')));
      console.log(`[codex-apt] ${base}: ${fields.Date}, ${entry.package} ${entry.version}`);
      return entry;
    } catch (error) {
      if (error instanceof TrustError) throw error;
      lastError = error;
      console.log(`[codex-apt] ${base}: ${error.message}`);
    }
  }
  throw lastError || new Error('no mirror configured');
}

async function fetchDeb(pin, { mirrors = MIRRORS, archiveBase = '', get = httpGet } = {}) {
  const sources = mirrors.map((base) => `${base}/${pin.filename}`);
  if (archiveBase) sources.push(`${archiveBase.replace(/\/$/, '')}/${path.posix.basename(pin.filename)}`);
  let lastError = null;
  for (const url of sources) {
    try {
      const body = await get(url);
      if (body.length === pin.size && sha256(body) === pin.sha256) {
        console.log(`[codex-apt] ${url}: size and SHA-256 match the pin`);
        return body;
      }
      // Not a TrustError: another source may hold the right file, and nothing
      // from this one is used.
      lastError = new Error(`${url}: does not match the pin`);
      console.log(`[codex-apt] ${lastError.message}`);
    } catch (error) {
      lastError = error;
      console.log(`[codex-apt] ${error.message}`);
    }
  }
  throw lastError || new Error('no .deb source configured');
}

// The pin came through the chain when it was written, and the .deb must match its
// hash whatever happens here, so this is a second opinion, not a gate. A build
// must not depend on Termux's index being fresh or still listing this version:
// only a failed signature stops it. The rest is worth seeing in the log.
async function confirmPinAgainstIndex(pin, options = {}) {
  let entry;
  try {
    entry = await resolveLatest(options);
    decideBump(pin, entry);
  } catch (error) {
    if (error instanceof SignatureError) throw error;
    console.log(`::warning title=Termux Codex::index not confirmed, relying on the committed hash: ${error.message}`);
    return 'unconfirmed';
  }
  if (entry.version === pin.version) {
    console.log(`[codex-apt] pin ${pin.version} confirmed by the signed index`);
    return 'confirmed';
  }
  console.log(`[codex-apt] index moved to ${entry.version}, relying on the committed hash of ${pin.version}`);
  return 'moved';
}

function npmHasCodex(version) {
  const result = childProcess.spawnSync('npm', ['view', `@openai/codex@${version}`, 'version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return String(result.stdout || '').trim() === version;
}

// ---- commands -------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// Moves nothing in the repository. The candidate goes to a file for the job to
// verify first; only then does it replace the channel pin.
async function runBump(args, { resolve = resolveLatest } = {}) {
  const pin = validatePin(readJson(args.pin));
  const entry = await resolve();
  const changed = decideBump(pin, entry);
  writeJson(args.candidate, changed ? { ...entry, verifiedAt: new Date().toISOString() } : pin);
  const lines = [`changed=${changed}`, `version=${entry.version}`];
  console.log(lines.join(' '));
  if (args['github-output']) fs.appendFileSync(args['github-output'], `${lines.join('\n')}\n`);
}

// The reviewed step that moves what agents run: run it, read the diff, open a PR.
// The APK also bundles the npm dispatcher of this version, so it must exist.
function runPromote(args, { hasNpm = npmHasCodex } = {}) {
  const channel = validatePin(readJson(args.channel));
  if (!hasNpm(channel.upstreamVersion)) {
    throw new Error(`@openai/codex@${channel.upstreamVersion} is not on npm yet`);
  }
  writeJson(args.pin, channel);
  fs.writeFileSync(args['codex-txt'], `${channel.upstreamVersion}\n`);
  console.log(`bundled pin is now ${channel.version}`);
}

async function runFetch(args, options = {}) {
  const pin = validatePin(readJson(args.pin));
  await confirmPinAgainstIndex(pin, options);
  const deb = await fetchDeb(pin, { archiveBase: args['archive-base'], ...options });
  extractPayload(deb, args['out-dir']);
  if (args['keep-deb']) fs.writeFileSync(args['keep-deb'], deb);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case 'check-pin':
      checkPinMatchesCodexTxt(readJson(args.pin), fs.readFileSync(args['codex-txt'], 'utf8'));
      console.log('pin and codex.txt agree');
      return;
    case 'bump':
      await runBump(args);
      return;
    case 'fetch':
      await runFetch(args);
      return;
    case 'promote':
      runPromote(args);
      return;
    case 'manifest':
      writeJson(args.out, runtimeManifest({
        pin: validatePin(readJson(args.pin)),
        assetName: args.asset,
        tarballUrl: args.url,
        sha256: args.sha256,
        gitSha: process.env.GITHUB_SHA,
        runId: Number(process.env.GITHUB_RUN_ID),
        runNumber: Number(process.env.GITHUB_RUN_NUMBER),
        createdAt: new Date().toISOString(),
      }));
      return;
    case 'published': {
      const manifest = args.manifest && fs.existsSync(args.manifest) ? readJson(args.manifest) : null;
      console.log(needsPublish(manifest, validatePin(readJson(args.pin))) ? 'behind' : 'current');
      return;
    }
    default:
      throw new Error(`unknown command "${command}"`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.log(`::error title=Termux Codex::${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  ALLOWED_NEEDED,
  SignatureError,
  TERMUX_SIGNING_FINGERPRINTS,
  TrustError,
  arMembers,
  bundledLibraryVersions,
  checkAndroidBinary,
  checkPinMatchesCodexTxt,
  checkReleaseFields,
  compareDebVersions,
  confirmPinAgainstIndex,
  decideBump,
  extractPayload,
  fetchDeb,
  needsPublish,
  newestPackage,
  parseDebVersion,
  parseInRelease,
  parsePackages,
  readElfInfo,
  resolveLatest,
  runBump,
  runFetch,
  runPromote,
  runtimeManifest,
  sha256,
  validatePin,
  verifyInRelease,
};
