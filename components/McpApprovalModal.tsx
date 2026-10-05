/**
 * components/McpApprovalModal.tsx
 *
 * Every run_command / write_file call from the MCP server's exec/write
 * tools (lib/mcp-server-bridge.ts, gated behind settings.mcpExecEnabled)
 * surfaces here before it executes — a remote MCP client is never trusted
 * to gate itself. Mounted once at the app root (app/_layout.tsx); reads
 * store/mcp-approval-store.ts and shows at most one request at a time.
 * Auto-denied by the caller's own timeout if this never gets a tap (e.g.
 * app backgrounded), so this component only needs to handle the visible case.
 */
import React, { memo } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, ScrollView } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import { fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';

export const McpApprovalModal = memo(function McpApprovalModal() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const current = useMcpApprovalStore((s) => s.current);
  const respond = useMcpApprovalStore((s) => s.respond);

  return (
    <Modal visible={current !== null} transparent animationType="fade" onRequestClose={() => current && respond(current.id, false)}>
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.error }]}>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <MaterialIcons name="warning" size={20} color={colors.error} />
            <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={2}>
              {t('mcp.approval_title')}
            </Text>
          </View>

          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            <Text style={[styles.summary, { color: colors.foreground }]} selectable>
              {current?.summary}
            </Text>
            {current?.riskLevel ? (
              <Text style={[styles.risk, { color: colors.error }]}>
                {t('mcp.approval_risk_label')}: {current.riskLevel}
              </Text>
            ) : null}
            <Text style={[styles.detail, { color: colors.muted }]} selectable>
              {current?.detail}
            </Text>
            <Text style={[styles.hint, { color: colors.muted }]}>
              {t('mcp.approval_hint')}
            </Text>
          </ScrollView>

          <View style={[styles.actions, { borderTopColor: colors.border }]}>
            <Pressable
              onPress={() => current && respond(current.id, false)}
              style={({ pressed }) => [
                styles.actionBtn,
                { borderColor: colors.border },
                pressed && { backgroundColor: withAlpha(colors.muted, 0.12) },
              ]}
            >
              <Text style={[styles.actionText, { color: colors.foreground }]}>{t('mcp.approval_deny')}</Text>
            </Pressable>
            <Pressable
              onPress={() => current && respond(current.id, true)}
              style={({ pressed }) => [
                styles.actionBtn,
                { borderColor: colors.border },
                pressed && { backgroundColor: withAlpha(colors.error, 0.12) },
              ]}
            >
              <Text style={[styles.actionText, { color: colors.error, fontWeight: '800' }]}>{t('mcp.approval_approve')}</Text>
            </Pressable>
          </View>
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
    maxWidth: 460,
    maxHeight: '80%',
    borderRadius: 12,
    borderWidth: 2,
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
    maxHeight: 380,
  },
  bodyContent: {
    padding: 14,
    gap: 10,
  },
  summary: {
    fontFamily: F.family,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 19,
  },
  risk: {
    fontFamily: F.family,
    fontSize: 11,
    fontWeight: '700',
  },
  detail: {
    fontFamily: F.family,
    fontSize: 11,
    lineHeight: 16,
  },
  hint: {
    fontFamily: F.family,
    fontSize: 10,
    fontStyle: 'italic',
  },
  actions: {
    flexDirection: 'row',
    borderTopWidth: 1,
  },
  actionBtn: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 14,
    alignItems: 'center',
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
  actionText: {
    fontFamily: F.family,
    fontSize: 13,
    fontWeight: '600',
  },
});
