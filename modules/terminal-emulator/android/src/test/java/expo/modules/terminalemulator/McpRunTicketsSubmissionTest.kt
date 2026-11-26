package expo.modules.terminalemulator

import expo.modules.terminalemulator.McpRunTickets.Submission
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure half of the launcher submission records (C4). The I/O half needs a device. */
class McpRunTicketsSubmissionTest {
    private val lp = "launcher:0123456789abcdef0123456789abcdef"
    private val now = 1_763_208_000_000L

    private fun sub(
        id: String = "ls_" + "1".repeat(32),
        state: String = McpRunTickets.SUB_PENDING,
        acceptedAt: Long = now,
        nonce: String? = "nonce-0001",
        untrusted: Boolean = true,
        exempt: Boolean = false,
        via: String? = null,
        ruleId: String? = null,
        principal: String = lp,
    ) = Submission(
        id = id, principal = principal, state = state, acceptedAt = acceptedAt, decidedAt = null, nonce = nonce,
        correlationRef = "task:7", untrusted = untrusted, exemptApplied = exempt, textSha256 = "a".repeat(64),
        textCodePoints = 42, certDigest = "b".repeat(64), schemaVersion = 1, approvedVia = via, ruleId = ruleId,
    )

    @Test
    fun roundTripsAndCarriesNoText() {
        val s = sub()
        val json = McpRunTickets.encodeSubmission(s)
        assertEquals(s, McpRunTickets.decodeSubmission(json))
        val o = JSONObject(json)
        assertEquals("submission", o.getString("kind"))
        assertEquals("submit_instruction", o.getString("op"))
        assertEquals("hayato", o.getString("target"))
        assertEquals("task:7", o.getString("correlationRef"))
        assertTrue(o.getBoolean("untrusted"))
        for (k in listOf("text", "instruction_text", "instructionText")) assertFalse(k, o.has(k))
    }

    @Test
    fun refusesImpossibleRecords() {
        val bad = listOf(
            sub(principal = "0123456789abcdef0123456789abcdef"), // an MCP principal
            sub(id = "mr_" + "1".repeat(32)), // a run handle is not a submission id
            sub(state = "running"),
            sub(state = McpRunTickets.SUB_APPROVED), // approved needs approvedVia
            sub(via = "user"), // pending can't carry approvedVia
            sub(state = McpRunTickets.SUB_APPROVED, via = "rule"), // tainted + rule: never unattended
            sub(state = McpRunTickets.SUB_APPROVED, via = "approve_all"), // tainted + switch: never unattended
            sub(untrusted = true, exempt = true),
            sub(nonce = "short"),
            sub(state = McpRunTickets.SUB_APPROVED, untrusted = false, exempt = true, via = "rule", ruleId = "bad"),
        )
        for (s in bad) assertFalse(s.toString(), McpRunTickets.isValidSubmission(s))
        assertTrue(McpRunTickets.isValidSubmission(sub(state = McpRunTickets.SUB_APPROVED, untrusted = false, exempt = true, via = "rule", ruleId = "r_0123456789abcdef")))
        assertTrue(McpRunTickets.isValidSubmission(sub(state = McpRunTickets.SUB_APPROVED, via = "user")))
        assertNull(McpRunTickets.decodeSubmission(JSONObject(McpRunTickets.encodeSubmission(sub())).put("text", "x").toString()))
        assertNull(McpRunTickets.decodeSubmission(JSONObject(McpRunTickets.encodeSubmission(sub())).put("v", 2).toString()))
    }

    @Test
    fun pendingExpiresAfterTheApprovalWindowNotTheTwoMinuteStaleRule() {
        val s = sub()
        assertEquals(McpRunTickets.SUB_PENDING, McpRunTickets.applySubmissionExpiry(s, now + McpRunTickets.ACCEPTED_STALE_MS + 1).state)
        assertEquals(McpRunTickets.SUB_PENDING, McpRunTickets.applySubmissionExpiry(s, now + LauncherIngressLimits.APPROVAL_WINDOW_MS).state)
        val expired = McpRunTickets.applySubmissionExpiry(s, now + LauncherIngressLimits.APPROVAL_WINDOW_MS + 1)
        assertEquals(McpRunTickets.SUB_EXPIRED, expired.state)
        assertNotNull(expired.decidedAt)
        // A decision after expiry is refused; before it, it lands.
        assertNull(McpRunTickets.withUserDecision(s, true, now + LauncherIngressLimits.APPROVAL_WINDOW_MS + 1))
        assertEquals(McpRunTickets.SUB_APPROVED, McpRunTickets.withUserDecision(s, true, now + 1)!!.state)
        assertEquals(McpRunTickets.SUB_DENIED_BY_USER, McpRunTickets.withUserDecision(s, false, now + 1)!!.state)
        assertNull(McpRunTickets.withUserDecision(sub(state = McpRunTickets.SUB_APPROVED, via = "user"), false, now))
    }

    @Test
    fun onlyPendingOnesPastTheWindowAreRewrittenAsExpired() {
        val late = now + LauncherIngressLimits.APPROVAL_WINDOW_MS + 1
        val old = sub(id = "ls_" + "2".repeat(32))
        val fresh = sub(id = "ls_" + "3".repeat(32), acceptedAt = late)
        val decided = sub(id = "ls_" + "4".repeat(32), state = McpRunTickets.SUB_APPROVED, via = "rule", ruleId = "r1")
        val out = McpRunTickets.submissionsToExpire(listOf(old, fresh, decided), late)
        assertEquals(listOf(old.id), out.map { it.id })
        assertEquals(McpRunTickets.SUB_EXPIRED, out[0].state)
        assertEquals(late, out[0].decidedAt)
        assertEquals(emptyList<Submission>(), McpRunTickets.submissionsToExpire(out, late + 1))
    }

    @Test
    fun nonceDedupesInsideTheWindowAndPendingCountsForBusy() {
        val a = sub(id = "ls_" + "a".repeat(32), acceptedAt = now - 1000)
        val b = sub(id = "ls_" + "b".repeat(32), acceptedAt = now - LauncherIngressLimits.NONCE_WINDOW_MS - 1, nonce = "nonce-0002")
        val c = sub(id = "ls_" + "c".repeat(32), acceptedAt = now - 5000, nonce = null, state = McpRunTickets.SUB_APPROVED, via = "user")
        val subs = listOf(a, b, c)
        assertEquals(a, McpRunTickets.findByNonce(subs, lp, "nonce-0001", now))
        assertNull(McpRunTickets.findByNonce(subs, lp, "nonce-0002", now))
        assertNull(McpRunTickets.findByNonce(subs, "launcher:" + "f".repeat(32), "nonce-0001", now))
        // b is past the approval window: expired, not pending. c is approved.
        assertEquals(1, McpRunTickets.pendingCount(subs, lp, now))
        assertEquals(listOf(now - 1000, now - 5000, b.acceptedAt), McpRunTickets.acceptedTimes(subs, lp))
    }

    @Test
    fun pruningNeverDropsAPendingOneByCount() {
        val many = (0 until McpRunTickets.MAX_PER_PRINCIPAL).map { i ->
            sub(id = "ls_" + "%032x".format(i), acceptedAt = now - 1000L * (i + 1), state = McpRunTickets.SUB_APPROVED, via = "user", nonce = null)
        }
        // The oldest of the group, still inside the approval window: pending.
        val pending = sub(id = "ls_" + "f".repeat(32), acceptedAt = now - 500_000L)
        val old = sub(id = "ls_" + "e".repeat(32), acceptedAt = now - McpRunTickets.RETENTION_MS - 1)
        val drop = McpRunTickets.submissionsToPrune(many + pending + old, now)
        assertTrue(old.id in drop)
        assertFalse(pending.id in drop)
        // `old` by age; then 101 kept + the new one = 2 over the cap: the two oldest DECIDED ones.
        assertEquals(setOf(old.id, many[99].id, many[98].id), drop)
    }
}
