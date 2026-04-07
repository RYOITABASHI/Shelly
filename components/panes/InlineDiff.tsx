/**
 * components/panes/InlineDiff.tsx
 *
 * Renders unified diff blocks from AI message content with syntax highlighting
 * and per-hunk Accept / Reject controls.
 *
 * Parses:
 *   - ```diff … ``` fenced blocks
 *   - Raw unified diff lines starting with ---, +++, @@
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ToastAndroid,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';

// ─── Types ────────────────────────────────────────────────────────────────────

export type DiffLine = {
  text: string;
  type: 'add' | 'remove' | 'context' | 'header';
  lineNum?: number;
};

export type DiffHunk = {
  header: string;       // @@ line
  lines: DiffLine[];
  status: 'pending' | 'accepted' | 'rejected';
};

type Segment =
  | { kind: 'text'; content: string }
  | { kind: 'diff'; hunks: DiffHunk[]; rawBlock: string };

// ─── Parsing ─────────────────────────────────────────────────────────────────

function parseDiffLines(rawLines: string[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let addNum = 0;
  let removeNum = 0;

  for (const raw of rawLines) {
    // Skip file header lines for hunk grouping but add them to current hunk
    if (raw.startsWith('---') || raw.startsWith('+++')) {
      if (current) {
        current.lines.push({ text: raw, type: 'header' });
      }
      continue;
    }

    if (raw.startsWith('@@')) {
      // Start new hunk
      if (current) hunks.push(current);
      // Parse @@ -a,b +c,d @@ to get starting line numbers
      const match = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      removeNum = match ? parseInt(match[1], 10) - 1 : 0;
      addNum = match ? parseInt(match[2], 10) - 1 : 0;
      current = { header: raw, lines: [], status: 'pending' };
      continue;
    }

    if (!current) {
      // Lines before first @@ — create an implicit hunk
      current = { header: '', lines: [], status: 'pending' };
    }

    if (raw.startsWith('+')) {
      addNum++;
      current.lines.push({ text: raw, type: 'add', lineNum: addNum });
    } else if (raw.startsWith('-')) {
      removeNum++;
      current.lines.push({ text: raw, type: 'remove', lineNum: removeNum });
    } else {
      // Context line (space or empty)
      addNum++;
      removeNum++;
      current.lines.push({ text: raw, type: 'context', lineNum: addNum });
    }
  }

  if (current) hunks.push(current);
  return hunks;
}

function parseContent(content: string): Segment[] {
  const segments: Segment[] = [];
  // Match fenced ```diff ... ``` blocks (multiline)
  const fenceRe = /```diff\s*\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(content)) !== null) {
    // Text before this diff block
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index);
      if (textBefore) segments.push({ kind: 'text', content: textBefore });
    }

    const rawBlock = match[1];
    const lines = rawBlock.split('\n');
    const hunks = parseDiffLines(lines);
    if (hunks.length > 0) {
      segments.push({ kind: 'diff', hunks, rawBlock });
    } else {
      segments.push({ kind: 'text', content: match[0] });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last diff block — check for raw unified diff lines
  const remaining = content.slice(lastIndex);
  if (remaining) {
    const rawLines = remaining.split('\n');
    const hasDiffLines = rawLines.some(
      (l) => l.startsWith('@@') || (l.startsWith('---') && rawLines.some((r) => r.startsWith('+++'))),
    );
    if (hasDiffLines) {
      const hunks = parseDiffLines(rawLines);
      if (hunks.length > 0) {
        segments.push({ kind: 'diff', hunks, rawBlock: remaining });
      } else {
        segments.push({ kind: 'text', content: remaining });
      }
    } else {
      segments.push({ kind: 'text', content: remaining });
    }
  }

  return segments;
}

// Build the "accepted" (patched) content from a hunk: lines that are context or added
function hunkPatchedContent(hunk: DiffHunk): string {
  return hunk.lines
    .filter((l) => l.type === 'add' || l.type === 'context')
    .map((l) => (l.type === 'add' ? l.text.slice(1) : l.text.replace(/^ /, '')))
    .join('\n');
}

// ─── Line colours ─────────────────────────────────────────────────────────────

const LINE_COLORS: Record<DiffLine['type'], { bg: string; fg: string }> = {
  add:     { bg: '#1a3a1a', fg: '#7ec87e' },
  remove:  { bg: '#3a1a1a', fg: '#e07070' },
  header:  { bg: '#1a2a3a', fg: '#5fc8d8' },
  context: { bg: '#111111', fg: '#cccccc' },
};

// ─── DiffLineRow ──────────────────────────────────────────────────────────────

const DiffLineRow = React.memo(function DiffLineRow({ line }: { line: DiffLine }) {
  const { bg, fg } = LINE_COLORS[line.type];
  const gutterNum = line.lineNum != null ? String(line.lineNum).padStart(3, ' ') : '   ';

  return (
    <View style={[rowStyles.row, { backgroundColor: bg }]}>
      <Text style={rowStyles.gutter} selectable={false}>
        {gutterNum}
      </Text>
      <Text style={[rowStyles.code, { color: fg }]} selectable>
        {line.text}
      </Text>
    </View>
  );
});

const rowStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    paddingVertical: 1,
    paddingHorizontal: 4,
  },
  gutter: {
    width: 30,
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#555',
    marginRight: 6,
    textAlign: 'right',
  },
  code: {
    flex: 1,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 17,
  },
});

// ─── HunkBlock ────────────────────────────────────────────────────────────────

type HunkBlockProps = {
  hunk: DiffHunk;
  index: number;
  onAccept: (index: number) => void;
  onReject: (index: number) => void;
};

const HunkBlock = React.memo(function HunkBlock({
  hunk,
  index,
  onAccept,
  onReject,
}: HunkBlockProps) {
  const handleAccept = useCallback(() => onAccept(index), [index, onAccept]);
  const handleReject = useCallback(() => onReject(index), [index, onReject]);

  if (hunk.status === 'rejected') {
    return (
      <View style={hunkStyles.rejectedContainer}>
        <Text style={hunkStyles.rejectedBadge}>{'REJECTED'}</Text>
      </View>
    );
  }

  return (
    <View style={hunkStyles.container}>
      {/* Header line */}
      {hunk.header ? (
        <View style={[hunkStyles.headerRow, { backgroundColor: LINE_COLORS.header.bg }]}>
          <Text style={[hunkStyles.headerText, { color: LINE_COLORS.header.fg }]} selectable>
            {hunk.header}
          </Text>
        </View>
      ) : null}

      {/* Diff lines */}
      {hunk.lines.map((line, i) => (
        <DiffLineRow key={i} line={line} />
      ))}

      {/* Accept / Reject pill buttons */}
      {hunk.status === 'pending' && (
        <View style={hunkStyles.actions}>
          <TouchableOpacity
            style={[hunkStyles.pill, hunkStyles.rejectPill]}
            onPress={handleReject}
            activeOpacity={0.7}
          >
            <Text style={[hunkStyles.pillText, hunkStyles.rejectPillText]}>{'Reject'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[hunkStyles.pill, hunkStyles.acceptPill]}
            onPress={handleAccept}
            activeOpacity={0.7}
          >
            <Text style={[hunkStyles.pillText, hunkStyles.acceptPillText]}>{'Accept'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {hunk.status === 'accepted' && (
        <View style={hunkStyles.actions}>
          <View style={[hunkStyles.pill, hunkStyles.acceptedPill]}>
            <Text style={[hunkStyles.pillText, hunkStyles.acceptedPillText]}>{'Copied'}</Text>
          </View>
        </View>
      )}
    </View>
  );
});

const hunkStyles = StyleSheet.create({
  container: {
    marginVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#333',
  },
  headerRow: {
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  headerText: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 6,
    padding: 6,
    backgroundColor: '#181818',
  },
  pill: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
  },
  pillText: {
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
  },
  acceptPill: {
    backgroundColor: '#1a3a1a',
    borderColor: '#4a8a4a',
  },
  acceptPillText: {
    color: '#7ec87e',
  },
  rejectPill: {
    backgroundColor: '#2a1a1a',
    borderColor: '#6a3a3a',
  },
  rejectPillText: {
    color: '#e07070',
  },
  acceptedPill: {
    backgroundColor: '#1a3a1a',
    borderColor: '#4a8a4a',
  },
  acceptedPillText: {
    color: '#7ec87e',
  },
  rejectedContainer: {
    marginVertical: 2,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: '#1e1e1e',
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#333',
    alignSelf: 'flex-start',
  },
  rejectedBadge: {
    fontFamily: 'monospace',
    fontSize: 10,
    color: '#666',
    letterSpacing: 0.5,
  },
});

// ─── DiffBlock ────────────────────────────────────────────────────────────────

type DiffBlockProps = {
  initialHunks: DiffHunk[];
};

function DiffBlock({ initialHunks }: DiffBlockProps) {
  const [hunks, setHunks] = useState<DiffHunk[]>(initialHunks);

  const handleAccept = useCallback(async (index: number) => {
    const hunk = hunks[index];
    if (!hunk) return;
    const patched = hunkPatchedContent(hunk);
    await Clipboard.setStringAsync(patched);
    ToastAndroid.show('Copied to clipboard', ToastAndroid.SHORT);
    setHunks((prev) =>
      prev.map((h, i) => (i === index ? { ...h, status: 'accepted' } : h)),
    );
  }, [hunks]);

  const handleReject = useCallback((index: number) => {
    ToastAndroid.show('Rejected', ToastAndroid.SHORT);
    setHunks((prev) =>
      prev.map((h, i) => (i === index ? { ...h, status: 'rejected' } : h)),
    );
  }, []);

  const handleAcceptAll = useCallback(async () => {
    const pendingHunks = hunks.filter((h) => h.status === 'pending');
    const allPatched = pendingHunks.map(hunkPatchedContent).join('\n');
    await Clipboard.setStringAsync(allPatched);
    ToastAndroid.show('All hunks copied to clipboard', ToastAndroid.SHORT);
    setHunks((prev) =>
      prev.map((h) => (h.status === 'pending' ? { ...h, status: 'accepted' } : h)),
    );
  }, [hunks]);

  const handleRejectAll = useCallback(() => {
    ToastAndroid.show('All hunks rejected', ToastAndroid.SHORT);
    setHunks((prev) =>
      prev.map((h) => (h.status === 'pending' ? { ...h, status: 'rejected' } : h)),
    );
  }, []);

  const hasPending = hunks.some((h) => h.status === 'pending');
  const multipleHunks = hunks.length > 1;

  return (
    <View style={diffBlockStyles.container}>
      {/* Sticky header for multi-hunk blocks */}
      {multipleHunks && hasPending && (
        <View style={diffBlockStyles.stickyHeader}>
          <Text style={diffBlockStyles.stickyLabel}>
            {`${hunks.filter((h) => h.status === 'pending').length} hunk${hunks.filter((h) => h.status === 'pending').length !== 1 ? 's' : ''}`}
          </Text>
          <View style={diffBlockStyles.stickyActions}>
            <TouchableOpacity
              style={[hunkStyles.pill, diffBlockStyles.rejectAllPill]}
              onPress={handleRejectAll}
              activeOpacity={0.7}
            >
              <Text style={[hunkStyles.pillText, diffBlockStyles.rejectAllText]}>
                {'Reject All'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[hunkStyles.pill, diffBlockStyles.acceptAllPill]}
              onPress={handleAcceptAll}
              activeOpacity={0.7}
            >
              <Text style={[hunkStyles.pillText, diffBlockStyles.acceptAllText]}>
                {'Accept All'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {hunks.map((hunk, i) => (
        <HunkBlock
          key={i}
          hunk={hunk}
          index={i}
          onAccept={handleAccept}
          onReject={handleReject}
        />
      ))}
    </View>
  );
}

const diffBlockStyles = StyleSheet.create({
  container: {
    marginVertical: 4,
  },
  stickyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1c1c1c',
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#333',
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 4,
  },
  stickyLabel: {
    fontFamily: 'monospace',
    fontSize: 11,
    color: '#888',
  },
  stickyActions: {
    flexDirection: 'row',
    gap: 6,
  },
  acceptAllPill: {
    backgroundColor: '#1a3a1a',
    borderColor: '#4a8a4a',
  },
  acceptAllText: {
    color: '#7ec87e',
  },
  rejectAllPill: {
    backgroundColor: '#2a1a1a',
    borderColor: '#6a3a3a',
  },
  rejectAllText: {
    color: '#e07070',
  },
});

// ─── InlineDiff (public API) ───────────────────────────────────────────────────

type InlineDiffProps = {
  content: string;
};

/**
 * InlineDiff parses `content` for unified diff blocks (fenced ```diff``` or
 * raw unified diff lines) and renders them with coloured line backgrounds plus
 * per-hunk Accept / Reject controls.
 *
 * Non-diff text segments are rendered as plain monospace Text nodes.
 */
export default function InlineDiff({ content }: InlineDiffProps) {
  const segments = useMemo(() => parseContent(content), [content]);

  return (
    <ScrollView
      horizontal={false}
      showsVerticalScrollIndicator={false}
      style={inlineStyles.root}
    >
      {segments.map((seg, i) => {
        if (seg.kind === 'text') {
          return seg.content ? (
            <Text key={i} style={inlineStyles.plainText} selectable>
              {seg.content}
            </Text>
          ) : null;
        }
        return <DiffBlock key={i} initialHunks={seg.hunks} />;
      })}
    </ScrollView>
  );
}

const inlineStyles = StyleSheet.create({
  root: {
    flex: 1,
  },
  plainText: {
    fontFamily: 'monospace',
    fontSize: 13,
    color: '#cccccc',
    lineHeight: 18,
  },
});

// ─── Utility export ──────────────────────────────────────────────────────────

/**
 * Returns true if the string contains a parseable unified diff block.
 * Used by AIPane to decide whether to render InlineDiff vs plain Text.
 */
export function hasDiffContent(content: string): boolean {
  if (/```diff\s*\n[\s\S]*?```/.test(content)) return true;
  const lines = content.split('\n');
  return (
    lines.some((l) => l.startsWith('@@')) &&
    lines.some((l) => l.startsWith('---')) &&
    lines.some((l) => l.startsWith('+++'))
  );
}
