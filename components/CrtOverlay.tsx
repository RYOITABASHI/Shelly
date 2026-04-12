// components/CrtOverlay.tsx
// CRT display effect overlay — scanlines, phosphor tint, vignette, flicker
// pointerEvents="none" so it never blocks touch interactions

import React, { useEffect } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';

// ── CRT constants ────────────────────────────────────────────────────────────
// Scanline: 1px black + 3px gap, fixed 0.15 opacity (not scaled by intensity)
const SCANLINE_OPACITY = 0.15;
// Phosphor green: rgba(0,255,68,0.03) × intensity
const PHOSPHOR_BASE_ALPHA = 0.03;
// Vignette: outer 20% dimmed to 0.85 brightness → overlay black at 0.15
const VIGNETTE_BAND_RATIO = 0.20;
const VIGNETTE_OPACITY = 0.15;
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useCosmeticStore } from '@/store/cosmetic-store';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Generate scanline data once — ~200 lines spaced 4px apart (1px line + 3px gap)
const SCANLINE_COUNT = Math.ceil(SCREEN_HEIGHT / 4) + 50; // extra buffer
const SCANLINES = Array.from({ length: SCANLINE_COUNT });

// Vignette band sizes: outer 20% of each dimension
const VIGNETTE_V_BAND = Math.round(SCREEN_HEIGHT * VIGNETTE_BAND_RATIO);
const VIGNETTE_H_BAND = Math.round(SCREEN_WIDTH * VIGNETTE_BAND_RATIO);

export function CrtOverlay() {
  const crtEnabled = useCosmeticStore((s) => s.crtEnabled);
  const crtIntensity = useCosmeticStore((s) => s.crtIntensity);

  // Flicker animation
  const flickerOpacity = useSharedValue(1);

  useEffect(() => {
    if (!crtEnabled) return;

    flickerOpacity.value = withRepeat(
      withSequence(
        withTiming(0.97, { duration: 100 }),
        withTiming(1, { duration: 100 }),
      ),
      -1, // infinite
      false,
    );
  }, [crtEnabled]);

  const flickerStyle = useAnimatedStyle(() => ({
    opacity: flickerOpacity.value,
  }));

  if (!crtEnabled) return null;

  // Scale all effect opacities by crtIntensity (0-100 → 0-1)
  const intensity = crtIntensity / 100;

  return (
    <Animated.View
      style={[styles.container, flickerStyle]}
      pointerEvents="none"
    >
      {/* ── Scanlines (fixed 0.15 opacity, not scaled) ── */}
      <View style={styles.scanlineContainer} pointerEvents="none">
        {SCANLINES.map((_, i) => (
          <View
            key={i}
            style={[styles.scanline, { opacity: SCANLINE_OPACITY }]}
          />
        ))}
      </View>

      {/* ── Phosphor green tint: rgba(0,255,68,0.03) × intensity ── */}
      <View
        style={[
          styles.phosphorTint,
          { opacity: PHOSPHOR_BASE_ALPHA * intensity },
        ]}
        pointerEvents="none"
      />

      {/* ── Vignette: outer 20% dimmed to 0.85 brightness ── */}
      <View style={styles.vignetteContainer} pointerEvents="none">
        <View
          style={[styles.vignetteTop, { height: VIGNETTE_V_BAND, opacity: VIGNETTE_OPACITY }]}
          pointerEvents="none"
        />
        <View
          style={[styles.vignetteBottom, { height: VIGNETTE_V_BAND, opacity: VIGNETTE_OPACITY }]}
          pointerEvents="none"
        />
        <View
          style={[styles.vignetteLeft, { width: VIGNETTE_H_BAND, opacity: VIGNETTE_OPACITY }]}
          pointerEvents="none"
        />
        <View
          style={[styles.vignetteRight, { width: VIGNETTE_H_BAND, opacity: VIGNETTE_OPACITY }]}
          pointerEvents="none"
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
  },

  // ── Scanlines ──────────────────────────────
  scanlineContainer: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'column',
    overflow: 'hidden',
  },
  scanline: {
    height: 1,
    marginBottom: 3, // 1px line + 3px gap = 4px period
    backgroundColor: 'rgba(0,0,0,1)',
  },

  // ── Phosphor tint ──────────────────────────
  phosphorTint: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 255, 68, 1)', // fully opaque, opacity prop scales it
  },

  // ── Vignette ──────────────────────────────
  vignetteContainer: {
    ...StyleSheet.absoluteFillObject,
  },
  vignetteTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,1)',
  },
  vignetteBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,1)',
  },
  vignetteLeft: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,1)',
  },
  vignetteRight: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,1)',
  },
});
