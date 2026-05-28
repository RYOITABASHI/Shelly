/**
 * Expo config plugin: keep app-level configuration changes from crashing when
 * an Expo module receives the event before its JS module registry is ready.
 *
 * Observed on Fold/multi-window changes with expo-localization 17:
 * LocalizationPackage.onConfigurationChanged() can call sendEvent() while the
 * module is not in the registry yet, throwing IllegalArgumentException from
 * AppContext.eventEmitter(). The locale-change event is safe to drop in that
 * early state; crashing the whole app is not.
 */
const { withMainApplication } = require("expo/config-plugins");

function withConfigurationChangeGuard(config) {
  return withMainApplication(config, (config) => {
    const marker = "Ignoring Expo configuration event before module registry is ready";
    if (config.modResults.contents.includes(marker)) {
      return config;
    }

    const target = `  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }`;

    const replacement = `  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    try {
      ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
    } catch (e: IllegalArgumentException) {
      if (e.message?.contains("isn't present in the module registry") == true) {
        android.util.Log.w("MainApplication", "${marker}", e)
      } else {
        throw e
      }
    }
  }`;

    if (!config.modResults.contents.includes(target)) {
      throw new Error(
        "with-configuration-change-guard could not find MainApplication.onConfigurationChanged template"
      );
    }

    config.modResults.contents = config.modResults.contents.replace(
      target,
      replacement
    );
    return config;
  });
}

module.exports = withConfigurationChangeGuard;
