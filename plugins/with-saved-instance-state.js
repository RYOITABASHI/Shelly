/**
 * Expo config plugin: patch MainActivity.kt to pass savedInstanceState
 * through to super.onCreate(). The Expo prebuild template hardcodes
 * `super.onCreate(null)` which throws away Android's restored state,
 * which in turn defeats our Zustand persist middleware and leaves
 * cwd / PTY metadata / pane layout lost after an lmkd kill.
 *
 * bug #50 — release blocker. See docs/superpowers/specs/ for context.
 */
const { withMainActivity } = require("expo/config-plugins");

function withSavedInstanceState(config) {
  return withMainActivity(config, (config) => {
    const target = "super.onCreate(null)";
    const replacement = "super.onCreate(savedInstanceState)";
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
