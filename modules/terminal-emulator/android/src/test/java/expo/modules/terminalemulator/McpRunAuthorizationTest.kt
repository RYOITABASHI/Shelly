package expo.modules.terminalemulator

import expo.modules.terminalemulator.McpRunAuthorization.Facts
import expo.modules.terminalemulator.McpRunAuthorization.Grant
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The launch grant of an MCP run_agent run and its start-time decision (gate
 * finding 4): what authorized the launch (signed deadline, approved binding,
 * the rule of a run without a tap) is kept with the handle and re-checked when
 * the service actually starts the run. Pure half; McpRunLauncher reads the
 * facts on the device. Not compiled on the VM this was written on (no Gradle).
 */
class McpRunAuthorizationTest {
    private val p1 = "0123456789abcdef0123456789abcdef"
    private val p2 = "fedcba9876543210fedcba9876543210"
    private val bind = "a".repeat(64)
    private val t0 = 1_763_208_000_000L
    private val deadline = t0 + 100_000L
    private val ruleId = "r_0123456789abcdef"
    private val handle = "mr_" + "0123456789abcdef".repeat(2)

    private val pin = "c".repeat(64)
    private fun tapGrant() = Grant("daily", p1, deadline, bind, null, null, pin)
    private fun ruleGrant() = Grant("daily", p1, deadline, bind, ruleId, "agent:daily", pin)

    private fun facts(
        now: Long = t0 + 1_000,
        enabled: Boolean = true,
        currentBind: String? = bind,
        halted: Boolean = false,
        tainted: Boolean = false,
        policyDenied: Boolean = false,
        declaresActions: Boolean = true,
        policyPin: String? = pin,
        policyVerified: Boolean = true,
        typedOps: Boolean = true,
        matched: String? = ruleId,
    ) = Facts(now, enabled, currentBind, halted, tainted, policyDenied, declaresActions, policyPin, policyVerified, typedOps, matched)

    @After
    fun clear() = McpRunAuthorization.clearForTests()

    @Test
    fun actionConsentRequiresTheExactVerifiedPolicySnapshotAtStart() {
        val current = facts().copy(matchedActionPolicyPin = pin)
        assertNull(McpRunAuthorization.refusal(ruleGrant(), "daily", p1, current))
        assertEquals(McpRunTickets.REASON_REFUSED, McpRunAuthorization.refusal(ruleGrant(), "daily", p1, current.copy(matchedActionPolicyPin = "d".repeat(64))))
        assertEquals(McpRunTickets.REASON_REFUSED, McpRunAuthorization.refusal(ruleGrant(), "daily", p1, current.copy(policyVerified = false)))
    }

    @Test
    fun currentGrantsMayStart() {
        assertNull(McpRunAuthorization.refusal(tapGrant(), "daily", p1, facts(matched = null)))
        assertNull(McpRunAuthorization.refusal(ruleGrant(), "daily", p1, facts()))
        // Exactly at the deadline is still inside the client's wait.
        assertNull(McpRunAuthorization.refusal(tapGrant(), "daily", p1, facts(now = deadline)))
    }

    @Test
    fun delayedPastTheSignedDeadlineNeverStarts() {
        assertEquals(McpRunTickets.REASON_EXPIRED, McpRunAuthorization.refusal(tapGrant(), "daily", p1, facts(now = deadline + 1)))
        assertEquals(McpRunTickets.REASON_EXPIRED, McpRunAuthorization.refusal(ruleGrant(), "daily", p1, facts(now = deadline + 60_000)))
    }

    @Test
    fun targetDisabledOrEditedAfterApprovalNeverStarts() {
        // unattended=false runs skip AgentRuntime's enabled backstop: this is the check.
        assertEquals(McpRunTickets.REASON_DISABLED, McpRunAuthorization.refusal(tapGrant(), "daily", p1, facts(enabled = false, currentBind = null)))
        assertEquals(McpRunTickets.REASON_TARGET_CHANGED, McpRunAuthorization.refusal(tapGrant(), "daily", p1, facts(currentBind = "b".repeat(64))))
        assertEquals(McpRunTickets.REASON_TARGET_CHANGED, McpRunAuthorization.refusal(ruleGrant(), "daily", p1, facts(currentBind = null)))
    }

    @Test
    fun ruleRemovedOrReplacedOrSettingOffNeverStartsARuleBasedRun() {
        assertEquals(McpRunTickets.REASON_REVOKED, McpRunAuthorization.refusal(ruleGrant(), "daily", p1, facts(matched = null)))
        assertEquals(McpRunTickets.REASON_REVOKED, McpRunAuthorization.refusal(ruleGrant(), "daily", p1, facts(matched = "r_ffffffffffffffff")))
        assertEquals(McpRunTickets.REASON_DISABLED, McpRunAuthorization.refusal(ruleGrant(), "daily", p1, facts(typedOps = false)))
    }

    @Test
    fun typedOpsTurnedOffBeforeTheStartStopsEveryGrant() {
        // Codex round 1: a tapped run accepted before the owner disabled typed ops.
        assertEquals(McpRunTickets.REASON_DISABLED, McpRunAuthorization.refusal(tapGrant(), "daily", p1, facts(typedOps = false, matched = null)))
    }

    @Test
    fun policyChangedReplacedOrDeletedAfterRnCheckedItNeverStarts() {
        // Codex round 1: native can't evaluate every POLICY-001 rule (conditional
        // deny, draft_only), so the file must still be the one RN evaluated.
        for (g in listOf(tapGrant(), ruleGrant())) {
            assertEquals(McpRunTickets.REASON_REFUSED, McpRunAuthorization.refusal(g, "daily", p1, facts(policyPin = "d".repeat(64))))
            assertEquals(McpRunTickets.REASON_REFUSED, McpRunAuthorization.refusal(g, "daily", p1, facts(policyPin = McpRunAuthorization.POLICY_ABSENT)))
            assertEquals(McpRunTickets.REASON_REFUSED, McpRunAuthorization.refusal(g, "daily", p1, facts(policyPin = null)))
            // RN could not say which file it read: an agent with actions never starts.
            assertEquals(McpRunTickets.REASON_REFUSED, McpRunAuthorization.refusal(g.copy(policyPin = null), "daily", p1, facts()))
        }
        // Deleted before RN read it, still absent: allowed (RN read "no rules", sealed).
        val absent = tapGrant().copy(policyPin = McpRunAuthorization.POLICY_ABSENT)
        assertNull(McpRunAuthorization.refusal(absent, "daily", p1, facts(policyPin = McpRunAuthorization.POLICY_ABSENT, matched = null)))
        // An agent with no declared action: the policy can't match anything (headless grants carry no pin).
        assertNull(McpRunAuthorization.refusal(ruleGrant().copy(policyPin = null), "daily", p1, facts(declaresActions = false, policyPin = null, policyVerified = false)))
    }

    @Test
    fun unverifiedPolicyStopsOnlyARuleBasedRunOfAnAgentWithActions() {
        // Gate finding 1 at the start boundary: no tap + unsealed / malformed policy.
        assertEquals(McpRunTickets.REASON_REFUSED, McpRunAuthorization.refusal(ruleGrant(), "daily", p1, facts(policyVerified = false)))
        // A tap was the owner's own decision (RN shows the dialog with an unavailable policy too).
        assertNull(McpRunAuthorization.refusal(tapGrant(), "daily", p1, facts(policyVerified = false, matched = null)))
    }

    @Test
    fun sealCheckMirrorsRnIsSealedPolicyState() {
        val h = "e".repeat(64)
        val absent = McpRunAuthorization.POLICY_ABSENT
        // Never sealed: only a missing or blank file.
        assertTrue(McpRunAuthorization.isSealed(true, false, "", absent, true))
        assertTrue(McpRunAuthorization.isSealed(true, false, "", h, true))
        assertFalse(McpRunAuthorization.isSealed(true, false, "", h, false))
        // Sealed once, now empty (seal deleted): unavailable even with no file.
        assertFalse(McpRunAuthorization.isSealed(true, true, "", absent, true))
        // A seal: the file must exist and its hash be listed (either of [new, old]).
        assertTrue(McpRunAuthorization.isSealed(true, true, h, h, false))
        assertTrue(McpRunAuthorization.isSealed(true, true, "${"f".repeat(64)},$h", h, false))
        assertFalse(McpRunAuthorization.isSealed(true, true, h, "d".repeat(64), false))
        assertFalse(McpRunAuthorization.isSealed(true, true, h, absent, true))
        // MAC failure / unreadable file.
        assertFalse(McpRunAuthorization.isSealed(false, true, h, h, false))
        assertFalse(McpRunAuthorization.isSealed(true, true, h, null, false))
    }

    @Test
    fun stopAllTaintAndPolicyDenyRefuse() {
        assertEquals(McpRunTickets.REASON_HALTED, McpRunAuthorization.refusal(tapGrant(), "daily", p1, facts(halted = true)))
        assertEquals(McpRunTickets.REASON_REFUSED, McpRunAuthorization.refusal(tapGrant(), "daily", p1, facts(tainted = true)))
        assertEquals(McpRunTickets.REASON_REFUSED, McpRunAuthorization.refusal(ruleGrant(), "daily", p1, facts(policyDenied = true)))
    }

    @Test
    fun noGrantOrAnotherAgentOrPrincipalIsUnauthorized() {
        assertEquals(McpRunTickets.REASON_UNAUTHORIZED, McpRunAuthorization.refusal(null, "daily", p1, facts()))
        assertEquals(McpRunTickets.REASON_UNAUTHORIZED, McpRunAuthorization.refusal(tapGrant(), "other", p1, facts()))
        assertEquals(McpRunTickets.REASON_UNAUTHORIZED, McpRunAuthorization.refusal(tapGrant(), "daily", p2, facts()))
        assertEquals(McpRunTickets.REASON_UNAUTHORIZED, McpRunAuthorization.refusal(tapGrant(), "daily", null, facts()))
        // Malformed grants: no deadline, bad bind, a rule without its own target.
        assertEquals(McpRunTickets.REASON_UNAUTHORIZED, McpRunAuthorization.refusal(tapGrant().copy(deadlineMs = 0L), "daily", p1, facts()))
        assertEquals(McpRunTickets.REASON_UNAUTHORIZED, McpRunAuthorization.refusal(tapGrant().copy(bind = "x"), "daily", p1, facts()))
        assertEquals(McpRunTickets.REASON_UNAUTHORIZED, McpRunAuthorization.refusal(ruleGrant().copy(target = "agent:other"), "daily", p1, facts()))
        assertEquals(McpRunTickets.REASON_UNAUTHORIZED, McpRunAuthorization.refusal(ruleGrant().copy(ruleId = "r_bad"), "daily", p1, facts()))
        assertEquals(McpRunTickets.REASON_UNAUTHORIZED, McpRunAuthorization.refusal(tapGrant().copy(policyPin = "x"), "daily", p1, facts()))
    }

    @Test
    fun everyRefusalIsAValidTicketReason() {
        for (r in listOf(McpRunAuthorization.REASON_EXPIRED, McpRunAuthorization.REASON_TARGET_CHANGED, McpRunAuthorization.REASON_UNAUTHORIZED)) {
            assertTrue(r in McpRunTickets.REASONS)
        }
        // A start refused at markRunning ends the ticket skipped with the reason.
        val t = McpRunTickets.newTicket(handle, p1, null, "daily", t0)!!
        val ended = McpRunTickets.withFinished(t, McpRunTickets.STATE_SKIPPED, McpRunTickets.REASON_EXPIRED, null, null, null, t0 + 1)!!
        assertEquals(ended, McpRunTickets.decode(McpRunTickets.encode(ended)))
    }

    @Test
    fun registryIsSingleUseAndBounded() {
        assertTrue(McpRunAuthorization.register(handle, tapGrant(), t0))
        assertFalse(McpRunAuthorization.register(handle, tapGrant(), t0)) // handle taken
        assertEquals(tapGrant(), McpRunAuthorization.take(handle))
        assertNull(McpRunAuthorization.take(handle)) // used once
        assertFalse(McpRunAuthorization.register("not-a-handle", tapGrant(), t0))
        assertFalse(McpRunAuthorization.register(handle, tapGrant().copy(bind = "x"), t0))
        // Full of live grants: refused (fail closed), nothing evicted.
        for (n in 0 until McpRunAuthorization.MAX_GRANTS) {
            assertTrue(McpRunAuthorization.register("mr_" + "%032x".format(n), tapGrant(), t0))
        }
        assertFalse(McpRunAuthorization.register(handle, tapGrant(), t0))
        assertSame(null, McpRunAuthorization.take(handle))
        // Past deadline + slack the old grants are pruned and room returns.
        assertTrue(McpRunAuthorization.register(handle, tapGrant().copy(deadlineMs = t0 + 500_000), deadline + McpRunAuthorization.GRANT_SLACK_MS + 1))
        assertNull(McpRunAuthorization.take("mr_" + "%032x".format(0)))
    }
}
