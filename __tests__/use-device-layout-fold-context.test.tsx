/**
 * hooks/use-device-layout.ts — bug fold-layout: on a Z Fold6, the Activity is
 * not recreated across fold/unfold (android:configChanges includes density /
 * screenSize), so `useWindowDimensions()` keeps reporting the size from the
 * last Activity resume. `DeviceLayoutSizeContext` lets ShellLayout's
 * authoritative `onLayout` measurement override that stale value for every
 * other `useDeviceLayout()` caller.
 */
import React from 'react';
import { renderHook } from '@testing-library/react-native';
import { useWindowDimensions } from 'react-native';
import { DeviceLayoutSizeContext, useDeviceLayout } from '@/hooks/use-device-layout';

// The test environment's `useWindowDimensions()` mock (from the jest-expo
// preset) is not itself controllable here, so these tests treat it as an
// opaque "stale window size" and assert the context/measuredSize priority
// relative to it, rather than asserting a specific literal.
const nativeWindowSize = renderHook(() => useWindowDimensions()).result.current;

describe('useDeviceLayout — DeviceLayoutSizeContext priority', () => {
  it('falls back to useWindowDimensions() when no context value is provided', () => {
    const { result } = renderHook(() => useDeviceLayout());
    expect(result.current.width).toBe(nativeWindowSize.width);
    expect(result.current.height).toBe(nativeWindowSize.height);
  });

  it('prefers the shared root-measured size from context over stale useWindowDimensions()', () => {
    const { result } = renderHook(() => useDeviceLayout(), {
      wrapper: ({ children }) => (
        <DeviceLayoutSizeContext.Provider value={{ width: 1812, height: 2176 }}>
          {children}
        </DeviceLayoutSizeContext.Provider>
      ),
    });
    expect(result.current.width).toBe(1812);
    expect(result.current.isWide).toBe(true);
    expect(result.current.isCompact).toBe(false);
  });

  it('prefers an explicit measuredSize argument over both context and useWindowDimensions()', () => {
    const { result } = renderHook(() => useDeviceLayout({ width: 700, height: 500 }), {
      wrapper: ({ children }) => (
        <DeviceLayoutSizeContext.Provider value={{ width: 1812, height: 2176 }}>
          {children}
        </DeviceLayoutSizeContext.Provider>
      ),
    });
    expect(result.current.width).toBe(700);
    expect(result.current.height).toBe(500);
  });

  it('ignores a zero-sized context value and falls back to useWindowDimensions()', () => {
    const { result } = renderHook(() => useDeviceLayout(), {
      wrapper: ({ children }) => (
        <DeviceLayoutSizeContext.Provider value={{ width: 0, height: 0 }}>
          {children}
        </DeviceLayoutSizeContext.Provider>
      ),
    });
    expect(result.current.width).toBe(nativeWindowSize.width);
  });
});
