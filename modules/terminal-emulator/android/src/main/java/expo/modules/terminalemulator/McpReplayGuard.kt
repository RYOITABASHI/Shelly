package expo.modules.terminalemulator

/**
 * The typed-op consumer's replay set (McpTypedOpConsumer): every callId this
 * consumer accepted is remembered until the signed request it came from can
 * no longer pass McpTypedOpDecision.parseRequest's freshness check, never
 * evicted by count. A signed request with receivedAt R is fresh while
 * `now - R <= MAX_REQUEST_AGE_MS` (and R is at most FUTURE_TOLERANCE_MS
 * ahead), so its callId is kept until `R + MAX_REQUEST_AGE_MS +
 * [SAFETY_MARGIN_MS]` — keyed by the signed receivedAt, not by when it was
 * seen, so a request signed up to 60 s in the future is still covered.
 *
 * When [capacity] entries are all still inside their window, a new callId is
 * NOT admitted ([admit] false) and the caller drops the request unanswered
 * (fail closed): evicting a live entry would make its captured request
 * replayable. A wall clock moved backwards only lengthens retention.
 *
 * Pure (no Android dependency): McpReplayGuardTest. Not thread-safe; the
 * consumer uses it on its single HandlerThread.
 */
class McpReplayGuard(private val capacity: Int = DEFAULT_CAPACITY) {
    companion object {
        /** Far above what a client can produce in one window (2 live runs per principal; requests are serialized). */
        const val DEFAULT_CAPACITY = 4096
        const val SAFETY_MARGIN_MS = 5_000L
        val RETAIN_AFTER_RECEIVED_MS = McpTypedOpDecision.MAX_REQUEST_AGE_MS + SAFETY_MARGIN_MS
    }

    /** callId -> the moment it may be forgotten (receivedAt + RETAIN_AFTER_RECEIVED_MS). */
    private val expiresAt = HashMap<String, Long>()

    val size: Int get() = expiresAt.size

    fun isSeen(callId: String): Boolean = expiresAt.containsKey(callId)

    /** Forgets only the callIds whose request can no longer be fresh at [nowMs]. */
    fun prune(nowMs: Long) {
        val it = expiresAt.entries.iterator()
        while (it.hasNext()) if (it.next().value < nowMs) it.remove()
    }

    /**
     * Remembers [callId] (signed receivedAt [receivedAtMs]). True when it is
     * remembered now (or already was); false when the set is full of live
     * entries — the request must then not run.
     */
    fun admit(callId: String, receivedAtMs: Long, nowMs: Long): Boolean {
        val until = receivedAtMs + RETAIN_AFTER_RECEIVED_MS
        val known = expiresAt[callId]
        if (known != null) {
            if (until > known) expiresAt[callId] = until
            return true
        }
        prune(nowMs)
        if (expiresAt.size >= capacity) return false
        expiresAt[callId] = until
        return true
    }
}
