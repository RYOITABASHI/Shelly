/**
 * BlockHistoryFab — the round "history" button floating at the bottom-right
 * of the Terminal pane. It opens the Block History overlay.
 *
 * It sits on top of terminal text, so it is deliberately unobtrusive:
 *  - idle:   faded (IDLE_OPACITY), no shadow, still tappable (full hit area).
 *  - active: fully opaque. Entered whenever `wakeKey` changes (the parent
 *            bumps it on scrollback scroll / terminal taps) or the FAB itself
 *            is tapped. Falls back to idle after IDLE_DELAY_MS of no activity.
 *  - hidden: opacity 0 + pointerEvents="none" while `hidden` is true (the
 *            native long-press text selection is up), so it never covers or
 *            steals touches from the selection handles / action menu.
 *
 * A tap while faded performs the action immediately (and wakes the button);
 * it never requires a second tap. Reduced motion → instant opacity changes.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { TIMING_CONFIGS } from '@/hooks/use-motion';
import { colors as C } from '@/theme.config';
import { createThemedStyles } from '@/lib/themed-stylesheet';

export const BLOCK_HISTORY_FAB_IDLE_OPACITY = 0.25;
export const BLOCK_HISTORY_FAB_IDLE_DELAY_MS = 3000;

export type BlockHistoryFabProps = {
  onPress: () => void;
  /** Any change (after mount) wakes the FAB to full opacity. */
  wakeKey: number;
  /** Fully hide + disable touches (e.g. native text selection active). */
  hidden: boolean;
  /** Positioning (bottom offset etc.) from the parent. */
  style?: StyleProp<ViewStyle>;
  accessibilityLabel?: string;
};

export function BlockHistoryFab({
  onPress,
  wakeKey,
  hidden,
  style,
  accessibilityLabel = 'Block History',
}: BlockHistoryFabProps) {
  const reduceMotion = useReducedMotion();
  const [active, setActive] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const wake = useCallback(() => {
    setActive(true);
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => {
      idleTimerRef.current = null;
      setActive(false);
    }, BLOCK_HISTORY_FAB_IDLE_DELAY_MS);
  }, []);

  // Wake on every wakeKey change, but not on mount (start idle).
  const lastWakeKeyRef = useRef(wakeKey);
  useEffect(() => {
    if (lastWakeKeyRef.current === wakeKey) return;
    lastWakeKeyRef.current = wakeKey;
    wake();
  }, [wakeKey, wake]);

  useEffect(
    () => () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    },
    [],
  );

  const target = hidden ? 0 : active ? 1 : BLOCK_HISTORY_FAB_IDLE_OPACITY;
  const opacity = useSharedValue(target);
  useEffect(() => {
    if (reduceMotion) {
      opacity.value = target;
    } else {
      opacity.value = withTiming(target, active || hidden ? TIMING_CONFIGS.fast : TIMING_CONFIGS.slow);
    }
  }, [target, active, hidden, reduceMotion, opacity]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  const handlePress = useCallback(() => {
    wake();
    onPress();
  }, [wake, onPress]);

  return (
    <Animated.View
      testID="block-history-fab"
      pointerEvents={hidden ? 'none' : 'box-none'}
      style={[styles.fab, style, animatedStyle]}
    >
      <TouchableOpacity
        testID="block-history-fab-button"
        style={styles.button}
        onPress={handlePress}
        disabled={hidden}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ disabled: hidden }}
        hitSlop={6}
      >
        <MaterialIcons name="history" size={18} color={C.text1} />
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = createThemedStyles(() => ({
  // Position/size preserved from the original TerminalPane FAB.
  fab: {
    position: 'absolute',
    right: 12,
    bottom: 160,
    width: 32,
    height: 32,
    zIndex: 15,
  },
  button: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: C.accent + '44',
    backgroundColor: C.bgDeep + 'B3', // ~0.7 alpha, matches the old rgba(0,0,0,0.7)
    alignItems: 'center',
    justifyContent: 'center',
    // No shadow/elevation: it must not add a dark halo over terminal text.
    elevation: 0,
    shadowOpacity: 0,
  },
}));
