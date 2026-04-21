// components/layout/ContextBar.tsx
import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, StyleSheet, AppState } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import { useTerminalStore } from '@/store/terminal-store';
import { execCommand } from '@/hooks/use-native-exec';
import { getHomePath } from '@/lib/home-path';
import { neonTextGlow, neonDotGlow } from '@/lib/neon-glow';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';
import { usePanelBackground } from '@/hooks/use-panel-background';

function truncatePath(path: string, maxLen = 30): string {
  if (path.length <= maxLen) return path;
  const home = getHomePath();
  const short = path.startsWith(home) ? '~' + path.slice(home.length) : path;
  if (short.length <= maxLen) return short;
  return '...' + short.slice(short.length - maxLen + 3);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function ContextBar() {
  const connectionMode = useTerminalStore((s) => s.connectionMode);
  const home = getHomePath();
  const currentDir = useTerminalStore((s) => {
    const session = s.sessions.find((item) => item.id === s.activeSessionId);
    return session?.currentDir;
  });

  const [cwd, setCwd] = useState('~');
  const [gitBranch, setGitBranch] = useState<string | null>(null);

  useEffect(() => {
    setCwd(currentDir || home);
  }, [currentDir, home]);

  useEffect(() => {
    let active = true;
    const refreshBranch = async () => {
      try {
        const dir = currentDir || home;
        if (dir === home) {
          if (active) setGitBranch(null);
          return;
        }
        const r = await execCommand(`cd ${shellQuote(dir)} && git branch --show-current 2>/dev/null`);
        if (!active) return;
        if (r.exitCode !== 0) return;
        const branch = r.stdout.trim();
        setGitBranch(branch || null);
      } catch { /* ignore */ }
    };
    refreshBranch();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshBranch();
    });
    return () => {
      active = false;
      sub.remove();
    };
  }, [currentDir, home]);

  const handleCopyPath = () => {
    Clipboard.setStringAsync(cwd);
  };

  const barBg = usePanelBackground(C.bgSidebar);

  return (
    <View style={[styles.bar, { backgroundColor: barBg }]}>
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
