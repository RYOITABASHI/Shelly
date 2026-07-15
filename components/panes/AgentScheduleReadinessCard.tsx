/**
 * components/panes/AgentScheduleReadinessCard.tsx
 *
 * P1 scheduling-reliability audit (2026-07-15) follow-up. A one-time,
 * dismissible checklist appended after a device's FIRST scheduled
 * (non-one-shot) agent registration — see hooks/use-ai-pane-dispatch.ts's
 * confirmAgentDraft. Combines three previously scattered/missing readiness
 * signals into ONE surface instead of three separate interruptions:
 *
 *  1. Exact-alarm special access (SCHEDULE_EXACT_ALARM, Android 12+) — when
 *     missing, AgentAlarmScheduler.kt silently downgrades to an inexact
 *     alarm that can drift under Doze (P1-B).
 *  2. Battery-optimization exemption — reuses the existing
 *     isIgnoringBatteryOptimizations/requestBatteryOptimizationExemption
 *     native pair (already used reactively by TerminalPane.tsx after a
 *     detected SIGKILL); here it's surfaced proactively, with an
 *     explanation, at schedule-registration time (P1-C).
 *  3. Samsung's separate "Sleeping apps" / "Deep sleeping apps" / "Never
 *     sleeping apps" One UI classification — informational only. There is
 *     no reliable deep-link intent to this OEM-specific screen, so this is
 *     manual navigation guidance, not a programmatic check (P1-A).
 *
 * NEVER a registration gate: by the time this card is shown, the agent it
 * follows has already been created (confirmAgentDraft creates first, then
 * appends this card). Dismissing without granting anything still leaves a
 * working — if less reliable — schedule.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, AppState, Linking } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { getDeviceProfile } from '@/lib/process-guard';

interface Props {
  onDismiss: () => void;
}

export default function AgentScheduleReadinessCard({ onDismiss }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  // null = not yet checked (avoid flashing a wrong state before the first
  // native round-trip resolves).
  const [exactAlarmGranted, setExactAlarmGranted] = useState<boolean | null>(null);
  const [batteryExempt, setBatteryExempt] = useState<boolean | null>(null);

  const samsungProfile = useMemo(() => {
    const profile = getDeviceProfile();
    if (!profile.manufacturer.includes('samsung')) return null;
    // Reuse the existing battery-settings deep link already validated by
    // ProcessGuardModal — there's no reliable OEM-specific deep link to the
    // "Sleeping apps" screen itself, so this opens the closest stock screen
    // and the card body gives manual navigation instructions from there.
    return profile.fixSteps.find((s) => s.intentUri)?.intentUri;
  }, []);

  const refresh = useCallback(() => {
    TerminalEmulator.canScheduleExactAlarms()
      .then(setExactAlarmGranted)
      .catch(() => setExactAlarmGranted(true));
    TerminalEmulator.isIgnoringBatteryOptimizations()
      .then(setBatteryExempt)
      .catch(() => setBatteryExempt(true));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Grant flows are separate OS Settings activities with no in-app result
  // callback — re-check whenever the app regains foreground so a granted
  // permission flips the checklist to "ok" without requiring a manual retry.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  const openSamsungBatterySettings = useCallback(() => {
    if (!samsungProfile) return;
    Linking.openURL(`intent://#Intent;action=${samsungProfile};end`).catch(() => {
      Linking.openURL('android.settings.SETTINGS').catch(() => {});
    });
  }, [samsungProfile]);

  return (
    <View style={[styles.card, { backgroundColor: colors.surfaceHigh, borderColor: colors.accent }]}>
      <Text style={[styles.title, { color: colors.accent }]}>{t('schedulereadiness.title')}</Text>
      <Text style={[styles.intro, { color: colors.muted }]}>{t('schedulereadiness.intro')}</Text>

      <ReadinessItem
        colors={colors}
        ok={exactAlarmGranted}
        title={t('schedulereadiness.exact_alarm_title')}
        okText={t('schedulereadiness.exact_alarm_ok')}
        missingText={t('schedulereadiness.exact_alarm_missing')}
        actionLabel={t('schedulereadiness.exact_alarm_action')}
        onAction={() => void TerminalEmulator.requestScheduleExactAlarm()}
      />

      <ReadinessItem
        colors={colors}
        ok={batteryExempt}
        title={t('schedulereadiness.battery_title')}
        okText={t('schedulereadiness.battery_ok')}
        missingText={t('schedulereadiness.battery_missing')}
        actionLabel={t('schedulereadiness.battery_action')}
        onAction={() => void TerminalEmulator.requestBatteryOptimizationExemption()}
      />

      {samsungProfile && (
        <View style={styles.item}>
          <Text style={[styles.itemTitle, { color: colors.foreground }]}>
            {t('schedulereadiness.samsung_title')}
          </Text>
          <Text style={[styles.itemBody, { color: colors.muted }]}>{t('schedulereadiness.samsung_body')}</Text>
          <TouchableOpacity
            onPress={openSamsungBatterySettings}
            style={[styles.actionBtn, { borderColor: colors.border }]}
            activeOpacity={0.7}
          >
            <Text style={[styles.actionText, { color: colors.accent }]}>{t('schedulereadiness.samsung_action')}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={styles.actions}>
        <TouchableOpacity
          onPress={onDismiss}
          style={[styles.dismissBtn, { backgroundColor: colors.success, borderColor: colors.success }]}
          activeOpacity={0.7}
        >
          <Text style={[styles.dismissText, { color: colors.background }]}>{t('schedulereadiness.dismiss')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ReadinessItem({
  colors,
  ok,
  title,
  okText,
  missingText,
  actionLabel,
  onAction,
}: {
  colors: any;
  ok: boolean | null;
  title: string;
  okText: string;
  missingText: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <View style={styles.item}>
      <Text style={[styles.itemTitle, { color: colors.foreground }]}>
        {ok === null ? title : `${ok ? '✓' : '⚠'} ${title}`}
      </Text>
      {ok !== null && (
        <Text style={[styles.itemBody, { color: ok ? colors.muted : colors.warning }]}>
          {ok ? okText : missingText}
        </Text>
      )}
      {ok === false && (
        <TouchableOpacity
          onPress={onAction}
          style={[styles.actionBtn, { borderColor: colors.border }]}
          activeOpacity={0.7}
        >
          <Text style={[styles.actionText, { color: colors.accent }]}>{actionLabel}</Text>
        </TouchableOpacity>
      )}
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
  intro: { fontSize: 11, lineHeight: 15, marginBottom: 4 },
  item: { marginTop: 8 },
  itemTitle: { fontSize: 12, fontWeight: '600' },
  itemBody: { fontSize: 11, lineHeight: 15, marginTop: 2 },
  actionBtn: {
    alignSelf: 'flex-start',
    marginTop: 5,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  actionText: { fontSize: 11, fontWeight: '600' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 10 },
  dismissBtn: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 18, paddingVertical: 7 },
  dismissText: { fontSize: 13, fontWeight: '700' },
});
