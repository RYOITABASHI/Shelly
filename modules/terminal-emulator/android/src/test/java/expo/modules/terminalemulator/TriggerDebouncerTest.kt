package expo.modules.terminalemulator

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Behavioral regression test for the 60s notification-trigger debounce
 * (ShellyNotificationListener's shouldFireNow, extracted to TriggerDebouncer
 * for testability — see that file's class doc). Prior to this test, only a
 * string/manifest-parity check existed for NOTIFY-001 (parity.test.ts); no
 * test actually exercised the suppression arithmetic itself.
 *
 * Note: this module has no Gradle unit-test task wired into CI yet
 * (build-android.yml only runs `assembleRelease`), so this file is not
 * currently executed automatically. It is placed in the idiomatic
 * src/test/java location so it runs correctly once that wiring exists, and
 * was verified manually via a standalone kotlinc + kotlin-stdlib run against
 * TriggerDebouncer.kt (zero android.* imports, so no android.jar is needed)
 * before this fix was pushed.
 */
class TriggerDebouncerTest {
    private val windowMs = 60_000L

    @Test
    fun `first fire for a key is always allowed`() {
        val debouncer = TriggerDebouncer(windowMs)
        assertTrue(debouncer.shouldFireNow("agent-1", nowMs = 1_000L))
    }

    @Test
    fun `second fire within the window is suppressed`() {
        val debouncer = TriggerDebouncer(windowMs)
        assertTrue(debouncer.shouldFireNow("agent-1", nowMs = 1_000L))
        assertFalse(debouncer.shouldFireNow("agent-1", nowMs = 1_000L + windowMs - 1))
    }

    @Test
    fun `fire exactly at the window boundary is allowed`() {
        val debouncer = TriggerDebouncer(windowMs)
        assertTrue(debouncer.shouldFireNow("agent-1", nowMs = 1_000L))
        assertTrue(debouncer.shouldFireNow("agent-1", nowMs = 1_000L + windowMs))
    }

    @Test
    fun `fire after the window is allowed`() {
        val debouncer = TriggerDebouncer(windowMs)
        assertTrue(debouncer.shouldFireNow("agent-1", nowMs = 1_000L))
        assertTrue(debouncer.shouldFireNow("agent-1", nowMs = 1_000L + windowMs + 5_000L))
    }

    @Test
    fun `different keys debounce independently`() {
        val debouncer = TriggerDebouncer(windowMs)
        assertTrue(debouncer.shouldFireNow("agent-1", nowMs = 1_000L))
        assertTrue(debouncer.shouldFireNow("agent-2", nowMs = 1_000L))
        assertFalse(debouncer.shouldFireNow("agent-1", nowMs = 1_500L))
        assertFalse(debouncer.shouldFireNow("agent-2", nowMs = 1_500L))
    }

    @Test
    fun `a burst of rapid re-posts collapses to a single fire`() {
        // Mirrors the on-device observation documented in
        // ShellyNotificationListener.kt: mail/chat sync apps can emit several
        // onNotificationPosted calls within milliseconds for one logical event.
        val debouncer = TriggerDebouncer(windowMs)
        val burstTimes = listOf(1_000L, 1_050L, 1_120L, 1_900L, 4_000L)
        val fired = burstTimes.map { debouncer.shouldFireNow("agent-1", nowMs = it) }
        assertTrue("first call in the burst must fire", fired.first())
        assertTrue("all subsequent calls within the window must be suppressed", fired.drop(1).all { !it })
    }

    @Test
    fun `different keys are independent even when one is recorded at a later timestamp than the other`() {
        // Per-key isolation: agent-2's first fire uses an EARLIER monotonic
        // timestamp than agent-1's already-recorded fire. This must not be
        // affected by agent-1's state at all — there is no shared/global
        // clock state, only a per-key last-fired map.
        val debouncer = TriggerDebouncer(windowMs)
        assertTrue(debouncer.shouldFireNow("agent-1", nowMs = 100_000L))
        assertTrue(debouncer.shouldFireNow("agent-2", nowMs = 50L))
    }

    @Test
    fun `a suppressed call does not reset or extend the debounce window`() {
        // If shouldFireNow(false) accidentally recorded nowMs on the
        // suppressed path too, the window would keep sliding forward on every
        // burst call and could suppress indefinitely under sustained bursts.
        // The real fire at 1_000 must remain the anchor: a call at 60_999 is
        // still suppressed (< 1_000 + 60_000), but 61_000 — exactly windowMs
        // after the ORIGINAL fire, not after the suppressed attempt — must be
        // allowed.
        val debouncer = TriggerDebouncer(windowMs)
        assertTrue(debouncer.shouldFireNow("agent-1", nowMs = 1_000L))
        assertFalse(debouncer.shouldFireNow("agent-1", nowMs = 60_999L))
        assertTrue(debouncer.shouldFireNow("agent-1", nowMs = 61_000L))
    }
}
