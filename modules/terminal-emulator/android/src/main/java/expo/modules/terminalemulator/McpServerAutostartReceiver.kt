package expo.modules.terminalemulator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Brings the MCP server back after a reboot (BOOT_COMPLETED) and after an
 * app update (MY_PACKAGE_REPLACED), without Shelly being opened — but only
 * when the owner has the MCP server enabled in Settings (the Keystore-backed
 * mirror McpAutostartStore; OFF / unreadable = nothing happens).
 *
 * Declared exported=true in the module AndroidManifest.xml, the
 * BootCompletedReceiver style that is verified on device. Both actions are
 * protected broadcasts that only the system can send, and anything else is
 * ignored below, so another app cannot use this receiver to start the
 * server. Both broadcasts are exempt from Android 12+'s background
 * foreground-service start restriction, and specialUse is not one of the
 * types Android 15 bars from BOOT_COMPLETED receivers (see McpServerService).
 * No LOCKED_BOOT_COMPLETED: the mirror lives in credential-encrypted prefs.
 */
class McpServerAutostartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val reason = if (action == Intent.ACTION_BOOT_COMPLETED) "boot" else "package replaced"
        McpServerSupervisor.requestAutostart(context, reason)
    }
}
