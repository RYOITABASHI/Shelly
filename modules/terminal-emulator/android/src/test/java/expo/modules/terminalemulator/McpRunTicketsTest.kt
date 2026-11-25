package expo.modules.terminalemulator

import expo.modules.terminalemulator.McpRunTickets.PruneEntry
import expo.modules.terminalemulator.McpRunTickets.RunLogSummary
import expo.modules.terminalemulator.McpRunTickets.Ticket
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure half of McpRunTickets (codec, transitions, stale rule, run-log
 * choice, outcome mapping, pruning, UTF-8 cut). The file I/O half needs a
 * device. Like McpAlwaysAllowStoreTest, not wired into CI's Gradle run yet, and
 * not compiled on the VM this was written on (no Gradle there).
 */
class McpRunTicketsTest {
    private val handle = "mr_" + "0123456789abcdef".repeat(2)
    private val p1 = "0123456789abcdef0123456789abcdef"
    private val p2 = "fedcba9876543210fedcba9876543210"
    private val t0 = 1_731_650_000_000L

    private fun accepted(
        h: String = handle,
        principal: String = p1,
        agentId: String = "daily",
        requestId: String? = "req-12345678",
        at: Long = t0,
    ): Ticket = McpRunTickets.newTicket(h, principal, requestId, agentId, at)!!

    private fun log(ts: Long, status: String = "success", err: String = "") =
        RunLogSummary(ts, status, "preview", err, null)

    private fun handleN(n: Int): String = "mr_" + "%032x".format(n)

    // ── Codec ────────────────────────────────────────────────────────────

    @Test
    fun encodeDecodeRoundTrip() {
        val a = accepted()
        assertEquals(a, McpRunTickets.decode(McpRunTickets.encode(a)))
        val running = McpRunTickets.withRunning(a, t0 + 1000)!!
        val done = McpRunTickets.withFinished(
            running, McpRunTickets.STATE_SUCCEEDED, null, 0,
            RunLogSummary(t0 + 5000, "success", "hello", "", "/sdcard/x.md"),
            McpRunTickets.outputFileName(handle), t0 + 6000,
        )!!
        assertEquals(done, McpRunTickets.decode(McpRunTickets.encode(done)))
        val noReq = accepted(requestId = null)
        assertEquals(noReq, McpRunTickets.decode(McpRunTickets.encode(noReq)))
    }

    @Test
    fun newTicketRejectsMalformedInputs() {
        assertNull(McpRunTickets.newTicket("mr_123", p1, null, "a", t0))
        assertNull(McpRunTickets.newTicket("mr_" + "A".repeat(32), p1, null, "a", t0))
        assertNull(McpRunTickets.newTicket(handle, "xyz", null, "a", t0))
        assertNull(McpRunTickets.newTicket(handle, p1, null, "../etc", t0))
        assertNull(McpRunTickets.newTicket(handle, p1, null, "", t0))
        assertNull(McpRunTickets.newTicket(handle, p1, "short", "a", t0))
        assertNull(McpRunTickets.newTicket(handle, p1, "has space!", "a", t0))
        assertNotNull(McpRunTickets.newTicket(handle, p1, null, "a_B-9", t0))
    }

    @Test
    fun decodeRejectsUnknownKeysVersionsAndTypes() {
        val good = JSONObject(McpRunTickets.encode(accepted()))
        val bads = listOf(
            JSONObject(good.toString()).put("extra", 1),
            JSONObject(good.toString()).put("v", 2),
            JSONObject(good.toString()).put("state", "done"),
            JSONObject(good.toString()).put("reason", "free text"),
            JSONObject(good.toString()).put("acceptedAt", "1"),
            JSONObject(good.toString()).put("acceptedAt", 1.5),
            JSONObject(good.toString()).put("acceptedAt", -1),
            JSONObject(good.toString()).put("outputFile", "../x.out"),
            JSONObject(good.toString()).put("runLog", JSONObject().put("timestamp", 1).put("status", "success")),
            JSONObject(good.toString()).put("runLog", "x"),
            JSONObject(good.toString()).put("exitCode", 1L shl 40),
        )
        for (b in bads) assertNull(b.toString(), McpRunTickets.decode(b.toString()))
        assertNull(McpRunTickets.decode("not json"))
        assertNull(McpRunTickets.decode("{" + "\"a\":1,".repeat(5000) + "\"b\":1}"))
    }

    // ── Transitions ──────────────────────────────────────────────────────

    @Test
    fun transitionsFollowTheStateMachine() {
        val a = accepted()
        assertTrue(McpRunTickets.canTransition("accepted", "running"))
        for (s in McpRunTickets.TERMINAL_STATES) {
            assertTrue(McpRunTickets.canTransition("accepted", s))
            assertTrue(McpRunTickets.canTransition("running", s))
            for (to in McpRunTickets.ALL_STATES) assertFalse("$s -> $to", McpRunTickets.canTransition(s, to))
        }
        assertFalse(McpRunTickets.canTransition("running", "running"))
        assertFalse(McpRunTickets.canTransition("running", "accepted"))

        val running = McpRunTickets.withRunning(a, t0 + 10)!!
        assertEquals("running", running.state)
        assertEquals(t0 + 10, running.startedAt)
        assertNull(McpRunTickets.withRunning(running, t0 + 20))

        val failed = McpRunTickets.withFinished(running, "failed", "crashed", null, null, null, t0 + 30)!!
        assertEquals("failed", failed.state)
        assertEquals("crashed", failed.reason)
        assertEquals(t0 + 30, failed.finishedAt)
        assertNull(McpRunTickets.withFinished(failed, "succeeded", null, 0, null, null, t0 + 40))
        assertNull(McpRunTickets.withFinished(running, "running", null, 0, null, null, t0 + 40))
        assertNull(McpRunTickets.withFinished(running, "failed", "not-a-reason", 1, null, null, t0 + 40))
    }

    @Test
    fun mayStartOnlyForTheSameFreshAcceptedTicket() {
        val a = accepted()
        assertTrue(McpRunTickets.mayStart(a, "daily", p1, t0 + 1000))
        assertFalse(McpRunTickets.mayStart(a, "other", p1, t0 + 1000))
        assertFalse(McpRunTickets.mayStart(a, "daily", p2, t0 + 1000))
        assertFalse(McpRunTickets.mayStart(a, "daily", null, t0 + 1000))
        assertFalse(McpRunTickets.mayStart(a, "daily", p1, t0 + McpRunTickets.ACCEPTED_STALE_MS + 1))
        assertFalse(McpRunTickets.mayStart(McpRunTickets.withRunning(a, t0)!!, "daily", p1, t0 + 1000))
    }

    // ── Stale rule ───────────────────────────────────────────────────────

    @Test
    fun staleAcceptedAndRunningBecomeLost() {
        val a = accepted()
        assertEquals(a, McpRunTickets.applyStale(a, t0 + McpRunTickets.ACCEPTED_STALE_MS))
        val lostA = McpRunTickets.applyStale(a, t0 + McpRunTickets.ACCEPTED_STALE_MS + 1)
        assertEquals("lost", lostA.state)
        assertEquals("stale", lostA.reason)

        val r = McpRunTickets.withRunning(a, t0 + 60_000)!!
        // Running is measured from startedAt, not acceptedAt.
        assertEquals(r, McpRunTickets.applyStale(r, t0 + 60_000 + McpRunTickets.RUNNING_STALE_MS))
        assertEquals("lost", McpRunTickets.applyStale(r, t0 + 60_000 + McpRunTickets.RUNNING_STALE_MS + 1).state)

        val done = McpRunTickets.withFinished(r, "succeeded", null, 0, null, null, t0 + 70_000)!!
        assertEquals(done, McpRunTickets.applyStale(done, t0 + 100L * 24 * 3600 * 1000))
    }

    @Test
    fun runningPastStaleIsLostOnlyWhenProgressStalled() {
        val started = t0 + 60_000
        val r = McpRunTickets.withRunning(accepted(), started)!!
        val min = 60_000L
        val at = started + 40 * min
        // Progress 2 min ago: a healthy long run is not lost.
        assertEquals(r, McpRunTickets.applyStale(r, at, at - 2 * min))
        // Progress 10+ min ago, none, or from before the run: lost/stale.
        assertEquals("lost", McpRunTickets.applyStale(r, at, at - McpRunTickets.RUNNING_PROGRESS_STALL_MS).state)
        assertEquals("lost", McpRunTickets.applyStale(r, at, null).state)
        assertEquals("lost", McpRunTickets.applyStale(r, at, started - 1).state)
        // Under 35 min: running whatever the progress.
        assertEquals(r, McpRunTickets.applyStale(r, started + 30 * min, null))
        // Past the hard ceiling: lost even with fresh progress.
        val late = started + McpRunTickets.RUNNING_HARD_STALE_MS + 1
        assertEquals("lost", McpRunTickets.applyStale(r, late, late - 1000).state)
        // liveCount follows the same rule.
        assertEquals(1, McpRunTickets.liveCount(listOf(r), r.principal, at) { at - 2 * min })
        assertEquals(0, McpRunTickets.liveCount(listOf(r), r.principal, at) { null })
    }

    // ── Run log choice ───────────────────────────────────────────────────

    @Test
    fun chooseRunLogPicksTheNewestWithinTheRun() {
        val runStart = t0 + 45_678
        val runEnd = t0 + 60_000
        val stale = log(t0 + 10_000, "success")
        val sameSecondSh = log(t0 + 45_000, "error") // legacy .sh `${TS}000`, same second
        val newer = log(t0 + 50_123, "skipped")
        val nextRun = log(t0 + 60_001, "success") // a later run, after this one ended
        assertEquals(newer, McpRunTickets.chooseRunLog(listOf(stale, sameSecondSh, newer, nextRun), runStart, runEnd))
        assertEquals(sameSecondSh, McpRunTickets.chooseRunLog(listOf(stale, sameSecondSh), runStart, runEnd))
        assertNull(McpRunTickets.chooseRunLog(listOf(stale, nextRun), runStart, runEnd))
        // A millisecond stamp earlier in the same second is a previous run's.
        assertNull(McpRunTickets.chooseRunLog(listOf(log(t0 + 45_677)), runStart, runEnd))
        assertNull(McpRunTickets.chooseRunLog(listOf(log(t0 + 44_999)), runStart, runEnd))
        assertNull(McpRunTickets.chooseRunLog(emptyList(), runStart, runEnd))
        assertEquals(runEnd, McpRunTickets.chooseRunLog(listOf(log(runEnd)), runStart, runEnd)!!.timestamp)
    }

    @Test
    fun isWithinRunBounds() {
        val start = t0 + 45_678
        val end = t0 + 50_000
        assertTrue(McpRunTickets.isWithinRun(t0 + 45_000, start, end)) // whole-second stamp: floored start
        assertTrue(McpRunTickets.isWithinRun(start, start, end))
        assertFalse(McpRunTickets.isWithinRun(start - 1, start, end))
        assertTrue(McpRunTickets.isWithinRun(end, start, end))
        assertFalse(McpRunTickets.isWithinRun(end + 1, start, end))
        assertFalse(McpRunTickets.isWithinRun(t0 + 44_000, start, end))
    }

    @Test
    fun parseRunLogRequiresAgentAndNumericTimestamp() {
        val ok = JSONObject().put("agentId", "daily").put("timestamp", t0).put("status", "success")
            .put("outputPreview", "x".repeat(900)).put("errorMessage", "").put("savedPath", "/sdcard/a.md")
        val parsed = McpRunTickets.parseRunLog(ok.toString(), "daily")!!
        assertEquals(t0, parsed.timestamp)
        assertEquals(McpRunTickets.MAX_PREVIEW_CHARS, parsed.outputPreview.length)
        assertEquals("/sdcard/a.md", parsed.savedPath)
        assertNull(McpRunTickets.parseRunLog(ok.toString(), "other"))
        assertNull(McpRunTickets.parseRunLog(JSONObject(ok.toString()).put("timestamp", "1").toString(), "daily"))
        assertNull(McpRunTickets.parseRunLog(JSONObject(ok.toString()).put("status", 1).toString(), "daily"))
        assertNull(McpRunTickets.parseRunLog("{", "daily"))
        // Receiver logs carry no preview: still a log.
        val receiver = "{\"agentId\":\"daily\",\"timestamp\":$t0,\"status\":\"skipped\",\"errorMessage\":\"previous run still active\"}"
        assertEquals("", McpRunTickets.parseRunLog(receiver, "daily")!!.outputPreview)
    }

    // ── Outcome mapping ──────────────────────────────────────────────────

    @Test
    fun exitCodes129And130AreSkipped() {
        for (code in listOf(129, 130)) {
            val o = McpRunTickets.outcomeOf(code, "previous run still active", null)
            assertEquals("skipped", o.state)
            assertEquals("busy", o.reason)
            // Even if a log says success, a refused-before-start code is skipped.
            assertEquals("skipped", McpRunTickets.outcomeOf(code, "", log(t0, "success")).state)
        }
        assertEquals("halted", McpRunTickets.outcomeOf(130, "All agents are stopped (global kill-switch is on).", null).reason)
        assertEquals("disabled", McpRunTickets.outcomeOf(129, "agent disabled immediately before launch: x", null).reason)
        assertEquals("backoff", McpRunTickets.outcomeOf(130, "native failure backoff active after 3 consecutive errors", null).reason)
        assertEquals("refused", McpRunTickets.outcomeOf(130, "something else", null).reason)
    }

    @Test
    fun outcomeUsesTheRunLogThenTheExitCode() {
        assertEquals(McpRunTickets.Outcome("failed", "crashed"), McpRunTickets.outcomeOf(null, null, null))
        assertEquals(McpRunTickets.Outcome("succeeded", null), McpRunTickets.outcomeOf(0, "", log(t0, "success")))
        // Soft failure: exit 0 but the log says error.
        assertEquals(McpRunTickets.Outcome("failed", "error"), McpRunTickets.outcomeOf(0, "", log(t0, "error")))
        assertEquals(McpRunTickets.Outcome("failed", "unavailable"), McpRunTickets.outcomeOf(1, "", log(t0, "unavailable")))
        assertEquals("skipped", McpRunTickets.outcomeOf(0, "", log(t0, "skipped", "previous run still active")).state)
        // No log (legacy .sh crashed before writing one, gap E1): the exit code decides.
        assertEquals(McpRunTickets.Outcome("succeeded", null), McpRunTickets.outcomeOf(0, "", null))
        assertEquals(McpRunTickets.Outcome("failed", "error"), McpRunTickets.outcomeOf(127, "missing script", null))
        assertEquals(McpRunTickets.Outcome("succeeded", null), McpRunTickets.outcomeOf(0, "", log(t0, "pending")))
        // A log never upgrades a non-zero exit to success.
        assertEquals(McpRunTickets.Outcome("failed", "error"), McpRunTickets.outcomeOf(1, "", log(t0, "success")))
    }

    // ── Pruning ──────────────────────────────────────────────────────────

    @Test
    fun pruneDropsTicketsOlderThan24h() {
        val now = t0 + McpRunTickets.RETENTION_MS + 10
        val entries = listOf(
            PruneEntry(handleN(1), p1, "succeeded", t0),
            PruneEntry(handleN(2), p1, "succeeded", t0 + 11),
            PruneEntry(handleN(3), p2, "running", t0 + 5),
        )
        assertEquals(setOf(handleN(1), handleN(3)), McpRunTickets.handlesToPrune(entries, now))
    }

    @Test
    fun pruneCapsEachPrincipalOldestFirstAndKeepsLiveTickets() {
        val now = t0 + 1_000_000
        val entries = ArrayList<PruneEntry>()
        // p1: 103 tickets; the two oldest are live, so the next three oldest go.
        entries.add(PruneEntry(handleN(0), p1, "running", t0))
        entries.add(PruneEntry(handleN(1), p1, "accepted", t0 + 1))
        for (i in 2 until 103) entries.add(PruneEntry(handleN(i), p1, "succeeded", t0 + i))
        // p2: exactly 100, nothing goes.
        for (i in 200 until 300) entries.add(PruneEntry(handleN(i), p2, "failed", t0 + i))
        val drop = McpRunTickets.handlesToPrune(entries, now)
        assertEquals(setOf(handleN(2), handleN(3), handleN(4)), drop)
    }

    // ── UTF-8 cut ────────────────────────────────────────────────────────

    @Test
    fun utf8PrefixNeverSplitsACharacter() {
        val text = "ab" + "あ" + "😀" // 2 + 3 + 4 bytes
        val bytes = text.toByteArray(Charsets.UTF_8)
        assertEquals(text, McpRunTickets.utf8Prefix(bytes, 100))
        assertEquals("ab", McpRunTickets.utf8Prefix(bytes, 2))
        assertEquals("ab", McpRunTickets.utf8Prefix(bytes, 3))
        assertEquals("ab", McpRunTickets.utf8Prefix(bytes, 4))
        assertEquals("abあ", McpRunTickets.utf8Prefix(bytes, 5))
        assertEquals("abあ", McpRunTickets.utf8Prefix(bytes, 8))
        assertEquals(text, McpRunTickets.utf8Prefix(bytes, 9))
        assertEquals("", McpRunTickets.utf8Prefix(bytes, 0))
        assertNull(McpRunTickets.utf8Prefix(byteArrayOf(0xC3.toByte(), 0x28), 2))
    }

    @Test
    fun withCancelledEndsOnlyLiveTicketsOfThePrincipal() {
        val a = accepted()
        val c = McpRunTickets.withCancelled(a, null, t0 + 10)!!
        assertEquals("cancelled", c.state)
        assertEquals("revoked", c.reason)
        assertNull(McpRunTickets.withRunning(c, t0 + 20))
        assertNull(McpRunTickets.withCancelled(a, p2, t0 + 10))
        assertNotNull(McpRunTickets.withCancelled(a, p1, t0 + 10))
        val running = McpRunTickets.withRunning(a, t0 + 5)!!
        assertEquals("cancelled", McpRunTickets.withCancelled(running, p1, t0 + 10)!!.state)
        assertNull(McpRunTickets.withCancelled(c, null, t0 + 30))
        // Stale: already lost, nothing to cancel.
        assertNull(McpRunTickets.withCancelled(a, null, t0 + McpRunTickets.ACCEPTED_STALE_MS + 1))
    }
}
