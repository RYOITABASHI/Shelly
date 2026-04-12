import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

type Props = {
  output: string;
};

type ParsedTable = {
  headers: string[];
  rows: string[][];
};

const NUMBER_PATTERN = /^-?[\d,._]+(%|ms|s|KB|MB|GB|TB|B)?$/i;

function isNumberLike(cell: string): boolean {
  return NUMBER_PATTERN.test(cell.trim());
}

function splitRow(line: string, separator: 'pipe' | 'tab'): string[] {
  if (separator === 'pipe') {
    // Remove leading/trailing pipes then split
    const stripped = line.replace(/^\s*\||\|\s*$/g, '');
    return stripped.split('|').map((c) => c.trim());
  }
  return line.split('\t').map((c) => c.trim());
}

function isSeparatorRow(line: string): boolean {
  // Matches rows like |---|---| or |:---:|---| or just dashes/colons/pipes/spaces
  return /^[\s|:\-]+$/.test(line);
}

function detectSeparator(lines: string[]): 'pipe' | 'tab' | null {
  const tableLines = lines.filter((l) => l.trim().length > 0);
  if (tableLines.length < 2) return null;

  const pipeCount = tableLines.filter((l) => l.includes('|')).length;
  const tabCount = tableLines.filter((l) => l.includes('\t')).length;

  if (pipeCount >= Math.ceil(tableLines.length * 0.6)) return 'pipe';
  if (tabCount >= Math.ceil(tableLines.length * 0.6)) return 'tab';
  return null;
}

function parseTable(output: string): ParsedTable | null {
  const lines = output
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);

  const separator = detectSeparator(lines);
  if (!separator) return null;

  const dataLines = lines.filter((l) => !isSeparatorRow(l));
  if (dataLines.length < 2) return null;

  const parsed = dataLines.map((l) => splitRow(l, separator));

  // Validate consistent column count (allow ±1 tolerance for trailing empties)
  const colCount = parsed[0].length;
  if (colCount < 2) return null;

  const consistent = parsed.every((row) => Math.abs(row.length - colCount) <= 1);
  if (!consistent) return null;

  // Normalise all rows to same column count
  const normalised = parsed.map((row) => {
    if (row.length < colCount) {
      return [...row, ...Array(colCount - row.length).fill('')];
    }
    return row.slice(0, colCount);
  });

  const [headers, ...rows] = normalised;
  if (!headers || headers.every((h) => h === '')) return null;

  return { headers, rows };
}

const TableBlock = memo(function TableBlock({ output }: Props) {
  const table = useMemo(() => parseTable(output), [output]);

  if (!table) return null;

  const { headers, rows } = table;
  const colCount = headers.length;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={true}
      style={styles.scrollView}
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.table}>
        {/* Header row */}
        <View style={styles.headerRow}>
          {headers.map((header, colIdx) => (
            <View
              key={colIdx}
              style={[
                styles.cell,
                styles.headerCell,
                colIdx < colCount - 1 && styles.cellBorderRight,
              ]}
            >
              <Text
                style={[
                  styles.cellText,
                  styles.headerText,
                  isNumberLike(header) && styles.numberCell,
                ]}
                numberOfLines={1}
              >
                {header}
              </Text>
            </View>
          ))}
        </View>

        {/* Data rows */}
        {rows.map((row, rowIdx) => (
          <View
            key={rowIdx}
            style={[
              styles.dataRow,
              { backgroundColor: rowIdx % 2 === 0 ? C.bgDeep : C.bgSurface },
            ]}
          >
            {row.map((cell, colIdx) => (
              <View
                key={colIdx}
                style={[
                  styles.cell,
                  colIdx < colCount - 1 && styles.cellBorderRight,
                ]}
              >
                <Text
                  style={[
                    styles.cellText,
                    isNumberLike(cell) && styles.numberCell,
                  ]}
                  numberOfLines={2}
                >
                  {cell}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  scrollView: {
    marginVertical: 8,
    marginHorizontal: 8,
  },
  scrollContent: {
    flexGrow: 1,
  },
  table: {
    borderWidth: 1,
    borderColor: '#2A2A2A',
    borderRadius: 6,
    overflow: 'hidden',
  },
  headerRow: {
    flexDirection: 'row',
    backgroundColor: C.border,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
  },
  dataRow: {
    flexDirection: 'row',
  },
  cell: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    minWidth: 60,
    justifyContent: 'center',
  },
  headerCell: {
    paddingVertical: 6,
  },
  cellBorderRight: {
    borderRightWidth: 1,
    borderRightColor: '#2A2A2A',
  },
  cellText: {
    fontFamily: 'monospace',
    fontSize: 12,
    color: '#BBBBBB',
    textAlign: 'left',
  },
  headerText: {
    color: C.accent,
    fontWeight: '700',
  },
  numberCell: {
    textAlign: 'right',
  },
});

export { TableBlock };
export default TableBlock;
