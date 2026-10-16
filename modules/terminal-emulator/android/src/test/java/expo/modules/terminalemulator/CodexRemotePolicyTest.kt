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
    private val ok = CodexRemotePolicy.Inputs(
        autostartOn = true, halted = false, stopRequested = false,
        serviceForeground = true, notificationsEnabled = true,
    )

    @Test
    fun `runs only when opted in, not halted, not stopped`() {
        assertTrue(CodexRemotePolicy.mayRun(ok))
        assertFalse(CodexRemotePolicy.mayRun(ok.copy(autostartOn = false)))
        assertFalse(CodexRemotePolicy.mayRun(ok.copy(halted = true)))
        assertFalse(CodexRemotePolicy.mayRun(ok.copy(stopRequested = true)))
    }

    @Test
    fun `M2 - needs a foreground service and visible notifications`() {
        assertFalse(CodexRemotePolicy.mayRun(ok.copy(serviceForeground = false)))
        assertFalse(CodexRemotePolicy.mayRun(ok.copy(notificationsEnabled = false)))
        // ...but stays "wanted" so the service keeps itself up to show it.
        assertTrue(CodexRemotePolicy.wanted(ok.copy(serviceForeground = false)))
        assertTrue(CodexRemotePolicy.shouldStopUnwanted(ok.copy(notificationsEnabled = false), nativeOwned = true))
        assertTrue(CodexRemotePolicy.shouldStopUnwanted(ok.copy(serviceForeground = false), nativeOwned = true))
    }

    @Test
    fun `M1 - STOP-ALL latches`() {
        assertTrue(CodexRemotePolicy.latchHalt(latched = false, sentinelPresent = true))
        // The sentinel going away (resume) does not clear the latch by itself.
        assertTrue(CodexRemotePolicy.latchHalt(latched = true, sentinelPresent = false))
        assertFalse(CodexRemotePolicy.latchHalt(latched = false, sentinelPresent = false))
    }

    @Test
    fun `a hand-started host is only stopped by STOP-ALL`() {
        val off = ok.copy(autostartOn = false)
        assertTrue(CodexRemotePolicy.shouldStopUnwanted(off, nativeOwned = true))
        assertFalse(CodexRemotePolicy.shouldStopUnwanted(off, nativeOwned = false))
        assertTrue(CodexRemotePolicy.shouldStopUnwanted(ok.copy(halted = true), nativeOwned = false))
        assertFalse(CodexRemotePolicy.shouldStopUnwanted(ok, nativeOwned = true))
    }

    @Test
    fun `backoff doubles from 5s and caps at 5 min, already-running counts too`() {
        assertEquals(0L, CodexRemotePolicy.backoffMs(0))
        assertEquals(5_000L, CodexRemotePolicy.backoffMs(1))
        assertEquals(10_000L, CodexRemotePolicy.backoffMs(2))
        assertEquals(300_000L, CodexRemotePolicy.backoffMs(99))
        assertEquals(600_000L, CodexRemotePolicy.restartDelayMs(CodexRemotePolicy.EXIT_NOT_SIGNED_IN, 1))
        assertEquals(20_000L, CodexRemotePolicy.restartDelayMs(CodexRemotePolicy.EXIT_ALREADY_RUNNING, 3))
        assertEquals(300_000L, CodexRemotePolicy.restartDelayMs(CodexRemotePolicy.EXIT_ALREADY_RUNNING, 50))
    }

    @Test
    fun `parses the shim state file`() {
        assertEquals(CodexRemotePolicy.HostState(123, "456", true), CodexRemotePolicy.parseState("123 456 native\n"))
        assertEquals(CodexRemotePolicy.HostState(123, "456", false), CodexRemotePolicy.parseState("123 456"))
        assertNull(CodexRemotePolicy.parseState("123"))
        assertNull(CodexRemotePolicy.parseState("1 456"))
        assertNull(CodexRemotePolicy.parseState("abc 456"))
        assertNull(CodexRemotePolicy.parseState(null))
    }

    @Test
    fun `reads starttime, ppid and uid from proc`() {
        val stat = "4242 (codex rc) S 77 4242 4242 0 -1 4194560 1 2 3 4 5 6 7 8 20 0 9 0 987654 1000 100"
        assertEquals("987654", CodexRemotePolicy.procStartTime(stat))
        assertEquals(77, CodexRemotePolicy.procParentPid(stat))
        assertEquals(10123, CodexRemotePolicy.procUid("Name:\tx\nUid:\t10123\t10123\t10123\t10123\n"))
    }

    @Test
    fun `M3 - only verified pids are signalled, never self`() {
        val recorded = mapOf(10 to "100", 11 to "110", 12 to "120", 1 to "1")
        val current = mapOf(10 to "100", 11 to "999", 12 to "120")
        val out = CodexRemotePolicy.signalable(recorded, { current[it] }, selfPid = 12)
        assertEquals(listOf(10), out)
    }

    @Test
    fun `M1b - recognizes remote-control argv`() {
        assertTrue(CodexRemotePolicy.isRemoteControlCmdline("/x/codex_tui\u0000remote-control\u0000--no-daemon\u0000"))
        assertFalse(CodexRemotePolicy.isRemoteControlCmdline("/x/bash\u0000-c\u0000echo remote-control-ish\u0000"))
        assertFalse(CodexRemotePolicy.isRemoteControlCmdline(""))
    }

    @Test
    fun `collects the whole process tree`() {
        val parents = mapOf(10 to 1, 11 to 10, 12 to 11, 13 to 10, 20 to 1)
        assertEquals(setOf(11, 12, 13), CodexRemotePolicy.descendants(10, parents).toSet())
    }

    @Test
    fun `L2 - restart only on an explicit disconnect without a later available line`() {
        assertEquals(CodexRemotePolicy.NetworkVerdict.UNKNOWN, CodexRemotePolicy.networkVerdict(""))
        assertEquals(CodexRemotePolicy.NetworkVerdict.UNKNOWN, CodexRemotePolicy.networkVerdict("error: rate limited\n"))
        assertEquals(CodexRemotePolicy.NetworkVerdict.DISCONNECTED, CodexRemotePolicy.networkVerdict("websocket closed\n"))
        assertEquals(
            CodexRemotePolicy.NetworkVerdict.RECONNECTED,
            CodexRemotePolicy.networkVerdict("connection reset\nThis machine is available for remote control as Fold.\n"),
        )
        assertEquals(
            CodexRemotePolicy.NetworkVerdict.DISCONNECTED,
            CodexRemotePolicy.networkVerdict("available for remote control\ndisconnected from server\n"),
        )
    }
}
