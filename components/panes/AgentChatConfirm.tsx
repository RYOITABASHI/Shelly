/**
 * components/panes/AgentChatConfirm.tsx
 *
 * Chat-native confirmation affordance for NL-self-registered agents whose draft
 * is app-act (e.g. X-posting) or a tool-pinned multi-step orchestration (Phase 7).
 * The project owner rejected a structured card/modal for this: "カードも要らない
 * って。チャットで自然言語で確認すればいいじゃん。" (no card — confirm via natural
 * language in chat). The natural-language plan itself is rendered as ordinary
 * assistant chat text (see `summarizeAgentDraftAsText` in lib/agent-plan-summary.ts,
 * set as the message's `content` at creation time in hooks/use-ai-pane-dispatch.ts).
 * This component is ONLY the trailing inline Confirm/Cancel affordance — two plain
 * buttons, not a form. There is no field editing: if the user wants something
 * different, the project's stated design is to cancel and re-describe it in chat.
 *
 * HARD REQUIREMENT (mirrors AgentConfirmCard's own, see its top doc comment):
 * Confirm must be withheld until a valid schedule exists — "never register an
 * agent that will never fire." `hasFireableSchedule` encodes the exact same
 * invariant for the no-editing chat-native flow; when it's false, only Cancel is
 * offered (the summary text already explains why, via schedule_restate_hint).
 *
 * Non-app-act / non-tool-pinned drafts are NOT routed here — they keep using
 * AgentConfirmCard unchanged (see components/panes/AIPane.tsx and
 * lib/agent-plan-summary.ts's `shouldUseChatConfirm`).
 */
import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import { hasFireableSchedule, draftToConfirmedAgentDraft } from '@/lib/agent-plan-summary';
import type { ConfirmedAgentDraft } from '@/components/panes/AgentConfirmCard';

interface Props {
  draft: ParsedAgentDraft;
  onConfirm: (final: ConfirmedAgentDraft) => void;
  onCancel: () => void;
}

export default function AgentChatConfirm({ draft, onConfirm, onCancel }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const canConfirm = hasFireableSchedule(draft);

  return (
    <View style={styles.row}>
      <TouchableOpacity
        onPress={onCancel}
        style={[styles.btn, { borderColor: colors.border }]}
        activeOpacity={0.7}
      >
        <Text style={[styles.btnText, { color: colors.muted }]}>{t('agentcard.cancel')}</Text>
      </TouchableOpacity>
      {canConfirm && (
        <TouchableOpacity
          onPress={() => onConfirm(draftToConfirmedAgentDraft(draft))}
          style={[styles.btn, { backgroundColor: colors.success, borderColor: colors.success }]}
          activeOpacity={0.7}
        >
          <Text style={[styles.btnText, { color: colors.background, fontWeight: '700' }]}>
            {t('agentcard.confirm')}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, paddingHorizontal: 12, paddingBottom: 6, marginTop: -2 },
  btn: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 6 },
  btnText: { fontSize: 12 },
});
