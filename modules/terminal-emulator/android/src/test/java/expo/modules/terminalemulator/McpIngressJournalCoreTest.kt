package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The persistent MCP ingress journal (McpNativeIngress.kt): a window is
 * journaled before a headless command runs, and every agent request that
 * appears while it is open stays MCP-originated even when the process dies
 * before RN drains it. The Keystore MAC / file layer is Android-only; its
 * fail-closed outcomes (missing / forged file ⇒ INVALID ⇒ repair) are
 * exercised here through [McpIngressJournalCore.decode] and [McpIngressJournalCore.repair].
 */
class McpIngressJournalCoreTest {
    private val p = "p".repeat(32)
    private val owner = "deadbeef00000000"

    @Test
    fun closeRecordsWhatAppeared() {
        var s = McpIngressJournalCore.open(McpIngressJournalCore.State(), "c1", p, setOf("1-a"), owner, 1_000L)
        assertNull(s.windows.single().end)
        s = McpIngressJournalCore.close(s, "c1", setOf("1-a", "1700000000000-0000abcd", "ctl-1700000000001-0000abce"), 2_000L)
        assertEquals(2_000L, s.windows.single().end)
        assertEquals(listOf("1700000000000-0000abcd", "ctl-1700000000001-0000abce"), s.requests.map { it.reqId })
        assertTrue(s.requests.all { it.callId == "c1" && it.principal == p })
    }

    @Test
    fun crashBeforeDrainIsRecoveredFromTheOpenWindow() {
        // The window was journaled, the command wrote a request (with any
        // timestamp it liked), and the process died before close().
        val s = McpIngressJournalCore.open(McpIngressJournalCore.State(), "c1", p, setOf("old-1"), owner, 1_000L)
        val text = McpIngressJournalCore.encode(s)
        val reloaded = McpIngressJournalCore.decode(text)!!
        val onDisk = setOf("old-1", "1000000000-0000abcd")
        // A new process: the window's owner is not running it any more.
        val r = McpIngressJournalCore.recover(reloaded, onDisk, { false }, 50_000L)
        assertEquals(listOf("1000000000-0000abcd"), r.requests.map { it.reqId })
        assertEquals(50_000L, r.windows.single().end)
        // A window still running in this process is left open.
        val live = McpIngressJournalCore.recover(reloaded, onDisk, { true }, 50_000L)
        assertNull(live.windows.single().end)
        assertTrue(live.requests.isEmpty())
    }

    @Test
    fun invalidJournalRepairMarksEveryRequestOnDisk() {
        val r = McpIngressJournalCore.repair(setOf("1700000000000-0000abcd", "ctl-1700000000001-0000abce"), 9_000L)
        assertEquals(setOf("1700000000000-0000abcd", "ctl-1700000000001-0000abce"), r.requests.map { it.reqId }.toSet())
        assertTrue(r.requests.all { it.callId == "unknown" })
    }

    @Test
    fun forgedOrGarbageStateDoesNotDecode() {
        assertNull(McpIngressJournalCore.decode("not json"))
        assertNull(McpIngressJournalCore.decode("""{"v":2,"windows":[],"requests":[]}"""))
        assertNull(McpIngressJournalCore.decode("""{"v":1,"windows":[{"callId":"c"}],"requests":[]}"""))
        assertNotNull(McpIngressJournalCore.decode("""{"v":1,"windows":[],"requests":[]}"""))
    }

    @Test
    fun recordedRequestsSurvivePastTheRequestLifetimeWhileOldWindowsAreTrimmed() {
        var s = McpIngressJournalCore.State()
        val step = 120_000L // two minutes apart: every closed window but the last is past RN's grace
        for (i in 0 until 100) {
            s = McpIngressJournalCore.open(s, "c$i", p, emptySet(), owner, i * step)
            s = McpIngressJournalCore.close(s, "c$i", setOf("${1700000000000L + i}-0000abcd"), i * step + 1)
        }
        assertEquals(100, s.requests.size)
        assertTrue(s.windows.size <= McpIngressJournalCore.MAX_WINDOWS)
        val last = 99 * step
        // 10-minute request lifetime: all still there an hour later, gone after a day.
        assertEquals(100, McpIngressJournalCore.prune(s, last + 60 * 60_000L).requests.size)
        assertEquals(0, McpIngressJournalCore.prune(s, last + McpIngressJournalCore.RETAIN_MS + 10_000L).requests.size)
    }

    @Test
    fun rnViewCarriesWindowsAndRequests() {
        var s = McpIngressJournalCore.open(McpIngressJournalCore.State(), "c1", p, emptySet(), owner, 1L)
        s = McpIngressJournalCore.close(s, "c1", setOf("1700000000000-0000abcd"), 2L)
        val o = org.json.JSONObject(McpIngressJournalCore.forRn(s))
        assertTrue(o.getBoolean("ok"))
        assertEquals(2L, o.getJSONArray("windows").getJSONObject(0).getLong("end"))
        assertEquals("1700000000000-0000abcd", o.getJSONArray("requests").getJSONObject(0).getString("reqId"))
    }
}
