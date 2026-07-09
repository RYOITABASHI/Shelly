/**
 * Expo config plugin: declare package-visibility <queries> so
 * TerminalEmulatorModule.kt's fireAgentIntent (INTENT-001, "launch" mode)
 * can actually see other installed apps.
 *
 * Android 11+ (API 30+) hides other apps' packages from PackageManager
 * queries by default (getLaunchIntentForPackage, resolveActivity, etc. all
 * return null for anything not explicitly declared visible), even when the
 * caller passes an exact, correctly-formatted package name. Without this,
 * every INTENT-001 launch-mode agent action fails with
 * ActivityNotFoundException regardless of what target it names.
 *
 * A <queries> block matching MAIN/LAUNCHER is the standard, unprivileged
 * way to see "any app with a launcher icon" — it does not require the
 * QUERY_ALL_PACKAGES permission.
 */
const { withAndroidManifest } = require("expo/config-plugins");

function withAgentLaunchQueries(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    if (!manifest.queries) manifest.queries = [{}];
    const queries = manifest.queries[0];
    if (!queries.intent) queries.intent = [];
    queries.intent.push({
      action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
      category: [{ $: { "android:name": "android.intent.category.LAUNCHER" } }],
    });
    return config;
  });
}

module.exports = withAgentLaunchQueries;
