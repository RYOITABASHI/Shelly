import { useMemo } from 'react';
import { getLiveThemeColors, type ThemeColorPalette } from '@/lib/theme';
import { useThemeVersionStore } from '@/store/theme-version-store';

/**
 * Provides the resolved theme color palette for components.
 * All components should use this instead of hardcoded color values.
 *
 * Usage:
 *   const { colors } = useTheme();
 *   <View style={{ backgroundColor: colors.surface }} />
 *
 * LIVE palette (2026-10-09): subscribes to theme-version-store, which every
 * applyThemePreset() / applyUiFont() bumps, and returns a fresh `colors`
 * object identity per version. Previously this memoized `Colors.dark` once
 * per mount (deps []), so consumers that derived memoized styles from it
 * (useMemo(() => makeStyles(colors), [colors])) — and any surface outside
 * ShellLayout's key={version} remount (Modals, sheets) — kept the dark
 * seed palette under the light Case File preset.
 */
export function useTheme(): { colors: ThemeColorPalette } {
  const version = useThemeVersionStore((s) => s.version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ({ colors: getLiveThemeColors() }), [version]);
}
