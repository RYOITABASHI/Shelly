import React, { memo, useState, useCallback } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { colors as TC, fonts as F, sizes as S } from '@/theme.config';

type Props = {
  json: string;
};

// ─── Colors ───────────────────────────────────────────────────────────────────

const C = {
  key: '#56B6C2',
  string: '#E5C07B',
  number: TC.accent,
  boolean: '#C678DD',
  null: '#666666',
  bracket: '#ABB2BF',
  comma: '#ABB2BF',
  colon: '#ABB2BF',
  plain: '#ECEDEE',
  bg: '#0E0E0F',
  toggleBg: TC.border,
};

const INDENT_PX = 12;
const MAX_DEPTH = 5;
const COLLAPSE_THRESHOLD = 20;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countKeys(val: unknown): number {
  if (val === null || typeof val !== 'object') return 0;
  return Object.keys(val as object).length;
}

function isComplex(val: unknown): val is object {
  return val !== null && typeof val === 'object';
}

function defaultCollapsed(val: unknown): boolean {
  return countKeys(val) > COLLAPSE_THRESHOLD;
}

// ─── JsonNode ────────────────────────────────────────────────────────────────

type JsonNodeProps = {
  value: unknown;
  depth: number;
  isLast: boolean;
  nodeKey?: string;
};

const JsonNode = memo(function JsonNode({ value, depth, isLast, nodeKey }: JsonNodeProps) {
  const [collapsed, setCollapsed] = useState(() => defaultCollapsed(value));

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  const comma = isLast ? null : <Text style={styles.comma}>,</Text>;
  const keyPrefix = nodeKey !== undefined ? (
    <>
      <Text style={styles.key}>{JSON.stringify(nodeKey)}</Text>
      <Text style={styles.colon}>{': '}</Text>
    </>
  ) : null;
  const indent = depth * INDENT_PX;

  // ── Max depth exceeded ──
  if (depth >= MAX_DEPTH && isComplex(value)) {
    return (
      <View style={[styles.row, { marginLeft: indent }]}>
        {keyPrefix}
        <Text style={styles.ellipsis}>…</Text>
        {comma}
      </View>
    );
  }

  // ── Null ──
  if (value === null) {
    return (
      <View style={[styles.row, { marginLeft: indent }]}>
        {keyPrefix}
        <Text style={styles.null}>null</Text>
        {comma}
      </View>
    );
  }

  // ── Boolean ──
  if (typeof value === 'boolean') {
    return (
      <View style={[styles.row, { marginLeft: indent }]}>
        {keyPrefix}
        <Text style={styles.boolean}>{value ? 'true' : 'false'}</Text>
        {comma}
      </View>
    );
  }

  // ── Number ──
  if (typeof value === 'number') {
    return (
      <View style={[styles.row, { marginLeft: indent }]}>
        {keyPrefix}
        <Text style={styles.number}>{String(value)}</Text>
        {comma}
      </View>
    );
  }

  // ── String ──
  if (typeof value === 'string') {
    return (
      <View style={[styles.row, { marginLeft: indent }]}>
        {keyPrefix}
        <Text style={styles.string}>{JSON.stringify(value)}</Text>
        {comma}
      </View>
    );
  }

  // ── Array ──
  if (Array.isArray(value)) {
    const items = value as unknown[];
    const isEmpty = items.length === 0;
    const summary = `[${isEmpty ? '' : `${items.length} item${items.length !== 1 ? 's' : ''}`}]`;

    if (isEmpty) {
      return (
        <View style={[styles.row, { marginLeft: indent }]}>
          {keyPrefix}
          <Text style={styles.bracket}>{'[]'}</Text>
          {comma}
        </View>
      );
    }

    return (
      <View style={{ marginLeft: indent }}>
        <Pressable onPress={toggle} style={styles.toggleRow}>
          {keyPrefix}
          <View style={styles.toggleBadge}>
            <Text style={styles.toggleIcon}>{collapsed ? '▶' : '▼'}</Text>
            <Text style={styles.bracket}>{collapsed ? summary : '['}</Text>
          </View>
          {collapsed && comma}
        </Pressable>
        {!collapsed && (
          <>
            {items.map((item, i) => (
              <JsonNode
                key={i}
                value={item}
                depth={depth + 1}
                isLast={i === items.length - 1}
              />
            ))}
            <View style={styles.row}>
              <Text style={styles.bracket}>{']'}</Text>
              {comma}
            </View>
          </>
        )}
      </View>
    );
  }

  // ── Object ──
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    const isEmpty = entries.length === 0;
    const summary = `{${isEmpty ? '' : `${entries.length} key${entries.length !== 1 ? 's' : ''}`}}`;

    if (isEmpty) {
      return (
        <View style={[styles.row, { marginLeft: indent }]}>
          {keyPrefix}
          <Text style={styles.bracket}>{'{}'}</Text>
          {comma}
        </View>
      );
    }

    return (
      <View style={{ marginLeft: indent }}>
        <Pressable onPress={toggle} style={styles.toggleRow}>
          {keyPrefix}
          <View style={styles.toggleBadge}>
            <Text style={styles.toggleIcon}>{collapsed ? '▶' : '▼'}</Text>
            <Text style={styles.bracket}>{collapsed ? summary : '{'}</Text>
          </View>
          {collapsed && comma}
        </Pressable>
        {!collapsed && (
          <>
            {entries.map(([k, v], i) => (
              <JsonNode
                key={k}
                nodeKey={k}
                value={v}
                depth={depth + 1}
                isLast={i === entries.length - 1}
              />
            ))}
            <View style={styles.row}>
              <Text style={styles.bracket}>{'}'}</Text>
              {comma}
            </View>
          </>
        )}
      </View>
    );
  }

  // ── Fallback ──
  return (
    <View style={[styles.row, { marginLeft: indent }]}>
      {keyPrefix}
      <Text style={styles.plain}>{String(value)}</Text>
      {comma}
    </View>
  );
});

// ─── JsonTreeBlock ────────────────────────────────────────────────────────────

function JsonTreeBlock({ json }: Props) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Render raw text on parse failure
    return (
      <View style={styles.container}>
        <Text style={styles.raw}>{json}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <JsonNode value={parsed} depth={0} isLast />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    backgroundColor: C.bg,
    borderRadius: 6,
    padding: 10,
    marginVertical: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    marginVertical: 1,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    marginVertical: 1,
    paddingVertical: 1,
  },
  toggleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.toggleBg,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  toggleIcon: {
    color: C.bracket,
    fontSize: 8,
    marginRight: 4,
  },
  key: {
    color: C.key,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  colon: {
    color: C.colon,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  comma: {
    color: C.comma,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  string: {
    color: C.string,
    fontSize: 12,
    fontFamily: 'monospace',
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  number: {
    color: C.number,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  boolean: {
    color: C.boolean,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  null: {
    color: C.null,
    fontSize: 12,
    fontFamily: 'monospace',
    fontStyle: 'italic',
  },
  bracket: {
    color: C.bracket,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  ellipsis: {
    color: C.null,
    fontSize: 12,
    fontFamily: 'monospace',
    fontStyle: 'italic',
  },
  plain: {
    color: C.plain,
    fontSize: 12,
    fontFamily: 'monospace',
  },
  raw: {
    color: C.plain,
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
});

export default memo(JsonTreeBlock);
