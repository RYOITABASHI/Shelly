/**
 * components/BackgroundLayer.tsx
 *
 * Phase B (2026-04-21) root-level background layer. Mounts beneath the
 * rest of the ShellLayout tree and paints either:
 *   - the theme's flat bg colour (default — no wallpaper set), or
 *   - a user-picked image with a configurable opacity, composited over
 *     a solid theme colour so themes with `bgDeep` that's not pure
 *     black still tint the exposed fringes of the image.
 *
 * The wallpaper URI is a `file://` path in app document storage (set
 * via `cosmetic-store.setWallpaper`). We don't ship any default assets
 * — users pick from their own gallery through the Settings UI.
 *
 * Perf notes:
 *   - `Image` from react-native is cached natively. We don't use
 *     FastImage / expo-image here because this view mounts once at app
 *     launch and the URI changes only on user action.
 *   - No BlurView here. Blur is layered on the individual chrome panels
 *     (Sidebar / AgentBar / ContextBar / PaneSlot) so the blur radius
 *     applies to what's behind THOSE panels, not the wallpaper itself.
 *     Blurring the wallpaper directly would defeat its purpose.
 */
import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
import { useCosmeticStore } from '@/store/cosmetic-store';
import { colors as C } from '@/theme.config';

export function BackgroundLayer() {
  const uri = useCosmeticStore((s) => s.wallpaperUri);
  const opacity = useCosmeticStore((s) => s.wallpaperOpacity) / 100;

  return (
    <View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { backgroundColor: C.bgDeep }]}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={[StyleSheet.absoluteFill, { opacity }]}
          resizeMode="cover"
        />
      ) : null}
    </View>
  );
}
