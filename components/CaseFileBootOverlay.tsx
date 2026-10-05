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

export function CaseFileBootOverlay() {
  const active = useThemeVersionStore((s) => s.caseFileBootFlash);
  const clear = useThemeVersionStore((s) => s.clearCaseFileBootFlash);
  const [visible, setVisible] = useState(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!active) return;
    setVisible(true);
    progress.setValue(0);
    opacity.setValue(1);
    Animated.timing(progress, {
      toValue: 1,
      duration: FLASH_DURATION_MS,
      easing: Easing.linear,
      useNativeDriver: false, // drives a width %, not transform/opacity
    }).start();
    const timer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => {
        setVisible(false);
        clear();
      });
    }, FLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [active, opacity, progress, clear]);

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
