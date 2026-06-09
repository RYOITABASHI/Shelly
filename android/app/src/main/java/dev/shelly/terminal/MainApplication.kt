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
