/**
 * components/terminal/SetupBlock.tsx
 *
 * Renders an interactive setup step inside the terminal's BlockList.
 * Supports: tappable option buttons, text inputs, log output, skip/next actions.
 */

import React, { useState, useCallback, memo } from 'react';
import {
  View,
  Text,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '@/hooks/use-theme';
import { useTranslation } from '@/lib/i18n';
import type { SetupBlock as SetupBlockType } from '@/store/types';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

// ── Constants ────────────────────────────────────────────────────────────────


// ── Step icons ──────────────────────────────────────────────────────────────

const STEP_ICONS: Record<string, { icon: string; color: string }> = {
  'welcome': { icon: 'terminal', color: C.accent },
  'cli-select': { icon: 'smart-toy', color: '#8B5CF6' },
  'cli-install': { icon: 'download', color: C.warning },
  'cli-auth': { icon: 'vpn-key', color: '#60A5FA' },
  'git-config': { icon: 'source', color: '#F97316' },
  'git-input': { icon: 'source', color: '#F97316' },
  'git-ssh': { icon: 'key', color: '#F97316' },
  'project-scan': { icon: 'folder-open', color: '#A78BFA' },
  'done': { icon: 'check-circle', color: '#4ADE80' },
};

// ── Props ───────────────────────────────────────────────────────────────────

type Props = {
  block: SetupBlockType;
  onOptionToggle: (blockId: string, optionId: string) => void;
  onInputSubmit: (blockId: string, values: Record<string, string>) => void;
  onSkip: (blockId: string) => void;
  onBack: (blockId: string) => void;
  onAction: (blockId: string, action: string) => void;
};

// ── Component ───────────────────────────────────────────────────────────────

function SetupBlockComponent({ block, onOptionToggle, onInputSubmit, onSkip, onBack, onAction }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [inputValues, setInputValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    block.inputs?.forEach((inp) => { initial[inp.key] = inp.value || ''; });
    return initial;
  });

  const stepConfig = STEP_ICONS[block.stepId] || { icon: 'settings', color: C.text2 };
  const isActive = block.status === 'active';
  const isCompleted = block.status === 'completed';
  const isSkipped = block.status === 'skipped';
  const isError = block.status === 'error';

  // Resolve i18n keys
  const title = t(block.title) || block.title;
  const description = block.description ? (t(block.description) || block.description) : undefined;

  // ── Action handlers ─────────────────────────────────────────────────────

  const handlePrimaryAction = useCallback(() => {
    switch (block.stepId) {
      case 'welcome':
        onAction(block.id, 'next-from-welcome');
        break;
      case 'cli-select':
        onAction(block.id, 'install-selected');
        break;
      case 'cli-auth':
        onAction(block.id, 'auth-done');
        break;
      case 'git-input':
        onInputSubmit(block.id, inputValues);
        break;
      case 'git-ssh':
        break; // Handled by option press
      case 'project-scan':
        // Collect selected project paths
        const selectedPaths = block.options?.filter((o) => o.selected).map((o) => o.id) || [];
        onAction(block.id, 'register-projects');
        // Also register the projects
        import('@/lib/setup-flow').then(({ SetupFlow }) => {
          const flow = new (SetupFlow as any)(() => {}, () => {}, '', () => {});
          flow.registerProjects(selectedPaths);
        });
        break;
      case 'done':
        onAction(block.id, 'finish');
        break;
      default:
        onAction(block.id, 'next');
        break;
    }
  }, [block.id, block.stepId, block.options, inputValues, onAction, onInputSubmit]);

  const handleOptionPress = useCallback((optionId: string) => {
    if (block.stepId === 'git-ssh') {
      if (optionId === 'ssh-yes') {
        onAction(block.id, 'git-ssh-yes');
      } else {
        onAction(block.id, 'git-ssh-no');
      }
      return;
    }
    if (block.stepId === 'cli-auth') {
      // Extract tool id from option id (auth-claude-code -> claude-code)
      const toolId = optionId.replace('auth-', '');
      onAction(block.id, `auth-browser-${toolId}`);
      return;
    }
    onOptionToggle(block.id, optionId);
  }, [block.id, block.stepId, onOptionToggle, onAction]);

  // ── Status indicator ──────────────────────────────────────────────────

  const statusIcon = isCompleted ? 'check-circle' : isSkipped ? 'skip-next' : isError ? 'error' : undefined;
  const statusColor = isCompleted ? '#4ADE80' : isSkipped ? C.text2 : isError ? '#F87171' : undefined;

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <Animated.View
      entering={FadeInDown.duration(300)}
      style={[styles.container, { backgroundColor: colors.surface, borderColor: isActive ? stepConfig.color + '44' : colors.border }]}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={[styles.iconCircle, { backgroundColor: stepConfig.color + '18' }]}>
          {statusIcon ? (
            <MaterialIcons name={statusIcon as any} size={24} color={statusColor} />
          ) : (
            <MaterialIcons name={stepConfig.icon as any} size={24} color={stepConfig.color} />
          )}
        </View>
        <View style={styles.headerText}>
          <Text style={[styles.title, { color: isActive ? stepConfig.color : colors.muted }]}>
            {title}
          </Text>
          {description && (
            <Text style={[styles.description, { color: colors.muted }]}>
              {description}
            </Text>
          )}
        </View>
      </View>

      {/* Only show interactive content for active blocks */}
      {isActive && (
        <View style={styles.body}>
          {/* Options (buttons/checkboxes) */}
          {block.options && block.options.length > 0 && (
            <View style={styles.optionList}>
              {block.options.map((opt) => (
                <Pressable
                  key={opt.id}
                  style={[
                    styles.optionCard,
                    { borderColor: opt.selected ? (opt.color || C.accent) + '66' : colors.border },
                    opt.selected && { backgroundColor: (opt.color || C.accent) + '08' },
                  ]}
                  onPress={() => handleOptionPress(opt.id)}
                >
                  {block.multiSelect && (
                    <View style={[
                      styles.checkbox,
                      opt.selected && { borderColor: opt.color || C.accent, backgroundColor: opt.color || C.accent },
                    ]}>
                      {opt.selected && <MaterialIcons name="check" size={14} color="#000" />}
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Text style={[styles.optionLabel, { color: opt.color || colors.foreground }]}>
                        {t(opt.label) || opt.label}
                      </Text>
                      {opt.badge && (
                        <View style={styles.badge}>
                          <Text style={styles.badgeText}>{opt.badge}</Text>
                        </View>
                      )}
                    </View>
                    {opt.description && (
                      <Text style={[styles.optionDesc, { color: colors.muted }]}>
                        {t(opt.description) || opt.description}
                      </Text>
                    )}
                  </View>
                  {!block.multiSelect && (
                    <MaterialIcons name="chevron-right" size={18} color={colors.muted} />
                  )}
                </Pressable>
              ))}
            </View>
          )}

          {/* Text inputs */}
          {block.inputs && block.inputs.length > 0 && (
            <View style={styles.inputList}>
              {block.inputs.map((inp) => (
                <View key={inp.key} style={styles.inputRow}>
                  <Text style={[styles.inputLabel, { color: colors.foreground }]}>
                    {t(inp.label) || inp.label}
                  </Text>
                  <TextInput
                    style={[styles.textInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.background }]}
                    value={inputValues[inp.key] || ''}
                    onChangeText={(v) => setInputValues((prev) => ({ ...prev, [inp.key]: v }))}
                    placeholder={t(inp.placeholder || '') || inp.placeholder}
                    placeholderTextColor={colors.muted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                  />
                </View>
              ))}
            </View>
          )}

          {/* Log lines */}
          {block.logLines && block.logLines.length > 0 && (
            <ScrollView style={[styles.logContainer, { backgroundColor: colors.background, borderColor: colors.border }]} nestedScrollEnabled>
              {block.logLines.map((line, i) => (
                <Text
                  key={i}
                  style={[
                    styles.logLine,
                    {
                      color: line.startsWith('→ FAIL') || line.startsWith('ERROR') || line.startsWith('→ ERROR')
                        ? '#F87171'
                        : line.startsWith('✓') || line.startsWith('→ installed') || line.includes('already installed')
                          ? '#4ADE80'
                          : line.startsWith('$')
                            ? colors.accent
                            : colors.muted,
                    },
                  ]}
                  selectable
                  onLongPress={() => {
                    if (line.length > 20) {
                      Clipboard.setStringAsync(line);
                    }
                  }}
                >
                  {line}
                </Text>
              ))}
            </ScrollView>
          )}

          {/* Error message */}
          {block.errorMessage && (
            <View style={styles.errorBox}>
              <MaterialIcons name="error-outline" size={14} color="#F87171" />
              <Text style={styles.errorText}>{t(block.errorMessage) || block.errorMessage}</Text>
            </View>
          )}

          {/* Action buttons */}
          <View style={styles.actionRow}>
            {block.showBack && (
              <Pressable style={[styles.secondaryBtn, { borderColor: colors.border }]} onPress={() => onBack(block.id)}>
                <MaterialIcons name="arrow-back" size={14} color={colors.muted} />
                <Text style={[styles.secondaryBtnText, { color: colors.muted }]}>{t('setup.back')}</Text>
              </Pressable>
            )}

            {block.skippable && (
              <Pressable style={[styles.secondaryBtn, { borderColor: colors.border }]} onPress={() => onSkip(block.id)}>
                <Text style={[styles.secondaryBtnText, { color: colors.muted }]}>{t('setup.skip')}</Text>
              </Pressable>
            )}

            {block.actionLabel && (
              <Pressable
                style={[styles.primaryBtn, { backgroundColor: stepConfig.color }]}
                onPress={handlePrimaryAction}
              >
                <Text style={styles.primaryBtnText}>{t(block.actionLabel) || block.actionLabel}</Text>
                <MaterialIcons name="arrow-forward" size={14} color="#000" />
              </Pressable>
            )}
          </View>
        </View>
      )}

      {/* Completed log lines (collapsed) */}
      {!isActive && block.logLines && block.logLines.length > 0 && (
        <View style={[styles.logContainer, { backgroundColor: colors.background, borderColor: colors.border, maxHeight: 60 }]}>
          {block.logLines.slice(-3).map((line, i) => (
            <Text key={i} style={[styles.logLine, { color: colors.muted }]} selectable>
              {line}
            </Text>
          ))}
        </View>
      )}
    </Animated.View>
  );
}

export const SetupBlock = memo(SetupBlockComponent);

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 8,
    marginVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 15,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  description: {
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
    marginTop: 2,
  },
  body: {
    paddingHorizontal: 14,
    paddingBottom: 14,
    gap: 12,
  },
  // Options
  optionList: {
    gap: 8,
  },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: C.text3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionLabel: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  optionDesc: {
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 1,
  },
  badge: {
    backgroundColor: '#4ADE8030',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  badgeText: {
    color: '#4ADE80',
    fontSize: 8,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  // Inputs
  inputList: {
    gap: 10,
  },
  inputRow: {
    gap: 4,
  },
  inputLabel: {
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'monospace',
  },
  // Log
  logContainer: {
    maxHeight: 140,
    borderRadius: 8,
    borderWidth: 1,
    padding: 8,
    marginHorizontal: 14,
    marginBottom: 8,
  },
  logLine: {
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  // Error
  errorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F8717110',
    borderRadius: 8,
    padding: 10,
  },
  errorText: {
    color: '#F87171',
    fontSize: 12,
    fontFamily: 'monospace',
    flex: 1,
  },
  // Actions
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 8,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
  },
  secondaryBtnText: {
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 10,
    flex: 1,
    justifyContent: 'center',
  },
  primaryBtnText: {
    color: '#000',
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '800',
  },
});
