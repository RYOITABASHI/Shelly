import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const plugin = require('../plugins/with-foldable-density-refresh.js');
const { applyFoldableDensityRefresh, MARKER } = plugin as {
  applyFoldableDensityRefresh: (src: string) => string;
  MARKER: string;
};

const ROOT = path.resolve(__dirname, '..');

// The stock Expo template MainApplication.kt sections the plugin patches.
const TEMPLATE = `package dev.shelly.terminal

import com.facebook.react.defaults.DefaultReactNativeHost

class MainApplication {
  override fun onCreate() {
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }
}
`;

describe('with-foldable-density-refresh plugin', () => {
  it('force-overrides the feature flags AFTER loadReactNative, never calling the single-shot override() (build 3184 + 3186 crashes)', () => {
    const out = applyFoldableDensityRefresh(TEMPLATE);
    const loadIdx = out.indexOf('loadReactNative(this)');
    const forceOverrideIdx = out.indexOf('ReactNativeFeatureFlags.dangerouslyForceOverride');
    expect(loadIdx).toBeGreaterThan(-1);
    expect(forceOverrideIdx).toBeGreaterThan(loadIdx);
    // loadReactNative() already calls the plain, single-shot override()
    // once internally (DefaultNewArchitectureEntryPoint.load()). A second
    // plain override() call throws "Feature flags cannot be overridden
    // more than once" (build 3186 crash) -- the patched onCreate must not
    // call it at all.
    expect(out).not.toContain('ReactNativeFeatureFlags.override(');
    // ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android is a final
    // Kotlin class in the prebuilt react-android AAR and can't be
    // subclassed, so the replacement must reuse it by interface
    // delegation (`by`) over a real instance -- not hand-replicated
    // fields on its open parent -- so every one of its other default
    // overrides (fabric/bridgeless/turboModules/etc.) survives verbatim
    // even if a future RN bump changes what it sets.
    expect(out).toContain('object : ReactNativeFeatureFlagsProvider by');
    expect(out).toContain('ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android(');
    expect(out).toContain('fabricEnabled = true');
    expect(out).toContain('bridgelessEnabled = true');
    expect(out).toContain('turboModulesEnabled = true');
    expect(out).toContain('enableFontScaleChangesUpdatingLayout(): Boolean = true');
    // Guarded: load() only calls its own override() when new-arch is on;
    // calling dangerouslyForceOverride unconditionally would be the FIRST
    // override on an old-arch build and would wrongly force fabric/
    // bridgeless/turboModules on.
    expect(out).toContain('if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED)');
    expect(out).toContain(MARKER);
  });

  it('is idempotent', () => {
    const once = applyFoldableDensityRefresh(TEMPLATE);
    expect(applyFoldableDensityRefresh(once)).toEqual(once);
  });

  it('the checked-in MainApplication.kt matches what the plugin would generate from the stock template', () => {
    const kt = fs.readFileSync(
      path.join(ROOT, 'android/app/src/main/java/dev/shelly/terminal/MainApplication.kt'),
      'utf8',
    );
    const loadIdx = kt.indexOf('loadReactNative(this)');
    const forceOverrideIdx = kt.indexOf('ReactNativeFeatureFlags.dangerouslyForceOverride');
    expect(loadIdx).toBeGreaterThan(-1);
    expect(forceOverrideIdx).toBeGreaterThan(loadIdx);
    expect(kt).not.toContain('ReactNativeFeatureFlags.override(');
    expect(kt).toContain('object : ReactNativeFeatureFlagsProvider by');
    expect(kt).toContain('if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED)');
    expect(kt).toContain(MARKER);
  });
});
