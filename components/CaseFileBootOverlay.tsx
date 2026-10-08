/**
 * components/CaseFileBootOverlay.tsx
 *
 * A brief (~1.1s) pseudo-boot flash shown only on the actual transition
 * INTO the Case File theme (never on re-applying it, never on leaving it —
 * see theme-version-store.ts's caseFileBootFlash / lib/theme-presets.ts's
 * applyThemePreset). Purely cosmetic: the theme switch itself is instant:
 * this is the "wolf in sheep's clothing" disguise, a fake loading sequence
 * over a real one-frame color swap, echoing an old PC's boot text.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Animated, Easing, StyleSheet } from 'react-native';
import { useThemeVersionStore } from '@/store/theme-version-store';
import { fonts as F } from '@/theme.config';

const BOOT_LINES = [
  'SHELLY CASE FILE SYSTEM v1.0',
  'LOADING RECORD INDEX...',
  'READY.',
];

const FLASH_DURATION_MS = 1100;
const FADE_DURATION_MS = 180;
// Hard ceiling, independent of any Animated completion callback: the overlay
// is ALWAYS gone this long after it appears, even if the fade's callback
// never fires (native-driver animation torn down by a remount / app
// backgrounding) or the store flag flips underneath it.
export const CASE_FILE_BOOT_FLASH_MAX_MS = FLASH_DURATION_MS + FADE_DURATION_MS + 300;

export function CaseFileBootOverlay() {
  const active = useThemeVersionStore((s) => s.caseFileBootFlash);
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  // Timers live in refs and are torn down ONLY on unmount. They must not be
  // tied to the `active` effect: 2026-10-08 build 2478 regression — the
  // flag being cleared (by a previous ShellLayout instance's fade callback
  // after a theme-version remount) re-ran the old effect, whose cleanup
  // killed the hide timer while `visible` stayed true, so the overlay stuck
  // on screen indefinitely.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      if (hardTimer.current) clearTimeout(hardTimer.current);
      fadeTimer.current = null;
      hardTimer.current = null;
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    // Consume the one-shot flag immediately so a remount (theme-version key
    // bump) or a duplicate trigger never replays / re-arms the flash.
    useThemeVersionStore.getState().clearCaseFileBootFlash();
    if (fadeTimer.current || hardTimer.current) return; // already flashing
    const hide = () => {
      if (fadeTimer.current) clearTimeout(fadeTimer.current);
      if (hardTimer.current) clearTimeout(hardTimer.current);
      fadeTimer.current = null;
      hardTimer.current = null;
      if (mounted.current) setVisible(false);
    };
    setVisible(true);
    progress.setValue(0);
    opacity.setValue(1);
    Animated.timing(progress, {
      toValue: 1,
      duration: FLASH_DURATION_MS,
      easing: Easing.linear,
      useNativeDriver: false, // drives a width %, not transform/opacity
    }).start();
    fadeTimer.current = setTimeout(() => {
      fadeTimer.current = null;
      Animated.timing(opacity, { toValue: 0, duration: FADE_DURATION_MS, useNativeDriver: true }).start(hide);
    }, FLASH_DURATION_MS);
    hardTimer.current = setTimeout(hide, CASE_FILE_BOOT_FLASH_MAX_MS);
  }, [active, opacity, progress]);

  if (!visible) return null;

  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.root, { opacity }]}>
      <View style={styles.lines}>
        {BOOT_LINES.map((line, i) => (
          <Text key={i} style={styles.line}>{line}</Text>
        ))}
      </View>
      <View style={styles.barTrack}>
        <Animated.View
          style={[
            styles.barFill,
            {
              width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
            },
          ]}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: '#E8E3D0',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: 24,
    zIndex: 999,
    elevation: 999,
  },
  lines: {
    marginBottom: 14,
  },
  line: {
    fontFamily: F.family,
    fontSize: 12,
    color: '#2A2416',
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  barTrack: {
    width: 180,
    height: 6,
    borderWidth: 1,
    borderColor: '#2A2416',
  },
  barFill: {
    height: '100%',
    backgroundColor: '#2A2416',
  },
});
