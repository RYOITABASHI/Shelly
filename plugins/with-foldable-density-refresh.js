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
 * "SoLoader.init() not yet called".
 *
 * ORDERING (build 3186 crash): loadReactNative() itself already calls
 * the single-shot override(...) on ReactNativeFeatureFlags once internally
 * (DefaultNewArchitectureEntryPoint.load() at ReleaseLevel.STABLE) to seed
 * fabric/bridgeless/turboModules = true. override() is single-shot and
 * throws "Feature flags cannot be overridden more than once" on a second
 * call, so the plain override() that fixed build 3184 crashed onCreate
 * again here. dangerouslyForceOverride() is the sanctioned way to replace
 * an already-set override, but it discards the previous provider
 * outright, so the replacement must re-assert the same
 * fabric/bridgeless/turboModules=true defaults loadReactNative() seeded,
 * or new-architecture would silently flip off.
 * ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android (the provider
 * loadReactNative() used) is a final class in the prebuilt react-android
 * AAR, so it can't be subclassed here; this extends its open parent,
 * ReactNativeNewArchitectureFeatureFlagsDefaults, and replicates the same
 * overrides RNOSS_Stable_Android applies for
 * fabricEnabled=bridgelessEnabled=turboModulesEnabled=true (the values
 * DefaultNewArchitectureEntryPoint.load() always passes at
 * ReleaseLevel.STABLE), then adds the font-scale flag.
 * __tests__/foldable-density-refresh-plugin.test.ts pins this shape.
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
import com.facebook.react.internal.featureflags.ReactNativeNewArchitectureFeatureFlagsDefaults`;

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
    // "SoLoader.init() not yet called" (build 3184).
    //
    // ORDERING (build 3186 crash): loadReactNative() itself already
    // calls the single-shot override(...) on ReactNativeFeatureFlags once internally
    // (DefaultNewArchitectureEntryPoint.load() at ReleaseLevel.STABLE)
    // to seed fabric/bridgeless/turboModules = true. override() is
    // single-shot and throws "Feature flags cannot be overridden more
    // than once" on a second call, so a plain override() here (the
    // build 3184 fix) crashed onCreate again in build 3186.
    // dangerouslyForceOverride() is the sanctioned way to replace an
    // already-set override, but it discards the previous provider
    // outright, so the replacement must re-assert the same
    // fabric/bridgeless/turboModules=true defaults loadReactNative()
    // seeded, or new-architecture would silently flip off.
    // ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android (the
    // provider loadReactNative() used) is a final class in the
    // prebuilt react-android AAR, so it can't be subclassed here; this
    // extends its open parent, ReactNativeNewArchitectureFeatureFlagsDefaults,
    // and replicates the same overrides RNOSS_Stable_Android applies
    // for fabricEnabled=bridgelessEnabled=turboModulesEnabled=true (the
    // values DefaultNewArchitectureEntryPoint.load() always passes at
    // ReleaseLevel.STABLE), then adds the font-scale flag.
    // __tests__/foldable-density-refresh-plugin.test.ts pins this shape.
    val previouslyAccessedFlags = ReactNativeFeatureFlags.dangerouslyForceOverride(
        object : ReactNativeNewArchitectureFeatureFlagsDefaults(true) {
          override fun useFabricInterop(): Boolean = true
          override fun enableFabricRenderer(): Boolean = true
          override fun useTurboModules(): Boolean = true
          override fun useShadowNodeStateOnClone(): Boolean = true
          override fun enableFontScaleChangesUpdatingLayout(): Boolean = true
        })
    if (previouslyAccessedFlags != null) {
      Log.w(TAG, "ReactNativeFeatureFlags read before dangerouslyForceOverride: $previouslyAccessedFlags")
    }
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
