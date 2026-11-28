package expo.modules.terminalemulator

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log

/**
 * Detection only (shelly-hayato-bridge #6 item 1): watches
 * Settings.Global `overlay_display_devices` (readable without a permission)
 * and, whenever it holds a display (not null / "" / "none"), writes one audit
 * line (`residency_guard`, event/action `overlay`, code `overlay_detected`,
 * the value's length only — never the value) and a warning under the tag
 * `OverlayGuard`. Shelly never writes the setting (it does not and must not
 * hold WRITE_SECURE_SETTINGS).
 *
 * Registered by TerminalSessionService.onCreate (where the supervisor is
 * adopted), unregistered in onDestroy. The current value is checked once at
 * registration too; the same value is reported once per process.
 */
object OverlayGuard {
    private const val TAG = "OverlayGuard"
    private const val SETTING = "overlay_display_devices"

    private var observer: ContentObserver? = null
    @Volatile private var lastReported: String? = null

    /** True for a value that names an overlay display. Pure. */
    fun isOverlay(value: String?): Boolean {
        val v = value?.trim() ?: return false
        return v.isNotEmpty() && !v.equals("none", ignoreCase = true)
    }

    @Synchronized
    fun register(context: Context) {
        if (observer != null) return
        val app = context.applicationContext
        try {
            val o = object : ContentObserver(Handler(Looper.getMainLooper())) {
                override fun onChange(selfChange: Boolean) = check(app)
            }
            app.contentResolver.registerContentObserver(Settings.Global.getUriFor(SETTING), false, o)
            observer = o
            check(app)
        } catch (e: Exception) {
            Log.w(TAG, "overlay observer not registered type=${e.javaClass.simpleName}")
        }
    }

    @Synchronized
    fun unregister(context: Context) {
        val o = observer ?: return
        observer = null
        runCatching { context.applicationContext.contentResolver.unregisterContentObserver(o) }
    }

    private fun check(context: Context) {
        try {
            val value = Settings.Global.getString(context.contentResolver, SETTING)
            if (!isOverlay(value)) {
                lastReported = null
                return
            }
            if (value == lastReported) return
            lastReported = value
            val len = value?.length ?: 0
            Log.w(TAG, "overlay display configured (overlay_display_devices length=$len)")
            Thread({
                if (!IngressAuditWriter.appendResidencyGuardLine(context, "overlay", "overlay_detected", null, len)) {
                    Log.w(TAG, "overlay audit line not written")
                }
            }, "ShellyOverlayGuard").apply { isDaemon = true; start() }
        } catch (e: Exception) {
            Log.w(TAG, "overlay check failed type=${e.javaClass.simpleName}")
        }
    }
}
