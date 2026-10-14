import * as fs from 'fs';
import * as path from 'path';
import {
  classifyApkSigner,
  formatCertDigest,
  LEGACY_DEBUG_CERT_SHA256,
  migrationApkCopyPath,
  normalizeCertDigest,
  SHELLY_RELEASE_CERT_SHA256,
} from '@/lib/apk-signer-check';

const ATTACKER = 'ab'.repeat(32);

describe('classifyApkSigner', () => {
  const base = { apkPackageName: 'dev.shelly.terminal' };

  it('same signer => normal update', () => {
    expect(
      classifyApkSigner({ ...base, apkSigners: [LEGACY_DEBUG_CERT_SHA256], installedSigners: [LEGACY_DEBUG_CERT_SHA256] }),
    ).toBe('same-signer');
    expect(
      classifyApkSigner({ ...base, apkSigners: [SHELLY_RELEASE_CERT_SHA256], installedSigners: [SHELLY_RELEASE_CERT_SHA256] }),
    ).toBe('same-signer');
  });

  it('debug-signed install + release-signed APK => migration', () => {
    expect(
      classifyApkSigner({ ...base, apkSigners: [SHELLY_RELEASE_CERT_SHA256], installedSigners: [LEGACY_DEBUG_CERT_SHA256] }),
    ).toBe('migration-to-release-key');
  });

  it('v3-rotated APK (lineage debug -> release) over a debug install => in-place rotation update', () => {
    expect(
      classifyApkSigner({
        ...base,
        apkSigners: [SHELLY_RELEASE_CERT_SHA256],
        apkSignerHistory: [LEGACY_DEBUG_CERT_SHA256, SHELLY_RELEASE_CERT_SHA256],
        installedSigners: [LEGACY_DEBUG_CERT_SHA256],
        installedSignerHistory: [LEGACY_DEBUG_CERT_SHA256],
      }),
    ).toBe('rotation-update');
  });

  it('rotated APK over an already-rotated install => same signer', () => {
    expect(
      classifyApkSigner({
        ...base,
        apkSigners: [SHELLY_RELEASE_CERT_SHA256],
        apkSignerHistory: [LEGACY_DEBUG_CERT_SHA256, SHELLY_RELEASE_CERT_SHA256],
        installedSigners: [SHELLY_RELEASE_CERT_SHA256],
        installedSignerHistory: [LEGACY_DEBUG_CERT_SHA256, SHELLY_RELEASE_CERT_SHA256],
      }),
    ).toBe('same-signer');
  });

  it('a lineage from an attacker key does not make a rotation update', () => {
    expect(
      classifyApkSigner({
        ...base,
        apkSigners: [ATTACKER],
        apkSignerHistory: [LEGACY_DEBUG_CERT_SHA256, ATTACKER],
        installedSigners: [LEGACY_DEBUG_CERT_SHA256],
      }),
    ).toBe('untrusted-signer');
    // lineage that does not end with the current signer is ignored
    expect(
      classifyApkSigner({
        ...base,
        apkSigners: [SHELLY_RELEASE_CERT_SHA256],
        apkSignerHistory: [SHELLY_RELEASE_CERT_SHA256, LEGACY_DEBUG_CERT_SHA256],
        installedSigners: [LEGACY_DEBUG_CERT_SHA256],
      }),
    ).toBe('migration-to-release-key');
  });

  it('accepts colon/uppercase digests', () => {
    const colon = SHELLY_RELEASE_CERT_SHA256.toUpperCase().match(/../g)!.join(':');
    expect(normalizeCertDigest(colon)).toBe(SHELLY_RELEASE_CERT_SHA256);
    expect(
      classifyApkSigner({ ...base, apkSigners: [colon], installedSigners: [LEGACY_DEBUG_CERT_SHA256] }),
    ).toBe('migration-to-release-key');
  });

  it('refuses an unknown signer instead of offering the uninstall flow', () => {
    expect(
      classifyApkSigner({ ...base, apkSigners: [ATTACKER], installedSigners: [LEGACY_DEBUG_CERT_SHA256] }),
    ).toBe('untrusted-signer');
  });

  it('refuses a downgrade back to the public debug key once on the release key', () => {
    expect(
      classifyApkSigner({ ...base, apkSigners: [LEGACY_DEBUG_CERT_SHA256], installedSigners: [SHELLY_RELEASE_CERT_SHA256] }),
    ).toBe('untrusted-signer');
  });

  it('refuses a release-key APK with an extra signer or another package name', () => {
    expect(
      classifyApkSigner({
        ...base,
        apkSigners: [SHELLY_RELEASE_CERT_SHA256, ATTACKER],
        installedSigners: [LEGACY_DEBUG_CERT_SHA256],
      }),
    ).toBe('untrusted-signer');
    expect(
      classifyApkSigner({
        apkPackageName: 'evil.app',
        apkSigners: [SHELLY_RELEASE_CERT_SHA256],
        installedSigners: [LEGACY_DEBUG_CERT_SHA256],
      }),
    ).toBe('untrusted-signer');
  });

  it('unknown when the native module cannot report signers', () => {
    expect(classifyApkSigner(null)).toBe('unknown');
    expect(classifyApkSigner({ ...base, apkSigners: [], installedSigners: [LEGACY_DEBUG_CERT_SHA256] })).toBe('unknown');
  });

  it('formats the pinned cert like keytool for the migration guide', () => {
    expect(formatCertDigest(SHELLY_RELEASE_CERT_SHA256)).toBe(
      '14:76:D9:52:0A:49:BF:8D:A7:A7:67:CB:41:39:18:CC:D5:C5:FC:D7:F6:26:03:76:6A:F6:52:1F:30:DE:21:2D',
    );
  });

  it('saves the migration APK outside app-private storage', () => {
    expect(migrationApkCopyPath(2545)).toBe('/sdcard/Download/Shelly-2545-new-signing-key.apk');
  });

  it('pins the same release fingerprint as CI', () => {
    const wf = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/build-android.yml'), 'utf8');
    expect(wf).toContain(`SHELLY_RELEASE_CERT_SHA256: ${SHELLY_RELEASE_CERT_SHA256}`);
    expect(wf).toContain(`SHELLY_LEGACY_DEBUG_CERT_SHA256: ${LEGACY_DEBUG_CERT_SHA256}`);
  });
});
