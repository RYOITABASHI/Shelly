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
 *
 * Launcher ingress Phase 2 (kind 'submit_instruction', D8): the same modal
 * and the same three decisions show a pending launcher submission — the
 * owner's own text, when it was sent and the time left — with the labels
 * allow / always allow / don't allow. Closing it (back, or the close link)
 * decides nothing: the store's `dismiss`, never 'deny'.
 */
import React, { memo, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, ScrollView } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import { fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { useMcpApprovalStore } from '@/store/mcp-approval-store';
import { useLauncherInboxStore } from '@/store/launcher-inbox-store';
import { formatRemaining, remainingMs } from '@/lib/launcher-approval';

export const McpApprovalModal = memo(function McpApprovalModal() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const current = useMcpApprovalStore((s) => s.current);
  const respond = useMcpApprovalStore((s) => s.respond);
  const dismiss = useMcpApprovalStore((s) => s.dismiss);
  const openInbox = useLauncherInboxStore((s) => s.open);
  const launcher = current?.kind === 'submit_instruction' ? current.launcher : undefined;
  const [now, setNow] = useState(() => Date.now());

  // The launcher prompt's countdown.
  useEffect(() => {
    if (!launcher) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [launcher]);

  if (launcher && current) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={() => dismiss(current.id)}>
        <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.85)' }]}>
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.accent }]}>
            <View style={[styles.header, { borderBottomColor: colors.border }]}>
              <MaterialIcons name="rocket-launch" size={20} color={colors.accent} />
              <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={2}>
                {t('launcher_approval.title')}
              </Text>
              <Pressable onPress={() => dismiss(current.id)} hitSlop={8} accessibilityRole="button">
                <Text style={[styles.link, { color: colors.muted }]}>{t('launcher_approval.close')}</Text>
              </Pressable>
            </View>

            <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
              <Text style={[styles.detail, { color: colors.muted }]}>
                {t('launcher_approval.sent_at', { time: new Date(launcher.sentAt).toLocaleString() })}
                {'\n'}
                {t('launcher_approval.remaining', { time: formatRemaining(remainingMs(launcher.expiresAt, now)) })}
              </Text>
              {/* The owner's own text: shown on the device only, never logged or audited. */}
              <Text style={[styles.summary, { color: colors.foreground }]} selectable>
                {current.detail}
              </Text>
              {launcher.untrusted ? (
                <Text style={[styles.risk, { color: colors.muted }]}>{t('launcher_approval.untrusted_note')}</Text>
              ) : null}
              <Text style={[styles.risk, { color: colors.foreground }]}>{t('launcher_approval.always_scope')}</Text>
              <Pressable
                onPress={() => {
                  dismiss(current.id);
                  openInbox();
                }}
                accessibilityRole="button"
              >
                <Text style={[styles.link, { color: colors.accent }]}>{t('launcher_approval.open_inbox')}</Text>
              </Pressable>
            </ScrollView>

            <View style={[styles.actions, { borderTopColor: colors.border }]}>
              <Pressable
                onPress={() => respond(current.id, 'deny')}
                android_ripple={{ color: withAlpha(colors.muted, 0.24) }}
                style={[styles.actionBtn, { borderColor: colors.border }]}
              >
                <Text style={[styles.actionText, { color: colors.foreground }]}>{t('launcher_approval.deny')}</Text>
              </Pressable>
              <Pressable
                onPress={() => respond(current.id, 'always')}
                android_ripple={{ color: withAlpha(colors.accent, 0.24) }}
                style={[styles.actionBtn, { borderColor: colors.border }]}
              >
                <Text style={[styles.actionText, { color: colors.foreground }]}>{t('launcher_approval.always')}</Text>
              </Pressable>
              <Pressable
                onPress={() => respond(current.id, 'once')}
                android_ripple={{ color: withAlpha(colors.accent, 0.24) }}
                style={[styles.actionBtn, { borderColor: colors.border }]}
              >
                <Text style={[styles.actionText, { color: colors.accent, fontWeight: '800' }]}>{t('launcher_approval.allow')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={current !== null} transparent animationType="fade" onRequestClose={() => current && respond(current.id, 'deny')}>
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
            {/* MCP ingress (Inc 2): always external; the name is the client's own claim. */}
            <Text style={[styles.risk, { color: colors.error }]}>{t('mcp.approval_origin')}</Text>
            {current?.origin ? (
              <Text style={[styles.detail, { color: colors.muted }]} selectable>
                {t('mcp.approval_principal', { principal: current.origin.principal })}
                {'\n'}
                {current.origin.clientNameSelfReported
                  ? t('mcp.approval_client_name', { name: current.origin.clientNameSelfReported })
                  : t('mcp.approval_client_name_none')}
              </Text>
            ) : null}
            {current?.riskLevel ? (
              <Text style={[styles.risk, { color: colors.error }]}>
                {t('mcp.approval_risk_label')}: {current.riskLevel}
              </Text>
            ) : null}
            <Text style={[styles.detail, { color: colors.muted }]} selectable>
              {current?.detail}
            </Text>
            {current?.alwaysAllowable ? (
              <Text style={[styles.risk, { color: colors.foreground }]} selectable>
                {t('mcp.approval_always_scope', {
                  op: current.alwaysAllowable.op,
                  target: current.alwaysAllowable.targetLabel,
                })}
              </Text>
            ) : null}
            <Text style={[styles.hint, { color: colors.muted }]}>
              {t('mcp.approval_hint')}
            </Text>
          </ScrollView>

          <View style={[styles.actions, { borderTopColor: colors.border }]}>
            <Pressable
              onPress={() => current && respond(current.id, 'deny')}
              // Static style: a style function was dropped here (the buttons rendered as
              // bare text crammed together on device), so pressed feedback is a ripple.
              android_ripple={{ color: withAlpha(colors.muted, 0.24) }}
              style={[styles.actionBtn, { borderColor: colors.border }]}
            >
              <Text style={[styles.actionText, { color: colors.foreground }]}>{t('mcp.approval_deny')}</Text>
            </Pressable>
            {current?.alwaysAllowable ? (
              <Pressable
                onPress={() => current && respond(current.id, 'always')}
                android_ripple={{ color: withAlpha(colors.error, 0.24) }}
                style={[styles.actionBtn, { borderColor: colors.border }]}
              >
                <Text style={[styles.actionText, { color: colors.foreground }]}>{t('mcp.approval_always')}</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => current && respond(current.id, 'once')}
              android_ripple={{ color: withAlpha(colors.error, 0.24) }}
              style={[styles.actionBtn, { borderColor: colors.border }]}
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
    // Shrink before the buttons do: in a short window (landscape, split
    // screen) the card hits its maxHeight and the action row was squeezed
    // to nothing, leaving the two labels crammed together.
    flexShrink: 1,
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
  link: {
    fontFamily: F.family,
    fontSize: 12,
    fontWeight: '600',
  },
  actions: {
    flexDirection: 'row',
    borderTopWidth: 1,
    flexShrink: 0,
  },
  actionBtn: {
    flex: 1,
    minHeight: 48,
    justifyContent: 'center',
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
