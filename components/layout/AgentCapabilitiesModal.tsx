/**
 * components/layout/AgentCapabilitiesModal.tsx
 *
 * "What can agents do?" discovery surface — opened from a help icon next to
 * the Sidebar's TASKS/AGENTS subheader (see Sidebar.tsx). Renders the
 * agent-category slice of lib/feature-catalog.ts (via
 * lib/agent-capability-catalog.ts's AGENT_CAPABILITIES) plus a small set of
 * copy-pasteable example `@agent …` utterances (AGENT_EXAMPLE_UTTERANCES),
 * each of which is proven to parse via the real deterministic parser in
 * __tests__/agent-capability-catalog.test.ts.
 *
 * Presentational only — no side effects beyond clipboard copy on an example.
 */
import React, { memo, useCallback, useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, ScrollView } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import { fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { AGENT_CAPABILITIES, AGENT_EXAMPLE_UTTERANCES } from '@/lib/agent-capability-catalog';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export const AgentCapabilitiesModal = memo(function AgentCapabilitiesModal({ visible, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = useCallback(async (id: string, text: string) => {
    await Clipboard.setStringAsync(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 2000);
  }, []);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <MaterialIcons name="smart-toy" size={20} color={colors.accent} />
            <Text style={[styles.title, { color: colors.foreground }]}>
              {t('agent_capabilities.title')}
            </Text>
            <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close')}>
              <MaterialIcons name="close" size={20} color={colors.muted} />
            </Pressable>
          </View>

          <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
            <Text style={[styles.intro, { color: colors.foregroundDim }]}>
              {t('agent_capabilities.intro')}
            </Text>

            <Text style={[styles.sectionHeading, { color: colors.muted }]}>
              {t('agent_capabilities.capabilities_heading')}
            </Text>
            {AGENT_CAPABILITIES.map((cap) => (
              <View key={cap.id} style={styles.capRow}>
                <View style={[styles.capDot, { backgroundColor: colors.accent }]} />
                <View style={styles.capText}>
                  <Text style={[styles.capName, { color: colors.foreground }]}>{cap.name}</Text>
                  <Text style={[styles.capDesc, { color: colors.foregroundDim }]}>{cap.description}</Text>
                </View>
              </View>
            ))}

            <Text style={[styles.sectionHeading, { color: colors.muted, marginTop: 16 }]}>
              {t('agent_capabilities.examples_heading')}
            </Text>
            {AGENT_EXAMPLE_UTTERANCES.map((ex) => (
              <View key={ex.id} style={[styles.exampleBox, { backgroundColor: colors.backgroundDeep, borderColor: colors.border }]}>
                <Text style={[styles.exampleText, { color: colors.foreground }]} selectable>
                  {ex.utterance}
                </Text>
                <Text style={[styles.exampleExplain, { color: colors.foregroundDim }]}>
                  {ex.explain}
                </Text>
                <Pressable
                  style={[styles.copyBtn, { backgroundColor: withAlpha(colors.accent, 0.15) }]}
                  onPress={() => void handleCopy(ex.id, ex.utterance)}
                  accessibilityRole="button"
                  accessibilityLabel={t('agent_capabilities.copy_a11y', { utterance: ex.utterance })}
                >
                  <MaterialIcons
                    name={copiedId === ex.id ? 'check' : 'content-copy'}
                    size={13}
                    color={colors.accent}
                  />
                  <Text style={[styles.copyText, { color: colors.accent }]}>
                    {copiedId === ex.id ? t('agent_capabilities.copied') : t('agent_capabilities.copy')}
                  </Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 440, maxHeight: '82%', borderRadius: 16, borderWidth: 1, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 16, borderBottomWidth: 1 },
  title: { flex: 1, fontFamily: F.family, fontSize: 15, fontWeight: '700' },
  content: { flexGrow: 0 },
  contentInner: { padding: 16, gap: 6 },
  intro: { fontFamily: F.family, fontSize: 12, lineHeight: 18, marginBottom: 4 },
  sectionHeading: {
    fontFamily: F.family,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginTop: 8,
    marginBottom: 4,
  },
  capRow: { flexDirection: 'row', gap: 8, paddingVertical: 5, alignItems: 'flex-start' },
  capDot: { width: 5, height: 5, borderRadius: 3, marginTop: 6 },
  capText: { flex: 1 },
  capName: { fontFamily: F.family, fontSize: 12, fontWeight: '700' },
  capDesc: { fontFamily: F.family, fontSize: 11, lineHeight: 16, marginTop: 1 },
  exampleBox: { borderRadius: 8, borderWidth: 1, padding: 10, marginTop: 8, gap: 4 },
  exampleText: { fontFamily: F.family, fontSize: 11, lineHeight: 16 },
  exampleExplain: { fontFamily: F.family, fontSize: 10, lineHeight: 14 },
  copyBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  copyText: { fontFamily: F.family, fontSize: 10, fontWeight: '700' },
});
