// components/CrtOverlay.tsx
// CRT display effect overlay — scanlines, phosphor tint, vignette.
// pointerEvents="none" so it never blocks touch interactions.
//
// The flicker animation was removed: a 10Hz opacity pulse was a
// pure aesthetic nod to CRT electron-gun refresh, but in practice
// it registered as distracting screen-wide blinking and wasted a
// Reanimated frame callback every 100ms. The scanlines + phosphor
// tint + vignette already read as "CRT" on their own.

import React from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { useCosmeticStore } from '@/store/cosmetic-store';

// ── CRT constants ────────────────────────────────────────────────────────────
// Scanline / phosphor / vignette caps. The `intensity` slider (0..1) blends
// between a floor and these caps so dragging the slider has a visible effect
// across the full range — previously phosphor capped at 3% opacity and
// scanlines ignored the slider entirely, which is why users thought the
// slider did nothing.
const SCANLINE_OPACITY_MIN = 0.05;
const SCANLINE_OPACITY_MAX = 0.28;
const PHOSPHOR_ALPHA_MIN = 0.005;
const PHOSPHOR_ALPHA_MAX = 0.09;
const VIGNETTE_BAND_RATIO = 0.20;
const VIGNETTE_OPACITY_MIN = 0.05;
// bug #61: at full intensity the four black bands combined with the panel's
// natural OLED non-uniformity produced visible corner brightness asymmetry
// (top-right bright, bottom-left dark). Capping the ceiling at 0.22 keeps
// the vignette readable as a CRT cue without amplifying panel mura.
const VIGNETTE_OPACITY_MAX = 0.22;

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

  if (!crtEnabled) return null;

  // Lerp from floor to ceiling so every slider position is visibly different.
  const t = Math.max(0, Math.min(1, crtIntensity / 100));
  const lerp = (a: number, b: number) => a + (b - a) * t;
  const scanlineOpacity = lerp(SCANLINE_OPACITY_MIN, SCANLINE_OPACITY_MAX);
  const phosphorOpacity = lerp(PHOSPHOR_ALPHA_MIN, PHOSPHOR_ALPHA_MAX);
  // bug #61: compress the vignette blend so the top 20% of slider travel
  // does not push the bands beyond comfortable contrast. Double safety on
  // top of the clamped VIGNETTE_OPACITY_MAX constant.
  const vignetteT = Math.min(t, 0.8) / 0.8;
  const vignetteOpacity =
    VIGNETTE_OPACITY_MIN + (VIGNETTE_OPACITY_MAX - VIGNETTE_OPACITY_MIN) * vignetteT;

  return (
    <View
      style={styles.container}
      pointerEvents="none"
    >
      {/* ── Scanlines (opacity scales with intensity) ── */}
      <View style={styles.scanlineContainer} pointerEvents="none">
        {SCANLINES.map((_, i) => (
          <View
            key={i}
            style={[styles.scanline, { opacity: scanlineOpacity }]}
          />
        ))}
      </View>

      {/* ── Phosphor green tint ── */}
      <View
        style={[styles.phosphorTint, { opacity: phosphorOpacity }]}
        pointerEvents="none"
      />

      {/* ── Vignette: outer 20% dimmed ── */}
      <View style={styles.vignetteContainer} pointerEvents="none">
        <View
          style={[styles.vignetteTop, { height: VIGNETTE_V_BAND, opacity: vignetteOpacity }]}
          pointerEvents="none"
        />
        <View
          style={[styles.vignetteBottom, { height: VIGNETTE_V_BAND, opacity: vignetteOpacity }]}
          pointerEvents="none"
        />
        <View
          style={[styles.vignetteLeft, { width: VIGNETTE_H_BAND, opacity: vignetteOpacity }]}
          pointerEvents="none"
        />
        <View
          style={[styles.vignetteRight, { width: VIGNETTE_H_BAND, opacity: vignetteOpacity }]}
          pointerEvents="none"
        />
      </View>
    </View>
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
