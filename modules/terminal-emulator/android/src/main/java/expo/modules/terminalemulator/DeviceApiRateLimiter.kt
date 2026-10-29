package expo.modules.terminalemulator

/**
 * Sliding-window limiter for `shelly device` side effects (DeviceApi.kt):
 * at most [maxEvents] accepted calls in any [windowMs] window. Pure Kotlin
 * (no Android imports) so DeviceApiRateLimiterTest runs on the plain JVM.
 *
 * The caller passes a MONOTONIC clock (SystemClock.elapsedRealtime()); a
 * timestamp older than the newest recorded event is treated as "now = newest"
 * so a clock that somehow steps back can never make the window forget events.
 */
class DeviceApiRateLimiter(private val maxEvents: Int, private val windowMs: Long) {
    init {
        require(maxEvents > 0) { "maxEvents must be positive" }
        require(windowMs > 0) { "windowMs must be positive" }
    }

    private val events = ArrayDeque<Long>()

    private fun prune(now: Long) {
        while (events.isNotEmpty() && now - events.first() >= windowMs) events.removeFirst()
    }

    private fun effectiveNow(nowMs: Long): Long =
        if (events.isNotEmpty() && nowMs < events.last()) events.last() else nowMs

    /** Records and accepts the call, or returns false when the window is full. */
    @Synchronized
    fun tryAcquire(nowMs: Long): Boolean {
        val now = effectiveNow(nowMs)
        prune(now)
        if (events.size >= maxEvents) return false
        events.addLast(now)
        return true
    }

    /** Milliseconds until the next call would be accepted (0 = now). */
    @Synchronized
    fun retryAfterMs(nowMs: Long): Long {
        val now = effectiveNow(nowMs)
        prune(now)
        if (events.size < maxEvents) return 0L
        return (windowMs - (now - events.first())).coerceAtLeast(0L)
    }
}
