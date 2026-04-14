/**
 * components/chat/EditSheet.tsx — Click-to-Edit BottomSheet
 *
 * 選択された要素のプレビュー + 編集指示入力 + プリセットボタン。
 * WebTabから表示される。
 */

import React, { memo, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView } from 'react-native';
import { useTranslation } from '@/lib/i18n';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import type { SelectedElement } from '@/lib/click-to-edit';

// ─── Presets ────────────────────────────────────────────────────────────────

type TranslateFn = (key: string, params?: Record<string, string | number>) => string;
const getPresets = (t: TranslateFn) => [
  { label: t('edit_sheet.preset_larger'), icon: 'zoom-in' as const, instruction: t('edit_sheet.preset_larger_inst') },
  { label: t('edit_sheet.preset_smaller'), icon: 'zoom-out' as const, instruction: t('edit_sheet.preset_smaller_inst') },
  { label: t('edit_sheet.preset_color'), icon: 'palette' as const, instruction: t('edit_sheet.preset_color_inst') },
  { label: t('edit_sheet.preset_bold'), icon: 'format-bold' as const, instruction: t('edit_sheet.preset_bold_inst') },
  { label: t('edit_sheet.preset_spacing'), icon: 'format-line-spacing' as const, instruction: t('edit_sheet.preset_spacing_inst') },
  { label: t('edit_sheet.preset_delete'), icon: 'delete-outline' as const, instruction: t('edit_sheet.preset_delete_inst') },
];

// ─── Props ──────────────────────────────────────────────────────────────────

type Props = {
  visible: boolean;
  element: SelectedElement | null;
  onSubmit: (instruction: string) => void;
  onClose: () => void;
};

// ─── Component ──────────────────────────────────────────────────────────────

export const EditSheet = memo(function EditSheet({ visible, element, onSubmit, onClose }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [instruction, setInstruction] = useState('');

  const handleSubmit = useCallback(() => {
    if (!instruction.trim() || !element) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onSubmit(buildEditPrompt(element, instruction.trim()));
    setInstruction('');
  }, [instruction, element, onSubmit]);

  const PRESETS = getPresets(t);

  const handlePreset = useCallback((preset: ReturnType<typeof getPresets>[number]) => {
    if (!element) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onSubmit(buildEditPrompt(element, preset.instruction));
  }, [element, onSubmit]);

  if (!visible || !element) return null;

  return (
    <Animated.View
      entering={SlideInDown.duration(250).springify().damping(18)}
      exiting={SlideOutDown.duration(200)}
      style={[styles.container, { backgroundColor: colors.surface, borderTopColor: colors.border }]}
    >
      {/* Header */}
      <View style={styles.header}>
        <MaterialIcons name="touch-app" size={16} color={colors.accent} />
        <Text style={[styles.headerText, { color: colors.foreground }]} numberOfLines={1}>
          &lt;{element.tagName}&gt; {element.text ? `"${element.text.slice(0, 30)}..."` : ''}
        </Text>
        <TouchableOpacity onPress={onClose} activeOpacity={0.7}>
          <MaterialIcons name="close" size={18} color={colors.muted} />
        </TouchableOpacity>
      </View>

      {/* Current styles preview */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.stylePreview}>
        <StyleChip label="size" value={element.currentStyles.fontSize} colors={colors} />
        <StyleChip label="color" value={element.currentStyles.color} colors={colors} />
        <StyleChip label="bg" value={element.currentStyles.backgroundColor} colors={colors} />
        <StyleChip label="pad" value={element.currentStyles.padding} colors={colors} />
      </ScrollView>

      {/* Preset buttons */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.presetRow}>
        {PRESETS.map((preset) => (
          <TouchableOpacity
            key={preset.label}
            style={[styles.presetButton, { backgroundColor: withAlpha(colors.accent, 0.1) }]}
            onPress={() => handlePreset(preset)}
            activeOpacity={0.7}
          >
            <MaterialIcons name={preset.icon} size={14} color={colors.accent} />
            <Text style={[styles.presetText, { color: colors.accent }]}>{preset.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Custom instruction input */}
      <View style={styles.inputRow}>
        <TextInput
          style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: withAlpha(colors.foreground, 0.05) }]}
          placeholder={t('edit_sheet.placeholder')}
          placeholderTextColor={colors.muted}
          value={instruction}
          onChangeText={setInstruction}
          onSubmitEditing={handleSubmit}
          returnKeyType="send"
        />
        <TouchableOpacity
          style={[styles.sendButton, { backgroundColor: instruction.trim() ? colors.accent : withAlpha(colors.accent, 0.3) }]}
          onPress={handleSubmit}
          activeOpacity={0.7}
          disabled={!instruction.trim()}
        >
          <MaterialIcons name="send" size={16} color="#000" />
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
});

// ─── Style Chip ─────────────────────────────────────────────────────────────

function StyleChip({ label, value, colors }: { label: string; value: string; colors: any }) {
  return (
    <View style={[chipStyles.chip, { backgroundColor: withAlpha(colors.foreground, 0.06) }]}>
      <Text style={[chipStyles.label, { color: colors.muted }]}>{label}</Text>
      <Text style={[chipStyles.value, { color: colors.foregroundDim }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const chipStyles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    marginRight: 6,
  },
  label: { fontSize: 9, fontFamily: 'Silkscreen', fontWeight: '600' },
  value: { fontSize: 10, fontFamily: 'Silkscreen', maxWidth: 80 },
});

// ─── Helper ─────────────────────────────────────────────────────────────────

function buildEditPrompt(element: SelectedElement, userInstruction: string): string {
  return `[Click-to-Edit Context]
Selected element: ${element.selector}
Current tag: ${element.tagName}
Current text: "${element.text}"
Current styles: ${JSON.stringify(element.currentStyles)}

[User instruction]
${userInstruction}

Respond with ONLY the modified HTML/CSS. Use a single fenced code block.
Do not explain. Do not add comments.`;
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopWidth: 1,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 16,
    gap: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  headerText: {
    fontSize: 12,
    flex: 1,
  },
  stylePreview: {
    flexDirection: 'row',
    maxHeight: 24,
  },
  presetRow: {
    flexDirection: 'row',
    maxHeight: 32,
  },
  presetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    marginRight: 6,
  },
  presetText: {
    fontSize: 11,
    fontWeight: '600',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 13,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  sendButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
