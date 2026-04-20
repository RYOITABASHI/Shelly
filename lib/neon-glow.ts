/**
 * lib/neon-glow.ts — Neon glow styles for CRT terminal aesthetic.
 *
 * The exported style objects are MUTATED in place by `refreshNeonGlows()`
 * on every theme swap so the halo follows the active palette. Consumers
 * that do `style={neonTextGlow}` or `style={[styles.foo, neonGlowPink]}`
 * keep working unchanged — RN reads the field values at render time, and
 * the applyThemePreset path bumps the theme-version-store which remounts
 * the whole tree under ShellLayout's `key={theme-${version}}`.
 *
 * Why mutation instead of getter / function? Most call sites pass these
 * objects as `style` props; getters on module exports don't survive
 * bundler ESM interop, and converting to `glowTextStyle('teal')` calls
 * would churn every caller (Sidebar / PaneSlot / AgentBar / …). In-place
 * mutation is surgical and keeps the existing API intact.
 */
import { TextStyle, ViewStyle } from 'react-native';
import { colors as C } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';

// Phase C (2026-04-20): pushed the teal glow up another notch so the
// Shelly identity reads as "neon arcade" rather than "teal text".
// Silkscreen's tight pixel grid tolerates radius up to ~14 before the
// letters smear; we cap at 13 for the base glow so hairline strokes
// (CLI prompt markers, status badges) still read crisply.
//
// Phase C+ (2026-04-21): glow colour made theme-aware via
// `refreshNeonGlows()` — no more hardcoded `rgba(0,240,200,*)` stuck on
// the Shelly palette when the user switches to Catppuccin / Kanagawa / …

// ── Shared accent glows ────────────────────────────────────────────

/** Subtle neon text glow for accent-colored labels */
export const neonTextGlow: TextStyle = {
  textShadowColor: withAlpha(C.accent, 1),
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: 13,
};

/** Stronger neon text glow for prominent elements */
export const neonTextGlowStrong: TextStyle = {
  textShadowColor: withAlpha(C.accent, 1),
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
// strings pink, etc). Radius trimmed on narrower hues so Silkscreen
// pixels don't smear when the accent is a softer pastel in
// low-saturation themes (Rose Pine / Everforest).

const mkGlow = (color: string, alpha: number, radius: number): TextStyle => ({
  textShadowColor: withAlpha(color, alpha),
  textShadowOffset: { width: 0, height: 0 },
  textShadowRadius: radius,
});

export const neonGlowTeal:   TextStyle = mkGlow(C.accent,       1.0,  14);
export const neonGlowBlue:   TextStyle = mkGlow(C.accentBlue,   0.95, 12);
export const neonGlowSky:    TextStyle = mkGlow(C.accentSky,    0.9,  11);
export const neonGlowPurple: TextStyle = mkGlow(C.accentPurple, 0.95, 12);
export const neonGlowPink:   TextStyle = mkGlow(C.accentPink,   1.0,  13);
export const neonGlowGreen:  TextStyle = mkGlow(C.accentGreen,  1.0,  13);
export const neonGlowRed:    TextStyle = mkGlow(C.errorText,    0.95, 12);
export const neonGlowAmber:  TextStyle = mkGlow(C.accentAmber,  1.0,  13);

// ── Theme-swap live refresh ────────────────────────────────────────

/**
 * Re-bind every glow to the CURRENT palette. Called from
 * `applyThemePreset` after it Object.assigns the new colours into
 * theme.config — we then overwrite the textShadow / shadow colour
 * fields on the existing style objects so references held by consumers
 * pick up the new halo on their next render.
 *
 * Alpha + radius values stay constant; only the colour channels shift.
 */
export function refreshNeonGlows() {
  neonTextGlow.textShadowColor = withAlpha(C.accent, 1);
  neonTextGlowStrong.textShadowColor = withAlpha(C.accent, 1);
  neonDotGlow.shadowColor = C.accent;
  neonBorderGlow.shadowColor = C.accent;

  neonGlowTeal.textShadowColor = withAlpha(C.accent, 1.0);
  neonGlowBlue.textShadowColor = withAlpha(C.accentBlue, 0.95);
  neonGlowSky.textShadowColor = withAlpha(C.accentSky, 0.9);
  neonGlowPurple.textShadowColor = withAlpha(C.accentPurple, 0.95);
  neonGlowPink.textShadowColor = withAlpha(C.accentPink, 1.0);
  neonGlowGreen.textShadowColor = withAlpha(C.accentGreen, 1.0);
  neonGlowRed.textShadowColor = withAlpha(C.errorText, 0.95);
  neonGlowAmber.textShadowColor = withAlpha(C.accentAmber, 1.0);
}
