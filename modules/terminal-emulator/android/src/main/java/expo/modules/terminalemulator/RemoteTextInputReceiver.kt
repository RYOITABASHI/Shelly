package expo.modules.terminalemulator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * REMOTE-INPUT-001: adb-triggerable Unicode text injection.
 *
 * Why this exists: `adb shell input text "日本語"` throws a NullPointerException
 * on this device (Samsung Z Fold6, Android 16) — Android's `input` shell command
 * synthesizes KeyEvents via KeyCharacterMap, which has no physical-key mapping
 * for CJK. scrcpy's own default SDK-based Unicode injection mode has the same
 * synthetic-KeyEvent lineage and does not reliably reach React Native
 * TextInput's JS-side text state either (RN owns its text state via the IME
 * InputConnection.commitText() flow, not raw KeyEvents). This receiver
 * bypasses both problems: the text arrives as a plain Intent String extra
 * (UTF-8 safe, no KeyEvent synthesis at all) and is forwarded straight into
 * JS as a controlled-input state update — exactly like a normal keystroke.
 *
 * Security: android:exported="true" is required for adb (a different UID,
 * `shell`/2000) to reach this receiver at all — an implicit broadcast from a
 * different UID is not delivered to a non-exported component. To keep this
 * from being reachable by an arbitrary third-party app on the same device,
 * the <receiver> in AndroidManifest.xml (wired via
 * plugins/with-remote-text-input.js, NOT hand-edited — see that file's doc
 * comment for why) is gated with `android:permission="android.permission.DUMP"`
 * rather than a brand-new custom signature permission.
 *
 * This deviates from a naive "declare our own dev.shelly.terminal.permission.
 * REMOTE_INPUT with protectionLevel=signature" approach on purpose: a
 * receiver-level android:permission requires the SENDER to hold that
 * permission, and `adb shell` (uid 2000, non-rooted retail "user" build,
 * `adb root` unavailable) cannot be granted a permission that is only
 * auto-granted by matching Shelly's own release signing certificate — nothing
 * signs the shell package with that key. This codebase already hit exactly
 * this failure mode once: see with-terminal-service.js's BootCompletedReceiver
 * comment, where giving a receiver a permission the sender (system_server)
 * didn't hold silently broke delivery. android.permission.DUMP sidesteps it:
 * it's a platform-defined protectionLevel="signature|privileged" permission
 * that AOSP's platform.xml pre-grants to the shell UID specifically for
 * adb-only debug/dump entry points (a well-established Android idiom), while
 * remaining unobtainable by an ordinary third-party app (Play Store apps
 * cannot hold a signature|privileged permission — they aren't signed with the
 * platform certificate and aren't a privileged system partition app). Net
 * effect: adb shell can trigger this without root; other installed apps
 * cannot. UNVERIFIED ON THIS SPECIFIC DEVICE — Samsung Knox has surprised
 * this codebase before (see CLAUDE.md's Android OAuth constraints reference).
 * Confirm with the adb command documented in this feature's handoff notes
 * before relying on this gate in production.
 */
class RemoteTextInputReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "RemoteTextInputReceiver"
        const val ACTION = "dev.shelly.terminal.REMOTE_TEXT_INPUT"
        const val EXTRA_TEXT = "text"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val text = intent.getStringExtra(EXTRA_TEXT)
        if (text.isNullOrEmpty()) {
            Log.w(TAG, "Received broadcast with no/empty 'text' extra — ignoring")
            return
        }
        Log.i(TAG, "Remote text input received, length=${text.length}")
        val delivered = TerminalEmulatorModule.emitRemoteTextInput(text)
        if (!delivered) {
            Log.w(TAG, "No live TerminalEmulatorModule instance bound — dropped (app not running/foregrounded?)")
        }
    }
}
