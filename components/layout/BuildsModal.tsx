// components/layout/BuildsModal.tsx
//
// Mobile self-update surface for the Shelly-on-Shelly loop. It reads the
// latest GitHub Actions APK runs, downloads a selected artifact to
// /sdcard/Download, then hands the APK to Android's package installer.

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
  const command =
    `gh run list -R ${sq(REPO)} --workflow ${sq(WORKFLOW)} --limit 5 ` +
    `--json databaseId,number,status,conclusion,displayTitle,headSha,createdAt,startedAt,updatedAt,url`;
  const r = await execCommand(command, 30_000);
  if (r.exitCode === 0) {
    return JSON.parse(r.stdout || '[]') as BuildRun[];
  }

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
    throw new Error(body || r.stderr || r.stdout || `GitHub API HTTP ${response.status}`);
  }
  return mapApiRuns(await response.json());
}

async function downloadBuildApk(runId: number): Promise<string> {
  const outDir = `/sdcard/Download/shelly-build-${runId}`;
  const command = [
    `gh auth status >/dev/null 2>&1 || { echo 'GitHub artifact downloads require GitHub CLI auth. Run: gh auth login' >&2; exit 64; }`,
    `rm -rf ${sq(outDir)}`,
    `mkdir -p ${sq(outDir)}`,
    `gh run download ${runId} -R ${sq(REPO)} --name shelly-apk -D ${sq(outDir)}`,
    `find ${sq(outDir)} -type f -name '*.apk' | head -n 1`,
  ].join(' && ');
  const r = await execCommand(command, 180_000);
  if (r.exitCode !== 0) {
    throw new Error((r.stderr || r.stdout || `gh exited ${r.exitCode}`).trim());
  }
  const apkPath = r.stdout.trim().split('\n').filter(Boolean).pop() ?? '';
  if (!apkPath.endsWith('.apk')) {
    throw new Error(`APK artifact was not found under ${outDir}`);
  }
  return apkPath;
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
  const [loading, setLoading] = useState(false);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const [logLoadingId, setLogLoadingId] = useState<number | null>(null);
  const [logTitle, setLogTitle] = useState<string | null>(null);
  const [logText, setLogText] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await fetchBuildRuns();
      setRuns(next);
      onStatusChange?.(statusFromRun(next[0]), next[0] ?? null);
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

  const installRun = useCallback(async (run: BuildRun) => {
    if (run.status !== 'completed' || run.conclusion !== 'success') {
      Alert.alert('Build is not installable', 'Only successful completed APK builds can be installed.');
      return;
    }
    setDownloadingId(run.databaseId);
    try {
      const apkPath = await downloadBuildApk(run.databaseId);
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
      setDownloadingId(null);
    }
  }, []);

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
            {runs.map((run) => {
              const status = statusFromRun(run);
              const installable = status === 'success';
              const failed = run.status === 'completed' && status === 'failure';
              const busy = downloadingId === run.databaseId;
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
                    <Pressable
                      style={[styles.actionBtn, !installable && styles.actionBtnDisabled]}
                      onPress={() => void installRun(run)}
                      disabled={!installable || busy}
                    >
                      {busy ? (
                        <ActivityIndicator size="small" color={C.bgDeep} />
                      ) : (
                        <MaterialIcons name="system-update-alt" size={13} color={installable ? C.bgDeep : C.text3} />
                      )}
                      <Text style={[styles.actionText, !installable && styles.actionTextDisabled]}>
                        {busy ? 'Downloading...' : 'Install APK'}
                      </Text>
                    </Pressable>
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
