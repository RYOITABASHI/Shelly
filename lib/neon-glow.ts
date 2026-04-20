/**
 * lib/neon-glow.ts — Neon glow styles for CRT terminal aesthetic
 */
import { TextStyle, ViewStyle } from 'react-native';
import { colors as C } from '@/theme.config';

// Phase C (2026-04-20): pushed the teal glow up another notch so the
// Shelly identity reads as "neon arcade" rather than "teal text".
// Silkscreen's tight pixel grid tolerates radius up to ~14 before the
// letters smear; we cap at 13 for the base glow so hairline strokes
// (CLI prompt markers, status badges) still read crisply.
const GLOW_COLOR = 'rgba(0, 212, 170, 1)';
const GLOW_COLOR_STRONG = 'rgba(0, 212, 170, 1)';

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

export const neonGlowTeal:   TextStyle = glow('0, 212, 170', 1.0, 13);
export const neonGlowBlue:   TextStyle = glow('96, 165, 250', 0.85, 10);
export const neonGlowSky:    TextStyle = glow('56, 189, 248', 0.85, 10);
export const neonGlowPurple: TextStyle = glow('167, 139, 250', 0.85, 10);
export const neonGlowPink:   TextStyle = glow('236, 72, 153', 0.85, 10);
export const neonGlowGreen:  TextStyle = glow('34, 197, 94', 0.85, 10);
export const neonGlowRed:    TextStyle = glow('239, 68, 68', 0.85, 10);
export const neonGlowAmber:  TextStyle = glow('245, 158, 11', 0.85, 10);
