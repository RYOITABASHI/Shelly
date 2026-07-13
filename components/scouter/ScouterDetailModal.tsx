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
  modelName?: string | null;
  totalCostUsd?: number;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  contextPercentRemaining?: number | null;
  lastError?: string | null;
  lastMessage?: string | null;
  localBackend?: string | null;
  localEndpoint?: string | null;
  tokensPerSecond?: number | null;
  queueSize?: number | null;
  latencyMs?: number | null;
};

type ScouterSystemLoad = {
  sampledAt?: number;
  cpuPercent?: number | null;
  appCpuPercent?: number | null;
  appPssMb?: number | null;
  appHeapUsedMb?: number;
  appHeapMaxMb?: number;
  ramAvailableMb?: number | null;
  ramTotalMb?: number | null;
};

type ScouterWidgetBinding = {
  codexSessionId?: string | null;
  ptySessionId?: string | null;
  shellySessionId?: string | null;
  cwd?: string | null;
  updatedAt?: number | null;
};

type ScouterWidgetConversation = {
  lastPrompt?: string | null;
  lastPromptAt?: number | null;
  widgetPrompt?: string | null;
  widgetPromptAt?: number | null;
  widgetStatus?: string | null;
  widgetStatusAt?: number | null;
  widgetError?: string | null;
  widgetAgentRunId?: string | null;
  widgetAgentRunName?: string | null;
  widgetAgentRunStatus?: 'running' | 'success' | 'error' | null;
  widgetAgentRunStatusAt?: number | null;
  widgetAgentRunError?: string | null;
  privacySuppressed?: boolean | null;
};

type ScouterCodexPetDebug = {
  visible?: boolean;
  selectedId?: string | null;
  selectedKey?: string | null;
  localRoot?: string | null;
  localRootExists?: boolean;
  localDirectoryCount?: number;
  localDirectories?: string[];
  petRoots?: Array<{
    path?: string;
    exists?: boolean;
    directoryCount?: number;
  }>;
  availablePetCount?: number;
  validPetCount?: number;
  availablePets?: Array<{
    id?: string;
    source?: string;
    valid?: boolean;
    selected?: boolean;
    spritesheetBytes?: number;
  }>;
};

type ScouterDebugInfo = {
  enabled?: boolean;
  port?: number;
  serverRunning?: boolean;
  jsonlWatcherRunning?: boolean;
  hookTokenPreview?: string;
  codexHookUrl?: string;
  localHookUrl?: string;
  localLlmEndpoints?: string;
  systemLoad?: ScouterSystemLoad;
  sessions?: ScouterSession[];
  widgetCodexBinding?: ScouterWidgetBinding | null;
  widgetConversation?: ScouterWidgetConversation | null;
  codexPet?: ScouterCodexPetDebug | null;
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

  const sessions = useMemo(() => dedupeSessions(info?.sessions ?? []), [info]);
  const latest = sessions[0];

  const copyHooks = useCallback(async () => {
    try {
      const codex = await TerminalEmulator.getScouterHookTemplate('codex');
      const local = await TerminalEmulator.getScouterHookTemplate('local');
      await Clipboard.setStringAsync(`Codex:\n${codex}\n\nLocal LLM:\n${local}`);
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
              <StatusPill label="LOCAL" value={localPillValue(sessions)} tone={localPillTone(sessions)} />
              <StatusPill label="LOAD" value={loadPillValue(info?.systemLoad)} tone={loadPillTone(info?.systemLoad)} />
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Section title="LATEST">
              {latest ? <SessionCard session={latest} primary /> : <Text style={styles.empty}>No session observed yet.</Text>}
            </Section>

            <Section title={`SESSIONS (${sessions.length})`}>
              {sessions.length === 0 ? (
                <Text style={styles.empty}>Open Codex, start a local LLM, or send a hook event.</Text>
              ) : (
                sessions.map((session) => <SessionCard key={sessionKey(session)} session={session} />)
              )}
            </Section>

            <Section title="WIDGET">
              <Text style={styles.codeLine}>{widgetBindingLine(info)}</Text>
              <Text style={styles.codeLine}>{widgetPromptLine(info?.widgetConversation)}</Text>
              <Text style={styles.codeLine}>{codexPetLine(info?.codexPet)}</Text>
              <Text style={styles.codeLine}>{codexPetDetailLine(info?.codexPet)}</Text>
            </Section>

            <Section title="SYSTEM">
              <Text style={styles.codeLine}>{systemLoadLine(info?.systemLoad)}</Text>
            </Section>

            <Section title="HOOKS">
              <Text style={styles.codeLine}>Codex: {info?.codexHookUrl || 'disabled'}</Text>
              <Text style={styles.codeLine}>Local hook: {info?.localHookUrl || 'disabled'}</Text>
              <Text style={styles.codeLine}>Local probe: {info?.localLlmEndpoints || '127.0.0.1:8080, 11434'}</Text>
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
  const lastMessage = session.lastMessage ? shorten(session.lastMessage, 110) : null;
  return (
    <View style={[styles.sessionCard, primary && styles.sessionCardPrimary, stale && styles.sessionCardStale]}>
      <View style={styles.sessionTop}>
        <View style={[styles.dot, { backgroundColor: dotColor(session.currentStatus, stale) }]} />
        <Text style={styles.sessionTitle} numberOfLines={1}>{sessionTitle(session, source, project)}</Text>
        <Text style={styles.badge}>{session.sourceBadge || source.slice(0, 2).toUpperCase()}</Text>
      </View>
      <Text style={styles.sessionStatus} numberOfLines={1}>{stale ? `Stale · ${status}` : status}</Text>
      <Text style={styles.sessionMeta} numberOfLines={1}>
        Last event {formatTime(session.lastEventAt)} · Session {formatDuration(session.sessionStartAt, session.lastEventAt)}
      </Text>
      <Text style={styles.sessionMeta} numberOfLines={1}>
        {metrics(session)}
      </Text>
      {usageDetails(session) ? (
        <Text style={styles.sessionMeta} numberOfLines={1}>
          {usageDetails(session)}
        </Text>
      ) : null}
      {lastMessage ? (
        <Text style={styles.sessionMessage} numberOfLines={1}>
          Last: {lastMessage}
        </Text>
      ) : null}
      {note ? (
        <Text style={[styles.sessionNote, note.tone === 'error' && styles.sessionNoteError]} numberOfLines={1}>
          {note.text}
        </Text>
      ) : null}
    </View>
  );
}

function dedupeSessions(sessions: ScouterSession[]): ScouterSession[] {
  const byKey = new Map<string, ScouterSession>();
  for (const session of sessions.filter((item) => item.source === 'CODEX' || item.source === 'LOCAL_LLM')) {
    const key = sessionKey(session);
    const previous = byKey.get(key);
    if (!previous || (session.lastEventAt || 0) >= (previous.lastEventAt || 0)) {
      byKey.set(key, session);
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
}

function sessionKey(session: ScouterSession): string {
  const id = session.sessionId?.trim();
  if (id) return `${session.source || 'SHELLY'}:${id}`;
  return `${session.source || 'SHELLY'}:${projectName(session.projectName)}:${session.sessionStartAt || 0}`;
}

function sourceName(source?: string): string {
  if (source === 'CODEX') return 'Codex';
  if (source === 'LOCAL_LLM') return 'Local LLM';
  return 'Shelly';
}

function sessionTitle(session: ScouterSession, source: string, project: string): string {
  if (session.source === 'LOCAL_LLM') return `MODEL  ${session.modelName || session.localBackend || project}`;
  if (session.source === 'CODEX') return `AGENT  ${source}@${project.toUpperCase()}`;
  return `${project} · ${source}`;
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
  if (session.source === 'LOCAL_LLM') {
    if (session.localBackend === 'offline') return 'HEALTH offline · no endpoint';
    if (session.currentStatus === 'TOOL_RUNNING') return `HEALTH busy · ${session.localBackend || session.modelName || 'local'}`;
    return `HEALTH ready · ${session.localBackend || session.modelName || 'local'}`;
  }
  switch (session.currentStatus) {
    case 'TOOL_RUNNING': return tool ? `STATE running ${tool} in ${project}` : `STATE running tool in ${project}`;
    case 'THINKING': return `STATE thinking in ${project}`;
    case 'WAITING_PERMISSION': return `STATE waiting for permission in ${project}`;
    case 'COMPLETED': return `STATE completed in ${project}`;
    case 'ERROR': return `STATE error in ${project}`;
    case 'IDLE':
    default: return `STATE waiting in ${project}`;
  }
}

function metrics(session: ScouterSession): string {
  const parts: string[] = [];
  if (session.source === 'LOCAL_LLM') {
    if (typeof session.tokensPerSecond === 'number' && session.tokensPerSecond > 0) {
      parts.push(`WAVE ${sparkline(session.tokensPerSecond, 80)}`);
    }
    const perf = localPerf(session);
    if (perf) parts.push(perf);
    if (session.localEndpoint) parts.push(`END ${session.localEndpoint}`);
    if (typeof session.queueSize === 'number') parts.push(`QUEUE ${session.queueSize}`);
    if (session.modelName) parts.push(shortModelName(session.modelName));
    return parts.length ? parts.join(' · ') : shortSessionId(session.sessionId);
  }
  parts.push(contextGauge(session));
  if (session.modelName) parts.push(`MODEL ${shortModelName(session.modelName)}`);
  if (session.currentTool) parts.push(`TOOL ${session.currentTool}`);
  if ((session.tokensUsed || 0) > 0) parts.push(`TOK ${formatTokens(session.tokensUsed || 0)}`);
  if ((session.totalCostUsd || 0) > 0) parts.push(`$${(session.totalCostUsd || 0).toFixed(2)}`);
  if (session.gitBranch) parts.push(session.gitBranch);
  return parts.filter(Boolean).length ? parts.filter(Boolean).join(' · ') : shortSessionId(session.sessionId);
}

function localPerf(session: ScouterSession): string | null {
  const parts: string[] = [];
  if (typeof session.tokensPerSecond === 'number' && session.tokensPerSecond > 0) {
    parts.push(`TPS ${session.tokensPerSecond.toFixed(1)}`);
  }
  if (typeof session.latencyMs === 'number') parts.push(`PING ${session.latencyMs}ms`);
  return parts.length ? `PERF ${parts.join(' / ')}` : null;
}

function usageDetails(session: ScouterSession): string | null {
  const parts: string[] = [];
  if ((session.inputTokens || 0) > 0 || (session.outputTokens || 0) > 0) {
    parts.push(`FLOW in ${formatTokens(session.inputTokens || 0)} / out ${formatTokens(session.outputTokens || 0)}`);
  }
  if ((session.reasoningOutputTokens || 0) > 0) parts.push(`REASON ${formatTokens(session.reasoningOutputTokens || 0)}`);
  const cacheTokens = (session.cacheCreationInputTokens || 0) + (session.cacheReadInputTokens || 0);
  if (cacheTokens > 0) parts.push(`CACHE ${formatTokens(cacheTokens)}`);
  return parts.length ? parts.join(' · ') : null;
}

function contextGauge(session: ScouterSession): string {
  if (typeof session.contextPercentRemaining === 'number') {
    const used = Math.max(0, Math.min(100, 100 - session.contextPercentRemaining));
    return `CTX ${bar(used)} ${Math.round(used)}%`;
  }
  return (session.tokensUsed || 0) > 0 ? `TOK ${formatTokens(session.tokensUsed || 0)}` : '';
}

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(10, Math.floor(percent / 10)));
  return `[${'#'.repeat(filled)}${'.'.repeat(10 - filled)}]`;
}

function sparkline(value: number, max: number): string {
  const levels = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const base = Math.max(0, Math.min(levels.length - 1, Math.floor((Math.min(value, max) / max) * (levels.length - 1))));
  return [-3, -1, 1, 3, 2, 0, -2, 0, 2, 3, 1, -1]
    .map((offset) => levels[Math.max(0, Math.min(levels.length - 1, base + offset))])
    .join('');
}

function localPillValue(sessions: ScouterSession[]): string {
  const local = sessions.find((session) => session.source === 'LOCAL_LLM');
  if (!local) return 'PROBING';
  if (local.localBackend === 'offline') return 'OFFLINE';
  if (local.currentStatus === 'TOOL_RUNNING') return 'BUSY';
  return 'READY';
}

function localPillTone(sessions: ScouterSession[]): 'good' | 'bad' | 'muted' {
  const local = sessions.find((session) => session.source === 'LOCAL_LLM');
  if (!local || local.localBackend === 'offline') return 'muted';
  return 'good';
}

function loadPillValue(load?: ScouterSystemLoad): string {
  if (typeof load?.cpuPercent === 'number') return `CPU ${Math.round(load.cpuPercent)}%`;
  return 'CPU --%';
}

function loadPillTone(load?: ScouterSystemLoad): 'good' | 'bad' | 'muted' {
  if (typeof load?.cpuPercent !== 'number') return 'muted';
  if (load.cpuPercent >= 85) return 'bad';
  if (load.cpuPercent >= 65) return 'muted';
  return 'good';
}

function systemLoadLine(load?: ScouterSystemLoad): string {
  if (!load) return 'CPU --% · APP --MB · RAM --';
  const cpu = typeof load.cpuPercent === 'number' ? `${Math.round(load.cpuPercent)}%` : '--%';
  const appCpu = typeof load.appCpuPercent === 'number' ? `${Math.max(0, Math.round(load.appCpuPercent))}%` : '--%';
  const app = typeof load.appPssMb === 'number' ? `${load.appPssMb}MB` : `${load.appHeapUsedMb || 0}/${load.appHeapMaxMb || 0}MB heap`;
  const ram = typeof load.ramAvailableMb === 'number'
    ? `${formatMegabytes(load.ramAvailableMb)} free${typeof load.ramTotalMb === 'number' ? ` / ${formatMegabytes(load.ramTotalMb)}` : ''}`
    : '--';
  return `CPU ${cpu} · APP CPU ${appCpu} · APP ${app} · RAM ${ram} · ${formatTime(load.sampledAt)}`;
}

function widgetBindingLine(info?: ScouterDebugInfo | null): string {
  const binding = info?.widgetCodexBinding;
  if (!binding?.ptySessionId) return 'BIND none';
  const codex = binding.codexSessionId ? shortSessionId(binding.codexSessionId) : 'codex --';
  return `BIND ${shortSessionId(binding.ptySessionId)} · ${codex} · ${projectName(binding.cwd || undefined)} · ${formatTime(binding.updatedAt || undefined)}`;
}

function widgetPromptLine(conversation?: ScouterWidgetConversation | null): string {
  const status = conversation?.widgetStatus || 'clear';
  if (conversation?.privacySuppressed) return `PROMPT ${status} · privacy suppressed`;
  const prompt = conversation?.widgetPrompt || conversation?.lastPrompt || '';
  if (!prompt.trim()) return `PROMPT ${status} · empty`;
  const at = conversation?.widgetPromptAt || conversation?.lastPromptAt;
  return `PROMPT ${status} · ${shorten(prompt, 82)} · ${formatTime(at || undefined)}`;
}

function codexPetLine(pet?: ScouterCodexPetDebug | null): string {
  if (!pet) return 'PET debug unavailable';
  const selected = pet.availablePets?.find((candidate) => candidate.selected);
  const selectedId = selected?.id || pet.selectedId || 'default';
  const valid = typeof pet.validPetCount === 'number' ? pet.validPetCount : 0;
  const total = typeof pet.availablePetCount === 'number' ? pet.availablePetCount : 0;
  return `PET ${pet.visible === false ? 'hidden' : 'visible'} · selected ${selectedId} · valid ${valid}/${total}`;
}

function codexPetDetailLine(pet?: ScouterCodexPetDebug | null): string {
  if (!pet) return 'PET root --';
  const directories = pet.localDirectories?.length ? pet.localDirectories.join(', ') : 'none';
  const root = pet.localRootExists ? 'root ok' : 'root missing';
  const roots = pet.petRoots ?? [];
  const existingRoots = roots.filter((candidate) => candidate.exists).length;
  return `PET ${root} · roots ${existingRoots}/${roots.length || 1} · dirs ${pet.localDirectoryCount ?? 0}: ${shorten(directories, 78)}`;
}

function shortModelName(model: string): string {
  return model
    .replace(/^gpt-/, '')
    .replace(/-20\d{6}$/, '')
    .slice(0, 24);
}

function summarizeSessionNote(error: string, isErrorStatus: boolean): { text: string; tone: 'info' | 'error' } {
  const value = error.trim();
  if (!value) return { text: '', tone: 'info' };
  if (looksLikeJson(value)) {
    const parsed = tryParseJson(value);
    const text = findJsonText(parsed);
    if (text) return { text: `Message: ${shorten(text, 90)}`, tone: isErrorStatus ? 'error' : 'info' };
    const errorMessage = findJsonString(parsed, ['error', 'errorMessage']);
    if (errorMessage) return { text: `Error: ${shorten(errorMessage, 90)}`, tone: 'error' };
    const stopReason = findJsonString(parsed, ['stop_reason', 'subtype', 'type']);
    if (stopReason && !isLowValuePayloadLabel(stopReason)) {
      return { text: `Result: ${shorten(stopReason, 90)}`, tone: isErrorStatus ? 'error' : 'info' };
    }
    return { text: isErrorStatus ? 'Error: JSON response' : 'Result: JSON response', tone: isErrorStatus ? 'error' : 'info' };
  }
  return { text: `Error: ${shorten(value.replace(/\s+/g, ' '), 120)}`, tone: 'error' };
}

function isLowValuePayloadLabel(value: string): boolean {
  return /^(ok|success|true|false|message|text|assistant|user)$/i.test(value.trim());
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

function formatMegabytes(value: number): string {
  return value >= 1024 ? `${(value / 1024).toFixed(1)}G` : `${Math.round(value)}M`;
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
  sessionMessage: {
    color: '#7DDB7D',
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
