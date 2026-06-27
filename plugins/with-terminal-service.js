/**
 * Expo config plugin: register TerminalSessionService as a foreground service.
 *
 * Since `expo prebuild --clean` regenerates the android/ directory, service
 * declarations must go through a config plugin rather than editing
 * AndroidManifest.xml directly.
 *
 * This plugin:
 * - Adds the <service> element for TerminalSessionService
 * - Sets android:foregroundServiceType="specialUse" (API 34+ requirement)
 * - Sets stopWithTask=false so onTaskRemoved() fires instead of auto-kill
 * - Registers AgentAlarmReceiver (legacy bridge for alarms armed by older builds;
 *   new alarms target the service directly via getForegroundService)
 */
const { withAndroidManifest } = require("expo/config-plugins");

function withTerminalService(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) return config;

    // Ensure the service array exists
    if (!application.service) {
      application.service = [];
    }

    const serviceName =
      "expo.modules.terminalemulator.TerminalSessionService";

    // Don't add duplicate
    const existing = application.service.find(
      (s) => s.$?.["android:name"] === serviceName
    );
    if (!existing) {
      application.service.push({
        $: {
          "android:name": serviceName,
          "android:exported": "false",
          "android:stopWithTask": "false",
          "android:foregroundServiceType": "specialUse",
        },
        // specialUse requires a <property> explaining the use case (API 34+)
        property: [
          {
            $: {
              "android:name":
                "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE",
              "android:value": "terminal_session",
            },
          },
        ],
      });
    }

    // Register AgentAlarmReceiver. New alarms target the service directly, but this
    // receiver is still needed as a backward-compat bridge for any alarm armed by an
    // older build via getBroadcast. Declared here so a clean prebuild keeps it.
    if (!application.receiver) {
      application.receiver = [];
    }
    const receiverName = "expo.modules.terminalemulator.AgentAlarmReceiver";
    const receiverExists = application.receiver.find(
      (r) => r.$?.["android:name"] === receiverName
    );
    if (!receiverExists) {
      application.receiver.push({
        $: {
          "android:name": receiverName,
          "android:exported": "false",
        },
      });
    }

    return config;
  });
}

module.exports = withTerminalService;
