/**
 * components/panes/AgentConfirmCard.tsx
 *
 * The confirmation / preview card for NL-self-registered agents (Phase 0 §2.1).
 *
 * Contract: an NL utterance is parsed by `parseAgentNL` into a ParsedAgentDraft and
 * shown here as a REVIEWABLE PREVIEW — never a live agent. First registration ALWAYS
 * requires one human Confirm. The card doubles as the edit UI (§2.1): name, schedule,
 * action, and route (Run-on pin) are all editable inline.
 *
 * HARD REQUIREMENT (§2.1): Confirm is disabled until a valid schedule (one of the 3
 * whitelisted cron shapes) is set. When the parser could not produce a confident
 * schedule, the card forces a manual selection — we never register an agent that will
 * never fire.
 *
 * This is presentational + local edit state only. The caller wires Confirm to
 * createAgent + installAgent, and Cancel to discard.
 */
import React, { useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import { AgentAction, AgentActionType, ToolChoice } from '@/store/types';

export interface ConfirmedAgentDraft {
  name: string;
  prompt: string;
  /** A valid whitelisted cron for a scheduled agent, or null = run ONCE now
   *  (the card executed immediately on Confirm — no separate @agent run). */
  schedule: string | null;
  tool: ToolChoice;
  action: AgentAction;
  runOn: 'auto' | 'on-device' | 'cloud';
  /** true = run via the B2 autonomous gate (driver/escalation), no per-step approval. */
  autonomous: boolean;
}

// 'once' = run immediately on Confirm (no schedule). The others register a schedule.
type Frequency = 'once' | 'daily' | 'weekly' | 'interval';
type RunOn = 'auto' | 'on-device' | 'cloud';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土']; // cron dow 0..6
const ACTION_TYPES: AgentActionType[] = ['draft', 'notify', 'webhook', 'cli'];
const RUN_ON: RunOn[] = ['auto', 'on-device', 'cloud'];

/** Parse an existing cron (when the draft was confident) back into selector state. */
function decodeCron(cron: string | null): {
  frequency: Frequency;
  hour: number;
  minute: number;
  weekday: number;
  interval: number;
} {
  const fallback = { frequency: 'daily' as Frequency, hour: 8, minute: 0, weekday: 1, interval: 15 };
  if (!cron) return fallback;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const [min, hour, , , dow] = parts;
  const everyMin = min.match(/^\*\/(\d+)$/);
  if (everyMin && hour === '*') {
    return { ...fallback, frequency: 'interval', interval: parseInt(everyMin[1], 10) };
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    if (/^\d+$/.test(dow)) {
      return { ...fallback, frequency: 'weekly', minute: +min, hour: +hour, weekday: +dow };
    }
    return { ...fallback, frequency: 'daily', minute: +min, hour: +hour };
  }
  return fallback;
}

/** Build a whitelisted cron from selector state, or null when the selection is invalid. */
function buildCron(f: Frequency, hour: number, minute: number, weekday: number, interval: number): string | null {
  if (f === 'once') return null; // one-shot: no schedule
  if (f === 'interval') {
    if (!Number.isInteger(interval) || interval < 1 || interval > 59) return null;
    return `*/${interval} * * * *`;
  }
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (f === 'weekly') {
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return null;
    return `${minute} ${hour} * * ${weekday}`;
  }
  return `${minute} ${hour} * * *`;
}

function clampInt(raw: string, min: number, max: number): number {
  const n = parseInt(raw.replace(/[^\d]/g, ''), 10);
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

interface Props {
  draft: ParsedAgentDraft;
  onConfirm: (final: ConfirmedAgentDraft) => void;
  onCancel: () => void;
}

export default function AgentConfirmCard({ draft, onConfirm, onCancel }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const decoded = useMemo(() => decodeCron(draft.schedule), [draft.schedule]);

  const [name, setName] = useState(draft.name);
  // No confident schedule parsed ⇒ default to a one-shot "run now" (the user can
  // still switch to Daily/Weekly/Every-N-min). A confident parse keeps its shape.
  const [frequency, setFrequency] = useState<Frequency>(
    draft.scheduleConfident ? decoded.frequency : 'once',
  );
  const [hour, setHour] = useState(draft.suggestedTime?.hour ?? decoded.hour);
  const [minute, setMinute] = useState(draft.suggestedTime?.minute ?? decoded.minute);
  const [weekday, setWeekday] = useState(decoded.weekday);
  const [interval, setInterval] = useState(decoded.interval);
  const [actionType, setActionType] = useState<AgentActionType>(draft.action.type);
  const [webhookUrl, setWebhookUrl] = useState(draft.action.webhookUrl ?? '');
  const [command, setCommand] = useState(draft.action.command ?? '');
  const [runOn, setRunOn] = useState<RunOn>('auto');
  const [autonomous, setAutonomous] = useState<boolean>(draft.autonomous ?? false);

  const isOnce = frequency === 'once';
  const cron = useMemo(
    () => buildCron(frequency, hour, minute, weekday, interval),
    [frequency, hour, minute, weekday, interval],
  );

  // Confirm gating: a one-shot needs no schedule; otherwise a valid cron is required.
  const webhookValid = actionType !== 'webhook' || /^https:\/\/\S+$/.test(webhookUrl.trim());
  const commandValid = actionType !== 'cli' || command.trim().length > 0;
  const canConfirm = (isOnce || !!cron) && name.trim().length > 0 && webhookValid && commandValid;

  const handleConfirm = () => {
    if (!canConfirm) return;
    const action: AgentAction = { type: actionType };
    if (actionType === 'webhook') action.webhookUrl = webhookUrl.trim();
    if (actionType === 'cli') action.command = command.trim();
    onConfirm({
      name: name.trim(),
      prompt: draft.prompt,
      schedule: isOnce ? null : cron,
      tool: draft.tool,
      action,
      runOn,
      autonomous,
    });
  };

  const fieldBg = { backgroundColor: colors.surface, borderColor: colors.border, color: colors.foreground };

  return (
    <View style={[styles.card, { backgroundColor: colors.surfaceHigh, borderColor: colors.accent }]}>
      {/* Header sentence: "I'll run <action> <schedule> using <route>." */}
      <Text style={[styles.title, { color: colors.accent }]}>{t('agentcard.title')}</Text>
      <Text style={[styles.summary, { color: colors.foreground }]}>
        {t('agentcard.summary', {
          action: t(`agentcard.action_${actionType}`),
          schedule: isOnce
            ? t('agentcard.sched_once')
            : cron
            ? scheduleHuman(frequency, hour, minute, weekday, interval, t)
            : t('agentcard.schedule_unset'),
          route: autonomous ? t('agentcard.autonomous') : t(`agentcard.runon_${runOn}`),
        })}
      </Text>

      {/* Name */}
      <Text style={[styles.label, { color: colors.muted }]}>{t('agentcard.name')}</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        style={[styles.input, fieldBg]}
        placeholder={t('agentcard.name')}
        placeholderTextColor={colors.inactive}
      />

      {/* Schedule */}
      <Text style={[styles.label, { color: colors.muted }]}>{t('agentcard.schedule')}</Text>
      <Segmented
        options={[
          { key: 'once', label: t('agentcard.freq_once') },
          { key: 'daily', label: t('agentcard.freq_daily') },
          { key: 'weekly', label: t('agentcard.freq_weekly') },
          { key: 'interval', label: t('agentcard.freq_interval') },
        ]}
        value={frequency}
        onChange={(k) => setFrequency(k as Frequency)}
        colors={colors}
      />
      {isOnce ? (
        <Text style={[styles.warn, { color: colors.muted }]}>{t('agentcard.once_hint')}</Text>
      ) : frequency === 'interval' ? (
        <View style={styles.row}>
          <TextInput
            value={String(interval)}
            onChangeText={(v) => setInterval(clampInt(v, 1, 59))}
            keyboardType="number-pad"
            style={[styles.inputSmall, fieldBg]}
          />
          <Text style={[styles.unit, { color: colors.foreground }]}>{t('agentcard.minutes_every')}</Text>
        </View>
      ) : (
        <>
          <View style={styles.row}>
            <TextInput
              value={String(hour).padStart(2, '0')}
              onChangeText={(v) => setHour(clampInt(v, 0, 23))}
              keyboardType="number-pad"
              style={[styles.inputSmall, fieldBg]}
            />
            <Text style={[styles.unit, { color: colors.foreground }]}>:</Text>
            <TextInput
              value={String(minute).padStart(2, '0')}
              onChangeText={(v) => setMinute(clampInt(v, 0, 59))}
              keyboardType="number-pad"
              style={[styles.inputSmall, fieldBg]}
            />
          </View>
          {frequency === 'weekly' && (
            <View style={styles.weekRow}>
              {WEEKDAY_LABELS.map((wl, d) => (
                <TouchableOpacity
                  key={d}
                  onPress={() => setWeekday(d)}
                  style={[
                    styles.weekDay,
                    { borderColor: colors.border },
                    weekday === d && { backgroundColor: colors.accent, borderColor: colors.accent },
                  ]}
                >
                  <Text style={{ color: weekday === d ? colors.background : colors.foreground, fontSize: 12 }}>{wl}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </>
      )}

      {/* Action */}
      <Text style={[styles.label, { color: colors.muted }]}>{t('agentcard.action')}</Text>
      <Segmented
        options={ACTION_TYPES.map((a) => ({ key: a, label: t(`agentcard.action_${a}`) }))}
        value={actionType}
        onChange={(k) => setActionType(k as AgentActionType)}
        colors={colors}
      />
      {actionType === 'webhook' && (
        <TextInput
          value={webhookUrl}
          onChangeText={setWebhookUrl}
          autoCapitalize="none"
          placeholder="https://"
          placeholderTextColor={colors.inactive}
          style={[styles.input, fieldBg, !webhookValid && { borderColor: colors.error }]}
        />
      )}
      {actionType === 'cli' && (
        <>
          <TextInput
            value={command}
            onChangeText={setCommand}
            autoCapitalize="none"
            placeholder={t('agentcard.command_placeholder')}
            placeholderTextColor={colors.inactive}
            style={[styles.input, fieldBg, !commandValid && { borderColor: colors.error }]}
          />
          <Text style={[styles.warn, { color: colors.warning }]}>{t('agentcard.cli_warning')}</Text>
        </>
      )}

      {/* Run on */}
      <Text style={[styles.label, { color: colors.muted }]}>{t('agentcard.runon')}</Text>
      <Segmented
        options={RUN_ON.map((r) => ({ key: r, label: t(`agentcard.runon_${r}`) }))}
        value={runOn}
        onChange={(k) => setRunOn(k as RunOn)}
        colors={colors}
      />

      {/* Autonomous — replaces the old `@agent autonomous` keyword (B2 gated execution). */}
      <View style={styles.autoRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.label, { color: colors.muted, marginTop: 0 }]}>{t('agentcard.autonomous')}</Text>
          <Text style={[styles.warn, { color: colors.muted }]}>{t('agentcard.autonomous_hint')}</Text>
        </View>
        <TouchableOpacity
          onPress={() => setAutonomous((v) => !v)}
          style={[
            styles.toggle,
            { borderColor: autonomous ? colors.accent : colors.border, backgroundColor: autonomous ? colors.accent : 'transparent' },
          ]}
          accessibilityRole="switch"
          accessibilityState={{ checked: autonomous }}
          activeOpacity={0.7}
        >
          <Text style={{ color: autonomous ? colors.background : colors.muted, fontSize: 11, fontWeight: '700' }}>
            {autonomous ? 'ON' : 'OFF'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Buttons */}
      <View style={styles.actions}>
        <TouchableOpacity onPress={onCancel} style={[styles.btn, { borderColor: colors.border }]} activeOpacity={0.7}>
          <Text style={[styles.btnText, { color: colors.muted }]}>{t('agentcard.cancel')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleConfirm}
          disabled={!canConfirm}
          style={[
            styles.btn,
            { backgroundColor: canConfirm ? colors.success : colors.surface, borderColor: canConfirm ? colors.success : colors.border },
          ]}
          activeOpacity={0.7}
        >
          <Text style={[styles.btnText, { color: canConfirm ? colors.background : colors.inactive, fontWeight: '700' }]}>
            {t(isOnce ? 'agentcard.run_now' : 'agentcard.confirm')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function scheduleHuman(
  f: Frequency,
  hour: number,
  minute: number,
  weekday: number,
  interval: number,
  t: (k: string, p?: Record<string, string | number>) => string,
): string {
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (f === 'interval') return t('agentcard.sched_interval', { n: interval });
  if (f === 'weekly') return t('agentcard.sched_weekly', { day: WEEKDAY_LABELS[weekday], time: hhmm });
  return t('agentcard.sched_daily', { time: hhmm });
}

// ─── Segmented control ──────────────────────────────────────────────────────
function Segmented({
  options,
  value,
  onChange,
  colors,
}: {
  options: Array<{ key: string; label: string }>;
  value: string;
  onChange: (key: string) => void;
  colors: any;
}) {
  return (
    <View style={[styles.segmented, { borderColor: colors.border }]}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <TouchableOpacity
            key={o.key}
            onPress={() => onChange(o.key)}
            style={[styles.segment, active && { backgroundColor: colors.accent }]}
            activeOpacity={0.7}
          >
            <Text style={{ color: active ? colors.background : colors.foreground, fontSize: 12 }}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginVertical: 6,
    gap: 4,
  },
  title: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
  summary: { fontSize: 13, lineHeight: 19, marginBottom: 6 },
  label: { fontSize: 10, letterSpacing: 0.5, marginTop: 8, textTransform: 'uppercase' },
  warn: { fontSize: 11, marginTop: 2 },
  input: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, fontSize: 13, marginTop: 4 },
  inputSmall: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6, fontSize: 14, minWidth: 44, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  unit: { fontSize: 14 },
  weekRow: { flexDirection: 'row', gap: 4, marginTop: 6 },
  weekDay: { width: 30, height: 30, borderRadius: 15, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  segmented: { flexDirection: 'row', borderWidth: 1, borderRadius: 8, overflow: 'hidden', marginTop: 4 },
  segment: { flex: 1, paddingVertical: 7, alignItems: 'center' },
  autoRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  toggle: { minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 14 },
  btn: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 18, paddingVertical: 8 },
  btnText: { fontSize: 13 },
});
