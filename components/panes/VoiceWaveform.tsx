/**
 * components/panes/VoiceWaveform.tsx
 *
 * Compact animated waveform bar — 5 bars that oscillate when active.
 * Height: 24px. Accent color: #00D4AA.
 */

import React, { useEffect } from 'react';
import { colors as C } from '@/theme.config';
import { View, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  Easing,
  cancelAnimation,
} from 'react-native-reanimated';

// ─── Types ────────────────────────────────────────────────────────────────────

type Props = {
  active: boolean;
};

// ─── Bar config ───────────────────────────────────────────────────────────────

// Each bar: [minHeight, maxHeight, durationMs, delayMs]
const BAR_CONFIG: [number, number, number, number][] = [
  [3, 16, 380, 0],
  [4, 22, 320, 60],
  [5, 24, 290, 120],
  [4, 20, 350, 40],
  [3, 14, 410, 90],
  [5, 18, 300, 150],
  [4, 22, 360, 80],
];



// ─── Single Bar ───────────────────────────────────────────────────────────────

function WaveBar({
  active,
  minH,
  maxH,
  duration,
  delay,
}: {
  active: boolean;
  minH: number;
  maxH: number;
  duration: number;
  delay: number;
}) {
  const height = useSharedValue(minH);

  useEffect(() => {
    if (active) {
      // Small initial delay to stagger bars
      const timer = setTimeout(() => {
        height.value = withRepeat(
          withTiming(maxH, {
            duration,
            easing: Easing.inOut(Easing.sin),
          }),
          -1,
          true,
        );
      }, delay);
      return () => {
        clearTimeout(timer);
        cancelAnimation(height);
        height.value = withTiming(minH, { duration: 150 });
      };
    } else {
      cancelAnimation(height);
      height.value = withTiming(minH, { duration: 200 });
    }
  }, [active, height, minH, maxH, duration, delay]);

  const animStyle = useAnimatedStyle(() => ({
    height: height.value,
  }));

  return <Animated.View style={[styles.bar, animStyle]} />;
}

// ─── VoiceWaveform ────────────────────────────────────────────────────────────

export default function VoiceWaveform({ active }: Props) {
  return (
    <View style={styles.container}>
      {BAR_CONFIG.map(([minH, maxH, dur, delay], i) => (
        <WaveBar
          key={i}
          active={active}
          minH={minH}
          maxH={maxH}
          duration={dur}
          delay={delay}
        />
      ))}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    height: 24,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: 4,
  },
  bar: {
    width: 3,
    borderRadius: 2,
    backgroundColor: C.accent,
  },
});
