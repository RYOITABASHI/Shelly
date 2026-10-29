package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * DeviceApiRateLimiter (`shelly device` notify/toast/vibrate/tts/share spam
 * guard). Like TriggerDebouncerTest this is not yet wired into a CI task
 * (build-android.yml only runs assembleRelease); run it with
 * `./gradlew :terminal-emulator:testDebugUnitTest`.
 */
class DeviceApiRateLimiterTest {
    @Test
    fun acceptsUpToTheLimitWithinTheWindow() {
        val l = DeviceApiRateLimiter(3, 60_000L)
        assertTrue(l.tryAcquire(1_000L))
        assertTrue(l.tryAcquire(1_001L))
        assertTrue(l.tryAcquire(1_002L))
        assertFalse(l.tryAcquire(1_003L))
        assertFalse(l.tryAcquire(60_999L))
    }

    @Test
    fun windowSlidesFromTheOldestEvent() {
        val l = DeviceApiRateLimiter(2, 10_000L)
        assertTrue(l.tryAcquire(0L))
        assertTrue(l.tryAcquire(5_000L))
        assertFalse(l.tryAcquire(9_999L))
        assertEquals(1L, l.retryAfterMs(9_999L))
        assertTrue(l.tryAcquire(10_000L))
        assertFalse(l.tryAcquire(14_999L))
        assertTrue(l.tryAcquire(15_000L))
    }

    @Test
    fun rejectedCallsDoNotExtendTheWindow() {
        val l = DeviceApiRateLimiter(1, 1_000L)
        assertTrue(l.tryAcquire(0L))
        repeat(50) { assertFalse(l.tryAcquire(500L)) }
        assertTrue(l.tryAcquire(1_000L))
    }

    @Test
    fun retryAfterIsZeroWhenThereIsRoom() {
        val l = DeviceApiRateLimiter(2, 1_000L)
        assertEquals(0L, l.retryAfterMs(0L))
        l.tryAcquire(0L)
        assertEquals(0L, l.retryAfterMs(10L))
    }

    @Test
    fun aClockSteppingBackCannotForgetEvents() {
        val l = DeviceApiRateLimiter(1, 1_000L)
        assertTrue(l.tryAcquire(5_000L))
        assertFalse(l.tryAcquire(0L))
        assertFalse(l.tryAcquire(5_999L))
        assertTrue(l.tryAcquire(6_000L))
    }
}
