/**
 * CommandKeyBar — Smart terminal shortcut key bar
 *
 * 5 context-aware key sets: Default, Vim, Git, REPL, Navigate
 * Swipe left/right to switch. Dot indicators show active set.
 * Auto-detect badge suggests relevant set (never auto-switches).
 */

import React, { useCallback, useState, useRef, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, type NativeSyntheticEvent, type NativeScrollEvent, Dimensions, type LayoutChangeEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTerminalStore } from '@/store/terminal-store';
import { KEY_BAR_HEIGHT, BORDER_WIDTH } from '@/lib/layout-constants';

type Props = {
  sendKey: (keyCode: string) => void;
  sendText: (text: string) => void;
  isCompact?: boolean;
  /** Suggested key set from PTY output detection */
  suggestedSet?: KeySetId;
  /** Attach file callback (replaces TerminalActionBar) */
  onAttach?: () => void;
  /** Voice input callback (replaces TerminalActionBar) */
  onVoice?: () => void;
};

type KeyConfig = {
  label: string;
  compactLabel: string;
  keyCode: string;
  icon?: keyof typeof MaterialIcons.glyphMap;
  action?: 'paste' | 'alt-toggle';
};

export type KeySetId = 'default' | 'vim' | 'git' | 'repl' | 'navigate';

const KEY_SETS: Record<KeySetId, { label: string; icon: string; keys: KeyConfig[] }> = {
  default: {
    label: 'Default',
    icon: 'keyboard',
    keys: [
      { label: 'Ctrl+C', compactLabel: '^C', keyCode: '\x03' },
      { label: 'Tab', compactLabel: 'Tab', keyCode: '\t' },
      { label: '↑', compactLabel: '↑', keyCode: '\x1b[A' },
      { label: '↓', compactLabel: '↓', keyCode: '\x1b[B' },
      { label: 'Paste', compactLabel: 'Paste', keyCode: '', action: 'paste' },
      { label: 'Alt', compactLabel: 'Alt', keyCode: '', action: 'alt-toggle' },
      { label: 'Enter', compactLabel: '\u21B5', keyCode: '\r' },
    ],
  },
  vim: {
    label: 'Vim',
    icon: 'edit',
    keys: [
      { label: 'Esc', compactLabel: 'Esc', keyCode: '\x1b' },
      { label: ':w', compactLabel: ':w', keyCode: ':w\r' },
      { label: ':q', compactLabel: ':q', keyCode: ':q\r' },
      { label: ':wq', compactLabel: ':wq', keyCode: ':wq\r' },
      { label: 'dd', compactLabel: 'dd', keyCode: 'dd' },
      { label: 'u', compactLabel: 'u', keyCode: 'u' },
      { label: 'Ctrl+R', compactLabel: '^R', keyCode: '\x12' },
    ],
  },
  git: {
    label: 'Git',
    icon: 'merge-type',
    keys: [
      { label: 'status', compactLabel: 'stat', keyCode: 'git status\r' },
      { label: 'diff', compactLabel: 'diff', keyCode: 'git diff\r' },
      { label: 'add .', compactLabel: 'add', keyCode: 'git add .\r' },
      { label: 'commit', compactLabel: 'cmt', keyCode: 'git commit -m "' },
      { label: 'push', compactLabel: 'push', keyCode: 'git push\r' },
      { label: 'log', compactLabel: 'log', keyCode: 'git log --oneline -10\r' },
      { label: 'stash', compactLabel: 'stsh', keyCode: 'git stash\r' },
    ],
  },
  repl: {
    label: 'REPL',
    icon: 'code',
    keys: [
      { label: 'Tab', compactLabel: 'Tab', keyCode: '\t' },
      { label: '↑', compactLabel: '↑', keyCode: '\x1b[A' },
      { label: 'Ctrl+C', compactLabel: '^C', keyCode: '\x03' },
      { label: 'Ctrl+D', compactLabel: '^D', keyCode: '\x04' },
      { label: 'Ctrl+L', compactLabel: '^L', keyCode: '\x0c' },
      { label: 'Paste', compactLabel: 'Paste', keyCode: '', action: 'paste' },
      { label: 'Enter', compactLabel: '\u21B5', keyCode: '\r' },
    ],
  },
  navigate: {
    label: 'Nav',
    icon: 'open-with',
    keys: [
      { label: '←', compactLabel: '←', keyCode: '\x1b[D' },
      { label: '→', compactLabel: '→', keyCode: '\x1b[C' },
      { label: 'Home', compactLabel: 'Hm', keyCode: '\x1b[H' },
      { label: 'End', compactLabel: 'End', keyCode: '\x1b[F' },
      { label: 'PgUp', compactLabel: 'PU', keyCode: '\x1b[5~' },
      { label: 'PgDn', compactLabel: 'PD', keyCode: '\x1b[6~' },
      { label: 'Del', compactLabel: 'Del', keyCode: '\x1b[3~' },
    ],
  },
};

const SET_ORDER: KeySetId[] = ['default', 'vim', 'git', 'repl', 'navigate'];

export function CommandKeyBar({ sendKey, sendText, isCompact, suggestedSet, onAttach, onVoice }: Props) {
  const { colors: c } = useTheme();
  const { settings } = useTerminalStore();
  const [activeSet, setActiveSet] = useState<KeySetId>('default');
  const [altActive, setAltActive] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const currentSet = KEY_SETS[activeSet];

  const handleKeyPress = useCallback((key: KeyConfig) => {
    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (key.action === 'paste') {
      Clipboard.getStringAsync().then((text) => { if (text) sendText(text); }).catch(() => {});
      return;
    }
    if (key.action === 'alt-toggle') {
      setAltActive((v) => !v);
      return;
    }
    if (altActive) {
      sendKey('\x1b' + key.keyCode);
      setAltActive(false);
    } else {
      sendKey(key.keyCode);
    }
  }, [sendKey, sendText, settings.hapticFeedback, altActive]);

  const switchSet = useCallback((id: KeySetId) => {
    const idx = SET_ORDER.indexOf(id);
    setActiveSet(id);
    scrollRef.current?.scrollTo({ x: idx * barWidth, animated: true });
    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [settings.hapticFeedback, barWidth]);

  // Track container width for paging
  const [barWidth, setBarWidth] = useState(Dimensions.get('window').width);
  const onBarLayout = useCallback((e: LayoutChangeEvent) => {
    setBarWidth(e.nativeEvent.layout.width);
  }, []);

  const handleScrollEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / e.nativeEvent.layoutMeasurement.width);
    if (page >= 0 && page < SET_ORDER.length && SET_ORDER[page] !== activeSet) {
      setActiveSet(SET_ORDER[page]);
      if (settings.hapticFeedback) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }
  }, [activeSet, settings.hapticFeedback]);

  // Render a single key set page
  const renderKeySet = useCallback((setId: KeySetId) => {
    const keySet = KEY_SETS[setId];
    return (
      <View key={setId} style={[styles.keysRow, { width: barWidth }]}>
        {keySet.keys.map((key, i) => (
          <Pressable
            key={`${setId}-${i}`}
            style={[
              styles.key,
              { backgroundColor: withAlpha(c.foreground, 0.06), borderColor: c.borderLight },
              key.action === 'alt-toggle' && altActive && {
                backgroundColor: withAlpha(c.accent, 0.2),
                borderColor: c.accent,
              },
            ]}
            onPress={() => handleKeyPress(key)}
            accessibilityRole="button"
            accessibilityLabel={key.label}
          >
            {key.icon ? (
              <MaterialIcons name={key.icon} size={14} color={c.foreground} />
            ) : (
              <Text style={[
                styles.keyText,
                { color: key.action === 'alt-toggle' && altActive ? c.accent : c.foreground },
              ]}>
                {isCompact ? key.compactLabel : key.label}
              </Text>
            )}
          </Pressable>
        ))}
      </View>
    );
  }, [barWidth, c, altActive, isCompact, handleKeyPress]);

  return (
    <View style={[styles.container, { backgroundColor: c.surfaceHigh, borderTopColor: c.border }]} onLayout={onBarLayout}>
      {/* Set indicator dots + attach/voice shortcuts */}
      <View style={styles.dotsRow}>
        {onAttach && (
          <Pressable onPress={onAttach} hitSlop={6} style={styles.miniBtn}>
            <MaterialIcons name="attach-file" size={12} color={c.muted} />
          </Pressable>
        )}
        {onVoice && (
          <Pressable onPress={onVoice} hitSlop={6} style={styles.miniBtn}>
            <MaterialIcons name="mic" size={12} color={c.muted} />
          </Pressable>
        )}
        <View style={{ flex: 1 }} />
        {SET_ORDER.map((id) => (
          <Pressable key={id} onPress={() => switchSet(id)} hitSlop={8}>
            <View style={[
              styles.dot,
              { backgroundColor: id === activeSet ? c.accent : withAlpha(c.foreground, 0.2) },
              id === suggestedSet && id !== activeSet && styles.suggestedDot,
              id === suggestedSet && id !== activeSet && { borderColor: c.accent },
            ]} />
          </Pressable>
        ))}
        <Text style={[styles.setLabel, { color: c.muted }]}>{currentSet.label}</Text>
      </View>

      {/* Swipeable key sets */}
      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={handleScrollEnd}
        scrollEventThrottle={16}
      >
        {SET_ORDER.map(renderKeySet)}
      </ScrollView>
    </View>
  );
}

// ─── PTY Output Detection ──────────────────────────────────────────────────

const VIM_PATTERNS = [/vim\s|nvim\s|vi\s/i, /-- INSERT --/, /-- VISUAL --/, /-- NORMAL --/];
const GIT_PATTERNS = [/On branch\s/, /Changes not staged/, /Changes to be committed/, /Untracked files/];
const REPL_PATTERNS = [/^>>>/, /^In \[\d+\]/, /^irb/, /^>\s*$/, /^node>/, /^deno>/];

/**
 * Detect suggested key set from PTY output lines.
 * Returns null if no strong signal. Never auto-switches — UI shows badge.
 */
export function detectKeySet(lines: string[]): KeySetId | undefined {
  for (const line of lines) {
    if (VIM_PATTERNS.some((p) => p.test(line))) return 'vim';
    if (GIT_PATTERNS.some((p) => p.test(line))) return 'git';
    if (REPL_PATTERNS.some((p) => p.test(line))) return 'repl';
  }
  return undefined;
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: BORDER_WIDTH,
  },
  dotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 2,
    paddingHorizontal: 6,
  },
  miniBtn: {
    width: 22,
    height: 22,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  suggestedDot: {
    borderWidth: 1,
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  setLabel: {
    fontFamily: 'monospace',
    fontSize: 8,
    marginLeft: 4,
  },
  keysRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingBottom: 4,
    gap: 4,
  },
  key: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 5,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 36,
  },
  keyText: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
});
