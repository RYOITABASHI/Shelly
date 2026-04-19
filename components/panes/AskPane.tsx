/**
 * components/panes/AskPane.tsx
 *
 * ASK Pane — Shelly's self-documenting assistant.
 *
 * Answers "can Shelly do X?" / "how do I use Y?" using the bundled
 * feature catalog + curated docs as system prompt. Calls Groq's free-
 * tier llama-3.3-70b-versatile by default (user can override the
 * provider via AI Pane settings — we just reuse whatever API key is
 * already configured there).
 *
 * Response format contract (enforced via system prompt):
 *   <answer body>
 *   [AVAILABLE|PLANNED|NOT_AVAILABLE]
 *
 * The trailing status tag is parsed out and rendered as a coloured
 * badge. Stage 1 MVP stops here; Stage 2 adds a "Create GitHub issue"
 * ActionBlock for NOT_AVAILABLE responses.
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '@/lib/theme-engine';
import { useSettingsStore } from '@/store/settings-store';
import { getApiKey } from '@/lib/secure-store';
import { buildAskSystemPrompt, extractStatus, stripStatusTag, type AskStatus } from '@/lib/ask-context';
import { groqChatStream } from '@/lib/groq';
import { logInfo, logError } from '@/lib/debug-logger';

type Turn = {
  id: string;
  question: string;
  answer: string;
  status: AskStatus;
  streaming: boolean;
  error?: string;
};

function statusLabel(status: AskStatus): string {
  switch (status) {
    case 'AVAILABLE': return '✅ 利用可能';
    case 'PLANNED': return '⏳ 計画中';
    case 'NOT_AVAILABLE': return '❌ 未実装';
    default: return '';
  }
}

function statusColor(status: AskStatus, theme: ReturnType<typeof useTheme>): string {
  switch (status) {
    case 'AVAILABLE': return theme.colors.success ?? '#22c55e';
    case 'PLANNED': return theme.colors.warning ?? '#facc15';
    case 'NOT_AVAILABLE': return theme.colors.error ?? '#ef4444';
    default: return theme.colors.muted ?? '#666';
  }
}

export default function AskPane() {
  const theme = useTheme();
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const groqModel = useSettingsStore((s) => s.settings.groqModel ?? 'llama-3.3-70b-versatile');

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || busy) return;

    const turnId = `ask-${Date.now()}`;
    setTurns((prev) => [...prev, { id: turnId, question: q, answer: '', status: null, streaming: true }]);
    setQuestion('');
    setBusy(true);

    const apiKey = await getApiKey('groqApiKey');
    if (!apiKey) {
      setTurns((prev) => prev.map((t) => t.id === turnId
        ? { ...t, streaming: false, error: 'Groq API キーが未設定です。Settings → Integrations → Groq で登録してください。' }
        : t,
      ));
      setBusy(false);
      return;
    }

    const system = buildAskSystemPrompt();
    let accumulated = '';
    try {
      const result = await groqChatStream(
        apiKey,
        q,
        (chunk, _done) => {
          accumulated += chunk;
          setTurns((prev) => prev.map((t) => t.id === turnId
            ? { ...t, answer: accumulated }
            : t,
          ));
          // Keep the scroll pinned near the bottom while the answer streams in.
          requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: false }));
        },
        groqModel,
        [],
        undefined,
        system,
      );
      const status = extractStatus(accumulated);
      const cleanAnswer = stripStatusTag(accumulated);
      if (result.success) {
        logInfo('AskPane', `answered: status=${status ?? '(none)'} len=${accumulated.length}`);
      } else {
        logError('AskPane', 'groq error', result.error);
      }
      setTurns((prev) => prev.map((t) => t.id === turnId
        ? { ...t, answer: cleanAnswer, status, streaming: false, error: result.success ? undefined : (result.error ?? 'Groq error') }
        : t,
      ));
    } catch (e: any) {
      logError('AskPane', 'dispatch failed', e);
      setTurns((prev) => prev.map((t) => t.id === turnId
        ? { ...t, streaming: false, error: e?.message ?? 'Unknown error' }
        : t,
      ));
    } finally {
      setBusy(false);
    }
  }, [question, busy, groqModel]);

  const styles = React.useMemo(() => makeStyles(theme), [theme]);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={styles.root}>
        <View style={styles.header}>
          <MaterialIcons name="help-outline" size={16} color={theme.colors.accent ?? '#a78bfa'} />
          <Text style={styles.headerTitle}>Ask Shelly</Text>
          <Text style={styles.headerHint}>  ·  Shelly の機能について何でも聞いてください</Text>
        </View>

        <ScrollView
          ref={scrollRef}
          style={styles.conversation}
          contentContainerStyle={{ paddingBottom: 16 }}
          keyboardShouldPersistTaps="handled"
        >
          {turns.length === 0 && (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>❓ Ask Shelly</Text>
              <Text style={styles.emptyBody}>
                Shelly の機能について質問できます。
                {'\n\n'}
                例:{'\n'}
                • 「ペイン分割ってどうやる？」{'\n'}
                • 「Cross-Pane Intelligence の使い方」{'\n'}
                • 「MIDI キーボード対応してる？」{'\n\n'}
                回答の末尾には ✅ / ⏳ / ❌ のステータスが付きます。
                未実装機能には GitHub Issue を作成するボタンが出ます (Stage 2 で実装予定)。
              </Text>
            </View>
          )}
          {turns.map((t) => (
            <View key={t.id} style={styles.turn}>
              <View style={styles.questionRow}>
                <MaterialIcons name="person" size={14} color={theme.colors.muted} />
                <Text style={styles.questionText}>{t.question}</Text>
              </View>
              {t.error ? (
                <View style={styles.errorBox}>
                  <MaterialIcons name="error-outline" size={14} color={theme.colors.error ?? '#ef4444'} />
                  <Text style={styles.errorText}>{t.error}</Text>
                </View>
              ) : (
                <>
                  <Text style={styles.answerText}>{t.answer || (t.streaming ? '…' : '')}</Text>
                  {t.status && !t.streaming && (
                    <View style={[styles.statusChip, { borderColor: statusColor(t.status, theme) }]}>
                      <Text style={[styles.statusText, { color: statusColor(t.status, theme) }]}>
                        {statusLabel(t.status)}
                      </Text>
                    </View>
                  )}
                  {t.status === 'NOT_AVAILABLE' && !t.streaming && (
                    <View style={styles.stagedActionRow}>
                      <MaterialIcons name="info-outline" size={12} color={theme.colors.muted} />
                      <Text style={styles.stagedActionText}>
                        Issue 作成機能は Stage 2 で実装予定 (shelly-cs OAuth token 経由)
                      </Text>
                    </View>
                  )}
                </>
              )}
            </View>
          ))}
        </ScrollView>

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            value={question}
            onChangeText={setQuestion}
            placeholder="Shelly の機能について質問…"
            placeholderTextColor={theme.colors.muted}
            onSubmitEditing={ask}
            editable={!busy}
            returnKeyType="send"
            multiline={false}
          />
          <TouchableOpacity
            onPress={ask}
            disabled={busy || !question.trim()}
            style={[
              styles.sendBtn,
              (busy || !question.trim()) && { opacity: 0.4 },
            ]}
          >
            {busy
              ? <ActivityIndicator size="small" color={theme.colors.accent ?? '#a78bfa'} />
              : <MaterialIcons name="send" size={18} color={theme.colors.accent ?? '#a78bfa'} />
            }
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  const c = theme.colors;
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: c.background ?? '#0a0a0a',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border ?? '#1f1f1f',
    },
    headerTitle: {
      color: c.foreground ?? '#eee',
      fontFamily: 'JetBrainsMono_700Bold',
      fontSize: 12,
      marginLeft: 6,
    },
    headerHint: {
      color: c.muted ?? '#666',
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 10,
    },
    conversation: {
      flex: 1,
      paddingHorizontal: 12,
      paddingTop: 8,
    },
    empty: {
      paddingVertical: 24,
      paddingHorizontal: 8,
    },
    emptyTitle: {
      color: c.foreground ?? '#eee',
      fontFamily: 'JetBrainsMono_700Bold',
      fontSize: 14,
      marginBottom: 8,
    },
    emptyBody: {
      color: c.muted ?? '#888',
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 11,
      lineHeight: 16,
    },
    turn: {
      marginBottom: 20,
    },
    questionRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 6,
      marginBottom: 6,
    },
    questionText: {
      flex: 1,
      color: c.foreground ?? '#eee',
      fontFamily: 'JetBrainsMono_700Bold',
      fontSize: 12,
      lineHeight: 16,
    },
    answerText: {
      color: c.foreground ?? '#ddd',
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 11,
      lineHeight: 16,
      marginLeft: 20,
    },
    statusChip: {
      alignSelf: 'flex-start',
      marginLeft: 20,
      marginTop: 6,
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 10,
      borderWidth: 1,
    },
    statusText: {
      fontFamily: 'JetBrainsMono_700Bold',
      fontSize: 10,
    },
    stagedActionRow: {
      marginLeft: 20,
      marginTop: 6,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    stagedActionText: {
      color: c.muted ?? '#666',
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 9,
      fontStyle: 'italic',
    },
    errorBox: {
      marginLeft: 20,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    errorText: {
      flex: 1,
      color: c.error ?? '#ef4444',
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 10,
    },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border ?? '#1f1f1f',
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 8,
    },
    input: {
      flex: 1,
      color: c.foreground ?? '#eee',
      backgroundColor: c.surface ?? '#1a1a1a',
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontFamily: 'JetBrainsMono_400Regular',
      fontSize: 12,
    },
    sendBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.border ?? '#2a2a2a',
    },
  });
}
