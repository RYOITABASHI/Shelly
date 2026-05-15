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
// identical shellyPalette for runtime preset swaps via Object.assign.
// Seed values match the Noir Blue preset (the new default). Existing
// users on a legacy `uiFont` (silkscreen / dracula / nord / ...) are
// migrated to 'noir-blue' at boot via settings-store loadSettings, so
// the live `colors` object will always end up reflecting one of the
// three Noir presets after applyThemePreset() runs in app/_layout.tsx.
export const colors = {
  bgDeep:     '#000000',
  bgSurface:  '#0D0D0D',
  bgSidebar:  '#0D0D0D',
  border:     '#1F1F1F',

  accent:        '#3B82F6',
  accentGreen:   '#3B82F6',
  accentBlue:    '#3B82F6',
  accentSky:     '#38BDF8',
  accentPurple:  '#A78BFA',
  accentPink:    '#EC4899',
  accentAmber:   '#F59E0B',
  accentCode:    '#60A5FA',
  warning:       '#F59E0B',

  text1:      '#FAFAFA',
  text2:      '#A1A1A1',
  text3:      '#5A5A5A',

  // Semantic
  errorText:  '#EF4444',
  errorBg:    'rgba(239,68,68,0.14)',
  addText:    '#3B82F6',
  addBg:      'rgba(59,130,246,0.14)',

  // Buttons
  btnPrimaryBg:     '#3B82F6',
  btnPrimaryText:   '#FFFFFF',
  btnSecondaryBg:   '#1A1A1A',
  btnSecondaryText: '#FAFAFA',

  // Badges
  badgeRunningBg:   'rgba(245,158,11,0.18)',
  badgeRunningText: '#F59E0B',
  badgeLinkedBg:    'rgba(59,130,246,0.18)',
  badgeLinkedText:  '#60A5FA',
  badgeConnectBg:   '#000000',
  badgeConnectText: '#5A5A5A',

  // Layout buttons
  layoutActiveBg:     '#3B82F6',
  layoutActiveText:   '#FFFFFF',
  layoutInactiveBg:   '#000000',
  layoutInactiveText: '#5A5A5A',

  // Auto-save
  autoSaveBg: '#000000',

  // Diff
  diffAddBorder:    '#3B82F6',
  diffRemoveBorder: '#EF4444',
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
  cursorColor: '#00D4AA',
  promptChar: '#00D4AA',
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
