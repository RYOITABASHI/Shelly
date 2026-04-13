// lib/theme-presets.ts
//
// Theme presets. Each preset fully describes the palette a user can flip
// between at runtime via Settings → Display → Font. theme.config.ts
// imports shellyPalette at boot; applyThemePreset mutates the live
// colors object in place so the 100+ files that already do
// `import { colors as C } from '@/theme.config'` don't need to change.
//
// Keys MUST stay aligned with the keys declared in theme.config.ts's
// `colors` export. Adding a new key? Add it here AND in theme.config.ts.

import React from 'react';
import { Text } from 'react-native';

// ── Global Text font injection ──────────────────────────────────────
// Text.defaultProps.style is REPLACED (not merged) when a child passes
// its own `style` prop, so ~100 call sites that write
// `<Text style={styles.x}>` escape the default font. Monkey-patch
// Text.render once so the injected fontFamily lives at the head of the
// style array — explicit per-site styles still win if they specify
// fontFamily themselves, but the default covers every unspecified case.
let currentFontFamily = 'Silkscreen';
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
      style: [{ fontFamily: currentFontFamily }, elem.props?.style],
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

  // CRT badge
  crtBadgeBg: string;
  crtBadgeText: string;

  // Auto-save
  autoSaveBg: string;

  // Diff
  diffAddBorder: string;
  diffRemoveBorder: string;
};

export type ThemePresetId = 'shelly' | 'silkscreen' | 'pixel' | 'mono';

export type ThemePreset = {
  id: ThemePresetId;
  font: string;
  colors: Palette;
};

// ── Shelly palette — extracted pixel-by-pixel from docs/images/mock-*.jpg ──
// This IS the mock. Do not drift without updating the spec first.
export const shellyPalette: Palette = {
  // Backgrounds (mock-exact)
  bgDeep:     '#0A0A0A',
  bgSurface:  '#111111',
  bgSidebar:  '#0D0D0D',
  border:     '#1C1C1C',

  // Accents (mock-exact — note the red/green tweaks vs silkscreen)
  accent:        '#00D4AA',  // teal — active, prompts, READING TERMINAL
  accentGreen:   '#4ADE80',  // + diff, LINKED, :3000, branch
  accentBlue:    '#60A5FA',  // YOU, folder/file, DEVICE, APP/ ls-dir
  accentSky:     '#38BDF8',  // COMPONENTS/ ls-dir, :8081 EXPO
  accentPurple:  '#A78BFA',  // IMPORT/FROM/USESTATE, CLAUDE label
  accentPink:    '#EC4899',  // string literals 'REACT'
  accentAmber:   '#F59E0B',  // BASH warning, EDIT dot, ALLOW, RUNNING
  accentCode:    '#60A5FA',  // alias for accentBlue, used by file-icon colorizer
  warning:       '#F59E0B',  // alias for accentAmber

  // Text (mock-exact, note text2 softer than silkscreen)
  text1:      '#E5E7EB',
  text2:      '#9CA3AF',
  text3:      '#6B7280',

  // Semantic (mock-exact — F87171 red instead of EF4444)
  errorText:  '#F87171',
  errorBg:    'rgba(248,113,113,0.12)',
  addText:    '#4ADE80',
  addBg:      'rgba(74,222,128,0.12)',

  // Buttons
  btnPrimaryBg:     '#00D4AA',
  btnPrimaryText:   '#000000',
  btnSecondaryBg:   '#1F2937',
  btnSecondaryText: '#E5E7EB',

  // Badges (mock-exact with translucent fills)
  badgeRunningBg:   'rgba(245,158,11,0.15)',
  badgeRunningText: '#F59E0B',
  badgeLinkedBg:    'rgba(74,222,128,0.15)',
  badgeLinkedText:  '#4ADE80',
  badgeConnectBg:   '#111111',
  badgeConnectText: '#6B7280',

  // Layout buttons
  layoutActiveBg:     '#00D4AA',
  layoutActiveText:   '#000000',
  layoutInactiveBg:   '#111111',
  layoutInactiveText: '#6B7280',

  // CRT badge
  crtBadgeBg:   '#0D0D0D',
  crtBadgeText: '#00D4AA',

  // Auto-save
  autoSaveBg: '#111827',

  // Diff borders (mock-exact)
  diffAddBorder:    '#4ADE80',
  diffRemoveBorder: '#F87171',
};

// ── Silkscreen palette — the previous static theme.config.ts values,
// preserved so switching back doesn't shift existing-user screens.
export const silkscreenPalette: Palette = {
  bgDeep:     '#0A0A0A',
  bgSurface:  '#111111',
  bgSidebar:  '#0D0D0D',
  border:     '#1C1C1C',

  accent:        '#00D4AA',
  accentGreen:   '#22C55E',
  accentBlue:    '#60A5FA',
  accentSky:     '#38BDF8',
  accentPurple:  '#A78BFA',
  accentPink:    '#EC4899',
  accentAmber:   '#F59E0B',
  accentCode:    '#60A5FA',
  warning:       '#F59E0B',

  text1:      '#E5E7EB',
  text2:      '#6B7280',
  text3:      '#374151',

  errorText:  '#EF4444',
  errorBg:    '#7F1D1D',
  addText:    '#00D4AA',
  addBg:      '#064E3B',

  btnPrimaryBg:     '#00D4AA',
  btnPrimaryText:   '#000000',
  btnSecondaryBg:   '#1F2937',
  btnSecondaryText: '#E5E7EB',

  badgeRunningBg:   '#022C22',
  badgeRunningText: '#00D4AA',
  badgeLinkedBg:    '#022C22',
  badgeLinkedText:  '#00D4AA',
  badgeConnectBg:   '#1F2937',
  badgeConnectText: '#6B7280',

  layoutActiveBg:     '#00D4AA',
  layoutActiveText:   '#000000',
  layoutInactiveBg:   '#111111',
  layoutInactiveText: '#6B7280',

  crtBadgeBg:   '#0D0D0D',
  crtBadgeText: '#00D4AA',

  autoSaveBg: '#111827',

  diffAddBorder:    '#00D4AA',
  diffRemoveBorder: '#EF4444',
};

export const themePresets: Record<ThemePresetId, ThemePreset> = {
  shelly:     { id: 'shelly',     font: 'Silkscreen',   colors: shellyPalette },
  silkscreen: { id: 'silkscreen', font: 'Silkscreen',   colors: silkscreenPalette },
  pixel:      { id: 'pixel',      font: 'PressStart2P', colors: silkscreenPalette },
  mono:       { id: 'mono',       font: 'monospace',    colors: silkscreenPalette },
};

// ── Runtime apply ──────────────────────────────────────────────────
// Lazy require() avoids the circular dependency with theme.config.ts
// (which imports shellyPalette from this file to seed its initial
// colors object).

export function applyThemePreset(id: ThemePresetId) {
  const preset = themePresets[id];
  if (!preset) return;

  // 1. Swap the live colors object fields in place.
  //    The object identity stays the same, so every
  //    `import { colors as C }` consumer sees the new values on
  //    their next render without needing a code change.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const themeConfig = require('@/theme.config');
  Object.assign(themeConfig.colors, preset.colors);

  // 2. Install the Text.render monkey-patch (idempotent) and update the
  //    currently-active font family. Every Text component re-renders
  //    with the new family after the version bump in step 3.
  patchTextRenderOnce();
  currentFontFamily = preset.font;

  // 3. Bump the theme version so ShellLayout forces a full re-render
  //    of the tree through its key={version} root <View>.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useThemeVersionStore } = require('@/store/theme-version-store');
  useThemeVersionStore.getState().bumpVersion();
}
