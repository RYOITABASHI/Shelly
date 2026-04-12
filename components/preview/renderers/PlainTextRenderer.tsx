import React, { memo } from 'react';
import { ScrollView, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/use-theme';

type Props = { content: string };

export const PlainTextRenderer = memo(function PlainTextRenderer({ content }: Props) {
  const { colors } = useTheme();
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={[styles.text, { color: colors.foreground }]} selectable>{content}</Text>
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 12 },
  text: { fontFamily: 'Silkscreen', fontSize: 12, lineHeight: 18 },
});
