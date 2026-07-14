/**
 * Expo config plugin: register ShellyAccessibilityService.
 *
 * UI-AUTOMATION-001 / app.act Milestone 0 — see ShellyAccessibilityService.kt's
 * doc comment and docs/superpowers/specs/2026-07-11-app-act-design.md.
 * Originally observe-only; now also performs narrow, hardcoded
 * performAction()-based actions (ShellyAccessibilityService.debugSendLineMessage
 * / debugPostToX, each reachable only from a manual debug button — see that
 * file). Note that `canPerformGestures` was never needed for this:
 * performAction(ACTION_CLICK / ACTION_SET_TEXT) only requires
 * canRetrieveWindowContent (set below) — gesture-dispatch capability gates a
 * different, lower-level API (dispatchGesture()) that this service does not
 * use. Scoped to an explicit package allowlist (LINE + X/Twitter) — never a
 * general screen-reader.
 *
 * Like TerminalSessionService/ShellyNotificationListener, this must go
 * through a config plugin — expo prebuild regenerates android/ and
 * silently drops hand-edited manifest entries with no corresponding
 * plugin (see with-terminal-service.js's doc comment for the confirmed
 * BootCompletedReceiver incident this pattern avoids repeating).
 *
 * android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE" on
 * the <service> element restricts BINDING to callers holding that
 * system-signature permission (only the OS) — the same pattern already
 * used for BIND_NOTIFICATION_LISTENER_SERVICE in with-terminal-service.js,
 * not the receiver-level android:permission mistake that broke
 * BootCompletedReceiver delivery.
 */
const { withAndroidManifest, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

const ACCESSIBILITY_SERVICE_CONFIG = `<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeWindowStateChanged|typeWindowContentChanged"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:accessibilityFlags="flagReportViewIds"
    android:canRetrieveWindowContent="true"
    android:packageNames="jp.naver.line.android,com.twitter.android"
    android:notificationTimeout="100" />
`;

function withAccessibilityService(config) {
  // Step 1: write accessibility_service_config.xml
  config = withDangerousMod(config, [
    "android",
    (config) => {
      const xmlDir = path.join(
        config.modRequest.platformProjectRoot,
        "app/src/main/res/xml"
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, "accessibility_service_config.xml"),
        ACCESSIBILITY_SERVICE_CONFIG
      );
      return config;
    },
  ]);

  // Step 2: register the <service> in AndroidManifest.xml
  config = withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) return config;

    if (!application.service) {
      application.service = [];
    }

    const serviceName = "expo.modules.terminalemulator.ShellyAccessibilityService";
    const existing = application.service.find(
      (s) => s.$?.["android:name"] === serviceName
    );
    if (!existing) {
      application.service.push({
        $: {
          "android:name": serviceName,
          "android:exported": "true",
          "android:permission": "android.permission.BIND_ACCESSIBILITY_SERVICE",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name": "android.accessibilityservice.AccessibilityService",
                },
              },
            ],
          },
        ],
        "meta-data": [
          {
            $: {
              "android:name": "android.accessibilityservice",
              "android:resource": "@xml/accessibility_service_config",
            },
          },
        ],
      });
    }

    return config;
  });

  return config;
}

module.exports = withAccessibilityService;
