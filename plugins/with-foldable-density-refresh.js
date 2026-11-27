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
 * ORDERING (build 3186 crash): loadReactNative() -> DefaultNewArchitectureEntryPoint
 * .load() already calls the single-shot ReactNativeFeatureFlags.override(...)
 * once internally (ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android, at
 * ReleaseLevel.STABLE, the release level this app always resolves to — see
 * android/app/build.gradle's `reactNativeReleaseLevel` default). override()
 * is single-shot and throws "Feature flags cannot be overridden more than
 * once" on a second call, so a second plain override() call here crashed
 * onCreate (build 3186 fix attempt, never shipped).
 *
 * dangerouslyForceOverride() replaces an already-set provider outright, so
 * naively calling it with only our one flag would silently flip
 * fabric/bridgeless/turboModules back off. ReactNativeFeatureFlagsOverrides_
 * RNOSS_Stable_Android (the exact provider loadReactNative() seeds) is a
 * final Kotlin class in the prebuilt react-android AAR, so it can't be
 * subclassed directly -- but its own interface, ReactNativeFeatureFlagsProvider,
 * CAN be implemented by Kotlin interface delegation (`by`) over a real
 * instance of it, which reuses every one of its defaults verbatim (no
 * hand-replicated guess) while overriding only enableFontScaleChangesUpdatingLayout.
 * Guarded by BuildConfig.IS_NEW_ARCHITECTURE_ENABLED because load() only
 * calls its own override() in that case -- calling dangerouslyForceOverride
 * unconditionally would be the FIRST override on an old-arch build and would
 * wrongly force fabric/bridgeless/turboModules on.
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
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlagsProvider`;

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
    // ${MARKER} on every
    // onConfigurationChanged (not just Activity recreation), so dp->px
    // scaling stays correct when the Z Fold6 cover/main displays swap
    // density without recreating the Activity. Must run AFTER
    // loadReactNative(): see plugins/with-foldable-density-refresh.js for
    // why this is dangerouslyForceOverride() wrapping (via Kotlin
    // interface delegation, not hand-replicated fields)
    // ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android, the exact
    // provider loadReactNative() already seeded at ReleaseLevel.STABLE.
    // __tests__/foldable-density-refresh-plugin.test.ts pins this shape.
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      val accessedBeforeForceOverride = ReactNativeFeatureFlags.dangerouslyForceOverride(
          object : ReactNativeFeatureFlagsProvider by
              ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android(
                  fabricEnabled = true,
                  bridgelessEnabled = true,
                  turboModulesEnabled = true) {
            override fun enableFontScaleChangesUpdatingLayout(): Boolean = true
          })
      if (accessedBeforeForceOverride != null) {
        Log.w(TAG, "ReactNativeFeatureFlags read before the fold-layout force-override: $accessedBeforeForceOverride")
      }
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
