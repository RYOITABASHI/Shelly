import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';
import { loadUserProfile } from '@/lib/user-profile';
import { suggestAgentsFromProfile, type AgentSuggestion } from '@/lib/agent-suggestion-engine';
import { markSuggestionSeen, shouldShowSuggestion } from '@/lib/agent-suggestion-dismissals';
import { useAgentStore } from '@/store/agent-store';
import { useSettingsStore } from '@/store/settings-store';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { hasDraftAssumptions, summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { useMultiPaneStore, type SlotIndex } from '@/hooks/use-multi-pane';
import { usePaneStore } from '@/store/pane-store';

function nextMessageId(): string {
  return `agent-suggestion-${Date.now().toString(36)}`;
}

function focusOrOpenAiPane(): string | null {
  const multiPane = useMultiPaneStore.getState();
  let aiSlot = multiPane.slots.find((slot) => slot?.tab === 'ai') ?? null;
  if (aiSlot) {
    const slotIndex = multiPane.slots.findIndex((slot) => slot?.id === aiSlot!.id);
    if (slotIndex >= 0) multiPane.focusSlot(slotIndex as SlotIndex);
    usePaneStore.getState().setFocusedPane(aiSlot.id);
    return aiSlot.id;
  }
  if (multiPane.addPane('ai') !== null) return null;
  const next = useMultiPaneStore.getState();
  aiSlot = next.slots[next.focusedSlot];
  return aiSlot?.tab === 'ai' ? aiSlot.id : null;
}

export function AgentSuggestionCard() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const agents = useAgentStore((s) => s.agents);
  const settingsLoaded = useSettingsStore((s) => s.isSettingsLoaded);
  const profileLearningEnabled = useSettingsStore((s) => s.settings.profileLearningEnabled ?? true);
  const [suggestion, setSuggestion] = useState<AgentSuggestion | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Codex review finding (round 2): settings load asynchronously from
    // AsyncStorage (loadSettings(), app/_layout.tsx), so before that
    // finishes `profileLearningEnabled` reads the in-memory default (true)
    // even if the user had persisted it to false — this would flash a
    // suggestion on cold start despite Profile Learning being off. Wait for
    // isSettingsLoaded before honoring the flag either way.
    if (!settingsLoaded || !profileLearningEnabled) {
      setSuggestion(null);
      return;
    }
    const refresh = async () => {
      if (cancelled || suggestion) return;
      const profile = await loadUserProfile();
      const candidates = suggestAgentsFromProfile(profile, agents, { limit: 3 });
      for (const candidate of candidates) {
        if (await shouldShowSuggestion(candidate.id)) {
          if (!cancelled) setSuggestion(candidate);
          return;
        }
      }
      if (!cancelled) setSuggestion(null);
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agents, settingsLoaded, profileLearningEnabled, suggestion]);

  const message = useMemo(() => {
    if (!suggestion) return '';
    return t('suggestions.agent.message', { signal: suggestion.signal });
  }, [suggestion, t]);

  const dismiss = useCallback(() => {
    if (!suggestion) return;
    void markSuggestionSeen(suggestion.id);
    setSuggestion(null);
  }, [suggestion]);

  const accept = useCallback(() => {
    if (!suggestion) return;
    const paneId = focusOrOpenAiPane();
    if (!paneId) return;
    const messageId = nextMessageId();
    const now = Date.now();
    const store = useAIPaneStore.getState();
    store.addMessage(paneId, {
      id: messageId,
      role: 'assistant',
      content: summarizeAgentDraftAsText(suggestion.draft),
      timestamp: now,
      agent: undefined,
      agentDraft: suggestion.draft,
      agentCardState: 'pending',
      agentChatConfirm: true,
    });
    store.setPendingAgentSession(paneId, {
      draft: suggestion.draft,
      phase: 'await-confirm',
      attemptCounts: {},
      hasAssumptions: hasDraftAssumptions(suggestion.draft),
      createdAt: now,
      messageId,
      agentLabel: undefined,
    });
    // Codex review finding (round 2): do NOT mark the suggestion "seen" here
    // — Accept only opens the chat-native confirm step, it does not create
    // the agent. If the user cancels there, the suggestion must remain
    // eligible to resurface later; only an explicit Dismiss (below) should
    // permanently suppress it. The global 60s throttle in
    // shouldShowSuggestion already keeps it from reappearing immediately
    // while the chat confirm is still pending.
    setSuggestion(null);
  }, [suggestion]);

  if (!suggestion) return null;

  return (
    <View
      style={[
        styles.wrap,
        {
          backgroundColor: colors.surfaceHigh,
          borderColor: withAlpha(colors.accent, 0.35),
        },
      ]}
    >
      <MaterialIcons name="auto-awesome" size={15} color={colors.accent} />
      <View style={styles.text}>
        <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>
          {t('suggestions.agent.title')}
        </Text>
        <Text style={[styles.body, { color: colors.muted }]} numberOfLines={2}>
          {message}
        </Text>
      </View>
      <Pressable
        style={[styles.button, { borderColor: withAlpha(colors.accent, 0.45) }]}
        onPress={accept}
        accessibilityRole="button"
      >
        <Text style={[styles.buttonText, { color: colors.accent }]} numberOfLines={1}>
          {t('suggestions.agent.accept')}
        </Text>
      </Pressable>
      <Pressable
        style={styles.iconButton}
        onPress={dismiss}
        accessibilityRole="button"
        accessibilityLabel={t('suggestions.agent.dismiss')}
      >
        <MaterialIcons name="close" size={16} color={colors.muted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    letterSpacing: 0,
  },
  body: {
    fontSize: 10,
    lineHeight: 13,
    letterSpacing: 0,
  },
  button: {
    height: 28,
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderWidth: 1,
    borderRadius: 6,
  },
  buttonText: {
    fontSize: 10,
    lineHeight: 12,
    fontWeight: '700',
    letterSpacing: 0,
  },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
