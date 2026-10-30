package expo.modules.terminalemulator.monitor

/**
 * Who is holding an agent's run open, for the MONITOR widget. Two kinds of
 * holder, tracked separately because they overlap:
 *  - native: every AgentRuntime.runAgent call (counted — the attended serial
 *    chain calls it once per step, and a refused / early-returning call for
 *    an agent that is already running must not end the real run);
 *  - chain: the attended JS chain's own start/end mark (notifyMonitorWidget).
 *
 * The run is "released" only when the last holder of either kind is gone;
 * only then does the widget record the end and stop watching. Pure, no Android.
 */
class MonitorRunHolders {
    private val native = HashMap<String, Int>()
    private val chain = HashSet<String>()
    private val endedAt = HashMap<String, Long>()

    @Synchronized
    fun startNative(agentId: String) {
        native[agentId] = (native[agentId] ?: 0) + 1
        endedAt.remove(agentId)
    }

    /** @return true when this released the run (no holder left). */
    @Synchronized
    fun endNative(agentId: String, nowMs: Long): Boolean {
        val n = (native[agentId] ?: 0) - 1
        if (n > 0) native[agentId] = n else native.remove(agentId)
        return releaseIfFree(agentId, nowMs)
    }

    @Synchronized
    fun startChain(agentId: String) {
        chain.add(agentId)
        endedAt.remove(agentId)
    }

    /** @return true when this released the run (no holder left). */
    @Synchronized
    fun endChain(agentId: String, nowMs: Long): Boolean {
        chain.remove(agentId)
        return releaseIfFree(agentId, nowMs)
    }

    /**
     * Drop every chain mark (the JS runtime that set them is gone: reload or
     * new Module instance). Native counts are untouched — those runs belong
     * to this process. @return the agents this released (no holder left).
     */
    @Synchronized
    fun clearChains(nowMs: Long): List<String> {
        val ids = chain.toList()
        chain.clear()
        return ids.filter { releaseIfFree(it, nowMs) }
    }

    @Synchronized
    fun isHeld(agentId: String): Boolean = (native[agentId] ?: 0) > 0 || agentId in chain

    @Synchronized
    fun nativeActive(agentId: String): Boolean = (native[agentId] ?: 0) > 0

    @Synchronized
    fun chainActive(agentId: String): Boolean = agentId in chain

    /** When the last holder of [agentId] let go, if it did and nothing restarted since. */
    @Synchronized
    fun endedAt(agentId: String): Long? = endedAt[agentId]

    private fun releaseIfFree(agentId: String, nowMs: Long): Boolean {
        if ((native[agentId] ?: 0) > 0 || agentId in chain) return false
        endedAt[agentId] = nowMs
        return true
    }
}
