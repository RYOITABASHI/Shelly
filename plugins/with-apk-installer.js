/**
 * Expo config plugin: allow Shelly to hand downloaded APKs to Android's
 * package installer via a FileProvider content:// URI.
 */
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const FILE_PROVIDER_PATHS = `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
  <external-path name="downloads" path="Download/" />
  <external-files-path name="external_files" path="." />
  <files-path name="app_files" path="." />
</paths>
`;

function withApkInstaller(config) {
  config = withDangerousMod(config, [
    "android",
    (config) => {
      const xmlDir = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/res/xml"
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, "shelly_file_provider_paths.xml"),
        FILE_PROVIDER_PATHS
      );
      return config;
    },
  ]);

  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) return config;

    if (!application.provider) application.provider = [];

    const providerName = "androidx.core.content.FileProvider";
    const authority = "dev.shelly.terminal.shelly.fileprovider";
    const existing = application.provider.find(
      (p) => p.$?.["android:authorities"] === authority
    );
    if (!existing) {
      application.provider.push({
        $: {
          "android:name": providerName,
          "android:authorities": authority,
          "android:exported": "false",
          "android:grantUriPermissions": "true",
        },
        "meta-data": [
          {
            $: {
              "android:name": "android.support.FILE_PROVIDER_PATHS",
              "android:resource": "@xml/shelly_file_provider_paths",
            },
          },
        ],
      });
    }

    return config;
  });
}

module.exports = withApkInstaller;
