/**
 * Wi-Fi connectivity guardian — RN side: the toggle mirror
 * (lib/connectivity-guardian-mirror.ts), the setting default, the Settings
 * row and its i18n (design test 8: toggle OFF / mirror unreadable -> OFF).
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  guardianEnabledFromSettings,
  startConnectivityGuardianMirror,
  writeConnectivityGuardianMirror,
  type GuardianMirrorNative,
} from '@/lib/connectivity-guardian-mirror';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

function makeNative(results: Array<boolean | Error> = []) {
  const calls: boolean[] = [];
  const native: GuardianMirrorNative = {
    setConnectivityGuardianMirror: jest.fn(async (enabled: boolean) => {
      calls.push(enabled);
      const r = results.length ? results.shift()! : true;
      if (r instanceof Error) throw r;
      return r;
    }),
  };
  return { native, calls };
}

function makeSource(initial: { connectivityGuardianEnabled?: any }, loaded: boolean) {
  let state = { settings: initial, isBaseSettingsLoaded: loaded };
  const listeners = new Set<() => void>();
  return {
    source: {
      getState: () => state,
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    set(next: Partial<typeof state>) {
      state = { ...state, ...next };
      listeners.forEach((l) => l());
    },
    listeners,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('guardianEnabledFromSettings', () => {
  it('only === true is on', () => {
    expect(guardianEnabledFromSettings({})).toBe(false);
    expect(guardianEnabledFromSettings({ connectivityGuardianEnabled: false })).toBe(false);
    expect(guardianEnabledFromSettings({ connectivityGuardianEnabled: 'true' as any })).toBe(false);
    expect(guardianEnabledFromSettings({ connectivityGuardianEnabled: 1 as any })).toBe(false);
    expect(guardianEnabledFromSettings({ connectivityGuardianEnabled: true })).toBe(true);
  });
});

describe('writeConnectivityGuardianMirror (fail closed)', () => {
  it('passes the value through', async () => {
    const { native, calls } = makeNative();
    expect(await writeConnectivityGuardianMirror(native, true)).toBe(true);
    expect(await writeConnectivityGuardianMirror(native, false)).toBe(true);
    expect(calls).toEqual([true, false]);
  });

  it('a refused ON write is followed by an explicit clear', async () => {
    const { native, calls } = makeNative([false]);
    expect(await writeConnectivityGuardianMirror(native, true)).toBe(false);
    expect(calls).toEqual([true, false]);
  });

  it('a throwing ON write is followed by an explicit clear', async () => {
    const { native, calls } = makeNative([new Error('keystore')]);
    expect(await writeConnectivityGuardianMirror(native, true)).toBe(false);
    expect(calls).toEqual([true, false]);
  });

  it('an older native build without the function is simply OFF', async () => {
    expect(await writeConnectivityGuardianMirror({}, true)).toBe(false);
  });
});

describe('startConnectivityGuardianMirror', () => {
  it('waits for the persisted settings (no OFF -> ON bounce at app start)', async () => {
    const { native, calls } = makeNative();
    const src = makeSource({ connectivityGuardianEnabled: false }, false);
    const stop = startConnectivityGuardianMirror(native, src.source);
    await flush();
    expect(calls).toEqual([]);
    src.set({ settings: { connectivityGuardianEnabled: true }, isBaseSettingsLoaded: true });
    await flush();
    expect(calls).toEqual([true]);
    stop();
  });

  it('writes at start and on every change of the flag only', async () => {
    const { native, calls } = makeNative();
    const src = makeSource({ connectivityGuardianEnabled: true }, true);
    const stop = startConnectivityGuardianMirror(native, src.source);
    await flush();
    src.set({ settings: { connectivityGuardianEnabled: true } }); // unrelated change
    src.set({ settings: { connectivityGuardianEnabled: false } });
    src.set({ settings: { connectivityGuardianEnabled: true } });
    await flush();
    await flush();
    expect(calls).toEqual([true, false, true]);
    stop();
    expect(src.listeners.size).toBe(0);
  });

  it('an OFF never lands before the preceding ON (serialized)', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const native: GuardianMirrorNative = {
      setConnectivityGuardianMirror: async (enabled) => {
        order.push(`start:${enabled}`);
        if (enabled) await gate;
        order.push(`end:${enabled}`);
        return true;
      },
    };
    const src = makeSource({ connectivityGuardianEnabled: true }, true);
    startConnectivityGuardianMirror(native, src.source);
    src.set({ settings: { connectivityGuardianEnabled: false } });
    await flush();
    release();
    await flush();
    await flush();
    expect(order).toEqual(['start:true', 'end:true', 'start:false', 'end:false']);
  });
});

describe('setting, Settings row, i18n', () => {
  it('connectivityGuardianEnabled defaults to false', () => {
    expect(read('store/settings-store.ts')).toContain('  connectivityGuardianEnabled: false,\n');
    expect(read('store/types.ts')).toContain('  connectivityGuardianEnabled?: boolean;\n');
  });

  it('the root layout mirrors it', () => {
    const layout = read('app/_layout.tsx');
    expect(layout).toContain("import { startConnectivityGuardianMirror } from '@/lib/connectivity-guardian-mirror';");
    expect(layout).toContain('useEffect(() => startConnectivityGuardianMirror(');
  });

  it('Settings has the toggle row bound to the setting', () => {
    const dd = read('components/layout/SettingsDropdown.tsx');
    expect(dd).toContain('<ConnectivityGuardianSection />');
    expect(dd).toContain('updateSettings({ connectivityGuardianEnabled: !on })');
  });

  it('en and ja have every key', () => {
    const keys = [
      'connectivity_guardian.settings_title',
      'connectivity_guardian.settings_toggle',
      'connectivity_guardian.settings_hint_on',
      'connectivity_guardian.settings_hint_off',
    ];
    for (const k of keys) {
      expect((en as any)[k]).toEqual(expect.any(String));
      expect((ja as any)[k]).toEqual(expect.any(String));
    }
    expect((ja as any)['connectivity_guardian.settings_toggle']).toBe('Wi-Fi連動オートパイロット');
  });
});
