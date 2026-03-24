/**
 * Expo config plugin: enable proper Android multi-window / split-view support.
 *
 * - Sets android:resizeableActivity="true" on <activity>
 * - Adds screenSize|smallestScreenSize|screenLayout|density to configChanges
 *   so the Activity is NOT recreated on window resize (split-view / foldable)
 */
const { withAndroidManifest } = require("expo/config-plugins");

function withMultiWindow(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) return config;

    const activities = application.activity;
    if (!activities?.length) return config;

    // Find MainActivity (the main launcher activity)
    const mainActivity = activities.find(
      (act) =>
        act.$?.["android:name"] === ".MainActivity" ||
        act.$?.["android:name"]?.endsWith(".MainActivity")
    );

    if (mainActivity) {
      // Enable resizable activity for multi-window
      mainActivity.$["android:resizeableActivity"] = "true";

      // Ensure configChanges includes multi-window related values
      const existing = mainActivity.$["android:configChanges"] || "";
      const existingSet = new Set(existing.split("|").filter(Boolean));

      // Add the keys needed for smooth multi-window transitions
      const required = [
        "screenSize",
        "smallestScreenSize",
        "screenLayout",
        "density",
      ];
      for (const key of required) {
        existingSet.add(key);
      }

      mainActivity.$["android:configChanges"] = [...existingSet].join("|");
    }

    return config;
  });
}

module.exports = withMultiWindow;
