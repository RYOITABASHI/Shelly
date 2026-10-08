/**
 * components/CaseFileBootOverlay.tsx — the overlay must ALWAYS disappear
 * within CASE_FILE_BOOT_FLASH_MAX_MS of appearing (2026-10-08 build 2478
 * regression: it stuck on screen indefinitely after a cold start, because a
 * theme-version remount mid-fade let a stale fade callback clear the store
 * flag, which re-ran the `active` effect whose cleanup killed the hide timer
 * while `visible` stayed true).
 */
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { Animated, View } from 'react-native';
import { useThemeVersionStore } from '@/store/theme-version-store';
import { CaseFileBootOverlay, CASE_FILE_BOOT_FLASH_MAX_MS } from '@/components/CaseFileBootOverlay';

jest.mock('@/theme.config', () => ({ fonts: { family: 'monospace' } }));

const BOOT_TEXT = 'SHELLY CASE FILE SYSTEM v1.0';

function Host({ k }: { k: number }) {
  // Mirrors ShellLayout's key={`theme-${version}`} root remount.
  return (
    <View key={`theme-${k}`}>
      <CaseFileBootOverlay />
    </View>
  );
}

describe('CaseFileBootOverlay', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useThemeVersionStore.setState({ caseFileBootFlash: false, version: 0 });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('shows on trigger and hides after the flash', () => {
    const r = render(<Host k={0} />);
    expect(r.queryByText(BOOT_TEXT)).toBeNull();
    act(() => useThemeVersionStore.getState().triggerCaseFileBootFlash());
    expect(r.queryByText(BOOT_TEXT)).not.toBeNull();
    // Flag is consumed immediately so remounts cannot replay it.
    expect(useThemeVersionStore.getState().caseFileBootFlash).toBe(false);
    act(() => { jest.advanceTimersByTime(CASE_FILE_BOOT_FLASH_MAX_MS); });
    expect(r.queryByText(BOOT_TEXT)).toBeNull();
  });

  it('double activation does not extend or wedge the flash', () => {
    const r = render(<Host k={0} />);
    act(() => useThemeVersionStore.getState().triggerCaseFileBootFlash());
    act(() => { jest.advanceTimersByTime(600); });
    act(() => useThemeVersionStore.getState().triggerCaseFileBootFlash());
    expect(r.queryByText(BOOT_TEXT)).not.toBeNull();
    act(() => { jest.advanceTimersByTime(CASE_FILE_BOOT_FLASH_MAX_MS - 600); });
    expect(r.queryByText(BOOT_TEXT)).toBeNull();
    expect(useThemeVersionStore.getState().caseFileBootFlash).toBe(false);
  });

  it('remount mid-flash (theme-version key bump) never leaves it stuck', () => {
    const r = render(<Host k={0} />);
    act(() => useThemeVersionStore.getState().triggerCaseFileBootFlash());
    act(() => { jest.advanceTimersByTime(1150); }); // mid-fade
    r.rerender(<Host k={1} />);
    // A stale flag clear arriving after the remount (the build-2478 path).
    act(() => useThemeVersionStore.getState().clearCaseFileBootFlash());
    act(() => { jest.advanceTimersByTime(CASE_FILE_BOOT_FLASH_MAX_MS); });
    expect(r.queryByText(BOOT_TEXT)).toBeNull();
  });

  it('remount while the flag is still set shows at most one bounded flash', () => {
    useThemeVersionStore.setState({ caseFileBootFlash: true });
    const r = render(<Host k={0} />);
    expect(r.queryByText(BOOT_TEXT)).not.toBeNull();
    r.rerender(<Host k={1} />);
    act(() => { jest.advanceTimersByTime(CASE_FILE_BOOT_FLASH_MAX_MS); });
    expect(r.queryByText(BOOT_TEXT)).toBeNull();
  });

  it('hides via the hard fallback even if the fade animation never completes', () => {
    const realTiming = Animated.timing;
    jest.spyOn(Animated, 'timing').mockImplementation((value, config) => {
      const anim = realTiming(value, config);
      return { ...anim, start: () => { /* completion callback never fires */ } };
    });
    const r = render(<Host k={0} />);
    act(() => useThemeVersionStore.getState().triggerCaseFileBootFlash());
    act(() => { jest.advanceTimersByTime(CASE_FILE_BOOT_FLASH_MAX_MS - 1); });
    expect(r.queryByText(BOOT_TEXT)).not.toBeNull();
    act(() => { jest.advanceTimersByTime(1); });
    expect(r.queryByText(BOOT_TEXT)).toBeNull();
  });

  it('flag clear while visible does not cancel the hide (old effect-cleanup bug)', () => {
    const r = render(<Host k={0} />);
    act(() => useThemeVersionStore.getState().triggerCaseFileBootFlash());
    act(() => useThemeVersionStore.getState().clearCaseFileBootFlash());
    act(() => { jest.advanceTimersByTime(CASE_FILE_BOOT_FLASH_MAX_MS); });
    expect(r.queryByText(BOOT_TEXT)).toBeNull();
  });
});
