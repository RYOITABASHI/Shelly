package expo.modules.terminalemulator.monitor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors __tests__/agent-progress*.test.ts rules for the native port. */
class MonitorProgressTest {
    private fun ev(seq: Int, kind: String, extra: String = "", run: String = "r1", agent: String = "a1", ts: String = "2026-10-30T12:00:%02d.000Z") =
        """{"v":1,"runId":"$run","agentId":"$agent","seq":$seq,"ts":"${ts.format(seq)}","kind":"$kind"$extra}"""

    @Test
    fun parsesAFullRun() {
        val text = listOf(
            ev(1, "run_start", ""","mode":"PARALLEL","stepCount":3"""),
            ev(2, "branch_state", ""","stepIndex":0,"state":"RUNNING""""),
            ev(3, "tool", ""","stepIndex":0,"tool":"perplexity","provider":{"kind":"API","name":"perplexity"}"""),
            ev(4, "usage", ""","stepIndex":0,"usage":{"inputTokens":100,"outputTokens":50,"usd":0.002}"""),
            ev(5, "usage", ""","stepIndex":0,"usage":{"inputTokens":10,"usd":0.001}"""),
            ev(6, "branch_state", ""","stepIndex":0,"state":"DONE""""),
            ev(7, "branch_state", ""","stepIndex":1,"state":"WAITING_APPROVAL""""),
            ev(8, "run_end", ""","status":"success"""")
        ).joinToString("\n")
        val run = MonitorProgress.parse(text)!!
        assertEquals("PARALLEL", run.mode)
        assertEquals(3, run.stepCount)
        assertEquals("success", run.status)
        assertTrue(run.ended)
        assertEquals(2, run.branches.size)
        val b0 = run.branches[0]
        assertEquals("DONE", b0.state)
        assertEquals("API", b0.provider!!.kind)
        assertEquals(160L, b0.usage!!.tokens)
        assertEquals(0.003, b0.usage!!.usd!!, 1e-9)
        assertEquals(MonitorProgress.parseIsoMs("2026-10-30T12:00:02.000Z"), b0.startedAtMs)
        assertEquals(MonitorProgress.parseIsoMs("2026-10-30T12:00:06.000Z"), b0.endedAtMs)
        assertTrue(run.branches[1].approvalAsked)
    }

    @Test
    fun dropsMalformedStaleAndForeignLines() {
        val text = listOf(
            ev(1, "run_start"),
            "{not json",
            """{"v":2,"runId":"r1","agentId":"a1","seq":2,"ts":"2026-10-30T12:00:02.000Z","kind":"run_end"}""",
            ev(3, "branch_state", ""","stepIndex":0,"state":"RUNNING""""),
            ev(3, "branch_state", ""","stepIndex":0,"state":"FAILED""""), // duplicate seq
            ev(2, "branch_state", ""","stepIndex":0,"state":"FAILED""""), // out of order
            ev(4, "branch_state", ""","stepIndex":0,"state":"BOGUS""""),
            ev(5, "tool", ""","tool":"x""""), // no stepIndex
            ev(6, "tail", ""","stepIndex":0,"tail":"hi"""", agent = "other"),
            """{"v":1,"runId":"r1","agentId":"a1","seq":"7","ts":"2026-10-30T12:00:07.000Z","kind":"run_end"}""",
            ev(8, "branch_state", ""","stepIndex":-1,"state":"DONE""""),
            "{\"v\":1,\"runId\":\"r1\",\"agentId\":\"a1\",\"seq\":9,\"ts\":\"2026-10-30T12:00:09.0" // truncated
        ).joinToString("\n")
        val run = MonitorProgress.parse(text)!!
        assertFalse(run.ended)
        assertEquals(1, run.branches.size)
        assertEquals("RUNNING", run.branches[0].state)
        assertNull(run.branches[0].tail)
    }

    @Test
    fun settledStateIsFinal() {
        val text = listOf(
            ev(1, "branch_state", ""","stepIndex":0,"state":"FAILED""""),
            ev(2, "branch_state", ""","stepIndex":0,"state":"RUNNING""""),
            ev(3, "branch_state", ""","stepIndex":0,"state":"DONE"""")
        ).joinToString("\n")
        assertEquals("FAILED", MonitorProgress.parse(text)!!.branches[0].state)
    }

    @Test
    fun latestRunWins() {
        val text = listOf(
            ev(1, "run_start", run = "old"),
            ev(1, "run_start", run = "new"),
            ev(2, "branch_state", ""","stepIndex":0,"state":"RUNNING"""", run = "new")
        ).joinToString("\n")
        val run = MonitorProgress.parse(text)!!
        assertEquals("new", run.runId)
        assertEquals(1, run.branches.size)
    }

    @Test
    fun emptyOrGarbageIsNull() {
        assertNull(MonitorProgress.parse(""))
        assertNull(MonitorProgress.parse("garbage\n\n[1,2]"))
    }

    @Test
    fun isoTimestamps() {
        assertEquals(0L, MonitorProgress.parseIsoMs("1970-01-01T00:00:00Z"))
        assertEquals(1_793_361_600_123L, MonitorProgress.parseIsoMs("2026-10-30T12:00:00.123Z"))
        assertEquals(1_793_361_600_000L, MonitorProgress.parseIsoMs("2026-10-30T21:00:00+09:00"))
        assertEquals(951_782_400_000L, MonitorProgress.parseIsoMs("2000-02-29T00:00:00.000Z"))
        assertNull(MonitorProgress.parseIsoMs("yesterday"))
        assertNull(MonitorProgress.parseIsoMs("2026-13-01T00:00:00Z"))
    }
}
