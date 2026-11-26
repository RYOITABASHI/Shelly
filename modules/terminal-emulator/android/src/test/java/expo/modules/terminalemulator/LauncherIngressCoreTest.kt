package expo.modules.terminalemulator

import expo.modules.terminalemulator.LauncherIngressCore.Decision
import expo.modules.terminalemulator.LauncherIngressCore.PayloadResult
import expo.modules.terminalemulator.LauncherIngressCore.Reason
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure half of the launcher ingress (fact sheet §1, §3, §5, A1–A4, D1). Made-up values only. */
class LauncherIngressCoreTest {
    private val now = 1_763_208_000_000L
    private val principal = IngressDecision.Principal(IngressOrigin.LAUNCHER, "0123456789abcdef0123456789abcdef")

    private class Extras(private val m: Map<String, Any?>) : LauncherIngressCore.Extras {
        override fun keys(): Set<String> = m.keys
        override fun has(key: String): Boolean = m.containsKey(key)
        override fun string(key: String): String? = m[key] as? String
    }

    private fun payload(vararg kv: Pair<String, Any?>) = LauncherIngressCore.checkPayload(Extras(mapOf(*kv)))

    private class Facts(
        var enabled: Boolean = true,
        var halted: Boolean = false,
        var bound: Boolean = false,
        var rule: String? = "r_0123456789abcdef",
        var approveAll: Boolean = false,
    ) : LauncherIngressCore.Facts {
        val calls = ArrayList<String>()
        override fun ingressEnabled(): Boolean { calls.add("enabled"); return enabled }
        override fun halted(): Boolean { calls.add("halted"); return halted }
        override fun exemptionBound(): Boolean { calls.add("bound"); return bound }
        override fun matchRule(principalWire: String): String? { calls.add("rule"); return rule }
        override fun approveAllOn(): Boolean { calls.add("approveAll"); return approveAll }
    }

    private fun decide(
        p: PayloadResult = payload("instruction_text" to "check the build"),
        f: Facts = Facts(),
        mine: List<McpRunTickets.Submission> = emptyList(),
    ) = LauncherIngressCore.decide(principal, p, mine, now, f)

    // ── Payload (§1.1, R3, R5) ─────────────────────────────────────────────

    private fun bad(r: PayloadResult) = r as PayloadResult.Bad

    @Test
    fun textIsCountedInCodePointsAndNeverCut() {
        val emoji = "😀" // one code point, two UTF-16 units
        val atLimit = emoji.repeat(LauncherIngressLimits.MAX_TEXT_CODE_POINTS)
        val ok = payload("instruction_text" to atLimit) as PayloadResult.Ok
        assertEquals(LauncherIngressLimits.MAX_TEXT_CODE_POINTS, ok.payload.codePoints)
        assertEquals(atLimit, ok.payload.text)
        assertEquals(Reason.PAYLOAD_TOO_LARGE, bad(payload("instruction_text" to atLimit + "x")).reason)
        assertTrue(payload("instruction_text" to "x".repeat(4000)) is PayloadResult.Ok)
        assertEquals(Reason.PAYLOAD_TOO_LARGE, bad(payload("instruction_text" to "x".repeat(4001))).reason)
        // A split surrogate pair is malformed, not "one more char".
        assertEquals("text_encoding", bad(payload("instruction_text" to "x" + "\uD83D")).code)
        assertEquals("text_encoding", bad(payload("instruction_text" to "\uDE00x")).code)
    }

    @Test
    fun missingWrongTypeEmptyOrControlTextIsInvalid() {
        assertEquals("payload_missing", bad(LauncherIngressCore.checkPayload(null)).code)
        assertEquals("text_missing", bad(payload("correlation_ref" to "a")).code)
        assertEquals("text_type", bad(payload("instruction_text" to 42)).code)
        assertEquals("text_empty", bad(payload("instruction_text" to "  \n ")).code)
        for (c in listOf("\u0000", "\u001B[2J", "\u007F", "\u0085", "‮", "⁦")) {
            assertEquals(c, "text_control", bad(payload("instruction_text" to "a${c}b")).code)
        }
        assertTrue(payload("instruction_text" to "line one\nline two\ttab\r\n") is PayloadResult.Ok)
    }

    @Test
    fun correlationAndNonceAreBoundedOpaqueTokens() {
        val ok = payload("instruction_text" to "x", "correlation_ref" to "task:42/a.b-c", "submission_nonce" to "Ab_9-xyz") as PayloadResult.Ok
        assertEquals("task:42/a.b-c", ok.payload.correlationRef)
        assertEquals("Ab_9-xyz", ok.payload.nonce)
        assertEquals(Reason.PAYLOAD_TOO_LARGE, bad(payload("instruction_text" to "x", "correlation_ref" to "a".repeat(257))).reason)
        assertEquals(Reason.INVALID_PAYLOAD, bad(payload("instruction_text" to "x", "correlation_ref" to "has spaces")).reason)
        assertEquals(Reason.INVALID_PAYLOAD, bad(payload("instruction_text" to "x", "correlation_ref" to 7)).reason)
        assertEquals(Reason.INVALID_PAYLOAD, bad(payload("instruction_text" to "x", "submission_nonce" to "short")).reason)
        assertEquals(Reason.PAYLOAD_TOO_LARGE, bad(payload("instruction_text" to "x", "submission_nonce" to "a".repeat(65))).reason)
    }

    // ── Decision ───────────────────────────────────────────────────────────

    @Test
    fun theStagesRunInTheSharedOrderAndStopAllWinsBeforeAnyApproval() {
        val f = Facts(halted = true, bound = true, approveAll = true)
        assertEquals(Decision.Deny(Reason.STOP_ALL_ACTIVE, "halted"), decide(f = f))
        assertEquals(listOf("enabled", "halted"), f.calls)
        assertEquals(Decision.Deny(Reason.DISABLED, "disabled"), decide(f = Facts(enabled = false, halted = true)))
        // Arguments are judged before STOP-ALL (the shared order).
        assertEquals(Reason.PAYLOAD_TOO_LARGE, (decide(p = payload("instruction_text" to "x".repeat(4001)), f = Facts(halted = true)) as Decision.Deny).reason)
    }

    /** A4 / D1 both values: without the exemption nothing is unattended; with it, a rule or the switch approves. */
    @Test
    fun d1ExemptionDecidesWhetherARuleOrTheSwitchMayApprove() {
        for (bound in listOf(false, true)) {
            val viaRule = decide(f = Facts(bound = bound)) as Decision.Accept
            assertEquals(bound, viaRule.approved)
            assertEquals(!bound, viaRule.taint.tainted)
            assertEquals(bound, viaRule.taint.exemptApplied)
            if (bound) assertEquals("rule", viaRule.via)

            val viaSwitch = decide(f = Facts(bound = bound, rule = null, approveAll = true)) as Decision.Accept
            assertEquals(bound, viaSwitch.approved)
            if (bound) assertEquals("approve_all", viaSwitch.via)

            val none = decide(f = Facts(bound = bound, rule = null)) as Decision.Accept
            assertFalse(none.approved) // pending: accepted at once, approval later (A1)
        }
    }

    @Test
    fun anExtraFieldOrAHumanImpossibleRateFallsBackToTainted() {
        val extra = decide(p = payload("instruction_text" to "x", "attachment_url" to "https://example.invalid"), f = Facts(bound = true)) as Decision.Accept
        assertTrue(extra.taint.tainted)
        assertEquals(IngressOrigin.Why.EXTRA_FIELD, extra.taint.why)
        assertFalse(extra.approved)
        // The previous submission 1 s ago: faster than a person.
        val prev = sub(acceptedAt = now - 1000)
        val fast = decide(f = Facts(bound = true), mine = listOf(prev)) as Decision.Accept
        assertEquals(IngressOrigin.Why.RATE, fast.taint.why)
        assertFalse(fast.approved)
        // 200 code points 5 s after the previous one: 40 cp/s.
        val burst = decide(p = payload("instruction_text" to "y".repeat(200)), f = Facts(bound = true), mine = listOf(sub(acceptedAt = now - 5000))) as Decision.Accept
        assertEquals(IngressOrigin.Why.RATE, burst.taint.why)
        // 60 s later the same text is fine.
        val calm = decide(p = payload("instruction_text" to "y".repeat(200)), f = Facts(bound = true), mine = listOf(sub(acceptedAt = now - 60_000))) as Decision.Accept
        assertTrue(calm.approved)
    }

    @Test
    fun rateBrakeLimits() {
        assertTrue(LauncherIngressCore.humanRate(now, emptyList(), 4000))
        assertFalse(LauncherIngressCore.humanRate(now, listOf(now - 2999), 1))
        assertTrue(LauncherIngressCore.humanRate(now, listOf(now - 3000), 60))
        assertFalse(LauncherIngressCore.humanRate(now, listOf(now - 3000), 61))
        val six = (1..6).map { now - it * 9_000L } // six in the last minute, 9 s apart
        assertFalse(LauncherIngressCore.humanRate(now, six, 1))
        assertTrue(LauncherIngressCore.humanRate(now, six.drop(1), 1))
    }

    private fun sub(
        id: String = "ls_" + "1".repeat(32),
        acceptedAt: Long = now - 60_000,
        state: String = McpRunTickets.SUB_PENDING,
        nonce: String? = null,
    ) = McpRunTickets.Submission(
        id = id, principal = principal.wire, state = state, acceptedAt = acceptedAt, decidedAt = null, nonce = nonce,
        correlationRef = null, untrusted = true, exemptApplied = false, textSha256 = "a".repeat(64), textCodePoints = 5,
        certDigest = "b".repeat(64), schemaVersion = 1, approvedVia = if (state == McpRunTickets.SUB_APPROVED) "user" else null, ruleId = null,
    )

    @Test
    fun aRepeatedNonceReturnsTheExistingSubmission() {
        val existing = sub(nonce = "nonce-0001")
        val d = decide(p = payload("instruction_text" to "different text", "submission_nonce" to "nonce-0001"), mine = listOf(existing))
        assertEquals(Decision.Duplicate(existing), d)
    }

    @Test
    fun busyOnlyWhenTheNewOneWouldWaitAndEightAreAlreadyPending() {
        val eight = (0 until LauncherIngressLimits.MAX_PENDING).map { sub(id = "ls_" + "%032x".format(it), acceptedAt = now - 60_000 - it) }
        assertEquals(Decision.Deny(Reason.BUSY, "busy"), decide(f = Facts(rule = null), mine = eight))
        // An immediately approved one is not held back (it waits for nobody).
        assertTrue((decide(f = Facts(bound = true), mine = eight) as Decision.Accept).approved)
        // Expired ones don't count.
        val old = eight.map { it.copy(acceptedAt = now - LauncherIngressLimits.APPROVAL_WINDOW_MS - 1) }
        assertFalse((decide(f = Facts(rule = null), mine = old) as Decision.Accept).approved)
    }

    /**
     * A3, its own test (not the signature test): self-declared identity in the
     * payload never changes provenance. With the exemption off the outcome is
     * identical with or without the keys; with it on, extra keys can only make
     * it worse (tainted), never better.
     */
    @Test
    fun a3SelfDeclaredIdentityKeysNeverChangeTheDecision() {
        val forged = arrayOf(
            "caller_package" to "com.example.launcher", "app_name" to "Launcher", "approval" to "approved",
            "approved" to "true", "origin" to "mcp", "untrusted" to "false", "principal" to "launcher:" + "f".repeat(32),
        )
        val plain = payload("instruction_text" to "check the build")
        val withKeys = payload("instruction_text" to "check the build", *forged)
        for (f in listOf(Facts(), Facts(rule = null), Facts(rule = null, approveAll = true), Facts(halted = true), Facts(enabled = false))) {
            val a = decide(p = plain, f = f)
            val b = decide(p = withKeys, f = Facts(f.enabled, f.halted, f.bound, f.rule, f.approveAll))
            if (a is Decision.Accept) {
                b as Decision.Accept
                assertEquals(a.approved, b.approved)
                assertEquals(a.via, b.via)
                assertEquals(a.taint.tainted, b.taint.tainted)
            } else {
                assertEquals(a, b)
            }
        }
        // With the exemption bound: the forged keys void it (tainted → pending), never upgrade anything.
        val exemptPlain = decide(p = plain, f = Facts(bound = true)) as Decision.Accept
        val exemptForged = decide(p = withKeys, f = Facts(bound = true)) as Decision.Accept
        assertTrue(exemptPlain.approved)
        assertFalse(exemptForged.approved)
        assertTrue(exemptForged.taint.tainted)
        // The principal is the verifier's, whatever the payload says: decide never reads it from extras.
        assertEquals(principal.wire, "launcher:0123456789abcdef0123456789abcdef")
    }

    @Test
    fun unverifiedAuditLinesAreCappedPerWindow() {
        val t = LauncherIngressCore.AuditThrottle(max = 3, windowMs = 1_000L)
        assertTrue(t.allow(10_000L))
        assertTrue(t.allow(10_100L))
        assertTrue(t.allow(10_200L))
        assertFalse(t.allow(10_300L))
        assertFalse(t.allow(10_999L))
        // A new window starts once the old one has passed.
        assertTrue(t.allow(11_000L))
        // A clock that moves back starts a new window (never stuck closed).
        val u = LauncherIngressCore.AuditThrottle(max = 1, windowMs = 1_000L)
        assertTrue(u.allow(5_000L))
        assertFalse(u.allow(5_500L))
        assertTrue(u.allow(4_000L))
    }
}
