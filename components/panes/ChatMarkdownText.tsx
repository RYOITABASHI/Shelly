/**
 * components/panes/ChatMarkdownText.tsx
 *
 * Renders AI pane assistant prose (the non-code segments from
 * splitFencedCode) with a small markdown subset — bold, italic, inline
 * code, headings and simple bullet / ordered lists — see
 * lib/chat-markdown.ts. Everything stays inside ONE selectable <Text> so
 * long-press selection / copy across lines keeps working exactly like the
 * previous plain-text render. Colors come from the live palette at render
 * time so preset swaps apply.
 */
import React, { useMemo } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { colors as C } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { parseChatMarkdown, type ChatSpan } from '@/lib/chat-markdown';

type Props = {
  text: string;
  style?: StyleProp<TextStyle>;
};

function renderSpans(spans: ChatSpan[], keyPrefix: string): React.ReactNode[] {
  return spans.map((span, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (span.kind) {
      case 'bold':
        return <Text key={key} style={{ fontWeight: '700' }}>{span.text}</Text>;
      case 'italic':
        return <Text key={key} style={{ fontStyle: 'italic' }}>{span.text}</Text>;
      case 'code':
        return (
          <Text
            key={key}
            style={{ color: C.accentCode, backgroundColor: withAlpha(C.accentCode, 0.12) }}
          >
            {span.text}
          </Text>
        );
      default:
        return span.text;
    }
  });
}

export function ChatMarkdownText({ text, style }: Props) {
  const lines = useMemo(() => parseChatMarkdown(text), [text]);
  return (
    <Text style={style} selectable>
      {lines.map((line, i) => {
        const key = `l${i}`;
        const nl = i < lines.length - 1 ? '\n' : '';
        switch (line.kind) {
          case 'heading':
            return (
              <Text key={key} style={{ fontWeight: '700' }}>
                {renderSpans(line.spans, key)}
                {nl}
              </Text>
            );
          case 'bullet':
            return (
              <Text key={key}>
                {'  '.repeat(line.indent)}
                <Text style={{ color: C.accent }}>{'• '}</Text>
                {renderSpans(line.spans, key)}
                {nl}
              </Text>
            );
          case 'ordered':
            return (
              <Text key={key}>
                {'  '.repeat(line.indent)}
                <Text style={{ color: C.accent }}>{`${line.marker} `}</Text>
                {renderSpans(line.spans, key)}
                {nl}
              </Text>
            );
          default:
            return (
              <Text key={key}>
                {renderSpans(line.spans, key)}
                {nl}
              </Text>
            );
        }
      })}
    </Text>
  );
}
