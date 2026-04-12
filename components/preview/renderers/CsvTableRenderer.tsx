import React, { memo } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';

type Props = { content: string; delimiter?: string };

export const CsvTableRenderer = memo(function CsvTableRenderer({ content, delimiter = ',' }: Props) {
  const { colors } = useTheme();
  const rows = content.split('\n').filter(Boolean).map((line) => line.split(delimiter));
  const header = rows[0] ?? [];
  const body = rows.slice(1);

  return (
    <ScrollView style={styles.container}>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          {/* Header */}
          <View style={[styles.row, { backgroundColor: withAlpha(colors.accent, 0.1) }]}>
            {header.map((cell, i) => (
              <Text key={i} style={[styles.cell, styles.headerCell, { color: colors.accent }]}>{cell.trim()}</Text>
            ))}
          </View>
          {/* Body */}
          {body.slice(0, 500).map((row, ri) => (
            <View key={ri} style={[styles.row, ri % 2 === 0 ? { backgroundColor: withAlpha(colors.foreground, 0.02) } : {}]}>
              {row.map((cell, ci) => (
                <Text key={ci} style={[styles.cell, { color: colors.foreground }]}>{cell.trim()}</Text>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#222' },
  cell: { fontFamily: 'Silkscreen', fontSize: 11, padding: 6, minWidth: 80, maxWidth: 200 },
  headerCell: { fontWeight: '600', fontSize: 11 },
});
