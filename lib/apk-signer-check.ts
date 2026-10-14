/**
 * Signing-key migration helpers for the in-app updater.
 *
 * Until 2026-10 every Shelly release APK was signed with the PUBLIC React
 * Native / Expo debug.keystore. Release builds now use APK Signature Scheme v3
 * key rotation (lineage: debug key -> private release key). On API 28+ such
 * an APK updates a debug-signed install in place ('rotation-update'), so no
 * uninstall is needed. Only an APK signed by the release key WITHOUT a
 * lineage that includes the installed signer needs the backup -> uninstall ->
 * install -> restore flow ('migration-to-release-key').
 *
 * Security: a signer change is only presented as a legitimate migration when
 * the downloaded APK is signed by the pinned Shelly release certificate below.
 * Anything else (including an APK re-signed with the public debug key while
 * the installed app already uses the release key) is refused outright — the
 * migration flow asks the user to uninstall, so trusting an arbitrary signer
 * there would be a phishing path.
 */

/** SHA-256 of the DER certificate of the Shelly release key (CN=Shelly, O=RYOITABASHI). */
export const SHELLY_RELEASE_CERT_SHA256 =
  '1476d9520a49bf8da7a767cb413918ccd5c5fcd7f62603766af6521f30de212d';

/** SHA-256 of the public RN/Expo debug.keystore certificate (legacy builds only). */
export const LEGACY_DEBUG_CERT_SHA256 =
  'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';

export const SHELLY_PACKAGE_NAME = 'dev.shelly.terminal';

export type ApkSignerVerdict =
  /** Same signer as the installed app: a normal in-place update. */
  | 'same-signer'
  /**
   * APK's current signer is the pinned release key and its v3 rotation
   * lineage contains the installed signer: Android updates in place.
   */
  | 'rotation-update'
  /**
   * Installed app uses another key, the APK is signed by the pinned release
   * key and has no lineage covering the installed signer: uninstall needed.
   */
  | 'migration-to-release-key'
  /** Signer differs and is not the pinned release key (or the package name is wrong). */
  | 'untrusted-signer'
  /** Native module could not report signers (old native build, parse failure). */
  | 'unknown';

export interface ApkSignerInfo {
  apkPackageName: string;
  apkSigners: string[];
  apkSignerHistory?: string[];
  installedSigners: string[];
  installedSignerHistory?: string[];
}

export function normalizeCertDigest(digest: string): string {
  return digest.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((x) => bs.has(x));
}

export function classifyApkSigner(
  info: ApkSignerInfo | null | undefined,
  options: { trustedReleaseCert?: string; expectedPackageName?: string } = {},
): ApkSignerVerdict {
  if (!info) return 'unknown';
  const trusted = normalizeCertDigest(options.trustedReleaseCert ?? SHELLY_RELEASE_CERT_SHA256);
  const expectedPackage = options.expectedPackageName ?? SHELLY_PACKAGE_NAME;
  const apk = (info.apkSigners ?? []).map(normalizeCertDigest).filter(Boolean);
  const installed = (info.installedSigners ?? []).map(normalizeCertDigest).filter(Boolean);
  if (apk.length === 0 || installed.length === 0) return 'unknown';
  if (info.apkPackageName && info.apkPackageName !== expectedPackage) return 'untrusted-signer';
  if (sameSet(apk, installed)) return 'same-signer';
  if (apk.length !== 1 || apk[0] !== trusted) return 'untrusted-signer';
  const lineage = (info.apkSignerHistory ?? []).map(normalizeCertDigest).filter(Boolean);
  const lineageEndsWithCurrent = lineage.length > 0 && lineage[lineage.length - 1] === apk[0];
  if (lineageEndsWithCurrent && installed.length === 1 && lineage.includes(installed[0])) {
    return 'rotation-update';
  }
  return 'migration-to-release-key';
}

/** `AA:BB:…` uppercase colon form, as shown by keytool / apksigner. */
export function formatCertDigest(digest: string): string {
  return (normalizeCertDigest(digest).toUpperCase().match(/../g) ?? []).join(':');
}

/** Where the migration flow saves a copy of the new APK so it survives uninstalling Shelly. */
export function migrationApkCopyPath(versionCode: number, downloadDir = '/sdcard/Download'): string {
  return `${downloadDir}/Shelly-${Math.max(0, Math.floor(versionCode))}-new-signing-key.apk`;
}
