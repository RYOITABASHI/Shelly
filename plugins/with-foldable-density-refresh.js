/**
 * Expo config plugin: keep dp->px scaling correct across a Z Fold6
 * fold/unfold transition.
 *
 * plugins/with-multi-window.js adds `density` (plus screenSize etc.) to the
 * MainActivity's android:configChanges so the Activity is NOT recreated when
 * the window moves between the cover and main displays (different physical
 * density) — recreating would kill the live PTY session.
 *
 * But React Native (0.81, bridgeless/new-arch ReactHostImpl) only refreshes
 * its cached DisplayMetricsHolder (density/scale used by every dp->px
 * conversion, i.e. Fabric view sizes, fontSize, letterSpacing, lineHeight)
 * from onConfigurationChanged when the `enableFontScaleChangesUpdatingLayout`
 * feature flag is on. It defaults to off. Without it, every dp value in the
 * app keeps rendering at the density captured at first launch, so after a
 * fold/unfold the header bar / tab bar / terminal grid render at the wrong
 * pixel size for the now-active display (oversized bars, stretched-looking
 * letter spacing, misaligned terminal columns).
 *
 * ORDERING (build 3184 crash): the override must be inserted AFTER
 * loadReactNative(). The override touches the Cxx feature-flag interop,
 * whose class initializer loads a native library through SoLoader — and
 * SoLoader is only initialized inside loadReactNative(). Placing the
 * override before it crashed Application.onCreate with
 * "SoLoader.init() not yet called". The ReactHost is created lazily after
 * onCreate, so the override still lands before the flag is first read.
 * __tests__/foldable-density-refresh-plugin.test.ts pins this order.
 */
const { withMainApplication } = require("expo/config-plugins");

const MARKER = "bug fold-layout: refresh RN's DisplayMetricsHolder";

function applyFoldableDensityRefresh(contents) {
  if (contents.includes(MARKER)) {
    return contents;
  }

  const importTarget = `import com.facebook.react.defaults.DefaultReactNativeHost`;
  const importReplacement = `import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlags
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsDefaults`;

  if (!contents.includes(importTarget)) {
    throw new Error(
      "with-foldable-density-refresh could not find MainApplication import anchor"
    );
  }

  const onCreateTarget = `  override fun onCreate() {
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }`;

  const onCreateReplacement = `  override fun onCreate() {
    super.onCreate()
    DefaultNewArchitectureEntryPoint.releaseLevel = try {
      ReleaseLevel.valueOf(BuildConfig.REACT_NATIVE_RELEASE_LEVEL.uppercase())
    } catch (e: IllegalArgumentException) {
      ReleaseLevel.STABLE
    }
    loadReactNative(this)
    // bug fold-layout: refresh RN's DisplayMetricsHolder on every
    // onConfigurationChanged (not just Activity recreation), so dp->px
    // scaling stays correct when the Z Fold6 cover/main displays swap
    // density without recreating the Activity. This must run AFTER
    // loadReactNative(): the override touches the Cxx feature-flag
    // interop, whose class initializer loads a native library through
    // SoLoader — and SoLoader is only initialized inside
    // loadReactNative(). Calling it earlier crashes onCreate with
    // "SoLoader.init() not yet called" (build 3184). The ReactHost is
    // created lazily after onCreate, so the override still lands
    // before the flag is first read.
    ReactNativeFeatureFlags.override(object : ReactNativeFeatureFlagsDefaults() {
      override fun enableFontScaleChangesUpdatingLayout(): Boolean = true
    })
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }`;

  if (!contents.includes(onCreateTarget)) {
    throw new Error(
      "with-foldable-density-refresh could not find MainApplication.onCreate template"
    );
  }

  return contents
    .replace(importTarget, importReplacement)
    .replace(onCreateTarget, onCreateReplacement);
}

function withFoldableDensityRefresh(config) {
  return withMainApplication(config, (config) => {
    config.modResults.contents = applyFoldableDensityRefresh(
      config.modResults.contents
    );
    return config;
  });
}

module.exports = withFoldableDensityRefresh;
module.exports.applyFoldableDensityRefresh = applyFoldableDensityRefresh;
module.exports.MARKER = MARKER;
