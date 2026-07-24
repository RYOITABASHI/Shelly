package expo.modules.terminalemulator

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.StatFs
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.time.Instant

/**
 * DeviceStatusBridge — read-only device system status (battery, and future
 * additions in the same shape), refreshed natively right before every agent
 * run and handed to the model as plain prompt context instead of a tool call.
 *
 * Why prompt injection, not a model-callable tool: a scheduled/unattended
 * agent's task (e.g. "notify current battery level") was on-device-observed
 * asking the model to fetch this itself, which meant the model guessing a
 * shell command — `find /sys/class/power_supply ...` — that Android's
 * SELinux policy denies to an unprivileged app's shell process (root would be
 * needed), even though the SAME data is trivially available to the app
 * itself via the public, unprivileged BatteryManager API used below. Two
 * routes were considered and rejected before this one:
 *   1. Let the model read a status file via a shell command at runtime —
 *      this is a path outside the agent's workspace root, so it would always
 *      trip the boundary-policy `leaves-root` signal (lib/agent-boundary-
 *      policy.ts) and force a human approval tap. That policy is
 *      security-critical, audited multiple times (docs/superpowers/
 *      DEFERRED.md 自律エージェント制御面レビュー), and this data (OS-level,
 *      non-secret, refreshed by Shelly itself) doesn't warrant touching it.
 *   2. Expose it as a new capability-broker (FS-001) operation the model
 *      calls at runtime — more general, but real new runtime surface for a
 *      class of data that's cheap to just always have on hand.
 * This route sidesteps both: AgentRuntime.kt's own (non-model, Shelly-
 * authored) code writes the snapshot, and lib/agent-executor.ts's generated
 * script reads it with plain shell BEFORE ever invoking the model — the
 * model never proposes or executes a command to get this data, so neither
 * the boundary classifier nor the capability broker is ever in the loop.
 * Mirrors the existing CURRENT_DATETIME_CONTEXT precedent (lib/agent-
 * executor.ts, v19, 2026-07-17) exactly: ground the model in real runtime
 * facts up front rather than let it guess, hallucinate, or attempt a doomed
 * shell command.
 *
 * Designed to grow: each capability is its own top-level JSON key in its own
 * file under deviceStatusDir(), written by its own small function below.
 * lib/agent-executor.ts's DEVICE_STATUS_CONTEXT reads every *.json file in
 * that directory generically (no per-capability wiring needed on the JS
 * side when a new one is added here).
 */
object DeviceStatusBridge {
    private const val TAG = "DeviceStatusBridge"

    fun deviceStatusDir(homeDir: File): File = File(homeDir, ".shelly/device-status")

    /**
     * Refreshes every known capability snapshot. Called once per agent run
     * (AgentRuntime.kt::runAgent, before the legacy .sh / PlanSpec branch —
     * a single chokepoint covers both executors). Each capability writer is
     * independently try/caught: one failing (e.g. a BatteryManager quirk on
     * some OEM build) must never block the agent run itself, and must never
     * leave a stale/wrong snapshot from a previous run lying around for a
     * capability that failed just now — see writeBatterySnapshot's own
     * fail-closed-by-deletion behavior.
     */
    fun refreshAll(context: Context, homeDir: File) {
        val dir = deviceStatusDir(homeDir)
        try {
            dir.mkdirs()
        } catch (e: Exception) {
            Log.w(TAG, "could not create device-status dir", e)
            return
        }
        writeBatterySnapshot(context, dir)
        writeStorageSnapshot(context, dir)
    }

    /**
     * Battery level + charging state via the public BatteryManager API
     * (no permission required, unlike a raw sysfs read). Writes a single
     * compact JSON line: {"battery":{"level":83,"charging":false,"asOf":"…"}}
     * — the top-level "battery" key is what lets lib/agent-executor.ts's
     * generic multi-file reader merge this with other capability files
     * (storage.json, network.json, …) into one object without collision.
     */
    private fun writeBatterySnapshot(context: Context, dir: File) {
        val file = File(dir, "battery.json")
        try {
            val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
            val level = bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
            if (level < 0 || level > 100) {
                // Fails closed: no plausible reading (some OEM builds return
                // -1/Int.MIN_VALUE when unsupported) — delete any stale
                // snapshot from a previous run rather than leave wrong data
                // for the model to read as current.
                file.delete()
                return
            }
            // ACTION_BATTERY_CHANGED registered with a null receiver returns
            // the last sticky broadcast synchronously — the standard,
            // documented way to read charging state without an actual
            // listener. BatteryManager itself has no direct "is charging"
            // getter pre-API 33 (isCharging was added in 33; minSdk here is
            // 24 — see app.config.ts), so this sticky-intent read is the
            // portable path across the whole supported OS range.
            val status = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            val statusInt = status?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
            val charging = statusInt == BatteryManager.BATTERY_STATUS_CHARGING ||
                statusInt == BatteryManager.BATTERY_STATUS_FULL
            val json = JSONObject()
                .put("battery", JSONObject()
                    .put("level", level)
                    .put("charging", charging)
                    .put("asOf", Instant.now().toString()))
            val tmp = File(dir, ".battery.json.${android.os.Process.myPid()}.${System.nanoTime()}.tmp")
            tmp.writeText(json.toString())
            if (!tmp.renameTo(file)) {
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "battery snapshot failed", e)
            file.delete()
        }
    }

    /**
     * Free/total storage via android.os.StatFs on the app's own internal
     * files directory (context.filesDir) — a no-permission-needed,
     * always-accessible mount point, unlike Environment.getDataDirectory()
     * (the shared /data mount, which is not guaranteed readable from an
     * unprivileged app on every OEM build) or /sdcard (needs
     * MANAGE_EXTERNAL_STORAGE and is a different, larger volume than what
     * actually constrains the app). Writes a single compact JSON line:
     * {"storage":{"freeBytes":123,"totalBytes":456,"asOf":"…"}} — same
     * top-level-key convention as writeBatterySnapshot so lib/agent-
     * executor.ts's generic multi-file reader merges this in without
     * collision.
     */
    private fun writeStorageSnapshot(context: Context, dir: File) {
        val file = File(dir, "storage.json")
        try {
            val stat = StatFs(context.filesDir.path)
            val freeBytes = stat.blockSizeLong * stat.availableBlocksLong
            val totalBytes = stat.blockSizeLong * stat.blockCountLong
            if (freeBytes < 0 || totalBytes <= 0 || freeBytes > totalBytes) {
                // Fails closed: no plausible reading — delete any stale
                // snapshot from a previous run rather than leave wrong data
                // for the model to read as current (mirrors
                // writeBatterySnapshot's implausible-value handling).
                file.delete()
                return
            }
            val json = JSONObject()
                .put("storage", JSONObject()
                    .put("freeBytes", freeBytes)
                    .put("totalBytes", totalBytes)
                    .put("asOf", Instant.now().toString()))
            val tmp = File(dir, ".storage.json.${android.os.Process.myPid()}.${System.nanoTime()}.tmp")
            tmp.writeText(json.toString())
            if (!tmp.renameTo(file)) {
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "storage snapshot failed", e)
            file.delete()
        }
    }
}
