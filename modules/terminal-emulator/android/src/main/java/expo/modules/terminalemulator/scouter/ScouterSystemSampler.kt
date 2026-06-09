package expo.modules.terminalemulator.scouter

import android.app.ActivityManager
import android.content.Context
import android.os.Debug
import android.util.Log
import org.json.JSONObject
import java.io.File

data class ScouterSystemLoad(
    val sampledAt: Long,
    val cpuPercent: Double?,
    val appCpuPercent: Double?,
    val appPssMb: Long?,
    val appHeapUsedMb: Long,
    val appHeapMaxMb: Long,
    val ramAvailableMb: Long?,
    val ramTotalMb: Long?
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("sampledAt", sampledAt)
        putNullable("cpuPercent", cpuPercent)
        putNullable("appCpuPercent", appCpuPercent)
        putNullable("appPssMb", appPssMb)
        put("appHeapUsedMb", appHeapUsedMb)
        put("appHeapMaxMb", appHeapMaxMb)
        putNullable("ramAvailableMb", ramAvailableMb)
        putNullable("ramTotalMb", ramTotalMb)
    }

    private fun JSONObject.putNullable(name: String, value: Any?) {
        put(name, value ?: JSONObject.NULL)
    }
}

class ScouterSystemSampler(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences("scouter_system_load", Context.MODE_PRIVATE)

    fun sample(): ScouterSystemLoad {
        return runCatching { sampleUnsafe() }
            .getOrElse {
                Log.w(TAG, "System load sample failed; returning fallback values", it)
                fallback(System.currentTimeMillis())
            }
    }

    private fun sampleUnsafe(): ScouterSystemLoad {
        val now = System.currentTimeMillis()
        val ticks = readCpuTicks()
        val appTicks = readAppCpuTicks()
        val previousTotal = prefs.getLong(KEY_CPU_TOTAL, -1L)
        val previousIdle = prefs.getLong(KEY_CPU_IDLE, -1L)
        val previousApp = prefs.getLong(KEY_APP_CPU_TOTAL, -1L)
        val totalDelta = ticks?.let { it.total - previousTotal }
        val cpuPercent = if (ticks != null && previousTotal >= 0L && previousIdle >= 0L) {
            val idleDelta = ticks.idle - previousIdle
            if (totalDelta != null && totalDelta > 0L) {
                ((totalDelta - idleDelta).coerceAtLeast(0L).toDouble() / totalDelta.toDouble() * 100.0)
                    .coerceIn(0.0, 100.0)
            } else {
                null
            }
        } else {
            null
        }
        val appCpuPercent = if (appTicks != null && previousApp >= 0L && previousTotal >= 0L && totalDelta != null && totalDelta > 0L) {
            ((appTicks - previousApp).coerceAtLeast(0L).toDouble() / totalDelta.toDouble() * 100.0)
                .coerceIn(0.0, 100.0)
        } else {
            null
        }
        if (ticks != null) {
            val editor = prefs.edit()
                .putLong(KEY_CPU_TOTAL, ticks.total)
                .putLong(KEY_CPU_IDLE, ticks.idle)
                .putLong(KEY_SAMPLED_AT, now)
            if (appTicks != null) editor.putLong(KEY_APP_CPU_TOTAL, appTicks)
            editor.apply()
        }

        val runtime = Runtime.getRuntime()
        val heapUsed = (runtime.totalMemory() - runtime.freeMemory()).toMb()
        val heapMax = runtime.maxMemory().toMb()
        val pss = runCatching {
            Debug.MemoryInfo().also { Debug.getMemoryInfo(it) }.totalPss.toLong().kilobytesToMb()
        }.getOrNull()
        val memoryInfo = systemMemory()

        return ScouterSystemLoad(
            sampledAt = now,
            cpuPercent = cpuPercent,
            appCpuPercent = appCpuPercent,
            appPssMb = pss,
            appHeapUsedMb = heapUsed,
            appHeapMaxMb = heapMax,
            ramAvailableMb = memoryInfo?.availMem?.toMb(),
            ramTotalMb = memoryInfo?.totalMem?.toMb()
        )
    }

    private fun systemMemory(): ActivityManager.MemoryInfo? {
        val manager = appContext.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return null
        return ActivityManager.MemoryInfo().also { manager.getMemoryInfo(it) }
    }

    private fun fallback(now: Long): ScouterSystemLoad {
        val runtime = Runtime.getRuntime()
        return ScouterSystemLoad(
            sampledAt = now,
            cpuPercent = null,
            appCpuPercent = null,
            appPssMb = null,
            appHeapUsedMb = (runtime.totalMemory() - runtime.freeMemory()).toMb(),
            appHeapMaxMb = runtime.maxMemory().toMb(),
            ramAvailableMb = null,
            ramTotalMb = null
        )
    }

    private fun readCpuTicks(): CpuTicks? {
        val line = runCatching {
            File("/proc/stat").useLines { lines ->
                lines.firstOrNull { it.startsWith("cpu ") }
            }
        }.getOrNull() ?: return null
        val values = line.trim()
            .split(Regex("\\s+"))
            .drop(1)
            .mapNotNull { it.toLongOrNull() }
        if (values.size < 5) return null
        val idle = values.getOrElse(3) { 0L } + values.getOrElse(4) { 0L }
        val total = values.take(8).sum()
        if (total <= 0L) return null
        return CpuTicks(total = total, idle = idle)
    }

    private fun readAppCpuTicks(): Long? {
        val raw = runCatching { File("/proc/self/stat").readText() }.getOrNull() ?: return null
        val endOfName = raw.lastIndexOf(") ")
        if (endOfName < 0 || endOfName + 2 >= raw.length) return null
        val values = raw.substring(endOfName + 2)
            .trim()
            .split(Regex("\\s+"))
        val userTicks = values.getOrNull(11)?.toLongOrNull() ?: return null
        val systemTicks = values.getOrNull(12)?.toLongOrNull() ?: return null
        return userTicks + systemTicks
    }

    private fun Long.toMb(): Long = this / BYTES_PER_MB
    private fun Long.kilobytesToMb(): Long = this / KILOBYTES_PER_MB

    private data class CpuTicks(val total: Long, val idle: Long)

    companion object {
        private const val TAG = "ScouterSystemSampler"
        private const val KEY_CPU_TOTAL = "cpu_total"
        private const val KEY_CPU_IDLE = "cpu_idle"
        private const val KEY_APP_CPU_TOTAL = "app_cpu_total"
        private const val KEY_SAMPLED_AT = "sampled_at"
        private const val BYTES_PER_MB = 1024L * 1024L
        private const val KILOBYTES_PER_MB = 1024L
    }
}
