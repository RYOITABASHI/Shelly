package expo.modules.terminalemulator

import java.util.concurrent.ConcurrentHashMap

/**
 * Per-key burst debouncer used by ShellyNotificationListener to suppress rapid
 * repeat fires of the same agent (see ShellyNotificationListener.kt's own
 * class-doc: a single logical notification event can produce several rapid
 * onNotificationPosted calls — initial post, then removed+reposted, then
 * updated again — each independently matching the same agent).
 *
 * Deliberately has ZERO android.* imports so it can be exercised with a plain
 * `kotlinc` + Kotlin stdlib, no Android SDK / android.jar / Robolectric
 * required — this project has no Gradle unit-test module set up for the
 * android/ source tree, and standalone kotlinc compiles against a downloaded
 * android.jar are the established fallback (see AgentAlarmScheduler.kt's
 * verification history), but that fallback can't easily RUN code that calls
 * real android.os.SystemClock. Extracting the pure logic here means the
 * caller supplies "now" (production: SystemClock.elapsedRealtime(); test: a
 * fake monotonic sequence), and the debounce arithmetic itself is verified
 * directly rather than only type-checked.
 *
 * The time source contract: callers MUST pass a monotonic clock (elapsed
 * device uptime), never wall-clock time — a backward wall-clock adjustment
 * between two rapid calls must not defeat the debounce this class exists to
 * provide.
 */
class TriggerDebouncer(private val windowMs: Long) {
    private val lastFiredAtMs = ConcurrentHashMap<String, Long>()

    /**
     * Returns true (and records the fire at [nowMs]) if [key] may fire now;
     * false if it fired within the last [windowMs] as of [nowMs] and this
     * call should be suppressed as a burst repeat.
     */
    fun shouldFireNow(key: String, nowMs: Long): Boolean {
        val last = lastFiredAtMs[key]
        if (last != null && nowMs - last < windowMs) {
            return false
        }
        lastFiredAtMs[key] = nowMs
        return true
    }
}
