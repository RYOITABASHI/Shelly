package expo.modules.terminalemulator.monitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MonitorRunHoldersTest {
    @Test
    fun attendedChainStaysHeldAcrossItsSteps() {
        val h = MonitorRunHolders()
        h.startChain("a")
        // Each step is its own AgentRuntime.runAgent.
        h.startNative("a")
        assertFalse(h.endNative("a", 100))
        assertTrue(h.isHeld("a"))
        assertNull(h.endedAt("a"))
        h.startNative("a")
        assertFalse(h.endNative("a", 200))
        // Only the chain's own end releases it.
        assertTrue(h.endChain("a", 300))
        assertFalse(h.isHeld("a"))
        assertEquals(300L, h.endedAt("a"))
    }

    @Test
    fun aRefusedSecondRunDoesNotEndTheRealOne() {
        val h = MonitorRunHolders()
        h.startNative("a") // the real run
        h.startNative("a") // "Run now" during it, refused / returns early
        assertFalse(h.endNative("a", 10))
        assertTrue(h.nativeActive("a"))
        assertNull(h.endedAt("a"))
        assertTrue(h.endNative("a", 20))
        assertFalse(h.nativeActive("a"))
        assertEquals(20L, h.endedAt("a"))
    }

    @Test
    fun aNewStartClearsTheRecordedEnd() {
        val h = MonitorRunHolders()
        h.startNative("a")
        assertTrue(h.endNative("a", 10))
        h.startChain("a")
        assertNull(h.endedAt("a"))
        assertTrue(h.chainActive("a"))
    }

    @Test
    fun agentsAreIndependentAndStrayEndsAreHarmless() {
        val h = MonitorRunHolders()
        h.startNative("a")
        assertTrue(h.endNative("b", 5)) // never started: nothing held
        assertTrue(h.isHeld("a"))
        assertTrue(h.endNative("a", 6))
        assertTrue(h.endNative("a", 7)) // extra end: still released, count never negative
        h.startNative("a")
        assertFalse(h.endChain("a", 8)) // native still holds it
        assertTrue(h.isHeld("a"))
    }
}
