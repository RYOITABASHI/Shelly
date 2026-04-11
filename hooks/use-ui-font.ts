/**
 * hooks/use-ui-font.ts — Resolve UI font family from settings.
 *
 * Returns 'PixelMplus12' when uiFont='pixel', 'monospace' otherwise.
 * All UI components should use this instead of hardcoding fontFamily.
 */
import { useSettingsStore } from '@/store/settings-store';

export function useUIFont(): string {
  const uiFont = useSettingsStore((s) => s.settings.uiFont ?? 'pixel');
  return uiFont === 'pixel' ? 'GeistPixel-Square' : 'monospace';
}

/** Non-hook version for StyleSheet.create or outside React */
export function getUIFont(): string {
  const uiFont = useSettingsStore.getState().settings.uiFont ?? 'pixel';
  return uiFont === 'pixel' ? 'GeistPixel-Square' : 'monospace';
}
