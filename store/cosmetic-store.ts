import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type SoundProfile = 'modern' | 'retro' | 'silent';
export type FontFamily = 'jetbrains-mono' | 'fira-code' | 'source-code-pro' | 'ibm-plex-mono' | 'pixel-mplus' | 'press-start-2p' | 'silkscreen';

interface CosmeticState {
  crtEnabled: boolean;
  crtIntensity: number; // 0-100
  soundProfile: SoundProfile;
  fontFamily: FontFamily;
  crtFont: FontFamily;
  hapticEnabled: boolean;
  isLoaded: boolean;

  setCrt: (enabled: boolean) => void;
  setCrtIntensity: (intensity: number) => void;
  setSoundProfile: (profile: SoundProfile) => void;
  setFontFamily: (font: FontFamily) => void;
  setCrtFont: (font: FontFamily) => void;
  setHapticEnabled: (enabled: boolean) => void;
  loadCosmetics: () => Promise<void>;
}

export const useCosmeticStore = create<CosmeticState>((set, get) => ({
  crtEnabled: true,
  crtIntensity: 11,
  soundProfile: 'modern',
  fontFamily: 'jetbrains-mono',
  crtFont: 'pixel-mplus',
  hapticEnabled: true,
  isLoaded: false,

  setCrt: (enabled) => { set({ crtEnabled: enabled }); persist(get()); },
  setCrtIntensity: (intensity) => { set({ crtIntensity: Math.max(0, Math.min(100, intensity)) }); persist(get()); },
  setSoundProfile: (profile) => { set({ soundProfile: profile }); persist(get()); },
  setFontFamily: (font) => { set({ fontFamily: font }); persist(get()); },
  setCrtFont: (font) => { set({ crtFont: font }); persist(get()); },
  setHapticEnabled: (enabled) => { set({ hapticEnabled: enabled }); persist(get()); },
  loadCosmetics: async () => {
    try {
      const raw = await AsyncStorage.getItem('shelly_cosmetics');
      if (raw) { const d = JSON.parse(raw); set({ ...d, isLoaded: true }); }
      else set({ isLoaded: true });
    } catch { set({ isLoaded: true }); }
  },
}));

function persist(s: CosmeticState) {
  const { isLoaded, setCrt, setCrtIntensity, setSoundProfile, setFontFamily, setCrtFont, setHapticEnabled, loadCosmetics, ...data } = s;
  AsyncStorage.setItem('shelly_cosmetics', JSON.stringify(data)).catch(() => {});
}
