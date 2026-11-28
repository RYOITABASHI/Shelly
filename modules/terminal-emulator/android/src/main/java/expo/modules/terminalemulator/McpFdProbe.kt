package expo.modules.terminalemulator

import android.util.Log
import java.io.File

/**
 * Logs this process's open fd count (entries of /proc/self/fd) after a typed /
 * raw MCP result is written (shelly-hayato-bridge #6: an Os.open without
 * Os.close leaked one fd per call). The app process's /proc/<pid>/fd is not
 * readable from adb (shell) or from run_command children, so this log line is
 * how the fix is measured on device: `adb logcat -s McpFdProbe`.
 * Count only, never paths or names.
 */
internal object McpFdProbe {
    private const val TAG = "McpFdProbe"

    fun log(source: String, what: String) {
        val n = try { File("/proc/self/fd").list()?.size ?: -1 } catch (e: Exception) { -1 }
        Log.i(TAG, "fd_count=$n after=$source:$what")
    }
}
