package expo.modules.terminalemulator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * "Keep ChatGPT connected": brings the Codex remote-control host back after a
 * reboot (BOOT_COMPLETED) and after an in-app update (MY_PACKAGE_REPLACED).
 * Both broadcasts are exempt from Android 12+'s background foreground-service
 * start restriction, and both are protected system broadcasts, so the
 * receiver is exported=false (plugins/with-terminal-service.js; expo prebuild
 * drops hand-edited manifest receivers). The decision itself is
 * CodexRemoteHost.requestStartIfWanted: the Keystore-verified in-app opt-in,
 * no STOP-ALL, and no `shelly codex stop` since the user last opened Shelly.
 */
class CodexRemoteAutostartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        CodexRemoteHost.requestStartIfWanted(context, action)
    }
}
