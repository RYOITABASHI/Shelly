import type { ExpoConfig } from "expo/config";

const bundleId = "dev.shelly.terminal";
const schemeFromBundleId = "shelly";

const env = {
  // App branding - update these values directly (do not use env vars)
  appName: "Shelly",
  appSlug: "shelly-terminal",
  // S3 URL of the app logo - set this to the URL returned by generate_image when creating custom logo
  // Leave empty to use the default icon from assets/images/icon.png
  logoUrl: "",
  scheme: schemeFromBundleId,
  iosBundleId: bundleId,
  androidPackage: bundleId,
};

const config: ExpoConfig & { android?: any } = {
  name: env.appName,
  slug: env.appSlug,
  version: "4.2.0",
  // bug #137 (2026-04-27): bumping runtimeVersion 1.0.0 → 5.1.0 to
  // invalidate the polluted OTA pool on the EAS preview branch. We
  // discovered that user-installed APKs were silently downloading a
  // stale OTA bundle from before the bug #131/#136 Recovery section
  // changes — the bundled JS had the new code but ON_LOAD's OTA fetch
  // overrode it with an older publish. Bumping runtimeVersion plus
  // setting enabled: false (below) means future installs always run
  // the JS bundled inside the APK. v5.1.1 will re-enable updates with
  // a proper runtimeVersion strategy + branch hygiene.
  runtimeVersion: "5.1.0",
  orientation: "default",
  icon: "./assets/images/icon.png",
  scheme: env.scheme,
  userInterfaceStyle: "automatic",
  newArchEnabled: true,
  ios: {
    supportsTablet: true,
    bundleIdentifier: env.iosBundleId,
    "infoPlist": {
        "ITSAppUsesNonExemptEncryption": false
      }
  },
  android: {
    adaptiveIcon: {
      foregroundImage: "./assets/images/adaptive-icon.png",
      backgroundColor: "#000000",
    },
    edgeToEdgeEnabled: true,
    predictiveBackGestureEnabled: false,
    package: env.androidPackage,
    // usesCleartextTraffic now handled by plugins/with-android-security.js (localhost only)
    // bug #92: MANAGE_EXTERNAL_STORAGE allows the terminal to read scripts
    // and files that the user adb push'es to /sdcard/Download. Without this,
    // Scoped Storage (targetSdk 30+) blocks direct open() on /sdcard paths
    // and the "push a script, source it from the shell" workflow is broken.
    // We request it at first run via Environment.isExternalStorageManager().
    // Shelly is distributed via GitHub Releases / F-Droid (not Play Store),
    // so the all-files-access restriction does not apply.
    permissions: [
      "POST_NOTIFICATIONS",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_SPECIAL_USE",
      "MANAGE_EXTERNAL_STORAGE",
    ],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          {
            scheme: env.scheme,
            host: "*",
          },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  web: {
    bundler: "metro",
    output: "static",
    favicon: "./assets/images/favicon.png",
  },
  plugins: [
    "expo-dev-client",
    "expo-router",
    "./plugins/with-multi-window",
    "./plugins/with-android-security",
    "./plugins/with-terminal-service",
    "./plugins/with-saved-instance-state",
    [
      "expo-audio",
      {
        microphonePermission: "Allow $(PRODUCT_NAME) to access your microphone.",
      },
    ],
    [
      "expo-video",
      {
        supportsBackgroundPlayback: true,
        supportsPictureInPicture: true,
      },
    ],
    [
      "expo-splash-screen",
      {
        backgroundColor: "#000000",
        image: "./assets/images/icon.png",
        imageWidth: 120,
      },
    ],
    "expo-localization",
    [
      "expo-build-properties",
      {
        android: {
          buildArchs: ["armeabi-v7a", "arm64-v8a"],
          minSdkVersion: 24,
          // cleartext traffic now controlled by plugins/with-android-security.js
        },
      },
    ],
  ],
  // bug #137 (2026-04-27): expo-updates disabled for v5.1.0 ship.
  // The OTA override bug (older preview-branch bundle silently
  // replacing the APK-bundled JS at ON_LOAD) wasted a build cycle and
  // confused the Recovery-section verification. Re-enable in v5.1.1
  // with a proper runtimeVersion + branch strategy. Until then, every
  // JS update goes via APK release; users always run exactly the JS
  // they installed.
  updates: {
    url: "https://u.expo.dev/e0d124cb-e18f-46c4-aca2-e19e48ba04fc",
    enabled: false,
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 3000,
  },
  extra: {
    eas: {
      projectId: "e0d124cb-e18f-46c4-aca2-e19e48ba04fc",
    },
    shellyPro: process.env.SHELLY_PRO === 'true',
  },
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
};

export default config;
