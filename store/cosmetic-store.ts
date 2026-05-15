import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type SoundProfile = 'modern' | 'retro' | 'silent';
// Kept for type compatibility with any callsite that still references
// the cosmetic-store font field. The active UI / terminal fonts are
// now fixed (JetBrains Mono via theme-presets.ts and TerminalView), so
// `fontFamily` here is effectively decorative state.
export type FontFamily = 'jetbrains-mono' | 'fira-code' | 'source-code-pro' | 'ibm-plex-mono' | 'pixel-mplus' | 'press-start-2p' | 'silkscreen';

/**
 * Cosmetic store — wallpaper, transparency, sound, haptic.
 *
 * Phase B (2026-04-21): wallpaper + chrome transparency state.
 * - `wallpaperUri` is a file:// path copied into app document storage on
 *   pick (so it survives cache eviction) — null when no wallpaper.
 * - `wallpaperOpacity` scales the image's own alpha (0-100 → 0.0-1.0).
 *   Lower values let the theme bg bleed through for a more subtle feel.
 * - `panelOpacity` scales 0-100 → 0.0-1.0 alpha applied to Sidebar /
 *   AgentBar / PaneSlot / ContextBar backgrounds. 100 keeps the solid
 *   look users had pre-Phase-B.
 * - `blurEnabled` wraps the chrome panels in an `expo-blur` BlurView
 *   when supported; lower API levels fall back to a dimmed tint.
 * - `blurIntensity` maps 0-100 → expo-blur `intensity`.
 *
 * v5.4 design refresh (2026-05-15): the CRT scanline overlay was
 * removed. Persisted state from older builds with `crtEnabled` /
 * `crtIntensity` is harmless — the spread in `loadCosmetics` just
 * drops unknown keys via the explicit destructure below.
 */
interface CosmeticState {
  soundProfile: SoundProfile;
  fontFamily: FontFamily;
  hapticEnabled: boolean;
  isLoaded: boolean;

  // Phase B — wallpaper + transparency
  wallpaperUri: string | null;
  wallpaperOpacity: number; // 0-100
  panelOpacity: number;     // 0-100
  blurEnabled: boolean;
  blurIntensity: number;    // 0-100

  setSoundProfile: (profile: SoundProfile) => void;
  setFontFamily: (font: FontFamily) => void;
  setHapticEnabled: (enabled: boolean) => void;
  setWallpaper: (uri: string | null) => void;
  setWallpaperOpacity: (n: number) => void;
  setPanelOpacity: (n: number) => void;
  setBlurEnabled: (b: boolean) => void;
  setBlurIntensity: (n: number) => void;
  loadCosmetics: () => Promise<void>;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

export const useCosmeticStore = create<CosmeticState>((set, get) => ({
  soundProfile: 'modern',
  fontFamily: 'jetbrains-mono',
  hapticEnabled: true,
  isLoaded: false,

  // Phase B defaults: no wallpaper, panels fully opaque, blur off.
  // Users opt in from Settings → Appearance → Wallpaper.
  wallpaperUri: null,
  wallpaperOpacity: 70,
  panelOpacity: 82,
  blurEnabled: false,
  blurIntensity: 55,

  setSoundProfile: (profile) => { set({ soundProfile: profile }); persist(get()); },
  setFontFamily: (font) => { set({ fontFamily: font }); persist(get()); },
  setHapticEnabled: (enabled) => { set({ hapticEnabled: enabled }); persist(get()); },
  setWallpaper: (uri) => { set({ wallpaperUri: uri }); persist(get()); },
  setWallpaperOpacity: (n) => { set({ wallpaperOpacity: clamp(n) }); persist(get()); },
  setPanelOpacity: (n) => { set({ panelOpacity: clamp(n) }); persist(get()); },
  setBlurEnabled: (b) => { set({ blurEnabled: b }); persist(get()); },
  setBlurIntensity: (n) => { set({ blurIntensity: clamp(n) }); persist(get()); },
  loadCosmetics: async () => {
    try {
      const raw = await AsyncStorage.getItem('shelly_cosmetics');
      if (raw) {
        // Whitelist known keys so legacy persisted state (e.g. crtEnabled /
        // crtIntensity / crtFont from pre-v5.4 installs) doesn't reappear
        // in the store. Anything missing falls back to the defaults set
        // above.
        const d = JSON.parse(raw);
        const known: Partial<CosmeticState> = {
          soundProfile:     d.soundProfile,
          fontFamily:       d.fontFamily,
          hapticEnabled:    d.hapticEnabled,
          wallpaperUri:     d.wallpaperUri,
          wallpaperOpacity: d.wallpaperOpacity,
          panelOpacity:     d.panelOpacity,
          blurEnabled:      d.blurEnabled,
          blurIntensity:    d.blurIntensity,
        };
        // Drop undefined keys so they don't blow away the defaults.
        Object.keys(known).forEach((k) => {
          if ((known as any)[k] === undefined) delete (known as any)[k];
        });
        set({ ...known, isLoaded: true });
      } else {
        set({ isLoaded: true });
      }
    } catch { set({ isLoaded: true }); }
  },
}));

function persist(s: CosmeticState) {
  const {
    isLoaded,
    setSoundProfile, setFontFamily,
    setHapticEnabled, setWallpaper, setWallpaperOpacity, setPanelOpacity,
    setBlurEnabled, setBlurIntensity, loadCosmetics,
    ...data
  } = s;
  AsyncStorage.setItem('shelly_cosmetics', JSON.stringify(data)).catch(() => {});
}
