import type { ExpoConfig } from "expo/config";
import { execSync } from "node:child_process";

const bundleId = "dev.shelly.terminal";
const schemeFromBundleId = "shelly";
const lastManualAndroidVersionCode = 532;
const fallbackAndroidVersionCode = lastManualAndroidVersionCode + 1;

function androidVersionCode(): number {
  const envVersionCode = Number.parseInt(process.env.SHELLY_ANDROID_VERSION_CODE || "", 10);
  if (Number.isInteger(envVersionCode) && envVersionCode >= fallbackAndroidVersionCode) {
    return envVersionCode;
  }

  try {
    const gitCount = Number.parseInt(
      execSync("git rev-list --count HEAD", { encoding: "utf8" }).trim(),
      10,
    );
    if (Number.isInteger(gitCount) && gitCount > 0) {
      return Math.max(gitCount, fallbackAndroidVersionCode);
    }
  } catch {
    // Keep local config evaluation working outside a full git checkout.
  }

  return fallbackAndroidVersionCode;
}

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
  version: "5.3.5",
  // OTA remains disabled for release APKs: installed devices should run
  // exactly the JS bundled in the APK. Keep runtimeVersion aligned with
  // the app semver so a future OTA re-enable starts from a clean boundary.
  runtimeVersion: "5.3.5",
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
    versionCode: androidVersionCode(),
    permissions: [
      "POST_NOTIFICATIONS",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_SPECIAL_USE",
      "MANAGE_EXTERNAL_STORAGE",
      "REQUEST_INSTALL_PACKAGES",
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
    "./plugins/with-apk-installer",
    "./plugins/with-saved-instance-state",
    "./plugins/with-configuration-change-guard",
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
          // bug #139 (2026-04-27): arm64-v8a only. All of Shelly's
          // bundled native binaries (claude SEA, codex termux fork,
          // bash/node/git/python/etc.) are arm64-only. Shipping
          // armeabi-v7a was packaging RN/Hermes/Reanimated 32-bit
          // .so files for an architecture nothing else in the APK
          // supports — pure dead weight (~80-150 MB). Modern Android
          // devices that target Shelly are 64-bit; the 32-bit slice
          // wouldn't have worked anyway.
          buildArchs: ["arm64-v8a"],
          minSdkVersion: 24,
          // cleartext traffic now controlled by plugins/with-android-security.js
        },
      },
    ],
  ],
  // expo-updates remains disabled for GitHub/F-Droid release APKs. Every
  // JS update ships through a new APK so CLI harness fixes and docs stay
  // tied to the binary the user actually installed.
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
