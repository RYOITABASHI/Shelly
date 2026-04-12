/**
 * lib/neon-glow.ts — Neon glow styles for CRT terminal aesthetic
 */
import { TextStyle, ViewStyle } from 'react-native';
import { colors as C } from '@/theme.config';

const GLOW_COLOR = 'rgba(0, 212, 170, 0.6)';
const GLOW_COLOR_STRONG = 'rgba(0, 212, 170, 0.8)';

/** Subtle neon text glow for accent-colored labels */
export const neonTextGlow: TextStyle = {
  textShadowColor: GLOW_COLOR,
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: 6,
};

/** Stronger neon text glow for prominent elements */
export const neonTextGlowStrong: TextStyle = {
  textShadowColor: GLOW_COLOR_STRONG,
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: 10,
};

/** Neon glow for status dots and indicators */
export const neonDotGlow: ViewStyle = {
  shadowColor: C.accent,
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 0.7,
  shadowRadius: 4,
  elevation: 3,
};

/** Neon border glow for active elements */
export const neonBorderGlow: ViewStyle = {
  shadowColor: C.accent,
  shadowOffset: { width: 0, height: 0 },
  shadowOpacity: 0.4,
  shadowRadius: 8,
  elevation: 2,
};
