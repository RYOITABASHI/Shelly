// components/layout/BuildsModal.tsx
//
// Mobile self-update surface for the Shelly-on-Shelly loop. It reads the
// latest GitHub Actions APK runs, installs the latest public release APK from
// GitHub Releases, then hands the APK to Android's package installer.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { ModalHeader } from '@/components/settings/ModalHeader';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { execCommand } from '@/hooks/use-native-exec';
import { colors as C, fonts as F, radii as R, sizes as S } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';

const REPO = 'RYOITABASHI/Shelly';
const WORKFLOW = 'build-android.yml';
const UPDATE_TAG = 'android-latest';
const UPDATE_MANIFEST_ASSET = 'latest.json';
const CODEX_RUNTIME_TAG = 'codex-runtime-latest';
const CODEX_RUNTIME_MANIFEST_ASSET = 'codex-runtime.json';
const APK_NAME_RE = /^[A-Za-z0-9._-]+\.apk$/;
const TARBALL_NAME_RE = /^[A-Za-z0-9._-]+\.tar\.gz$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const ANDROID_UPDATE_DOWNLOAD_KEY = 'shelly_android_update_download';

export type BuildStatus = 'unknown' | 'in_progress' | 'success' | 'failure';

export type BuildRun = {
  databaseId: number;
  number?: number;
  status: string;
  conclusion: string | null;
  displayTitle: string;
  headSha: string;
  createdAt: string;
  startedAt?: string;
  updatedAt?: string;
  url: string;
};

type AndroidUpdateManifest = {
  schemaVersion: number;
  channel?: string;
  versionCode: number;
  versionName: string;
  codexVersion?: string;
  codexTermuxVersion?: string;
  gitSha: string;
  runId?: number;
  runNumber?: number;
  createdAt?: string;
  apkAssetName: string;
  apkUrl: string;
  apkSizeBytes?: number;
  sha256: string;
};

type AppVersionInfo = {
  packageName: string;
  versionName: string;
  versionCode: number;
};

type CodexRuntimeManifest = {
  schemaVersion: number;
  channel?: string;
  version: string;
  codexVersion?: string;
  codexTermuxVersion?: string;
  gitSha: string;
  runId?: number;
  runNumber?: number;
  createdAt?: string;
  assetName: string;
  tarballUrl: string;
  sha256: string;
};

type CodexVersionInfo = {
  version: string;
  source: 'runtime' | 'bundled' | 'runtime_broken' | 'unknown';
  runtimePresent: boolean;
  runtimeHealthy: boolean;
};

type DownloadApkStep = 'prepare' | 'download' | 'verify' | 'ready';

type DownloadApkProgress = {
  step: DownloadApkStep;
  downloadedBytes?: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
};

type PendingApkDownload = {
  versionCode: number;
  assetName: string;
  apkPath: string;
  downloadId: number;
  createdAt: number;
};

type DownloadLogEntry = {
  id: string;
  label: string;
  status: 'active' | 'done' | 'error';
};

function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function statusFromRun(run?: BuildRun | null): BuildStatus {
  if (!run) return 'unknown';
  if (run.status !== 'completed') return 'in_progress';
  return run.conclusion === 'success' ? 'success' : 'failure';
}

function statusFromUpdate(update?: AndroidUpdateManifest | null, installed?: AppVersionInfo | null): BuildStatus {
  if (!update || !installed) return 'unknown';
  return update.versionCode > installed.versionCode ? 'in_progress' : 'success';
}

export function buildStatusColor(status: BuildStatus): string {
  switch (status) {
    case 'in_progress': return '#F59E0B';
    case 'success': return '#22C55E';
    case 'failure': return '#EF4444';
    default: return C.text3;
  }
}

function durationSec(run: BuildRun): number | null {
  const start = Date.parse(run.startedAt || run.createdAt);
  const end = run.status === 'completed'
    ? Date.parse(run.updatedAt || run.createdAt)
    : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 1000);
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return 'duration n/a';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatBytes(bytes?: number | null): string {
  if (!Number.isFinite(bytes ?? NaN) || !bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = unit >= 2 ? 1 : 0;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

function formatDownloadProgress(
  downloadedBytes?: number,
  totalBytes?: number,
  speedBytesPerSec?: number,
): string {
  const downloaded = Number.isFinite(downloadedBytes ?? NaN) ? Math.max(0, downloadedBytes ?? 0) : 0;
  const total = Number.isFinite(totalBytes ?? NaN) && (totalBytes ?? 0) > 0 ? totalBytes : undefined;
  const speed = Number.isFinite(speedBytesPerSec ?? NaN) && (speedBytesPerSec ?? 0) > 0
    ? `, ${formatBytes(speedBytesPerSec)}/s`
    : '';
  if (total) {
    const percent = Math.min(100, Math.max(0, (downloaded / total) * 100));
    return `${formatBytes(downloaded)} / ${formatBytes(total)} (${percent.toFixed(0)}%${speed})`;
  }
  return `${formatBytes(downloaded)}${speed}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NETWORK_TIMEOUT_MS = 15_000;

// fetch() in React Native has no default timeout: a stalled TLS/connection
// (or a throttled GitHub response held open) never settles, which hangs the
// whole Updates refresh on "Checking…" forever. Abort the request after a
// bounded time so the promise always rejects instead of hanging.
async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = NETWORK_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Backstop for any promise feeding the Updates refresh (native version probe,
// codex --version shell probe, fetches). Guarantees Promise.allSettled can
// never hang: if the underlying op stalls, this rejects after `ms`.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function parseCodexVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

function codexVersionFromUpdate(update?: AndroidUpdateManifest | null): string | null {
  const version = update?.codexTermuxVersion || update?.codexVersion;
  return version ? version.replace(/^v/, '') : null;
}

function compareSemver(a?: string | null, b?: string | null): number {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const left = a.replace(/^v/, '').split(/[+-]/)[0].split('.').map((part) => Number(part) || 0);
  const right = b.replace(/^v/, '').split(/[+-]/)[0].split('.').map((part) => Number(part) || 0);
  for (let i = 0; i < Math.max(left.length, right.length, 3); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return a === b ? 0 : a.localeCompare(b);
}

async function fetchInstalledCodexVersion(): Promise<CodexVersionInfo | null> {
  const command = [
    'lib="${SHELLY_LIB_DIR:-${LD_LIBRARY_PATH%%:*}}"',
    'runtime="$HOME/.shelly-runtime/codex/current"',
    'runtime_present=0',
    '[ -e "$runtime" ] || [ -L "$runtime" ] && runtime_present=1',
    'runtime_healthy=0',
    'base="$lib"',
    'source=bundled',
    'if [ "${SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME:-0}" != "1" ] && [ -f "$runtime/.healthy" ] && [ -f "$runtime/manifest.json" ] && [ -x "$runtime/codex_tui" ] && [ -x "$runtime/codex_exec" ]; then runtime_healthy=1; base="$runtime"; source=runtime; fi',
    'if [ "$source" = runtime ]; then bin="$base/codex_tui"; out="$(SHELLY_LIB_DIR="$lib" LD_PRELOAD="$lib/libexec_wrapper.so" SHELLY_CODEX_EXEC_PATH="$bin" SHELLY_CODEX_PROC_EXE_SHIM=1 SHELLY_CODEX_PROC_EXE_OPEN_SHIM=1 LD_LIBRARY_PATH="$base:$lib" /system/bin/linker64 "$bin" --version 2>&1)" && { printf "%s\\t%s\\t%s\\t%s\\n" "$source" "$runtime_present" "$runtime_healthy" "$out"; exit 0; }; source=runtime_broken; base="$lib"; fi',
    'if [ -x "$base/codex_tui" ]; then bin="$base/codex_tui"; elif [ -x "$base/codex_exec" ]; then bin="$base/codex_exec"; else exit 127; fi',
    'out="$(SHELLY_LIB_DIR="$lib" LD_LIBRARY_PATH="$base:$lib" /system/bin/linker64 "$bin" --version 2>&1)" || exit $?',
    'printf "%s\\t%s\\t%s\\t%s\\n" "$source" "$runtime_present" "$runtime_healthy" "$out"',
  ].join('; ');
  const r = await execCommand(command, 15_000);
  if (r.exitCode !== 0) return null;
  const line = r.stdout.trim().split('\n').filter(Boolean).pop() || '';
  const [rawSource, runtimePresentRaw, runtimeHealthyRaw, ...rest] = line.split('\t');
  const version = parseCodexVersion(rest.join('\t') || `${r.stdout}\n${r.stderr}`);
  if (!version) return null;
  const source = rawSource === 'runtime' || rawSource === 'bundled' || rawSource === 'runtime_broken'
    ? rawSource
    : 'unknown';
  return {
    version,
    source,
    runtimePresent: runtimePresentRaw === '1',
    runtimeHealthy: runtimeHealthyRaw === '1',
  };
}

function mapApiRuns(payload: any): BuildRun[] {
  const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
  return runs.map((run: any) => ({
    databaseId: Number(run.id),
    number: Number(run.run_number || 0) || undefined,
    status: String(run.status || 'unknown'),
    conclusion: run.conclusion ? String(run.conclusion) : null,
    displayTitle: String(run.display_title || run.name || `Run #${run.id}`),
    headSha: String(run.head_sha || ''),
    createdAt: String(run.created_at || run.createdAt || ''),
    startedAt: String(run.run_started_at || run.started_at || run.created_at || ''),
    updatedAt: String(run.updated_at || run.updatedAt || ''),
    url: String(run.html_url || run.url || ''),
  }));
}

export async function fetchBuildRuns(): Promise<BuildRun[]> {
  // Public workflow status should not require `gh auth login`. Use React
  // Native's network stack instead of shelling out to curl: user shells can
  // carry Termux-specific CURL_CA_BUNDLE / SSL_CERT_FILE paths that do not
  // exist inside Shelly and produce false TLS errors.
  const apiUrl = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=5`;
  const response = await fetchWithTimeout(apiUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Shelly',
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `GitHub API HTTP ${response.status}`);
  }
  return mapApiRuns(await response.json());
}

async function fetchLatestAndroidUpdate(): Promise<AndroidUpdateManifest | null> {
  const releaseUrl = `https://api.github.com/repos/${REPO}/releases/tags/${UPDATE_TAG}`;
  const releaseResponse = await fetchWithTimeout(releaseUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Shelly',
    },
  });
  if (releaseResponse.status === 404) return null;
  if (!releaseResponse.ok) {
    const body = await releaseResponse.text().catch(() => '');
    throw new Error(body || `GitHub release API HTTP ${releaseResponse.status}`);
  }

  const release = await releaseResponse.json();
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const manifestAsset = assets.find((asset: any) => asset?.name === UPDATE_MANIFEST_ASSET);
  if (!manifestAsset?.browser_download_url) {
    throw new Error(`Release ${UPDATE_TAG} has no ${UPDATE_MANIFEST_ASSET} asset.`);
  }

  const manifestResponse = await fetchWithTimeout(String(manifestAsset.browser_download_url), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Shelly',
    },
  });
  if (!manifestResponse.ok) {
    const body = await manifestResponse.text().catch(() => '');
    throw new Error(body || `GitHub release manifest HTTP ${manifestResponse.status}`);
  }

  const raw = await manifestResponse.json();
  const versionCode = Number(raw?.versionCode);
  const apkAssetName = String(raw?.apkAssetName || '');
  const sha256 = String(raw?.sha256 || '').toLowerCase();
  const apkAsset = assets.find((asset: any) => asset?.name === apkAssetName);
  const rawApkSizeBytes = Number(raw?.apkSizeBytes);
  const assetSizeBytes = Number(apkAsset?.size);
  // The GitHub asset's own .size is authoritative — it is exactly the byte
  // count the DownloadManager fetches and what verifyApkFile must check against.
  // The manifest's apkSizeBytes is a secondary value computed in CI and has
  // been observed to drift by a few bytes vs the uploaded asset, which made the
  // size check reject a fully-correct (sha256-valid) download and re-loop the
  // 668 MB download forever. Prefer the asset size; fall back to the manifest
  // only when the asset has no usable size.
  const apkSizeBytes = Number.isInteger(assetSizeBytes) && assetSizeBytes > 0
    ? assetSizeBytes
    : Number.isInteger(rawApkSizeBytes) && rawApkSizeBytes > 0
      ? rawApkSizeBytes
      : undefined;
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    throw new Error('Release manifest has an invalid versionCode.');
  }
  if (!APK_NAME_RE.test(apkAssetName)) {
    throw new Error('Release manifest has an invalid APK asset name.');
  }
  if (!SHA256_RE.test(sha256)) {
    throw new Error('Release manifest has an invalid sha256.');
  }
  if (!apkAsset?.browser_download_url) {
    throw new Error(`Release ${UPDATE_TAG} has no APK asset named ${apkAssetName}.`);
  }

  return {
    schemaVersion: Number(raw?.schemaVersion || 1),
    channel: raw?.channel ? String(raw.channel) : undefined,
    versionCode,
    versionName: String(raw?.versionName || ''),
    codexVersion: raw?.codexVersion ? String(raw.codexVersion) : undefined,
    codexTermuxVersion: raw?.codexTermuxVersion ? String(raw.codexTermuxVersion) : undefined,
    gitSha: String(raw?.gitSha || ''),
    runId: Number.isInteger(Number(raw?.runId)) ? Number(raw.runId) : undefined,
    runNumber: Number.isInteger(Number(raw?.runNumber)) ? Number(raw.runNumber) : undefined,
    createdAt: raw?.createdAt ? String(raw.createdAt) : undefined,
    apkAssetName,
    apkUrl: String(apkAsset.browser_download_url),
    apkSizeBytes,
    sha256,
  };
}

async function fetchLatestCodexRuntime(): Promise<CodexRuntimeManifest | null> {
  const releaseUrl = `https://api.github.com/repos/${REPO}/releases/tags/${CODEX_RUNTIME_TAG}`;
  const releaseResponse = await fetchWithTimeout(releaseUrl, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Shelly',
    },
  });
  if (releaseResponse.status === 404) return null;
  if (!releaseResponse.ok) {
    const body = await releaseResponse.text().catch(() => '');
    throw new Error(body || `GitHub Codex runtime release API HTTP ${releaseResponse.status}`);
  }

  const release = await releaseResponse.json();
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const manifestAsset = assets.find((asset: any) => asset?.name === CODEX_RUNTIME_MANIFEST_ASSET);
  if (!manifestAsset?.browser_download_url) {
    throw new Error(`Release ${CODEX_RUNTIME_TAG} has no ${CODEX_RUNTIME_MANIFEST_ASSET} asset.`);
  }

  const manifestResponse = await fetchWithTimeout(String(manifestAsset.browser_download_url), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'Shelly',
    },
  });
  if (!manifestResponse.ok) {
    const body = await manifestResponse.text().catch(() => '');
    throw new Error(body || `GitHub Codex runtime manifest HTTP ${manifestResponse.status}`);
  }

  const raw = await manifestResponse.json();
  const version = String(raw?.version || '').replace(/^v/, '');
  const assetName = String(raw?.assetName || '');
  const sha256 = String(raw?.sha256 || '').toLowerCase();
  const runtimeAsset = assets.find((asset: any) => asset?.name === assetName);
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('Codex runtime manifest has an invalid version.');
  }
  if (!TARBALL_NAME_RE.test(assetName)) {
    throw new Error('Codex runtime manifest has an invalid asset name.');
  }
  if (!SHA256_RE.test(sha256)) {
    throw new Error('Codex runtime manifest has an invalid sha256.');
  }
  if (!runtimeAsset?.browser_download_url) {
    throw new Error(`Release ${CODEX_RUNTIME_TAG} has no asset named ${assetName}.`);
  }

  return {
    schemaVersion: Number(raw?.schemaVersion || 1),
    channel: raw?.channel ? String(raw.channel) : undefined,
    version,
    codexVersion: raw?.codexVersion ? String(raw.codexVersion) : undefined,
    codexTermuxVersion: raw?.codexTermuxVersion ? String(raw.codexTermuxVersion) : undefined,
    gitSha: String(raw?.gitSha || ''),
    runId: Number.isInteger(Number(raw?.runId)) ? Number(raw.runId) : undefined,
    runNumber: Number.isInteger(Number(raw?.runNumber)) ? Number(raw.runNumber) : undefined,
    createdAt: raw?.createdAt ? String(raw.createdAt) : undefined,
    assetName,
    tarballUrl: String(runtimeAsset.browser_download_url),
    sha256,
  };
}

export async function fetchUpdateAvailabilityStatus(): Promise<BuildStatus> {
  try {
    const [update, installed] = await Promise.all([
      fetchLatestAndroidUpdate(),
      TerminalEmulator.getAppVersionInfo(),
    ]);
    return statusFromUpdate(update, installed);
  } catch {
    return 'unknown';
  }
}

async function downloadReleaseApk(
  update: AndroidUpdateManifest,
  onProgress?: (progress: DownloadApkProgress) => void,
): Promise<string> {
  const apkPath = releaseApkPath(update);

  onProgress?.({ step: 'prepare' });
  const existingValid = await verifyReleaseApkFile(update, apkPath).catch(() => false);
  if (existingValid) {
    await clearPendingApkDownload();
    onProgress?.({ step: 'ready' });
    return apkPath;
  }

  const matchingPending = await readPendingApkDownload().then((pending) => {
    if (!pending) return null;
    if (pending.versionCode !== update.versionCode) return null;
    if (pending.assetName !== update.apkAssetName) return null;
    if (pending.apkPath !== apkPath) return null;
    return pending;
  });

  let downloadId = matchingPending?.downloadId;
  if (!downloadId) {
    const started = await TerminalEmulator.enqueueApkDownload(
      update.apkUrl,
      `shelly-update-${update.versionCode}`,
      update.apkAssetName,
    );
    downloadId = Number(started.downloadId);
    if (!Number.isFinite(downloadId) || downloadId < 1) {
      throw new Error('Could not start APK download.');
    }
    try {
      await writePendingApkDownload({
        versionCode: update.versionCode,
        assetName: update.apkAssetName,
        apkPath,
        downloadId,
        createdAt: Date.now(),
      });
    } catch (e: any) {
      await TerminalEmulator.removeApkDownload(downloadId).catch(() => undefined);
      throw new Error(`Could not persist update download state: ${String(e?.message || e)}`);
    }
  }

  onProgress?.({
    step: 'download',
    downloadedBytes: 0,
    totalBytes: update.apkSizeBytes,
  });
  const startedAt = Date.now();
  let lastBytes = 0;
  let lastAt = startedAt;
  while (true) {
    await sleep(1000);
    const status = await TerminalEmulator.getApkDownloadStatus(downloadId);
    const downloadedBytes = Math.max(0, Number(status.downloadedBytes) || 0);
    const totalBytes = Number(status.totalBytes) > 0 ? Number(status.totalBytes) : update.apkSizeBytes;
    const now = Date.now();
    const elapsedSinceLast = Math.max(1, now - lastAt) / 1000;
    const speedBytesPerSec = Math.max(0, downloadedBytes - lastBytes) / elapsedSinceLast;
    lastBytes = downloadedBytes;
    lastAt = now;
    onProgress?.({
      step: 'download',
      downloadedBytes,
      totalBytes,
      speedBytesPerSec,
    });

    if (status.status === 'successful') {
      break;
    }
    if (status.status === 'failed' || status.status === 'missing' || status.status === 'unknown') {
      await TerminalEmulator.removeApkDownload(downloadId).catch(() => undefined);
      await clearPendingApkDownload();
      throw new Error(downloadManagerFailureMessage(status.status, status.reason));
    }
    if (Date.now() - startedAt > 1_800_000) {
      await TerminalEmulator.removeApkDownload(downloadId).catch(() => undefined);
      await clearPendingApkDownload();
      throw new Error('APK download timed out.');
    }
  }

  onProgress?.({ step: 'verify' });
  const verify = await TerminalEmulator.verifyApkFile(apkPath, update.sha256, Math.trunc(update.apkSizeBytes ?? -1));
  if (!verify.ok) {
    await clearPendingApkDownload();
    throw new Error(verify.error || `sha256 mismatch: expected ${update.sha256}, got ${verify.actualSha256}`);
  }
  await clearPendingApkDownload();
  onProgress?.({ step: 'ready' });
  return apkPath;
}

async function readPendingApkDownload(): Promise<PendingApkDownload | null> {
  try {
    const raw = await AsyncStorage.getItem(ANDROID_UPDATE_DOWNLOAD_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PendingApkDownload>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Number.isFinite(Number(parsed.downloadId))) return null;
    if (!Number.isFinite(Number(parsed.versionCode))) return null;
    if (!parsed.assetName || !parsed.apkPath) return null;
    return {
      versionCode: Number(parsed.versionCode),
      assetName: String(parsed.assetName),
      apkPath: String(parsed.apkPath),
      downloadId: Number(parsed.downloadId),
      createdAt: Number(parsed.createdAt) || 0,
    };
  } catch {
    return null;
  }
}

async function writePendingApkDownload(download: PendingApkDownload): Promise<void> {
  await AsyncStorage.setItem(ANDROID_UPDATE_DOWNLOAD_KEY, JSON.stringify(download));
}

async function clearPendingApkDownload(): Promise<void> {
  await AsyncStorage.removeItem(ANDROID_UPDATE_DOWNLOAD_KEY).catch(() => undefined);
}

function downloadManagerFailureMessage(status: string, reason?: number): string {
  const code = Number(reason) || 0;
  const reasonText = (() => {
    if (status === 'paused') {
      switch (code) {
        case 1: return 'waiting to retry';
        case 2: return 'waiting for network';
        case 3: return 'queued for Wi-Fi';
        case 4: return 'paused for an unknown reason';
        default: return code > 0 ? `pause reason ${code}` : 'paused';
      }
    }
    switch (code) {
      case 1000: return 'unknown error';
      case 1001: return 'file error';
      case 1002: return 'unhandled HTTP code';
      case 1004: return 'HTTP data error';
      case 1005: return 'too many redirects';
      case 1006: return 'insufficient space';
      case 1007: return 'device not found';
      case 1008: return 'cannot resume';
      case 1009: return 'file already exists';
      default:
        if (code >= 400 && code <= 599) return `HTTP ${code}`;
        return code > 0 ? `reason ${code}` : 'no reason reported';
    }
  })();
  return `Android DownloadManager ${status}: ${reasonText}`;
}

function releaseApkDir(update: AndroidUpdateManifest): string {
  return `/sdcard/Download/shelly-update-${update.versionCode}`;
}

function releaseApkPath(update: AndroidUpdateManifest): string {
  return `${releaseApkDir(update)}/${update.apkAssetName}`;
}

async function verifyReleaseApkFile(update: AndroidUpdateManifest, apkPath: string): Promise<boolean> {
  if (apkPath !== releaseApkPath(update)) return false;
  const verify = await TerminalEmulator.verifyApkFile(apkPath, update.sha256, Math.trunc(update.apkSizeBytes ?? -1));
  return verify.ok;
}

async function installCodexRuntime(update: CodexRuntimeManifest): Promise<string> {
  const manifest = JSON.stringify({
    schemaVersion: update.schemaVersion || 1,
    channel: update.channel || CODEX_RUNTIME_TAG,
    version: update.version,
    codexVersion: update.codexVersion || '',
    codexTermuxVersion: update.codexTermuxVersion || update.version,
    gitSha: update.gitSha || '',
    runId: update.runId,
    runNumber: update.runNumber,
    createdAt: update.createdAt,
    assetName: update.assetName,
    tarballUrl: update.tarballUrl,
    sha256: update.sha256.toLowerCase(),
    installedAt: new Date().toISOString(),
  }, null, 2);
  const command = [
    'set -eu',
    'toybox=/system/bin/toybox',
    'lib="${SHELLY_LIB_DIR:-${LD_LIBRARY_PATH%%:*}}"',
    'test -n "$lib"',
    'test -x "$lib/curl" || { echo "bundled curl is missing at $lib/curl" >&2; exit 127; }',
    'runtime_root="$HOME/.shelly-runtime/codex"',
    'versions_dir="$runtime_root/versions"',
    'current_link="$runtime_root/current"',
    'tmp_dir="$HOME/.shelly-runtime/.tmp"',
    `version=${sq(update.version)}`,
    `run_id=${sq(String(update.runId || 'manual'))}`,
    `asset_name=${sq(update.assetName)}`,
    `url=${sq(update.tarballUrl)}`,
    `expected_sha=${sq(update.sha256.toLowerCase())}`,
    '"$toybox" mkdir -p "$versions_dir" "$tmp_dir" "$HOME/.tmp" "$HOME/.config" "$HOME/.cache" "$HOME/.local/share"',
    'install_id="${version}-${run_id}-$("$toybox" date +%s)"',
    'staging="$tmp_dir/codex-$install_id"',
    'archive="$tmp_dir/$install_id.tar.gz"',
    'cleanup() { "$toybox" rm -f "$archive" 2>/dev/null || true; [ -n "${staging:-}" ] && [ -d "$staging" ] && "$toybox" rm -rf "$staging" 2>/dev/null || true; }',
    'trap cleanup EXIT',
    '"$toybox" rm -rf "$staging" "$archive"',
    '"$toybox" mkdir -p "$staging"',
    'echo "[shelly] downloading $asset_name"',
    'LD_LIBRARY_PATH="$lib" /system/bin/linker64 "$lib/curl" --fail --location --retry 2 --connect-timeout 20 --max-time 300 --output "$archive" "$url"',
    'actual_sha="$("$toybox" sha256sum "$archive" | "$toybox" cut -d " " -f 1)"',
    '[ "$actual_sha" = "$expected_sha" ] || { echo "sha256 mismatch: expected $expected_sha, got $actual_sha" >&2; exit 1; }',
    '"$toybox" tar -xzf "$archive" -C "$staging"',
    'for name in codex_exec codex_tui; do test -f "$staging/$name" || { echo "$name missing from Codex runtime" >&2; exit 1; }; "$toybox" chmod 700 "$staging/$name"; done',
    '[ ! -f "$staging/libc++_shared.so" ] || "$toybox" chmod 600 "$staging/libc++_shared.so"',
    'extract_version() { printf "%s\\n" "$1" | "$toybox" sed -n "s/.*\\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*[-+A-Za-z0-9.]*\\).*/\\1/p" | "$toybox" head -n 1; }',
    'run_codex_version() { bin="$1"; label="$2"; out_file="$tmp_dir/$label.version.out"; SHELLY_LIB_DIR="$lib" LD_PRELOAD="$lib/libexec_wrapper.so" SHELLY_CODEX_EXEC_PATH="$bin" SHELLY_CODEX_PROC_EXE_SHIM=1 SHELLY_CODEX_PROC_EXE_OPEN_SHIM=1 LD_LIBRARY_PATH="$staging:$lib" /system/bin/linker64 "$bin" --version > "$out_file" 2>&1 & pid=$!; elapsed=0; while kill -0 "$pid" 2>/dev/null; do if [ "$elapsed" -ge 20 ]; then kill "$pid" 2>/dev/null || true; "$toybox" sleep 1; kill -9 "$pid" 2>/dev/null || true; "$toybox" cat "$out_file"; "$toybox" rm -f "$out_file"; return 124; fi; "$toybox" sleep 1; elapsed=$((elapsed + 1)); done; wait "$pid"; code=$?; "$toybox" cat "$out_file"; "$toybox" rm -f "$out_file"; return "$code"; }',
    'tui_output="$(run_codex_version "$staging/codex_tui" codex_tui)" || { code=$?; echo "codex_tui --version failed: $tui_output" >&2; exit "$code"; }',
    'exec_output="$(run_codex_version "$staging/codex_exec" codex_exec)" || { code=$?; echo "codex_exec --version failed: $exec_output" >&2; exit "$code"; }',
    'tui_version="$(extract_version "$tui_output")"',
    'exec_version="$(extract_version "$exec_output")"',
    '[ "$tui_version" = "$version" ] || { echo "codex_tui version mismatch: expected $version, got ${tui_version:-none}; output=$tui_output" >&2; exit 1; }',
    '[ "$exec_version" = "$version" ] || { echo "codex_exec version mismatch: expected $version, got ${exec_version:-none}; output=$exec_output" >&2; exit 1; }',
    `"$toybox" cat > "$staging/manifest.json" <<'SHELLY_CODEX_RUNTIME_MANIFEST'\n${manifest}\nSHELLY_CODEX_RUNTIME_MANIFEST`,
    'printf "%s\\n" "$tui_output" > "$staging/codex_tui.version"',
    'printf "%s\\n" "$exec_output" > "$staging/codex_exec.version"',
    'printf "%s\\n" "$("$toybox" date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || "$toybox" date +%s)" > "$staging/.healthy"',
    '"$toybox" chmod 600 "$staging/manifest.json" "$staging/.healthy" "$staging/codex_tui.version" "$staging/codex_exec.version"',
    'final_dir="$versions_dir/$install_id"',
    '"$toybox" rm -rf "$final_dir"',
    '"$toybox" mv "$staging" "$final_dir"',
    'next_link="$runtime_root/current.next"',
    '"$toybox" rm -rf "$next_link"',
    '"$toybox" ln -s "$final_dir" "$next_link"',
    'if [ -L "$current_link" ]; then "$toybox" rm -f "$current_link"; elif [ -e "$current_link" ]; then "$toybox" mv "$current_link" "$runtime_root/current.backup.$("$toybox" date +%s)"; fi',
    '"$toybox" mv "$next_link" "$current_link"',
    'echo "[shelly] Codex runtime $version installed. Open a new terminal tab to use it."',
  ].join('\n');
  const r = await execCommand(command, 600_000);
  if (r.exitCode !== 0) {
    throw new Error((r.stderr || r.stdout || `Codex runtime install exited ${r.exitCode}`).trim());
  }
  return (r.stdout || '').trim();
}

async function resetCodexRuntime(): Promise<string> {
  const command = [
    'set -eu',
    'toybox=/system/bin/toybox',
    'lib="${SHELLY_LIB_DIR:-${LD_LIBRARY_PATH%%:*}}"',
    'test -n "$lib"',
    'runtime_root="$HOME/.shelly-runtime/codex"',
    'current_link="$runtime_root/current"',
    'if [ -L "$current_link" ]; then "$toybox" rm -f "$current_link"; elif [ -e "$current_link" ]; then "$toybox" mv "$current_link" "$runtime_root/current.disabled.$("$toybox" date +%s)"; fi',
    'echo "[shelly] Codex runtime reset. Bundled APK runtime will be used in new terminal tabs."',
  ].join('\n');
  const r = await execCommand(command, 60_000);
  if (r.exitCode !== 0) {
    throw new Error((r.stderr || r.stdout || `Codex runtime reset exited ${r.exitCode}`).trim());
  }
  return (r.stdout || '').trim();
}

async function fetchFailedLog(runId: number): Promise<string> {
  const command = `gh run view ${runId} -R ${sq(REPO)} --log-failed`;
  const r = await execCommand(command, 60_000);
  if (r.exitCode !== 0) {
    throw new Error((r.stderr || r.stdout || `gh exited ${r.exitCode}`).trim());
  }
  return r.stdout.trim() || 'No failed log output.';
}

type Props = {
  visible: boolean;
  onClose: () => void;
  onStatusChange?: (status: BuildStatus, latest: BuildRun | null) => void;
};

export function BuildsModal({ visible, onClose, onStatusChange }: Props) {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<BuildRun[]>([]);
  const [latestUpdate, setLatestUpdate] = useState<AndroidUpdateManifest | null>(null);
  const [latestCodexRuntime, setLatestCodexRuntime] = useState<CodexRuntimeManifest | null>(null);
  const [installedVersion, setInstalledVersion] = useState<AppVersionInfo | null>(null);
  const [installedCodexInfo, setInstalledCodexInfo] = useState<CodexVersionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [preparingUpdateInstall, setPreparingUpdateInstall] = useState(false);
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  const [installingCodexRuntime, setInstallingCodexRuntime] = useState(false);
  const [resettingCodexRuntime, setResettingCodexRuntime] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [logLoadingId, setLogLoadingId] = useState<number | null>(null);
  const [logTitle, setLogTitle] = useState<string | null>(null);
  const [logText, setLogText] = useState<string>('');
  const [downloadedApk, setDownloadedApk] = useState<{ versionCode: number; path: string } | null>(null);
  const [downloadLog, setDownloadLog] = useState<DownloadLogEntry[]>([]);
  const [downloadStartedAt, setDownloadStartedAt] = useState<number | null>(null);
  const [downloadTick, setDownloadTick] = useState(0);
  const [codexInstallLog, setCodexInstallLog] = useState<DownloadLogEntry[]>([]);
  const [codexInstallStartedAt, setCodexInstallStartedAt] = useState<number | null>(null);
  const [codexInstallTick, setCodexInstallTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const updateInstallInFlight = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // fetchWithTimeout only bounds the request up to the response headers — it
      // clears its AbortController timer the moment fetch() resolves, so the
      // subsequent `await response.json()/.text()` body read is UNBOUNDED. A
      // GitHub response held open mid-body then hangs the body read forever, and
      // Promise.allSettled never settles → "Checking…" sticks (bug: updater hang).
      // Wrap EVERY entry (fetches included) in withTimeout so the whole operation
      // — headers + body read — is bounded and refresh() always completes.
      const [runsResult, updateResult, codexRuntimeResult, versionResult, codexResult] = await Promise.allSettled([
        withTimeout(fetchBuildRuns(), 25_000, 'Build runs'),
        withTimeout(fetchLatestAndroidUpdate(), 25_000, 'Android update'),
        withTimeout(fetchLatestCodexRuntime(), 25_000, 'Codex runtime'),
        withTimeout<AppVersionInfo>(TerminalEmulator.getAppVersionInfo(), 10_000, 'App version'),
        withTimeout<CodexVersionInfo | null>(fetchInstalledCodexVersion(), 20_000, 'Codex version probe'),
      ]);
      let nextRuns: BuildRun[] = [];
      let nextUpdate: AndroidUpdateManifest | null = null;
      let nextInstalled: AppVersionInfo | null = null;
      const errors: string[] = [];

      if (runsResult.status === 'fulfilled') {
        nextRuns = runsResult.value;
        setRuns(nextRuns);
      } else {
        setRuns([]);
        errors.push(String(runsResult.reason?.message || runsResult.reason));
      }

      if (updateResult.status === 'fulfilled') {
        nextUpdate = updateResult.value;
        setLatestUpdate(nextUpdate);
      } else {
        setLatestUpdate(null);
        errors.push(String(updateResult.reason?.message || updateResult.reason));
      }

      if (codexRuntimeResult.status === 'fulfilled') {
        setLatestCodexRuntime(codexRuntimeResult.value);
      } else {
        setLatestCodexRuntime(null);
        errors.push(String(codexRuntimeResult.reason?.message || codexRuntimeResult.reason));
      }

      if (versionResult.status === 'fulfilled') {
        nextInstalled = versionResult.value;
        setInstalledVersion(nextInstalled);
      } else {
        setInstalledVersion(null);
        errors.push(String(versionResult.reason?.message || versionResult.reason));
      }

      if (codexResult.status === 'fulfilled') {
        setInstalledCodexInfo(codexResult.value);
      } else {
        setInstalledCodexInfo(null);
      }

      onStatusChange?.(statusFromUpdate(nextUpdate, nextInstalled), nextRuns[0] ?? null);
      if (errors.length > 0) setError(errors.join('\n'));
    } catch (e: any) {
      const msg = String(e?.message || e);
      setError(msg);
      onStatusChange?.('unknown', null);
    } finally {
      setLoading(false);
    }
  }, [onStatusChange]);

  useEffect(() => {
    setAdvancedOpen(false);
    if (visible) void refresh();
  }, [refresh, visible]);

  useEffect(() => {
    if (!downloadingUpdate) return undefined;
    const timer = setInterval(() => {
      setDownloadTick((n) => n + 1);
    }, 750);
    return () => clearInterval(timer);
  }, [downloadingUpdate]);

  useEffect(() => {
    if (!installingCodexRuntime) return undefined;
    const timer = setInterval(() => {
      setCodexInstallTick((n) => n + 1);
    }, 750);
    return () => clearInterval(timer);
  }, [installingCodexRuntime]);

  const pushDownloadLog = useCallback((id: string, label: string, status: DownloadLogEntry['status'] = 'active') => {
    setDownloadLog((prev) => {
      const settled = prev.map((entry) => (
        entry.status === 'active' ? { ...entry, status: 'done' as const } : entry
      ));
      const index = settled.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        return settled.map((entry, i) => (i === index ? { ...entry, label, status } : entry));
      }
      return [...settled, { id, label, status }];
    });
  }, []);

  const markDownloadFailed = useCallback(() => {
    setDownloadLog((prev) => {
      const settled = prev.map((entry) => (
        entry.status === 'active' ? { ...entry, status: 'error' as const } : entry
      ));
      if (settled.some((entry) => entry.id === 'error')) return settled;
      return [...settled, { id: 'error', label: t('updates.download_log_error'), status: 'error' }];
    });
  }, [t]);

  const pushCodexInstallLog = useCallback((id: string, label: string, status: DownloadLogEntry['status'] = 'active') => {
    setCodexInstallLog((prev) => {
      const settled = prev.map((entry) => (
        entry.status === 'active' ? { ...entry, status: 'done' as const } : entry
      ));
      const index = settled.findIndex((entry) => entry.id === id);
      if (index >= 0) {
        return settled.map((entry, i) => (i === index ? { ...entry, label, status } : entry));
      }
      return [...settled, { id, label, status }];
    });
  }, []);

  const markCodexInstallFailed = useCallback(() => {
    setCodexInstallLog((prev) => {
      const settled = prev.map((entry) => (
        entry.status === 'active' ? { ...entry, status: 'error' as const } : entry
      ));
      if (settled.some((entry) => entry.id === 'error')) return settled;
      return [...settled, { id: 'error', label: t('updates.codex_log_error'), status: 'error' }];
    });
  }, [t]);

  const openApkInstaller = useCallback((apkPath: string) => {
    TerminalEmulator.installApk(apkPath).catch((e: any) => {
      Alert.alert(t('updates.install_failed_title'), String(e?.message || e));
    });
  }, [t]);

  const clearDownloadedApk = useCallback(() => {
    setDownloadedApk(null);
    setDownloadLog((prev) => prev.filter((entry) => entry.id !== 'ready'));
  }, []);

  const openVerifiedApkInstaller = useCallback(async (update: AndroidUpdateManifest, apkPath: string) => {
    setPreparingUpdateInstall(true);
    try {
      const valid = await verifyReleaseApkFile(update, apkPath);
      if (!valid) {
        clearDownloadedApk();
        Alert.alert(t('updates.download_missing_title'), t('updates.download_missing_body'));
        return;
      }
      openApkInstaller(apkPath);
    } finally {
      setPreparingUpdateInstall(false);
    }
  }, [clearDownloadedApk, openApkInstaller, t]);

  const installLatestUpdate = useCallback(async () => {
    if (updateInstallInFlight.current) return;
    const update = latestUpdate;
    if (!update) {
      Alert.alert(t('updates.no_release_title'), t('updates.no_release_body'));
      return;
    }
    updateInstallInFlight.current = true;
    setPreparingUpdateInstall(true);
    try {
      const current = await TerminalEmulator.getAppVersionInfo().catch(() => installedVersion);
      if (!current) {
        Alert.alert(t('updates.verify_failed_title'), t('updates.verify_failed_body'));
        return;
      }
      if (update.versionCode <= current.versionCode) {
        clearDownloadedApk();
        Alert.alert(
          t('updates.up_to_date_title'),
          t('updates.up_to_date_body', {
            current: current.versionCode,
            available: update.versionCode,
          }),
        );
        return;
      }
      if (downloadedApk?.versionCode === update.versionCode) {
        await openVerifiedApkInstaller(update, downloadedApk.path);
        return;
      }
      setDownloadedApk(null);
      setDownloadLog([]);
      setDownloadStartedAt(Date.now());
      setDownloadTick(0);
      setPreparingUpdateInstall(false);
      setDownloadingUpdate(true);
      const apkPath = await downloadReleaseApk(update, (progress) => {
        switch (progress.step) {
          case 'prepare':
            pushDownloadLog('prepare', t('updates.download_log_prepare'));
            break;
          case 'download':
            pushDownloadLog('download', t('updates.download_log_download_progress', {
              name: update.apkAssetName,
              progress: formatDownloadProgress(
                progress.downloadedBytes,
                progress.totalBytes,
                progress.speedBytesPerSec,
              ),
            }));
            break;
          case 'verify':
            pushDownloadLog('verify', t('updates.download_log_verify'));
            break;
          case 'ready':
            pushDownloadLog('ready', t('updates.download_log_ready'), 'done');
            break;
        }
      });
      setDownloadedApk({ versionCode: update.versionCode, path: apkPath });
      Alert.alert(
        t('updates.ready_title'),
        t('updates.download_install_alert_body'),
        [
          { text: t('updates.later'), style: 'cancel' },
          {
            text: t('updates.install'),
            onPress: () => void openVerifiedApkInstaller(update, apkPath),
          },
        ],
      );
    } catch (e: any) {
      markDownloadFailed();
      Alert.alert(t('updates.download_failed_title'), String(e?.message || e));
    } finally {
      updateInstallInFlight.current = false;
      setPreparingUpdateInstall(false);
      setDownloadingUpdate(false);
    }
  }, [
    clearDownloadedApk,
    downloadedApk,
    installedVersion,
    latestUpdate,
    markDownloadFailed,
    openVerifiedApkInstaller,
    pushDownloadLog,
    t,
  ]);

  const installLatestCodexRuntime = useCallback(async () => {
    const update = latestCodexRuntime;
    if (!update) {
      Alert.alert(t('updates.codex_unavailable_title'), t('updates.codex_unavailable_body'));
      return;
    }
    setCodexInstallLog([]);
    setCodexInstallStartedAt(Date.now());
    setCodexInstallTick(0);
    setInstallingCodexRuntime(true);
    try {
      pushCodexInstallLog('prepare', t('updates.codex_log_prepare'));
      pushCodexInstallLog('install', t('updates.codex_log_installing', { version: update.version }));
      await installCodexRuntime(update);
      pushCodexInstallLog('ready', t('updates.codex_log_ready'), 'done');
      Alert.alert(t('updates.codex_ready_title'), t('updates.codex_ready_body'));
      await refresh();
    } catch (e: any) {
      markCodexInstallFailed();
      Alert.alert(t('updates.codex_install_failed_title'), String(e?.message || e));
    } finally {
      setInstallingCodexRuntime(false);
    }
  }, [latestCodexRuntime, markCodexInstallFailed, pushCodexInstallLog, refresh, t]);

  const resetInstalledCodexRuntime = useCallback(async () => {
    setResettingCodexRuntime(true);
    try {
      await resetCodexRuntime();
      Alert.alert(t('updates.codex_reset_title'), t('updates.codex_reset_body'));
      await refresh();
    } catch (e: any) {
      Alert.alert(t('updates.codex_reset_failed_title'), String(e?.message || e));
    } finally {
      setResettingCodexRuntime(false);
    }
  }, [refresh, t]);

  const showFailedLog = useCallback(async (run: BuildRun) => {
    setLogLoadingId(run.databaseId);
    setLogTitle(`#${run.number || run.databaseId} failed log`);
    try {
      setLogText(await fetchFailedLog(run.databaseId));
    } catch (e: any) {
      setLogText(`${String(e?.message || e)}\n\nGitHub: ${run.url || 'n/a'}`);
    } finally {
      setLogLoadingId(null);
    }
  }, []);

  const updateIsNewer = Boolean(
    installedVersion && latestUpdate && latestUpdate.versionCode > installedVersion.versionCode,
  );
  const readyToInstallUpdate = Boolean(
    updateIsNewer &&
    latestUpdate &&
    downloadedApk?.versionCode === latestUpdate.versionCode &&
    downloadedApk.path,
  );
  const downloadDots = '.'.repeat((downloadTick % 3) + 1);
  const downloadElapsedSec = downloadStartedAt
    ? Math.max(0, Math.floor((Date.now() - downloadStartedAt) / 1000))
    : 0;
  const codexInstallDots = '.'.repeat((codexInstallTick % 3) + 1);
  const codexInstallElapsedSec = codexInstallStartedAt
    ? Math.max(0, Math.floor((Date.now() - codexInstallStartedAt) / 1000))
    : 0;
  const canInstallUpdate = updateIsNewer && !preparingUpdateInstall && !downloadingUpdate;
  const currentVersionText = installedVersion
    ? t('updates.current_version', {
      versionName: installedVersion.versionName || t('updates.unknown'),
      versionCode: installedVersion.versionCode,
    })
    : t('updates.current_unavailable');
  const availableVersionText = latestUpdate
    ? t('updates.available_version', {
      versionName: latestUpdate.versionName || t('updates.unknown'),
      versionCode: latestUpdate.versionCode,
    })
    : t('updates.details_unavailable');
  const bundledCodexVersion = codexVersionFromUpdate(latestUpdate);
  const availableCodexVersion = latestCodexRuntime?.version || bundledCodexVersion;
  const codexRuntimeIsNewer = Boolean(
    latestCodexRuntime && installedCodexInfo && compareSemver(latestCodexRuntime.version, installedCodexInfo.version) > 0,
  );
  const codexRuntimeNeedsRepair = installedCodexInfo?.source === 'runtime_broken';
  const canInstallCodexRuntime = Boolean(
    latestCodexRuntime &&
    !installingCodexRuntime &&
    !resettingCodexRuntime &&
    (!installedCodexInfo || codexRuntimeIsNewer || codexRuntimeNeedsRepair),
  );
  const currentCodexText = installedCodexInfo
    ? t('updates.current_codex_version', { version: installedCodexInfo.version })
    : t('updates.current_codex_unavailable');
  const codexSourceText = installedCodexInfo
    ? t('updates.codex_runtime_source', {
      source: installedCodexInfo.source === 'runtime'
        ? t('updates.codex_runtime_app_data')
        : installedCodexInfo.source === 'bundled'
          ? t('updates.codex_runtime_bundled')
          : installedCodexInfo.source === 'runtime_broken'
            ? t('updates.codex_runtime_broken_source')
            : t('updates.unknown'),
    })
    : null;
  const availableCodexText = availableCodexVersion
    ? t('updates.available_codex_version', { version: availableCodexVersion })
    : null;
  const updateStatusText = loading
    ? t('updates.checking')
    : !latestUpdate
      ? t('updates.status_unavailable')
      : !installedVersion
        ? t('updates.verify_failed_title')
        : updateIsNewer
          ? t('updates.available')
          : t('updates.latest_status');
  const updateIconName = loading
    ? 'sync'
    : !latestUpdate || !installedVersion
      ? 'error-outline'
      : updateIsNewer
        ? 'system-update-alt'
        : 'check-circle';
  const updateActionLabel = downloadingUpdate
    ? t('updates.downloading')
    : preparingUpdateInstall
      ? t('updates.checking_short')
    : readyToInstallUpdate
      ? t('updates.install')
    : updateIsNewer
      ? t('updates.update')
      : loading
        ? t('updates.checking_short')
        : latestUpdate && installedVersion
          ? t('updates.latest')
          : t('updates.unavailable');
  const codexStatusText = loading
    ? t('updates.checking')
    : !latestCodexRuntime
      ? t('updates.codex_status_unavailable')
      : !installedCodexInfo
        ? t('updates.current_codex_unavailable')
      : codexRuntimeNeedsRepair
        ? t('updates.codex_runtime_broken_status')
        : codexRuntimeIsNewer
          ? t('updates.codex_available')
          : t('updates.codex_latest_status');
  const codexIconName = loading
    ? 'sync'
    : !latestCodexRuntime || !installedCodexInfo
      ? 'error-outline'
      : codexRuntimeNeedsRepair
        ? 'error-outline'
      : codexRuntimeIsNewer
        ? 'upgrade'
        : 'check-circle';
  const codexActionLabel = installingCodexRuntime
    ? t('updates.installing')
    : codexRuntimeNeedsRepair
      ? t('updates.codex_reinstall')
      : codexRuntimeIsNewer || !installedCodexInfo
      ? t('updates.codex_update')
      : loading
        ? t('updates.checking_short')
        : latestCodexRuntime
          ? t('updates.latest')
          : t('updates.unavailable');
  const hasCodexRuntimeToReset = Boolean(installedCodexInfo?.runtimePresent);
  const canResetCodexRuntime = hasCodexRuntimeToReset && !installingCodexRuntime && !resettingCodexRuntime;
  const renderProgressLog = (
    title: string,
    active: boolean,
    elapsedSec: number,
    entries: DownloadLogEntry[],
    dots: string,
  ) => {
    if (!active && entries.length === 0) return null;
    return (
      <View style={styles.downloadLogBox}>
        <View style={styles.downloadLogHead}>
          {active ? (
            <ActivityIndicator size="small" color={C.accent} />
          ) : (
            <MaterialIcons name="article" size={13} color={C.accent} />
          )}
          <Text style={styles.downloadLogTitle}>{title}</Text>
          {active && (
            <Text style={styles.downloadLogElapsed}>
              {t('updates.download_log_elapsed', { seconds: elapsedSec })}
            </Text>
          )}
        </View>
        {entries.map((entry) => {
          const rowActive = entry.status === 'active';
          const failed = entry.status === 'error';
          return (
            <View key={entry.id} style={styles.downloadLogRow}>
              {rowActive ? (
                <ActivityIndicator size="small" color={C.accent} />
              ) : (
                <MaterialIcons
                  name={failed ? 'error-outline' : 'check-circle'}
                  size={12}
                  color={failed ? '#FCA5A5' : C.accent}
                />
              )}
              <Text
                style={[
                  styles.downloadLogText,
                  rowActive && styles.downloadLogTextActive,
                  failed && styles.downloadLogTextError,
                ]}
                numberOfLines={2}
              >
                {rowActive ? `${entry.label}${dots}` : entry.label}
              </Text>
            </View>
          );
        })}
      </View>
    );
  };

  return (
    <>
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={styles.root}>
          <ModalHeader title={t('updates.title')} onClose={onClose} />
          <View style={styles.toolbar}>
            <Text style={styles.subtitle}>{t('updates.subtitle')}</Text>
            <Pressable
              style={styles.refreshBtn}
              onPress={() => setAdvancedOpen((v) => !v)}
            >
              <MaterialIcons name={advancedOpen ? 'expand-less' : 'expand-more'} size={15} color={C.accent} />
              <Text style={styles.refreshText}>{t('updates.advanced')}</Text>
            </Pressable>
            <Pressable style={styles.refreshBtn} onPress={refresh} disabled={loading}>
              {loading ? (
                <ActivityIndicator size="small" color={C.accent} />
              ) : (
                <MaterialIcons name="refresh" size={15} color={C.accent} />
              )}
              <Text style={styles.refreshText}>{t('updates.refresh')}</Text>
            </Pressable>
          </View>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            <View style={styles.updateBox}>
              <View style={styles.updateHead}>
                <View style={styles.statusIcon}>
                  <MaterialIcons name={updateIconName as any} size={18} color={C.accent} />
                </View>
                <View style={styles.updateCopy}>
                  <Text style={styles.updateTitle}>{updateStatusText}</Text>
                  <Text style={styles.updateMeta}>{currentVersionText}</Text>
                  {latestUpdate && <Text style={styles.updateMeta}>{availableVersionText}</Text>}
                </View>
                <Pressable
                  style={[styles.actionBtn, !canInstallUpdate && styles.actionBtnDisabled]}
                  onPress={() => void installLatestUpdate()}
                  disabled={!canInstallUpdate}
                >
                  {downloadingUpdate ? (
                    <ActivityIndicator size="small" color={C.bgDeep} />
                  ) : preparingUpdateInstall ? (
                    <ActivityIndicator size="small" color={C.bgDeep} />
                  ) : (
                    <MaterialIcons
                      name={readyToInstallUpdate ? 'install-mobile' : 'system-update-alt'}
                      size={13}
                      color={canInstallUpdate ? C.bgDeep : C.text3}
                    />
                  )}
                  <Text style={[styles.actionText, !canInstallUpdate && styles.actionTextDisabled]}>
                    {updateActionLabel}
                  </Text>
                </Pressable>
              </View>
              {updateIsNewer && (
                <Text style={styles.updateHint}>{t('updates.android_confirm')}</Text>
              )}
              {readyToInstallUpdate && !downloadingUpdate && (
                <Text style={styles.updateHint}>{t('updates.download_install_ready_hint')}</Text>
              )}
              {renderProgressLog(
                t('updates.download_log_title'),
                downloadingUpdate,
                downloadElapsedSec,
                downloadLog,
                downloadDots,
              )}
            </View>

            <View style={styles.updateBox}>
              <View style={styles.updateHead}>
                <View style={styles.statusIcon}>
                  <MaterialIcons name={codexIconName as any} size={18} color={C.accent} />
                </View>
                <View style={styles.updateCopy}>
                  <Text style={styles.updateTitle}>{codexStatusText}</Text>
                  <Text style={styles.updateMeta}>{currentCodexText}</Text>
                  {codexSourceText && <Text style={styles.updateMeta}>{codexSourceText}</Text>}
                  {availableCodexText && <Text style={styles.updateMeta}>{availableCodexText}</Text>}
                  {(codexRuntimeIsNewer || installedCodexInfo?.source === 'runtime' || codexRuntimeNeedsRepair) && (
                    <Text style={styles.updateHint}>{t('updates.codex_next_terminal_hint')}</Text>
                  )}
                </View>
                <View style={styles.actionGroup}>
                  <Pressable
                    style={[styles.actionBtn, !canInstallCodexRuntime && styles.actionBtnDisabled]}
                    onPress={() => void installLatestCodexRuntime()}
                    disabled={!canInstallCodexRuntime}
                  >
                    {installingCodexRuntime ? (
                      <ActivityIndicator size="small" color={C.bgDeep} />
                    ) : (
                      <MaterialIcons name="upgrade" size={13} color={canInstallCodexRuntime ? C.bgDeep : C.text3} />
                    )}
                    <Text style={[styles.actionText, !canInstallCodexRuntime && styles.actionTextDisabled]}>
                      {codexActionLabel}
                    </Text>
                  </Pressable>
                  {hasCodexRuntimeToReset && (
                    <Pressable
                      style={[styles.actionBtn, styles.secondaryActionBtn, !canResetCodexRuntime && styles.actionBtnDisabled]}
                      onPress={() => void resetInstalledCodexRuntime()}
                      disabled={!canResetCodexRuntime}
                    >
                      {resettingCodexRuntime ? (
                        <ActivityIndicator size="small" color={C.accent} />
                      ) : (
                        <MaterialIcons name="restore" size={13} color={canResetCodexRuntime ? C.accent : C.text3} />
                      )}
                      <Text style={[styles.actionText, styles.secondaryActionText, !canResetCodexRuntime && styles.actionTextDisabled]}>
                        {t('updates.codex_reset')}
                      </Text>
                    </Pressable>
                  )}
                </View>
              </View>
              {renderProgressLog(
                t('updates.codex_log_title'),
                installingCodexRuntime,
                codexInstallElapsedSec,
                codexInstallLog,
                codexInstallDots,
              )}
            </View>

            {advancedOpen && (
              <View style={styles.advancedSection}>
                <Text style={styles.advancedTitle}>{t('updates.build_details')}</Text>
                {error && (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                )}
                {runs.map((run) => {
                  const status = statusFromRun(run);
                  const releaseMatchesRun = Boolean(
                    (latestUpdate && (
                      (latestUpdate.runId && latestUpdate.runId === run.databaseId) ||
                      (!latestUpdate.runId && latestUpdate.gitSha && latestUpdate.gitSha === run.headSha)
                    )) ||
                    (latestCodexRuntime && (
                      (latestCodexRuntime.runId && latestCodexRuntime.runId === run.databaseId) ||
                      (!latestCodexRuntime.runId && latestCodexRuntime.gitSha && latestCodexRuntime.gitSha === run.headSha)
                    )),
                  );
                  const failed = run.status === 'completed' && status === 'failure';
                  const logBusy = logLoadingId === run.databaseId;
                  return (
                    <View key={run.databaseId} style={styles.runCard}>
                      <View style={styles.runHead}>
                        <View style={[styles.dot, { backgroundColor: buildStatusColor(status) }]} />
                        <Text style={styles.runTitle} numberOfLines={2}>{run.displayTitle || `Run #${run.databaseId}`}</Text>
                      </View>
                      <Text style={styles.runMeta}>
                        #{run.number || run.databaseId} · {run.status}{run.conclusion ? `/${run.conclusion}` : ''} · {formatDuration(durationSec(run))} · {run.headSha.slice(0, 8)}
                      </Text>
                      <Text style={styles.runMeta}>{new Date(run.createdAt).toLocaleString()}</Text>
                      <View style={styles.runActions}>
                        {failed && (
                          <Pressable
                            style={[styles.actionBtn, styles.logBtn]}
                            onPress={() => void showFailedLog(run)}
                            disabled={logBusy}
                          >
                            {logBusy ? (
                              <ActivityIndicator size="small" color={C.accent} />
                            ) : (
                              <MaterialIcons name="article" size={13} color={C.accent} />
                            )}
                            <Text style={[styles.actionText, styles.logText]}>
                              {logBusy ? t('updates.loading_log') : t('updates.failed_log')}
                            </Text>
                          </Pressable>
                        )}
                        {releaseMatchesRun && (
                          <View style={styles.releaseBadge}>
                            <MaterialIcons name="verified" size={12} color={C.accent} />
                            <Text style={styles.releaseBadgeText}>{t('updates.release_source')}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })}
                {!loading && runs.length === 0 && !error && (
                  <Text style={styles.empty}>{t('updates.no_recent_builds')}</Text>
                )}
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>
      <Modal visible={Boolean(logTitle)} animationType="slide" onRequestClose={() => setLogTitle(null)}>
        <View style={styles.root}>
          <ModalHeader title={logTitle || t('updates.failed_log').toUpperCase()} onClose={() => setLogTitle(null)} />
          <ScrollView style={styles.body} contentContainerStyle={styles.logContent}>
            <Text selectable style={styles.logOutput}>{logText || t('updates.loading')}</Text>
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bgDeep,
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: S.borderWidth,
    borderBottomColor: C.border,
  },
  subtitle: {
    flex: 1,
    color: C.text2,
    fontFamily: F.family,
    fontSize: F.badge.size,
  },
  refreshBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.4),
    borderRadius: R.badge,
  },
  refreshText: {
    color: C.accent,
    fontFamily: F.family,
    fontSize: F.badge.size,
    fontWeight: '700',
  },
  errorBox: {
    margin: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: withAlpha('#EF4444', 0.5),
    borderRadius: R.badge,
    backgroundColor: withAlpha('#EF4444', 0.08),
  },
  errorText: {
    color: '#FCA5A5',
    fontFamily: F.family,
    fontSize: F.badge.size,
  },
  body: {
    flex: 1,
  },
  bodyContent: {
    padding: 12,
    gap: 10,
  },
  updateBox: {
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.45),
    borderRadius: R.badge,
    backgroundColor: withAlpha(C.accent, 0.08),
    padding: 10,
    gap: 4,
  },
  updateHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  actionGroup: {
    alignItems: 'flex-end',
    gap: 7,
  },
  statusIcon: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: R.badge,
    backgroundColor: C.bgDeep,
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.4),
  },
  updateCopy: {
    flex: 1,
    gap: 4,
  },
  updateTitle: {
    color: C.text1,
    fontFamily: F.family,
    fontSize: F.sidebarItem.size,
    fontWeight: '700',
  },
  updateMeta: {
    color: C.text2,
    fontFamily: F.family,
    fontSize: F.badge.size,
  },
  updateHint: {
    color: C.text3,
    fontFamily: F.family,
    fontSize: F.badge.size,
    marginTop: 4,
  },
  downloadLogBox: {
    marginTop: 8,
    padding: 9,
    gap: 7,
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.3),
    borderRadius: R.badge,
    backgroundColor: withAlpha(C.bgDeep, 0.7),
  },
  downloadLogHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  downloadLogTitle: {
    flex: 1,
    color: C.text1,
    fontFamily: F.family,
    fontSize: F.badge.size,
    fontWeight: '700',
  },
  downloadLogElapsed: {
    color: C.text3,
    fontFamily: F.family,
    fontSize: F.badge.size,
  },
  downloadLogRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 16,
  },
  downloadLogText: {
    flex: 1,
    color: C.text2,
    fontFamily: F.family,
    fontSize: F.badge.size,
    lineHeight: 16,
  },
  downloadLogTextActive: {
    color: C.text1,
  },
  downloadLogTextError: {
    color: '#FCA5A5',
  },
  advancedSection: {
    gap: 10,
  },
  advancedTitle: {
    color: C.text2,
    fontFamily: F.family,
    fontSize: F.badge.size,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  runCard: {
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: R.badge,
    backgroundColor: C.bgSurface,
    padding: 12,
    gap: 6,
  },
  runHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  runTitle: {
    flex: 1,
    color: C.text1,
    fontFamily: F.family,
    fontSize: F.sidebarItem.size,
    fontWeight: '700',
  },
  runMeta: {
    color: C.text3,
    fontFamily: F.family,
    fontSize: F.badge.size,
  },
  runActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: R.badge,
    backgroundColor: C.accent,
  },
  actionBtnDisabled: {
    backgroundColor: C.bgDeep,
    borderWidth: 1,
    borderColor: C.border,
  },
  secondaryActionBtn: {
    backgroundColor: C.bgDeep,
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.45),
  },
  actionText: {
    color: C.bgDeep,
    fontFamily: F.family,
    fontSize: F.badge.size,
    fontWeight: '700',
  },
  actionTextDisabled: {
    color: C.text3,
  },
  secondaryActionText: {
    color: C.accent,
  },
  logBtn: {
    backgroundColor: C.bgDeep,
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.45),
  },
  logText: {
    color: C.accent,
  },
  releaseBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderRadius: R.badge,
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.45),
    backgroundColor: C.bgDeep,
  },
  releaseBadgeText: {
    color: C.accent,
    fontFamily: F.family,
    fontSize: F.badge.size,
    fontWeight: '700',
  },
  logContent: {
    padding: 12,
  },
  logOutput: {
    color: C.text2,
    fontFamily: F.family,
    fontSize: F.badge.size,
    lineHeight: 16,
  },
  empty: {
    color: C.text3,
    fontFamily: F.family,
    fontSize: F.sidebarItem.size,
    textAlign: 'center',
    marginTop: 30,
  },
});
