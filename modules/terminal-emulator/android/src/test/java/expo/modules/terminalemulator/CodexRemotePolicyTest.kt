package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * "Keep ChatGPT connected" start conditions and restart policy
 * (CodexRemoteHost.kt). Like TriggerDebouncerTest, not wired into CI's
 * Gradle run yet; CodexRemotePolicy has no android.* imports.
 */
class CodexRemotePolicyTest {
    private val on = CodexRemotePolicy.Inputs(autostartOn = true, paired = true, halted = false, stopRequested = false)

    @Test
    fun `runs only when opted in, paired, not halted and not stopped`() {
        assertTrue(CodexRemotePolicy.shouldRun(on))
        assertFalse(CodexRemotePolicy.shouldRun(on.copy(autostartOn = false)))
        assertFalse(CodexRemotePolicy.shouldRun(on.copy(paired = false)))
        assertFalse(CodexRemotePolicy.shouldRun(on.copy(halted = true)))
        assertFalse(CodexRemotePolicy.shouldRun(on.copy(stopRequested = true)))
    }

    @Test
    fun `a hand-started host is only stopped by STOP-ALL`() {
        val off = on.copy(autostartOn = false)
        assertTrue(CodexRemotePolicy.shouldStopUnwanted(off, nativeOwned = true))
        assertFalse(CodexRemotePolicy.shouldStopUnwanted(off, nativeOwned = false))
        assertTrue(CodexRemotePolicy.shouldStopUnwanted(on.copy(halted = true), nativeOwned = false))
        assertFalse(CodexRemotePolicy.shouldStopUnwanted(on, nativeOwned = true))
    }

    @Test
    fun `backoff doubles from 5s and caps at 5 min`() {
        assertEquals(0L, CodexRemotePolicy.backoffMs(0))
        assertEquals(5_000L, CodexRemotePolicy.backoffMs(1))
        assertEquals(10_000L, CodexRemotePolicy.backoffMs(2))
        assertEquals(160_000L, CodexRemotePolicy.backoffMs(6))
        assertEquals(300_000L, CodexRemotePolicy.backoffMs(7))
        assertEquals(300_000L, CodexRemotePolicy.backoffMs(99))
        assertEquals(600_000L, CodexRemotePolicy.restartDelayMs(CodexRemotePolicy.EXIT_NOT_SIGNED_IN, 1))
        assertEquals(5_000L, CodexRemotePolicy.restartDelayMs(CodexRemotePolicy.EXIT_ALREADY_RUNNING, 0))
    }

    @Test
    fun `parses the shim state file`() {
        assertEquals(CodexRemotePolicy.HostState(123, "456", true), CodexRemotePolicy.parseState("123 456 native\n"))
        assertEquals(CodexRemotePolicy.HostState(123, "456", false), CodexRemotePolicy.parseState("123 456"))
        assertNull(CodexRemotePolicy.parseState("123"))
        assertNull(CodexRemotePolicy.parseState("1 456"))
        assertNull(CodexRemotePolicy.parseState("abc 456"))
        assertNull(CodexRemotePolicy.parseState("123 x"))
        assertNull(CodexRemotePolicy.parseState(null))
    }

    @Test
    fun `reads starttime and ppid from proc stat even with spaces in comm`() {
        val stat = "4242 (codex rc) S 77 4242 4242 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 9 0 987654 1000 100"
        assertEquals("987654", CodexRemotePolicy.procStartTime(stat))
        assertEquals(77, CodexRemotePolicy.procParentPid(stat))
        assertNull(CodexRemotePolicy.procStartTime("garbage"))
    }

    @Test
    fun `collects the whole process tree`() {
        val parents = mapOf(10 to 1, 11 to 10, 12 to 11, 13 to 10, 20 to 1)
        assertEquals(setOf(11, 12, 13), CodexRemotePolicy.descendants(10, parents).toSet())
    }

    @Test
    fun `network health signal`() {
        assertTrue(CodexRemotePolicy.logShowsReconnect("This machine is available for remote control as Fold.\n"))
        assertFalse(CodexRemotePolicy.logShowsReconnect(""))
        assertFalse(CodexRemotePolicy.logShowsReconnect("websocket disconnected\n"))
        assertFalse(CodexRemotePolicy.logShowsReconnect("available for remote control\nerror: connection reset\n"))
        assertTrue(CodexRemotePolicy.logShowsReconnect("error: connection reset\nreconnected\n"))
    }
}
