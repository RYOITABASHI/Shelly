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
  // 2026-09-16: fired once by applyThemePreset() on the actual transition
  // INTO Case File (not on every re-application while already active, and
  // not on leaving it) so a top-level overlay can play a brief pseudo-boot
  // flash. Session state only — never persisted.
  caseFileBootFlash: boolean;
  triggerCaseFileBootFlash: () => void;
  clearCaseFileBootFlash: () => void;
}>((set) => ({
  version: 0,
  bumpVersion: () => set((s) => ({ version: s.version + 1 })),
  caseFileBootFlash: false,
  triggerCaseFileBootFlash: () => set({ caseFileBootFlash: true }),
  clearCaseFileBootFlash: () => set({ caseFileBootFlash: false }),
}));
