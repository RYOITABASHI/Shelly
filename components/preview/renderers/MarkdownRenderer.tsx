import React, { memo } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import Markdown from 'react-native-markdown-display';
import { getMarkdownInk } from '@/lib/markdown-theme';
import { useThemeVersion } from '@/lib/themed-stylesheet';
import { withAlpha } from '@/lib/theme-utils';
import { usePanelBackground } from '@/hooks/use-panel-background';

type Props = { content: string };

export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: Props) {
  // Live preset palette (hooks/use-theme is frozen to the dark seed).
  useThemeVersion();
  const colors = getMarkdownInk();
  const codeBg = usePanelBackground(colors.surface);
  const mdStyles = {
    body: { color: colors.foreground, fontSize: 14, fontFamily: 'JetBrainsMono_400Regular', lineHeight: 20 },
    heading1: { color: colors.foreground, fontSize: 20, fontWeight: '700' as const, marginVertical: 8 },
    heading2: { color: colors.foreground, fontSize: 17, fontWeight: '700' as const, marginVertical: 6 },
    heading3: { color: colors.foreground, fontSize: 15, fontWeight: '600' as const, marginVertical: 4 },
    code_inline: { backgroundColor: withAlpha(colors.foreground, 0.08), color: colors.foreground, fontFamily: 'JetBrainsMono_400Regular', fontSize: 13 },
    code_block: { backgroundColor: codeBg, color: colors.foreground, borderWidth: 1, borderColor: colors.border, fontFamily: 'JetBrainsMono_400Regular', fontSize: 12, padding: 10, borderRadius: 6 },
    fence: { backgroundColor: codeBg, color: colors.foreground, borderWidth: 1, borderColor: colors.border, fontFamily: 'JetBrainsMono_400Regular', fontSize: 12, padding: 10, borderRadius: 6 },
    link: { color: colors.accent },
    blockquote: { borderLeftColor: colors.accent, borderLeftWidth: 3, paddingLeft: 10, opacity: 0.85 },
    hr: { backgroundColor: colors.border },
    table: { borderColor: colors.border },
    th: { borderColor: colors.border },
    td: { borderColor: colors.border },
    tr: { borderColor: colors.border },
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
