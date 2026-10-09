import React, { memo, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { parseDiff, type DiffLineType } from '@/lib/diff-parser';
import { colors as C } from '@/theme.config';
import { createThemedStyles } from '@/lib/themed-stylesheet';
import { withAlpha } from '@/lib/theme-utils';


const getLineColors = (): Record<DiffLineType, { bg: string; fg: string }> => ({
  added:   { bg: withAlpha(C.accentGreen, 0.06), fg: C.addText },
  removed: { bg: withAlpha(C.errorText, 0.06), fg: C.errorText },
  context: { bg: 'transparent', fg: C.text2 },
  header:  { bg: C.bgSurface, fg: C.accentBlue },
  hunk:    { bg: withAlpha(C.accentPurple, 0.08), fg: C.accentPurple },
});

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
              color={C.text2}
            />
            <Text style={styles.filename} numberOfLines={1}>{file.filename}</Text>
            <Text style={styles.fileStats}>
              <Text style={{ color: C.addText }}>+{file.additions}</Text>
              {' '}
              <Text style={{ color: C.errorText }}>-{file.deletions}</Text>
            </Text>
          </Pressable>

          {/* Diff lines */}
          {expandedFiles.has(fi) && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={styles.diffLines}>
                {file.lines.map((line, li) => {
                  const colors = getLineColors()[line.type];
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

const styles = createThemedStyles(() => ({
  container: {
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: C.border,
    marginTop: 4,
  },
  summaryBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: C.bgSurface,
    borderBottomWidth: 1,
    borderBottomColor: C.bgSurface,
  },
  summaryText: {
    color: C.text2,
    fontSize: 11,
    flex: 1,
  },
  addCount: {
    color: C.addText,
    fontSize: 11,
    fontWeight: '600',
  },
  delCount: {
    color: C.errorText,
    fontSize: 11,
    fontWeight: '600',
  },
  aiSummary: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: withAlpha(C.accentPurple, 0.08),
    borderBottomWidth: 1,
    borderBottomColor: withAlpha(C.accentPurple, 0.13),
  },
  aiLabel: {
    color: C.accentPurple,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  aiText: {
    color: C.accentPurple,
    fontSize: 11,
    lineHeight: 16,
  },
  fileBlock: {
    borderBottomWidth: 1,
    borderBottomColor: C.bgSurface,
  },
  fileHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: C.bgSurface,
  },
  filename: {
    color: C.accentBlue,
    fontSize: 12,
    flex: 1,
  },
  fileStats: {
    fontSize: 10,
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
    textAlign: 'center',
  },
  lineText: {
    fontSize: 11,
    flex: 1,
  },
}));
