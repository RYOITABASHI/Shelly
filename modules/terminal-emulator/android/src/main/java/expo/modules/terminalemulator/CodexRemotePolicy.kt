package expo.modules.terminalemulator

/**
 * Pure decision logic for "Keep ChatGPT connected" (CodexRemoteHost.kt).
 * Zero android.* imports so it can be unit-tested on the JVM
 * (src/test/.../CodexRemotePolicyTest.kt).
 */
object CodexRemotePolicy {
    /** `shelly codex __host` exit codes (HomeInitializer.kt, __shelly_codex_remote_host). */
    const val EXIT_NOT_SIGNED_IN = 3
    const val EXIT_ALREADY_RUNNING = 4
    /** The generated ~/.bashrc did not define __shelly_codex_remote (stale / missing). */
    const val EXIT_NO_FUNCTION = 127

    const val BASE_BACKOFF_MS = 5_000L
    const val MAX_BACKOFF_MS = 5 * 60_000L
    const val NOT_SIGNED_IN_BACKOFF_MS = 10 * 60_000L
    /** A host that stayed up this long was healthy; its exit does not count as a failure streak. */
    const val HEALTHY_RUN_MS = 2 * 60_000L
    /** After a network change the host gets this long to show it reconnected. */
    const val NETWORK_GRACE_MS = 30_000L

    data class Inputs(
        val autostartOn: Boolean,
        val paired: Boolean,
        val halted: Boolean,
        val stopRequested: Boolean,
    )

    /** Whether a supervised host should exist right now (network aside). */
    fun shouldRun(i: Inputs): Boolean = i.autostartOn && i.paired && !i.halted && !i.stopRequested

    /**
     * What to do with a host that is running but no longer wanted: a host the
     * native supervisor started is always stopped; one started by hand
     * (`shelly codex pair --background`) is only stopped by STOP-ALL.
     */
    fun shouldStopUnwanted(i: Inputs, nativeOwned: Boolean): Boolean =
        !shouldRun(i) && (nativeOwned || i.halted)

    /** 5s, 10s, 20s ... capped at 5 min, for the n-th consecutive quick failure (n >= 1). */
    fun backoffMs(consecutiveFailures: Int): Long {
        if (consecutiveFailures <= 0) return 0L
        val shift = (consecutiveFailures - 1).coerceAtMost(10)
        return (BASE_BACKOFF_MS shl shift).coerceAtMost(MAX_BACKOFF_MS)
    }

    /** Delay before the next start attempt after the host exited with [exitCode]. */
    fun restartDelayMs(exitCode: Int, consecutiveFailures: Int): Long = when (exitCode) {
        EXIT_NOT_SIGNED_IN -> NOT_SIGNED_IN_BACKOFF_MS
        EXIT_ALREADY_RUNNING -> BASE_BACKOFF_MS
        else -> backoffMs(consecutiveFailures)
    }

    data class HostState(val pid: Int, val startTime: String, val nativeOwned: Boolean)

    /** Parses `$TMPDIR/shelly-codex-remote.host`: "<pid> <starttime> [native]". */
    fun parseState(text: String?): HostState? {
        val parts = text?.trim()?.split(Regex("\\s+")) ?: return null
        if (parts.size < 2) return null
        val pid = parts[0].toIntOrNull()?.takeIf { it > 1 } ?: return null
        if (parts[1].isEmpty() || !parts[1].all { it.isDigit() }) return null
        return HostState(pid, parts[1], parts.getOrNull(2) == "native")
    }

    /** Field 22 (starttime) of /proc/<pid>/stat, same as __shelly_codex_remote_proc_start. */
    fun procStartTime(stat: String?): String? {
        if (stat == null) return null
        val close = stat.lastIndexOf(") ")
        if (close < 0) return null
        val rest = stat.substring(close + 2).trim().split(Regex("\\s+"))
        return rest.getOrNull(19)?.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }
    }

    /** Parent pid (field 4) of /proc/<pid>/stat. */
    fun procParentPid(stat: String?): Int? {
        if (stat == null) return null
        val close = stat.lastIndexOf(") ")
        if (close < 0) return null
        return stat.substring(close + 2).trim().split(Regex("\\s+")).getOrNull(1)?.toIntOrNull()
    }

    /** All descendants of [root] given a pid -> ppid map (root excluded). */
    fun descendants(root: Int, parentOf: Map<Int, Int>): List<Int> {
        val children = HashMap<Int, MutableList<Int>>()
        for ((pid, ppid) in parentOf) if (pid != ppid) children.getOrPut(ppid) { mutableListOf() }.add(pid)
        val out = ArrayList<Int>()
        val queue = ArrayDeque(listOf(root))
        val seen = hashSetOf(root)
        while (queue.isNotEmpty()) {
            val p = queue.removeFirst()
            for (c in children[p].orEmpty()) if (seen.add(c)) { out.add(c); queue.addLast(c) }
        }
        return out
    }

    private val reconnectLine = Regex(
        "(?i)(available for remote control|\\breconnected\\b|\\bconnected to\\b|\\bconnection (re)?established\\b)"
    )
    private val failureLine = Regex("(?i)(disconnect|error|fail|retry|retrying|unable|timed out)")

    /**
     * Health signal after a network change: the host log written since the
     * change contains a line saying it is (again) available / connected and
     * no later line reports a failure.
     */
    fun logShowsReconnect(logSinceChange: String): Boolean {
        var ok = false
        for (line in logSinceChange.lineSequence()) {
            if (reconnectLine.containsMatchIn(line) && !failureLine.containsMatchIn(line)) ok = true
            else if (failureLine.containsMatchIn(line)) ok = false
        }
        return ok
    }
}
