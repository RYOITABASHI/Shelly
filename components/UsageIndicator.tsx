// components/UsageIndicator.tsx
import React from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';
import { useUsageStore } from '@/store/usage-store';

function getCostColor(cost: number): string {
  if (cost > 15) return '#FF6B6B';
  if (cost > 5) return '#FBBF24';
  return '#00D4AA';
}

export function UsageIndicator() {
  const { usageData, isLoading, toggleExpanded } = useUsageStore();

  let label: string;
  let color: string;

  if (isLoading && !usageData) {
    label = '...';
    color = '#666';
  } else if (!usageData) {
    label = '--';
    color = '#666';
  } else {
    const cost = usageData.todayTotal.totalCost;
    label = cost >= 10 ? `$${Math.round(cost)}` : `$${cost.toFixed(2)}`;
    color = getCostColor(cost);
  }

  return (
    <Pressable onPress={toggleExpanded} hitSlop={8}>
      <Text style={[styles.badge, { color }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  badge: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
});
