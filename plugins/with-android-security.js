/**
 * Expo config plugin: harden Android security settings.
 *
 * - Sets android:allowBackup="false" to prevent adb backup data leakage
 * - Adds network_security_config.xml to restrict cleartext traffic to localhost only
 * - Removes global usesCleartextTraffic in favor of the network security config
 */
const { withAndroidManifest } = require("expo/config-plugins");
const { withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const NETWORK_SECURITY_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">localhost</domain>
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">10.0.2.2</domain>
  </domain-config>
</network-security-config>
`;

function withAndroidSecurity(config) {
  // Step 1: Write network_security_config.xml
  config = withDangerousMod(config, [
    "android",
    (config) => {
      const xmlDir = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/res/xml"
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, "network_security_config.xml"),
        NETWORK_SECURITY_CONFIG
      );
      return config;
    },
  ]);

  // Step 2: Modify AndroidManifest.xml
  config = withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (app?.$) {
      app.$["android:allowBackup"] = "false";
      app.$["android:networkSecurityConfig"] =
        "@xml/network_security_config";
      // Remove global usesCleartextTraffic — now handled by network_security_config
      delete app.$["android:usesCleartextTraffic"];
    }
    return config;
  });

  return config;
}

module.exports = withAndroidSecurity;
