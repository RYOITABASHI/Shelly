/**
 * Expo config plugin: register TerminalSessionService as a foreground service.
 *
 * Since `expo prebuild` regenerates the android/ directory (observed: even
 * without --clean, prebuild reported "The android project is malformed,
 * project files will be cleared and reinitialized" and wiped android/ on a
 * plain CI run), service/receiver declarations must go through a config
 * plugin rather than editing AndroidManifest.xml directly. A hand-edited
 * <receiver> with no corresponding plugin is silently dropped on the next
 * prebuild — this is exactly what happened to BootCompletedReceiver (added
 * directly to the checked-in manifest in commit 58a378834): it parsed fine
 * from source, round-tripped fine through xml2js, yet was absent from every
 * built APK because CI's `expo prebuild` step never preserved it. Confirmed
 * via 4 on-device reboot cycles (BootCompletedReceiver never in
 * `dumpsys activity broadcasts history`) and locally reproduced by running
 * `npx expo prebuild --platform android` and diffing the regenerated
 * manifest.
 *
 * This plugin:
 * - Adds the <service> element for TerminalSessionService
 * - Sets android:foregroundServiceType="specialUse" (API 34+ requirement)
 * - Sets stopWithTask=false so onTaskRemoved() fires instead of auto-kill
 * - Registers AgentAlarmReceiver (legacy bridge for alarms armed by older builds;
 *   new alarms target the service directly via getForegroundService)
 * - Registers ShellyNotificationListener (NOTIFY-001 Increment 0, dormant
 *   plumbing-only until the native enable flag is flipped — see
 *   ShellyNotificationListener.kt). android:permission on THIS element is
 *   correct (unlike the receiver-level mistake fixed for BootCompletedReceiver):
 *   for a <service>, android:permission means "only callers holding this
 *   permission may bind", and BIND_NOTIFICATION_LISTENER_SERVICE is a
 *   system-signature permission only the OS holds — this is the standard,
 *   required declaration for a NotificationListenerService.
 * - Registers BootCompletedReceiver (L1 boot-autostart floor, dormant until
 *   the native enable flag is flipped — see AgentAlarmScheduler.kt)
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

    // Register BootCompletedReceiver (L1 boot-autostart floor, dormant/flag-OFF
    // — see AgentAlarmScheduler.bootAutostartEnabled). exported=true is required
    // to receive the system BOOT_COMPLETED broadcast. No android:permission
    // attribute: that would require the SENDER (system_server) to hold the
    // named permission, which observably breaks delivery (dumpsys showed
    // "Permission Denial ... due to sender null (uid 1000)" for other apps'
    // receivers using that mistaken pattern). The <uses-permission> declared
    // via app.config.ts's permissions list is what actually grants this app
    // the ability to receive the broadcast.
    const bootReceiverName =
      "expo.modules.terminalemulator.BootCompletedReceiver";
    const bootReceiverExists = application.receiver.find(
      (r) => r.$?.["android:name"] === bootReceiverName
    );
    if (!bootReceiverExists) {
      application.receiver.push({
        $: {
          "android:name": bootReceiverName,
          "android:exported": "true",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name": "android.intent.action.BOOT_COMPLETED",
                },
              },
            ],
          },
        ],
      });
    }

    // Register ShellyNotificationListener (NOTIFY-001 Increment 0, dormant
    // plumbing-only — see ShellyNotificationListener.notificationListenerEnabled,
    // default false). exported=false, matching Android's own official
    // NotificationListenerService declaration pattern. The
    // BIND_NOTIFICATION_LISTENER_SERVICE permission on the <service> element
    // already restricts BINDING to callers holding that system-signature
    // permission (only the OS), independent of exported — that permission
    // check is a different mechanism than the receiver-level
    // android:permission mistake fixed for BootCompletedReceiver (that
    // required the SENDER to hold the permission and broke delivery).
    // exported=false narrows the declared component surface without
    // affecting the OS's ability to bind for real notification-listener use.
    const notificationListenerName =
      "expo.modules.terminalemulator.ShellyNotificationListener";
    const notificationListenerExists = application.service.find(
      (s) => s.$?.["android:name"] === notificationListenerName
    );
    if (!notificationListenerExists) {
      application.service.push({
        $: {
          "android:name": notificationListenerName,
          "android:exported": "false",
          "android:permission":
            "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name":
                    "android.service.notification.NotificationListenerService",
                },
              },
            ],
          },
        ],
      });
    }

    return config;
  });
}

module.exports = withTerminalService;
