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
let currentFontFamily = 'JetBrainsMono_400Regular';
let textRenderPatched = false;
function patchTextRenderOnce() {
  if (textRenderPatched) return;
  const TextAny = Text as any;
  const original = TextAny.render;
  if (typeof original !== 'function') return;
  TextAny.render = function patchedRender(...args: any[]) {
    const elem = original.apply(this, args);
    if (!elem) return elem;
    // Force every Text through the active preset font regardless of
    // fontWeight. We previously swapped in Silkscreen-Bold for weight
    // >= 600 so native Android wouldn't fall back to system sans, but
    // the Bold variant reads as visibly chunkier than the Regular
    // variant, and mixing them across the UI looks inconsistent. The
    // trailing { fontFamily } override ensures caller-set font styles
    // can't escape the preset.
    return React.cloneElement(elem, {
      style: [{ fontFamily: currentFontFamily }, elem.props?.style, { fontFamily: currentFontFamily }],
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

export type ThemePresetId =
  | 'shelly'
  | 'silkscreen'
  | 'pixel'
  | 'mono'
  | 'dracula'
  | 'nord'
  | 'gruvbox'
  | 'tokyo-night'
  | 'catppuccin-mocha'
  | 'rose-pine'
  | 'kanagawa'
  | 'everforest'
  | 'one-dark';

export type ThemePreset = {
  id: ThemePresetId;
  font: string;
  colors: Palette;
};

// ── Shelly palette — Phase C neon-arcade refresh ────────────────────
// User direction (2026-04-20): "カラフルでネオン感ビカビカで". The previous
// mock-extracted values landed inside Tailwind 500-ish pastel range
// which reads tasteful but not LOUD. Shelly's identity is the Tokyo
// night-street arcade billboard, not a tailwind dashboard. Accents
// are pushed to pure saturated neon hues (cyan / magenta / hot pink
// / neon lime / electric yellow) so they glow instead of tint. The
// black background stays (anything else dilutes the neon).
//
// Guardrails kept:
//  - text1 stays readable (#F5F7FF), text3 stays dim enough for
//    tertiary metadata to recede
//  - background hex still pure #000 so OLED panels draw no power on
//    blank surfaces
//  - diffAdd / errorText deltas remain within WCAG AA on the black bg
export const shellyPalette: Palette = {
  bgDeep:     '#000000',
  bgSurface:  '#000000',
  bgSidebar:  '#000000',
  border:     '#1F1F2E',

  // Neon accents — each one is a distinct arcade-sign hue. Grouping:
  //   accent / accentGreen / accentBlue / accentSky are the "cool" family
  //   accentPurple / accentPink are the "hot" family
  //   accentAmber is the "warm highlight"
  accent:        '#00F0C8',  // cyan-teal — primary neon, replaces #00D4AA
  accentGreen:   '#39FF14',  // neon lime (+diff, LINKED, branch, prompts)
  accentBlue:    '#0AF0FF',  // electric cyan-blue (YOU, folder/file)
  accentSky:     '#38E1FF',  // lighter cyan (COMPONENTS, :8081 EXPO)
  accentPurple:  '#B14AFF',  // neon violet (IMPORT/FROM, CLAUDE label)
  accentPink:    '#FF2ED3',  // hot magenta-pink (strings, voice)
  accentAmber:   '#FFE500',  // neon yellow (BASH warning, RUNNING)
  accentCode:    '#0AF0FF',  // alias for accentBlue
  warning:       '#FFE500',  // alias for accentAmber

  // Text pushed to pure-ish white for the brightest possible read on
  // black. Secondary / tertiary stay cool so they recede behind the
  // neon accents rather than fighting for attention.
  text1:      '#F5F7FF',
  text2:      '#A9B0CF',
  text3:      '#5C6385',

  // Semantic — neon red-pink instead of coral; matches the "hot" accent
  // family so the error colour does not read as a fourth distinct hue.
  errorText:  '#FF3366',
  errorBg:    'rgba(255,51,102,0.14)',
  addText:    '#39FF14',
  addBg:      'rgba(57,255,20,0.14)',

  // Buttons
  btnPrimaryBg:     '#00F0C8',
  btnPrimaryText:   '#000000',
  btnSecondaryBg:   '#1A1A2E',
  btnSecondaryText: '#F5F7FF',

  // Badges — translucent fills scaled up slightly (0.15 → 0.18) so the
  // neon hue reads under the black bg without turning muddy.
  badgeRunningBg:   'rgba(255,229,0,0.18)',
  badgeRunningText: '#FFE500',
  badgeLinkedBg:    'rgba(57,255,20,0.18)',
  badgeLinkedText:  '#39FF14',
  badgeConnectBg:   '#000000',
  badgeConnectText: '#5C6385',

  // Layout buttons
  layoutActiveBg:     '#00F0C8',
  layoutActiveText:   '#000000',
  layoutInactiveBg:   '#000000',
  layoutInactiveText: '#5C6385',

  // CRT badge
  crtBadgeBg:   '#000000',
  crtBadgeText: '#00F0C8',

  // Auto-save
  autoSaveBg: '#000000',

  // Diff borders — neon lime / neon red to match add/errorText
  diffAddBorder:    '#39FF14',
  diffRemoveBorder: '#FF3366',
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

// ── Dracula (official-ish, neon-safe) ──────────────────────────────
export const draculaPalette: Palette = {
  bgDeep:     '#282A36',
  bgSurface:  '#21222C',
  bgSidebar:  '#1A1B24',
  border:     '#44475A',
  accent:        '#BD93F9',
  accentGreen:   '#50FA7B',
  accentBlue:    '#8BE9FD',
  accentSky:     '#8BE9FD',
  accentPurple:  '#BD93F9',
  accentPink:    '#FF79C6',
  accentAmber:   '#F1FA8C',
  accentCode:    '#8BE9FD',
  warning:       '#FFB86C',
  text1:      '#F8F8F2',
  text2:      '#BFBFBF',
  text3:      '#6272A4',
  errorText:  '#FF5555',
  errorBg:    'rgba(255,85,85,0.12)',
  addText:    '#50FA7B',
  addBg:      'rgba(80,250,123,0.12)',
  btnPrimaryBg:     '#BD93F9',
  btnPrimaryText:   '#282A36',
  btnSecondaryBg:   '#44475A',
  btnSecondaryText: '#F8F8F2',
  badgeRunningBg:   'rgba(255,184,108,0.15)',
  badgeRunningText: '#FFB86C',
  badgeLinkedBg:    'rgba(80,250,123,0.15)',
  badgeLinkedText:  '#50FA7B',
  badgeConnectBg:   '#21222C',
  badgeConnectText: '#6272A4',
  layoutActiveBg:     '#BD93F9',
  layoutActiveText:   '#282A36',
  layoutInactiveBg:   '#21222C',
  layoutInactiveText: '#6272A4',
  crtBadgeBg:   '#1A1B24',
  crtBadgeText: '#BD93F9',
  autoSaveBg:   '#21222C',
  diffAddBorder:    '#50FA7B',
  diffRemoveBorder: '#FF5555',
};

// ── Nord (official-ish) ────────────────────────────────────────────
export const nordPalette: Palette = {
  bgDeep:     '#2E3440',
  bgSurface:  '#3B4252',
  bgSidebar:  '#242933',
  border:     '#434C5E',
  accent:        '#88C0D0',
  accentGreen:   '#A3BE8C',
  accentBlue:    '#81A1C1',
  accentSky:     '#88C0D0',
  accentPurple:  '#B48EAD',
  accentPink:    '#B48EAD',
  accentAmber:   '#EBCB8B',
  accentCode:    '#81A1C1',
  warning:       '#EBCB8B',
  text1:      '#ECEFF4',
  text2:      '#D8DEE9',
  text3:      '#4C566A',
  errorText:  '#BF616A',
  errorBg:    'rgba(191,97,106,0.12)',
  addText:    '#A3BE8C',
  addBg:      'rgba(163,190,140,0.12)',
  btnPrimaryBg:     '#88C0D0',
  btnPrimaryText:   '#2E3440',
  btnSecondaryBg:   '#434C5E',
  btnSecondaryText: '#ECEFF4',
  badgeRunningBg:   'rgba(235,203,139,0.15)',
  badgeRunningText: '#EBCB8B',
  badgeLinkedBg:    'rgba(163,190,140,0.15)',
  badgeLinkedText:  '#A3BE8C',
  badgeConnectBg:   '#3B4252',
  badgeConnectText: '#4C566A',
  layoutActiveBg:     '#88C0D0',
  layoutActiveText:   '#2E3440',
  layoutInactiveBg:   '#3B4252',
  layoutInactiveText: '#4C566A',
  crtBadgeBg:   '#242933',
  crtBadgeText: '#88C0D0',
  autoSaveBg:   '#3B4252',
  diffAddBorder:    '#A3BE8C',
  diffRemoveBorder: '#BF616A',
};

// ── Gruvbox dark medium ────────────────────────────────────────────
export const gruvboxPalette: Palette = {
  bgDeep:     '#282828',
  bgSurface:  '#3C3836',
  bgSidebar:  '#1D2021',
  border:     '#504945',
  accent:        '#FABD2F',
  accentGreen:   '#B8BB26',
  accentBlue:    '#83A598',
  accentSky:     '#8EC07C',
  accentPurple:  '#D3869B',
  accentPink:    '#D3869B',
  accentAmber:   '#FABD2F',
  accentCode:    '#83A598',
  warning:       '#FE8019',
  text1:      '#EBDBB2',
  text2:      '#D5C4A1',
  text3:      '#7C6F64',
  errorText:  '#FB4934',
  errorBg:    'rgba(251,73,52,0.12)',
  addText:    '#B8BB26',
  addBg:      'rgba(184,187,38,0.12)',
  btnPrimaryBg:     '#FABD2F',
  btnPrimaryText:   '#282828',
  btnSecondaryBg:   '#504945',
  btnSecondaryText: '#EBDBB2',
  badgeRunningBg:   'rgba(254,128,25,0.15)',
  badgeRunningText: '#FE8019',
  badgeLinkedBg:    'rgba(184,187,38,0.15)',
  badgeLinkedText:  '#B8BB26',
  badgeConnectBg:   '#3C3836',
  badgeConnectText: '#7C6F64',
  layoutActiveBg:     '#FABD2F',
  layoutActiveText:   '#282828',
  layoutInactiveBg:   '#3C3836',
  layoutInactiveText: '#7C6F64',
  crtBadgeBg:   '#1D2021',
  crtBadgeText: '#FABD2F',
  autoSaveBg:   '#3C3836',
  diffAddBorder:    '#B8BB26',
  diffRemoveBorder: '#FB4934',
};

// ── Tokyo Night ────────────────────────────────────────────────────
export const tokyoNightPalette: Palette = {
  bgDeep:     '#1A1B26',
  bgSurface:  '#24283B',
  bgSidebar:  '#16161E',
  border:     '#414868',
  accent:        '#7AA2F7',
  accentGreen:   '#9ECE6A',
  accentBlue:    '#7AA2F7',
  accentSky:     '#7DCFFF',
  accentPurple:  '#BB9AF7',
  accentPink:    '#F7768E',
  accentAmber:   '#E0AF68',
  accentCode:    '#7AA2F7',
  warning:       '#E0AF68',
  text1:      '#C0CAF5',
  text2:      '#A9B1D6',
  text3:      '#565F89',
  errorText:  '#F7768E',
  errorBg:    'rgba(247,118,142,0.12)',
  addText:    '#9ECE6A',
  addBg:      'rgba(158,206,106,0.12)',
  btnPrimaryBg:     '#7AA2F7',
  btnPrimaryText:   '#1A1B26',
  btnSecondaryBg:   '#414868',
  btnSecondaryText: '#C0CAF5',
  badgeRunningBg:   'rgba(224,175,104,0.15)',
  badgeRunningText: '#E0AF68',
  badgeLinkedBg:    'rgba(158,206,106,0.15)',
  badgeLinkedText:  '#9ECE6A',
  badgeConnectBg:   '#24283B',
  badgeConnectText: '#565F89',
  layoutActiveBg:     '#7AA2F7',
  layoutActiveText:   '#1A1B26',
  layoutInactiveBg:   '#24283B',
  layoutInactiveText: '#565F89',
  crtBadgeBg:   '#16161E',
  crtBadgeText: '#7AA2F7',
  autoSaveBg:   '#24283B',
  diffAddBorder:    '#9ECE6A',
  diffRemoveBorder: '#F7768E',
};

// ── Catppuccin Mocha ──────────────────────────────────────────────
// Official palette from catppuccin/catppuccin — warm pastel dark that
// reads noticeably softer than Tokyo Night. Currently the most-installed
// theme in WezTerm / neovim / VSCode communities.
export const catppuccinMochaPalette: Palette = {
  bgDeep:     '#1E1E2E', // base
  bgSurface:  '#313244', // surface0
  bgSidebar:  '#181825', // mantle
  border:     '#45475A', // surface1
  accent:        '#89B4FA', // blue
  accentGreen:   '#A6E3A1', // green
  accentBlue:    '#89B4FA',
  accentSky:     '#74C7EC', // sapphire
  accentPurple:  '#CBA6F7', // mauve
  accentPink:    '#F5C2E7', // pink
  accentAmber:   '#F9E2AF', // yellow
  accentCode:    '#89B4FA',
  warning:       '#FAB387', // peach
  text1:         '#CDD6F4', // text
  text2:         '#BAC2DE', // subtext1
  text3:         '#6C7086', // overlay0
  errorText:     '#F38BA8', // red
  errorBg:       'rgba(243,139,168,0.12)',
  addText:       '#A6E3A1',
  addBg:         'rgba(166,227,161,0.12)',
  btnPrimaryBg:     '#89B4FA',
  btnPrimaryText:   '#1E1E2E',
  btnSecondaryBg:   '#45475A',
  btnSecondaryText: '#CDD6F4',
  badgeRunningBg:   'rgba(249,226,175,0.15)',
  badgeRunningText: '#F9E2AF',
  badgeLinkedBg:    'rgba(166,227,161,0.15)',
  badgeLinkedText:  '#A6E3A1',
  badgeConnectBg:   '#313244',
  badgeConnectText: '#6C7086',
  layoutActiveBg:     '#89B4FA',
  layoutActiveText:   '#1E1E2E',
  layoutInactiveBg:   '#313244',
  layoutInactiveText: '#6C7086',
  crtBadgeBg:   '#181825',
  crtBadgeText: '#89B4FA',
  autoSaveBg:   '#313244',
  diffAddBorder:    '#A6E3A1',
  diffRemoveBorder: '#F38BA8',
};

// ── Rose Pine ──────────────────────────────────────────────────────
// Official palette from rose-pine/rose-pine — muted violet base with
// peach / gold / rose accents. Lower saturation than Tokyo Night; kind
// on the eyes for long-form terminal work.
export const rosePinePalette: Palette = {
  bgDeep:     '#191724', // base
  bgSurface:  '#26233A', // overlay
  bgSidebar:  '#1F1D2E', // surface
  border:     '#403D52', // highlight med
  accent:        '#C4A7E7', // iris (violet)
  accentGreen:   '#9CCFD8', // foam (teal-green)
  accentBlue:    '#31748F', // pine
  accentSky:     '#9CCFD8',
  accentPurple:  '#C4A7E7',
  accentPink:    '#EBBCBA', // rose
  accentAmber:   '#F6C177', // gold
  accentCode:    '#C4A7E7',
  warning:       '#F6C177',
  text1:         '#E0DEF4', // text
  text2:         '#908CAA', // subtle
  text3:         '#6E6A86',
  errorText:     '#EB6F92', // love
  errorBg:       'rgba(235,111,146,0.12)',
  addText:       '#9CCFD8',
  addBg:         'rgba(156,207,216,0.12)',
  btnPrimaryBg:     '#C4A7E7',
  btnPrimaryText:   '#191724',
  btnSecondaryBg:   '#403D52',
  btnSecondaryText: '#E0DEF4',
  badgeRunningBg:   'rgba(246,193,119,0.15)',
  badgeRunningText: '#F6C177',
  badgeLinkedBg:    'rgba(156,207,216,0.15)',
  badgeLinkedText:  '#9CCFD8',
  badgeConnectBg:   '#26233A',
  badgeConnectText: '#6E6A86',
  layoutActiveBg:     '#C4A7E7',
  layoutActiveText:   '#191724',
  layoutInactiveBg:   '#26233A',
  layoutInactiveText: '#6E6A86',
  crtBadgeBg:   '#1F1D2E',
  crtBadgeText: '#C4A7E7',
  autoSaveBg:   '#26233A',
  diffAddBorder:    '#9CCFD8',
  diffRemoveBorder: '#EB6F92',
};

// ── Kanagawa ──────────────────────────────────────────────────────
// Official palette from rebelot/kanagawa.nvim "wave" variant. Sumi-ink
// bases + crystal-blue accent + sakura / surimi pops. Popular in the
// Japanese neovim community; reads as a moody, low-saturation dark.
export const kanagawaPalette: Palette = {
  bgDeep:     '#1F1F28', // sumiInk1
  bgSurface:  '#2A2A37', // sumiInk3
  bgSidebar:  '#16161D', // sumiInk0
  border:     '#363646', // sumiInk4
  accent:        '#7E9CD8', // crystalBlue
  accentGreen:   '#98BB6C', // springGreen
  accentBlue:    '#7E9CD8',
  accentSky:     '#7FB4CA', // waveBlue
  accentPurple:  '#957FB8', // oniViolet
  accentPink:    '#D27E99', // sakuraPink
  accentAmber:   '#FFA066', // surimiOrange
  accentCode:    '#7E9CD8',
  warning:       '#FFA066',
  text1:         '#DCD7BA', // fujiWhite
  text2:         '#C8C093', // oldWhite
  text3:         '#727169', // fujiGray
  errorText:     '#E82424', // samuraiRed
  errorBg:       'rgba(232,36,36,0.12)',
  addText:       '#98BB6C',
  addBg:         'rgba(152,187,108,0.12)',
  btnPrimaryBg:     '#7E9CD8',
  btnPrimaryText:   '#1F1F28',
  btnSecondaryBg:   '#363646',
  btnSecondaryText: '#DCD7BA',
  badgeRunningBg:   'rgba(255,160,102,0.15)',
  badgeRunningText: '#FFA066',
  badgeLinkedBg:    'rgba(152,187,108,0.15)',
  badgeLinkedText:  '#98BB6C',
  badgeConnectBg:   '#2A2A37',
  badgeConnectText: '#727169',
  layoutActiveBg:     '#7E9CD8',
  layoutActiveText:   '#1F1F28',
  layoutInactiveBg:   '#2A2A37',
  layoutInactiveText: '#727169',
  crtBadgeBg:   '#16161D',
  crtBadgeText: '#7E9CD8',
  autoSaveBg:   '#2A2A37',
  diffAddBorder:    '#98BB6C',
  diffRemoveBorder: '#E82424',
};

// ── Everforest ────────────────────────────────────────────────────
// Official palette from sainnhe/everforest "dark hard" variant.
// Gruvbox-adjacent but cooler and noticeably softer on the eyes —
// a common pick for long terminal / editor sessions.
export const everforestPalette: Palette = {
  bgDeep:     '#2D353B', // bg0
  bgSurface:  '#343F44', // bg1
  bgSidebar:  '#232A2E', // bg_dim
  border:     '#4A555B', // bg4
  accent:        '#A7C080', // green
  accentGreen:   '#A7C080',
  accentBlue:    '#7FBBB3', // blue
  accentSky:     '#83C092', // aqua
  accentPurple:  '#D699B6', // purple
  accentPink:    '#D699B6',
  accentAmber:   '#DBBC7F', // yellow
  accentCode:    '#7FBBB3',
  warning:       '#E69875', // orange
  text1:         '#D3C6AA', // fg
  text2:         '#9DA9A0', // grey1
  text3:         '#859289', // grey0
  errorText:     '#E67E80', // red
  errorBg:       'rgba(230,126,128,0.12)',
  addText:       '#A7C080',
  addBg:         'rgba(167,192,128,0.12)',
  btnPrimaryBg:     '#A7C080',
  btnPrimaryText:   '#2D353B',
  btnSecondaryBg:   '#4A555B',
  btnSecondaryText: '#D3C6AA',
  badgeRunningBg:   'rgba(219,188,127,0.15)',
  badgeRunningText: '#DBBC7F',
  badgeLinkedBg:    'rgba(167,192,128,0.15)',
  badgeLinkedText:  '#A7C080',
  badgeConnectBg:   '#343F44',
  badgeConnectText: '#859289',
  layoutActiveBg:     '#A7C080',
  layoutActiveText:   '#2D353B',
  layoutInactiveBg:   '#343F44',
  layoutInactiveText: '#859289',
  crtBadgeBg:   '#232A2E',
  crtBadgeText: '#A7C080',
  autoSaveBg:   '#343F44',
  diffAddBorder:    '#A7C080',
  diffRemoveBorder: '#E67E80',
};

// ── One Dark ──────────────────────────────────────────────────────
// Atom's One Dark (navarasu/onedark.nvim "dark" variant). Broadly
// familiar from GitHub / VSCode / Atom; reads more blueish than
// Dracula and without the fluorescent pop shelly/tokyo-night have.
export const oneDarkPalette: Palette = {
  bgDeep:     '#282C34', // bg0
  bgSurface:  '#2C323B', // bg1
  bgSidebar:  '#21252B', // bg_dark
  border:     '#3E4451', // bg2
  accent:        '#61AFEF', // blue
  accentGreen:   '#98C379', // green
  accentBlue:    '#61AFEF',
  accentSky:     '#56B6C2', // cyan
  accentPurple:  '#C678DD', // purple
  accentPink:    '#E06C75', // "red" used as pink tone
  accentAmber:   '#E5C07B', // yellow
  accentCode:    '#61AFEF',
  warning:       '#D19A66', // orange
  text1:         '#ABB2BF', // fg
  text2:         '#9DA5B4',
  text3:         '#5C6370', // grey
  errorText:     '#BE5046', // dark red
  errorBg:       'rgba(190,80,70,0.14)',
  addText:       '#98C379',
  addBg:         'rgba(152,195,121,0.12)',
  btnPrimaryBg:     '#61AFEF',
  btnPrimaryText:   '#282C34',
  btnSecondaryBg:   '#3E4451',
  btnSecondaryText: '#ABB2BF',
  badgeRunningBg:   'rgba(229,192,123,0.15)',
  badgeRunningText: '#E5C07B',
  badgeLinkedBg:    'rgba(152,195,121,0.15)',
  badgeLinkedText:  '#98C379',
  badgeConnectBg:   '#2C323B',
  badgeConnectText: '#5C6370',
  layoutActiveBg:     '#61AFEF',
  layoutActiveText:   '#282C34',
  layoutInactiveBg:   '#2C323B',
  layoutInactiveText: '#5C6370',
  crtBadgeBg:   '#21252B',
  crtBadgeText: '#61AFEF',
  autoSaveBg:   '#2C323B',
  diffAddBorder:    '#98C379',
  diffRemoveBorder: '#E06C75',
};

// NOTE: after bug #28, every preset except the explicit 'silkscreen' /
// 'pixel' opt-ins defaults to JetBrainsMono_400Regular so lowercase UI
// text renders as lowercase. The Silkscreen preset still ships for users
// who want the original aesthetic, but it is no longer the default.
export const themePresets: Record<ThemePresetId, ThemePreset> = {
  shelly:       { id: 'shelly',       font: 'JetBrainsMono_400Regular', colors: shellyPalette },
  silkscreen:   { id: 'silkscreen',   font: 'Silkscreen',               colors: silkscreenPalette },
  pixel:        { id: 'pixel',        font: 'PressStart2P',             colors: silkscreenPalette },
  mono:         { id: 'mono',         font: 'JetBrainsMono_400Regular', colors: silkscreenPalette },
  dracula:      { id: 'dracula',      font: 'JetBrainsMono_400Regular', colors: draculaPalette },
  nord:         { id: 'nord',         font: 'JetBrainsMono_400Regular', colors: nordPalette },
  gruvbox:      { id: 'gruvbox',      font: 'JetBrainsMono_400Regular', colors: gruvboxPalette },
  'tokyo-night':{ id: 'tokyo-night',  font: 'JetBrainsMono_400Regular', colors: tokyoNightPalette },
  'catppuccin-mocha': { id: 'catppuccin-mocha', font: 'JetBrainsMono_400Regular', colors: catppuccinMochaPalette },
  'rose-pine':  { id: 'rose-pine',    font: 'JetBrainsMono_400Regular', colors: rosePinePalette },
  kanagawa:     { id: 'kanagawa',     font: 'JetBrainsMono_400Regular', colors: kanagawaPalette },
  everforest:   { id: 'everforest',   font: 'JetBrainsMono_400Regular', colors: everforestPalette },
  'one-dark':   { id: 'one-dark',     font: 'JetBrainsMono_400Regular', colors: oneDarkPalette },
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

  // 2. Re-bind the shared neon-glow style objects. They hold
  //    textShadowColor / shadowColor values keyed to the OLD palette;
  //    refreshing mutates them in place so consumers holding a
  //    reference get the new halo on the next render. Must run BEFORE
  //    the version bump so the remount picks up fresh halos, not stale
  //    ones.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { refreshNeonGlows } = require('@/lib/neon-glow');
  refreshNeonGlows();

  // 3. Install the Text.render monkey-patch (idempotent) and update the
  //    currently-active font family. Every Text component re-renders
  //    with the new family after the version bump in step 4.
  patchTextRenderOnce();
  currentFontFamily = preset.font;

  // 4. Bump the theme version so ShellLayout forces a full re-render
  //    of the tree through its key={version} root <View>.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { useThemeVersionStore } = require('@/store/theme-version-store');
  useThemeVersionStore.getState().bumpVersion();
}
