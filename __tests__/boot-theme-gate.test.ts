/**
 * lib/boot-theme-gate.ts — the cold-start gate that keeps the splash up
 * until the persisted theme preset is applied (2026-10-06 boot theme flash:
 * the UI painted the module-load default blue palette for ~14s before the
 * user's Case File preset was applied).
 */
import {
  startBootThemeGate,
  applyThemeFromSettings,
  __resetBootThemeGateForTests,
  BOOT_THEME_GATE_TIMEOUT_MS,
} from '../lib/boot-theme-gate';

function makeHarness(initiallyLoaded = false) {
  let loaded = initiallyLoaded;
  const listeners = new Set<() => void>();
  const events: string[] = [];
  let timerFn: (() => void) | null = null;
  let timerMs = -1;
  const dispose = startBootThemeGate({
    isBaseSettingsLoaded: () => loaded,
    subscribe: (l) => { listeners.add(l); return () => listeners.delete(l); },
    applyPersistedTheme: () => events.push('apply'),
    onReady: (r) => events.push('ready:' + r),
    setTimer: (fn, ms) => { timerFn = fn; timerMs = ms; return 1; },
    clearTimer: () => { timerFn = null; },
  });
  return {
    events,
    listeners,
    dispose,
    hydrate: () => { loaded = true; listeners.forEach((l) => l()); },
    fireTimer: () => timerFn?.(),
    get timerArmed() { return timerFn !== null; },
    get timerMs() { return timerMs; },
  };
}

describe('startBootThemeGate', () => {
  it('applies the persisted theme BEFORE reporting ready when hydration lands', () => {
    const h = makeHarness();
    expect(h.events).toEqual([]);
    expect(h.timerMs).toBe(BOOT_THEME_GATE_TIMEOUT_MS);
    h.hydrate();
    expect(h.events).toEqual(['apply', 'ready:hydrated']);
    expect(h.timerArmed).toBe(false);
    expect(h.listeners.size).toBe(0);
  });

  it('is ready immediately (with apply) when settings were already hydrated', () => {
    const h = makeHarness(true);
    expect(h.events).toEqual(['apply', 'ready:hydrated']);
    expect(h.timerArmed).toBe(false);
  });

  it('falls back to ready on timeout without applying, and ignores late hydration', () => {
    const h = makeHarness();
    h.fireTimer();
    expect(h.events).toEqual(['ready:timeout']);
    h.hydrate();
    expect(h.events).toEqual(['ready:timeout']);
  });

  it('ignores store updates that are not the hydration', () => {
    const h = makeHarness();
    h.listeners.forEach((l) => l());
    expect(h.events).toEqual([]);
  });

  it('dispose cancels the timer and subscription', () => {
    const h = makeHarness();
    h.dispose();
    expect(h.timerArmed).toBe(false);
    expect(h.listeners.size).toBe(0);
  });
});

describe('applyThemeFromSettings', () => {
  beforeEach(() => __resetBootThemeGateForTests());

  it('de-duplicates identical applies so the gate + effect do not double-remount', () => {
    const fns = { applyThemePreset: jest.fn(), applyUiFont: jest.fn() };
    expect(applyThemeFromSettings('case-file', 'default', false, fns)).toBe(true);
    expect(applyThemeFromSettings('case-file', 'default', false, fns)).toBe(false);
    expect(fns.applyThemePreset).toHaveBeenCalledTimes(1);
    // fonts finishing loading re-applies (remount picks up the real face)
    expect(applyThemeFromSettings('case-file', 'default', true, fns)).toBe(true);
    expect(fns.applyThemePreset).toHaveBeenCalledTimes(2);
    expect(fns.applyUiFont).not.toHaveBeenCalled();
  });

  it('applies the DotGothic font override after the preset', () => {
    const order: string[] = [];
    const fns = {
      applyThemePreset: (id: string) => order.push('preset:' + id),
      applyUiFont: (f: string) => order.push('font:' + f),
    };
    applyThemeFromSettings('red', 'dotgothic16', true, fns);
    expect(order).toEqual(['preset:red', 'font:DotGothic16_400Regular']);
  });
});

describe('app/_layout.tsx boot theme gate wiring', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const source: string = require('fs').readFileSync(require('path').join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');

  it('holds the splash at module scope and hides it only when the gate is ready', () => {
    expect(source).toContain('SplashScreen.preventAutoHideAsync()');
    expect(source).toMatch(/if \(!bootThemeReady\) return;\s*SplashScreen\.hideAsync\(\)/);
  });

  it('mounts the navigator only after the gate reports ready', () => {
    expect(source).toMatch(/\{bootThemeReady \? \(\s*<Stack key=\{locale\}/);
  });

  it('never applies the theme preset before base settings hydrate', () => {
    expect(source).toMatch(/if \(!baseSettingsLoaded\) return;\s*if \(applyThemeFromSettings\(/);
  });
});
