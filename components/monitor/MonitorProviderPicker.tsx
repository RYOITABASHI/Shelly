/**
 * components/monitor/MonitorProviderPicker.tsx — inline provider picker shown
 * above the camera in the MONITOR single view (live runs only). Pick a
 * provider, then 「続ける」 (the running step finishes as it is; the steps that
 * have not started and later runs use the new provider) or 「今のステップを
 * やり直す」 (only while the step runs). Inline in the pane, never a modal; the
 * pane posts a one-line chat note for what was done.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from '@/lib/i18n';
import { PROVIDER_PICKS, providerPickLabel, type ProviderPick } from '@/lib/agent-provider-overrides';
import { MON, MON_FONT_OSD } from '@/components/monitor/monitor-palette';

type Props = {
  channel: string;
  current: ProviderPick;
  /** The step is running: offer 「今のステップをやり直す」. */
  canRestart: boolean;
  busy?: boolean;
  onApply: (pick: ProviderPick, restart: boolean) => void;
  onClose: () => void;
};

function PickKey({ label, on, onPress, testID }: { label: string; on?: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!on }}
      testID={testID}
      style={({ pressed }) => [styles.key, (on || pressed) && styles.keyOn]}
    >
      <Text style={[styles.keyText, on && { color: MON.phosphor }]}>{label}</Text>
    </Pressable>
  );
}

export function MonitorProviderPicker({ channel, current, canRestart, busy, onApply, onClose }: Props) {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<ProviderPick>(current);
  const changed = choice !== current;
  return (
    <View style={styles.box} testID="monitor-provider-picker">
      <Text style={styles.title}>{t('monitor.provider.title', { channel })}</Text>
      <View style={styles.row}>
        {PROVIDER_PICKS.map((pick) => (
          <PickKey
            key={pick}
            label={providerPickLabel(pick)}
            on={choice === pick}
            onPress={() => setChoice(pick)}
            testID={`monitor-provider-${pick}`}
          />
        ))}
      </View>
      <View style={styles.row}>
        {changed && !busy && (
          <PickKey label={t('monitor.provider.keep')} onPress={() => onApply(choice, false)} testID="monitor-provider-keep" />
        )}
        {changed && !busy && canRestart && (
          <PickKey label={t('monitor.provider.restart')} onPress={() => onApply(choice, true)} testID="monitor-provider-restart" />
        )}
        <PickKey label={t('monitor.provider.close')} onPress={onClose} testID="monitor-provider-close" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: MON.panel,
    borderWidth: 1,
    borderColor: MON.bezelHi,
    borderRadius: 12,
    padding: 10,
    gap: 8,
    marginTop: 8,
  },
  title: { fontFamily: MON_FONT_OSD, fontSize: 14, color: MON.label },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  key: {
    backgroundColor: MON.keyTop,
    borderWidth: 1,
    borderColor: MON.keyEdge,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  keyOn: { backgroundColor: MON.keyTopOn },
  keyText: { fontFamily: MON_FONT_OSD, fontSize: 14, color: MON.osd },
});
