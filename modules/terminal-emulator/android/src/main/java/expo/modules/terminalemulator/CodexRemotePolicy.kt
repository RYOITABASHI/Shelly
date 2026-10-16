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
        /** Keystore-verified native ON switch (CodexRemoteAutostart). */
        val autostartOn: Boolean,
        /** STOP-ALL sentinel seen now, or latched earlier in this process. */
        val halted: Boolean,
        /** `shelly codex stop` / notification Exit until the user next opens Shelly. */
        val stopRequested: Boolean,
        /** TerminalSessionService exists and is in the foreground state. */
        val serviceForeground: Boolean,
        /** The user can see the "ChatGPT can run commands" notification. */
        val notificationsEnabled: Boolean,
    )

    /** The user wants a host (keeps the foreground service alive while true). */
    fun wanted(i: Inputs): Boolean = i.autostartOn && !i.halted && !i.stopRequested

    /** A supervised host may run right now (network aside). */
    fun mayRun(i: Inputs): Boolean = wanted(i) && i.serviceForeground && i.notificationsEnabled

    /**
     * What to do with a host that is running but may not run: a host the
     * native supervisor started is always stopped; one started by hand
     * (`shelly codex pair --background`) is only stopped by STOP-ALL.
     */
    fun shouldStopUnwanted(i: Inputs, nativeOwned: Boolean): Boolean =
        !mayRun(i) && (nativeOwned || i.halted)

    /** Once STOP-ALL is seen, stay halted for the process until an in-app re-enable clears it. */
    fun latchHalt(latched: Boolean, sentinelPresent: Boolean): Boolean = latched || sentinelPresent

    /** 5s, 10s, 20s ... capped at 5 min, for the n-th consecutive quick failure (n >= 1). */
    fun backoffMs(consecutiveFailures: Int): Long {
        if (consecutiveFailures <= 0) return 0L
        val shift = (consecutiveFailures - 1).coerceAtMost(10)
        return (BASE_BACKOFF_MS shl shift).coerceAtMost(MAX_BACKOFF_MS)
    }

    /**
     * Delay before the next start attempt after the host exited with [exitCode].
     * "Already running" counts toward the same capped backoff (a second host
     * that keeps winning the state file must not make us spin).
     */
    fun restartDelayMs(exitCode: Int, consecutiveFailures: Int): Long = when (exitCode) {
        EXIT_NOT_SIGNED_IN -> NOT_SIGNED_IN_BACKOFF_MS
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

    /** Real uid from /proc/<pid>/status ("Uid:\t<real>\t<eff>..."). */
    fun procUid(status: String?): Int? =
        status?.lineSequence()?.firstOrNull { it.startsWith("Uid:") }
            ?.substringAfter("Uid:")?.trim()?.split(Regex("\\s+"))?.firstOrNull()?.toIntOrNull()

    /** A same-uid `codex remote-control` process (NUL-separated /proc/<pid>/cmdline). */
    fun isRemoteControlCmdline(cmdline: String?): Boolean {
        if (cmdline.isNullOrEmpty()) return false
        val args = cmdline.split('\u0000')
        return args.any { it == "remote-control" }
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

    /**
     * Pids that may be signalled: recorded with a start time that still
     * matches, never [selfPid], never pid <= 1.
     */
    fun signalable(recorded: Map<Int, String>, currentStart: (Int) -> String?, selfPid: Int): List<Int> =
        recorded.filter { (pid, start) -> pid > 1 && pid != selfPid && currentStart(pid) == start }.keys.toList()

    private val reconnectLine = Regex(
        "(?i)(available for remote control|\\breconnected\\b|\\bconnected to\\b|\\bconnection (re)?established\\b)"
    )
    private val disconnectLine = Regex(
        "(?i)(\\bdisconnected\\b|connection (lost|closed|reset|refused)|websocket[^\\n]*(closed|error)|failed to (re)?connect|network is unreachable)"
    )

    enum class NetworkVerdict { RECONNECTED, DISCONNECTED, UNKNOWN }

    /**
     * Health signal after a network change, from the host log written since
     * the change. Only an explicit disconnect without a later "available /
     * connected" line is DISCONNECTED (=> restart); silence is UNKNOWN (keep).
     */
    fun networkVerdict(logSinceChange: String): NetworkVerdict {
        var verdict = NetworkVerdict.UNKNOWN
        for (line in logSinceChange.lineSequence()) {
            when {
                reconnectLine.containsMatchIn(line) && !disconnectLine.containsMatchIn(line) -> verdict = NetworkVerdict.RECONNECTED
                disconnectLine.containsMatchIn(line) -> verdict = NetworkVerdict.DISCONNECTED
            }
        }
        return verdict
    }

    /** Lines worth logging so the regexes can be tuned from on-device logcat. */
    fun interestingLines(logSinceChange: String, max: Int = 8): List<String> =
        logSinceChange.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }
            .toList().takeLast(max).map { it.take(200) }
}
