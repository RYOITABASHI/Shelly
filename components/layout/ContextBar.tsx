// components/layout/ContextBar.tsx
import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import { useTerminalStore } from '@/store/terminal-store';
import { execCommand } from '@/hooks/use-native-exec';
import { getHomePath } from '@/lib/home-path';
import { neonTextGlow, neonDotGlow } from '@/lib/neon-glow';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

function truncatePath(path: string, maxLen = 30): string {
  if (path.length <= maxLen) return path;
  const home = getHomePath();
  const short = path.startsWith(home) ? '~' + path.slice(home.length) : path;
  if (short.length <= maxLen) return short;
  return '...' + short.slice(short.length - maxLen + 3);
}

export function ContextBar() {
  const session = useTerminalStore((s) => {
    const active = s.sessions.find((sess) => sess.id === s.activeSessionId);
    return active;
  });

  const cwd = session?.currentDir ?? '~';
  const connectionMode = useTerminalStore((s) => s.connectionMode);

  const [gitBranch, setGitBranch] = useState<string | null>(null);
  useEffect(() => {
    execCommand(`cd '${cwd}' && git branch --show-current 2>/dev/null`)
      .then((r) => setGitBranch(r.exitCode === 0 ? r.stdout.trim() || null : null))
      .catch(() => setGitBranch(null));
  }, [cwd]);

  const handleCopyPath = () => {
    Clipboard.setStringAsync(cwd);
  };

  return (
    <View style={styles.bar}>
      {/* CWD */}
      <Pressable onPress={handleCopyPath} style={styles.segment} hitSlop={4}>
        <MaterialIcons name="folder" size={10} color={C.text2} />
        <Text style={styles.text} numberOfLines={1}>
          {truncatePath(cwd)}
        </Text>
      </Pressable>

      {/* Git branch */}
      {gitBranch && (
        <View style={[styles.segment, { marginLeft: 8 }]}>
          <MaterialIcons name="call-split" size={10} color={C.accent} />
          <Text style={[styles.text, { color: C.accent, ...neonTextGlow }]}>{gitBranch}</Text>
        </View>
      )}

      <View style={styles.spacer} />

      {/* Tagline */}
      <Text style={styles.tagline}>
        BUILDING A TERMINAL IDE ON ANDROID WITH REACT NATIVE
      </Text>

      <View style={styles.spacer} />

      {/* Connection status */}
      <View style={styles.segment}>
        <View style={[styles.dot, {
          backgroundColor: connectionMode === 'native' ? C.accent : C.errorText,
        }, connectionMode === 'native' && neonDotGlow]} />
        <Text style={styles.text}>
          {connectionMode === 'native' ? 'Native' : 'Off'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: S.contextBarHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    borderTopWidth: S.borderWidth,
    borderTopColor: C.border,
    backgroundColor: C.bgSidebar,
  },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  spacer: { flex: 1 },
  text: {
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    fontWeight: F.contextBar.weight,
    color: C.text2,
    letterSpacing: 0.3,
  },
  tagline: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: '600',
    color: C.text3,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
});
