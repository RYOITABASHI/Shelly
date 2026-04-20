/**
 * hooks/use-panel-background.ts
 *
 * Phase B helper. When a wallpaper is set, chrome panels (Sidebar,
 * AgentBar, ContextBar, PaneSlot header) swap their solid theme bg
 * for a half-alpha version of the same token so the wallpaper shows
 * through. When no wallpaper, panels stay opaque — so users who don't
 * touch Settings see the same look they had pre-Phase-B.
 *
 * Returned value is a CSS-compatible colour string; pass it straight
 * to `style={{ backgroundColor }}`.
 */
import { useCosmeticStore } from '@/store/cosmetic-store';
import { withAlpha } from '@/lib/theme-utils';

export function usePanelBackground(solidHex: string): string {
  const uri = useCosmeticStore((s) => s.wallpaperUri);
  const panelOpacity = useCosmeticStore((s) => s.panelOpacity) / 100;
  if (!uri) return solidHex;
  return withAlpha(solidHex, panelOpacity);
}
