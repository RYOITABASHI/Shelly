package expo.modules.terminalemulator

import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.io.File

/**
 * Writes `$HOME/.shelly/app-info.json` with facts the shell cannot read for
 * itself: an app uid cannot run `dumpsys package` / `dumpsys deviceidle`, so
 * `shelly doctor --report` used to print "unknown" for Shelly's own version,
 * the notification permission and the battery-optimization exemption.
 *
 * Refreshed on every HomeInitializer.initialize() (app start, agent runtime,
 * remote-control host start), so the values are "as of the last Shelly start".
 * Holds no identifiers, tokens or paths.
 */
object AppInfoSnapshot {
    private const val TAG = "AppInfoSnapshot"

    fun write(context: Context, home: File) {
        try {
            val pm = context.packageManager
            val info = pm.getPackageInfo(context.packageName, 0)
            val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                info.longVersionCode
            } else {
                @Suppress("DEPRECATION")
                info.versionCode.toLong()
            }
            val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
            val json = JSONObject()
                .put("versionName", info.versionName ?: "")
                .put("versionCode", versionCode)
                .put("notificationsEnabled", NotificationManagerCompat.from(context).areNotificationsEnabled())
                .put("ignoringBatteryOptimizations", power?.isIgnoringBatteryOptimizations(context.packageName) ?: JSONObject.NULL)
                .put("writtenAtMs", System.currentTimeMillis())
            val dir = File(home, ".shelly").apply { mkdirs() }
            val tmp = File(dir, "app-info.json.tmp")
            tmp.writeText(json.toString())
            if (!tmp.renameTo(File(dir, "app-info.json"))) tmp.delete()
        } catch (t: Throwable) {
            Log.w(TAG, "app-info snapshot failed: ${t.message}")
        }
    }
}
