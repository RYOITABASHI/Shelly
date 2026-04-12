// components/terminal/ClaudeSessionHeader.tsx
// Renders the Claude Code session header shown at the top of a terminal pane.
// Matches mock: CLAUDE CODE V2.1.92 / OPUS 4.6 (1M CONTEXT) · ~/SHELLY
//               progress bar + 42K / 1M TOKENS · ~$0.63
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';


type Props = {
  version?: string;
  model?: string;
  contextSize?: string;
  cwd?: string;
  tokensUsed?: string;
  tokensMax?: string;
  cost?: string;
  /** 0–1 ratio for the token usage bar */
  usageRatio?: number;
};

export function ClaudeSessionHeader({
  version = 'V2.1.92',
  model = 'OPUS 4.6 (1M CONTEXT)',
  cwd = '~/SHELLY',
  tokensUsed = '42K',
  tokensMax = '1M TOKENS',
  cost = '~$0.63',
  usageRatio = 0.042,
}: Props) {
  return (
    <View style={styles.container}>
      {/* Top line: name + version */}
      <View style={styles.topRow}>
        <Text style={styles.name}>CLAUDE CODE</Text>
        <Text style={styles.version}> {version}</Text>
      </View>

      {/* Second line: model + cwd */}
      <Text style={styles.modelLine}>
        {model} · {cwd}
      </Text>

      {/* Progress bar */}
      <View style={styles.progressOuter}>
        <View style={[styles.progressInner, { width: `${Math.min(usageRatio * 100, 100)}%` }]} />
        {/* Dot indicator */}
        <View style={[styles.progressDot, { left: `${Math.min(usageRatio * 100, 100)}%` }]} />
      </View>

      {/* Token usage line */}
      <Text style={styles.tokenLine}>
        {tokensUsed} / {tokensMax} · {cost}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#111',
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 8,
    marginTop: 8,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  name: {
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '800',
    color: C.text1,
    letterSpacing: 0.5,
  },
  version: {
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '600',
    color: C.text2,
  },
  modelLine: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '500',
    color: C.text2,
    marginTop: 2,
    letterSpacing: 0.3,
  },
  progressOuter: {
    height: 3,
    backgroundColor: C.border,
    borderRadius: 1.5,
    marginTop: 8,
    position: 'relative',
    overflow: 'visible',
  },
  progressInner: {
    height: 3,
    backgroundColor: C.accent,
    borderRadius: 1.5,
  },
  progressDot: {
    position: 'absolute',
    top: -3,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: C.accent,
    marginLeft: -4.5,
  },
  tokenLine: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
    color: C.text2,
    marginTop: 6,
    textAlign: 'right',
    letterSpacing: 0.3,
  },
});
