/**
 * lib/neon-glow.ts — Neon glow styles for CRT terminal aesthetic
 */
import { TextStyle, ViewStyle } from 'react-native';
import { colors as C } from '@/theme.config';

// Punched up from alpha 0.6 / radius 6 so the teal accent text actually
// reads as a CRT neon glow on-screen instead of a faint tint. Silkscreen's
// tight pixel grid lets us push radius up to ~10 before the letters blur.
const GLOW_COLOR = 'rgba(0, 212, 170, 0.95)';
const GLOW_COLOR_STRONG = 'rgba(0, 212, 170, 1)';

/** Subtle neon text glow for accent-colored labels */
export const neonTextGlow: TextStyle = {
  textShadowColor: GLOW_COLOR,
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: 10,
};

/** Stronger neon text glow for prominent elements */
export const neonTextGlowStrong: TextStyle = {
  textShadowColor: GLOW_COLOR_STRONG,
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: 14,
};

/** Neon glow for status dots and indicators */
export const neonDotGlow: ViewStyle = {
  shadowColor: C.accent,
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 1,
  shadowRadius: 8,
  elevation: 6,
};

/** Neon border glow for active elements */
export const neonBorderGlow: ViewStyle = {
  shadowColor: C.accent,
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 0.7,
  shadowRadius: 12,
  elevation: 4,
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

export const neonGlowTeal:   TextStyle = glow('0, 212, 170', 0.95, 10);
export const neonGlowBlue:   TextStyle = glow('96, 165, 250', 0.6, 6);
export const neonGlowSky:    TextStyle = glow('56, 189, 248', 0.55, 5);
export const neonGlowPurple: TextStyle = glow('167, 139, 250', 0.55, 5);
export const neonGlowPink:   TextStyle = glow('236, 72, 153', 0.5, 5);
export const neonGlowGreen:  TextStyle = glow('34, 197, 94', 0.6, 6);
export const neonGlowRed:    TextStyle = glow('239, 68, 68', 0.55, 5);
export const neonGlowAmber:  TextStyle = glow('245, 158, 11', 0.55, 6);
