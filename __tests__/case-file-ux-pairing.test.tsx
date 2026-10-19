/**
 * Case File pairs a block cursor + "retro" sound profile when the user
 * switches INTO it. Now that Case File is the default preset, that pairing
 * must not run on the boot-time apply or on same-preset re-applies, or a
 * cursor/sound the user changed while on Case File is reset every launch.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { addListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('@/lib/ai-edit', () => ({ getStagedEdit: jest.fn(), acceptStagedDiff: jest.fn() }));
jest.mock('@/lib/sounds', () => ({ playSound: jest.fn() }));

import { act } from '@testing-library/react-native';
import { applyThemePreset } from '@/lib/theme-presets';
import { useSettingsStore } from '@/store/settings-store';
import { useCosmeticStore } from '@/store/cosmetic-store';

describe('Case File cursor/sound pairing', () => {
  it('keeps the user\'s cursor and sound on boot and same-preset re-applies, pairs only on a real switch', () => {
    act(() => {
      useSettingsStore.getState().updateSettings({ cursorShape: 'bar' });
      useCosmeticStore.getState().setSoundProfile('modern');
    });

    // Boot-time apply of the persisted (default) preset, then a re-apply
    // such as the one fired when fonts finish loading.
    act(() => applyThemePreset('case-file'));
    act(() => applyThemePreset('case-file'));
    expect(useSettingsStore.getState().settings.cursorShape).toBe('bar');
    expect(useCosmeticStore.getState().soundProfile).toBe('modern');

    // A real switch away and back in pairs block + retro...
    act(() => applyThemePreset('blue'));
    act(() => applyThemePreset('case-file'));
    expect(useSettingsStore.getState().settings.cursorShape).toBe('block');
    expect(useCosmeticStore.getState().soundProfile).toBe('retro');

    // ...and leaving again restores what was there before the switch.
    act(() => applyThemePreset('blue'));
    expect(useSettingsStore.getState().settings.cursorShape).toBe('bar');
    expect(useCosmeticStore.getState().soundProfile).toBe('modern');
  });
});
