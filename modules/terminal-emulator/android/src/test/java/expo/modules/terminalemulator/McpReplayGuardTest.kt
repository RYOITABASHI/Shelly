package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The typed-op consumer's replay set (gate finding 3): a consumed callId is
 * kept for the whole validity window of its signed request, never evicted by
 * count; a full set of live entries refuses new requests. Like the other Mcp*
 * JVM tests, not compiled on the VM this was written on (no Gradle there).
 */
class McpReplayGuardTest {
    private val t0 = 1_731_650_000_000L
    private fun id(n: Int) = "call-%08d".format(n)

    /**
     * The gate's scenario: a captured signed request without requestId, then
     * more valid requests than the old 1,000-entry FIFO held, all within its
     * 100 s window — re-inserting the captured file is still a replay.
     */
    @Test
    fun capturedSignedRequestStaysAReplayAfterThousandsOfLaterRequestsInItsWindow() {
        val fixture = McpFixtures.load("mcp-signed-request-cases.json")
        val key = fixture.getString("bridgeKey")
        val req = fixture.getJSONArray("cases").getJSONObject(0).getJSONObject("request")
        val text = req.toString()
        val callId = req.getString("callId")
        val received = McpTypedOpDecision.parseIsoMs(req.getString("receivedAt"))!!
        val g = McpReplayGuard()
        val first = McpTypedOpDecision.parseRequest(text, "$callId.json", key, received) { g.isSeen(it) }
        assertTrue(first is McpTypedOpDecision.Parsed.Ok)
        assertTrue(g.admit(callId, received, received))
        for (n in 0 until 3_000) assertTrue(g.admit(id(n), received + n * 30L, received + n * 30L))
        val replayAt = received + McpTypedOpDecision.MAX_REQUEST_AGE_MS
        assertEquals(
            McpTypedOpDecision.Parsed.Drop("replay"),
            McpTypedOpDecision.parseRequest(text, "$callId.json", key, replayAt) { g.isSeen(it) },
        )
    }

    @Test
    fun fullOfLiveEntriesRefusesANewCallIdAndEvictsNothing() {
        val g = McpReplayGuard(capacity = 3)
        assertTrue(g.admit(id(1), t0, t0))
        assertTrue(g.admit(id(2), t0, t0))
        assertTrue(g.admit(id(3), t0, t0))
        assertFalse(g.admit(id(4), t0 + 1_000, t0 + 1_000))
        assertFalse(g.isSeen(id(4)))
        for (n in 1..3) assertTrue(g.isSeen(id(n)))
        assertEquals(3, g.size)
    }

    @Test
    fun entriesAreForgottenOnlyAfterReceivedAtPlusWindowPlusMargin() {
        val g = McpReplayGuard(capacity = 1)
        assertTrue(g.admit(id(1), t0, t0))
        val lastKept = t0 + McpReplayGuard.RETAIN_AFTER_RECEIVED_MS
        assertFalse(g.admit(id(2), lastKept, lastKept))
        assertTrue(g.isSeen(id(1)))
        assertTrue(g.admit(id(2), lastKept + 1, lastKept + 1))
        assertFalse(g.isSeen(id(1)))
        assertTrue(McpReplayGuard.RETAIN_AFTER_RECEIVED_MS > McpTypedOpDecision.MAX_REQUEST_AGE_MS)
    }

    @Test
    fun retentionFollowsTheSignedReceivedAtSoAFutureDatedRequestStaysCovered() {
        val g = McpReplayGuard(capacity = 1)
        val future = t0 + McpTypedOpDecision.FUTURE_TOLERANCE_MS
        assertTrue(g.admit(id(1), future, t0))
        // Past seen-time + 100 s, but the request itself is still fresh until future + 100 s.
        val later = t0 + McpTypedOpDecision.MAX_REQUEST_AGE_MS + 30_000
        assertFalse(g.admit(id(2), later, later))
        assertTrue(g.isSeen(id(1)))
    }

    @Test
    fun readmittingAKnownCallIdNeverShortensItAndNeedsNoRoom() {
        val g = McpReplayGuard(capacity = 1)
        assertTrue(g.admit(id(1), t0 + 50_000, t0))
        assertTrue(g.admit(id(1), t0, t0))
        g.prune(t0 + McpReplayGuard.RETAIN_AFTER_RECEIVED_MS + 1)
        assertTrue(g.isSeen(id(1)))
    }
}
