// theme.config.ts — Single source of truth for all design tokens
// Extracted from mock screenshots. Every component imports from here.

// ─── Colors ─────────────────────────────────────────────────────────────────

export const colors = {
  // Backgrounds
  bgDeep: '#0A0A0A',        // deepest background
  bgSurface: '#111111',     // pane backgrounds, cards
  bgSidebar: '#0D0D0D',     // sidebar, agentbar, contextbar
  border: '#1C1C1C',        // standard border

  // Accent
  accent: '#00D4AA',        // primary accent (cyan)
  accentGreen: '#22C55E',   // running dot green
  warning: '#F59E0B',       // ⚠ warning amber

  // Text
  text1: '#E5E7EB',         // main text
  text2: '#6B7280',         // sub text, labels
  text3: '#374151',         // muted, tip text

  // Semantic
  errorText: '#EF4444',     // error / delete line text
  errorBg: '#7F1D1D',       // delete line background
  addText: '#00D4AA',       // add line text
  addBg: '#064E3B',         // add line background

  // Buttons
  btnPrimaryBg: '#00D4AA',
  btnPrimaryText: '#000000',
  btnSecondaryBg: '#1F2937',
  btnSecondaryText: '#E5E7EB',

  // Badges
  badgeRunningBg: '#022C22',
  badgeRunningText: '#00D4AA',
  badgeLinkedBg: '#022C22',
  badgeLinkedText: '#00D4AA',
  badgeConnectBg: '#1F2937',
  badgeConnectText: '#6B7280',

  // Layout buttons
  layoutActiveBg: '#00D4AA',
  layoutActiveText: '#000000',
  layoutInactiveBg: '#111111',
  layoutInactiveText: '#6B7280',

  // CRT badge
  crtBadgeBg: '#0D0D0D',
  crtBadgeText: '#00D4AA',

  // Auto-save row
  autoSaveBg: '#111827',

  // Diff
  diffAddBorder: '#00D4AA',
  diffRemoveBorder: '#EF4444',
} as const;

// ─── Fonts ──────────────────────────────────────────────────────────────────

export const fonts = {
  family: 'PressStart2P',

  agentTab:       { size: 10, weight: '700' as const },
  paneHeader:     { size: 10, weight: '700' as const },
  sidebarSection: { size: 10, weight: '700' as const, letterSpacing: 0.5 }, // 0.05em ≈ 0.5px at 10px
  sidebarItem:    { size: 10, weight: '500' as const },
  fileName:       { size: 10, weight: '400' as const },
  badge:          { size: 8,  weight: '700' as const },
  contextBar:     { size: 9,  weight: '500' as const },
  layoutButton:   { size: 9,  weight: '700' as const },
  tip:            { size: 9,  weight: '400' as const },
} as const;

// ─── Sizes ──────────────────────────────────────────────────────────────────

export const sizes = {
  agentBarHeight: 32,
  paneHeaderHeight: 28,
  layoutBarHeight: 36,
  sidebarWidth: 180,
  sidebarItemHeight: 24,
  sidebarSectionHeaderHeight: 28,
  agentDotSize: 6,
  borderWidth: 1,
  contextBarHeight: 24,
} as const;

// ─── Padding ────────────────────────────────────────────────────────────────

export const padding = {
  agentBar:     { px: 6 },
  agentTab:     { px: 10, py: 6 },
  paneHeader:   { px: 8 },
  sidebarItem:  { px: 12, py: 4 },
  layoutButton: { px: 12, py: 5, gap: 6 },
  statusBadge:  { px: 6, py: 2 },
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
