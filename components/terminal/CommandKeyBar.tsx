/**
 * CommandKeyBar — Smart terminal shortcut key bar
 *
 * 5 context-aware key sets: Default, Vim, Git, REPL, Navigate
 * Swipe left/right to switch. Dot indicators show active set.
 * Auto-detect badge suggests relevant set (never auto-switches).
 */

import React, { useCallback, useEffect, useState, useRef, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView, type NativeSyntheticEvent, type NativeScrollEvent, Dimensions, type LayoutChangeEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useSettingsStore } from '@/store/settings-store';
import { KEY_BAR_HEIGHT, BORDER_WIDTH } from '@/lib/layout-constants';
import { usePaneVoice } from '@/hooks/use-pane-voice';
import { fonts as F } from '@/theme.config';
import { themePresets, type ThemePresetId } from '@/lib/theme-presets';

type Props = {
  sendKey: (keyCode: string) => void;
  sendText: (text: string) => void;
  /** bug #81: paste-aware writer that goes through TerminalEmulator.paste(). Falls back to sendText. */
  sendPaste?: (text: string) => void;
  /** Preferred Android path: native ClipboardManager -> TerminalEmulator.paste(). */
  pasteFromClipboard?: () => Promise<void> | void;
  isCompact?: boolean;
  /** Suggested key set from PTY output detection */
  suggestedSet?: KeySetId;
  /** Attach file callback (replaces TerminalActionBar) */
  onAttach?: () => void;
  /** Voice input callback — called with the transcript text when recording completes */
  onVoice?: (text: string) => void;
  /** Long-press on the mic opens the continuous voice dialogue mode */
  onVoiceLong?: () => void;
  /** Overrides the default opaque-black bar background — pass the same
   * value TerminalPane derives (terminalPaneBg) so the key bar follows
   * the settings.terminalWallpaperTransparency opt-in instead of always
   * staying solid black underneath a transparent terminal surface. */
  backgroundColor?: string;
};

type KeyConfig = {
  label: string;
  compactLabel: string;
  keyCode: string;
  icon?: keyof typeof MaterialIcons.glyphMap;
  action?: 'paste' | 'alt-toggle';
};

export type KeySetId = 'default' | 'vim' | 'git' | 'repl' | 'navigate';

const TERMINAL_KEY_BAR_BACKGROUND = '#000000';

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

/** Natural key metrics (dp) — used to detect when a page can't fit them. */
const KEY_MIN_WIDTH = 36;
const KEY_GAP = 3;
const KEYS_ROW_PAD_X = 2;
const KEYS_PER_SET = 7;
/**
 * Narrowest viewport (dp) that fits a full key set at its natural minimum
 * key width: 7 × 36 + 6 × 3 gaps + 2 × 2 padding = 274dp.
 *
 * On the Z Fold6 cover display (968px @ 464dpi ≈ 333dp) the pane is
 * 333 − 38 (sidebar rail) − 2 (pane border) = 293dp wide, leaving the scroller
 * 293 − 2 × 28 (attach/mic) − 19 (dots column) = 218dp. The old fixed
 * minWidth:36 forced every page to 274dp inside that 218dp viewport, so the
 * last ~56dp (the "Alt"/"↵" keys) were clipped at the right edge. Below this
 * threshold the row switches to a tight layout whose keys may shrink.
 */
export const KEY_PAGE_NATURAL_MIN_WIDTH =
  KEYS_PER_SET * KEY_MIN_WIDTH + (KEYS_PER_SET - 1) * KEY_GAP + 2 * KEYS_ROW_PAD_X;

const SET_ORDER_FULL: KeySetId[] = ['default', 'vim', 'git', 'repl', 'navigate'];
const SET_ORDER_NO_VIM: KeySetId[] = ['default', 'git', 'repl', 'navigate'];

export function CommandKeyBar({ sendKey, sendText, sendPaste, pasteFromClipboard, isCompact, suggestedSet, onAttach, onVoice, onVoiceLong, backgroundColor }: Props) {
  const { colors: c } = useTheme();
  const settings = useSettingsStore((s) => s.settings);
  const visualPreset =
    settings.uiFont === 'orange' ? 'orange'
      : settings.uiFont === 'scouter-green' ? 'green'
      : settings.uiFont === 'purple' || settings.uiFont === 'shelly' || settings.uiFont === 'modal' ? 'purple'
        : 'blue';
  const presetColors = themePresets[settings.uiFont as ThemePresetId]?.colors;
  const accent = presetColors?.accent ?? c.accent;
  const foreground = presetColors?.text1 ?? c.foreground;
  const muted = presetColors?.text2 ?? c.muted;
  const border = presetColors?.border ?? c.border;
  const barBg = backgroundColor ?? TERMINAL_KEY_BAR_BACKGROUND;
  const keyChrome = useMemo(() => {
    if (visualPreset === 'blue') {
      return {
        key: {
          backgroundColor: withAlpha(accent, 0.06),
          borderColor: withAlpha(accent, 0.42),
          borderRadius: 2,
        },
        textColor: accent,
        iconColor: accent,
      };
    }
    if (visualPreset === 'orange') {
      return {
        key: {
          backgroundColor: withAlpha(accent, 0.07),
          borderColor: withAlpha(accent, 0.44),
          borderRadius: 4,
        },
        textColor: accent,
        iconColor: accent,
      };
    }
    if (visualPreset === 'purple') {
      return {
        key: {
          backgroundColor: withAlpha(accent, 0.06),
          borderColor: withAlpha(accent, 0.46),
          borderRadius: 3,
        },
        textColor: accent,
        iconColor: accent,
      };
    }
    if (visualPreset === 'green') {
      return {
        key: {
          backgroundColor: withAlpha(accent, 0.07),
          borderColor: withAlpha(accent, 0.46),
          borderRadius: 2,
        },
        textColor: accent,
        iconColor: accent,
      };
    }
    return {
      key: {
        backgroundColor: withAlpha(foreground, 0.06),
        borderColor: border,
        borderRadius: 5,
      },
      textColor: foreground,
      iconColor: foreground,
    };
  }, [accent, border, foreground, visualPreset]);
  // bug #48: Gate the Vim key page behind a settings toggle. Vim users opt in
  // via Settings → Terminal → "Show Vim key bar" (default off). Until then
  // ":w / :q / :wq / dd" don't clutter the bar for non-vim users.
  const SET_ORDER = useMemo<KeySetId[]>(
    () => (settings.showVimKeyBar ? SET_ORDER_FULL : SET_ORDER_NO_VIM),
    [settings.showVimKeyBar],
  );
  const [activeSet, setActiveSet] = useState<KeySetId>('default');
  const [altActive, setAltActive] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  // Voice recording via usePaneVoice — only active when onVoice prop is provided
  const handleTranscript = useCallback((text: string) => {
    onVoice?.(text);
  }, [onVoice]);
  const { startRecording, stopRecording, isRecording, isTranscribing } = usePaneVoice(handleTranscript);

  const handleVoicePress = useCallback(async () => {
    if (!onVoice) return;
    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    if (isRecording) {
      await stopRecording();
    } else {
      await startRecording();
    }
  }, [onVoice, isRecording, startRecording, stopRecording, settings.hapticFeedback]);

  const handleKeyPress = useCallback((key: KeyConfig) => {
    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (key.action === 'paste') {
      // bug #81: prefer the paste-aware path (routes through the emulator's
      // paste() — CR/LF normalized + bracketed-paste wrapped). Fallback to
      // sendText for legacy callers that haven't passed sendPaste through.
      if (pasteFromClipboard) {
        Promise.resolve(pasteFromClipboard()).catch((err) => {
          console.warn('[CommandKeyBar] native pasteFromClipboard failed:', err);
          Clipboard.getStringAsync().then((text) => {
            if (!text) return;
            if (sendPaste) sendPaste(text);
            else sendText(text);
          }).catch((clipErr) => console.warn('[CommandKeyBar] Clipboard.getStringAsync failed:', clipErr));
        });
        return;
      }
      Clipboard.getStringAsync().then((text) => {
        if (!text) return;
        if (sendPaste) sendPaste(text);
        else sendText(text);
      }).catch((err) => console.warn('[CommandKeyBar] Clipboard.getStringAsync failed:', err));
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
  }, [sendKey, sendText, sendPaste, pasteFromClipboard, settings.hapticFeedback, altActive]);

  // Track the key-set SCROLLER viewport width for paging. Each page must be
  // exactly as wide as the horizontal ScrollView's viewport: pagingEnabled
  // snaps by viewport width, and the keys inside a page use flex:1. This was
  // previously measured on the whole bar container (which also holds the
  // attach/mic buttons and the dots column), so every page was ~70dp wider
  // than the viewport and the last key of each set was cut off at the right
  // edge (2026-10-06 Fold6 on-device feedback).
  const [barWidth, setBarWidth] = useState(Dimensions.get('window').width);

  const switchSet = useCallback((id: KeySetId) => {
    const idx = SET_ORDER.indexOf(id);
    setActiveSet(id);
    scrollRef.current?.scrollTo({ x: idx * barWidth, animated: true });
    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [settings.hapticFeedback, barWidth, SET_ORDER]);
  const onScrollerLayout = useCallback((e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    // Ignore sub-pixel jitter so a resize doesn't re-render every page twice.
    setBarWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
  }, []);

  // Re-snap to the active page whenever the viewport width changes (fold /
  // unfold, sidebar expand/collapse, split resize); otherwise the old pixel
  // offset leaves the scroller parked between two pages.
  const activeSetRef = useRef(activeSet);
  activeSetRef.current = activeSet;
  useEffect(() => {
    const idx = SET_ORDER.indexOf(activeSetRef.current);
    if (idx < 0) return;
    scrollRef.current?.scrollTo({ x: idx * barWidth, animated: false });
  }, [barWidth, SET_ORDER]);

  const handleScrollEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(e.nativeEvent.contentOffset.x / e.nativeEvent.layoutMeasurement.width);
    if (page >= 0 && page < SET_ORDER.length && SET_ORDER[page] !== activeSet) {
      setActiveSet(SET_ORDER[page]);
      if (settings.hapticFeedback) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    }
  }, [activeSet, settings.hapticFeedback, SET_ORDER]);

  // Render a single key set page
  // Tight mode only kicks in when the measured viewport can't hold the keys
  // at their natural minimum width, so standard/wide layouts render exactly
  // as before.
  const tight = barWidth < KEY_PAGE_NATURAL_MIN_WIDTH;
  const renderKeySet = useCallback((setId: KeySetId) => {
    const keySet = KEY_SETS[setId];
    return (
      <View key={setId} style={[styles.keysRow, tight && styles.keysRowTight, { width: barWidth }]}>
        {keySet.keys.map((key, i) => (
          <Pressable
            key={`${setId}-${i}`}
            style={[
              styles.key,
              tight && styles.keyTight,
              keyChrome.key,
              key.action === 'alt-toggle' && altActive && {
                backgroundColor: withAlpha(accent, 0.2),
                borderColor: accent,
              },
            ]}
            onPress={() => handleKeyPress(key)}
            accessibilityRole="button"
            accessibilityLabel={key.label}
          >
            {key.icon ? (
              <MaterialIcons name={key.icon} size={14} color={keyChrome.iconColor} />
            ) : (
              <Text
                style={[
                  styles.keyText,
                  tight && styles.keyTextTight,
                  { color: key.action === 'alt-toggle' && altActive ? accent : keyChrome.textColor },
                ]}
                numberOfLines={1}
                adjustsFontSizeToFit={tight}
                minimumFontScale={0.6}
              >
                {isCompact || tight ? key.compactLabel : key.label}
              </Text>
            )}
          </Pressable>
        ))}
      </View>
    );
  }, [barWidth, tight, accent, altActive, isCompact, handleKeyPress, keyChrome]);

  return (
    <View style={[styles.container, { backgroundColor: barBg, borderTopColor: border }]}>
      {/* Single row: attach/voice + swipeable keys + dots */}
      <View style={styles.singleRow}>
        {/* Attach + Voice mini buttons */}
        {onAttach && (
          <Pressable onPress={onAttach} hitSlop={6} style={styles.miniBtn}>
            <MaterialIcons name="attach-file" size={13} color={muted} />
          </Pressable>
        )}
        {onVoice && (
          <Pressable
            onPress={handleVoicePress}
            onLongPress={onVoiceLong}
            delayLongPress={350}
            hitSlop={6}
            style={styles.miniBtn}
          >
            <MaterialIcons name="mic" size={13} color={isRecording || isTranscribing ? accent : muted} />
            {(isRecording || isTranscribing) && (
              <View style={[styles.recordingDot, { backgroundColor: accent }]} />
            )}
          </Pressable>
        )}

        {/* Swipeable key sets */}
        <View style={styles.scroller} onLayout={onScrollerLayout}>
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

        {/* Dots column (compact) */}
        <View style={styles.dotsCol}>
          <View style={styles.dotsGroup}>
            {SET_ORDER.map((id) => (
              <Pressable key={id} onPress={() => switchSet(id)} hitSlop={6}>
                <View style={[
                  styles.dot,
                  { backgroundColor: id === activeSet ? accent : withAlpha(foreground, 0.2) },
                  id === suggestedSet && id !== activeSet && styles.suggestedDot,
                  id === suggestedSet && id !== activeSet && { borderColor: accent },
                ]} />
              </Pressable>
            ))}
          </View>
        </View>
      </View>
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
    minHeight: KEY_BAR_HEIGHT,
  },
  singleRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  miniBtn: {
    width: 28,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordingDot: {
    position: 'absolute',
    bottom: 6,
    right: 5,
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  scroller: {
    flex: 1,
    minWidth: 0,
    // Contain the paging scroller so a page can never paint past the pane's
    // right border while it is mid-swipe.
    overflow: 'hidden',
  },
  dotsCol: {
    paddingLeft: 4,
    paddingRight: 8,
    justifyContent: 'center',
  },
  dotsGroup: {
    flexDirection: 'column',
    gap: 3,
    alignItems: 'center',
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
    fontFamily: F.family,
    fontSize: 8,
    marginLeft: 4,
  },
  keysRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: KEYS_ROW_PAD_X,
    paddingVertical: 4,
    gap: KEY_GAP,
  },
  keysRowTight: {
    paddingHorizontal: 1,
    gap: 2,
  },
  key: {
    flex: 1,
    paddingVertical: 6,
    borderRadius: 5,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: KEY_MIN_WIDTH,
  },
  keyTight: {
    // Equal-share keys that may shrink below KEY_MIN_WIDTH so the whole set
    // always fits inside the page (never paints past the right edge).
    flexBasis: 0,
    flexShrink: 1,
    minWidth: 0,
    paddingHorizontal: 1,
  },
  keyText: {
    fontFamily: F.family,
    fontSize: 11,
    fontWeight: '600',
  },
  keyTextTight: {
    fontSize: 10,
  },
});
