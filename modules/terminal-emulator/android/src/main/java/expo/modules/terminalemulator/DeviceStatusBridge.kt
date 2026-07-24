package expo.modules.terminalemulator

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.StatFs
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.time.Instant

/**
 * DeviceStatusBridge — read-only device system status (battery, memory, and
 * future additions in the same shape), refreshed natively right before every
 * agent run and handed to the model as plain prompt context instead of a
 * tool call.
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
        writeMemorySnapshot(context, dir)
        writeNetworkSnapshot(context, dir)
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
                    .put("freeHuman", humanBytes(freeBytes))
                    .put("totalBytes", totalBytes)
                    .put("totalHuman", humanBytes(totalBytes))
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

    /**
     * Available/total RAM + low-memory state via the public ActivityManager
     * API (no permission required — this is the app's own process-level view
     * of system memory, unlike a privileged /proc/meminfo read). Writes a
     * single compact JSON line: {"memory":{"availBytes":123,"totalBytes":456,
     * "lowMemory":false,"asOf":"…"}} — the top-level "memory" key is what
     * lets lib/agent-executor.ts's generic multi-file reader merge this with
     * other capability files (battery.json, storage.json, …) into one object
     * without collision.
     */
    private fun writeMemorySnapshot(context: Context, dir: File) {
        val file = File(dir, "memory.json")
        try {
            val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            if (am == null) {
                file.delete()
                return
            }
            val memoryInfo = ActivityManager.MemoryInfo()
            am.getMemoryInfo(memoryInfo)
            val availBytes = memoryInfo.availMem
            val totalBytes = memoryInfo.totalMem
            if (totalBytes <= 0 || availBytes <= 0 || availBytes > totalBytes) {
                // Fails closed: no plausible reading — delete any stale
                // snapshot from a previous run rather than leave wrong data
                // for the model to read as current (mirrors
                // writeBatterySnapshot's own fail-closed-by-deletion path).
                file.delete()
                return
            }
            val json = JSONObject()
                .put("memory", JSONObject()
                    .put("availBytes", availBytes)
                    .put("availHuman", humanBytes(availBytes))
                    .put("totalBytes", totalBytes)
                    .put("totalHuman", humanBytes(totalBytes))
                    .put("lowMemory", memoryInfo.lowMemory)
                    .put("asOf", Instant.now().toString()))
            val tmp = File(dir, ".memory.json.${android.os.Process.myPid()}.${System.nanoTime()}.tmp")
            tmp.writeText(json.toString())
            if (!tmp.renameTo(file)) {
                tmp.delete()
            }
        } catch (e: Exception) {
            Log.w(TAG, "memory snapshot failed", e)
            file.delete()
        }
    }

    /**
     * Network connectivity TYPE only (wifi / cellular / other / none) via the
     * modern, non-deprecated ConnectivityManager#getNetworkCapabilities API
     * (minSdk 24 here, so activeNetwork + getNetworkCapabilities is safe —
     * the older NetworkInfo API is deprecated and avoided on purpose).
     * Deliberately does NOT read SSID or any network-identifying detail —
     * that requires location permission and is out of scope for this
     * capability; connectivity type only, nothing identifying. Requires
     * android.permission.ACCESS_NETWORK_STATE (normal protection level, no
     * runtime prompt — declared in app.config.ts, not hand-edited into
     * AndroidManifest.xml, per this project's "expo prebuild wipes manual
     * manifest edits" lesson). Writes a single compact JSON line:
     * {"network":{"connected":true,"type":"wifi","asOf":"…"}} — same
     * top-level-key convention as writeBatterySnapshot so
     * lib/agent-executor.ts's generic multi-file reader merges this in
     * without collision.
     */
    private fun writeNetworkSnapshot(context: Context, dir: File) {
        val file = File(dir, "network.json")
        try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            val activeNetwork = cm?.activeNetwork
            if (cm == null || activeNetwork == null) {
                // No active network is a legitimate "not connected" reading —
                // but "cm == null" (service unavailable) is not, and both
                // collapse to the same branch here for simplicity; the
                // capabilities-null branch below is what actually fails
                // closed on "cannot determine" vs. guessing "none".
                if (cm != null) {
                    val json = JSONObject()
                        .put("network", JSONObject()
                            .put("connected", false)
                            .put("type", "none")
                            .put("asOf", Instant.now().toString()))
                    writeAtomically(dir, file, "network", json)
                } else {
                    file.delete()
                }
                return
            }
            val caps = cm.getNetworkCapabilities(activeNetwork)
            if (caps == null) {
                // Fails closed: an active network handle exists but its
                // capabilities could not be looked up (races between the two
                // calls are possible) — treat as "cannot determine" and
                // delete any stale snapshot rather than guess.
                file.delete()
                return
            }
            val connected = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
            val type = when {
                caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
                caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
                else -> "other"
            }
            val json = JSONObject()
                .put("network", JSONObject()
                    .put("connected", connected)
                    .put("type", if (connected) type else "none")
                    .put("asOf", Instant.now().toString()))
            writeAtomically(dir, file, "network", json)
        } catch (e: Exception) {
            Log.w(TAG, "network snapshot failed", e)
            file.delete()
        }
    }

    /** Shared atomic tmp-file-then-rename write, mirroring
     *  writeBatterySnapshot's inline pattern so both capability writers stay
     *  byte-for-byte consistent in how they avoid a torn/partial read. */
    private fun writeAtomically(dir: File, file: File, key: String, json: JSONObject) {
        val tmp = File(dir, ".${key}.json.${android.os.Process.myPid()}.${System.nanoTime()}.tmp")
        tmp.writeText(json.toString())
        if (!tmp.renameTo(file)) {
            tmp.delete()
        }
    }

    /**
     * 2026-07-24 on-device finding: the raw byte counts alone ("99629735936")
     * led the local model to invent an incorrect/nonsensical unit label
     * ("99629735936 倍" — "times", not a unit of storage at all) when
     * composing its natural-language answer, rather than converting to
     * GB/MB itself. Alongside each *Bytes field, storage/memory snapshots
     * now also carry a pre-formatted *Human string (e.g. "92.8 GB") the
     * model can quote directly — the raw byte count stays too, for any
     * caller that wants exact arithmetic rather than a display string.
     */
    private fun humanBytes(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        val units = arrayOf("KB", "MB", "GB", "TB", "PB")
        var value = bytes.toDouble()
        var unitIndex = -1
        while (value >= 1024 && unitIndex < units.size - 1) {
            value /= 1024
            unitIndex += 1
        }
        return String.format("%.1f %s", value, units[unitIndex])
    }
}
