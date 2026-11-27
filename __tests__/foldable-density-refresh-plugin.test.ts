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
  it('inserts the feature-flag override AFTER loadReactNative (build 3184 crash)', () => {
    const out = applyFoldableDensityRefresh(TEMPLATE);
    const loadIdx = out.indexOf('loadReactNative(this)');
    const overrideIdx = out.indexOf('ReactNativeFeatureFlags.override');
    expect(loadIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(loadIdx);
    expect(out).toContain('enableFontScaleChangesUpdatingLayout(): Boolean = true');
    expect(out).toContain(MARKER);
  });

  it('is idempotent', () => {
    const once = applyFoldableDensityRefresh(TEMPLATE);
    expect(applyFoldableDensityRefresh(once)).toEqual(once);
  });

  it('the checked-in MainApplication.kt keeps the override after loadReactNative', () => {
    const kt = fs.readFileSync(
      path.join(ROOT, 'android/app/src/main/java/dev/shelly/terminal/MainApplication.kt'),
      'utf8',
    );
    const loadIdx = kt.indexOf('loadReactNative(this)');
    const overrideIdx = kt.indexOf('ReactNativeFeatureFlags.override');
    expect(loadIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeGreaterThan(loadIdx);
  });
});
