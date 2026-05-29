// theme.config.ts — Single source of truth for all design tokens
// Extracted from mock screenshots. Every component imports from here.
//
// `colors` is now a MUTABLE object seeded from the Shelly preset. At
// runtime, applyThemePreset() (lib/theme-presets.ts) calls
// Object.assign(colors, newPalette) to swap values in place. Consumers
// keep the same object reference so the 100+ `import { colors as C }`
// call sites do not need to change.

// ─── Colors ─────────────────────────────────────────────────────────────────

// NOTE: no imports on purpose. tailwind.config.js does a plain
// CommonJS require() of this file during Metro bundling, and sucrase
// on this project's version chokes on any TS-style import in the top
// of theme.config.ts (column 8 parse error, regardless of `import
// type` vs `import {}`). So keep this file import-free. Mutable
// palette object is seeded inline here; lib/theme-presets.ts holds the
// matching Unit-00 bluePalette for runtime preset swaps via Object.assign.
export const colors = {
  bgDeep:     '#000000',
  bgSurface:  '#000000',
  bgSidebar:  '#000000',
  border:     '#143A52',

  accent:        '#1CA9E0',
  accentGreen:   '#2BD9C4',
  accentBlue:    '#1CA9E0',
  accentSky:     '#5CC8F0',
  accentPurple:  '#6FA8D8',
  accentPink:    '#4FD0E0',
  accentAmber:   '#F2B705',
  accentCode:    '#5CC8F0',
  warning:       '#F2B705',

  text1:      '#D6ECF7',
  text2:      '#7FA8C4',
  text3:      '#3E5A70',

  // Semantic
  errorText:  '#FF5A3C',
  errorBg:    'rgba(255,90,60,0.14)',
  addText:    '#2BD9C4',
  addBg:      'rgba(43,217,196,0.14)',

  // Buttons
  btnPrimaryBg:     '#1CA9E0',
  btnPrimaryText:   '#000000',
  btnSecondaryBg:   '#0A1620',
  btnSecondaryText: '#D6ECF7',

  // Badges
  badgeRunningBg:   'rgba(242,183,5,0.18)',
  badgeRunningText: '#F2B705',
  badgeLinkedBg:    'rgba(43,217,196,0.18)',
  badgeLinkedText:  '#2BD9C4',
  badgeConnectBg:   '#000000',
  badgeConnectText: '#3E5A70',

  // Layout buttons
  layoutActiveBg:     '#1CA9E0',
  layoutActiveText:   '#000000',
  layoutInactiveBg:   '#000000',
  layoutInactiveText: '#3E5A70',

  // CRT badge
  crtBadgeBg:   '#000000',
  crtBadgeText: '#1CA9E0',

  // Auto-save
  autoSaveBg: '#000000',

  // Diff
  diffAddBorder:    '#2BD9C4',
  diffRemoveBorder: '#FF5A3C',
};

// ─── Fonts ──────────────────────────────────────────────────────────────────

export const fonts = {
  // Default UI font — JetBrains Mono for real lowercase glyphs and a
  // shared aesthetic with the terminal. Silkscreen used to be the default
  // but renders lowercase as uppercase by design (bug #28). Users can
  // override via Settings → Display → Font.
  family: 'JetBrainsMono_400Regular',

  // PressStart2P is an 8x8 pixel font, so each unit reads about 1.4× a normal
  // monospace pixel. These sizes were tuned down from 10/9/8 because the
  // mock-1 ratios were drowning the actual content.
  agentTab:       { size: 8, weight: '700' as const },
  paneHeader:     { size: 8, weight: '700' as const },
  sidebarSection: { size: 8, weight: '700' as const, letterSpacing: 0.4 },
  sidebarItem:    { size: 7, weight: '500' as const },
  fileName:       { size: 7, weight: '400' as const },
  badge:          { size: 6, weight: '700' as const },
  contextBar:     { size: 7, weight: '500' as const },
  layoutButton:   { size: 7, weight: '700' as const },
  tip:            { size: 7, weight: '400' as const },
} as const;

// ─── Sizes ──────────────────────────────────────────────────────────────────

export const sizes = {
  agentBarHeight: 28,
  paneHeaderHeight: 24,
  layoutBarHeight: 32,
  sidebarWidth: 156,
  // Tightened rows — mock renders much denser than the original 20/22 px.
  sidebarItemHeight: 16,
  sidebarSectionHeaderHeight: 18,
  agentDotSize: 5,
  borderWidth: 1,
  contextBarHeight: 18,
} as const;

// ─── Padding ────────────────────────────────────────────────────────────────

export const padding = {
  agentBar:     { px: 5 },
  agentTab:     { px: 8, py: 4 },
  paneHeader:   { px: 6 },
  // Tighter sidebar rows — py dropped from 3 to 1 for denser stacking.
  sidebarItem:  { px: 10, py: 1 },
  layoutButton: { px: 10, py: 4, gap: 5 },
  statusBadge:  { px: 5, py: 2 },
} as const;

// ─── Radii ──────────────────────────────────────────────────────────────────

export const radii = {
  agentTab: 4,
  layoutButton: 4,
  badge: 3,
  paneHeader: 0,
  actionButton: 3,  // ALLOW/DENY/ACCEPT/REJECT
} as const;

// ─── Icons ──────────────────────────────────────────────────────────────────

export const icons = {
  sidebarArrow: 6,
  fileIcon: 12,
  externalLink: 10,
} as const;

// ─── Diff / Decorations ────────────────────────────────────────────────────

export const decorations = {
  diffBorderWidth: 2,
  cursorColor: '#1CA9E0',
  promptChar: '#1CA9E0',
} as const;

// ─── Legacy compat — themeColors used by theme-engine.ts ────────────────────
// Maps the new tokens into the old light/dark format consumed by useTheme().

export const themeColors = {
  primary:        { light: colors.accent,      dark: colors.accent },
  background:     { light: colors.bgDeep,      dark: colors.bgDeep },
  backgroundDeep: { light: colors.bgDeep,      dark: colors.bgDeep },
  surface:        { light: colors.bgSurface,   dark: colors.bgSurface },
  surfaceHigh:    { light: colors.bgSidebar,   dark: colors.bgSidebar },
  surface2:       { light: colors.btnSecondaryBg, dark: colors.btnSecondaryBg },

  foreground:     { light: colors.text1,       dark: colors.text1 },
  foregroundDim:  { light: colors.text1,       dark: colors.text1 },
  muted:          { light: colors.text2,       dark: colors.text2 },
  inactive:       { light: colors.text3,       dark: colors.text3 },
  hint:           { light: colors.text3,       dark: colors.text3 },

  border:         { light: colors.border,      dark: colors.border },
  borderLight:    { light: colors.border,      dark: colors.border },
  borderHeavy:    { light: '#333333',          dark: '#333333' },

  success:        { light: colors.accentGreen, dark: colors.accentGreen },
  warning:        { light: colors.warning,     dark: colors.warning },
  error:          { light: colors.errorText,   dark: colors.errorText },

  accent:         { light: colors.accent,      dark: colors.accent },
  prompt:         { light: colors.accent,      dark: colors.accent },
  command:        { light: '#93C5FD',          dark: '#93C5FD' },
  tint:           { light: colors.accent,      dark: colors.accent },
  link:           { light: '#60A5FA',          dark: '#60A5FA' },

  aiPurple:       { light: '#8B5CF6',          dark: '#8B5CF6' },
  interpretPurple:{ light: '#A78BFA',          dark: '#A78BFA' },
  interpretText:  { light: '#C4B5FD',          dark: '#C4B5FD' },

  keyLabel:       { light: '#B0B8C1',          dark: '#B0B8C1' },
  infoText:       { light: '#9BA1A6',          dark: '#9BA1A6' },
} as const;
