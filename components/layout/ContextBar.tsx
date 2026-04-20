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

export function ContextBar() {
  const connectionMode = useTerminalStore((s) => s.connectionMode);
  const home = getHomePath();

  const [cwd, setCwd] = useState('~');
  const [gitBranch, setGitBranch] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    // bug #103: combine cwd + git branch into a single exec. The old
    // path spawned two subprocesses (fork + exec + pipe × 2) every 3 s
    // which, combined with Sidebar's polling, meant five or more
    // execSubprocess calls per interval. The UI thread spent more time
    // marshalling JNI call results than processing IME events, so user
    // keystrokes lagged visibly and first-char drops during paste
    // became reproducible.
    //
    // Merged form: read .shelly_cwd, then chain a `git branch` in the
    // same shell so we pay for one fork. Interval raised from 3 s to
    // 15 s — cwd only changes when the user runs `cd`, and git branch
    // changes only when they `git switch`/`checkout`, neither of which
    // needs 3-second visual latency. The explicit `refresh()` on mount
    // still hits immediately for first paint.
    const poll = async () => {
      try {
        const cmd = `cat '${home}/.shelly_cwd' 2>/dev/null; echo '---'; cd "$(cat '${home}/.shelly_cwd' 2>/dev/null || echo '${home}')" && git branch --show-current 2>/dev/null`;
        const r = await execCommand(cmd);
        if (!active) return;
        if (r.exitCode !== 0) return;
        const [cwdPart, branchPart = ''] = r.stdout.split('---\n');
        const dir = cwdPart.trim() || home;
        setCwd(dir);
        const branch = branchPart.trim();
        setGitBranch(branch || null);
      } catch { /* ignore */ }
    };
    // bug #103 (post-v41 review fix): genuinely pause the interval when
    // the app is backgrounded — the earlier revision left setInterval
    // running and only fired an extra poll on resume, so JNI
    // execSubprocess was still being spawned every 15 s in the background.
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (id === null) id = setInterval(poll, 15000); };
    const stop = () => { if (id !== null) { clearInterval(id); id = null; } };
    poll();
    start();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') { poll(); start(); }
      else { stop(); }
    });
    return () => {
      active = false;
      stop();
      sub.remove();
    };
  }, [home]);

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
