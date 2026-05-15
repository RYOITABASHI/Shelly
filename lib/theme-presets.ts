// lib/theme-presets.ts
//
// Theme presets — Noir family (v5.4 design refresh, 2026-05-15)
//
// The visual catalogue collapsed from 15 mixed presets + variable fonts
// down to a single Noir base in three accent colours: Blue (default),
// Violet, Orange. Every preset shares the same pure-black surfaces and
// the same JetBrains Mono font; the only thing the user picks is which
// brand hue colours the wordmark, focus rings, primary buttons, prompts,
// and success / linked status.
//
// Why the cull (2026-05-15): the legacy collection (shelly / blackline /
// modal / silkscreen / pixel / mono / dracula / nord / gruvbox /
// tokyo-night / catppuccin-mocha / rose-pine / kanagawa / everforest /
// one-dark) covered too much surface, none of it really polished, and
// pulled CRT / pixel font baggage along with it. Existing users on a
// legacy id get migrated to noir-blue at boot (settings-store
// loadSettings).
//
// theme.config.ts still seeds the live `colors` object inline; we mutate
// it via `Object.assign(colors, preset.colors)` on every preset swap so
// the 100+ `import { colors as C }` callsites keep their reference.
// CRT badge tokens (`crtBadgeBg` / `crtBadgeText`) were removed alongside
// the CRT feature in this PR; nothing in the tree still reads them.

import React from 'react';
import { Text } from 'react-native';

// ── Global Text font injection ──────────────────────────────────────
// Keeps the historical monkey-patch (every Text routed through the
// active font family) but the family is now fixed to JetBrains Mono so
// the function is mainly a backstop for caller-set styles that would
// otherwise escape the project default.
const FIXED_FONT_FAMILY = 'JetBrainsMono_400Regular';
let textRenderPatched = false;
function patchTextRenderOnce() {
  if (textRenderPatched) return;
  const TextAny = Text as any;
  const original = TextAny.render;
  if (typeof original !== 'function') return;
  TextAny.render = function patchedRender(...args: any[]) {
    const elem = original.apply(this, args);
    if (!elem) return elem;
    return React.cloneElement(elem, {
      style: [{ fontFamily: FIXED_FONT_FAMILY }, elem.props?.style, { fontFamily: FIXED_FONT_FAMILY }],
    });
  };
  textRenderPatched = true;
}

export type Palette = {
  // Backgrounds
  bgDeep: string;
  bgSurface: string;
  bgSidebar: string;
  border: string;

  // Accent
  accent: string;
  accentGreen: string;
  accentBlue: string;
  accentSky: string;
  accentPurple: string;
  accentPink: string;
  accentAmber: string;
  accentCode: string;
  warning: string;

  // Text
  text1: string;
  text2: string;
  text3: string;

  // Semantic
  errorText: string;
  errorBg: string;
  addText: string;
  addBg: string;

  // Buttons
  btnPrimaryBg: string;
  btnPrimaryText: string;
  btnSecondaryBg: string;
  btnSecondaryText: string;

  // Badges
  badgeRunningBg: string;
  badgeRunningText: string;
  badgeLinkedBg: string;
  badgeLinkedText: string;
  badgeConnectBg: string;
  badgeConnectText: string;

  // Layout buttons
  layoutActiveBg: string;
  layoutActiveText: string;
  layoutInactiveBg: string;
  layoutInactiveText: string;

  // Auto-save
  autoSaveBg: string;

  // Diff
  diffAddBorder: string;
  diffRemoveBorder: string;
};

export type ThemePresetId = 'noir-blue' | 'noir-violet' | 'noir-orange';

export type ThemePreset = {
  id: ThemePresetId;
  font: string;
  colors: Palette;
};

// ── Shared Noir chrome (surfaces, neutrals, neutral status) ─────────
// Every accent picks up these so changing brand only re-tints the brand
// elements (wordmark, primary buttons, focus rings, prompts, link/
// success badges). Status indicators stay constant: amber for warning,
// red for error, pink for voice/decorative, sky for info.
const NOIR_BASE = {
  // Pure black page so OLED panels draw no power on blank surface;
  // panels step to slight grey so the layout is visually parseable
  // without colour borders.
  bgDeep:     '#000000',
  bgSurface:  '#0D0D0D',
  bgSidebar:  '#0D0D0D',
  border:     '#1F1F1F',

  text1:      '#FAFAFA',
  text2:      '#A1A1A1',
  text3:      '#5A5A5A',

  // Neutral status — same across all three accents so the UI's
  // semantic colour vocabulary (warning = amber, error = red) stays
  // stable when the user swaps brand.
  accentSky:   '#38BDF8',
  accentPink:  '#EC4899',
  accentAmber: '#F59E0B',
  warning:     '#F59E0B',
  errorText:   '#EF4444',
  errorBg:     'rgba(239,68,68,0.14)',

  // Neutral badges
  btnSecondaryBg:   '#1A1A1A',
  btnSecondaryText: '#FAFAFA',
  badgeRunningBg:   'rgba(245,158,11,0.18)',
  badgeRunningText: '#F59E0B',
  badgeConnectBg:   '#000000',
  badgeConnectText: '#5A5A5A',

  layoutInactiveBg:   '#000000',
  layoutInactiveText: '#5A5A5A',

  autoSaveBg: '#000000',

  diffRemoveBorder: '#EF4444',
} as const;

function hexToRgbTuple(hex: string): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `${r},${g},${b}`;
}

// ── Helper: build a Noir palette from a brand colour set ────────────
function noirPalette(brand: {
  accent: string;       // primary brand fill
  accentBright: string; // brighter halo / hover
  accentBlue: string;   // value for accentBlue slot (decorative)
  accentPurple: string; // value for accentPurple slot (decorative)
  textOnBrand: string;  // readable text colour on a brand-coloured surface
}): Palette {
  const accentRgb = hexToRgbTuple(brand.accent);
  return {
    ...NOIR_BASE,
    accent:           brand.accent,
    // "Success / linked / clean" semantic tracks brand — the old neon-
    // green slot is now whichever hue the user picked.
    accentGreen:      brand.accent,
    accentBlue:       brand.accentBlue,
    accentPurple:     brand.accentPurple,
    accentCode:       brand.accentBright,
    addText:          brand.accent,
    addBg:            `rgba(${accentRgb},0.14)`,
    btnPrimaryBg:     brand.accent,
    btnPrimaryText:   brand.textOnBrand,
    badgeLinkedBg:    `rgba(${accentRgb},0.18)`,
    badgeLinkedText:  brand.accentBright,
    layoutActiveBg:   brand.accent,
    layoutActiveText: brand.textOnBrand,
    diffAddBorder:    brand.accent,
  };
}

// ── Noir Blue (default) ─────────────────────────────────────────────
// Electric royal blue. Reads as "modern dev tool / Linear / Vercel".
export const noirBluePalette: Palette = noirPalette({
  accent:       '#3B82F6',
  accentBright: '#60A5FA',
  accentBlue:   '#3B82F6',
  accentPurple: '#A78BFA',
  textOnBrand:  '#FFFFFF',
});

// ── Noir Violet ─────────────────────────────────────────────────────
// Rich electric violet. Reads as "AI dev tool / Cursor / Anthropic".
export const noirVioletPalette: Palette = noirPalette({
  accent:       '#7C3AED',
  accentBright: '#A78BFA',
  accentBlue:   '#60A5FA',
  accentPurple: '#7C3AED',
  textOnBrand:  '#FFFFFF',
});

// ── Noir Orange ─────────────────────────────────────────────────────
// Red-leaning rust orange. Warm / Anthropic-adjacent without the
// danger-signal feel that pure red triggers.
export const noirOrangePalette: Palette = noirPalette({
  accent:       '#E63218',
  accentBright: '#FF5236',
  accentBlue:   '#60A5FA',
  accentPurple: '#A78BFA',
  textOnBrand:  '#FFFFFF',
});

// ── Preset registry ─────────────────────────────────────────────────
// Order here drives the AccentSection swatch ordering in the
// SettingsDropdown — Blue first because it's the default.
export const themePresets: Record<ThemePresetId, ThemePreset> = {
  'noir-blue':   { id: 'noir-blue',   font: FIXED_FONT_FAMILY, colors: noirBluePalette },
  'noir-violet': { id: 'noir-violet', font: FIXED_FONT_FAMILY, colors: noirVioletPalette },
  'noir-orange': { id: 'noir-orange', font: FIXED_FONT_FAMILY, colors: noirOrangePalette },
};

// Backwards-compat: a couple of historical callsites (and the legacy
// spec docs) reach for `shellyPalette` by name. We keep the symbol
// pointing at the new default so module-load consumers see sane values
// without runtime errors. New code should reach for `noirBluePalette`
// (or the brand-specific palette) directly.
export const shellyPalette: Palette = noirBluePalette;

// ── Runtime apply ──────────────────────────────────────────────────
// Lazy require() avoids the circular dependency with theme.config.ts
// (which inlines the seed palette to dodge the tailwind.config.js
// CommonJS require() boundary — see notes in theme.config.ts).

export function applyThemePreset(id: ThemePresetId) {
  const preset = themePresets[id];
  if (!preset) return;

  // 1. Swap the live `colors` object fields in place. Object identity
  //    stays the same so the 100+ static `import { colors as C }`
  //    consumers see the new values on their next render.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const themeConfig = require('@/theme.config');
  Object.assign(themeConfig.colors, preset.colors);

  // 2. Re-bind the shared neon-glow style objects keyed to the OLD
  //    palette. Mutating in place keeps existing style references
  //    pointing at fresh halos. Must run BEFORE the version bump.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { refreshNeonGlows } = require('@/lib/neon-glow');
  refreshNeonGlows();

  // 3. Idempotent install of the Text.render font monkey-patch. The
  //    font family is constant now, but the patch still defends
  //    against components that pass a `style` array overriding the
  //    project default.
  patchTextRenderOnce();

  // 4. Bump the theme version so ShellLayout forces a full re-render of
  //    the tree through its key={version} root <View>.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useThemeVersionStore } = require('@/store/theme-version-store');
  useThemeVersionStore.getState().bumpVersion();
}
