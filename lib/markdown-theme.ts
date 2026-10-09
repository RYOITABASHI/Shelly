/**
 * lib/markdown-theme.ts — live-palette ink for react-native-markdown-display.
 *
 * Bug (build 2498, Case File preset): MarkdownPane hardcoded '#ECEDEE' /
 * '#FFFFFF' for paragraph / list_item / td / em / strong / code_block, i.e.
 * near-white "dark theme" ink, so body text all but vanished on the cream
 * background while headings (theme accent) stayed dark. useTheme() from
 * lib/theme-engine / hooks/use-theme also can't be trusted here: their
 * palettes are copied from theme.config at module load (dark seed) and
 * never see applyThemePreset()'s in-place Object.assign.
 *
 * Read the live `colors` object from '@/theme.config' at render time
 * instead (callers subscribe to useThemeVersion() so a preset swap
 * re-renders them).
 */
import { colors as C } from '@/theme.config';

export type MarkdownInk = {
  foreground: string;
  muted: string;
  accent: string;
  surface: string;
  border: string;
  background: string;
};

/** Snapshot of the CURRENT preset palette — call during render, not at module load. */
export function getMarkdownInk(): MarkdownInk {
  return {
    foreground: C.text1,
    muted: C.text2,
    accent: C.accent,
    surface: C.bgSurface,
    border: C.border,
    background: C.bgDeep,
  };
}
