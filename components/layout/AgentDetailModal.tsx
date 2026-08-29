/**
 * components/layout/AgentDetailModal.tsx
 *
 * Agent contract view (Fable5 + Codex, 2026-08-29 Hermes Agent parity
 * audit): the previous agent-detail surface was an Alert.alert built from
 * Sidebar.tsx's showAgentDetail — plain-text sections joined with newlines,
 * and a button list that Android's native AlertDialog silently truncates to
 * 3 (see that function's own long comment trail on the subject, most
 * recently 2026-07-23). Both reviewers independently flagged the same gap:
 * an agent's trigger, authority, approval mode, outputs, and last-failure
 * reason should be readable as ONE screen, not scattered across a
 * plain-text Alert body plus separate Run/Pause/Edit/Memory/Runs entry
 * points fighting for three button slots.
 *
 * This is presentational only. showAgentDetail (Sidebar.tsx) still does ALL
 * the data collection (run history, memory notes, route decision, missed-run
 * detection, exact-alarm health) exactly as before — only the display target
 * changed, from Alert.alert to this scrollable modal, and the button list is
 * no longer capped at 3.
 */
import React, { memo } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, ScrollView } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import { fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';

export interface AgentDetailSection {
  /** Unique key for the list — not displayed. */
  key: string;
  /** i18n label shown above the section body, e.g. "Trigger", "Reliability". */
  titleKey: string;
  /** Already-formatted, multi-line text (same content showAgentDetail always
   *  built — this component does no additional formatting/translation). */
  text: string;
}

export interface AgentDetailButton {
  key: string;
  labelKey: string;
  onPress: () => void;
  /** Renders in the destructive (error-tinted) style — used for nothing
   *  today (delete lives on the row itself, not this popup) but kept for
   *  parity with the Alert.alert button shape callers already build. */
  destructive?: boolean;
}

export interface AgentDetailData {
  agentName: string;
  sections: AgentDetailSection[];
  buttons: AgentDetailButton[];
}

type Props = {
  data: AgentDetailData | null;
  onClose: () => void;
};

export const AgentDetailModal = memo(function AgentDetailModal({ data, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Modal visible={data !== null} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <MaterialIcons name="smart-toy" size={20} color={colors.accent} />
            <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
              {data?.agentName ?? ''}
            </Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <MaterialIcons name="close" size={20} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            {data?.sections.filter((s) => s.text.trim().length > 0).map((section) => (
              <View key={section.key} style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.accent }]}>
                  {t(section.titleKey)}
                </Text>
                <Text style={[styles.sectionText, { color: colors.foreground }]} selectable>
                  {section.text}
                </Text>
              </View>
            ))}
          </ScrollView>

          {data?.buttons.length ? (
            <View style={[styles.actions, { borderTopColor: colors.border }]}>
              {data.buttons.map((btn) => (
                <Pressable
                  key={btn.key}
                  onPress={() => {
                    onClose();
                    btn.onPress();
                  }}
                  style={({ pressed }) => [
                    styles.actionBtn,
                    { borderColor: colors.border },
                    pressed && { backgroundColor: withAlpha(colors.accent, 0.12) },
                  ]}
                >
                  <Text
                    style={[
                      styles.actionText,
                      { color: btn.destructive ? colors.error : colors.foreground },
                    ]}
                    numberOfLines={1}
                  >
                    {t(btn.labelKey)}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  card: {
    width: '100%',
    maxWidth: 440,
    maxHeight: '80%',
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  title: {
    flex: 1,
    fontFamily: F.family,
    fontSize: 14,
    fontWeight: '700',
  },
  body: {
    maxHeight: 420,
  },
  bodyContent: {
    padding: 14,
    gap: 14,
  },
  section: {
    gap: 4,
  },
  sectionTitle: {
    fontFamily: F.family,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  sectionText: {
    fontFamily: F.family,
    fontSize: 12,
    lineHeight: 18,
  },
  actions: {
    borderTopWidth: 1,
  },
  actionBtn: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionText: {
    fontFamily: F.family,
    fontSize: 13,
    fontWeight: '600',
  },
});
