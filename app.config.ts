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
  runtimeVersion: "1.0.0",
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
    permissions: ["POST_NOTIFICATIONS", "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_SPECIAL_USE"],
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
  updates: {
    url: "https://u.expo.dev/e0d124cb-e18f-46c4-aca2-e19e48ba04fc",
    enabled: true,
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
