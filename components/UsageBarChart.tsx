// components/UsageBarChart.tsx
import React from 'react';
import { colors as C } from '@/theme.config';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import type { DailyUsage } from '@/lib/usage-parser';

const CHART_HEIGHT = 48;
const BAR_GAP = 4;

const TODAY_COLOR = '#FFD700';
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return `${n}`;
}

export function UsageBarChart({ daily }: { daily: DailyUsage[] }) {
  const maxCost = Math.max(...daily.map(d => d.totalCost), 0.01);
  const barCount = daily.length;
  const todayIndex = barCount - 1;

  const totals = daily.reduce(
    (acc, d) => ({
      input: acc.input + d.inputTokens,
      output: acc.output + d.outputTokens,
      cache: acc.cache + d.cacheCreationTokens + d.cacheReadTokens,
    }),
    { input: 0, output: 0, cache: 0 }
  );

  return (
    <View style={styles.container}>
      <Svg width="100%" height={CHART_HEIGHT} viewBox={`0 0 ${barCount * 30} ${CHART_HEIGHT}`}>
        {daily.map((d, i) => {
          const barHeight = Math.max(2, (d.totalCost / maxCost) * (CHART_HEIGHT - 4));
          const x = i * 30 + BAR_GAP / 2;
          const width = 30 - BAR_GAP;
          const y = CHART_HEIGHT - barHeight;
          const fill = i === todayIndex ? TODAY_COLOR : C.accent;
          const opacity = i === todayIndex ? 0.85 : 0.5;
          return (
            <Rect
              key={d.date}
              x={x}
              y={y}
              width={width}
              height={barHeight}
              rx={2}
              fill={fill}
              opacity={opacity}
            />
          );
        })}
      </Svg>
      <View style={styles.labels}>
        {daily.map((d, i) => {
          const dayOfWeek = new Date(d.date + 'T12:00:00').getDay();
          const isToday = i === todayIndex;
          return (
            <Text
              key={d.date}
              style={[styles.dayLabel, isToday && styles.todayLabel]}
            >
              {isToday ? 'Today' : DAY_LABELS[dayOfWeek]}
            </Text>
          );
        })}
      </View>
      <View style={styles.footer}>
        <Text style={styles.footerText}>In: {formatTokens(totals.input)}</Text>
        <Text style={styles.footerText}>Out: {formatTokens(totals.output)}</Text>
        <Text style={styles.footerText}>Cache: {formatTokens(totals.cache)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { paddingTop: 4 },
  labels: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 4,
  },
  dayLabel: { fontSize: 9, color: '#666', fontFamily: 'monospace', textAlign: 'center', flex: 1 },
  todayLabel: { color: '#FFD700', fontWeight: 'bold' },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
    paddingHorizontal: 4,
  },
  footerText: { fontSize: 9, color: '#888', fontFamily: 'monospace' },
});
