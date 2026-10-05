// lib/themed-styles.ts
//
// Theme-reactive replacement for a module-level `StyleSheet.create({...})`.
//
// `colors` (theme.config.ts) is mutated in place by applyThemePreset(), but a
// module-level `StyleSheet.create({ x: { color: C.text1 } })` copies the
// string value once, when the module is first evaluated — which is before
// app/_layout.tsx applies the persisted preset. Those styles therefore kept
// the seed palette forever, so light presets such as Case File showed dark
// islands (settings panels, sheets, sidebar rows) that no remount could fix.
//
// themedStyleSheet() takes a factory instead and returns a Proxy that
// rebuilds the sheet lazily whenever the theme version changes. Call sites
// keep reading `styles.foo` unchanged; ShellLayout's key={version} remount
// guarantees a re-render after every preset swap, at which point the next
// property read sees the fresh palette.
//
// Do NOT read a themed sheet from inside a Reanimated worklet: a Proxy cannot
// be serialized to the UI thread. Copy the needed values out first.

import { StyleSheet } from 'react-native';
import { useThemeVersionStore } from '@/store/theme-version-store';

export function themedStyleSheet<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  factory: () => T & StyleSheet.NamedStyles<any>,
): T {
  let cache: T | null = null;
  let cachedVersion = -1;
  const resolve = (): T => {
    const version = useThemeVersionStore.getState().version;
    if (cache === null || version !== cachedVersion) {
      cache = StyleSheet.create(factory()) as T;
      cachedVersion = version;
    }
    return cache;
  };
  return new Proxy({} as T, {
    get: (_target, key) => (resolve() as any)[key],
    has: (_target, key) => key in (resolve() as object),
    ownKeys: () => Reflect.ownKeys(resolve() as object),
    getOwnPropertyDescriptor: (_target, key) => {
      const sheet = resolve() as object;
      if (!(key in sheet)) return undefined;
      return { value: (sheet as any)[key], enumerable: true, configurable: true, writable: false };
    },
  });
}
