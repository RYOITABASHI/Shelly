import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { logError } from '@/lib/debug-logger';

type Props = {
  visible: boolean;
  onClose: () => void;
};

type ScouterSession = {
  sessionId?: string;
  source?: string;
  sourceBadge?: string;
  projectName?: string;
  gitBranch?: string | null;
  currentStatus?: string;
  currentTool?: string | null;
  currentFile?: string | null;
  lastEventAt?: number;
  sessionStartAt?: number;
  totalCostUsd?: number;
  tokensUsed?: number;
  contextPercentRemaining?: number | null;
  lastError?: string | null;
};

type ScouterDebugInfo = {
  enabled?: boolean;
  port?: number;
  serverRunning?: boolean;
  jsonlWatcherRunning?: boolean;
  hookTokenPreview?: string;
  claudeHookUrl?: string;
  codexHookUrl?: string;
  sessions?: ScouterSession[];
};

const STALE_MS = 10 * 60 * 1000;

export function ScouterDetailModal({ visible, onClose }: Props) {
  const [info, setInfo] = useState<ScouterDebugInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const raw = await TerminalEmulator.getScouterDebugInfo();
      setInfo(JSON.parse(raw));
    } catch (e: any) {
      const message = String(e?.message || e);
      setError(message);
      logError('ScouterDetailModal', 'Failed to load Scouter detail', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    load();
    const id = setInterval(load, 5_000);
    return () => clearInterval(id);
  }, [visible, load]);

  const sessions = useMemo(() => info?.sessions ?? [], [info]);
  const latest = sessions[0];

  const copyHooks = useCallback(async () => {
    try {
      const [cc, codex] = await Promise.all([
        TerminalEmulator.getScouterHookTemplate('cc'),
        TerminalEmulator.getScouterHookTemplate('codex'),
      ]);
      await Clipboard.setStringAsync(`Claude Code:\n${cc}\n\nCodex:\n${codex}`);
    } catch (e: any) {
      setError(String(e?.message || e));
      logError('ScouterDetailModal', 'Failed to copy hook templates', e);
    }
  }, []);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>SCOUTER</Text>
            <View style={styles.headerActions}>
              <Pressable style={styles.iconButton} onPress={load} accessibilityRole="button" accessibilityLabel="Refresh Scouter status">
                {loading ? <ActivityIndicator size="small" color="#7DDB7D" /> : <MaterialIcons name="refresh" size={18} color="#9BC49B" />}
              </Pressable>
              <Pressable style={styles.iconButton} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close Scouter">
                <MaterialIcons name="close" size={18} color="#9BC49B" />
              </Pressable>
            </View>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
            <View style={styles.statusGrid}>
              <StatusPill label="SERVICE" value={info?.enabled ? 'ON' : 'OFF'} tone={info?.enabled ? 'good' : 'muted'} />
              <StatusPill label="HOOK" value={info?.serverRunning ? `:${info?.port}` : 'STOPPED'} tone={info?.serverRunning ? 'good' : 'bad'} />
              <StatusPill label="JSONL" value={info?.jsonlWatcherRunning ? 'WATCHING' : 'OFF'} tone={info?.jsonlWatcherRunning ? 'good' : 'muted'} />
              <StatusPill label="TOKEN" value={info?.hookTokenPreview || 'NONE'} tone={info?.hookTokenPreview ? 'good' : 'muted'} />
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Section title="LATEST">
              {latest ? <SessionCard session={latest} primary /> : <Text style={styles.empty}>No session observed yet.</Text>}
            </Section>

            <Section title={`SESSIONS (${sessions.length})`}>
              {sessions.length === 0 ? (
                <Text style={styles.empty}>Open Claude Code or Codex, or send a hook event.</Text>
              ) : (
                sessions.map((session) => <SessionCard key={session.sessionId || `${session.source}-${session.lastEventAt}`} session={session} />)
              )}
            </Section>

            <Section title="HOOKS">
              <Text style={styles.codeLine}>Claude: {info?.claudeHookUrl || 'disabled'}</Text>
              <Text style={styles.codeLine}>Codex:  {info?.codexHookUrl || 'disabled'}</Text>
              <Pressable style={styles.copyButton} onPress={copyHooks} accessibilityRole="button" accessibilityLabel="Copy Scouter hook templates">
                <MaterialIcons name="content-copy" size={14} color="#001200" />
                <Text style={styles.copyText}>COPY HOOKS</Text>
              </Pressable>
            </Section>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone: 'good' | 'bad' | 'muted' }) {
  return (
    <View style={[styles.pill, tone === 'bad' && styles.pillBad, tone === 'muted' && styles.pillMuted]}>
      <Text style={styles.pillLabel}>{label}</Text>
      <Text style={styles.pillValue}>{value}</Text>
    </View>
  );
}

function SessionCard({ session, primary = false }: { session: ScouterSession; primary?: boolean }) {
  const stale = isStale(session.lastEventAt);
  const source = sourceName(session.source);
  const project = projectName(session.projectName);
  const status = statusText(session);
  const note = session.lastError ? summarizeSessionNote(session.lastError, session.currentStatus === 'ERROR') : null;
  return (
    <View style={[styles.sessionCard, primary && styles.sessionCardPrimary, stale && styles.sessionCardStale]}>
      <View style={styles.sessionTop}>
        <View style={[styles.dot, { backgroundColor: dotColor(session.currentStatus, stale) }]} />
        <Text style={styles.sessionTitle} numberOfLines={1}>{source} · {project}</Text>
        <Text style={styles.badge}>{session.sourceBadge || source.slice(0, 2).toUpperCase()}</Text>
      </View>
      <Text style={styles.sessionStatus} numberOfLines={1}>{stale ? `Stale · ${status}` : status}</Text>
      <Text style={styles.sessionMeta} numberOfLines={1}>
        Last event {formatTime(session.lastEventAt)} · Session {formatDuration(session.sessionStartAt, session.lastEventAt)}
      </Text>
      <Text style={styles.sessionMeta} numberOfLines={1}>
        {metrics(session)}
      </Text>
      {note ? (
        <Text style={[styles.sessionNote, note.tone === 'error' && styles.sessionNoteError]} numberOfLines={1}>
          {note.text}
        </Text>
      ) : null}
    </View>
  );
}

function sourceName(source?: string): string {
  if (source === 'CLAUDE_CODE') return 'Claude Code';
  if (source === 'CODEX') return 'Codex';
  return 'Shelly';
}

function projectName(raw?: string): string {
  const value = (raw || '').trim();
  if (!value) return 'Shelly';
  const lower = value.toLowerCase();
  if (lower.includes('dev-shelly-terminal-files-home') || lower.includes('dev.shelly.terminal/files/home')) return 'home';
  if (value.includes('/') || value.includes('\\')) return value.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || 'Shelly';
  return value;
}

function statusText(session: ScouterSession): string {
  const project = projectName(session.projectName);
  const tool = session.currentTool;
  switch (session.currentStatus) {
    case 'TOOL_RUNNING': return tool ? `Running ${tool} in ${project}` : `Running tool in ${project}`;
    case 'THINKING': return `Thinking in ${project}`;
    case 'WAITING_PERMISSION': return `Waiting for permission in ${project}`;
    case 'COMPLETED': return `Completed in ${project}`;
    case 'ERROR': return `Error in ${project}`;
    case 'IDLE':
    default: return `Waiting in ${project}`;
  }
}

function metrics(session: ScouterSession): string {
  const parts: string[] = [];
  if ((session.tokensUsed || 0) > 0) parts.push(`${formatTokens(session.tokensUsed || 0)} tokens`);
  if ((session.totalCostUsd || 0) > 0) parts.push(`$${(session.totalCostUsd || 0).toFixed(2)}`);
  if (typeof session.contextPercentRemaining === 'number') parts.push(`${session.contextPercentRemaining.toFixed(0)}% context`);
  if (session.gitBranch) parts.push(session.gitBranch);
  return parts.length ? parts.join(' · ') : shortSessionId(session.sessionId);
}

function summarizeSessionNote(error: string, isErrorStatus: boolean): { text: string; tone: 'info' | 'error' } {
  const value = error.trim();
  if (!value) return { text: '', tone: 'info' };
  if (looksLikeJson(value)) {
    const parsed = tryParseJson(value);
    const text = findJsonText(parsed);
    if (text) return { text: `Payload: ${shorten(text, 90)}`, tone: isErrorStatus ? 'error' : 'info' };
    const message = findJsonString(parsed, ['message', 'error', 'stop_reason', 'type']);
    if (message) return { text: `Payload: ${shorten(message, 90)}`, tone: isErrorStatus ? 'error' : 'info' };
    return { text: 'Payload: JSON response', tone: isErrorStatus ? 'error' : 'info' };
  }
  return { text: `Error: ${shorten(value.replace(/\s+/g, ' '), 120)}`, tone: 'error' };
}

function looksLikeJson(value: string): boolean {
  return value.startsWith('{') || value.startsWith('[');
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function findJsonText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonText(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  for (const item of Object.values(record)) {
    const found = findJsonText(item);
    if (found) return found;
  }
  return null;
}

function findJsonString(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findJsonString(item, keys);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  for (const item of Object.values(record)) {
    const found = findJsonString(item, keys);
    if (found) return found;
  }
  return null;
}

function shorten(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

function shortSessionId(sessionId?: string): string {
  if (!sessionId) return 'No metrics yet';
  return sessionId.length > 18 ? `session ${sessionId.slice(0, 8)}` : sessionId;
}

function dotColor(status?: string, stale?: boolean): string {
  if (stale) return '#7A967A';
  if (status === 'ERROR') return '#FF5C5C';
  if (status === 'TOOL_RUNNING') return '#2FAF2F';
  if (status === 'THINKING') return '#7DDB7D';
  return '#9BC49B';
}

function isStale(time?: number): boolean {
  return !time || Date.now() - time > STALE_MS;
}

function formatTime(time?: number): string {
  if (!time) return 'never';
  return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDuration(start?: number, end?: number): string {
  if (!start || !end || end < start) return 'unknown';
  const minutes = Math.floor((end - start) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens);
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
    justifyContent: 'center',
    padding: 16,
  },
  panel: {
    maxHeight: '88%',
    borderWidth: 1,
    borderColor: '#2FAF2F',
    borderRadius: 10,
    backgroundColor: 'rgba(0, 8, 0, 0.94)',
    overflow: 'hidden',
  },
  header: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#244F24',
    paddingHorizontal: 14,
  },
  title: {
    color: '#F4FFF4',
    fontFamily: 'JetBrainsMono_700Bold',
    fontSize: 16,
    fontWeight: '800',
  },
  headerActions: {
    marginLeft: 'auto',
    flexDirection: 'row',
    gap: 8,
  },
  iconButton: {
    minWidth: 32,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    maxHeight: '100%',
  },
  content: {
    padding: 14,
    gap: 14,
  },
  statusGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  pill: {
    minWidth: 112,
    borderWidth: 1,
    borderColor: '#2FAF2F',
    backgroundColor: 'rgba(47, 175, 47, 0.16)',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  pillBad: {
    borderColor: '#FF5C5C',
    backgroundColor: 'rgba(255, 92, 92, 0.12)',
  },
  pillMuted: {
    borderColor: '#496849',
    backgroundColor: 'rgba(122, 150, 122, 0.10)',
  },
  pillLabel: {
    color: '#9BC49B',
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 10,
  },
  pillValue: {
    color: '#F4FFF4',
    fontFamily: 'JetBrainsMono_700Bold',
    fontSize: 13,
    marginTop: 2,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    color: '#7DDB7D',
    fontFamily: 'JetBrainsMono_700Bold',
    fontSize: 12,
    letterSpacing: 0,
  },
  empty: {
    color: '#9BC49B',
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 13,
  },
  error: {
    color: '#FF8A8A',
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 12,
  },
  sessionCard: {
    borderWidth: 1,
    borderColor: '#244F24',
    backgroundColor: 'rgba(0, 0, 0, 0.34)',
    padding: 10,
    gap: 6,
  },
  sessionCardPrimary: {
    borderColor: '#2FAF2F',
  },
  sessionCardStale: {
    opacity: 0.76,
  },
  sessionTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  sessionTitle: {
    flex: 1,
    color: '#F4FFF4',
    fontFamily: 'JetBrainsMono_700Bold',
    fontSize: 14,
  },
  badge: {
    color: '#001200',
    backgroundColor: '#2FAF2F',
    fontFamily: 'JetBrainsMono_700Bold',
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  sessionStatus: {
    color: '#7DDB7D',
    fontFamily: 'JetBrainsMono_700Bold',
    fontSize: 13,
  },
  sessionMeta: {
    color: '#9BC49B',
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 11,
  },
  sessionNote: {
    color: '#9BC49B',
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 11,
  },
  sessionNoteError: {
    color: '#FF8A8A',
  },
  codeLine: {
    color: '#9BC49B',
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 11,
  },
  copyButton: {
    marginTop: 4,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#2FAF2F',
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  copyText: {
    color: '#001200',
    fontFamily: 'JetBrainsMono_700Bold',
    fontSize: 12,
  },
});
