// components/UsagePanel.tsx
import React, { useEffect } from 'react';
import { colors as C } from '@/theme.config';
import { View, Text, Pressable, LayoutAnimation, StyleSheet, Platform, UIManager } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useUsageStore } from '@/store/usage-store';
import { UsageBarChart } from '@/components/UsageBarChart';
import type { TokenUsage, ReadFileFn, ListFilesFn } from '@/lib/usage-parser';

if (Platform.OS === 'android') {
  UIManager.setLayoutAnimationEnabledExperimental?.(true);
}

function formatCost(cost: number): string {
  if (cost >= 100) return `$${Math.round(cost)}`;
  if (cost >= 10) return `$${cost.toFixed(1)}`;
  return `$${cost.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K tok`;
  return `${n} tok`;
}

function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}

function UsageCard({ label, value, sub, borderColor }: {
  label: string; value: string; sub: string; borderColor: string;
}) {
  return (
    <View style={[styles.card, { borderColor: borderColor + '44' }]}>
      <Text style={styles.cardLabel}>{label}</Text>
      <Text style={[styles.cardValue, { color: borderColor }]}>{value}</Text>
      <Text style={styles.cardSub}>{sub}</Text>
    </View>
  );
}

export function UsagePanel({
  readFile,
  listFiles,
}: {
  readFile: ReadFileFn;
  listFiles: ListFilesFn;
}) {
  const { usageData, isLoading, isExpanded, refresh, forceRefresh } = useUsageStore();

  useEffect(() => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
  }, [isExpanded]);

  useEffect(() => {
    if (isExpanded) {
      refresh(readFile, listFiles);
    }
  }, [isExpanded]);

  if (!isExpanded || !usageData) return null;

  const { todayTotal, monthTotal, currentBlock, daily } = usageData;

  const blockValue = currentBlock
    ? `${currentBlock.minutesRemaining}m`
    : '--';
  const blockSub = currentBlock
    ? formatTokens(totalTokens(currentBlock))
    : 'No activity';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Usage</Text>
        <Pressable
          onPress={() => forceRefresh(readFile, listFiles)}
          hitSlop={8}
        >
          <MaterialIcons
            name="refresh"
            size={16}
            color={isLoading ? '#333' : '#666'}
          />
        </Pressable>
      </View>

      <View style={styles.cards}>
        <UsageCard
          label="TODAY"
          value={formatCost(todayTotal.totalCost)}
          sub={formatTokens(totalTokens(todayTotal))}
          borderColor="#00D4AA"
        />
        <UsageCard
          label="MONTH"
          value={formatCost(monthTotal.totalCost)}
          sub={formatTokens(totalTokens(monthTotal))}
          borderColor="#A78BFA"
        />
        <UsageCard
          label="5H LEFT"
          value={blockValue}
          sub={blockSub}
          borderColor="#FFD700"
        />
      </View>

      <UsageBarChart daily={daily} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#0A0A0A',
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
    paddingHorizontal: 16,
    paddingBottom: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  headerTitle: {
    fontSize: 11,
    color: C.accent,
    fontWeight: '600',
  },
  cards: {
    flexDirection: 'row',
    gap: 8,
  },
  card: {
    flex: 1,
    backgroundColor: '#111',
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    alignItems: 'center',
  },
  cardLabel: { fontSize: 9, color: '#666', fontFamily: 'Silkscreen' },
  cardValue: { fontSize: 20, fontWeight: 'bold', fontFamily: 'Silkscreen', marginVertical: 2 },
  cardSub: { fontSize: 9, color: '#888', fontFamily: 'Silkscreen' },
});
