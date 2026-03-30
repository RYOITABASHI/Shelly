import React, { memo, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';

export type MentionOption = {
  trigger: string;
  label: string;
  descKey: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  color: string;
};

const MENTION_OPTIONS: MentionOption[] = [
  { trigger: '@claude',     label: 'Claude Code',  descKey: 'mention.claude_desc',      icon: 'code',           color: '#F59E0B' },
  { trigger: '@codex',      label: 'Codex',        descKey: 'mention.codex_desc',       icon: 'terminal',       color: '#6366F1' },
  { trigger: '@gemini',     label: 'Gemini',       descKey: 'mention.gemini_desc',      icon: 'travel-explore', color: '#3B82F6' },
  { trigger: '@cerebras',   label: 'Cerebras',     descKey: 'mention.cerebras_desc',    icon: 'auto-awesome',   color: '#A78BFA' },
  { trigger: '@local',      label: 'Local LLM',    descKey: 'mention.local_desc',       icon: 'memory',         color: '#8B5CF6' },
  { trigger: '@perplexity', label: 'Perplexity',   descKey: 'mention.perplexity_desc',  icon: 'search',         color: '#20B2AA' },
  { trigger: '@git',        label: 'Git Guide',    descKey: 'mention.git_desc',         icon: 'account-tree',   color: '#F97316' },
  { trigger: '@team',       label: 'Team Table',   descKey: 'mention.team_desc',        icon: 'groups',         color: '#EC4899' },
  { trigger: '@open',       label: 'Browser',      descKey: 'mention.browser_desc',     icon: 'open-in-browser', color: '#4ADE80' },
  { trigger: '@plan',       label: 'Plan Mode',    descKey: 'mention.plan_desc',        icon: 'checklist',       color: '#10B981' },
  { trigger: '@arena',      label: 'Arena Mode',   descKey: 'mention.arena_desc',       icon: 'compare-arrows',  color: '#F43F5E' },
  { trigger: '@actions',    label: 'GitHub Actions', descKey: 'mention.actions_desc',   icon: 'play-circle',     color: '#F97316' },
];

type Props = {
  query: string;
  onSelect: (trigger: string) => void;
};

function MentionDropdownInner({ query, onSelect }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

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
    <ScrollView
      style={[styles.container, { backgroundColor: colors.surfaceHigh, borderColor: colors.borderLight }]}
      keyboardShouldPersistTaps="always"
      nestedScrollEnabled
    >
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
            <Text style={[styles.desc, { color: colors.inactive }]} numberOfLines={1}>{t(option.descKey)}</Text>
          </View>
        </Pressable>
      ))}
    </ScrollView>
  );
}

export const MentionDropdown = memo(MentionDropdownInner);

const styles = StyleSheet.create({
  container: {
    borderWidth: 1,
    borderRadius: 8,
    marginHorizontal: 8,
    marginBottom: 4,
    maxHeight: 240,
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
