// components/layout/BuildsModal.tsx
//
// Mobile self-update surface for the Shelly-on-Shelly loop. It reads the
// latest GitHub Actions APK runs, installs the latest public release APK from
// GitHub Releases, then hands the APK to Android's package installer.

import React, { useCallback, useEffect, useState } from 'react';
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
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { ModalHeader } from '@/components/settings/ModalHeader';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { execCommand } from '@/hooks/use-native-exec';
import { colors as C, fonts as F, radii as R, sizes as S } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';

const REPO = 'RYOITABASHI/Shelly';
const WORKFLOW = 'build-android.yml';
const UPDATE_TAG = 'android-latest';
const UPDATE_MANIFEST_ASSET = 'latest.json';
const APK_NAME_RE = /^[A-Za-z0-9._-]+\.apk$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

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
  gitSha: string;
  runId?: number;
  runNumber?: number;
  createdAt?: string;
  apkAssetName: string;
  apkUrl: string;
  sha256: string;
};

type AppVersionInfo = {
  packageName: string;
  versionName: string;
  versionCode: number;
};

function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function statusFromRun(run?: BuildRun | null): BuildStatus {
  if (!run) return 'unknown';
  if (run.status !== 'completed') return 'in_progress';
  return run.conclusion === 'success' ? 'success' : 'failure';
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
  const response = await fetch(apiUrl, {
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
  const releaseResponse = await fetch(releaseUrl, {
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

  const manifestResponse = await fetch(String(manifestAsset.browser_download_url), {
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
    gitSha: String(raw?.gitSha || ''),
    runId: Number.isInteger(Number(raw?.runId)) ? Number(raw.runId) : undefined,
    runNumber: Number.isInteger(Number(raw?.runNumber)) ? Number(raw.runNumber) : undefined,
    createdAt: raw?.createdAt ? String(raw.createdAt) : undefined,
    apkAssetName,
    apkUrl: String(apkAsset.browser_download_url),
    sha256,
  };
}

async function downloadReleaseApk(update: AndroidUpdateManifest): Promise<string> {
  const outDir = `/sdcard/Download/shelly-update-${update.versionCode}`;
  const apkPath = `${outDir}/${update.apkAssetName}`;
  const command = [
    `rm -rf ${sq(outDir)}`,
    `mkdir -p ${sq(outDir)}`,
    `curl -fL --silent --show-error --retry 3 --retry-delay 2 --connect-timeout 20 -o ${sq(apkPath)} ${sq(update.apkUrl)}`,
    `actual=$(sha256sum ${sq(apkPath)} | awk '{print $1}')`,
    `if [ "$actual" != ${sq(update.sha256)} ]; then echo "sha256 mismatch: expected ${update.sha256}, got $actual" >&2; exit 65; fi`,
    `printf '%s\\n' ${sq(apkPath)}`,
  ].join(' && ');
  const r = await execCommand(command, 1_800_000);
  if (r.exitCode !== 0) {
    throw new Error((r.stderr || r.stdout || `download exited ${r.exitCode}`).trim());
  }
  const downloadedPath = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  if (!downloadedPath.endsWith('.apk')) {
    throw new Error(`APK was not found under ${outDir}`);
  }
  return downloadedPath;
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
  const [runs, setRuns] = useState<BuildRun[]>([]);
  const [latestUpdate, setLatestUpdate] = useState<AndroidUpdateManifest | null>(null);
  const [installedVersion, setInstalledVersion] = useState<AppVersionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloadingUpdate, setDownloadingUpdate] = useState(false);
  const [logLoadingId, setLogLoadingId] = useState<number | null>(null);
  const [logTitle, setLogTitle] = useState<string | null>(null);
  const [logText, setLogText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [runsResult, updateResult, versionResult] = await Promise.allSettled([
        fetchBuildRuns(),
        fetchLatestAndroidUpdate(),
        TerminalEmulator.getAppVersionInfo(),
      ]);
      let nextRuns: BuildRun[] = [];
      const errors: string[] = [];

      if (runsResult.status === 'fulfilled') {
        nextRuns = runsResult.value;
        setRuns(nextRuns);
        onStatusChange?.(statusFromRun(nextRuns[0]), nextRuns[0] ?? null);
      } else {
        setRuns([]);
        errors.push(String(runsResult.reason?.message || runsResult.reason));
        onStatusChange?.('unknown', null);
      }

      if (updateResult.status === 'fulfilled') {
        setLatestUpdate(updateResult.value);
      } else {
        setLatestUpdate(null);
        errors.push(String(updateResult.reason?.message || updateResult.reason));
      }

      if (versionResult.status === 'fulfilled') {
        setInstalledVersion(versionResult.value);
      } else {
        setInstalledVersion(null);
        errors.push(String(versionResult.reason?.message || versionResult.reason));
      }

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
    if (visible) void refresh();
  }, [refresh, visible]);

  const installLatestUpdate = useCallback(async () => {
    const update = latestUpdate;
    if (!update) {
      Alert.alert('No public APK release', `The ${UPDATE_TAG} release is not available yet.`);
      return;
    }
    setDownloadingUpdate(true);
    try {
      const current = await TerminalEmulator.getAppVersionInfo().catch(() => installedVersion);
      if (!current) {
        Alert.alert('Cannot verify installed version', 'Shelly could not read the current Android versionCode, so the update was not downloaded.');
        return;
      }
      if (update.versionCode <= current.versionCode) {
        Alert.alert(
          'Up to date',
          `Installed versionCode ${current.versionCode} is already newer than or equal to available ${update.versionCode}.`,
        );
        return;
      }
      const apkPath = await downloadReleaseApk(update);
      Alert.alert(
        'APK downloaded',
        `${apkPath}\n\nAndroid will ask you to confirm installation.`,
        [
          { text: 'Later', style: 'cancel' },
          {
            text: 'Install',
            onPress: () => {
              TerminalEmulator.installApk(apkPath).catch((e: any) => {
                Alert.alert('Install failed', String(e?.message || e));
              });
            },
          },
        ],
      );
    } catch (e: any) {
      Alert.alert('Download failed', String(e?.message || e));
    } finally {
      setDownloadingUpdate(false);
    }
  }, [installedVersion, latestUpdate]);

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

  return (
    <>
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={styles.root}>
          <ModalHeader title="BUILDS / UPDATES" onClose={onClose} />
          <View style={styles.toolbar}>
            <Text style={styles.subtitle}>GitHub Actions · {REPO}</Text>
            <Pressable style={styles.refreshBtn} onPress={refresh} disabled={loading}>
              {loading ? (
                <ActivityIndicator size="small" color={C.accent} />
              ) : (
                <MaterialIcons name="refresh" size={15} color={C.accent} />
              )}
              <Text style={styles.refreshText}>Refresh</Text>
            </Pressable>
          </View>
          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {latestUpdate && (
              <View style={styles.updateBox}>
                <View style={styles.updateHead}>
                  <View style={styles.updateCopy}>
                    <Text style={styles.updateTitle}>
                      Android update · v{latestUpdate.versionName || 'unknown'} ({latestUpdate.versionCode})
                    </Text>
                    <Text style={styles.updateMeta}>
                      Installed {installedVersion ? `${installedVersion.versionName || 'unknown'} (${installedVersion.versionCode})` : 'unknown'}
                      {latestUpdate.runNumber ? ` · run #${latestUpdate.runNumber}` : ''}
                    </Text>
                  </View>
                  {(() => {
                    const updateIsNewer = Boolean(installedVersion && latestUpdate.versionCode > installedVersion.versionCode);
                    const installable = updateIsNewer && !downloadingUpdate;
                    return (
                      <Pressable
                        style={[styles.actionBtn, !installable && styles.actionBtnDisabled]}
                        onPress={() => void installLatestUpdate()}
                        disabled={!installable}
                      >
                        {downloadingUpdate ? (
                          <ActivityIndicator size="small" color={C.bgDeep} />
                        ) : (
                          <MaterialIcons name="system-update-alt" size={13} color={installable ? C.bgDeep : C.text3} />
                        )}
                        <Text style={[styles.actionText, !installable && styles.actionTextDisabled]}>
                          {downloadingUpdate ? 'Downloading...' : updateIsNewer ? 'Install APK' : installedVersion ? 'Up to date' : 'Version unknown'}
                        </Text>
                      </Pressable>
                    );
                  })()}
                </View>
              </View>
            )}
            {runs.map((run) => {
              const status = statusFromRun(run);
              const releaseMatchesRun = Boolean(
                latestUpdate && (
                  (latestUpdate.runId && latestUpdate.runId === run.databaseId) ||
                  (!latestUpdate.runId && latestUpdate.gitSha && latestUpdate.gitSha === run.headSha)
                ),
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
                          {logBusy ? 'Loading log...' : 'Failed log'}
                        </Text>
                      </Pressable>
                    )}
                    {releaseMatchesRun && (
                      <View style={styles.releaseBadge}>
                        <MaterialIcons name="verified" size={12} color={C.accent} />
                        <Text style={styles.releaseBadgeText}>Release source</Text>
                      </View>
                    )}
                  </View>
                </View>
              );
            })}
            {!loading && runs.length === 0 && !error && (
              <Text style={styles.empty}>No recent APK builds found.</Text>
            )}
          </ScrollView>
        </View>
      </Modal>
      <Modal visible={Boolean(logTitle)} animationType="slide" onRequestClose={() => setLogTitle(null)}>
        <View style={styles.root}>
          <ModalHeader title={logTitle || 'FAILED LOG'} onClose={() => setLogTitle(null)} />
          <ScrollView style={styles.body} contentContainerStyle={styles.logContent}>
            <Text selectable style={styles.logOutput}>{logText || 'Loading...'}</Text>
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
  actionText: {
    color: C.bgDeep,
    fontFamily: F.family,
    fontSize: F.badge.size,
    fontWeight: '700',
  },
  actionTextDisabled: {
    color: C.text3,
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
