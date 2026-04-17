/**
 * components/panes/AIPane.tsx
 *
 * AI Pane — per-pane chat interface for the Superset UI.
 * Redesigned to match mock: YOU/CLAUDE labels, inline diff, READING TERMINAL badge.
 */

import React, { useContext, useCallback, useRef, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Animated,
  Easing,
  TouchableOpacity,
  type ListRenderItemInfo,
  type TextStyle,
} from 'react-native';
import {
  neonGlowPurple,
  neonGlowBlue,
  neonGlowGreen,
  neonGlowAmber,
  neonGlowSky,
  neonGlowTeal,
} from '@/lib/neon-glow';
import { MaterialIcons } from '@expo/vector-icons';
import { PaneIdContext, MultiPaneContext } from '@/components/multi-pane/PaneSlot';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { usePaneStore } from '@/store/pane-store';
import { formatContextBadge } from '@/lib/ai-pane-context';
import { useTheme } from '@/lib/theme-engine';
import type { ChatMessage } from '@/store/chat-store';
import PaneInputBar from '@/components/panes/PaneInputBar';
import InlineDiff, { hasDiffContent } from '@/components/panes/InlineDiff';
import { useAIPaneDispatch } from '@/hooks/use-ai-pane-dispatch';
import VoiceWaveform from '@/components/panes/VoiceWaveform';
import { usePaneVoice } from '@/hooks/use-pane-voice';
import { useSettingsStore } from '@/store/settings-store';
import { VoiceChat } from '@/components/VoiceChat';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

// ─── Streaming Indicator ─────────────────────────────────────────────────────

const StreamingDots = React.memo(function StreamingDots({ color }: { color: string }) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <Animated.Text style={[dotStyles.text, { color, opacity }]}>
      {'...'}
    </Animated.Text>
  );
});

const dotStyles = StyleSheet.create({
  text: {
    fontFamily: F.family,
    fontSize: 16,
    letterSpacing: 2,
    marginTop: 2,
  },
});

// ─── Per-agent label colors (mock-faithful neon) ────────────────────────────

const AGENT_LABEL_COLORS: Record<string, string> = {
  claude:     '#A78BFA', // purple
  gemini:     '#60A5FA', // blue
  codex:      '#22C55E', // green
  cerebras:   '#FF6B35', // brand orange
  groq:       '#F97316', // brand orange-deep
  perplexity: '#38BDF8', // sky
  local:      '#E5E7EB', // neutral
  default:    '#A78BFA',
};

const AGENT_LABEL_GLOWS: Record<string, TextStyle> = {
  claude:     neonGlowPurple,
  gemini:     neonGlowBlue,
  codex:      neonGlowGreen,
  cerebras:   neonGlowAmber,
  groq:       neonGlowAmber,
  perplexity: neonGlowSky,
  local:      neonGlowTeal,
  default:    neonGlowPurple,
};

// ─── Message Bubble (Redesigned) ────────────────────────────────────────────

type BubbleProps = {
  message: ChatMessage;
  isStreaming: boolean;
  maxWidth?: number;
};

const MessageBubble = React.memo(function MessageBubble({
  message,
  isStreaming,
  maxWidth,
}: BubbleProps) {
  const containerMaxWidth = maxWidth && maxWidth > 0 ? { maxWidth } : null;
  const isUser = message.role === 'user';
  const isLastStreaming = isStreaming && message.isStreaming;
  const displayText = message.streamingText ?? message.content;

  if (message.role === 'system') {
    return (
      <View style={[bubbleStyles.systemRow, containerMaxWidth]}>
        <Text style={bubbleStyles.systemText}>{displayText}</Text>
      </View>
    );
  }

  if (isUser) {
    return (
      <View style={[bubbleStyles.messageContainer, containerMaxWidth]}>
        <Text style={bubbleStyles.roleLabel}>YOU</Text>
        <Text style={bubbleStyles.userText} selectable>{displayText}</Text>
      </View>
    );
  }

  // Assistant message
  const containsDiff = !isLastStreaming && hasDiffContent(displayText);
  const agentKey = message.agent ?? 'claude';
  const agentLabel = agentKey.toUpperCase();
  // Per-provider neon label color so each assistant bubble reads as the
  // agent that produced it (mock: CLAUDE purple, Cerebras orange, etc).
  const labelColor = AGENT_LABEL_COLORS[agentKey] ?? AGENT_LABEL_COLORS.default;
  const labelGlow = AGENT_LABEL_GLOWS[agentKey] ?? AGENT_LABEL_GLOWS.default;

  return (
    <View style={[bubbleStyles.messageContainer, containerMaxWidth]}>
      <Text style={[bubbleStyles.roleLabelClaude, { color: labelColor }, labelGlow]}>
        {agentLabel}
      </Text>
      <View style={bubbleStyles.assistantContent}>
        {containsDiff ? (
          <InlineDiff content={displayText} />
        ) : (
          <Text style={bubbleStyles.assistantText} selectable>{displayText}</Text>
        )}
        {isLastStreaming && <StreamingDots color="#6B7280" />}
      </View>
    </View>
  );
});

const bubbleStyles = StyleSheet.create({
  messageContainer: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  roleLabel: {
    fontSize: 7,
    fontFamily: F.family,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: C.accentBlue,
    marginBottom: 2,
    textTransform: 'uppercase',
    textShadowColor: 'rgba(96, 165, 250, 0.6)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
  roleLabelClaude: {
    fontSize: 7,
    fontFamily: F.family,
    fontWeight: '800',
    letterSpacing: 0.8,
    color: '#D4A574',
    marginBottom: 2,
    textTransform: 'uppercase',
  },
  userText: {
    fontSize: 8,
    fontFamily: F.family,
    lineHeight: 14,
    color: C.text1,
  },
  assistantContent: {
    backgroundColor: C.bgSurface,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  assistantText: {
    fontSize: 8,
    fontFamily: F.family,
    lineHeight: 14,
    color: C.text1,
  },
  systemRow: {
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  systemText: {
    fontSize: 7,
    fontFamily: F.family,
    color: C.text2,
    fontStyle: 'italic',
  },
});

// ─── AIPane ──────────────────────────────────────────────────────────────────

export default function AIPane() {
  const paneId = useContext(PaneIdContext);
  const theme = useTheme();
  const colors = theme.colors;
  // Bug #56 — narrow grid layouts (2×2 or 1+2) drop pane width below
  // ~360dp. Shrink horizontal padding so bubble content does not get
  // clipped by the pane chrome.
  const mp = useContext(MultiPaneContext);
  const pw = mp?.paneWidth ?? 0;
  const ph = mp?.paneHeight ?? 0;
  const isCompactPane = pw > 0 && pw < 360;
  const compactOverlay = isCompactPane
    ? { paddingHorizontal: 6 }
    : null;
  // Wave F — cap chat bubble width at 85% of the pane so long responses
  // do not run into the right-edge chrome in 2×2 grid layouts. Fall back
  // to 0 (unconstrained) when paneWidth is not yet measured.
  const bubbleMaxWidth = pw > 0 ? Math.max(Math.floor(pw * 0.85), 180) : 0;
  // ph is captured for future height-aware tweaks (e.g. clamping the
  // input-row footprint in short panes). Referenced to satisfy the
  // noUnusedLocals compiler option.
  void ph;

  const { dispatch, cancelStreaming, isStreaming: dispatchStreaming } = useAIPaneDispatch(paneId);

  const handleSubmit = useCallback(
    (text: string) => { dispatch(text); },
    [dispatch],
  );

  const { startRecording, stopRecording, isRecording, isTranscribing } =
    usePaneVoice(handleSubmit);

  const handleMicPress = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, startRecording, stopRecording]);

  const [voiceChatVisible, setVoiceChatVisible] = useState(false);
  const handleMicLongPress = useCallback(() => {
    setVoiceChatVisible(true);
  }, []);

  const handleAttach = useCallback(() => {
    if (dispatchStreaming) {
      cancelStreaming();
    }
  }, [dispatchStreaming, cancelStreaming]);

  const conversation = useAIPaneStore((s) => {
    return s.conversations[paneId] ?? null;
  });

  const initialised = useRef(false);
  if (!initialised.current) {
    useAIPaneStore.getState().getOrCreate(paneId);
    if (!usePaneStore.getState().paneAgents[paneId]) {
      // Pick the first agent the user has actually configured. The order
      // mirrors the chat-routing decision settled in commit 2ba65f3a:
      //   Cerebras Qwen3-235B (1M tok/day, frontier-class, fastest)
      //   → Groq Llama3 (100K tok/day, fast fallback)
      //   → Gemini API (free tier)
      //   → Claude CLI (bundled, always available, no key needed)
      const s = useSettingsStore.getState().settings;
      const pick =
        s.cerebrasApiKey ? 'cerebras' :
        s.groqApiKey     ? 'groq' :
        s.geminiApiKey   ? 'gemini' :
        'claude';
      usePaneStore.getState().bindAgent(paneId, pick);
    }
    initialised.current = true;
  }

  const boundAgent = usePaneStore((s) => s.paneAgents[paneId] ?? null);
  const prevAgentRef = useRef<string | null>(boundAgent);
  useEffect(() => {
    const prev = prevAgentRef.current;
    prevAgentRef.current = boundAgent;
    if (prev === boundAgent) return;
    const agentName = boundAgent
      ? boundAgent.charAt(0).toUpperCase() + boundAgent.slice(1)
      : 'Unbound';
    const systemMsg: ChatMessage = {
      id: `system-agent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role: 'system',
      content: `Switched to ${agentName}`,
      timestamp: Date.now(),
    };
    useAIPaneStore.getState().addMessage(paneId, systemMsg);
  }, [boundAgent, paneId]);

  const messages = conversation?.messages ?? [];
  const isStreaming = conversation?.isStreaming ?? false;
  const terminalContext = conversation?.terminalContext ?? null;
  const contextBadge = formatContextBadge(terminalContext);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatMessage>) => (
      <MessageBubble
        message={item}
        isStreaming={isStreaming}
        maxWidth={bubbleMaxWidth}
      />
    ),
    [isStreaming, bubbleMaxWidth],
  );

  const keyExtractor = useCallback((item: ChatMessage) => item.id, []);

  return (
    <View style={[paneStyles.container, compactOverlay]}>
      {/* Context badge — READING TERMINAL 1 */}
      {contextBadge && (
        <View style={paneStyles.contextBadge}>
          <MaterialIcons name="visibility" size={9} color={C.accent} />
          <Text style={paneStyles.contextBadgeText}>{contextBadge}</Text>
        </View>
      )}

      {/* Message list */}
      {messages.length === 0 ? (
        <View style={paneStyles.emptyState}>
          <Text style={paneStyles.emptyText}>
            Ask anything. I can see your terminal output.
          </Text>
        </View>
      ) : (
        <FlatList
          data={messages}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          inverted={false}
          contentContainerStyle={paneStyles.listContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          removeClippedSubviews
        />
      )}

      {/* Voice mode indicator */}
      {(isRecording || isTranscribing) && (
        <View style={paneStyles.voiceBar}>
          <VoiceWaveform active={isRecording} />
          <Text style={paneStyles.voiceLabel}>
            {isTranscribing ? 'Transcribing...' : 'Listening...'}
          </Text>
          {isRecording && (
            <TouchableOpacity onPress={stopRecording} style={paneStyles.voiceStopButton}>
              <MaterialIcons name="stop" size={16} color={C.accent} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Input bar (mic integrated so the attach/mic/send icons live inside
          the same rounded pill rather than as separate large circles). */}
      <PaneInputBar
        placeholder={dispatchStreaming ? 'Responding...' : 'Ask anything...'}
        onSubmit={handleSubmit}
        onAttach={handleAttach}
        showMic
        isRecording={isRecording}
        onMicPress={handleMicPress}
        onMicLongPress={handleMicLongPress}
      />

      <VoiceChat
        visible={voiceChatVisible}
        onClose={() => setVoiceChatVisible(false)}
      />
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const paneStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.bgDeep,
  },
  contextBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    marginHorizontal: 10,
    marginTop: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.35)',
    backgroundColor: 'rgba(0,212,170,0.08)',
  },
  contextDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.accent,
  },
  contextBadgeText: {
    fontSize: 7,
    fontFamily: F.family,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontWeight: '700',
    color: C.accent,
    textShadowColor: 'rgba(0, 212, 170, 0.9)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 8,
    fontFamily: F.family,
    textAlign: 'center',
    lineHeight: 14,
    color: C.text2,
  },
  listContent: {
    paddingVertical: 8,
  },
  voiceBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: C.border,
    backgroundColor: C.bgSurface,
    gap: 8,
  },
  voiceLabel: {
    flex: 1,
    fontSize: 7,
    fontFamily: F.family,
    letterSpacing: 0.5,
    color: C.accent,
  },
  voiceStopButton: {
    width: 28,
    height: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
