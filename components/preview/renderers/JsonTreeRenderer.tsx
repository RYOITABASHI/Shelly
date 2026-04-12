import React, { memo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme } from '@/hooks/use-theme';

type Props = { content: string };

const JsonNode = memo(function JsonNode({ keyName, value, depth }: { keyName?: string; value: any; depth: number }) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(depth < 2);

  if (value === null) return <JsonLeaf keyName={keyName} value="null" color="#D946EF" />;
  if (typeof value === 'boolean') return <JsonLeaf keyName={keyName} value={String(value)} color="#D946EF" />;
  if (typeof value === 'number') return <JsonLeaf keyName={keyName} value={String(value)} color="#D946EF" />;
  if (typeof value === 'string') return <JsonLeaf keyName={keyName} value={`"${value}"`} color="#F59E0B" />;

  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((v: any, i: number) => [String(i), v]) : Object.entries(value);
  const bracket = isArray ? ['[', ']'] : ['{', '}'];

  return (
    <View style={{ paddingLeft: depth > 0 ? 16 : 0 }}>
      <TouchableOpacity onPress={() => setExpanded(!expanded)} activeOpacity={0.7}>
        <Text style={[styles.nodeText, { color: colors.foreground }]}>
          {keyName ? <Text style={{ color: '#3B82F6' }}>"{keyName}": </Text> : null}
          <Text style={{ color: colors.muted }}>{expanded ? bracket[0] : `${bracket[0]}...${bracket[1]} (${entries.length})`}</Text>
        </Text>
      </TouchableOpacity>
      {expanded && entries.map(([k, v]: [string, any]) => (
        <JsonNode key={k} keyName={isArray ? undefined : k} value={v} depth={depth + 1} />
      ))}
      {expanded && <Text style={[styles.nodeText, { color: colors.muted }]}>{bracket[1]}</Text>}
    </View>
  );
});

function JsonLeaf({ keyName, value, color }: { keyName?: string; value: string; color: string }) {
  return (
    <Text style={styles.nodeText}>
      {keyName ? <Text style={{ color: '#3B82F6' }}>"{keyName}": </Text> : null}
      <Text style={{ color }}>{value}</Text>
    </Text>
  );
}

export const JsonTreeRenderer = memo(function JsonTreeRenderer({ content }: Props) {
  const { colors } = useTheme();
  let parsed: any;
  try {
    parsed = JSON.parse(content);
  } catch {
    return <Text style={[styles.errorText, { color: colors.muted }]}>Invalid JSON</Text>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <JsonNode value={parsed} depth={0} />
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D0D0D' },
  content: { padding: 12 },
  nodeText: { fontFamily: 'Silkscreen', fontSize: 12, lineHeight: 20 },
  errorText: { fontFamily: 'Silkscreen', fontSize: 13, padding: 16 },
});
