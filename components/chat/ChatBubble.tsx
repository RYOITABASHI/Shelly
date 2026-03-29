/**
 * components/chat/ChatBubble.tsx
 *
 * Chat message bubble — GPT/Claude style.
 * Right-aligned for user, left-aligned for assistant.
 */

import React, { memo, useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Share } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import Markdown from 'react-native-markdown-display';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';
import type { ChatMessage, ChatAgent, ActionsWizardData, AutoCheckState } from '@/store/chat-store';
import type { ThemeColorPalette } from '@/lib/theme';
import { SavepointBubble } from '@/components/SavepointBubble';
import { WebPreviewModal } from '@/components/WebPreviewModal';
import { useSavepointStore } from '@/store/savepoint-store';
import { useTerminalStore } from '@/store/terminal-store';
import { parseCodeBlocks, hasCodeBlocks } from '@/lib/parse-code-blocks';
import { ActionBlock } from '@/components/chat/ActionBlock';
import { ActionsWizardBubble } from '@/components/chat/ActionsWizardBubble';
import { AutoCheckProposalBubble } from '@/components/chat/AutoCheckProposalBubble';
import { ApprovalBubble } from '@/components/chat/ApprovalBubble';
import { ErrorSummaryBubble } from '@/components/chat/ErrorSummaryBubble';
import { PlanCardList } from '@/components/chat/PlanCardList';
import { ArenaBubble } from '@/components/chat/ArenaBubble';
import { isPlanOutput, parsePlanOutput } from '@/lib/parse-plan';
import { usePlanStore } from '@/store/plan-store';
import { useDeviceLayout } from '@/hooks/use-device-layout';

// ─── Agent Colors ────────────────────────────────────────────────────────────

const AGENT_COLORS: Record<ChatAgent | 'default', string> = {
  claude: '#F59E0B',
  gemini: '#3B82F6',
  local: '#8B5CF6',
  groq: '#F97316',
  cerebras: '#A78BFA',
  perplexity: '#14B8A6',
  team: '#EC4899',
  git: '#F97316',
  codex: '#6366F1',
  default: '#00D4AA',
};

function getAgentColor(agent?: ChatAgent): string {
  return agent ? AGENT_COLORS[agent] : AGENT_COLORS.default;
}

function getAgentLabel(agent?: ChatAgent): string {
  if (!agent) return 'AI';
  const labels: Record<ChatAgent, string> = {
    claude: 'Claude',
    gemini: 'Gemini',
    local: 'Local',
    groq: 'Groq',
    cerebras: 'Cerebras',
    perplexity: 'Search',
    team: 'Team',
    git: 'Git',
    codex: 'Codex',
  };
  return labels[agent];
}

// ─── Props ───────────────────────────────────────────────────────────────────

type Props = {
  message: ChatMessage;
  fontSize?: number;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onDelete?: (messageId: string) => void;
  projectDir?: string;
  runCommand?: (cmd: string) => Promise<{ stdout: string; exitCode: number }>;
  sendToTerminal?: (text: string) => void;
  runCommandInBackground?: (command: string) => Promise<{ stdout: string; exitCode: number | null }>;
  onWizardUpdate?: (messageId: string, data: ActionsWizardData) => void;
  onWizardComplete?: (messageId: string, data: ActionsWizardData) => void;
  onAutoCheckEnable?: (messageId: string) => void;
  onAutoCheckDismiss?: (messageId: string) => void;
  onAskTeam?: (context: string) => void;
  onSuggestFix?: (context: string) => void;
};

// ─── Component ───────────────────────────────────────────────────────────────

export const ChatBubble = memo(function ChatBubble({ message, fontSize = 14, onRegenerate, onEdit, onDelete, projectDir, runCommand, sendToTerminal, runCommandInBackground, onWizardUpdate, onWizardComplete, onAutoCheckEnable, onAutoCheckDismiss, onAskTeam, onSuggestFix }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isWide } = useDeviceLayout();
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const savepointInfo = useSavepointStore((s) => s.messageSavepoints[message.id]);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isUser = message.role === 'user';
  const agentColor = getAgentColor(message.agent);

  const handleOpenInTerminal = useCallback((command: string) => {
    if (sendToTerminal) {
      sendToTerminal(command);
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/(tabs)/terminal' as any);
  }, [sendToTerminal, router]);

  useEffect(() => {
    return () => { if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current); };
  }, []);

  const handleCopy = useCallback(async () => {
    const text = message.content || message.streamingText || '';
    if (!text) return;
    await Clipboard.setStringAsync(text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [message.content, message.streamingText]);

  const handleShare = useCallback(async () => {
    const text = message.content || message.streamingText || '';
    if (!text) return;
    const agentLabel = message.agent ? getAgentLabel(message.agent) : 'AI';
    try {
      await Share.share({ message: `${text}\n\n— via Shelly (${agentLabel})` });
    } catch { /* cancelled */ }
  }, [message.content, message.streamingText, message.agent]);

  const displayText = message.isStreaming ? (message.streamingText || '') : message.content;

  // ── Arena Bubble ────────────────────────────────────────────────────────
  if (message.arenaId) {
    return (
      <View style={styles.systemBubbleRow}>
        <ArenaBubble arenaId={message.arenaId} isWide={isWide} />
      </View>
    );
  }

  // ── Approval Bubble (system message with approvalData) ─────────────────
  if (message.approvalData) {
    return (
      <View style={styles.systemBubbleRow}>
        <ApprovalBubble data={message.approvalData} onAskTeam={onAskTeam} />
      </View>
    );
  }

  // ── Error Summary Bubble (system message with errorSummaryData) ────────
  if (message.errorSummaryData) {
    return (
      <View style={styles.systemBubbleRow}>
        <ErrorSummaryBubble data={message.errorSummaryData} onSuggestFix={onSuggestFix} onAskTeam={onAskTeam} />
      </View>
    );
  }

  // ── User Bubble (right-aligned) ──────────────────────────────────────────
  if (isUser) {
    return (
      <Animated.View
        entering={FadeInDown.duration(200).springify().damping(18)}
        style={styles.userRow}
      >
        <View style={[styles.userBubble, { backgroundColor: withAlpha(colors.accent, 0.12), borderColor: withAlpha(colors.accent, 0.2) }]}>
          <Text style={[styles.messageText, { color: colors.foreground, fontSize }]} selectable>
            {message.content}
          </Text>
          <View style={styles.bottomRow}>
            <View style={styles.actionGroup}>
              {onEdit && (
                <TouchableOpacity onPress={() => onEdit(message.id, message.content)} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Edit message">
                  <MaterialIcons name="edit" size={12} color={colors.inactive} />
                </TouchableOpacity>
              )}
              {onDelete && (
                <TouchableOpacity onPress={() => onDelete(message.id)} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Delete message">
                  <MaterialIcons name="delete-outline" size={12} color={colors.inactive} />
                </TouchableOpacity>
              )}
            </View>
            <Text style={[styles.timestamp, { color: colors.inactive }]}>
              {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </View>
        </View>
      </Animated.View>
    );
  }

  // ── Assistant Bubble (left-aligned) ──────────────────────────────────────
  return (
    <Animated.View
      entering={FadeInDown.duration(250).springify().damping(16)}
      style={styles.assistantRow}
    >
      {/* Avatar */}
      <View style={[styles.avatar, { backgroundColor: withAlpha(agentColor, 0.15), borderColor: withAlpha(agentColor, 0.3) }]}>
        <Text style={[styles.avatarText, { color: agentColor }]}>
          {getAgentLabel(message.agent).slice(0, 2)}
        </Text>
      </View>

      <View style={[styles.assistantBubble, { backgroundColor: colors.surfaceHigh, borderColor: withAlpha(agentColor, 0.15) }]}>
        {/* Accent bar */}
        <View style={[styles.accentBar, { backgroundColor: agentColor }]} />

        {/* Agent label + LLM model name */}
        {message.agent && (
          <View style={styles.agentRow}>
            <View style={[styles.agentDot, { backgroundColor: agentColor }]} />
            <Text style={[styles.agentLabel, { color: agentColor }]}>
              {getAgentLabel(message.agent)}
            </Text>
            {message.agent === 'local' && message.llmModelLabel && (
              <Text style={[styles.llmModelLabel, { color: withAlpha(agentColor, 0.6) }]}>
                {message.llmModelLabel}
              </Text>
            )}
            {message.isStreaming && (
              <ActivityIndicator size="small" color={agentColor} style={{ marginLeft: 4 }} />
            )}
          </View>
        )}

        {/* Auto-check proposal (after push) */}
        {message.autoCheckState && message.autoCheckState !== 'dismissed' && (
          <View style={styles.markdownWrap}>
            <AutoCheckProposalBubble
              state={message.autoCheckState}
              error={message.error}
              onEnable={() => onAutoCheckEnable?.(message.id)}
              onDismiss={() => onAutoCheckDismiss?.(message.id)}
            />
          </View>
        )}

        {/* Actions Wizard inline UI */}
        {message.wizardType === 'actions' && message.wizardData && (
          <View style={styles.markdownWrap}>
            <ActionsWizardBubble
              wizardData={message.wizardData}
              onUpdate={(data) => onWizardUpdate?.(message.id, data)}
              onComplete={(data) => onWizardComplete?.(message.id, data)}
            />
          </View>
        )}

        {/* Plan Mode ステップカード */}
        {!message.isStreaming && displayText && isPlanOutput(displayText) && (() => {
          const plan = parsePlanOutput(displayText, message.agent);
          if (plan) {
            return (
              <View style={styles.markdownWrap}>
                <PlanCardList
                  plan={plan}
                  onExecuteStep={(step) => {
                    if (step.command && sendToTerminal) {
                      usePlanStore.getState().updateStepStatus(plan.id, step.id, 'running');
                      sendToTerminal(step.command + '\n');
                      // Mark done after a short delay (real status should come from terminal output)
                      setTimeout(() => usePlanStore.getState().updateStepStatus(plan.id, step.id, 'done'), 2000);
                    } else {
                      usePlanStore.getState().updateStepStatus(plan.id, step.id, 'done');
                    }
                  }}
                  onSkipStep={(step) => {
                    usePlanStore.getState().updateStepStatus(plan.id, step.id, 'skipped');
                  }}
                  isWide={isWide}
                />
              </View>
            );
          }
          return null;
        })()}

        {/* Message text (Markdown) — skip if Plan Mode rendered above */}
        {(!displayText || message.isStreaming || !isPlanOutput(displayText)) && (() => {
          const markdownStyles = {
            body: { color: colors.foregroundDim, fontSize, fontFamily: 'monospace', lineHeight: 18 },
            code_inline: { backgroundColor: withAlpha(colors.foreground, 0.08), color: colors.accent, fontFamily: 'monospace', fontSize: fontSize - 1, paddingHorizontal: 4, borderRadius: 3 },
            code_block: { backgroundColor: '#0D0D0D', color: '#E8E8E8', fontFamily: 'monospace', fontSize: fontSize - 1, padding: 10, borderRadius: 6, lineHeight: 18 },
            fence: { backgroundColor: '#0D0D0D', color: '#E8E8E8', fontFamily: 'monospace', fontSize: fontSize - 1, padding: 10, borderRadius: 6, lineHeight: 18 },
            heading1: { color: colors.foreground, fontSize: fontSize + 4, fontWeight: '700' as const, fontFamily: 'monospace', marginVertical: 6 },
            heading2: { color: colors.foreground, fontSize: fontSize + 2, fontWeight: '700' as const, fontFamily: 'monospace', marginVertical: 4 },
            heading3: { color: colors.foreground, fontSize: fontSize + 1, fontWeight: '600' as const, fontFamily: 'monospace', marginVertical: 3 },
            link: { color: colors.link ?? colors.accent },
            blockquote: { borderLeftColor: agentColor, borderLeftWidth: 3, paddingLeft: 10, opacity: 0.85 },
            bullet_list_icon: { color: colors.foregroundDim },
            ordered_list_icon: { color: colors.foregroundDim },
          };
          if (displayText) {
            return (
              <View style={styles.markdownWrap}>
                {hasCodeBlocks(displayText) && !message.isStreaming ? (
                  <>
                    {parseCodeBlocks(displayText).map((seg, i) =>
                      seg.type === 'text' ? (
                        <Markdown key={i} style={markdownStyles}>
                          {seg.content}
                        </Markdown>
                      ) : (
                        <ActionBlock
                          key={i}
                          code={seg.content}
                          language={seg.language}
                          isWide={isWide}
                          onExecuteInTerminal={isWide ? sendToTerminal : undefined}
                          onExecuteInBackground={!isWide ? runCommandInBackground : undefined}
                        />
                      )
                    )}
                  </>
                ) : (
                  <Markdown style={markdownStyles}>
                    {displayText}
                  </Markdown>
                )}
                {message.isStreaming && (
                  <Text style={{ color: agentColor, fontSize: 14, fontFamily: 'monospace' }}>{'\u258B'}</Text>
                )}
              </View>
            );
          } else if (message.isStreaming) {
            return (
              <View style={[styles.markdownWrap, { flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
                <ActivityIndicator size="small" color={agentColor} />
                <Text style={{ color: agentColor, fontSize: 12, fontFamily: 'monospace', opacity: 0.7 }}>{t('chat.thinking')}</Text>
              </View>
            );
          }
          return null;
        })()}

        {/* Command executions */}
        {message.executions && message.executions.length > 0 && (
          <View style={styles.execContainer}>
            {message.executions.map((exec, i) => (
              <CommandExecView key={i} exec={exec} colors={colors} onOpenInTerminal={handleOpenInTerminal} />
            ))}
          </View>
        )}

        {/* Savepoint: undo + view changes */}
        {savepointInfo && projectDir && runCommand && (
          <SavepointBubble
            messageId={message.id}
            projectDir={projectDir}
            runCommand={runCommand}
          />
        )}

        {/* HTML Preview button */}
        {(() => {
          const content = message.content ?? '';
          const htmlMatch = content.match(/```html\n([\s\S]*?)```/);
          if (!htmlMatch || isUser) return null;
          return (
            <>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 6, marginTop: 4 }}
                onPress={() => setShowPreview(true)}
              >
                <MaterialIcons name="visibility" size={14} color={colors.accent} />
                <Text style={{ color: colors.accent, fontFamily: 'monospace', fontSize: 11, fontWeight: '600' }}>
                  {t('preview.open')}
                </Text>
              </TouchableOpacity>
              <WebPreviewModal
                visible={showPreview}
                html={htmlMatch[1]}
                onClose={() => setShowPreview(false)}
              />
            </>
          );
        })()}

        {/* Citations */}
        {message.citations && message.citations.length > 0 && (
          <View style={[styles.citationsBox, { borderTopColor: colors.surface }]}>
            <Text style={[styles.citationsTitle, { color: colors.inactive }]}>{t('chat.sources')}</Text>
            {message.citations.map((c, i) => (
              <Text key={i} style={[styles.citationItem, { color: colors.link }]} numberOfLines={1}>
                {i + 1}. {c.title || c.url}
              </Text>
            ))}
          </View>
        )}

        {/* Error */}
        {message.error && (
          <View style={styles.errorRow}>
            <MaterialIcons name="error-outline" size={14} color="#F87171" />
            <Text style={styles.errorText} numberOfLines={3}>{message.error}</Text>
          </View>
        )}

        {/* Actions + Timestamp */}
        <View style={styles.bottomRow}>
          {!message.isStreaming && displayText ? (
            <View style={styles.actionGroup}>
              <TouchableOpacity onPress={handleCopy} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Copy message">
                <MaterialIcons
                  name={copied ? 'check' : 'content-copy'}
                  size={12}
                  color={copied ? colors.accent : colors.inactive}
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={handleShare} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Share message">
                <MaterialIcons name="share" size={12} color={colors.inactive} />
              </TouchableOpacity>
              {onRegenerate && message.role === 'assistant' && (
                <TouchableOpacity onPress={() => onRegenerate(message.id)} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Regenerate response">
                  <MaterialIcons name="refresh" size={12} color={colors.inactive} />
                </TouchableOpacity>
              )}
              {onDelete && (
                <TouchableOpacity onPress={() => onDelete(message.id)} activeOpacity={0.7} style={styles.copyBtn} accessibilityRole="button" accessibilityLabel="Delete message">
                  <MaterialIcons name="delete-outline" size={12} color={colors.inactive} />
                </TouchableOpacity>
              )}
            </View>
          ) : <View />}
          <Text style={[styles.timestamp, { color: colors.inactive }]}>
            {message.isStreaming && message.streamingStartTime ? (
              (() => {
                const elapsed = Math.floor((Date.now() - message.streamingStartTime) / 1000);
                const tps = elapsed > 0 && message.tokenCount ? (message.tokenCount / elapsed).toFixed(1) : null;
                return `${message.tokenCount ?? 0} tok${tps ? ` · ${tps} t/s` : ''} · ${elapsed}s`;
              })()
            ) : (
              `${message.tokenCount ? `${message.tokenCount} tok · ` : ''}${new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
            )}
          </Text>
        </View>
      </View>
    </Animated.View>
  );
});

// ─── Command Execution Sub-component ─────────────────────────────────────────

function CommandExecView({ exec, colors, onOpenInTerminal }: {
  exec: { command: string; output: string; exitCode: number | null; isCollapsed: boolean };
  colors: ThemeColorPalette;
  onOpenInTerminal?: (command: string) => void;
}) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(exec.isCollapsed);
  const [outputCopied, setOutputCopied] = useState(false);
  useEffect(() => { setCollapsed(exec.isCollapsed); }, [exec.isCollapsed]);
  const isError = exec.exitCode !== null && exec.exitCode !== 0;
  const outputLines = exec.output.split('\n');
  const shouldCollapse = outputLines.length > 5;

  const handleCopyOutput = useCallback(async () => {
    await Clipboard.setStringAsync(exec.output);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setOutputCopied(true);
    setTimeout(() => setOutputCopied(false), 1500);
  }, [exec.output]);

  return (
    <View style={[styles.execBlock, { borderColor: isError ? '#F8717133' : '#2D2D2D' }]}>
      <TouchableOpacity
        style={styles.execHeader}
        onPress={() => shouldCollapse && setCollapsed(!collapsed)}
        activeOpacity={shouldCollapse ? 0.7 : 1}
      >
        <Text style={styles.execPrompt}>$</Text>
        <Text style={styles.execCommand} numberOfLines={1}>{exec.command}</Text>
        {exec.exitCode !== null && (
          <View style={[styles.exitBadge, { backgroundColor: isError ? '#F8717120' : '#4ADE8020' }]}>
            <Text style={[styles.exitText, { color: isError ? '#F87171' : '#4ADE80' }]}>
              {isError ? `exit ${exec.exitCode}` : 'ok'}
            </Text>
          </View>
        )}
        {/* Copy output button */}
        {exec.output && (
          <TouchableOpacity onPress={handleCopyOutput} activeOpacity={0.7} style={{ padding: 4 }}>
            <MaterialIcons name={outputCopied ? 'check' : 'content-copy'} size={12} color={outputCopied ? '#4ADE80' : '#6B7280'} />
          </TouchableOpacity>
        )}
        {shouldCollapse && (
          <MaterialIcons name={collapsed ? 'expand-more' : 'expand-less'} size={14} color="#6B7280" />
        )}
      </TouchableOpacity>
      {!collapsed && exec.output && (
        <Text style={styles.execOutput} selectable>
          {exec.output}
        </Text>
      )}
      {/* Open in Terminal link */}
      {onOpenInTerminal && (
        <TouchableOpacity
          style={styles.openInTerminalRow}
          onPress={() => onOpenInTerminal(exec.command)}
          activeOpacity={0.7}
        >
          <MaterialIcons name="terminal" size={12} color={colors.accent} />
          <Text style={[styles.openInTerminalText, { color: colors.accent }]}>
            {t('exec.open_in_terminal')}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  // System bubble (full-width, centered)
  systemBubbleRow: {
    paddingHorizontal: 12,
    marginVertical: 4,
  },
  // User bubble (right-aligned)
  userRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingLeft: 60,
    paddingRight: 12,
    marginVertical: 2,
  },
  userBubble: {
    borderRadius: 14,
    borderTopRightRadius: 4,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 5,
    maxWidth: '80%',
  },

  // Assistant bubble (left-aligned)
  assistantRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingLeft: 8,
    paddingRight: 40,
    marginVertical: 2,
    gap: 6,
  },
  avatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  avatarText: {
    fontSize: 8,
    fontWeight: '800',
    fontFamily: 'monospace',
  },
  assistantBubble: {
    flex: 1,
    maxWidth: '90%',
    borderRadius: 14,
    borderTopLeftRadius: 4,
    borderWidth: 1,
    overflow: 'hidden',
  },
  accentBar: {
    height: 2,
    width: '100%',
  },
  agentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingTop: 6,
    gap: 4,
  },
  agentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  agentLabel: {
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  llmModelLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '400',
    marginLeft: 6,
  },

  // Markdown wrapper
  markdownWrap: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  // Shared
  messageText: {
    fontFamily: 'monospace',
    lineHeight: 19,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  timestamp: {
    fontSize: 9,
    fontFamily: 'monospace',
    textAlign: 'right',
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingBottom: 4,
  },
  actionGroup: {
    flexDirection: 'row',
    gap: 1,
  },
  copyBtn: {
    padding: 6,
    minWidth: 30,
    minHeight: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Command execution
  execContainer: {
    paddingHorizontal: 10,
    paddingBottom: 6,
    gap: 4,
  },
  execBlock: {
    backgroundColor: '#0D0D0D',
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  execHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    gap: 6,
  },
  execPrompt: {
    color: '#00D4AA',
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  execCommand: {
    color: '#E8E8E8',
    fontSize: 12,
    fontFamily: 'monospace',
    flex: 1,
  },
  exitBadge: {
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  exitText: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  execOutput: {
    color: '#9CA3AF',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
    paddingHorizontal: 10,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: '#1A1A1A',
    paddingTop: 6,
  },
  openInTerminalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderTopWidth: 1,
    borderTopColor: '#1A1A1A',
  },
  openInTerminalText: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
  },

  // Citations
  citationsBox: {
    paddingHorizontal: 12,
    paddingBottom: 6,
    borderTopWidth: 1,
    paddingTop: 6,
  },
  citationsTitle: {
    fontFamily: 'monospace',
    fontSize: 10,
    fontWeight: '600',
    marginBottom: 2,
  },
  citationItem: {
    fontFamily: 'monospace',
    fontSize: 10,
    marginBottom: 1,
  },

  // Error
  errorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  errorText: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#F87171',
    flex: 1,
  },
});
