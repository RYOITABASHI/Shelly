package dev.shelly.terminal

import android.app.Application
import android.content.res.Configuration
import android.util.Log

import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.ReactHost
import com.facebook.react.common.ReleaseLevel
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.internal.featureflags.ReactNativeFeatureFlags
import com.facebook.react.internal.featureflags.ReactNativeNewArchitectureFeatureFlagsDefaults

import com.horcrux.svg.SvgPackage
import com.reactnativecommunity.asyncstorage.AsyncStoragePackage
import com.reactnativecommunity.webview.RNCWebViewPackage
import com.swmansion.gesturehandler.RNGestureHandlerPackage
import com.swmansion.reanimated.ReanimatedPackage
import com.swmansion.rnscreens.RNScreensPackage
import com.swmansion.worklets.WorkletsPackage
import com.th3rdwave.safeareacontext.SafeAreaContextPackage
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ExpoModulesPackage
import expo.modules.ReactNativeHostWrapper

private fun MutableList<ReactPackage>.addIfMissing(packageInstance: ReactPackage) {
  if (none { it.javaClass.name == packageInstance.javaClass.name }) {
    add(packageInstance)
  }
}

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost = ReactNativeHostWrapper(
      this,
      object : DefaultReactNativeHost(this) {
        override fun getPackages(): List<ReactPackage> =
            PackageList(this).packages.apply {
              addIfMissing(ExpoModulesPackage())
              addIfMissing(AsyncStoragePackage())
              addIfMissing(RNGestureHandlerPackage())
              addIfMissing(SafeAreaContextPackage())
              addIfMissing(RNScreensPackage())
              addIfMissing(SvgPackage())
              addIfMissing(RNCWebViewPackage())
              addIfMissing(WorkletsPackage())
              addIfMissing(ReanimatedPackage())
            }

          override fun getJSMainModuleName(): String = ".expo/.virtual-metro-entry"

          override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

          override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED

          override val isHermesEnabled: Boolean
            get() = BuildConfig.IS_HERMES_ENABLED
      }
  )

  override val reactHost: ReactHost
    get() = ReactNativeHostWrapper.createReactHost(applicationContext, reactNativeHost)

  override fun onCreate() {
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
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    try {
      ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
    } catch (e: IllegalArgumentException) {
      if (e.message?.contains("module registry") == true) {
        Log.w(TAG, "Ignoring Expo configuration event before module registry is ready", e)
      } else {
        throw e
      }
    }
  }

  companion object {
    private const val TAG = "MainApplication"
  }
}
