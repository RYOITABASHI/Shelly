# ccusage Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time Claude Code usage/cost visualization to Shelly's StatusIndicator with an expandable panel showing daily/monthly/5H-block summaries and a 7-day bar chart.

**Architecture:** Read Claude Code's JSONL journal files directly via bridge `readFile`/`listFiles` → parse in TypeScript → aggregate by date/block → display in StatusIndicator + expandable UsagePanel with react-native-svg bar chart. No ccusage CLI dependency at runtime.

**Tech Stack:** TypeScript, Zustand (with AsyncStorage persist), react-native-svg, expo-notifications, LayoutAnimation

**Spec:** `docs/superpowers/specs/2026-04-05-ccusage-integration-design.md`

---

### Task 1: Usage Parser — JSONL reader and aggregator

**Files:**
- Create: `lib/usage-parser.ts`

This is the core data layer. It reads JSONL files via bridge callbacks, parses entries, deduplicates, calculates costs, and aggregates into daily/monthly/block summaries.

- [ ] **Step 1: Create `lib/usage-parser.ts` with types and pricing table**

```typescript
// lib/usage-parser.ts

// ── Types ────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
}

export interface DailyUsage extends TokenUsage {
  date: string; // YYYY-MM-DD
}

export interface BlockUsage extends TokenUsage {
  blockStart: Date;
  blockEnd: Date;
  minutesRemaining: number;
}

export interface UsageData {
  daily: DailyUsage[];
  todayTotal: TokenUsage;
  monthTotal: TokenUsage;
  currentBlock: BlockUsage | null;
  lastUpdated: number;
}

// ── Pricing (USD per 1M tokens) ──────────────────────────────────────────────

const MODEL_PRICING: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-4-6':            { input: 15,   output: 75,  cacheWrite: 18.75, cacheRead: 1.50 },
  'claude-sonnet-4-6':          { input: 3,    output: 15,  cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-4-5-20251001':  { input: 0.80, output: 4,   cacheWrite: 1.00,  cacheRead: 0.08 },
};
const DEFAULT_PRICING = MODEL_PRICING['claude-sonnet-4-6'];

function getPricing(model: string) {
  // Try exact match, then prefix match (e.g. "claude-opus-4-6" matches "claude-opus-4-6-xxx")
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  for (const key of Object.keys(MODEL_PRICING)) {
    if (model.startsWith(key)) return MODEL_PRICING[key];
  }
  return DEFAULT_PRICING;
}

function calcCost(model: string, input: number, output: number, cacheWrite: number, cacheRead: number): number {
  const p = getPricing(model);
  return (input * p.input + output * p.output + cacheWrite * p.cacheWrite + cacheRead * p.cacheRead) / 1_000_000;
}

// ── Zero usage helper ────────────────────────────────────────────────────────

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0 };
}

// ── JSONL parsing ────────────────────────────────────────────────────────────

interface ParsedEntry {
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  requestId: string;
}

function parseJSONLContent(content: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== 'assistant' || !obj.message?.usage) continue;
      const u = obj.message.usage;
      entries.push({
        timestamp: obj.timestamp,
        model: obj.message.model || 'unknown',
        inputTokens: u.input_tokens || 0,
        outputTokens: u.output_tokens || 0,
        cacheCreationTokens: u.cache_creation_input_tokens || 0,
        cacheReadTokens: u.cache_read_input_tokens || 0,
        requestId: obj.requestId || `${obj.timestamp}-${Math.random()}`,
      });
    } catch { /* skip malformed lines */ }
  }
  return entries;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

function aggregateDaily(entries: ParsedEntry[]): DailyUsage[] {
  const byDate = new Map<string, { usage: TokenUsage; entries: ParsedEntry[] }>();

  for (const e of entries) {
    const date = e.timestamp.slice(0, 10); // YYYY-MM-DD
    if (!byDate.has(date)) byDate.set(date, { usage: zeroUsage(), entries: [] });
    const d = byDate.get(date)!;
    d.usage.inputTokens += e.inputTokens;
    d.usage.outputTokens += e.outputTokens;
    d.usage.cacheCreationTokens += e.cacheCreationTokens;
    d.usage.cacheReadTokens += e.cacheReadTokens;
    d.usage.totalCost += calcCost(e.model, e.inputTokens, e.outputTokens, e.cacheCreationTokens, e.cacheReadTokens);
  }

  return Array.from(byDate.entries())
    .map(([date, { usage }]) => ({ date, ...usage }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function aggregateBlock(entries: ParsedEntry[], now: Date): BlockUsage | null {
  // 5-hour blocks aligned to midnight UTC
  const msIn5h = 5 * 60 * 60 * 1000;
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const msSinceDayStart = now.getTime() - dayStart.getTime();
  const blockIndex = Math.floor(msSinceDayStart / msIn5h);
  const blockStart = new Date(dayStart.getTime() + blockIndex * msIn5h);
  const blockEnd = new Date(blockStart.getTime() + msIn5h);

  const blockEntries = entries.filter(e => {
    const t = new Date(e.timestamp).getTime();
    return t >= blockStart.getTime() && t < now.getTime();
  });

  if (blockEntries.length === 0) return null;

  const usage = zeroUsage();
  for (const e of blockEntries) {
    usage.inputTokens += e.inputTokens;
    usage.outputTokens += e.outputTokens;
    usage.cacheCreationTokens += e.cacheCreationTokens;
    usage.cacheReadTokens += e.cacheReadTokens;
    usage.totalCost += calcCost(e.model, e.inputTokens, e.outputTokens, e.cacheCreationTokens, e.cacheReadTokens);
  }

  const minutesRemaining = Math.max(0, Math.round((blockEnd.getTime() - now.getTime()) / 60000));

  return { ...usage, blockStart, blockEnd, minutesRemaining };
}

// ── Main entry point ─────────────────────────────────────────────────────────

export type ReadFileFn = (path: string) => Promise<string | null>;
export type ListFilesFn = (dir: string) => Promise<{ name: string; mtime?: number }[]>;

export async function parseUsage(
  readFile: ReadFileFn,
  listFiles: ListFilesFn,
): Promise<UsageData> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const sinceDate = monthStart < sevenDaysAgo ? monthStart : sevenDaysAgo;

  // Find all project dirs
  const claudeProjectsDir = `${process.env.HOME || '/data/data/com.termux/files/home'}/.claude/projects`;
  let projectDirs: { name: string }[];
  try {
    projectDirs = await listFiles(claudeProjectsDir);
  } catch {
    return { daily: [], todayTotal: zeroUsage(), monthTotal: zeroUsage(), currentBlock: null, lastUpdated: Date.now() };
  }

  // Collect all entries from recent JSONL files
  const allEntries: ParsedEntry[] = [];
  const seenRequestIds = new Set<string>();

  for (const dir of projectDirs) {
    const dirPath = `${claudeProjectsDir}/${dir.name}`;
    let files: { name: string; mtime?: number }[];
    try {
      files = await listFiles(dirPath);
    } catch { continue; }

    // Only read .jsonl files, skip old ones by mtime if available
    const jsonlFiles = files.filter(f => f.name.endsWith('.jsonl'));
    // If mtime available, skip files older than sinceDate
    const recentFiles = jsonlFiles.filter(f =>
      !f.mtime || f.mtime * 1000 > sinceDate.getTime()
    );

    for (const file of recentFiles) {
      try {
        const content = await readFile(`${dirPath}/${file.name}`);
        if (!content) continue;
        const entries = parseJSONLContent(content);
        for (const e of entries) {
          if (new Date(e.timestamp) < sinceDate) continue;
          if (seenRequestIds.has(e.requestId)) continue;
          seenRequestIds.add(e.requestId);
          allEntries.push(e);
        }
      } catch { continue; }
    }
  }

  // Aggregate
  const daily = aggregateDaily(allEntries);
  const todayStr = now.toISOString().slice(0, 10);
  const todayDaily = daily.find(d => d.date === todayStr);
  const todayTotal: TokenUsage = todayDaily
    ? { inputTokens: todayDaily.inputTokens, outputTokens: todayDaily.outputTokens, cacheCreationTokens: todayDaily.cacheCreationTokens, cacheReadTokens: todayDaily.cacheReadTokens, totalCost: todayDaily.totalCost }
    : zeroUsage();

  const monthStr = now.toISOString().slice(0, 7); // YYYY-MM
  const monthEntries = daily.filter(d => d.date.startsWith(monthStr));
  const monthTotal = monthEntries.reduce((acc, d) => ({
    inputTokens: acc.inputTokens + d.inputTokens,
    outputTokens: acc.outputTokens + d.outputTokens,
    cacheCreationTokens: acc.cacheCreationTokens + d.cacheCreationTokens,
    cacheReadTokens: acc.cacheReadTokens + d.cacheReadTokens,
    totalCost: acc.totalCost + d.totalCost,
  }), zeroUsage());

  // Last 7 days for chart (fill gaps with zero)
  const last7: DailyUsage[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().slice(0, 10);
    const existing = daily.find(x => x.date === dateStr);
    last7.push(existing || { date: dateStr, ...zeroUsage() });
  }

  const currentBlock = aggregateBlock(allEntries, now);

  return { daily: last7, todayTotal, monthTotal, currentBlock, lastUpdated: Date.now() };
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/usage-parser.ts
git commit -m "feat: add usage-parser for JSONL reading and cost aggregation"
```

---

### Task 2: Usage Store — Zustand state management

**Files:**
- Create: `store/usage-store.ts`
- Reference: `hooks/use-termux-bridge.ts` (readFile/listFiles API)

- [ ] **Step 1: Create `store/usage-store.ts`**

```typescript
// store/usage-store.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { UsageData, TokenUsage, parseUsage } from '@/lib/usage-parser';

interface AlertSettings {
  alertEnabled: boolean;
  alertBlockThreshold: number;   // 0-100
  alertDailyCostLimit: number;   // USD
}

interface UsageState extends AlertSettings {
  usageData: UsageData | null;
  isLoading: boolean;
  error: string | null;
  isExpanded: boolean;
  lastAlertedDate: string | null;   // prevent dup daily alerts
  lastAlertedBlock: string | null;  // prevent dup block alerts
}

interface UsageActions {
  refresh: (
    readFile: (path: string) => Promise<string | null>,
    listFiles: (dir: string) => Promise<{ name: string; mtime?: number }[]>,
  ) => Promise<void>;
  toggleExpanded: () => void;
  setAlertSettings: (s: Partial<AlertSettings>) => void;
  markAlerted: (type: 'daily' | 'block', id: string) => void;
}

const REFRESH_TTL_MS = 60_000; // 60s

export const useUsageStore = create<UsageState & UsageActions>()(
  persist(
    (set, get) => ({
      // State
      usageData: null,
      isLoading: false,
      error: null,
      isExpanded: false,
      alertEnabled: false,
      alertBlockThreshold: 80,
      alertDailyCostLimit: 10,
      lastAlertedDate: null,
      lastAlertedBlock: null,

      // Actions
      refresh: async (readFile, listFiles) => {
        const state = get();
        if (state.isLoading) return;
        if (state.usageData && Date.now() - state.usageData.lastUpdated < REFRESH_TTL_MS) return;

        set({ isLoading: true, error: null });
        try {
          const data = await parseUsage(readFile, listFiles);
          set({ usageData: data, isLoading: false });
        } catch (e: any) {
          set({ error: e.message || 'Failed to load usage', isLoading: false });
        }
      },

      toggleExpanded: () => set(s => ({ isExpanded: !s.isExpanded })),

      setAlertSettings: (s) => set(s),

      markAlerted: (type, id) => {
        if (type === 'daily') set({ lastAlertedDate: id });
        else set({ lastAlertedBlock: id });
      },
    }),
    {
      name: 'shelly-usage',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({
        usageData: s.usageData,
        alertEnabled: s.alertEnabled,
        alertBlockThreshold: s.alertBlockThreshold,
        alertDailyCostLimit: s.alertDailyCostLimit,
        lastAlertedDate: s.lastAlertedDate,
        lastAlertedBlock: s.lastAlertedBlock,
      }),
    }
  )
);
```

- [ ] **Step 2: Commit**

```bash
git add store/usage-store.ts
git commit -m "feat: add usage-store with Zustand persist and alert settings"
```

---

### Task 3: UsageBarChart — SVG bar chart component

**Files:**
- Create: `components/UsageBarChart.tsx`

- [ ] **Step 1: Create `components/UsageBarChart.tsx`**

```typescript
// components/UsageBarChart.tsx
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Rect, Line } from 'react-native-svg';
import type { DailyUsage } from '@/lib/usage-parser';

const CHART_HEIGHT = 48;
const BAR_GAP = 4;
const ACCENT = '#00D4AA';
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

  // Sum totals for footer
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
          const fill = i === todayIndex ? TODAY_COLOR : ACCENT;
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
      {/* Day labels */}
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
      {/* Token summary */}
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
```

- [ ] **Step 2: Commit**

```bash
git add components/UsageBarChart.tsx
git commit -m "feat: add UsageBarChart SVG component for 7-day cost chart"
```

---

### Task 4: UsagePanel — Expandable detail panel

**Files:**
- Create: `components/UsagePanel.tsx`

- [ ] **Step 1: Create `components/UsagePanel.tsx`**

```typescript
// components/UsagePanel.tsx
import React, { useEffect } from 'react';
import { View, Text, Pressable, LayoutAnimation, StyleSheet, Platform, UIManager } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useUsageStore } from '@/store/usage-store';
import { UsageBarChart } from '@/components/UsageBarChart';
import type { TokenUsage } from '@/lib/usage-parser';

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
  readFile: (path: string) => Promise<string | null>;
  listFiles: (dir: string) => Promise<{ name: string; mtime?: number }[]>;
}) {
  const { usageData, isLoading, isExpanded, refresh } = useUsageStore();

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
      {/* Header with refresh button */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Usage</Text>
        <Pressable
          onPress={() => {
            // Force refresh by clearing lastUpdated
            useUsageStore.setState(s => ({
              usageData: s.usageData ? { ...s.usageData, lastUpdated: 0 } : null,
            }));
            refresh(readFile, listFiles);
          }}
          hitSlop={8}
        >
          <MaterialIcons
            name="refresh"
            size={16}
            color={isLoading ? '#333' : '#666'}
          />
        </Pressable>
      </View>

      {/* 3 cards */}
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

      {/* Bar chart */}
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
    color: '#00D4AA',
    fontFamily: 'monospace',
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
  cardLabel: { fontSize: 9, color: '#666', fontFamily: 'monospace' },
  cardValue: { fontSize: 20, fontWeight: 'bold', fontFamily: 'monospace', marginVertical: 2 },
  cardSub: { fontSize: 9, color: '#888', fontFamily: 'monospace' },
});
```

- [ ] **Step 2: Commit**

```bash
git add components/UsagePanel.tsx
git commit -m "feat: add UsagePanel expandable component with 3 cards + chart"
```

---

### Task 5: UsageIndicator — StatusIndicator inline badge

**Files:**
- Create: `components/UsageIndicator.tsx`

- [ ] **Step 1: Create `components/UsageIndicator.tsx`**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add components/UsageIndicator.tsx
git commit -m "feat: add UsageIndicator badge for StatusIndicator"
```

---

### Task 6: Integrate into StatusIndicator + layout

**Files:**
- Modify: `components/StatusIndicator.tsx`
- Modify: `app/(tabs)/_layout.tsx` (or wherever StatusIndicator is rendered — need to add UsagePanel below it)

- [ ] **Step 1: Add UsageIndicator to StatusIndicator.tsx**

In `components/StatusIndicator.tsx`, add the usage badge after the LLM label section (before closing `</View>`):

```typescript
// Add import at top:
import { UsageIndicator } from '@/components/UsageIndicator';

// Add after the llmLabel block (line ~101), before the closing </View>:
      <Text style={styles.separator}>·</Text>
      <UsageIndicator />
```

- [ ] **Step 2: Add UsagePanel below StatusIndicator in the tab layout**

Find where `<StatusIndicator />` is rendered in the Chat and Terminal tabs. Add `<UsagePanel>` directly below it, passing the bridge's `readFile` and `listFiles` as props.

The bridge adapter functions need to wrap `useTermuxBridge()` outputs to match the parser's expected signatures:

```typescript
// In the parent component that renders StatusIndicator:
import { UsagePanel } from '@/components/UsagePanel';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { useUsageStore } from '@/store/usage-store';

// Inside the component:
const { readFile: bridgeReadFile, listFiles: bridgeListFiles, isConnected } = useTermuxBridge();

const readFileAdapter = async (path: string): Promise<string | null> => {
  const result = await bridgeReadFile(path, 'utf8');
  return result.ok ? result.content : null;
};

const listFilesAdapter = async (dir: string): Promise<{ name: string; mtime?: number }[]> => {
  const result = await bridgeListFiles(dir, { includeHidden: true });
  if (!result.ok) return [];
  return result.entries.map((e: any) => ({ name: e.name, mtime: e.mtime }));
};

// Trigger refresh on mount / foreground resume:
const { refresh } = useUsageStore();
useEffect(() => {
  if (isConnected) refresh(readFileAdapter, listFilesAdapter);
}, [isConnected]);

// In JSX, after <StatusIndicator />:
<UsagePanel readFile={readFileAdapter} listFiles={listFilesAdapter} />
```

- [ ] **Step 3: Add LayoutAnimation to toggle**

In `UsagePanel.tsx`, trigger LayoutAnimation when `isExpanded` changes:

```typescript
useEffect(() => {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
}, [isExpanded]);
```

- [ ] **Step 4: Commit**

```bash
git add components/StatusIndicator.tsx app/\(tabs\)/index.tsx app/\(tabs\)/terminal.tsx
git commit -m "feat: integrate UsageIndicator + UsagePanel into StatusIndicator"
```

---

### Task 7: Usage Alerts in Settings

**Files:**
- Modify: `app/(tabs)/settings.tsx`

- [ ] **Step 1: Add Usage Alerts section to settings.tsx**

After the "Sound" section (~line 829), add a new section:

```tsx
<SectionHeader title="Usage Alerts" subtitle="Claude Code cost notifications" />
<View style={styles.settingRow}>
  <View style={{ flex: 1 }}>
    <Text style={styles.settingLabel}>Enable usage alerts</Text>
    <Text style={styles.settingHint}>Notify when cost thresholds are exceeded</Text>
  </View>
  <Switch
    value={usageAlertEnabled}
    onValueChange={(v) => useUsageStore.getState().setAlertSettings({ alertEnabled: v })}
    trackColor={{ false: '#333', true: '#00D4AA44' }}
    thumbColor={usageAlertEnabled ? '#00D4AA' : '#666'}
  />
</View>

{usageAlertEnabled && (
  <>
    <View style={styles.settingRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.settingLabel}>Daily cost limit</Text>
        <Text style={styles.settingHint}>Alert when today's cost exceeds this amount</Text>
      </View>
      <TextInput
        style={[styles.wsUrlInput, { width: 80, textAlign: 'center' }]}
        value={`$${dailyCostLimit}`}
        onChangeText={(v) => {
          const num = parseFloat(v.replace('$', ''));
          if (!isNaN(num)) useUsageStore.getState().setAlertSettings({ alertDailyCostLimit: num });
        }}
        keyboardType="numeric"
        placeholderTextColor="#3D4451"
      />
    </View>
  </>
)}
```

- [ ] **Step 2: Wire alert check into refresh cycle**

In `store/usage-store.ts`, after `set({ usageData: data, isLoading: false })`, add alert checking:

```typescript
// Check alerts
const state = get();
if (state.alertEnabled && data) {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (data.todayTotal.totalCost > state.alertDailyCostLimit && state.lastAlertedDate !== todayStr) {
    set({ lastAlertedDate: todayStr });
    // Fire notification (import from command-notifier pattern)
    sendUsageAlert(`Daily cost $${data.todayTotal.totalCost.toFixed(2)} exceeded $${state.alertDailyCostLimit} limit`);
  }
}
```

- [ ] **Step 3: Create `sendUsageAlert` helper** using existing `expo-notifications` pattern from `lib/command-notifier.ts`:

```typescript
// Add to lib/usage-parser.ts or a small lib/usage-alert.ts:
import * as Notifications from 'expo-notifications';

export async function sendUsageAlert(body: string) {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Shelly — Usage Alert',
      body,
      sound: 'default',
    },
    trigger: null, // immediate
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add app/\(tabs\)/settings.tsx store/usage-store.ts lib/usage-alert.ts
git commit -m "feat: add usage alert settings and notification trigger"
```

---

### Task 8: Foreground resume trigger + final polish

**Files:**
- Modify: `app/(tabs)/index.tsx` or `app/(tabs)/_layout.tsx`

- [ ] **Step 1: Add AppState listener for foreground resume**

```typescript
import { AppState } from 'react-native';

useEffect(() => {
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active' && isConnected) {
      // Clear TTL to force refresh
      useUsageStore.setState(s => ({
        usageData: s.usageData ? { ...s.usageData, lastUpdated: 0 } : null,
      }));
      useUsageStore.getState().refresh(readFileAdapter, listFilesAdapter);
    }
  });
  return () => sub.remove();
}, [isConnected]);
```

- [ ] **Step 2: Commit**

```bash
git add app/\(tabs\)/index.tsx
git commit -m "feat: refresh usage on foreground resume"
```

---

### Task 9: Build, test, commit all

- [ ] **Step 1: TypeScript check**

```bash
cd ~/Shelly && npx tsc --noEmit 2>&1 | grep -v "expo-modules-core"
```

Expected: No new errors.

- [ ] **Step 2: Push and trigger CI build**

```bash
cd ~/Shelly && git push origin main
```

- [ ] **Step 3: Download APK from CI and install for manual testing**

Verify:
- StatusIndicator shows `$X.XX` badge
- Tapping badge expands/collapses UsagePanel
- 3 cards show correct data (Today/Month/5H Block)
- 7-day bar chart renders with correct bars
- Refresh button updates data
- Settings → Usage Alerts toggle works
