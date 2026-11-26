/**
 * components/LauncherInboxModal.tsx — the launcher approval inbox (launcher
 * ingress Phase 2, P2-B3/B4). Read-only: pending (tap to reopen the prompt —
 * the only place a decision is taken, McpApprovalModal), approved (waiting to
 * be taken / consumed / stale), denied by you, expired, and submissions
 * refused at once (STOP-ALL, disabled, too large, ...) with their reason.
 * Retention is native: the newest 50 or the last 7 days, whichever is
 * shorter. No instruction text is ever listed here.
 *
 * Mounted once in ShellLayout; opened from Settings → Launcher or from the
 * launcher prompt. Presentation only (store/launcher-inbox-store.ts).
 */
import React, { memo, useCallback } from 'react';
import { View, Text, StyleSheet, Modal, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import { fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { useLauncherInboxStore } from '@/store/launcher-inbox-store';
import { maybePromptLauncherSubmission, type LauncherInboxItem } from '@/lib/launcher-approval';

/** The i18n key of a row's state label. */
export function inboxStateKey(item: LauncherInboxItem): string {
  if (item.state === 'approved') return 'launcher_inbox.state.approved_waiting';
  return `launcher_inbox.state.${item.state}`;
}

export const LauncherInboxModal = memo(function LauncherInboxModal() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const visible = useLauncherInboxStore((s) => s.visible);
  const loading = useLauncherInboxStore((s) => s.loading);
  const inbox = useLauncherInboxStore((s) => s.inbox);
  const close = useLauncherInboxStore((s) => s.close);
  const refresh = useLauncherInboxStore((s) => s.refresh);

  const reopen = useCallback((id: string) => {
    close();
    void maybePromptLauncherSubmission('inbox', id);
  }, [close]);

  const items = inbox?.items ?? [];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <View style={[styles.overlay, { backgroundColor: withAlpha(colors.background, 0.92) }]}>
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <MaterialIcons name="inbox" size={20} color={colors.accent} />
            <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>{t('launcher_inbox.title')}</Text>
            <Pressable onPress={() => void refresh()} hitSlop={8} accessibilityRole="button">
              <MaterialIcons name="refresh" size={20} color={colors.muted} />
            </Pressable>
            <Pressable onPress={close} hitSlop={8} accessibilityRole="button">
              <MaterialIcons name="close" size={20} color={colors.muted} />
            </Pressable>
          </View>
          <ScrollView style={styles.body} contentContainerStyle={styles.bodyContent}>
            <Text style={[styles.note, { color: colors.muted }]}>{t('launcher_inbox.intro')}</Text>
            {inbox?.halted ? (
              <Text style={[styles.note, { color: colors.error }]}>{t('launcher_inbox.halted')}</Text>
            ) : null}
            {loading && !inbox ? <ActivityIndicator color={colors.accent} /> : null}
            {inbox && !inbox.ok ? (
              <Text style={[styles.note, { color: colors.error }]}>{t('launcher_inbox.unreadable')}</Text>
            ) : null}
            {inbox?.ok && items.length === 0 ? (
              <Text style={[styles.note, { color: colors.muted }]}>{t('launcher_inbox.empty')}</Text>
            ) : null}
            {items.map((item, i) => {
              const pending = item.state === 'pending_approval' && item.id !== undefined && !inbox?.halted;
              const row = (
                <View style={[styles.row, { borderColor: colors.border }]}>
                  <View style={styles.rowHead}>
                    <Text style={[styles.state, { color: pending ? colors.accent : colors.foreground }]}>{t(inboxStateKey(item))}</Text>
                    <Text style={[styles.time, { color: colors.muted }]}>{new Date(item.at).toLocaleString()}</Text>
                  </View>
                  {item.state === 'approved' || item.state === 'consumed' || item.state === 'stale' ? (
                    <Text style={[styles.meta, { color: colors.muted }]}>
                      {t(`launcher_inbox.via.${item.approvedVia ?? 'user'}`)}
                    </Text>
                  ) : null}
                  {item.kind === 'denied' && item.reason ? (
                    <Text style={[styles.meta, { color: colors.muted }]}>{t('launcher_inbox.reason', { reason: item.reason, code: item.code ?? '' })}</Text>
                  ) : null}
                  {item.codePoints !== undefined ? (
                    <Text style={[styles.meta, { color: colors.muted }]}>{t('launcher_inbox.length', { count: item.codePoints })}</Text>
                  ) : null}
                  {pending ? <Text style={[styles.meta, { color: colors.accent }]}>{t('launcher_inbox.tap_to_review')}</Text> : null}
                </View>
              );
              const key = `${item.kind}-${item.id ?? ''}-${item.at}-${i}`;
              return pending ? (
                <Pressable key={key} onPress={() => reopen(item.id!)} accessibilityRole="button">{row}</Pressable>
              ) : (
                <View key={key}>{row}</View>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 16 },
  card: { width: '100%', maxWidth: 520, maxHeight: '85%', borderRadius: 12, borderWidth: 1, overflow: 'hidden' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1 },
  title: { flex: 1, fontFamily: F.family, fontSize: 14, fontWeight: '700' },
  body: { flexShrink: 1 },
  bodyContent: { padding: 14, gap: 8 },
  note: { fontFamily: F.family, fontSize: 11, lineHeight: 16 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, padding: 10, gap: 3 },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  state: { fontFamily: F.family, fontSize: 12, fontWeight: '700', flexShrink: 1 },
  time: { fontFamily: F.family, fontSize: 11 },
  meta: { fontFamily: F.family, fontSize: 11 },
});
