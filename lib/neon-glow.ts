/**
 * lib/neon-glow.ts — Neon glow styles for CRT terminal aesthetic
 */
import { TextStyle, ViewStyle } from 'react-native';
import { colors as C } from '@/theme.config';

// Phase C (2026-04-20): pushed the teal glow up another notch so the
// Shelly identity reads as "neon arcade" rather than "teal text".
// Silkscreen's tight pixel grid tolerates radius up to ~14 before the
// letters smear; we cap at 13 for the base glow so hairline strokes
// (CLI prompt markers, status badges) still read crisply. The rgba
// tuple matches the new Shelly neon accent `#00F0C8` introduced in
// the same pass — a cyan-teal an extra notch brighter than the old
// #00D4AA. Glow colour is still hardcoded (not theme-aware) because
// react-native TextStyle cannot take a live-bound colour without a
// consumer refactor; tracked as follow-up.
const GLOW_COLOR = 'rgba(0, 240, 200, 1)';
const GLOW_COLOR_STRONG = 'rgba(0, 240, 200, 1)';

/** Subtle neon text glow for accent-colored labels */
export const neonTextGlow: TextStyle = {
  textShadowColor: GLOW_COLOR,
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: 13,
};

/** Stronger neon text glow for prominent elements */
export const neonTextGlowStrong: TextStyle = {
  textShadowColor: GLOW_COLOR_STRONG,
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: 18,
};

/** Neon glow for status dots and indicators */
export const neonDotGlow: ViewStyle = {
  shadowColor: C.accent,
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 1,
  shadowRadius: 11,
  elevation: 8,
};

/** Neon border glow for active elements */
export const neonBorderGlow: ViewStyle = {
  shadowColor: C.accent,
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 0.85,
  shadowRadius: 16,
  elevation: 6,
};

// ── Per-color glows ────────────────────────────────────────────────
// Match the mock's color-coded neon text (CLAUDE purple, YOU blue,
// strings pink, etc). Radius trimmed to 5 because Silkscreen pixels
// smear at higher values.

const glow = (color: string, alpha: number, radius: number): TextStyle => ({
  textShadowColor: `rgba(${color}, ${alpha})`,
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: radius,
});

// Per-colour glows matched to the Phase C neon accent palette
// (see shellyPalette in theme-presets.ts). Each tuple corresponds to
// one accent hue so that text in that colour carries a matching halo.
export const neonGlowTeal:   TextStyle = glow('0, 240, 200', 1.0, 14);   // #00F0C8
export const neonGlowBlue:   TextStyle = glow('10, 240, 255', 0.95, 12); // #0AF0FF
export const neonGlowSky:    TextStyle = glow('56, 225, 255', 0.9, 11);  // #38E1FF
export const neonGlowPurple: TextStyle = glow('177, 74, 255', 0.95, 12); // #B14AFF
export const neonGlowPink:   TextStyle = glow('255, 46, 211', 1.0, 13);  // #FF2ED3
export const neonGlowGreen:  TextStyle = glow('57, 255, 20', 1.0, 13);   // #39FF14
export const neonGlowRed:    TextStyle = glow('255, 51, 102', 0.95, 12); // #FF3366
export const neonGlowAmber:  TextStyle = glow('255, 229, 0', 1.0, 13);   // #FFE500
