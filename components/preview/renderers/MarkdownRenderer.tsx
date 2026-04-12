import React, { memo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';

type Props = { content: string };

export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: Props) {
  const { colors } = useTheme();
  const mdStyles = {
    body: { color: colors.foreground, fontSize: 14, fontFamily: 'Silkscreen', lineHeight: 20 },
    heading1: { color: colors.foreground, fontSize: 20, fontWeight: '700' as const, marginVertical: 8 },
    heading2: { color: colors.foreground, fontSize: 17, fontWeight: '700' as const, marginVertical: 6 },
    heading3: { color: colors.foreground, fontSize: 15, fontWeight: '600' as const, marginVertical: 4 },
    code_inline: { backgroundColor: withAlpha(colors.foreground, 0.08), color: colors.accent, fontFamily: 'Silkscreen', fontSize: 13 },
    code_block: { backgroundColor: '#0D0D0D', color: '#E8E8E8', fontFamily: 'Silkscreen', fontSize: 12, padding: 10, borderRadius: 6 },
    fence: { backgroundColor: '#0D0D0D', color: '#E8E8E8', fontFamily: 'Silkscreen', fontSize: 12, padding: 10, borderRadius: 6 },
    link: { color: colors.accent },
    blockquote: { borderLeftColor: colors.accent, borderLeftWidth: 3, paddingLeft: 10, opacity: 0.85 },
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Markdown style={mdStyles}>{content}</Markdown>
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16 },
});
