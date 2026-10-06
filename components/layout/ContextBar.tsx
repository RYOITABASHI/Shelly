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
import { canonicalizeAndroidDataPath, formatContextBarPath } from '@/lib/context-bar-path';

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
        if (canonicalizeAndroidDataPath(dir) === canonicalizeAndroidDataPath(home)) {
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
      <Pressable onPress={handleCopyPath} style={[styles.segment, styles.shrinkSegment]} hitSlop={4}>
        <MaterialIcons name="folder" size={10} color={C.text2} />
        <Text style={[styles.text, styles.shrinkText]} numberOfLines={1}>
          {formatContextBarPath(cwd, home)}
        </Text>
      </Pressable>

      {/* Git branch */}
      {gitBranch && (
        <View style={[styles.segment, styles.shrinkSegment, { marginLeft: 8 }]}>
          <MaterialIcons name="call-split" size={10} color={C.accent} />
          <Text
            style={[styles.text, styles.shrinkText, { color: C.accent, ...neonTextGlow }]}
            numberOfLines={1}
          >
            {gitBranch}
          </Text>
        </View>
      )}

      <View style={styles.spacer} />

      {/* Connection status — never shrinks; the cwd/branch segments give
          way first so the status label is always fully visible. */}
      <View style={[styles.segment, styles.fixedSegment]}>
        <View style={[styles.dot, {
          backgroundColor: connectionMode === 'native' ? C.accent : C.errorText,
        }, connectionMode === 'native' && neonDotGlow]} />
        {/* No numberOfLines here on purpose: this is a fixed short label
            that must never ellipsize — see styles.statusText. */}
        <Text style={[styles.text, styles.statusText]}>
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
    // 12dp keeps the right-hand status clear of the Fold6 inner display's
    // rounded bottom-right corner.
    paddingHorizontal: 12,
    borderTopWidth: S.borderWidth,
    borderTopColor: C.border,
    backgroundColor: C.bgSidebar,
  },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  shrinkSegment: {
    flexShrink: 1,
    minWidth: 0,
  },
  shrinkText: {
    flexShrink: 1,
  },
  fixedSegment: {
    flexShrink: 0,
    marginLeft: 8,
  },
  spacer: { flex: 1 },
  text: {
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    // No fontWeight: F.family is the single-weight JetBrainsMono_400Regular
    // face, so weight 500 can't be honoured — Android instead resolves a
    // synthetic/fallback face, and the measured run can come out narrower
    // than the drawn glyphs. That measure/draw mismatch is the most likely
    // source of the clipped "Nativ" that survived the letterSpacing removal
    // and, with numberOfLines={1}, became "Nat…" (2026-10-06, build 2459).
    color: C.text2,
    // No letterSpacing: on Android, letterSpacing on this custom mono font
    // under-measures the run by roughly one glyph, which clipped the last
    // character ("Nativ") and forced the short cwd into a bare ellipsis.
    // A 1dp trailing pad absorbs any remaining sub-pixel rounding.
    paddingRight: 1,
  },
  statusText: {
    flexShrink: 0,
    // Belt-and-braces floor: 6 monospace cells ("Native") at ~0.6em each
    // plus the 1dp trailing pad, so even a residual measuring error can't
    // squeeze the label below its natural width.
    minWidth: Math.ceil(6 * F.contextBar.size * 0.62) + 2,
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
