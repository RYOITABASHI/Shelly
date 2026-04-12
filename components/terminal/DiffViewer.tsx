import React, { memo, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { parseDiff, type DiffLineType } from '@/lib/diff-parser';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';


const LINE_COLORS: Record<DiffLineType, { bg: string; fg: string }> = {
  added:   { bg: '#4ADE8010', fg: '#86EFAC' },
  removed: { bg: '#F8717110', fg: '#FCA5A5' },
  context: { bg: 'transparent', fg: '#9BA1A6' },
  header:  { bg: '#1E1E1E', fg: '#60A5FA' },
  hunk:    { bg: '#1A1A2E', fg: '#A78BFA' },
};

type Props = {
  output: string;
  /** Optional AI summary of the diff */
  aiSummary?: string;
};

function DiffViewerInner({ output, aiSummary }: Props) {
  const files = parseDiff(output);
  const [expandedFiles, setExpandedFiles] = useState<Set<number>>(
    new Set(files.map((_, i) => i)), // All expanded by default
  );

  const toggleFile = useCallback((index: number) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }, []);

  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  return (
    <View style={styles.container}>
      {/* Summary bar */}
      <View style={styles.summaryBar}>
        <MaterialIcons name="difference" size={14} color={C.accent} />
        <Text style={styles.summaryText}>
          {files.length} file{files.length !== 1 ? 's' : ''}
        </Text>
        <Text style={styles.addCount}>+{totalAdd}</Text>
        <Text style={styles.delCount}>-{totalDel}</Text>
      </View>

      {/* AI Summary */}
      {aiSummary && (
        <View style={styles.aiSummary}>
          <Text style={styles.aiLabel}>AI Summary</Text>
          <Text style={styles.aiText}>{aiSummary}</Text>
        </View>
      )}

      {/* File diffs */}
      {files.map((file, fi) => (
        <View key={fi} style={styles.fileBlock}>
          {/* File header */}
          <Pressable style={styles.fileHeader} onPress={() => toggleFile(fi)}>
            <MaterialIcons
              name={expandedFiles.has(fi) ? 'expand-more' : 'chevron-right'}
              size={16}
              color="#6B7280"
            />
            <Text style={styles.filename} numberOfLines={1}>{file.filename}</Text>
            <Text style={styles.fileStats}>
              <Text style={{ color: '#86EFAC' }}>+{file.additions}</Text>
              {' '}
              <Text style={{ color: '#FCA5A5' }}>-{file.deletions}</Text>
            </Text>
          </Pressable>

          {/* Diff lines */}
          {expandedFiles.has(fi) && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.diffLines}>
                {file.lines.map((line, li) => {
                  const colors = LINE_COLORS[line.type];
                  return (
                    <View key={`${li}-${line.type}`} style={[styles.diffLine, { backgroundColor: colors.bg }]}>
                      <Text style={styles.lineMarker}>
                        {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                      </Text>
                      <Text style={[styles.lineText, { color: colors.fg }]} selectable>
                        {line.type === 'added' || line.type === 'removed'
                          ? line.text.slice(1)
                          : line.text}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </ScrollView>
          )}
        </View>
      ))}
    </View>
  );
}

export const DiffViewer = memo(DiffViewerInner);

const styles = StyleSheet.create({
  container: {
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#2A2A2A',
    marginTop: 4,
  },
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#111',
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
  },
  summaryText: {
    color: '#9BA1A6',
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
  },
  addCount: {
    color: '#86EFAC',
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  delCount: {
    color: '#FCA5A5',
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  aiSummary: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#1A1A2E',
    borderBottomWidth: 1,
    borderBottomColor: '#A78BFA22',
  },
  aiLabel: {
    color: '#A78BFA',
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  aiText: {
    color: '#C4B5FD',
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
  },
  fileBlock: {
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: '#141414',
  },
  filename: {
    color: '#60A5FA',
    fontSize: 12,
    fontFamily: 'monospace',
    flex: 1,
  },
  fileStats: {
    fontSize: 10,
    fontFamily: 'monospace',
  },
  diffLines: {
    minWidth: '100%',
  },
  diffLine: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    minHeight: 18,
  },
  lineMarker: {
    width: 14,
    color: C.text3,
    fontSize: 11,
    fontFamily: 'monospace',
    textAlign: 'center',
  },
  lineText: {
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
  },
});
