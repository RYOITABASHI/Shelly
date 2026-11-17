package expo.modules.terminalemulator

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import android.util.Log

/**
 * Wireless debugging on/off for the connectivity guardian, through the
 * Settings.Global key `adb_wifi_enabled` (Android 11+; the hidden constant
 * Settings.Global.ADB_WIFI_ENABLED).
 *
 * Writing needs WRITE_SECURE_SETTINGS (signature|privileged|development).
 * Shelly declares it (app.config.ts) but it is only ever granted by a
 * one-time `pm grant dev.shelly.terminal android.permission.WRITE_SECURE_SETTINGS`
 * from the shell uid: a device-phase setup step, never attempted in code.
 * Without the grant [write] returns false and the guardian falls back to an
 * assist notification.
 *
 * Consent: on a network Android does not yet trust it shows "Allow wireless
 * debugging on this network?" instead of enabling. Nothing here (or anywhere
 * in the guardian) answers that dialog; the runner sees the value not take
 * effect and stops with a notification.
 */
object WifiDebugControl {
    private const val TAG = "WifiDebugControl"
    const val KEY_ADB_WIFI_ENABLED = "adb_wifi_enabled"

    fun hasGrant(context: Context): Boolean = try {
        context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED
    } catch (e: Exception) {
        false
    }

    /** 1 / 0, or null when it cannot be read (e.g. restricted for this targetSdk). */
    fun read(context: Context): Int? = try {
        if (Settings.Global.getInt(context.contentResolver, KEY_ADB_WIFI_ENABLED, 0) == 1) 1 else 0
    } catch (e: Exception) {
        Log.w(TAG, "adb_wifi_enabled unreadable type=${e.javaClass.simpleName}")
        null
    }

    /** Only 0 or 1, only with the grant. False on anything else. */
    fun write(context: Context, value: Int): Boolean {
        if (value != 0 && value != 1) return false
        if (!hasGrant(context)) return false
        return try {
            Settings.Global.putInt(context.contentResolver, KEY_ADB_WIFI_ENABLED, value)
        } catch (e: Exception) {
            Log.w(TAG, "adb_wifi_enabled write failed type=${e.javaClass.simpleName}")
            false
        }
    }
}
