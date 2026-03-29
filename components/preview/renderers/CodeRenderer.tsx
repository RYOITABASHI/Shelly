import React, { memo } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { tokenizeLine, TOKEN_COLORS } from '@/lib/syntax-highlight';

type Props = {
  content: string;
  language: string;
  maxLines?: number;
};

export const CodeRenderer = memo(function CodeRenderer({ content, language, maxLines }: Props) {
  const { colors } = useTheme();
  const lines = content.split('\n');
  const displayLines = maxLines ? lines.slice(0, maxLines) : lines;
  const truncated = maxLines && lines.length > maxLines;
  const gutterWidth = String(displayLines.length).length * 9 + 16;

  return (
    <ScrollView style={styles.container} horizontal={false}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.codeBlock}>
          {displayLines.map((line, i) => {
            const tokens = tokenizeLine(line, language);
            return (
              <View key={i} style={styles.lineRow}>
                <Text style={[styles.lineNumber, { color: colors.muted, width: gutterWidth }]}>
                  {i + 1}
                </Text>
                <Text style={styles.lineContent}>
                  {tokens.map((token, j) => (
                    <Text key={j} style={{ color: TOKEN_COLORS[token.type] }}>
                      {token.text}
                    </Text>
                  ))}
                </Text>
              </View>
            );
          })}
          {truncated && (
            <Text style={[styles.truncatedNotice, { color: colors.muted }]}>
              ... truncated ({lines.length} total lines)
            </Text>
          )}
        </View>
      </ScrollView>
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D0D' },
  codeBlock: { padding: 8 },
  lineRow: { flexDirection: 'row', minHeight: 18 },
  lineNumber: {
    fontFamily: 'monospace', fontSize: 11, textAlign: 'right',
    paddingRight: 8, opacity: 0.5,
  },
  lineContent: { fontFamily: 'monospace', fontSize: 12, flex: 1 },
  truncatedNotice: { fontFamily: 'monospace', fontSize: 11, padding: 8, textAlign: 'center' },
});
