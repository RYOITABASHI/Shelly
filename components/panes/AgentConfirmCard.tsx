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
 * HARD REQUIREMENT (§2.1): Confirm is disabled until a valid schedule (one of the 4
 * whitelisted cron shapes) is set. When the parser could not produce a confident
 * schedule, the card forces a manual selection — we never register an agent that will
 * never fire.
 *
 * This is presentational + local edit state only. The caller wires Confirm to
 * createAgent + installAgent, and Cancel to discard.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import { AgentAction, AgentActionType, AgentMemoryConfig, ToolChoice } from '@/store/types';
import { useSettingsStore } from '@/store/settings-store';
import { resolveAutonomousFinalTool } from '@/lib/agent-tool-router';
import { detectRouteSignals } from '@/lib/agent-router-scoring';
import { decodeCron, buildCron, resolveInitialFrequency, type Frequency } from '@/lib/agent-card-cron';
import { parseNotificationTriggerPackages } from '@/lib/notification-trigger';
import { pairingConfidence, useDmPairingStore } from '@/store/dm-pairing-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

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
  /** Phase 1 memory intent parsed from the utterance ("remember that …"). */
  memory?: AgentMemoryConfig;
  /** Phase 2a: id of a reused skill recipe the user kept on in the card. */
  skillId?: string;
  /** Phase 4: ordered step instructions for a multi-step (orchestrated) agent. */
  orchestrationSteps?: string[];
  /** NOTIFY-001 Increment 2: notification-package allowlist that triggers this agent. */
  notificationTrigger?: { packageNames: string[] } | null;
}

// 'once' = run immediately on Confirm (no schedule). The others register a schedule.
type RunOn = 'auto' | 'on-device' | 'cloud';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土']; // cron dow 0..6
const ACTION_TYPES: AgentActionType[] = ['draft', 'notify', 'webhook', 'cli', 'dm-reply'];
const RUN_ON: RunOn[] = ['auto', 'on-device', 'cloud'];

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

  // Initial frequency. A confident parse keeps its shape. Otherwise, if the user
  // clearly stated a recurrence but no time (suggestedFrequency), honour it so the
  // card doesn't silently fall to a one-shot "run now" — a multi-day weekly hint
  // becomes 'custom'. Only a truly scheduleless utterance defaults to 'once'.
  const initialFrequency = resolveInitialFrequency(
    draft.scheduleConfident,
    decoded.frequency,
    draft.suggestedFrequency,
    draft.suggestedDowList,
  );
  // The time is a PLACEHOLDER when a recurrence was stated without one — surface a
  // "confirm the time" hint and never claim it was parsed.
  const timeIsPlaceholder = !draft.scheduleConfident && !!draft.suggestedFrequency && !draft.suggestedTime;
  const initialDow = draft.scheduleConfident ? decoded.dowList : draft.suggestedDowList || decoded.dowList;
  const initialWeekday = (() => {
    if (draft.scheduleConfident) return decoded.weekday;
    const first = parseInt((draft.suggestedDowList ?? '').split(',')[0], 10);
    return Number.isNaN(first) ? decoded.weekday : first;
  })();

  const [name, setName] = useState(draft.name);
  const [frequency, setFrequency] = useState<Frequency>(initialFrequency);
  const [hour, setHour] = useState(draft.suggestedTime?.hour ?? decoded.hour);
  const [minute, setMinute] = useState(draft.suggestedTime?.minute ?? decoded.minute);
  // 'daily-multi' extra times (hours only — the minute is always the single shared
  // value above, per contract: a daily-multi schedule can't have per-time minutes).
  // `hour` above is the anchor/base time; extraHours holds any additional times
  // added via the "+ Add another time" affordance. Seeded from a decoded multi-time
  // cron's hourList when the draft itself was a confident 'daily-multi' parse.
  const [extraHours, setExtraHours] = useState<number[]>(() =>
    initialFrequency === 'daily-multi'
      ? decoded.hourList
          .split(',')
          .map((h) => parseInt(h, 10))
          .filter((h) => h !== hour)
      : [],
  );
  // When the time is only a placeholder (recurrence stated without one), Confirm is
  // gated until the user actually touches the time — "force a manual time pick"
  // rather than letting an unreviewed 08:00 register in one tap.
  const [timeTouched, setTimeTouched] = useState(false);
  const [weekday, setWeekday] = useState(initialWeekday);
  // Multi-day ('custom') DOW list (e.g. "1,5" = Mon/Fri). Editable via the weekday
  // chips below: tapping a 2nd day promotes weekly→custom; dropping back to 1 day
  // demotes custom→weekly. Preserved verbatim so a Mon/Fri preset doesn't flatten.
  const [customDow, setCustomDow] = useState(initialDow);
  const [interval, setInterval] = useState(decoded.interval);
  const [actionType, setActionType] = useState<AgentActionType>(draft.action.type);
  const [webhookUrl, setWebhookUrl] = useState(draft.action.webhookUrl ?? '');
  const [command, setCommand] = useState(draft.action.command ?? '');
  const [dmPairingId, setDmPairingId] = useState(draft.action.dmPairingId ?? '');
  const [dmReplyText, setDmReplyText] = useState(draft.action.dmReplyText ?? '');
  const dmPairings = useDmPairingStore((state) => state.pairings.filter((pairing) => !pairing.revoked));
  const [runOn, setRunOn] = useState<RunOn>('auto');
  const [autonomous, setAutonomous] = useState<boolean>(draft.autonomous ?? false);
  // NOTIFY-001 Increment 2: free-text package allowlist. No NL-parse producer yet
  // (ParsedAgentDraft carries no notificationTrigger field), so this always starts empty.
  const [notificationPackagesRaw, setNotificationPackagesRaw] = useState('');
  // null = not yet loaded from the native bridge — avoid flashing a wrong hint.
  const [notificationTriggerEnabled, setNotificationTriggerEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    TerminalEmulator.getNotificationTriggerEnabled()
      .then(setNotificationTriggerEnabled)
      .catch(() => setNotificationTriggerEnabled(false));
  }, []);
  // N1: an autonomous run normally uses the gated Codex driver (no API keys). But
  // with explicit cloud consent, a WEB-MANDATORY task keeps its scored web backend
  // (Gemini/Perplexity) — generateRunScript honours the same exception and bakes a
  // Codex fallback for the unattended fire (P1). Mirror that here so the card stores
  // the web tool instead of overriding to Codex (which silently defeated the path).
  // The needsWeb gate is required: suggestTool defaults a general prompt to gemini-api,
  // so without it a NON-web autonomous task would store gemini-api and the runtime
  // would refuse it (api-key backend not allowed when needsWeb is false).
  const cloudConsent = useSettingsStore((s) => s.settings.autonomousCloudConsent ?? false);
  const needsWeb = useMemo(() => detectRouteSignals(draft.prompt).needsWeb, [draft.prompt]);
  // The tool this agent will actually be STORED with — same resolver the submit
  // handler and runtime use — so the preview never lies about the engine (web
  // with consent, on-device local, or the gated Codex driver).
  const autonomousTool = resolveAutonomousFinalTool(true, draft.tool, cloudConsent, needsWeb);
  const keepWebTool = autonomous && (autonomousTool.type === 'gemini-api' || autonomousTool.type === 'perplexity');
  const keepLocal = autonomous && autonomousTool.type === 'local';
  const webEngineLabel = autonomousTool.type === 'perplexity' ? 'Perplexity' : 'Gemini';
  // Phase 2a: gated skill reuse. A matching skill (if any) is shown and reused by
  // default; the user can opt out. Off when no skill matched the task.
  const [useSkill, setUseSkill] = useState<boolean>(!!draft.matchedSkill);

  const isOnce = frequency === 'once';
  // The full daily-multi time list (base `hour` + `extraHours`, deduped+sorted) —
  // used for the cron hourList arg, the summary text, and the add/remove/cap logic.
  const MAX_DAILY_TIMES = 4;
  const dailyMultiHours = useMemo(
    () => Array.from(new Set([hour, ...extraHours])).sort((a, b) => a - b),
    [hour, extraHours],
  );
  const hourListArg = frequency === 'daily-multi' ? dailyMultiHours.join(',') : '';
  const cron = useMemo(
    () => buildCron(frequency, hour, minute, weekday, interval, customDow, hourListArg),
    [frequency, hour, minute, weekday, interval, customDow, hourListArg],
  );

  // "+ Add another time" (daily-multi). Reuses the current shared `minute` — no
  // second minute picker. Picks the next unused hour as a starting default so the
  // new entry is immediately a valid, distinct time; the user can retype it.
  const addDailyTime = () => {
    if (dailyMultiHours.length >= MAX_DAILY_TIMES) return;
    let candidate = (dailyMultiHours[dailyMultiHours.length - 1] + 1) % 24;
    while (dailyMultiHours.includes(candidate)) candidate = (candidate + 1) % 24;
    setExtraHours((prev) => [...prev, candidate]);
    setFrequency('daily-multi');
    setTimeTouched(true);
  };
  const updateExtraHour = (index: number, raw: string) => {
    const next = clampInt(raw, 0, 23);
    setExtraHours((prev) => {
      // Reject a value that collides with the base hour or another extra
      // entry, rather than silently deduping down to <2 distinct hours —
      // that would leave frequency stuck at 'daily-multi' while buildCron
      // rejects the collapsed list, disabling Confirm with no visible reason.
      const collides = next === hour || prev.some((h, i) => i !== index && h === next);
      if (collides) return prev;
      return prev.map((h, i) => (i === index ? next : h));
    });
    setTimeTouched(true);
  };
  // Removing an extra time back down to just the base hour demotes 'daily-multi'
  // back to plain 'daily' and hides the chip row again — mirrors the weekday
  // chips' custom→weekly demotion on dropping to a single day.
  const removeExtraHour = (index: number) => {
    const next = extraHours.filter((_, i) => i !== index);
    setExtraHours(next);
    if (next.length === 0) setFrequency('daily');
  };

  // The weekday chips are shown for both 'weekly' (single) and 'custom' (multi).
  // selectedDays is the unified selection; toggling reconciles the frequency:
  // 1 day → 'weekly' (weekday), 2+ days → 'custom' (customDow csv). Empty is
  // disallowed so the agent always has at least one fire day.
  const selectedDays = useMemo(() => {
    if (frequency === 'custom') {
      return customDow
        .split(',')
        .map((d) => parseInt(d, 10))
        .filter((n) => n >= 0 && n <= 6);
    }
    return [weekday];
  }, [frequency, customDow, weekday]);

  const showWeekdays = frequency === 'weekly' || frequency === 'custom';

  const toggleDay = (d: number) => {
    const has = selectedDays.includes(d);
    const next = (has ? selectedDays.filter((x) => x !== d) : [...selectedDays, d])
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => a - b);
    if (next.length === 0) return; // never allow an empty day list
    if (next.length === 1) {
      setWeekday(next[0]);
      setFrequency('weekly');
    } else {
      setCustomDow(next.join(','));
      setFrequency('custom');
    }
  };

  // Confirm gating: a one-shot needs no schedule; otherwise a valid cron is required.
  // A placeholder time (recurrence stated without one) additionally requires the
  // user to touch the time first, so an unreviewed default never registers silently.
  const webhookValid = actionType !== 'webhook' || /^https:\/\/\S+$/.test(webhookUrl.trim());
  const commandValid = actionType !== 'cli' || command.trim().length > 0;
  const dmReplyValid = actionType !== 'dm-reply' || dmPairingId.length > 0;
  // The placeholder-time gate only applies to clock-time frequencies. If the user
  // switches a time-less daily/weekly candidate to 'once' or 'interval' (neither
  // uses an HH:MM), there's nothing to confirm — don't deadlock Confirm.
  const freqUsesClockTime =
    frequency === 'daily' || frequency === 'weekly' || frequency === 'custom' || frequency === 'daily-multi';
  const timeReady = !freqUsesClockTime || !timeIsPlaceholder || timeTouched;
  const canConfirm =
    (isOnce || !!cron) && timeReady && name.trim().length > 0 && webhookValid && commandValid && dmReplyValid;

  const handleConfirm = () => {
    if (!canConfirm) return;
    const action: AgentAction = { type: actionType };
    if (actionType === 'webhook') action.webhookUrl = webhookUrl.trim();
    if (actionType === 'cli') action.command = command.trim();
    if (actionType === 'dm-reply') {
      action.dmPairingId = dmPairingId;
      action.dmReplyText = dmReplyText.trim();
    }
    // Autonomous keeps the scored web tool when consent allows (P1 Gemini path);
    // otherwise the gated Codex driver. Non-autonomous keeps the scored tool.
    const finalTool = resolveAutonomousFinalTool(autonomous, draft.tool, cloudConsent, needsWeb);
    const { valid: notificationPackages } = parseNotificationTriggerPackages(notificationPackagesRaw);
    onConfirm({
      name: name.trim(),
      prompt: draft.prompt,
      schedule: isOnce ? null : cron,
      tool: finalTool,
      action,
      runOn: autonomous ? 'auto' : runOn,
      autonomous,
      // Phase 1 memory: carry the parsed "remember that …" intent through to
      // createAgent. No card control yet — the NL parse is the source of truth.
      memory: draft.memory,
      // Phase 2a: attach the reused skill only when the user kept it on.
      skillId: useSkill ? draft.matchedSkill?.id : undefined,
      // Phase 4: carry detected multi-step instructions through to createAgent.
      orchestrationSteps: draft.orchestrationSteps,
      // NOTIFY-001 Increment 2: carry the parsed package allowlist through to createAgent.
      notificationTrigger: notificationPackages.length > 0 ? { packageNames: notificationPackages } : null,
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
            ? scheduleHuman(frequency, hour, minute, weekday, interval, t, customDow, dailyMultiHours)
            : t('agentcard.schedule_unset'),
          route: autonomous
            ? keepWebTool
              ? t('agentcard.autonomous_route_web', { engine: webEngineLabel })
              : keepLocal
              ? t('agentcard.autonomous_route_local')
              : t('agentcard.autonomous_route')
            : t(`agentcard.runon_${runOn}`),
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
          { key: 'hourly', label: t('agentcard.freq_hourly') },
          // Multi-day presets (e.g. Mon/Fri) surface a read-through 'custom' chip
          // labelled with the weekdays so the schedule isn't silently flattened.
          ...(frequency === 'custom'
            ? [{ key: 'custom', label: customDow.split(',').map((d) => WEEKDAY_LABELS[+d] ?? d).join('・') }]
            : []),
          // Multi-time preset (e.g. 08・21) surfaces the same kind of read-through
          // chip as 'custom' above, so the segmented control still shows something
          // highlighted once "+ Add another time" has promoted daily→daily-multi.
          ...(frequency === 'daily-multi'
            ? [{ key: 'daily-multi', label: dailyMultiHours.map((h) => String(h).padStart(2, '0')).join('・') }]
            : []),
        ]}
        value={frequency}
        onChange={(k) => setFrequency(k as Frequency)}
        colors={colors}
      />
      {isOnce ? (
        <Text style={[styles.warn, { color: colors.muted }]}>
          {t(autonomous ? 'agentcard.once_autonomous_hint' : 'agentcard.once_hint')}
        </Text>
      ) : frequency === 'interval' || frequency === 'hourly' ? (
        <View style={styles.row}>
          <TextInput
            value={String(interval)}
            onChangeText={(v) => setInterval(clampInt(v, 1, frequency === 'hourly' ? 23 : 59))}
            keyboardType="number-pad"
            style={[styles.inputSmall, fieldBg]}
          />
          <Text style={[styles.unit, { color: colors.foreground }]}>
            {t(frequency === 'hourly' ? 'agentcard.interval_hours' : 'agentcard.minutes_every')}
          </Text>
        </View>
      ) : (
        <>
          <View style={styles.row}>
            <TextInput
              value={String(hour).padStart(2, '0')}
              onChangeText={(v) => {
                const next = clampInt(v, 0, 23);
                // Same collision guard as updateExtraHour — the base hour is
                // also part of the daily-multi list, so it must not be
                // allowed to collapse the distinct-hour count below 2 either.
                if (frequency === 'daily-multi' && extraHours.includes(next)) return;
                setHour(next);
                setTimeTouched(true);
              }}
              keyboardType="number-pad"
              style={[styles.inputSmall, fieldBg]}
            />
            <Text style={[styles.unit, { color: colors.foreground }]}>:</Text>
            <TextInput
              value={String(minute).padStart(2, '0')}
              onChangeText={(v) => {
                setMinute(clampInt(v, 0, 59));
                setTimeTouched(true);
              }}
              keyboardType="number-pad"
              style={[styles.inputSmall, fieldBg]}
            />
          </View>
          {timeIsPlaceholder && (
            <Text style={[styles.warn, { color: colors.warning }]}>{t('agentcard.time_placeholder_hint')}</Text>
          )}
          {(frequency === 'daily' || frequency === 'daily-multi') && (
            <>
              <TouchableOpacity
                onPress={addDailyTime}
                disabled={dailyMultiHours.length >= MAX_DAILY_TIMES}
                style={styles.addTimeBtn}
                activeOpacity={0.7}
              >
                <Text
                  style={{
                    color: dailyMultiHours.length >= MAX_DAILY_TIMES ? colors.inactive : colors.accent,
                    fontSize: 12,
                  }}
                >
                  {t('agentcard.add_time')}
                </Text>
              </TouchableOpacity>
              {frequency === 'daily-multi' && (
                <>
                  <View style={styles.weekRow}>
                    {extraHours.map((h, i) => {
                      const hhmm = `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
                      return (
                        <View key={i} style={[styles.timeChip, { borderColor: colors.border }]}>
                          <TextInput
                            value={String(h).padStart(2, '0')}
                            onChangeText={(v) => updateExtraHour(i, v)}
                            keyboardType="number-pad"
                            style={[styles.timeChipInput, { color: colors.foreground }]}
                          />
                          <Text style={{ color: colors.foreground, fontSize: 12 }}>{`:${String(minute).padStart(2, '0')}`}</Text>
                          <TouchableOpacity
                            onPress={() => removeExtraHour(i)}
                            accessibilityLabel={t('agentcard.remove_time', { time: hhmm })}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          >
                            <Text style={{ color: colors.muted, fontSize: 12, marginLeft: 2 }}>✕</Text>
                          </TouchableOpacity>
                        </View>
                      );
                    })}
                  </View>
                  <Text style={[styles.warn, { color: colors.muted }]}>{t('agentcard.daily_multi_hint')}</Text>
                </>
              )}
            </>
          )}
          {showWeekdays && (
            <>
              <View style={styles.weekRow}>
                {WEEKDAY_LABELS.map((wl, d) => {
                  const on = selectedDays.includes(d);
                  return (
                    <TouchableOpacity
                      key={d}
                      onPress={() => toggleDay(d)}
                      style={[
                        styles.weekDay,
                        { borderColor: colors.border },
                        on && { backgroundColor: colors.accent, borderColor: colors.accent },
                      ]}
                    >
                      <Text style={{ color: on ? colors.background : colors.foreground, fontSize: 12 }}>{wl}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={[styles.warn, { color: colors.muted }]}>{t('agentcard.weekday_multi_hint')}</Text>
            </>
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
      {actionType === 'dm-reply' && (
        <>
          <Text style={[styles.label, { color: colors.muted }]}>{t('agentcard.dmreply_pairing_label')}</Text>
          {dmPairings.length === 0 ? (
            <Text style={[styles.warn, { color: colors.warning }]}>{t('agentcard.dmreply_no_pairings')}</Text>
          ) : (
            <View style={styles.dmPairingList}>
              {dmPairings.map((pairing) => {
                const selected = pairing.id === dmPairingId;
                return (
                  <TouchableOpacity
                    key={pairing.id}
                    onPress={() => setDmPairingId(pairing.id)}
                    style={[styles.dmPairingRow, {
                      borderColor: selected ? colors.accent : colors.border,
                      backgroundColor: selected ? `${colors.accent}15` : 'transparent',
                    }]}
                  >
                    <Text style={{ color: selected ? colors.accent : colors.foreground, fontSize: 12, flex: 1 }} numberOfLines={1}>
                      {pairing.label}
                    </Text>
                    {pairingConfidence(pairing) === 'weak' && (
                      <Text style={[styles.dmWeakBadge, { color: colors.warning, borderColor: colors.warning }]}>
                        {t('agentcard.dmreply_weak_confidence_hint')}
                      </Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          <Text style={[styles.label, { color: colors.muted }]}>{t('agentcard.dmreply_text_label')}</Text>
          <TextInput
            value={dmReplyText}
            onChangeText={setDmReplyText}
            multiline
            placeholder={t('agentcard.dmreply_text_label')}
            placeholderTextColor={colors.inactive}
            style={[styles.input, fieldBg]}
          />
          <Text style={[styles.warn, { color: colors.muted }]}>{t('agentcard.dmreply_text_hint')}</Text>
        </>
      )}

      {/* Notification trigger (NOTIFY-001 Increment 2) */}
      <Text style={[styles.label, { color: colors.muted }]}>{t('agentcard.notification_trigger_label')}</Text>
      <TextInput
        value={notificationPackagesRaw}
        onChangeText={setNotificationPackagesRaw}
        autoCapitalize="none"
        multiline
        placeholder={t('agentcard.notification_trigger_placeholder')}
        placeholderTextColor={colors.inactive}
        style={[styles.input, fieldBg]}
      />
      {(() => {
        const { valid, skippedCount } = parseNotificationTriggerPackages(notificationPackagesRaw);
        if (valid.length === 0 && skippedCount === 0) return null;
        return (
          <Text style={[styles.warn, { color: colors.muted }]}>
            {t('agentcard.notification_trigger_hint_count', { valid: valid.length, skipped: skippedCount })}
          </Text>
        );
      })()}
      {notificationTriggerEnabled === false && (
        <Text style={[styles.warn, { color: colors.warning }]}>
          {t('agentcard.notification_trigger_hint_disabled')}
        </Text>
      )}

      {/* Run on */}
      {autonomous ? (
        <>
          <Text style={[styles.label, { color: colors.muted }]}>{t('agentcard.runon')}</Text>
          <Text style={[styles.warn, { color: colors.muted }]}>
            {keepWebTool
              ? t('agentcard.autonomous_route_hint_web', { engine: webEngineLabel })
              : keepLocal
              ? t('agentcard.autonomous_route_hint_local')
              : t('agentcard.autonomous_route_hint')}
          </Text>
        </>
      ) : (
        <>
          <Text style={[styles.label, { color: colors.muted }]}>{t('agentcard.runon')}</Text>
          <Segmented
            options={RUN_ON.map((r) => ({ key: r, label: t(`agentcard.runon_${r}`) }))}
            value={runOn}
            onChange={(k) => setRunOn(k as RunOn)}
            colors={colors}
          />
        </>
      )}

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

      {/* Phase 2a: gated skill reuse — only shown when a skill matched the task. */}
      {draft.matchedSkill && (
        <View style={styles.autoRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.label, { color: colors.muted, marginTop: 0 }]}>
              {t('agentcard.use_skill', { name: draft.matchedSkill.name, count: draft.matchedSkill.successCount })}
            </Text>
            <Text style={[styles.warn, { color: colors.muted }]}>{t('agentcard.use_skill_hint')}</Text>
          </View>
          <TouchableOpacity
            onPress={() => setUseSkill((v) => !v)}
            style={[
              styles.toggle,
              { borderColor: useSkill ? colors.accent : colors.border, backgroundColor: useSkill ? colors.accent : 'transparent' },
            ]}
            accessibilityRole="switch"
            accessibilityState={{ checked: useSkill }}
            activeOpacity={0.7}
          >
            <Text style={{ color: useSkill ? colors.background : colors.muted, fontSize: 11, fontWeight: '700' }}>
              {useSkill ? 'ON' : 'OFF'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Phase 4: when the utterance was multi-step, show the planned chain. */}
      {draft.orchestrationSteps && draft.orchestrationSteps.length >= 2 && (
        <View style={{ marginTop: 4 }}>
          <Text style={[styles.label, { color: colors.muted, marginTop: 0 }]}>
            {t('agentcard.orchestration', { count: draft.orchestrationSteps.length })}
          </Text>
          {draft.orchestrationSteps.map((s, i) => (
            <Text key={`step-${i}`} style={[styles.warn, { color: colors.muted }]} numberOfLines={2}>
              {`${i + 1}. ${s}`}
            </Text>
          ))}
        </View>
      )}

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
  customDow = '',
  dailyMultiHours: number[] = [],
): string {
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (f === 'interval') return t('agentcard.sched_interval', { n: interval });
  if (f === 'hourly') return t('agentcard.sched_hourly', { n: interval });
  if (f === 'daily-multi') {
    const hours = dailyMultiHours.length > 0 ? dailyMultiHours : [hour];
    const times = hours.map((h) => `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`).join('・');
    return t('agentcard.sched_daily_multi', { times });
  }
  if (f === 'custom') {
    const days = customDow.split(',').map((d) => WEEKDAY_LABELS[+d] ?? d).join('・');
    return t('agentcard.sched_weekly', { day: days, time: hhmm });
  }
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
  options: { key: string; label: string }[];
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
    padding: 10,
    marginVertical: 5,
    gap: 2,
  },
  title: { fontSize: 13, fontWeight: '700', marginBottom: 1 },
  summary: { fontSize: 12, lineHeight: 16, marginBottom: 4 },
  label: { fontSize: 10, letterSpacing: 0.5, marginTop: 6, textTransform: 'uppercase' },
  warn: { fontSize: 10, lineHeight: 14, marginTop: 1 },
  input: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 5, fontSize: 13, marginTop: 3 },
  inputSmall: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 5, fontSize: 14, minWidth: 44, textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  unit: { fontSize: 14 },
  weekRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 5 },
  weekDay: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  addTimeBtn: { marginTop: 5, alignSelf: 'flex-start' },
  timeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 6,
    paddingVertical: 3,
    gap: 2,
  },
  timeChipInput: { fontSize: 12, minWidth: 18, padding: 0, textAlign: 'right' },
  segmented: { flexDirection: 'row', borderWidth: 1, borderRadius: 8, overflow: 'hidden', marginTop: 3 },
  segment: { flex: 1, paddingVertical: 6, alignItems: 'center' },
  dmPairingList: { marginTop: 3, gap: 4 },
  dmPairingRow: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 7, gap: 6 },
  dmWeakBadge: { fontSize: 9, borderWidth: 1, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  autoRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 7 },
  toggle: { minWidth: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 10 },
  btn: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 18, paddingVertical: 7 },
  btnText: { fontSize: 13 },
});
