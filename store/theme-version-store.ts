// store/theme-version-store.ts
//
// Global "theme version" counter. Bumped every time applyThemePreset()
// rewrites the live colors object so consumers can re-render. Kept
// dead simple — one number, one setter — because the only subscriber
// is ShellLayout's root <View key={version}>.

import { create } from 'zustand';

export const useThemeVersionStore = create<{
  version: number;
  bumpVersion: () => void;
}>((set) => ({
  version: 0,
  bumpVersion: () => set((s) => ({ version: s.version + 1 })),
}));
