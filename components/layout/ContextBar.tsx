// components/layout/ContextBar.tsx
import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '@/lib/theme-engine';
import { useTerminalStore } from '@/store/terminal-store';
import { execCommand } from '@/hooks/use-native-exec';

function truncatePath(path: string, maxLen = 30): string {
  if (path.length <= maxLen) return path;
  const home = '/data/data/com.termux/files/home';
  const short = path.startsWith(home) ? '~' + path.slice(home.length) : path;
  if (short.length <= maxLen) return short;
  return '...' + short.slice(short.length - maxLen + 3);
}

export function ContextBar() {
  const theme = useTheme();
  const c = theme.colors;
  const session = useTerminalStore((s) => {
    const active = s.sessions.find((sess) => sess.id === s.activeSessionId);
    return active;
  });

  const cwd = session?.currentDir ?? '~';
  const connectionMode = useTerminalStore((s) => s.connectionMode);

  // Git branch detection
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
    <View style={[styles.bar, { backgroundColor: c.surface, borderTopColor: c.border }]}>
      {/* CWD */}
      <Pressable onPress={handleCopyPath} style={styles.segment} hitSlop={4}>
        <MaterialIcons name="folder" size={11} color={c.muted} />
        <Text style={[styles.text, { color: c.muted }]} numberOfLines={1}>
          {truncatePath(cwd)}
        </Text>
      </Pressable>

      {/* Git branch */}
      {gitBranch && (
        <View style={[styles.segment, { marginLeft: 8 }]}>
          <MaterialIcons name="call_split" size={11} color={c.accent} />
          <Text style={[styles.text, { color: c.accent }]}>{gitBranch}</Text>
        </View>
      )}

      <View style={styles.spacer} />

      {/* Connection status */}
      <View style={styles.segment}>
        <View style={[styles.dot, {
          backgroundColor: connectionMode === 'native' ? c.success : c.error,
        }]} />
        <Text style={[styles.text, { color: c.muted }]}>
          {connectionMode === 'native' ? 'Native' : 'Off'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    borderTopWidth: 1,
  },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  spacer: { flex: 1 },
  text: {
    fontSize: 10,
    fontFamily: 'monospace',
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
