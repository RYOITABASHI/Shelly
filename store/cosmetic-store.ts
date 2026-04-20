import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type SoundProfile = 'modern' | 'retro' | 'silent';
export type FontFamily = 'jetbrains-mono' | 'fira-code' | 'source-code-pro' | 'ibm-plex-mono' | 'pixel-mplus' | 'press-start-2p' | 'silkscreen';

/**
 * Phase B (2026-04-21) — wallpaper + chrome transparency state.
 *
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
 * CRT conflict: the scanline overlay reads weirdly over a user photo,
 * so we expose both toggles independently but Settings warns when the
 * user tries to enable CRT while a wallpaper is set.
 */
interface CosmeticState {
  crtEnabled: boolean;
  crtIntensity: number; // 0-100
  soundProfile: SoundProfile;
  fontFamily: FontFamily;
  crtFont: FontFamily;
  hapticEnabled: boolean;
  isLoaded: boolean;

  // Phase B — wallpaper + transparency
  wallpaperUri: string | null;
  wallpaperOpacity: number; // 0-100
  panelOpacity: number;     // 0-100
  blurEnabled: boolean;
  blurIntensity: number;    // 0-100

  setCrt: (enabled: boolean) => void;
  setCrtIntensity: (intensity: number) => void;
  setSoundProfile: (profile: SoundProfile) => void;
  setFontFamily: (font: FontFamily) => void;
  setCrtFont: (font: FontFamily) => void;
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
  // Phase C (2026-04-20): CRT defaults to OFF. Scanlines + phosphor
  // tint are opt-in now — users who want the retro look toggle from
  // Settings. Keeps the default install looking modern and stops
  // surprising users who later switch to Tokyo Night / Catppuccin.
  // Intensity seeded at a visible 35 (old 11 was nearly invisible) so
  // when users DO flip the switch they see an immediate effect.
  crtEnabled: false,
  crtIntensity: 35,
  soundProfile: 'modern',
  fontFamily: 'jetbrains-mono',
  crtFont: 'pixel-mplus',
  hapticEnabled: true,
  isLoaded: false,

  // Phase B defaults: no wallpaper, panels fully opaque, blur off.
  // Users opt in from Settings → Appearance → Wallpaper.
  wallpaperUri: null,
  wallpaperOpacity: 70,
  panelOpacity: 82,
  blurEnabled: false,
  blurIntensity: 55,

  setCrt: (enabled) => { set({ crtEnabled: enabled }); persist(get()); },
  setCrtIntensity: (intensity) => { set({ crtIntensity: clamp(intensity) }); persist(get()); },
  setSoundProfile: (profile) => { set({ soundProfile: profile }); persist(get()); },
  setFontFamily: (font) => { set({ fontFamily: font }); persist(get()); },
  setCrtFont: (font) => { set({ crtFont: font }); persist(get()); },
  setHapticEnabled: (enabled) => { set({ hapticEnabled: enabled }); persist(get()); },
  setWallpaper: (uri) => { set({ wallpaperUri: uri }); persist(get()); },
  setWallpaperOpacity: (n) => { set({ wallpaperOpacity: clamp(n) }); persist(get()); },
  setPanelOpacity: (n) => { set({ panelOpacity: clamp(n) }); persist(get()); },
  setBlurEnabled: (b) => { set({ blurEnabled: b }); persist(get()); },
  setBlurIntensity: (n) => { set({ blurIntensity: clamp(n) }); persist(get()); },
  loadCosmetics: async () => {
    try {
      const raw = await AsyncStorage.getItem('shelly_cosmetics');
      if (raw) { const d = JSON.parse(raw); set({ ...d, isLoaded: true }); }
      else set({ isLoaded: true });
    } catch { set({ isLoaded: true }); }
  },
}));

function persist(s: CosmeticState) {
  const {
    isLoaded,
    setCrt, setCrtIntensity, setSoundProfile, setFontFamily, setCrtFont,
    setHapticEnabled, setWallpaper, setWallpaperOpacity, setPanelOpacity,
    setBlurEnabled, setBlurIntensity, loadCosmetics,
    ...data
  } = s;
  AsyncStorage.setItem('shelly_cosmetics', JSON.stringify(data)).catch(() => {});
}
