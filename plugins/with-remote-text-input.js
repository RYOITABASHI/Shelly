/**
 * Expo config plugin: register RemoteTextInputReceiver (REMOTE-INPUT-001).
 *
 * Adb-triggerable Unicode text injection into whatever text input is
 * currently focused in Shelly — see RemoteTextInputReceiver.kt's doc comment
 * for the full rationale (Android's `adb shell input text` can't synthesize
 * CJK KeyEvents; scrcpy's default Unicode injection mode doesn't reliably
 * reach RN TextInput's JS-side state either).
 *
 * Like TerminalSessionService/ShellyNotificationListener, this MUST go
 * through a config plugin — expo
 * prebuild regenerates android/ and silently drops hand-edited manifest
 * entries with no corresponding plugin (see with-terminal-service.js's doc
 * comment for the confirmed BootCompletedReceiver incident this pattern
 * avoids repeating; commit 58a378834 added a <receiver> directly to the
 * checked-in manifest and it was absent from every CI-built APK).
 *
 * android:exported="true" is required: adb runs as a different UID (`shell`,
 * 2000) than this app, and an implicit broadcast from a different UID is
 * only delivered to an exported component.
 *
 * android:permission="android.permission.DUMP" gates who may SEND this
 * broadcast (receiver-level android:permission is a sender-side check, not a
 * self-protecting one — see the BootCompletedReceiver comment in
 * with-terminal-service.js for the same distinction). DUMP is a
 * platform-defined protectionLevel="signature|privileged" permission that
 * AOSP's platform.xml pre-grants to the shell UID, which is the standard
 * Android idiom for "adb-only, but not reachable by an arbitrary third-party
 * app" (a Play Store app cannot hold a signature|privileged permission — it
 * isn't signed with the platform certificate). This was chosen deliberately
 * INSTEAD OF a brand-new custom signature permission
 * (dev.shelly.terminal.permission.REMOTE_INPUT): a custom signature
 * permission is only auto-granted to callers signed with Shelly's own
 * release certificate, which `adb shell` (uid 2000, non-rooted retail "user"
 * build) can never be — that would silently break the exact adb delivery
 * path this feature exists for, repeating the BootCompletedReceiver mistake.
 * UNVERIFIED ON THIS SPECIFIC DEVICE (Samsung Knox has surprised this
 * codebase before) — confirm with a real `adb shell am broadcast` before
 * relying on this gate.
 */
const { withAndroidManifest } = require("expo/config-plugins");

const RECEIVER_NAME = "expo.modules.terminalemulator.RemoteTextInputReceiver";
const ACTION_NAME = "dev.shelly.terminal.REMOTE_TEXT_INPUT";

function withRemoteTextInput(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) return config;

    if (!application.receiver) {
      application.receiver = [];
    }

    const existing = application.receiver.find(
      (r) => r.$?.["android:name"] === RECEIVER_NAME
    );
    if (!existing) {
      application.receiver.push({
        $: {
          "android:name": RECEIVER_NAME,
          "android:exported": "true",
          "android:permission": "android.permission.DUMP",
        },
        "intent-filter": [
          {
            action: [
              {
                $: {
                  "android:name": ACTION_NAME,
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

module.exports = withRemoteTextInput;
