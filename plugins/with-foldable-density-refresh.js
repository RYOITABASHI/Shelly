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
 */
const { withMainApplication } = require("expo/config-plugins");

function withFoldableDensityRefresh(config) {
  return withMainApplication(config, (config) => {
    const marker = "bug fold-layout: refresh RN's DisplayMetricsHolder";
    if (config.modResults.contents.includes(marker)) {
      return config;
    }

    const importTarget = `import com.facebook.react.defaults.DefaultReactNativeHost`;
    const importReplacement = `import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlags
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsDefaults`;

    if (!config.modResults.contents.includes(importTarget)) {
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
    // bug fold-layout: refresh RN's DisplayMetricsHolder on every
    // onConfigurationChanged (not just Activity recreation), so dp->px
    // scaling stays correct when the Z Fold6 cover/main displays swap
    // density without recreating the Activity. Must be set before
    // loadReactNative() builds the ReactHost.
    ReactNativeFeatureFlags.override(object : ReactNativeFeatureFlagsDefaults() {
      override fun enableFontScaleChangesUpdatingLayout(): Boolean = true
    })
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }`;

    if (!config.modResults.contents.includes(onCreateTarget)) {
      throw new Error(
        "with-foldable-density-refresh could not find MainApplication.onCreate template"
      );
    }

    config.modResults.contents = config.modResults.contents
      .replace(importTarget, importReplacement)
      .replace(onCreateTarget, onCreateReplacement);
    return config;
  });
}

module.exports = withFoldableDensityRefresh;
