import React, { memo, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';

export type MentionOption = {
  trigger: string;
  label: string;
  description: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  color: string;
};

const MENTION_OPTIONS: MentionOption[] = [
  { trigger: '@local',      label: 'Local LLM',   description: 'ローカルAIに質問',       icon: 'memory',         color: '#8B5CF6' },
  { trigger: '@claude',     label: 'Claude Code',  description: 'コード生成・修正',        icon: 'code',           color: '#F59E0B' },
  { trigger: '@gemini',     label: 'Gemini',       description: '調査・検索・画像分析',     icon: 'travel-explore', color: '#3B82F6' },
  { trigger: '@perplexity', label: 'Perplexity',   description: 'リアルタイムWeb検索',     icon: 'search',         color: '#20B2AA' },
  { trigger: '@git',        label: 'Git Guide',    description: 'Git操作ガイド',           icon: 'account-tree',   color: '#F97316' },
  { trigger: '@team',       label: 'Team Table',   description: 'マルチAI並列実行',        icon: 'groups',         color: '#EC4899' },
  { trigger: '@open',       label: 'Browser',      description: 'URLをブラウザで開く',     icon: 'open-in-browser', color: '#4ADE80' },
];

type Props = {
  query: string;
  onSelect: (trigger: string) => void;
};

function MentionDropdownInner({ query, onSelect }: Props) {
  const { colors } = useTheme();

  const filtered = useMemo(() => {
    if (!query) return MENTION_OPTIONS;
    const q = query.toLowerCase();
    return MENTION_OPTIONS.filter(
      (o) =>
        o.trigger.toLowerCase().includes(q) ||
        o.label.toLowerCase().includes(q)
    );
  }, [query]);

  if (filtered.length === 0) return null;

  return (
    <View style={[styles.container, { backgroundColor: colors.surfaceHigh, borderColor: colors.borderLight }]}>
      {filtered.map((option) => (
        <Pressable
          key={option.trigger}
          style={({ pressed }) => [
            styles.option,
            { backgroundColor: pressed ? withAlpha(option.color, 0.1) : 'transparent' },
          ]}
          onPress={() => onSelect(option.trigger)}
        >
          <View style={[styles.iconWrap, { backgroundColor: withAlpha(option.color, 0.12) }]}>
            <MaterialIcons name={option.icon} size={14} color={option.color} />
          </View>
          <View style={styles.textWrap}>
            <Text style={[styles.trigger, { color: option.color }]}>{option.trigger}</Text>
            <Text style={[styles.desc, { color: colors.inactive }]}>{option.description}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

export const MentionDropdown = memo(MentionDropdownInner);

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 8,
    marginHorizontal: 8,
    marginBottom: 4,
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  iconWrap: {
    width: 26,
    height: 26,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  trigger: {
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  desc: {
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
  },
});
