// lib/themed-stylesheet.ts
//
// Drop-in replacement for a module-level `StyleSheet.create({...})` whose
// values read the live palette (`colors as C` from '@/theme.config').
//
// Problem (2026-10-06, product-owner report: Settings sub-screens / Local
// LLM catalog ignore the Case File preset): a module-level
// `StyleSheet.create({ x: { color: C.text1 } })` copies the palette values
// ONCE, at module load — i.e. the built-in blue/dark seed palette — so
// applyThemePreset()'s in-place Object.assign(colors, preset) never
// reaches those styles, even after theme-version-store's remount.
//
// createThemedStyles(() => ({...})) returns an object with the same shape
// that lazily rebuilds the underlying StyleSheet whenever
// theme-version-store's version changes (every applyThemePreset() bumps
// it). Reads are plain property access, so call sites (`styles.foo`) stay
// unchanged; the factory runs at most once per theme version.

import { StyleSheet } from 'react-native';
import { useThemeVersionStore } from '@/store/theme-version-store';

export function createThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  factory: () => T & StyleSheet.NamedStyles<any>,
): T {
  let cachedVersion = -1;
  let cached: T | null = null;
  const resolve = (): T => {
    const version = useThemeVersionStore.getState().version;
    if (cached === null || version !== cachedVersion) {
      cached = StyleSheet.create(factory()) as T;
      cachedVersion = version;
    }
    return cached;
  };
  return new Proxy({} as T, {
    get: (_target, prop) => (resolve() as Record<PropertyKey, unknown>)[prop],
    has: (_target, prop) => prop in (resolve() as object),
    ownKeys: () => Reflect.ownKeys(resolve() as object),
    getOwnPropertyDescriptor: (_target, prop) => {
      const desc = Reflect.getOwnPropertyDescriptor(resolve() as object, prop);
      if (desc) desc.configurable = true;
      return desc;
    },
  });
}

/** Subscribe a component to theme changes (re-render on preset swap) for
 *  surfaces that are NOT under ShellLayout's key={version} remount, e.g. a
 *  Modal that stays open while the preset changes. Returns the version. */
export function useThemeVersion(): number {
  return useThemeVersionStore((s) => s.version);
}
