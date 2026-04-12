import React, { memo, useCallback } from 'react';
import { View, Text, StyleSheet, Linking, Pressable } from 'react-native';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

type Props = {
  content: string;
};

// ─── Inline Span Types ────────────────────────────────────────────────────────

type Span =
  | { type: 'text'; value: string }
  | { type: 'bold'; value: string }
  | { type: 'code'; value: string }
  | { type: 'link'; label: string; url: string };

// ─── Inline Parser ────────────────────────────────────────────────────────────

function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  // Matches: **bold**, `code`, [label](url)
  const pattern = /(\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      spans.push({ type: 'text', value: text.slice(last, match.index) });
    }
    if (match[2] !== undefined) {
      // **bold**
      spans.push({ type: 'bold', value: match[2] });
    } else if (match[3] !== undefined) {
      // `code`
      spans.push({ type: 'code', value: match[3] });
    } else if (match[4] !== undefined && match[5] !== undefined) {
      // [label](url)
      spans.push({ type: 'link', label: match[4], url: match[5] });
    }
    last = match.index + match[0].length;
  }

  if (last < text.length) {
    spans.push({ type: 'text', value: text.slice(last) });
  }

  return spans;
}

// ─── InlineSpan ───────────────────────────────────────────────────────────────

function InlineSpan({ span }: { span: Span }) {
  const handlePress = useCallback(() => {
    if (span.type === 'link') {
      Linking.openURL(span.url).catch(() => {});
    }
  }, [span]);

  switch (span.type) {
    case 'bold':
      return <Text style={styles.bold}>{span.value}</Text>;
    case 'code':
      return (
        <Text style={styles.inlineCode}>{span.value}</Text>
      );
    case 'link':
      return (
        <Text style={styles.link} onPress={handlePress}>
          {span.label}
        </Text>
      );
    default:
      return <Text style={styles.plain}>{span.value}</Text>;
  }
}

// ─── InlineText ───────────────────────────────────────────────────────────────

function InlineText({ text, style }: { text: string; style?: object }) {
  const spans = parseInline(text);
  return (
    <Text style={style}>
      {spans.map((span, i) => (
        <InlineSpan key={i} span={span} />
      ))}
    </Text>
  );
}

// ─── Line Parser ─────────────────────────────────────────────────────────────

type LineToken =
  | { type: 'h1'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'bullet'; text: string }
  | { type: 'ordered'; n: number; text: string }
  | { type: 'code_block_start' }
  | { type: 'code_block_end' }
  | { type: 'code_line'; text: string }
  | { type: 'blank' }
  | { type: 'paragraph'; text: string };

function tokenizeLine(line: string): LineToken {
  if (/^```/.test(line)) return line.trim() === '```' ? { type: 'code_block_end' } : { type: 'code_block_start' };
  if (/^# /.test(line)) return { type: 'h1', text: line.slice(2) };
  if (/^## /.test(line)) return { type: 'h2', text: line.slice(3) };
  if (/^[-*] /.test(line)) return { type: 'bullet', text: line.slice(2) };
  const ordMatch = line.match(/^(\d+)\. (.+)/);
  if (ordMatch) return { type: 'ordered', n: parseInt(ordMatch[1], 10), text: ordMatch[2] };
  if (line.trim() === '') return { type: 'blank' };
  return { type: 'paragraph', text: line };
}

// ─── MarkdownBlock ────────────────────────────────────────────────────────────

function MarkdownBlock({ content }: Props) {
  const lines = content.split('\n');

  type RenderedNode =
    | { kind: 'line'; key: string; token: LineToken; inBlock: boolean }
    | { kind: 'codeblock'; key: string; lines: string[] };

  const nodes: RenderedNode[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let blockStart = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const token = tokenizeLine(line);

    if (token.type === 'code_block_start') {
      inCodeBlock = true;
      codeLines = [];
      blockStart = i;
      continue;
    }

    if (token.type === 'code_block_end') {
      if (inCodeBlock) {
        nodes.push({ kind: 'codeblock', key: `cb-${blockStart}`, lines: codeLines });
        inCodeBlock = false;
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    nodes.push({ kind: 'line', key: `l-${i}`, token, inBlock: false });
  }

  // Unclosed code block
  if (inCodeBlock && codeLines.length > 0) {
    nodes.push({ kind: 'codeblock', key: `cb-eof`, lines: codeLines });
  }

  return (
    <View style={styles.container}>
      {nodes.map((node) => {
        if (node.kind === 'codeblock') {
          return (
            <View key={node.key} style={styles.codeBlock}>
              {node.lines.map((cl, ci) => (
                <Text key={ci} style={styles.codeBlockText}>
                  {cl}
                </Text>
              ))}
            </View>
          );
        }

        const { token } = node;

        switch (token.type) {
          case 'h1':
            return (
              <Text key={node.key} style={styles.h1}>
                {token.text}
              </Text>
            );
          case 'h2':
            return (
              <Text key={node.key} style={styles.h2}>
                {token.text}
              </Text>
            );
          case 'bullet':
            return (
              <View key={node.key} style={styles.listRow}>
                <Text style={styles.bullet}>{'• '}</Text>
                <InlineText text={token.text} style={styles.plain} />
              </View>
            );
          case 'ordered':
            return (
              <View key={node.key} style={styles.listRow}>
                <Text style={styles.bullet}>{token.n}. </Text>
                <InlineText text={token.text} style={styles.plain} />
              </View>
            );
          case 'blank':
            return <View key={node.key} style={styles.blank} />;
          case 'paragraph':
            return (
              <InlineText
                key={node.key}
                text={token.text}
                style={styles.plain}
              />
            );
          default:
            return null;
        }
      })}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const TEXT = '#ECEDEE';
const CODE_BG = C.border;
const MUTED = '#666';

const styles = StyleSheet.create({
  container: {
    gap: 2,
  },
  plain: {
    color: TEXT,
    fontSize: 13,
    lineHeight: 20,
    flexShrink: 1,
    flexWrap: 'wrap',
  },
  bold: {
    color: TEXT,
    fontSize: 13,
    fontWeight: '700',
  },
  inlineCode: {
    color: C.accent,
    fontSize: 12,
    fontFamily: 'monospace',
    backgroundColor: CODE_BG,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  link: {
    color: C.accent,
    fontSize: 13,
    textDecorationLine: 'underline',
  },
  h1: {
    color: C.accent,
    fontSize: 16,
    fontWeight: '700',
    marginTop: 6,
    marginBottom: 2,
    lineHeight: 22,
  },
  h2: {
    color: TEXT,
    fontSize: 14,
    fontWeight: '700',
    marginTop: 4,
    marginBottom: 2,
    lineHeight: 20,
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingLeft: 4,
  },
  bullet: {
    color: C.accent,
    fontSize: 13,
    lineHeight: 20,
    marginRight: 2,
  },
  codeBlock: {
    backgroundColor: CODE_BG,
    borderRadius: 6,
    padding: 10,
    marginVertical: 4,
  },
  codeBlockText: {
    color: TEXT,
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 18,
  },
  blank: {
    height: 6,
  },
});

export default memo(MarkdownBlock);
