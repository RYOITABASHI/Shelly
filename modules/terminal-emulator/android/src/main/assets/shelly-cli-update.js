#!/usr/bin/env node
// Device-side installer and updater for the two CLIs Shelly must not bundle:
// Claude Code and the Antigravity CLI. Shelly neither hosts nor redistributes
// them: the device fetches the vendors' own files, unmodified.
//
//   claude   Anthropic's bucket. manifest.json must carry a detached OpenPGP
//            signature from the key pinned below; its SHA-256 and size then
//            bind the binary.
//   glibc    Termux's termux-glibc repository, by apt's own chain, as in
//            scripts/codex-termux-apt.js but with no gpgv:
//            pinned key -> signed InRelease -> Packages.gz -> .deb -> files.
//            xz is decoded here: a device has no xz we can rely on.
//   agy      Google's Android manifest (URL allowlist + SHA-512). There is no
//            signature to check, only HTTPS, so the version it names is never
//            allowed to go backwards without a person asking.
//
// Layout (plan 6.1), one per CLI under ~/.shelly-runtime/<dir>/:
//   versions/<version>-<sha8>/  immutable once promoted
//   current -> versions/...     what the terminal starts
//   previous -> versions/...    the one before
//   agent-current -> ...        claude only; see REVIEWED_CLAUDE
//   state.json                  channel, last check, failed versions
//   leases/<pid>                a running claude's real version directory
//
// Promotion is a symlink rename. A running TUI resolved `current` to its real
// directory before it started, so it never notices. A version is deleted only
// when no link names it and nothing is running from it.
//
// Agy is never executed here, by any path. Google's terms (plan 5.4) leave open
// whether a third-party tool may start the CLI, and an automatic probe would be
// exactly that. Its check is the checksum plus reading the ELF header.
//
// Exit 0 = done, 1 = failure, 2 = usage.

'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const zlib = require('zlib');

// ─── What agents may run ────────────────────────────────────────────────────
// `current` follows the channel for the person at the terminal. A worker's
// safety rests on flags and stream-json details a --version probe cannot see, so
// it stays on the build the driver was reviewed against. This moves only by a
// reviewed commit, in lockstep with the same constant in shelly-agent-driver.js
// (a test holds them equal). `claude-install --agent` is the only thing that
// points agent-current anywhere, and only ever at this build: no update moves it.
const REVIEWED_CLAUDE = {
  version: '2.1.314',
  sha256: 'a66c0a8f5d0c87a439953d797985192bbcbaefbce2e0d7b2eaa8df30ef0f3ef2',
  size: 297067016,
};

const CLAUDE_BASE = 'https://downloads.claude.ai/claude-code-releases';
const CLAUDE_PLATFORM = 'linux-arm64';
// Every host this script talks to, for the first request and for any redirect.
// None of them redirected on 2026-11-07. A checksum still decides what is
// installed, but no page should be able to send the device elsewhere.
const ALLOWED_HOSTS = new Set([
  'downloads.claude.ai',
  'storage.googleapis.com',
  'packages-cf.termux.dev',
  'packages.termux.dev',
  'antigravity-cli-auto-updater-974169037036.us-central1.run.app',
]);
const CLAUDE_CHANNELS = ['latest', 'stable'];
const AGY_MANIFEST_URL = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json';
const AGY_URL_ORIGIN = 'https://storage.googleapis.com';
const AGY_URL_PATH = '/antigravity-public/';
const TERMUX_GLIBC_MIRRORS = [
  'https://packages-cf.termux.dev/apt/termux-glibc',
  'https://packages.termux.dev/apt/termux-glibc',
];
const TERMUX_GLIBC_DIST = 'dists/glibc';
const TERMUX_GLIBC_PACKAGES = 'stable/binary-aarch64/Packages.gz';
const TERMUX_GLIBC_LIB_PREFIX = 'data/data/com.termux/files/usr/glibc/lib/';
// What ran on the device since S1, by name. claude itself needs only the first
// six; the rest may be dlopen'd, which only running it could rule out.
const GLIBC_REQUIRED = [
  'ld-linux-aarch64.so.1', 'libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0',
  'librt.so.1', 'libresolv.so.2', 'libgcc_s.so.1', 'libstdc++.so.6',
];
// gcc-libs-glibc also carries Fortran, Go and D runtimes, 120 MB nobody here needs.
const TERMUX_GLIBC_PACKAGES_WANTED = [
  { name: 'glibc', files: /^(?:ld-linux-aarch64\.so\.1|lib[A-Za-z0-9_+.-]+\.so(?:\.[0-9]+)+)$/ },
  { name: 'gcc-libs-glibc', files: /^(?:libgcc_s\.so\.1|libstdc\+\+\.so\.6)$/ },
];

const KB = 1024;
const MB = 1024 * KB;
const LIMITS = {
  versionText: 64,
  manifest: 256 * KB,
  signature: 16 * KB,
  inRelease: MB,
  packagesGz: 4 * MB,
  packages: 32 * MB,
  deb: 64 * MB,
  xzOutput: 256 * MB,
  glibcFiles: 128 * MB,
  agyManifest: 64 * KB,
  agyArchive: 300 * MB,
  agyExpanded: 600 * MB,
  claudeBinary: 800 * MB,
};
const SPACE_MARGIN = 500 * MB;
const AGY_SPACE = 400 * MB;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PROBE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const PROBE_HOLD_AFTER = 2;
// Generous: this also runs at app start, while the phone is busy. Running out of
// time says nothing about the version; see probeClaude.
const PROBE_TIMEOUT_MS = 120 * 1000;
const NETWORK_IDLE_MS = 60 * 1000;
const LOCK_FRESH_MS = 60 * 1000;
const ANDROID_LINKER = '/system/bin/linker64';

// fingerprint 31DD DE24 DDFA B679 F42D 7BD2 BAA9 29FF 1A7E CACE, the key Anthropic
// documents for release manifests (https://downloads.claude.ai/keys/claude-code.asc).
const CLAUDE_KEY_FINGERPRINT = '31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE';
const CLAUDE_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGnK73ABEACnbytJXkjweYrwIr0aLEFRlH+C0nF44KxFc7gQmJ6PjSPMGZAD
dxZcaixU7zZl8WxEpVO0wLmIH8cf2zGOdyuZg1Yaugk1vHb2b8WBhAGCQJdPgB8W
XquedepEYtk56uP/gCoTjJDUZluEGBHnlnuujSJ4orxEdhSykEoAUfJZGEILPpMd
bphFt/Sn+Eb/TxM5jpKPdwnv8AShNF/1mZU1fWTQq9tRKJUakZj04gdaDFElQXak
CtTij+GT6yoYCARSHwGO+PC/Pr6q4tc+D7LRjxSBvUWDoFSmlqb/PJ1hj9D/7I2O
e4XXniAPWMR56KvxHlzOzrNQdJujbJdSkCwh1ZijkSd3y8ayW5WYUTGdRab99NUw
agzlabe/VVF6kzJ0Scn5q3PihB2Y9Bwo0CKnkYk7a7KT77EWv0Kkq+VHmOtqX3a2
hhX+b6a6ve9rzJ1qZYGj+obv/C3Sx1LzUjAfqVy7RJDf2uAoP5t2g8u/TkSpUxhM
VEjZBkSxYZhMyzQM6t8IgkUfnSrIPTHixbDWARZ4beMOBjxyPZK1nP7OOrNR3TkK
JtwLMQAabURCDnL0PjS0iwBTU4jtumBD1XSULyWuoTvMljrpQr1nV1oDyOt0OLqa
KA2McWtd9PdXhC8y2EIg7TmrTlJLfHYbdmkiCYj4J49Q8HWkN/6WE+RTUwARAQAB
tD5BbnRocm9waWMgQ2xhdWRlIENvZGUgUmVsZWFzZSBTaWduaW5nIDxzZWN1cml0
eUBhbnRocm9waWMuY29tPokCUQQTAQoAOxYhBDHd3iTd+rZ59C170rqpKf8afsrO
BQJpyu9wAhsPBQsJCAcCAiICBhUKCQgLAgQWAgMBAh4HAheAAAoJELqpKf8afsrO
l5IP/2I8X1dFy5xYczWB/coIxGjuzS/V6ByZGZZEJsbr04pmuHiFUykJqPGWGQ6q
U0YF5iEwvEkaagS5m7DzhSEf3FM3Cgafax/6d70tar9Vr1D+w6uPfxetu7u/WYJp
aolIsdh5fTrBh9zSM1Njl8FM8wG8CwZQjS33Oa7d8cwRkgdUWbt6LXgz+cTQNuBn
BgW6Ks7oZFI25dfu0ojDR+aDFJg4+4wZoyDLPvJz1SIrJ5WFGs67zsx9SfS3yZnf
XKmBe+f0dUy+GJ2nFZrXFf99+c0dPEHYO8DCeAHZizjkFrdYtUHdDU0YDYEGkLJa
bE+pgcpkHf5EvsZzHsyDbl95W/eh7pcXMbwkN+W4CBYUE9X4uHhqzWaC5yAVRWUA
1BJ9V4LjZfHPLEJt0I3TxzXiEg9/BVeaTYq9RjaxIFo9Nfk158HqJY6SA5jslBlx
Gv/No8u+xVcze2UJyGVfEIUfm92+0UAIkny3+5cuVV0ICzJxXlXj0CnLM9Lt50wE
p3suVwuBEviCbZ08eAH1Ht8gbBdSsiOkIU8CX3v/scwHHx5q0+NBL6xLrQObg13a
tRXBlKObfElkPN3lTUbUnJOW4U8uSjH8VRP+AujKWMDFe7x0zCs+iYY1mTOvbrTS
9n3CmZUmbynZ+E/QWNENpW/pDNZdWFy43PASmML5FHu4m9Sn
=oqMI
-----END PGP PUBLIC KEY BLOCK-----`;

// scripts/termux-autobuilds.gpg, the key that signs termux-main and, as observed
// on 2026-11-07, termux-glibc. A rotation stops installs on purpose.
const TERMUX_KEY_FINGERPRINT = 'CC72CF8BA7DBFA0182877D045A897D96E57CF20C';
const TERMUX_KEY_BASE64 = 'mQINBFx8VwQBEADIGHsW2eg/jGVae9T4BTBddjGC/vBpSTFD7iIT6m/9GjQvDuyJFxislu35UVUQLyx7nUVXYeyqABUJ+rclS2JXzZAElr+Ht98svkQN1EaWAEbXoS2NdDqcwbWX3rRrx9Bis/vrb8QUE74eNA6SdiIbO7t0Zbz6fFiI19EBf587zIaWO6v8lYmr5R3rLqPZqegeUn68a5ooF0Kggs+V0v+cTf6aTJTOC9Vl7dA8e8MTBswOAIg3El3hTrB5Gf4gZdJ+nhtaTiw6NNs9YVGmrMGl9WlLsAGw52FaB+vJ9QLfD58tnD0f/XRAnzK2davuLlwKDyNF33uROaPu5fQjQBMX8AuOp1DVlVvmqNKFg/rtk/zqwA3033ZYs3sKCsgZ8AENcrMfNLxT5HO3N+LBdvHSNYfCWJTIVkOsfYplXHo8NhvdMgJAYwd0XswbfV8Z8rHjP8CeXmip7VLhAH0jBpGUdDAFEZPW6HaDphDRL8FKUDTJ3WvD5ukPU4HkCaMHybebhis4Jdw1aTFWZOJtS6ntR1hyH56RLcCRBIUaDiU8zhlCAAq23ssxKaUqobbLxguWJDNH6Mv8PxXp0D85CpIA+18gUePm8b/7Ub/SkHnhZGVHlNyR1O9e/bjVfKWINpGc6jN/02k5+OLx7TCWq+Y3E7r0lNigU+mA/S7sQwrglwARAQABtD5UZXJtdXggUmVsZWFzZXMgKFRlcm11eCBhdXRvbWF0aWMgYnVpbGRzKSA8Y29udGFjdEB0ZXJtdXguZGV2PokCTAQTAQoANhYhBMxyz4un2/oBgod9BFqJfZblfPIMBQJiwApbAhsDBAsJCAcEFQoJCAUWAgMBAAIeAQIXgAAKCRBaiX2W5XzyDOCVD/9wkBapV8Uh4QtOGAtLzPzQxt6QhOYLHLp/fYdMCF+QM1okUdXvpy2gLHJF5V36oJlMq+MlaJRxZEqb6L+A4hMySIxkUbUvWOfO3dq2B9HreZt5W4e4dRPYHy/KL8O3phucu6MbV39yuxnY6SP9eVvXE6H1stOezrTvMRT03bA5j6YV1sNBViSJRQVBkCfSkxe1nSsrVdeph19pkILj9IOOpnL3S1M+oimstqOL7kuW014o5xnZmRzguXvj72JinJOx3Op+e/HvhBa3BS5qp1IJ0z7S0fG0OwiPBslh9rCLZs/83OQdBo5F8SaoRYtRn4rF8zVP7zKNAVMe6Z6fhyvUuxPX+MR66qwoan2LOCjTMu2dzx44Lb/cSLoL7YgvzMZ4LYx4w04LidpFg1FkdgEdrC4lLBJ3gJq4BdZVZEPN8RdEcRsbXv0/SIK/OuE91JLk+pKC1PointqE6VG+OvuOMjadVvAveNU49g16w1X29VwGqsq2/+D1PiqbI2hk7E2C3GzKliO2j5YFJpRbR1dl7maN9EWHN470Qf7mpxvdJYJpCV0F54xUViIU8MclLR6OOMf8bYv26tcKv0M4HnidZxpz7wLnr5vELmTXg4ZMu/XJOsLz9AYp6+iREDUAsqvTszsCtqL0k1H+4YHtSV8ZT2X5AaqHttTyyYweEPMoookBMwQQAQgAHRYhBCx/Ka6XiR9kGanizbAHbkkLcWFrBQJiwAvDAAoJELAHbkkLcWFrEPUH/3agqn23nwXwaNRCyAFARlLk4wd3/N9P1Qn2egD1tvbw3WK7+6xDSs7YyLYv1YyVRWvBACGao/B6xoo3xqbbfEumSRk3bKet/pq7O/YXYRAyqt6OmeZBbdZqslou80myLFXReVMv6liwGsxNFDKPXWdFPF5AsC8zEBrZNF+ZAN4VGOkLlipz0UVzYd0YAI+fVRgX+T+DcmWa7xaJrUHEpgaRtph/oHV0VPw/vfOWfLFLI/Ji8IMMGyS7dOBpa3HqnFslOy1ZnX2IJYReFRdpaDgzOAQd74JNEGvvNsn0IU4jQuHgSKcqn4DXhdiXjIbye89LYqg4fULEUySopggyo0u0PlRlcm11eCBSZWxlYXNlcyAoVGVybXV4IGF1dG9tYXRpYyBidWlsZHMpIDxjb250YWN0QHRlcm11eC5vcmc+iQJMBBMBCgA2FiEEzHLPi6fb+gGCh30EWol9luV88gwFAmLACjMCGwMECwkIBwQVCgkIBRYCAwEAAh4BAheAAAoJEFqJfZblfPIMVIcP/1G0fLCjv/kzN2ioldHM66OZygxoc7Yi0fAip1WP+iUy8nPGFHQNxQOR/2l7yKGkLsNADMF/8eTr1sCXAqSrcYWaIrnTj6OIKBhgNuzloWL5B0EUkkZ2wesVeBJv8XSf9fFj6Tz8EE9eZX8RpU1B6tdzBCzeCmJFwyxzape2wudWbLL6Q+33qxDOmTn6dNkn1VgVEh+HlbahHDI1BO2n0NvTwSZ1VzBZOx5Bs45obw4yk13uy9TwQAXRi4Q9V0scMdvs8XqvoT92Z8ge15BK8yphg6grkoVWDhk5oRwwr30u50xJXjK8YM0RER+mR/hqNVVzaC8rsTp6szytGnNW92qHoX0KFshY30juxv9jUIJm9Ct24g06taawDpe7UdOc+zBw067CqnNoPWVC+ZGc02r4d6ql75T9TW9LR8jKa3HY4Mk/Jek/0Fx0QmwdDnnNvnggpyagyBzx25cfZL8bny+YiI1+q/YM18gIBm5GlGTJIOkgSucKNnsSmfDWA3VulnihCjM+n+39gAyXzbZkbu/XAUt+GhATWiD6yItLoOMblKUvPEbMWmWYV2gWtiyPPOsQjB4xflAK1szIouytp662LRjYCdl4rDSBa5L12CUcrrO/Y0ApwQqEe/EaA0lMFqSpz17G8Cv1A2lrmkTwT5TBUvQo42oDSSF5TMUuUPfNiQEzBBABCAAdFiEELH8prpeJH2QZqeLNsAduSQtxYWsFAmLAC8gACgkQsAduSQtxYWv/uwf+LH3ShzmKer9Sfo1qjPC8ieK2sSqpD6Js65ORTglm9r5mWEcPtHzo7wjjd43Lr3oU3EptkAApy1v8qpoLXkiUrhMqRt/kHQDPsJ1IUSZUu+yWXGq3GIcIPqZw97/tYE8tKrMfj4uqQCqMAcL4wef6KdRFz0jExae32f2bVvp9drDXmpRMKLvRCHd9xlbg9289WQuxou0AcLU53EFquEYr9hVmS7Ju8fEiQA3D69jKM8S75F3W4KeeRFOdKJ0dcwfReHqaMDc14vCH8MoBaAGju1a3q/oH3clHafr8x9YzLGTI3UPwPiTxx1mXv3xvpZD7F6S+59wrk0TSR5Jqu26LEA==';

// A trust failure says the bytes are not what the vendor signed. Unlike a flaky
// network it must not be retried quietly, so the version is held at once.
class TrustError extends Error {}
class ProbeError extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}
class UsageError extends Error {}
class LockBusy extends Error {}

function sha(algorithm, data) {
  return crypto.createHash(algorithm).update(data).digest('hex');
}

// ─── OpenPGP (just enough: v4 RSA keys and v4 RSA signatures) ───────────────

function decodeArmor(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((line) => /^-----BEGIN PGP [A-Z ]+-----$/.test(line.trim()));
  if (start < 0) throw new TrustError('no armor block');
  let i = start + 1;
  while (i < lines.length && lines[i].trim() !== '') i += 1;
  const body = [];
  for (i += 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line.startsWith('-----END PGP ')) break;
    if (line.startsWith('=')) continue;
    body.push(line);
  }
  if (i >= lines.length) throw new TrustError('unterminated armor block');
  return Buffer.from(body.join(''), 'base64');
}

function parsePackets(buf) {
  const packets = [];
  let o = 0;
  while (o < buf.length) {
    const first = buf[o];
    if (!(first & 0x80)) throw new TrustError('bad OpenPGP packet header');
    let tag;
    let len;
    o += 1;
    if (first & 0x40) {
      tag = first & 0x3f;
      const b = buf[o];
      if (b === undefined) throw new TrustError('truncated OpenPGP packet');
      if (b < 192) {
        len = b;
        o += 1;
      } else if (b < 224) {
        len = ((b - 192) << 8) + buf[o + 1] + 192;
        o += 2;
      } else if (b === 255) {
        if (o + 5 > buf.length) throw new TrustError('truncated OpenPGP packet');
        len = buf.readUInt32BE(o + 1);
        o += 5;
      } else {
        throw new TrustError('partial-length OpenPGP packet');
      }
    } else {
      tag = (first >> 2) & 0xf;
      const type = first & 3;
      if (type === 3) throw new TrustError('indeterminate-length OpenPGP packet');
      const size = 1 << type;
      if (o + size > buf.length) throw new TrustError('truncated OpenPGP packet');
      len = buf.readUIntBE(o, size);
      o += size;
    }
    if (o + len > buf.length) throw new TrustError('truncated OpenPGP packet');
    packets.push({ tag, body: buf.subarray(o, o + len) });
    o += len;
  }
  return packets;
}

function readMpi(buf, o) {
  if (o + 2 > buf.length) throw new TrustError('truncated OpenPGP number');
  const bits = buf.readUInt16BE(o);
  const bytes = Math.ceil(bits / 8);
  if (o + 2 + bytes > buf.length) throw new TrustError('truncated OpenPGP number');
  return { value: buf.subarray(o + 2, o + 2 + bytes), next: o + 2 + bytes };
}

function parseRsaPublicKey(keyBytes) {
  const packet = parsePackets(keyBytes).find((item) => item.tag === 6);
  if (!packet) throw new TrustError('no public key packet');
  const { body } = packet;
  if (body[0] !== 4 || body[5] !== 1) throw new TrustError('pinned key is not a v4 RSA key');
  const n = readMpi(body, 6);
  const e = readMpi(body, n.next);
  const prefix = Buffer.from([0x99, (body.length >> 8) & 0xff, body.length & 0xff]);
  const fingerprint = crypto.createHash('sha1').update(prefix).update(body).digest('hex').toUpperCase();
  const jwk = {
    kty: 'RSA',
    n: n.value.toString('base64url'),
    e: e.value.toString('base64url'),
  };
  return {
    fingerprint,
    modulusBytes: n.value.length,
    publicKey: crypto.createPublicKey({ key: jwk, format: 'jwk' }),
  };
}

function parseSubpackets(buf) {
  const out = [];
  let o = 0;
  while (o < buf.length) {
    let len = buf[o];
    o += 1;
    if (len === 255) {
      if (o + 4 > buf.length) throw new TrustError('bad signature subpacket');
      len = buf.readUInt32BE(o);
      o += 4;
    } else if (len >= 192) {
      len = ((len - 192) << 8) + buf[o] + 192;
      o += 1;
    }
    if (!(len >= 1) || o + len > buf.length) throw new TrustError('bad signature subpacket');
    out.push({ type: buf[o] & 0x7f, body: buf.subarray(o + 1, o + len) });
    o += len;
  }
  return out;
}

const HASHES = { 8: 'sha256', 10: 'sha512' };

// Exactly one packet, and it must be the signature: anything else in a .sig
// means it is not what the vendor's tooling produced.
function parseSignature(sigBytes) {
  const packets = parsePackets(sigBytes);
  if (packets.length !== 1 || packets[0].tag !== 2) throw new TrustError('expected exactly one signature packet');
  const { body } = packets[0];
  if (body.length < 8 || body[0] !== 4) throw new TrustError('unsupported signature version');
  const sigClass = body[1];
  const keyAlgo = body[2];
  const hash = HASHES[body[3]];
  if (keyAlgo !== 1) throw new TrustError('signature is not RSA');
  if (!hash) throw new TrustError('unsupported signature hash');
  const hashedLen = body.readUInt16BE(4);
  const hashedEnd = 6 + hashedLen;
  if (hashedEnd + 2 > body.length) throw new TrustError('truncated signature');
  const unhashedLen = body.readUInt16BE(hashedEnd);
  const left16At = hashedEnd + 2 + unhashedLen;
  if (left16At + 2 > body.length) throw new TrustError('truncated signature');
  const mpi = readMpi(body, left16At + 2);
  const trailer = Buffer.alloc(6);
  trailer[0] = 4;
  trailer[1] = 0xff;
  trailer.writeUInt32BE(hashedEnd, 2);
  const issuer = parseSubpackets(body.subarray(6, hashedEnd)).find((item) => item.type === 33);
  return {
    sigClass,
    hash,
    signed: Buffer.concat([body.subarray(0, hashedEnd), trailer]),
    left16: body.subarray(left16At, left16At + 2),
    mpi: mpi.value,
    issuerFingerprint: issuer ? issuer.body.subarray(1).toString('hex').toUpperCase() : null,
  };
}

function verifySignature(data, signature, key, fingerprint, sigClass) {
  if (key.fingerprint !== fingerprint) throw new TrustError('pinned key does not match its fingerprint');
  if (signature.sigClass !== sigClass) throw new TrustError('unexpected signature type');
  if (signature.issuerFingerprint && signature.issuerFingerprint !== fingerprint) {
    throw new TrustError(`signed by an unknown key ${signature.issuerFingerprint}`);
  }
  const material = Buffer.concat([data, signature.signed]);
  if (!crypto.createHash(signature.hash).update(material).digest().subarray(0, 2).equals(signature.left16)) {
    throw new TrustError('signature does not match this data');
  }
  // An MPI drops leading zero bytes; RSA verification wants the full width.
  if (signature.mpi.length > key.modulusBytes) throw new TrustError('oversized signature');
  const padded = Buffer.alloc(key.modulusBytes);
  signature.mpi.copy(padded, key.modulusBytes - signature.mpi.length);
  const ok = crypto.verify(signature.hash, material, {
    key: key.publicKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  }, padded);
  if (!ok) throw new TrustError('signature did not verify');
}

/** Detached binary-document signature, armored or raw. */
function verifyDetached(data, sigBytes, keyBytes, fingerprint) {
  const start = sigBytes.subarray(0, 32).toString('latin1');
  const raw = start.includes('-----BEGIN PGP') ? decodeArmor(sigBytes.toString('utf8')) : sigBytes;
  verifySignature(data, parseSignature(raw), parseRsaPublicKey(keyBytes), fingerprint, 0x00);
}

// Only the text inside the signed block is returned: anything around it in a
// clearsigned file is unsigned and could say whatever it likes.
function verifyClearsigned(text, keyBytes, fingerprint) {
  const lines = String(text).split('\n').map((line) => line.replace(/\r$/, ''));
  if (lines[0] !== '-----BEGIN PGP SIGNED MESSAGE-----') throw new TrustError('not a clearsigned file');
  let i = 1;
  while (i < lines.length && lines[i] !== '') {
    if (!/^Hash: /.test(lines[i])) throw new TrustError('unexpected clearsign header');
    i += 1;
  }
  const signed = [];
  for (i += 1; i < lines.length && lines[i] !== '-----BEGIN PGP SIGNATURE-----'; i += 1) {
    const line = lines[i];
    if (line.startsWith('- ')) signed.push(line.slice(2));
    else if (line.startsWith('-')) throw new TrustError('undashed line in a clearsigned file');
    else signed.push(line);
  }
  if (i >= lines.length) throw new TrustError('no signature in a clearsigned file');
  const rest = lines.slice(i);
  const end = rest.indexOf('-----END PGP SIGNATURE-----');
  if (end < 0 || rest.slice(end + 1).some((line) => line.trim() !== '')) {
    throw new TrustError('data after the signature');
  }
  const canonical = Buffer.from(signed.map((line) => line.replace(/[ \t]+$/, '')).join('\r\n'), 'utf8');
  verifySignature(
    canonical,
    parseSignature(decodeArmor(rest.slice(0, end + 1).join('\n'))),
    parseRsaPublicKey(keyBytes),
    fingerprint,
    0x01,
  );
  return signed.join('\n');
}

// ─── xz (LZMA2 only; the .deb hash already proved the bytes) ────────────────

const LZMA_STATES = 12;
const LZMA_POS_STATES = 16;
const LZMA_MATCH_MIN = 2;

// Layout of the one probability table.
const PROB_IS_MATCH = 0;
const PROB_IS_REP = PROB_IS_MATCH + (LZMA_STATES << 4);
const PROB_IS_REP_G0 = PROB_IS_REP + LZMA_STATES;
const PROB_IS_REP_G1 = PROB_IS_REP_G0 + LZMA_STATES;
const PROB_IS_REP_G2 = PROB_IS_REP_G1 + LZMA_STATES;
const PROB_IS_REP0_LONG = PROB_IS_REP_G2 + LZMA_STATES;
const PROB_POS_SLOT = PROB_IS_REP0_LONG + (LZMA_STATES << 4);
const PROB_POS_SPECIAL = PROB_POS_SLOT + (4 << 6);
const PROB_ALIGN = PROB_POS_SPECIAL + 128;
const LEN_CHOICE = 0;
const LEN_CHOICE2 = 1;
const LEN_LOW = 2;
const LEN_MID = LEN_LOW + (LZMA_POS_STATES << 3);
const LEN_HIGH = LEN_MID + (LZMA_POS_STATES << 3);
const LEN_SIZE = LEN_HIGH + 256;
const PROB_LEN = PROB_ALIGN + 16;
const PROB_REP_LEN = PROB_LEN + LEN_SIZE;
const PROB_LITERAL = PROB_REP_LEN + LEN_SIZE;

function newLzmaState() {
  return { probs: null, lc: 0, lp: 0, pb: 0, state: 0, rep: [0, 0, 0, 0] };
}

function resetLzma(lzma) {
  lzma.state = 0;
  lzma.rep = [0, 0, 0, 0];
  const size = PROB_LITERAL + (0x300 << (lzma.lc + lzma.lp));
  if (!lzma.probs || lzma.probs.length !== size) lzma.probs = new Uint16Array(size);
  lzma.probs.fill(1024);
}

function setLzmaProps(lzma, byte) {
  if (byte >= 225) throw new TrustError('bad LZMA properties');
  lzma.pb = Math.floor(byte / 45);
  const rest = byte - lzma.pb * 45;
  lzma.lp = Math.floor(rest / 9);
  lzma.lc = rest - lzma.lp * 9;
  if (lzma.lc + lzma.lp > 4) throw new TrustError('bad LZMA2 properties');
  resetLzma(lzma);
}

function growOutput(out, needed, limit) {
  if (needed > limit) throw new TrustError('xz output is over the size limit');
  if (needed <= out.length) return out;
  const next = Buffer.allocUnsafe(Math.min(limit, Math.max(out.length * 2, needed)));
  out.copy(next);
  return next;
}

/** One LZMA chunk: decodes exactly `size` bytes from input[start..end). */
function decodeLzmaChunk(lzma, input, start, end, out, firstOut, dictStart, size) {
  if (end > input.length || end - start < 5 || input[start] !== 0) throw new TrustError('bad LZMA range coder start');
  const { probs, lc, lp, pb } = lzma;
  const posMask = (1 << pb) - 1;
  const litMask = (1 << lp) - 1;
  let outPos = firstOut;
  let pos = start + 5;
  let range = 0xffffffff;
  let code = input.readUInt32BE(start + 1);
  let { state } = lzma;
  let [rep0, rep1, rep2, rep3] = lzma.rep;
  const target = outPos + size;

  const bit = (index) => {
    const p = probs[index];
    const bound = (range >>> 11) * p;
    let result;
    if (code < bound) {
      range = bound;
      probs[index] = p + ((2048 - p) >>> 5);
      result = 0;
    } else {
      range -= bound;
      code -= bound;
      probs[index] = p - (p >>> 5);
      result = 1;
    }
    if (range < 0x1000000) {
      range *= 256;
      code = code * 256 + input[pos];
      pos += 1;
    }
    return result;
  };
  const tree = (base, bits) => {
    let m = 1;
    for (let i = 0; i < bits; i += 1) m = (m << 1) | bit(base + m);
    return m - (1 << bits);
  };
  const reverse = (base, bits) => {
    let m = 1;
    let sym = 0;
    for (let i = 0; i < bits; i += 1) {
      const b = bit(base + m);
      m = (m << 1) | b;
      sym |= b << i;
    }
    return sym;
  };
  const direct = (count) => {
    let result = 0;
    for (let i = 0; i < count; i += 1) {
      range = Math.floor(range / 2);
      let b = 0;
      if (code >= range) {
        code -= range;
        b = 1;
      }
      result = result * 2 + b;
      if (range < 0x1000000) {
        range *= 256;
        code = code * 256 + input[pos];
        pos += 1;
      }
    }
    return result;
  };
  const length = (base, posState) => {
    if (bit(base + LEN_CHOICE) === 0) return tree(base + LEN_LOW + (posState << 3), 3);
    if (bit(base + LEN_CHOICE2) === 0) return 8 + tree(base + LEN_MID + (posState << 3), 3);
    return 16 + tree(base + LEN_HIGH, 8);
  };

  while (outPos < target) {
    const posState = (outPos - dictStart) & posMask;
    if (bit(PROB_IS_MATCH + (state << 4) + posState) === 0) {
      const prev = outPos > dictStart ? out[outPos - 1] : 0;
      const base = PROB_LITERAL
        + 0x300 * ((((outPos - dictStart) & litMask) << lc) + (prev >> (8 - lc)));
      let sym = 1;
      if (state >= 7) {
        if (rep0 >= outPos - dictStart) throw new TrustError('LZMA match before the dictionary');
        let matchByte = out[outPos - rep0 - 1];
        do {
          const matchBit = (matchByte >> 7) & 1;
          matchByte = (matchByte << 1) & 0xff;
          const b = bit(base + ((1 + matchBit) << 8) + sym);
          sym = (sym << 1) | b;
          if (matchBit !== b) break;
        } while (sym < 0x100);
      }
      while (sym < 0x100) sym = (sym << 1) | bit(base + sym);
      out[outPos] = sym & 0xff;
      outPos += 1;
      if (state < 4) state = 0;
      else if (state < 10) state -= 3;
      else state -= 6;
      continue;
    }
    let len;
    if (bit(PROB_IS_REP + state) !== 0) {
      if (bit(PROB_IS_REP_G0 + state) === 0) {
        if (bit(PROB_IS_REP0_LONG + (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          if (rep0 >= outPos - dictStart) throw new TrustError('LZMA match before the dictionary');
          out[outPos] = out[outPos - rep0 - 1];
          outPos += 1;
          continue;
        }
      } else {
        let distance;
        if (bit(PROB_IS_REP_G1 + state) === 0) {
          distance = rep1;
        } else {
          if (bit(PROB_IS_REP_G2 + state) === 0) {
            distance = rep2;
          } else {
            distance = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = distance;
      }
      len = length(PROB_REP_LEN, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      len = length(PROB_LEN, posState);
      state = state < 7 ? 7 : 10;
      const lenState = len < 4 ? len : 3;
      const slot = tree(PROB_POS_SLOT + (lenState << 6), 6);
      if (slot < 4) {
        rep0 = slot;
      } else {
        const footer = (slot >> 1) - 1;
        rep0 = (2 | (slot & 1)) * 2 ** footer;
        if (slot < 14) rep0 += reverse(PROB_POS_SPECIAL + rep0 - slot - 1, footer);
        else rep0 += direct(footer - 4) * 16 + reverse(PROB_ALIGN - 1, 4);
      }
      if (rep0 === 0xffffffff) throw new TrustError('LZMA end marker inside LZMA2');
    }
    len += LZMA_MATCH_MIN;
    if (rep0 >= outPos - dictStart) throw new TrustError('LZMA match before the dictionary');
    if (outPos + len > target) throw new TrustError('LZMA match past the chunk end');
    const from = outPos - rep0 - 1;
    for (let i = 0; i < len; i += 1) out[outPos + i] = out[from + i];
    outPos += len;
  }
  if (pos !== end) throw new TrustError('LZMA chunk size mismatch');
  lzma.state = state;
  lzma.rep = [rep0, rep1, rep2, rep3];
  return outPos;
}

function readVli(buf, o) {
  let value = 0;
  for (let i = 0; i < 9; i += 1) {
    const b = buf[o + i];
    if (b === undefined) throw new TrustError('truncated xz integer');
    value += (b & 0x7f) * 2 ** (7 * i);
    if (!(b & 0x80)) return { value, next: o + i + 1 };
  }
  throw new TrustError('bad xz integer');
}

const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]);
const XZ_CHECK_SIZES = [0, 4, 4, 4, 8, 8, 8, 16, 16, 16, 32, 32, 32, 64, 64, 64];

function decodeXz(input, limit = LIMITS.xzOutput) {
  if (input.length < 24 || !input.subarray(0, 6).equals(XZ_MAGIC)) throw new TrustError('not an xz stream');
  const checkSize = XZ_CHECK_SIZES[input[7] & 0xf];
  let o = 12;
  let out = Buffer.allocUnsafe(Math.min(limit, 16 * MB));
  let outPos = 0;
  while (input[o] !== 0) {
    if (o >= input.length) throw new TrustError('truncated xz stream');
    const headerSize = (input[o] + 1) * 4;
    const flags = input[o + 1];
    if ((flags & 0x3f) !== 0) throw new TrustError('unsupported xz filter chain');
    let h = o + 2;
    if (flags & 0x40) h = readVli(input, h).next;
    if (flags & 0x80) h = readVli(input, h).next;
    if (readVli(input, h).value !== 0x21) throw new TrustError('unsupported xz filter');
    o += headerSize;
    const blockStart = o;
    const lzma = newLzmaState();
    let dictStart = outPos;
    let needProps = true;
    let needDict = true;
    for (;;) {
      if (o + 1 > input.length) throw new TrustError('truncated LZMA2 stream');
      const control = input[o];
      o += 1;
      if (control === 0) break;
      if (control >= 0xe0 || control === 1) {
        needProps = true;
        needDict = false;
        dictStart = outPos;
      } else if (needDict) {
        throw new TrustError('LZMA2 stream without a dictionary reset');
      }
      if (control >= 0x80) {
        if (o + 5 > input.length) throw new TrustError('truncated LZMA2 stream');
        const size = ((control & 0x1f) * 65536) + input.readUInt16BE(o) + 1;
        const packed = input.readUInt16BE(o + 2) + 1;
        o += 4;
        const reset = (control >> 5) & 3;
        if (reset >= 2) {
          setLzmaProps(lzma, input[o]);
          o += 1;
          needProps = false;
        } else if (needProps) {
          throw new TrustError('LZMA2 chunk without properties');
        } else if (reset === 1) {
          resetLzma(lzma);
        }
        out = growOutput(out, outPos + size, limit);
        outPos = decodeLzmaChunk(lzma, input, o, o + packed, out, outPos, dictStart, size);
        o += packed;
      } else if (control <= 2) {
        if (o + 2 > input.length) throw new TrustError('truncated LZMA2 stream');
        const size = input.readUInt16BE(o) + 1;
        o += 2;
        if (o + size > input.length) throw new TrustError('truncated LZMA2 stream');
        out = growOutput(out, outPos + size, limit);
        input.copy(out, outPos, o, o + size);
        outPos += size;
        o += size;
      } else {
        throw new TrustError('bad LZMA2 control byte');
      }
    }
    o += (4 - ((o - blockStart) % 4)) % 4;
    o += checkSize;
  }
  return out.subarray(0, outPos);
}

// ─── ar, tar ────────────────────────────────────────────────────────────────

function arMember(deb, name) {
  if (deb.subarray(0, 8).toString('latin1') !== '!<arch>\n') throw new TrustError('not an ar archive');
  let o = 8;
  while (o + 60 <= deb.length) {
    const member = deb.subarray(o, o + 16).toString('latin1').trim().replace(/\/$/, '');
    const size = Number(deb.subarray(o + 48, o + 58).toString('latin1').trim());
    if (!Number.isInteger(size) || size < 0 || o + 60 + size > deb.length) throw new TrustError('bad ar member');
    if (member === name) return deb.subarray(o + 60, o + 60 + size);
    o += 60 + size + (size & 1);
  }
  throw new TrustError(`${name} missing from the package`);
}

function tarString(buf, start, len) {
  const end = buf.indexOf(0, start);
  return buf.subarray(start, end < 0 || end > start + len ? start + len : end).toString('utf8');
}

function tarNumber(buf, start, len) {
  if (buf[start] & 0x80) throw new TrustError('oversized tar entry');
  const text = tarString(buf, start, len).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new TrustError('bad tar number');
  return parseInt(text, 8);
}

function parsePax(body) {
  const out = {};
  let o = 0;
  while (o < body.length) {
    const space = body.indexOf(0x20, o);
    if (space < 0) break;
    const len = Number(body.subarray(o, space).toString('latin1'));
    if (!Number.isInteger(len) || len <= 0) throw new TrustError('bad pax header');
    const record = body.subarray(space + 1, o + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    o += len;
  }
  return out;
}

// A name with `..` or an absolute path stops the whole archive, whether or not
// it is one we wanted. An archive that tries it is not the vendor's.
function cleanTarName(name) {
  if (name.includes('\0') || name.startsWith('/')) {
    throw new TrustError(`unsafe path in archive: ${name.slice(0, 120)}`);
  }
  const parts = name.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) throw new TrustError(`unsafe path in archive: ${name.slice(0, 120)}`);
  return parts.join('/');
}

/**
 * Lists a tar held in memory. Nothing here touches the disk, so no entry can
 * write through a link: callers take file bytes by name.
 */
function readTar(buf) {
  const entries = [];
  let o = 0;
  let pendingName = null;
  let pendingLink = null;
  let pendingPax = {};
  while (o + 512 <= buf.length) {
    const header = buf.subarray(o, o + 512);
    if (header.every((b) => b === 0)) break;
    const stored = tarNumber(header, 148, 8);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : header[i];
    if (sum !== stored) throw new TrustError('bad tar header checksum');
    const type = String.fromCharCode(header[156] || 0x30);
    const size = tarNumber(header, 124, 12);
    const dataStart = o + 512;
    if (dataStart + size > buf.length) throw new TrustError('truncated tar entry');
    const data = buf.subarray(dataStart, dataStart + size);
    o = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      pendingName = tarString(data, 0, size);
    } else if (type === 'K') {
      pendingLink = tarString(data, 0, size);
    } else if (type === 'x') {
      pendingPax = parsePax(data);
    } else if (type !== 'g') {
      const magic = header.subarray(257, 262).toString('latin1');
      const prefix = magic === 'ustar' && header[345] ? tarString(header, 345, 155) : '';
      const shortName = tarString(header, 0, 100);
      const rawName = pendingPax.path || pendingName || (prefix ? `${prefix}/${shortName}` : shortName);
      const linkName = pendingPax.linkpath || pendingLink || tarString(header, 157, 100);
      pendingName = null;
      pendingLink = null;
      pendingPax = {};
      entries.push({ name: cleanTarName(rawName), type, data, linkName });
    }
  }
  return entries;
}

/**
 * The regular files under `prefix` whose base name passes `accept`, by base
 * name. A link stops being a link: it becomes a copy of a file in the same
 * directory, so nothing on disk can point anywhere. A link that reaches outside
 * that directory stops the archive.
 */
function selectTarFiles(entries, prefix, accept) {
  const isRegular = (entry) => entry.type === '0' || entry.type === '7';
  const regular = new Map();
  for (const entry of entries) {
    if (isRegular(entry) && entry.name.startsWith(prefix)) {
      const base = entry.name.slice(prefix.length);
      if (!base.includes('/')) regular.set(base, entry.data);
    }
  }
  const files = new Map();
  for (const entry of entries) {
    const base = entry.name.slice(prefix.length);
    if (entry.name.startsWith(prefix) && !base.includes('/') && accept(base)) {
      if (isRegular(entry)) {
        files.set(base, entry.data);
      } else if (entry.type === '2' || entry.type === '1') {
        // A hard link names a path from the archive root, a symlink one from its directory.
        let target = entry.linkName;
        if (entry.type === '1') {
          const full = cleanTarName(target);
          if (!full.startsWith(prefix)) throw new TrustError(`link leaves the library directory: ${base}`);
          target = full.slice(prefix.length);
        }
        if (target === '' || target.includes('/') || target === '.' || target === '..') {
          throw new TrustError(`link leaves the library directory: ${base}`);
        }
        const data = regular.get(target);
        if (!data) throw new TrustError(`dangling link: ${base}`);
        files.set(base, data);
      }
    }
  }
  return files;
}

// ─── ELF ────────────────────────────────────────────────────────────────────

const ET_EXEC = 2;
const ET_DYN = 3;
const EM_AARCH64 = 183;
const PT_INTERP = 3;

function elfInfo(head) {
  if (head.length < 64 || head.readUInt32BE(0) !== 0x7f454c46) throw new TrustError('not an ELF file');
  if (head[4] !== 2 || head[5] !== 1) throw new TrustError('not a 64-bit little-endian ELF');
  const type = head.readUInt16LE(16);
  const machine = head.readUInt16LE(18);
  if (machine !== EM_AARCH64) throw new TrustError('not an aarch64 ELF');
  const phoff = Number(head.readBigUInt64LE(32));
  const phentsize = head.readUInt16LE(54);
  const phnum = head.readUInt16LE(56);
  let interp = null;
  for (let i = 0; i < phnum; i += 1) {
    const at = phoff + i * phentsize;
    if (at + 56 > head.length) break;
    if (head.readUInt32LE(at) === PT_INTERP) {
      const offset = Number(head.readBigUInt64LE(at + 8));
      const size = Number(head.readBigUInt64LE(at + 32));
      if (offset + size > head.length) throw new TrustError('ELF interpreter is out of reach');
      interp = head.subarray(offset, offset + size).toString('latin1').replace(/\0+$/, '');
    }
  }
  return { type, interp };
}

function readHead(file, bytes = 64 * KB) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(bytes);
    return head.subarray(0, fs.readSync(fd, head, 0, bytes, 0));
  } finally {
    fs.closeSync(fd);
  }
}

// The one check agy gets: the file is a bionic aarch64 PIE, as Google's Android
// build is, and it is not executed.
function checkAgyElf(file) {
  const { type, interp } = elfInfo(readHead(file));
  if (type !== ET_DYN || interp !== ANDROID_LINKER) throw new TrustError('not an Android PIE executable');
}

function checkClaudeElf(file) {
  const { type } = elfInfo(readHead(file));
  if (type !== ET_EXEC && type !== ET_DYN) throw new TrustError('not an executable');
}

// ─── Versions and the update decision ───────────────────────────────────────

const VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

function parseVersionText(text) {
  const trimmed = String(text).trim();
  if (!VERSION.test(trimmed)) throw new TrustError('invalid version text');
  return trimmed;
}

function compareVersions(a, b) {
  const left = String(a).split('.').map(Number);
  const right = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function claudeChannelUrl(channel) {
  if (!CLAUDE_CHANNELS.includes(channel)) throw new UsageError(`unknown channel: ${channel} (latest or stable)`);
  return `${CLAUDE_BASE}/${channel}`;
}

function claudeVersionUrl(version, file) {
  return `${CLAUDE_BASE}/${parseVersionText(version)}/${file}`;
}

/** The checksum the signed manifest promises, or a TrustError. */
function readClaudeManifest(manifestBytes, sigBytes, version, { keyBytes, fingerprint }) {
  verifyDetached(manifestBytes, sigBytes, keyBytes, fingerprint);
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch (_) {
    throw new TrustError('manifest is not JSON');
  }
  if (manifest.version !== version) {
    throw new TrustError(`manifest is for ${manifest.version}, expected ${version}`);
  }
  const entry = manifest.platforms && manifest.platforms[CLAUDE_PLATFORM];
  if (!entry || !/^[a-f0-9]{64}$/.test(String(entry.checksum))) throw new TrustError('manifest has no valid checksum');
  if (!Number.isInteger(entry.size) || entry.size <= 0 || entry.size > LIMITS.claudeBinary) {
    throw new TrustError('manifest has no valid size');
  }
  return { sha256: entry.checksum, size: entry.size };
}

// Judged on the parsed URL, and the text must already be in that form: `%2e%2e`
// passes any test on the raw string and only becomes `..` at the server.
function checkAgyUrl(url) {
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch (_) {
    // Reported below.
  }
  if (
    typeof url !== 'string'
    || url.includes('%')
    || !parsed
    || parsed.href !== url
    || parsed.origin !== AGY_URL_ORIGIN
    || !parsed.pathname.startsWith(AGY_URL_PATH)
    || parsed.username !== ''
    || parsed.password !== ''
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw new TrustError(`unexpected Antigravity download URL: ${String(url).slice(0, 200)}`);
  }
}

function readAgyManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(String(text));
  } catch (_) {
    throw new TrustError('Antigravity manifest is not JSON');
  }
  const { version, url, sha512 } = manifest;
  parseVersionText(version);
  checkAgyUrl(url);
  if (!/^[a-f0-9]{128}$/.test(String(sha512))) throw new TrustError('Antigravity manifest has no valid sha512');
  return { version, url, sha512 };
}

/**
 * Whether `target` should be installed. Only a person can pass `force`, which
 * clears a hold and allows going back; an automatic run cannot.
 */
function decideUpdate({ target, installed: have, failure, now, force = false }) {
  if (!force && failure) {
    if (failure.hold) return { install: false, reason: 'held' };
    if (failure.retryAt && now < failure.retryAt) return { install: false, reason: 'cooldown' };
  }
  if (have && !force) {
    const order = compareVersions(target, have);
    if (order === 0) return { install: false, reason: 'current' };
    if (order < 0) return { install: false, reason: 'older' };
  }
  return { install: true, reason: 'newer' };
}

function recordFailure(state, version, stage, reason, now) {
  const failed = state.failed || (state.failed = {});
  const count = ((failed[version] && failed[version].count) || 0) + 1;
  const hold = stage === 'trust' || stage === 'rollback' || count >= PROBE_HOLD_AFTER;
  failed[version] = {
    stage,
    reason: String(reason).slice(0, 300),
    count,
    at: now,
    hold,
    retryAt: hold ? null : now + PROBE_COOLDOWN_MS,
  };
}

// ─── Files ──────────────────────────────────────────────────────────────────

const CLIS = {
  claude: { dir: 'claude-glibc', file: 'claude', label: 'Claude Code' },
  agy: { dir: 'agy', file: 'antigravity', label: 'Antigravity CLI' },
};

function cliPaths(ctx, cli) {
  const spec = CLIS[cli];
  const shellyRuntime = path.join(ctx.home, '.shelly-runtime');
  const root = path.join(shellyRuntime, spec.dir);
  return {
    spec,
    shellyRuntime,
    root,
    versions: path.join(root, 'versions'),
    current: path.join(root, 'current'),
    previous: path.join(root, 'previous'),
    agent: path.join(root, 'agent-current'),
    entry: path.join(root, spec.file),
    state: path.join(root, 'state.json'),
    lock: path.join(root, '.lock'),
    leases: path.join(root, 'leases'),
    stage: path.join(root, '.stage'),
    lib: path.join(root, 'lib'),
    glibc: path.join(root, 'glibc'),
  };
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Everything is written under HOME. A planted link at either directory would
// otherwise turn every later write into a write somewhere else.
function jail(ctx, paths) {
  const home = fs.realpathSync(ctx.home);
  for (const dir of [paths.shellyRuntime, paths.root, paths.versions]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(dir).isSymbolicLink() || !isInside(home, fs.realpathSync(dir))) {
      throw new TrustError(`${dir} is not a directory under HOME`);
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// state.json is only ever ours, but it is a file a person or a crash can change,
// and every decision reads it. Anything unexpected is dropped, not trusted: at
// worst a held version gets one more try and then a probe.
function readState(paths) {
  const raw = readJson(paths.state);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const state = {};
  if (CLAUDE_CHANNELS.includes(raw.channel)) state.channel = raw.channel;
  if (typeof raw.lastLatest === 'string' && VERSION.test(raw.lastLatest)) state.lastLatest = raw.lastLatest;
  if (Number.isFinite(raw.lastCheckAt)) state.lastCheckAt = raw.lastCheckAt;
  if (raw.failed && typeof raw.failed === 'object' && !Array.isArray(raw.failed)) {
    const failed = {};
    for (const [version, failure] of Object.entries(raw.failed)) {
      if (VERSION.test(version) && failure && typeof failure === 'object' && !Array.isArray(failure)) {
        failed[version] = {
          stage: String(failure.stage),
          reason: String(failure.reason).slice(0, 300),
          count: Number.isInteger(failure.count) ? failure.count : 1,
          at: Number.isFinite(failure.at) ? failure.at : 0,
          hold: failure.hold === true,
          retryAt: Number.isFinite(failure.retryAt) ? failure.retryAt : null,
        };
      }
    }
    state.failed = failed;
  }
  return state;
}

function exists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (_) {
    return false;
  }
}

function isLink(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch (_) {
    return false;
  }
}

/** The versions/ directory a link names, or null. Never follows it elsewhere. */
function linkedVersion(paths, link) {
  let target;
  try {
    target = fs.readlinkSync(link);
  } catch (_) {
    return null;
  }
  const dir = path.resolve(path.dirname(link), target);
  if (path.dirname(dir) !== paths.versions) return null;
  return exists(dir) ? dir : null;
}

function versionOf(dir) {
  const manifest = dir ? readJson(path.join(dir, 'manifest.json')) : null;
  return manifest && typeof manifest.version === 'string' ? manifest.version : null;
}

function atomicLink(link, target) {
  const next = `${link}.next.${process.pid}`;
  fs.rmSync(next, { force: true });
  fs.symlinkSync(target, next);
  // Atomic on the device. Windows, where only the tests run, cannot rename over a
  // link to a directory.
  if (process.platform === 'win32') fs.rmSync(link, { force: true, recursive: true });
  fs.renameSync(next, link);
}

function pointAt(link, versionDir) {
  atomicLink(link, path.join('versions', path.basename(versionDir)));
}

function promote(paths, versionDir) {
  const old = linkedVersion(paths, paths.current);
  if (old && old !== versionDir) pointAt(paths.previous, old);
  pointAt(paths.current, versionDir);
  atomicLink(paths.entry, path.join('current', paths.spec.file));
  syncDir(paths.root);
}

// A promoted version must be on disk before a link names it: after a power cut a
// link to a half-written binary would look installed. Windows, where only the
// tests run, cannot open a directory.
function syncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function syncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncTree(dir) {
  for (const name of fs.readdirSync(dir)) syncFile(path.join(dir, name));
  syncDir(dir);
}

function writeVersionMeta(dir, meta, now) {
  const stamp = new Date(now).toISOString();
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, ...meta, installedAt: stamp }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, '.healthy'), `${stamp}\n`, { mode: 0o600 });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function processStart(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'latin1');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || '';
  } catch (_) {
    return '';
  }
}

// The start time tells a live holder from another process that got its pid.
function lockOwner() {
  return `${process.pid} ${processStart(process.pid)}`;
}

function lockLooksLive(paths, text) {
  const [pidText, start] = text.trim().split(' ');
  const pid = Number(pidText);
  // Created but not written yet: the holder is between two system calls.
  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      return Date.now() - fs.statSync(paths.lock).mtimeMs < LOCK_FRESH_MS;
    } catch (_) {
      return false;
    }
  }
  if (!pidAlive(pid)) return false;
  return !start || processStart(pid) === start;
}

function lockCli(paths) {
  const busy = () => new LockBusy(`${paths.spec.label}: another install is already running`);
  const take = () => {
    const fd = fs.openSync(paths.lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeSync(fd, lockOwner());
    fs.closeSync(fd);
    return () => fs.rmSync(paths.lock, { force: true });
  };
  try {
    return take();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const seen = readText(paths.lock);
  if (seen === null) throw busy();
  if (lockLooksLive(paths, seen)) throw busy();
  // Two processes can both find the same stale lock. Removing it by name could
  // delete the lock the other one has just taken, so move it aside and look at
  // what was actually moved. Only one of them gets the stale file.
  const aside = `${paths.lock}.stale.${process.pid}`;
  try {
    fs.renameSync(paths.lock, aside);
  } catch (_) {
    throw busy();
  }
  if (readText(aside) !== seen) {
    fs.renameSync(aside, paths.lock);
    throw busy();
  }
  fs.rmSync(aside, { force: true });
  try {
    return take();
  } catch (error) {
    if (error.code === 'EEXIST') throw busy();
    throw error;
  }
}

/** A change to state.json, or false when an install holds it: that run writes last. */
function updateState(ctx, paths, change) {
  jail(ctx, paths);
  let unlock;
  try {
    unlock = lockCli(paths);
  } catch (error) {
    if (error instanceof LockBusy) return false;
    throw error;
  }
  try {
    const state = readState(paths);
    change(state);
    writeJsonAtomic(paths.state, state);
    return true;
  } finally {
    unlock();
  }
}

function hashFile(algorithm, file) {
  const hash = crypto.createHash(algorithm);
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(4 * MB);
    for (;;) {
      const got = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (got === 0) break;
      hash.update(chunk.subarray(0, got));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function writeExclusive(file, data) {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
  const fd = fs.openSync(file, flags, 0o700);
  try {
    let at = 0;
    while (at < data.length) at += fs.writeSync(fd, data, at);
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Network ────────────────────────────────────────────────────────────────

function checkFetchUrl(url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:'
    || !ALLOWED_HOSTS.has(parsed.hostname)
    || parsed.port !== ''
    || parsed.username !== ''
    || parsed.password !== ''
  ) {
    throw new TrustError(`refusing a URL outside the vendors' hosts: ${parsed.origin}`);
  }
  return parsed;
}

function request(url, redirects, onResponse, reject) {
  let parsed;
  try {
    parsed = checkFetchUrl(url);
  } catch (error) {
    reject(error);
    return;
  }
  const headers = { 'User-Agent': 'Shelly', 'Accept-Encoding': 'identity' };
  const req = https.get(parsed, { headers }, (response) => {
    const status = response.statusCode || 0;
    const { location } = response.headers;
    if (status >= 300 && status < 400 && location) {
      response.resume();
      if (redirects >= 5) reject(new Error('too many redirects'));
      else request(new URL(location, parsed).toString(), redirects + 1, onResponse, reject);
      return;
    }
    if (status !== 200) {
      response.resume();
      reject(new Error(`HTTP ${status} from ${parsed.hostname}`));
      return;
    }
    onResponse(response);
  });
  req.setTimeout(NETWORK_IDLE_MS, () => req.destroy(new Error(`timeout from ${parsed.hostname}`)));
  req.on('error', reject);
}

function fetchBytes(url, maxBytes) {
  return new Promise((resolve, reject) => {
    request(url, 0, (response) => {
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          response.destroy(new TrustError(`response is over the ${maxBytes} byte limit`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }, reject);
  });
}

/** Streams to a new file; the hash is taken from the bytes as they arrive. */
function downloadTo(url, file, maxBytes, algorithm) {
  return new Promise((resolve, reject) => {
    request(url, 0, (response) => {
      const hash = crypto.createHash(algorithm);
      let size = 0;
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
      const out = fs.createWriteStream(file, { fd: fs.openSync(file, flags, 0o600), flush: true });
      let failed = false;
      const fail = (error) => {
        failed = true;
        response.destroy();
        out.destroy();
        reject(error);
      };
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) fail(new TrustError(`download is over the ${maxBytes} byte limit`));
        else hash.update(chunk);
      });
      response.on('error', fail);
      out.on('error', fail);
      // close, not finish: that is when the bytes have reached the file.
      out.on('close', () => {
        if (!failed) resolve({ size, hash: hash.digest('hex') });
      });
      response.pipe(out);
    }, reject);
  });
}

function freeBytes(dir) {
  const stat = fs.statfsSync(dir);
  return stat.bavail * stat.bsize;
}

function requireSpace(ctx, paths, needed) {
  const free = ctx.freeBytes(paths.root);
  if (free < needed) {
    throw new Error(`not enough free space: need ${Math.ceil(needed / MB)} MB, have ${Math.floor(free / MB)} MB`);
  }
}

// ─── glibc from Termux ──────────────────────────────────────────────────────

function parseRelease(text) {
  const fields = {};
  const sha256 = new Map();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    if (/^\s/.test(line)) {
      if (section === 'SHA256') {
        const [hash, size, name] = line.trim().split(/\s+/);
        if (hash && size && name) sha256.set(name, { sha256: hash, size: Number(size) });
      }
    } else {
      const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
      if (m) {
        [, section] = m;
        fields[m[1]] = m[2];
      }
    }
  }
  return { fields, sha256 };
}

function parsePackageIndex(text) {
  const out = new Map();
  for (const block of text.split(/\n\n+/)) {
    const stanza = {};
    for (const line of block.split('\n')) {
      const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line);
      if (m) stanza[m[1]] = m[2];
    }
    if (stanza.Package) out.set(stanza.Package, stanza);
  }
  return out;
}

// There is no age limit here, unlike codex-termux-apt.js. termux-glibc moves
// rarely (its index was 18 days old on 2026-11-07), and a replayed index can only
// offer an older package Termux signed, which then faces the same probe.
async function fetchGlibcIndex(ctx, mirror) {
  const release = await ctx.fetchBytes(`${mirror}/${TERMUX_GLIBC_DIST}/InRelease`, LIMITS.inRelease);
  const text = verifyClearsigned(release.toString('utf8'), ctx.termuxKey, ctx.termuxFingerprint);
  const { fields, sha256 } = parseRelease(text);
  if (fields.Suite !== 'glibc' || fields.Codename !== 'glibc' || !String(fields.Origin || '').startsWith('termux-glibc')) {
    throw new TrustError(`unexpected repository ${fields.Origin}/${fields.Suite}`);
  }
  const expected = sha256.get(TERMUX_GLIBC_PACKAGES);
  if (!expected) throw new TrustError('package index is not listed in InRelease');
  const gz = await ctx.fetchBytes(`${mirror}/${TERMUX_GLIBC_DIST}/${TERMUX_GLIBC_PACKAGES}`, LIMITS.packagesGz);
  if (sha('sha256', gz) !== expected.sha256) throw new TrustError('package index hash mismatch');
  return parsePackageIndex(zlib.gunzipSync(gz, { maxOutputLength: LIMITS.packages }).toString('utf8'));
}

function extractDebLibraries(deb, wanted) {
  const tar = decodeXz(arMember(deb, 'data.tar.xz'));
  return selectTarFiles(readTar(tar), TERMUX_GLIBC_LIB_PREFIX, (base) => wanted.test(base));
}

function glibcDirReady(dir) {
  return GLIBC_REQUIRED.every((name) => {
    try {
      return fs.statSync(path.join(dir, name)).isFile();
    } catch (_) {
      return false;
    }
  });
}

async function fetchGlibcIndexes(ctx) {
  let lastError = null;
  for (const mirror of TERMUX_GLIBC_MIRRORS) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return { index: await fetchGlibcIndex(ctx, mirror), mirror };
    } catch (error) {
      if (error instanceof TrustError) throw error;
      lastError = error;
    }
  }
  throw lastError || new Error('no Termux mirror answered');
}

function glibcPackages(index) {
  return TERMUX_GLIBC_PACKAGES_WANTED.map(({ name, files }) => {
    const stanza = index.get(name);
    if (!stanza) throw new TrustError(`${name} is not in the package index`);
    const size = Number(stanza.Size);
    if (!Number.isInteger(size) || size <= 0 || size > LIMITS.deb) throw new TrustError(`${name} has a bad size`);
    if (!/^pool\/[A-Za-z0-9/_.+~-]+\.deb$/.test(String(stanza.Filename)) || stanza.Filename.includes('..')) {
      throw new TrustError(`${name} has a bad filename`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(stanza.SHA256))) throw new TrustError(`${name} has no valid hash`);
    return { name, wanted: files, stanza, size };
  });
}

async function downloadGlibcFiles(ctx, mirror, packages) {
  const files = new Map();
  for (const { name, wanted, stanza, size } of packages) {
    // eslint-disable-next-line no-await-in-loop
    const deb = await ctx.fetchBytes(`${mirror}/${stanza.Filename}`, LIMITS.deb);
    if (deb.length !== size || sha('sha256', deb) !== stanza.SHA256) throw new TrustError(`${name} hash mismatch`);
    for (const [base, data] of extractDebLibraries(deb, wanted)) {
      if (!files.has(base)) files.set(base, data);
    }
  }
  let total = 0;
  for (const data of files.values()) total += data.length;
  if (total > LIMITS.glibcFiles) throw new TrustError('glibc libraries are over the size limit');
  for (const name of GLIBC_REQUIRED) {
    if (!files.has(name)) throw new TrustError(`${name} is missing from the Termux packages`);
  }
  elfInfo(files.get('ld-linux-aarch64.so.1').subarray(0, 64 * KB));
  return files;
}

/**
 * The directory to probe with. Nothing that runs today changes here: a new set
 * waits in glibc/<id>/ until commitGlibc, after a probe passed on it, and that
 * id comes from the packages' hashes, so a retry after a failed probe does not
 * download the same files again. Kept once in place: claude asks glibc for
 * very little, and a running TUI maps it.
 */
async function prepareGlibc(ctx, paths) {
  if (glibcDirReady(paths.lib)) return { dir: fs.realpathSync(paths.lib), id: null };
  ctx.log('[shelly] fetching the glibc libraries from Termux');
  try {
    const { index, mirror } = await fetchGlibcIndexes(ctx);
    const packages = glibcPackages(index);
    const versions = Object.fromEntries(packages.map(({ name, stanza }) => [name, stanza.Version]));
    const digest = sha('sha256', packages.map(({ stanza }) => stanza.SHA256).join('\n')).slice(0, 8);
    const id = `${String(versions.glibc).replace(/[^0-9A-Za-z.+-]/g, '_')}-${digest}`;
    const final = path.join(paths.glibc, id);
    if (glibcDirReady(final)) return { dir: fs.realpathSync(final), id };
    const files = await downloadGlibcFiles(ctx, mirror, packages);
    fs.mkdirSync(paths.glibc, { recursive: true, mode: 0o700 });
    const staged = path.join(paths.glibc, `.stage-${id}`);
    fs.rmSync(staged, { recursive: true, force: true });
    fs.mkdirSync(staged, { mode: 0o700 });
    try {
      for (const [base, data] of files) writeExclusive(path.join(staged, base), data);
      fs.writeFileSync(path.join(staged, 'SOURCE.json'), `${JSON.stringify({ source: 'termux-glibc', versions }, null, 2)}\n`, { mode: 0o600 });
      syncTree(staged);
      fs.rmSync(final, { recursive: true, force: true });
      fs.renameSync(staged, final);
      syncDir(paths.glibc);
    } finally {
      fs.rmSync(staged, { recursive: true, force: true });
    }
    return { dir: fs.realpathSync(final), id };
  } catch (error) {
    // Not Claude's bytes, so no reason to hold a Claude version. Nothing is
    // installed, and the next attempt asks Termux again.
    if (error instanceof TrustError) throw new Error(`glibc from Termux was rejected: ${error.message}`);
    throw error;
  }
}

function commitGlibc(ctx, paths, glibc) {
  if (!glibc.id) return;
  // A partial hand-staged lib/ is a real directory; move it aside, never delete it.
  if (exists(paths.lib) && !isLink(paths.lib)) fs.renameSync(paths.lib, `${paths.lib}.manual.${ctx.now()}`);
  atomicLink(paths.lib, path.join('glibc', glibc.id));
  syncDir(paths.root);
}

// ─── Probes ─────────────────────────────────────────────────────────────────

// Claude's --version under the same loader the terminal uses, and with a home of
// its own, so a probe can neither see a credential nor write into ~/.claude.
function probeClaude(ctx, binary, libDir, probeHome) {
  // Thrown, not returned: a broken environment says nothing about this version.
  if (!ctx.lib) throw new Error('SHELLY_LIB_DIR is not set');
  const env = {
    HOME: probeHome,
    PATH: '/system/bin',
    TMPDIR: probeHome,
    CLAUDE_CODE_TMPDIR: probeHome,
    LD_LIBRARY_PATH: ctx.lib,
    SHELLY_GLIBC_LD_LIBRARY_PATH: ctx.lib,
    DISABLE_UPDATES: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  // A timeout or a SIGKILL (the low-memory killer) is the phone's state, not the
  // build's. It must not count towards holding a good version.
  const transient = (result) => (result.error && result.error.code === 'ETIMEDOUT') || result.signal === 'SIGKILL';
  const run = (args) => {
    const result = childProcess.spawnSync(ANDROID_LINKER, [
      path.join(ctx.lib, 'shelly_glibc_exec'),
      path.join(libDir, 'ld-linux-aarch64.so.1'),
      '--library-path', libDir, binary, ...args,
    ], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, env, maxBuffer: MB });
    return {
      status: result.status,
      signal: result.signal,
      transient: transient(result),
      output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
    };
  };
  const failure = (stage, step) => ({
    ok: false,
    stage,
    transient: step.transient,
    detail: step.output || `signal ${step.signal}`,
  });
  const version = run(['--version']);
  if (version.status !== 0) return failure('version', version);
  const help = run(['--help']);
  if (help.status !== 0) return failure('help', help);
  const m = /\b(\d+\.\d+\.\d+)\b/.exec(version.output);
  return { ok: true, version: m ? m[1] : null };
}

function assertProbe(probe, version) {
  if (!probe.ok && probe.transient) throw new Error('the check could not finish, so nothing changed; try again later');
  if (!probe.ok) throw new ProbeError(probe.stage || 'probe', String(probe.detail || 'probe failed').slice(0, 300));
  if (probe.version !== version) {
    throw new ProbeError('version', `binary reports ${probe.version}, expected ${version}`);
  }
}

// ─── Legacy layouts ─────────────────────────────────────────────────────────

// A rename that was cut off before its record was written: the binary sits in
// versions/ with nothing pointing at it, and cleanup would delete it.
function recoverInterruptedAdoption(ctx, paths, cli) {
  if (exists(paths.entry) || linkedVersion(paths, paths.current)) return;
  for (const name of fs.readdirSync(paths.versions)) {
    const dir = path.join(paths.versions, name);
    const file = path.join(dir, paths.spec.file);
    if (exists(file) && !exists(path.join(dir, '.healthy'))) {
      const version = VERSION.test(name.split('-')[0]) ? name.split('-')[0] : '0.0.0';
      writeVersionMeta(dir, { cli, version, sha256: hashFile('sha256', file), size: fs.statSync(file).size, source: 'manual' }, ctx.now());
      syncTree(dir);
      promote(paths, dir);
      return;
    }
  }
}

// A build matching the reviewed hash needs no one to approve it again: that hash
// is the approval. Hand-staged 2.1.314 keeps working for agents this way.
function linkReviewedBuild(ctx, paths) {
  const reviewed = ctx.reviewedClaude;
  if (versionOf(linkedVersion(paths, paths.agent)) === reviewed.version) return;
  const dir = findVersionDir(paths, reviewed.version, reviewed.sha256);
  if (dir) pointAt(paths.agent, dir);
}

// Hand-staged Claude and the old agy-install left a plain file at the entry
// path. Only a person's install command gets here. It is renamed, not hard
// linked (SELinux denies apps hard links in app data); a running TUI holds the
// inode, and the entry path is back a moment later as a link. The record is
// written after the rename and the link last, so being cut off anywhere leaves
// the binary findable.
function adoptLegacy(ctx, paths, cli) {
  recoverInterruptedAdoption(ctx, paths, cli);
  let stat;
  try {
    stat = fs.lstatSync(paths.entry);
  } catch (_) {
    return;
  }
  if (!stat.isFile()) return;
  const digest = hashFile('sha256', paths.entry);
  let version = null;
  if (cli === 'claude' && digest === ctx.reviewedClaude.sha256) {
    ({ version } = ctx.reviewedClaude);
  } else if (cli === 'agy') {
    version = (readText(path.join(paths.root, 'VERSION')) || '').trim();
  } else if (glibcDirReady(paths.lib)) {
    const probeHome = path.join(paths.stage, 'adopt-home');
    fs.rmSync(paths.stage, { recursive: true, force: true });
    fs.mkdirSync(probeHome, { recursive: true, mode: 0o700 });
    const probe = ctx.probeClaude(ctx, paths.entry, paths.lib, probeHome);
    if (probe.ok) ({ version } = probe);
    fs.rmSync(paths.stage, { recursive: true, force: true });
  }
  const known = VERSION.test(String(version));
  const dir = path.join(paths.versions, `${known ? version : 'manual'}-${digest.slice(0, 8)}`);
  const file = path.join(dir, paths.spec.file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!exists(file)) fs.renameSync(paths.entry, file);
  else if (hashFile('sha256', file) !== digest) throw new Error(`${dir} holds a different file; ${paths.entry} was left alone`);
  if (!exists(path.join(dir, '.healthy'))) {
    writeVersionMeta(dir, { cli, version: known ? version : '0.0.0', sha256: digest, size: stat.size, source: 'manual' }, ctx.now());
  }
  syncTree(dir);
  promote(paths, dir);
  if (cli === 'claude') linkReviewedBuild(ctx, paths);
  ctx.log(`[shelly] adopted the existing ${paths.spec.label}${known ? ` ${version}` : ''}`);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

function findVersionDir(paths, version, digest) {
  const dir = path.join(paths.versions, `${version}-${digest.slice(0, 8)}`);
  const file = path.join(dir, paths.spec.file);
  if (!exists(file) || !exists(path.join(dir, '.healthy'))) return null;
  return hashFile('sha256', file) === digest ? dir : null;
}

// ─── Install ────────────────────────────────────────────────────────────────

async function fetchClaudeTarget(ctx, version) {
  const manifest = await ctx.fetchBytes(claudeVersionUrl(version, 'manifest.json'), LIMITS.manifest);
  const sig = await ctx.fetchBytes(claudeVersionUrl(version, 'manifest.json.sig'), LIMITS.signature);
  return readClaudeManifest(manifest, sig, version, { keyBytes: ctx.claudeKey, fingerprint: ctx.claudeFingerprint });
}

function installedVersion(paths) {
  return versionOf(linkedVersion(paths, paths.current));
}

async function stageClaude(ctx, paths, version, target, channel) {
  const reusable = findVersionDir(paths, version, target.sha256);
  if (!reusable) requireSpace(ctx, paths, target.size * 2 + SPACE_MARGIN);
  const glibc = await prepareGlibc(ctx, paths);
  const { stage } = paths;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'home'), { recursive: true, mode: 0o700 });
  if (reusable) {
    // No download, but a new glibc still has to prove itself on this build.
    if (glibc.id) {
      assertProbe(ctx.probeClaude(ctx, path.join(reusable, paths.spec.file), glibc.dir, path.join(stage, 'home')), version);
    }
    commitGlibc(ctx, paths, glibc);
    return reusable;
  }
  const dir = path.join(stage, 'version');
  fs.mkdirSync(dir, { mode: 0o700 });
  const binary = path.join(dir, paths.spec.file);
  ctx.log(`[shelly] downloading Claude Code ${version} (${Math.ceil(target.size / MB)} MB) from Anthropic`);
  const url = claudeVersionUrl(version, `${CLAUDE_PLATFORM}/claude`);
  const got = await ctx.downloadTo(url, binary, LIMITS.claudeBinary, 'sha256');
  if (got.size !== target.size || got.hash !== target.sha256) throw new TrustError('Claude Code checksum mismatch');
  fs.chmodSync(binary, 0o700);
  checkClaudeElf(binary);
  assertProbe(ctx.probeClaude(ctx, binary, glibc.dir, path.join(stage, 'home')), version);
  writeVersionMeta(dir, { cli: 'claude', version, sha256: target.sha256, size: target.size, channel, source: 'anthropic' }, ctx.now());
  syncTree(dir);
  const final = path.join(paths.versions, `${version}-${target.sha256.slice(0, 8)}`);
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(dir, final);
  syncDir(paths.versions);
  commitGlibc(ctx, paths, glibc);
  return final;
}

async function installClaude(ctx, paths, state, options, attempt) {
  const channel = options.channel || state.channel || 'latest';
  const channelUrl = claudeChannelUrl(channel);
  if (options.channel) state.channel = channel;
  const version = parseVersionText((await ctx.fetchBytes(channelUrl, LIMITS.versionText)).toString('utf8'));
  state.lastLatest = version;
  const decision = decideUpdate({
    target: version,
    installed: installedVersion(paths),
    failure: (state.failed || {})[version],
    now: ctx.now(),
    force: Boolean(options.force),
  });
  if (!decision.install) return { installed: false, reason: decision.reason, version };
  attempt.version = version;
  const target = await fetchClaudeTarget(ctx, version);
  const dir = await stageClaude(ctx, paths, version, target, channel);
  promote(paths, dir);
  return { installed: true, version, dir };
}

// Agents, by the person's own command. It never moves `current` unless there is
// no `current` at all, and it cannot name any build but the reviewed one.
async function enableClaudeForAgents(ctx, paths, attempt) {
  const reviewed = ctx.reviewedClaude;
  attempt.version = reviewed.version;
  const target = await fetchClaudeTarget(ctx, reviewed.version);
  if (target.sha256 !== reviewed.sha256 || target.size !== reviewed.size) {
    throw new TrustError(`the signed manifest for ${reviewed.version} differs from the reviewed build`);
  }
  const dir = await stageClaude(ctx, paths, reviewed.version, target, 'reviewed');
  pointAt(paths.agent, dir);
  if (!linkedVersion(paths, paths.current)) promote(paths, dir);
  return { installed: true, version: reviewed.version, dir, agent: true };
}

async function stageAgy(ctx, paths, manifest) {
  const { stage } = paths;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  requireSpace(ctx, paths, AGY_SPACE + SPACE_MARGIN);
  const archive = path.join(stage, 'cli.tar.gz');
  ctx.log(`[shelly] downloading Antigravity CLI ${manifest.version} from Google`);
  const got = await ctx.downloadTo(manifest.url, archive, LIMITS.agyArchive, 'sha512');
  if (got.hash !== manifest.sha512) throw new TrustError('Antigravity SHA-512 mismatch');
  const tar = zlib.gunzipSync(fs.readFileSync(archive), { maxOutputLength: LIMITS.agyExpanded });
  const entry = readTar(tar).find((item) => item.name === 'antigravity');
  if (!entry || entry.type !== '0') throw new TrustError('antigravity is missing from the archive, or is not a plain file');
  const dir = path.join(stage, 'version');
  fs.mkdirSync(dir, { mode: 0o700 });
  const binary = path.join(dir, paths.spec.file);
  writeExclusive(binary, entry.data);
  fs.chmodSync(binary, 0o700);
  checkAgyElf(binary);
  const digest = sha('sha256', entry.data);
  writeVersionMeta(dir, { cli: 'agy', version: manifest.version, sha256: digest, sha512Archive: manifest.sha512, source: 'google', probe: 'checksum+elf' }, ctx.now());
  syncTree(dir);
  const final = path.join(paths.versions, `${manifest.version}-${digest.slice(0, 8)}`);
  fs.rmSync(final, { recursive: true, force: true });
  fs.renameSync(dir, final);
  syncDir(paths.versions);
  return final;
}

async function installAgy(ctx, paths, state, options, attempt) {
  const manifest = readAgyManifest((await ctx.fetchBytes(AGY_MANIFEST_URL, LIMITS.agyManifest)).toString('utf8'));
  state.lastLatest = manifest.version;
  const decision = decideUpdate({
    target: manifest.version,
    installed: installedVersion(paths),
    failure: (state.failed || {})[manifest.version],
    now: ctx.now(),
    force: Boolean(options.force),
  });
  if (!decision.install) return { installed: false, reason: decision.reason, version: manifest.version };
  attempt.version = manifest.version;
  const dir = await stageAgy(ctx, paths, manifest);
  promote(paths, dir);
  return { installed: true, version: manifest.version, dir };
}

// A version is deleted only when all of it agrees: no link names it, no lease
// holds it, and no process maps a file from it or names it on its command line.
function inUseElsewhere(dir) {
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name));
  } catch (_) {
    return true;
  }
  for (const pid of pids) {
    for (const file of ['maps', 'cmdline']) {
      try {
        if (fs.readFileSync(`/proc/${pid}/${file}`, 'latin1').includes(dir)) return true;
      } catch (_) {
        // Another uid's process, or it just exited.
      }
    }
  }
  return false;
}

function leasedDirs(paths) {
  const held = new Set();
  let names;
  try {
    names = fs.readdirSync(paths.leases);
  } catch (_) {
    return held;
  }
  for (const name of names) {
    const file = path.join(paths.leases, name);
    const pid = Number(name);
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
      const dir = readText(file);
      if (dir) held.add(dir.trim());
    } else {
      fs.rmSync(file, { force: true });
    }
  }
  return held;
}

function reviewedDirName(ctx) {
  return `${ctx.reviewedClaude.version}-${ctx.reviewedClaude.sha256.slice(0, 8)}`;
}

function collectGarbage(ctx, paths) {
  const keep = new Set([paths.current, paths.previous, paths.agent].map((link) => linkedVersion(paths, link)).filter(Boolean));
  // The reviewed build is what agents need, with or without a link to it yet.
  if (paths.spec.file === 'claude') keep.add(path.join(paths.versions, reviewedDirName(ctx)));
  const leased = leasedDirs(paths);
  for (const name of fs.readdirSync(paths.versions)) {
    const dir = path.join(paths.versions, name);
    if (!keep.has(dir)) {
      let real = dir;
      try {
        real = fs.realpathSync(dir);
      } catch (_) {
        // Gone already; rmSync below is a no-op.
      }
      if (!leased.has(real) && !ctx.inUseElsewhere(real)) {
        fs.rmSync(dir, { recursive: true, force: true });
        ctx.log(`[shelly] removed unused version ${name}`);
      }
    }
  }
}

async function install(ctx, cli, options = {}) {
  const paths = cliPaths(ctx, cli);
  jail(ctx, paths);
  const unlock = lockCli(paths);
  const state = readState(paths);
  // Set only once this run has named a version, so that a failure before that
  // cannot hold a version some earlier run saw.
  const attempt = { version: null };
  try {
    if (options.agent && cli !== 'claude') {
      throw new UsageError('--agent applies to Claude Code only: Antigravity is never an agent worker');
    }
    if (!options.auto) adoptLegacy(ctx, paths, cli);
    let result;
    if (options.agent) result = await enableClaudeForAgents(ctx, paths, attempt);
    else if (cli === 'claude') result = await installClaude(ctx, paths, state, options, attempt);
    else result = await installAgy(ctx, paths, state, options, attempt);
    if (result.installed) {
      if (state.failed) delete state.failed[result.version];
      if (cli === 'claude') linkReviewedBuild(ctx, paths);
      collectGarbage(ctx, paths);
    }
    return result;
  } catch (error) {
    if (attempt.version && error instanceof TrustError) {
      recordFailure(state, attempt.version, 'trust', error.message, ctx.now());
    } else if (attempt.version && error instanceof ProbeError) {
      recordFailure(state, attempt.version, error.stage, error.message, ctx.now());
    }
    throw error;
  } finally {
    fs.rmSync(paths.stage, { recursive: true, force: true });
    writeJsonAtomic(paths.state, state);
    unlock();
  }
}

/** A person going back. The version they left is held so auto does not undo it. */
function rollback(ctx, cli) {
  const paths = cliPaths(ctx, cli);
  jail(ctx, paths);
  const unlock = lockCli(paths);
  try {
    const current = linkedVersion(paths, paths.current);
    const previous = linkedVersion(paths, paths.previous);
    if (!previous) throw new Error(`${paths.spec.label}: there is no previous version to go back to`);
    const state = readState(paths);
    const leaving = versionOf(current);
    if (leaving) recordFailure(state, leaving, 'rollback', 'rolled back by the user', ctx.now());
    const back = versionOf(previous);
    if (state.failed && back) delete state.failed[back];
    promote(paths, previous);
    writeJsonAtomic(paths.state, state);
    return { version: versionOf(previous) };
  } finally {
    unlock();
  }
}

// ─── Status ─────────────────────────────────────────────────────────────────

function cliStatus(ctx, cli) {
  const paths = cliPaths(ctx, cli);
  const state = readState(paths);
  const managed = linkedVersion(paths, paths.current);
  const status = {
    cli,
    installed: Boolean(managed) || exists(paths.entry),
    managed: Boolean(managed),
    version: versionOf(managed),
    previous: versionOf(linkedVersion(paths, paths.previous)),
    channel: cli === 'claude' ? state.channel || 'latest' : null,
    latest: state.lastLatest || null,
    lastCheckAt: state.lastCheckAt || null,
    held: Object.entries(state.failed || {})
      .filter(([, failure]) => failure.hold)
      .map(([version, failure]) => ({ version, stage: failure.stage })),
  };
  if (cli === 'claude') {
    const version = versionOf(linkedVersion(paths, paths.agent));
    status.agent = {
      reviewed: ctx.reviewedClaude.version,
      version,
      enabled: version === ctx.reviewedClaude.version,
    };
  }
  return status;
}

async function latestVersion(ctx, cli, state) {
  if (cli === 'claude') {
    const body = await ctx.fetchBytes(claudeChannelUrl(state.channel || 'latest'), LIMITS.versionText);
    return parseVersionText(body.toString('utf8'));
  }
  return readAgyManifest((await ctx.fetchBytes(AGY_MANIFEST_URL, LIMITS.agyManifest)).toString('utf8')).version;
}

async function check(ctx) {
  const out = {};
  for (const cli of Object.keys(CLIS)) {
    const paths = cliPaths(ctx, cli);
    const state = readState(paths);
    let latest = null;
    let latestError = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      latest = await latestVersion(ctx, cli, state);
      // Under the lock, on a fresh read: the network took a while, and writing
      // the copy from before it could erase a hold an install just recorded.
      const seen = latest;
      if (exists(paths.root)) updateState(ctx, paths, (fresh) => { fresh.lastLatest = seen; });
    } catch (error) {
      latestError = String(error.message || error).slice(0, 200);
    }
    out[cli] = { ...cliStatus(ctx, cli), latest, latestError };
  }
  return out;
}

/**
 * The app-start pass, when the person has turned it on. The caller has already
 * seen an unmetered network. A CLI nobody installed is never fetched, and a
 * legacy layout waits for a person.
 */
async function autoUpdate(ctx) {
  const results = {};
  for (const cli of Object.keys(CLIS)) {
    const paths = cliPaths(ctx, cli);
    const state = readState(paths);
    if (!linkedVersion(paths, paths.current)) {
      results[cli] = { skipped: 'not-managed' };
    } else if (state.lastCheckAt && ctx.now() - state.lastCheckAt < CHECK_INTERVAL_MS) {
      results[cli] = { skipped: 'checked-recently' };
    } else if (!updateState(ctx, paths, (fresh) => { fresh.lastCheckAt = ctx.now(); })) {
      results[cli] = { skipped: 'install-running' };
    } else {
      try {
        // eslint-disable-next-line no-await-in-loop
        results[cli] = await install(ctx, cli, { auto: true });
      } catch (error) {
        results[cli] = { error: String(error.message || error).slice(0, 200) };
      }
    }
  }
  return results;
}

// ─── Command line ───────────────────────────────────────────────────────────

const USAGE = `usage:
  shelly-cli-update claude install [--channel latest|stable] [--force]
  shelly-cli-update claude install --agent
  shelly-cli-update agy install [--force]
  shelly-cli-update <claude|agy> rollback
  shelly-cli-update status|check|auto`;

function parseArgs(argv) {
  const options = {};
  const words = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--channel') {
      i += 1;
      options.channel = argv[i];
      claudeChannelUrl(options.channel);
    } else if (arg === '--agent') {
      options.agent = true;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      words.push(arg);
    }
  }
  return { words, options };
}

function nextStepText(cli, result, ctx) {
  if (cli === 'agy') return `[shelly] Antigravity CLI ${result.version} is ready. Run: agy`;
  if (result.agent) return `[shelly] Agents will use the reviewed Claude Code ${result.version}.`;
  const reviewed = ctx.reviewedClaude;
  return [
    `[shelly] Claude Code ${result.version} is ready. Run: claude`,
    '[shelly] Updates are a tap in the Builds screen, or turn on Update on Wi-Fi there.',
    `[shelly] Agents use only the reviewed ${reviewed.version}, a separate ${Math.ceil(reviewed.size / MB)} MB. To enable them: claude-install --agent`,
  ].join('\n');
}

function unchangedText(result, paths) {
  const { label } = paths.spec;
  if (result.reason === 'held') return `[shelly] ${label} ${result.version} is held after a failed install. --force tries it again.`;
  if (result.reason === 'cooldown') return `[shelly] ${label} ${result.version} failed recently and will be retried later.`;
  if (result.reason === 'older') return `[shelly] ${label} ${result.version} is older than what is installed. --force goes back to it.`;
  return `[shelly] ${label} ${result.version} is already installed.`;
}

function defaultCtx() {
  const { HOME: home, SHELLY_LIB_DIR: lib = '' } = process.env;
  if (!home || !path.isAbsolute(home)) throw new Error('HOME is not set');
  return {
    home,
    lib,
    now: () => Date.now(),
    log: (line) => process.stdout.write(`${line}\n`),
    fetchBytes,
    downloadTo,
    probeClaude,
    freeBytes,
    inUseElsewhere,
    claudeKey: decodeArmor(CLAUDE_KEY),
    claudeFingerprint: CLAUDE_KEY_FINGERPRINT,
    termuxKey: Buffer.from(TERMUX_KEY_BASE64, 'base64'),
    termuxFingerprint: TERMUX_KEY_FINGERPRINT,
    reviewedClaude: REVIEWED_CLAUDE,
  };
}

async function main(argv) {
  const { words, options } = parseArgs(argv);
  const ctx = defaultCtx();
  const [first, second] = words;
  if (first === 'status') {
    process.stdout.write(`${JSON.stringify({ claude: cliStatus(ctx, 'claude'), agy: cliStatus(ctx, 'agy') })}\n`);
    return;
  }
  if (first === 'check') {
    process.stdout.write(`${JSON.stringify(await check(ctx))}\n`);
    return;
  }
  if (first === 'auto') {
    process.stdout.write(`${JSON.stringify(await autoUpdate(ctx))}\n`);
    return;
  }
  if (!CLIS[first]) throw new UsageError(USAGE);
  if (second === 'rollback') {
    const { version } = rollback(ctx, first);
    ctx.log(`[shelly] ${CLIS[first].label} is back on ${version}. Open a new terminal tab to use it.`);
    return;
  }
  if (second !== 'install') throw new UsageError(USAGE);
  const result = await install(ctx, first, options);
  ctx.log(result.installed ? nextStepText(first, result, ctx) : unchangedText(result, cliPaths(ctx, first)));
}

module.exports = {
  REVIEWED_CLAUDE,
  CLAUDE_KEY,
  CLAUDE_KEY_FINGERPRINT,
  TERMUX_KEY_BASE64,
  TERMUX_KEY_FINGERPRINT,
  GLIBC_REQUIRED,
  TrustError,
  decodeArmor,
  parseRsaPublicKey,
  verifyDetached,
  verifyClearsigned,
  decodeXz,
  arMember,
  readTar,
  selectTarFiles,
  elfInfo,
  checkAgyElf,
  checkFetchUrl,
  compareVersions,
  claudeChannelUrl,
  readClaudeManifest,
  readAgyManifest,
  decideUpdate,
  recordFailure,
  cliPaths,
  linkedVersion,
  install,
  rollback,
  autoUpdate,
  cliStatus,
  check,
  defaultCtx,
};

// `node -e` bootstrap on Android (see HomeInitializer `__shelly_cli_update`): a
// direct `node file.js` hits Node's ReadFileSync ESM main-file crash there.
if (require.main === module || process.env.SHELLY_CLI_UPDATE_MAIN === '1') {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`[shelly] ${error.message || error}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
