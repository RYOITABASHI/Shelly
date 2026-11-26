import { useWindowDimensions } from 'react-native';
import { createContext, useContext, useMemo } from 'react';

/**
 * Authoritative root size, measured via `onLayout` on the app's root View
 * (see ShellLayout.tsx) and provided through this context.
 *
 * bug fold-layout: on Android, `android:configChanges` includes `density` /
 * `screenSize` (plugins/with-multi-window.js) so the Activity is never
 * recreated across a Z Fold6 fold/unfold. React Native's `Dimensions` /
 * `useWindowDimensions()` are only refreshed by a native `didUpdateDimensions`
 * event that RN's DeviceInfoModule emits from `onHostResume()` when the OS
 * font scale changes — a plain fold/unfold configuration change never fires
 * it, so `useWindowDimensions()` keeps reporting whatever size was current
 * at last launch/resume. The root View's `onLayout` size is not subject to
 * that gap (Android always re-measures the real view tree), so ShellLayout
 * publishes it here and every other `useDeviceLayout()` caller prefers it
 * over the native Dimensions constant.
 */
export const DeviceLayoutSizeContext = createContext<{ width: number; height: number } | null>(null);

export type DeviceLayout = {
  isLandscape: boolean;
  /** Wide screen (tablet, foldable inner, desktop browser) — width >= 600dp */
  isWide: boolean;
  /** Compact screen (small phone, foldable cover) — width < 380dp */
  isCompact: boolean;
  /** Use side-by-side split layout (wide + landscape) */
  useSplitLayout: boolean;
  width: number;
  height: number;
  // Adaptive values
  fontSize: number;
  terminalFlex: number;

  // Legacy compat aliases (used by existing code)
  isFoldInner: boolean;
  isFoldOuter: boolean;
};

/**
 * Responsive layout hook.
 *
 * Breakpoints:
 *   Compact  : width < 380dp  (Z Fold6 cover ~373dp, small phones)
 *   Standard : 380-599dp      (most phones)
 *   Wide     : width >= 600dp (tablets, foldable inner, desktop)
 */
export function useDeviceLayout(
  measuredSize?: { width: number; height: number } | null,
): DeviceLayout {
  const windowSize = useWindowDimensions();
  const contextSize = useContext(DeviceLayoutSizeContext);
  // Priority: an explicit measuredSize argument (callers that measure their
  // own onLayout) > the shared root onLayout size from ShellLayout > the
  // native Dimensions constant (only correct until the first fold/unfold).
  const fallback = contextSize?.width && contextSize.width > 0 ? contextSize : windowSize;
  const width = measuredSize?.width && measuredSize.width > 0 ? measuredSize.width : fallback.width;
  const height = measuredSize?.height && measuredSize.height > 0 ? measuredSize.height : fallback.height;

  return useMemo(() => {
    const isLandscape = width > height;
    const isWide = width >= 600;
    const isCompact = width < 380;
    const useSplitLayout = isLandscape && isWide;

    // Adaptive font size
    let fontSize = 14;
    if (isWide) fontSize = 15;
    if (isCompact) fontSize = 13;
    if (isLandscape && !isWide) fontSize = 12;

    const terminalFlex = isWide ? 3 : 2.5;

    return {
      isLandscape,
      isWide,
      isCompact,
      useSplitLayout,
      width,
      height,
      fontSize,
      terminalFlex,
      // Legacy aliases
      isFoldInner: isWide,
      isFoldOuter: isCompact,
    };
  }, [width, height]);
}
