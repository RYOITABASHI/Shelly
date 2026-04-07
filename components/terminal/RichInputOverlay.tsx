import React, { memo } from 'react';
import { Text, StyleSheet, View } from 'react-native';
import { tokenize, TOKEN_COLORS } from '@/lib/syntax-highlighter';

type Props = {
  /** Current text content of the TextInput being overlaid. */
  input: string;
  /** Must match the TextInput's fontSize exactly. */
  fontSize: number;
};

/**
 * RichInputOverlay
 *
 * A transparent, non-interactive overlay that renders syntax-highlighted text
 * on top of a TextInput. It must be absolutely positioned over the TextInput
 * with identical font/padding so the colored spans align with the real text.
 *
 * Usage (inside the same View that wraps the TextInput):
 *
 *   <View style={{ flex: 1, position: 'relative' }}>
 *     <TextInput style={inputStyle} value={text} ... />
 *     <RichInputOverlay input={text} fontSize={settings.fontSize} />
 *   </View>
 *
 * The TextInput's own text color should be set to 'transparent' when the
 * overlay is active, so only the colored spans are visible.
 */
const RichInputOverlay = memo(function RichInputOverlay({ input, fontSize }: Props) {
  const tokens = tokenize(input);
  const lineHeight = Math.round(fontSize * 1.4);

  return (
    <View
      style={styles.container}
      pointerEvents="none"
    >
      <Text
        style={[
          styles.text,
          {
            fontSize,
            lineHeight,
            // paddingHorizontal/paddingTop must match the TextInput's padding
            // defined in CommandInput's StyleSheet (.input rule):
            //   paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8
            paddingHorizontal: 10,
            paddingTop: 8,
            paddingBottom: 8,
          },
        ]}
        selectable={false}
      >
        {tokens.map((token, index) => (
          <Text
            key={index}
            style={{ color: TOKEN_COLORS[token.type] }}
          >
            {token.text}
          </Text>
        ))}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    // Sit above the TextInput but swallow no touches.
    zIndex: 10,
  },
  text: {
    fontFamily: 'monospace',
    // backgroundColor must stay transparent so the TextInput background shows through.
    backgroundColor: 'transparent',
    // Allow text to wrap exactly like the TextInput (multiline).
    flexWrap: 'wrap',
  },
});

export default RichInputOverlay;
