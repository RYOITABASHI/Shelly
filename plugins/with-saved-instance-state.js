/**
 * Expo config plugin: keep MainActivity.kt from restoring Android fragment
 * state. react-native-screens intentionally crashes if Screen fragments are
 * restored by the platform; Shelly state restoration must come from our
 * explicit stores/native PTY registries instead.
 *
 * This protects background resume, fold/unfold, and process recreation paths.
 */
const { withMainActivity } = require("expo/config-plugins");

function withSavedInstanceState(config) {
  return withMainActivity(config, (config) => {
    const target = "super.onCreate(savedInstanceState)";
    const replacement = "super.onCreate(null)";
    if (config.modResults.contents.includes(target)) {
      config.modResults.contents = config.modResults.contents.replace(
        target,
        replacement
      );
    }
    return config;
  });
}

module.exports = withSavedInstanceState;
