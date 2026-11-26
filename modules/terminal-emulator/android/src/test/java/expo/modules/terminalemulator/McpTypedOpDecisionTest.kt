package expo.modules.terminalemulator

import expo.modules.terminalemulator.McpTypedOpDecision.Outcome
import expo.modules.terminalemulator.McpTypedOpDecision.Parsed
import expo.modules.terminalemulator.McpTypedOpPolicy.Decision
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure half of McpTypedOpConsumer: request verification (shared fixture
 * __tests__/fixtures/mcp-signed-request-cases.json, TS side in
 * mcp-typed-op-native-parity.test.ts), the RN heartbeat, the orphan rule and
 * the run_agent decision order (the always-allow store is consulted only after
 * every deny class; "cannot decide" never executes). Not wired into CI's
 * Gradle run yet; not compiled on the VM this was written on (no Gradle there).
 */
class McpTypedOpDecisionTest {
    private val principal = "0123456789abcdef0123456789abcdef"
    private val now = 1_763_208_000_000L // 2025-11-15T12:00:00Z

    // ── Fake facts, recording every call ──────────────────────────────────

    private class FakeSteps(
        var typedOps: Boolean = true,
        var epoch: Boolean = true,
        var agent: JSONObject? = JSONObject().put("id", "daily").put("enabled", true).put("prompt", "p"),
        var halted: Boolean = false,
        var tainted: Boolean = false,
        var step7: Decision = Decision.CLEARABLE,
        var existing: McpRunTickets.Ticket? = null,
        var rule: String? = "r_0123456789abcdef",
        var live: Boolean = false,
        var approved: String? = null,
    ) : McpTypedOpDecision.Steps {
        val calls = ArrayList<String>()
        override fun typedOpsOn(): Boolean { calls.add("typedOps"); return typedOps }
        override fun epochCurrent(): Boolean { calls.add("epoch"); return epoch }
        override fun resolveAgent(agentId: String): JSONObject? { calls.add("agent"); return agent }
        override fun halted(): Boolean { calls.add("halted"); return halted }
        override fun tainted(agentId: String): Boolean { calls.add("tainted"); return tainted }
        override fun actionRule(principal: String, target: String, bind: String): String? = approved
        override fun step7(agent: JSONObject): Decision { calls.add("step7"); return step7 }
        override fun existingTicket(principal: String, requestId: String): McpRunTickets.Ticket? { calls.add("existing"); return existing }
        override fun matchRule(principal: String, target: String, bind: String): String? { calls.add("rule"); return rule }
        override fun rnLive(): Boolean { calls.add("live"); return live }
    }

    private fun request(args: JSONObject = JSONObject().put("agentId", "daily"), tool: String = "run_agent", ageMs: Long = 100L) =
        McpTypedOpDecision.Request("11111111-1111-4111-8111-111111111111", tool, args, principal, now - ageMs)

    private fun refusalCode(o: Outcome): String? = (o as? Outcome.Refuse)?.refusal?.code

    @Test
    fun sealedActionConsentStartsHeadlessWithoutTheConservativePolicySubset() {
        val s = FakeSteps(step7 = Decision.UNDECIDABLE, approved = "r_0123456789abcdef")
        s.agent!!.put("action", JSONObject().put("type", "draft"))
        assertTrue(McpTypedOpDecision.decide(request(), s, now) is Outcome.Execute)
        assertFalse("step7" in s.calls)
        assertFalse("live" in s.calls)
        val changed = FakeSteps(step7 = Decision.UNDECIDABLE, approved = null)
        assertEquals("not_attended", refusalCode(McpTypedOpDecision.decide(request(), changed, now)))
    }

    @Test
    fun actionConsentCannotRescueStoppedOrTaintedAgents() {
        for (s in listOf(FakeSteps(halted = true, approved = "r_0123456789abcdef"), FakeSteps(tainted = true, approved = "r_0123456789abcdef"))) {
            assertTrue(McpTypedOpDecision.decide(request(), s, now) is Outcome.Refuse)
        }
    }

    // ── Decision order ────────────────────────────────────────────────────

    @Test
    fun ruleMatchExecutesAfterEveryCheck() {
        val s = FakeSteps()
        val o = McpTypedOpDecision.decide(request(), s, now)
        assertTrue(o is Outcome.Execute)
        o as Outcome.Execute
        assertEquals("agent:daily", o.target)
        assertEquals("r_0123456789abcdef", o.ruleId)
        assertEquals(McpAgentBinding.bindingHash(s.agent!!), o.bind)
        assertEquals(listOf("typedOps", "epoch", "agent", "halted", "tainted", "step7", "rule"), s.calls)
    }

    @Test
    fun eachDenyClassRefusesWithoutConsultingTheRuleStore() {
        val cases = listOf<Pair<(FakeSteps) -> Unit, String>>(
            Pair({ it.typedOps = false }, "disabled"),
            Pair({ it.epoch = false }, "revoked"),
            Pair({ it.agent = null }, "unknown_agent"),
            Pair({ it.halted = true }, "halted"),
            Pair({ it.tainted = true }, "tainted"),
            Pair({ it.step7 = Decision.POLICY_DENIED }, "policy_denied"),
        )
        for ((setup, code) in cases) {
            // RN live too: a deny is never handed off, and never rescued by a rule.
            val s = FakeSteps(live = true)
            setup(s)
            val o = McpTypedOpDecision.decide(request(), s, now)
            assertEquals(code, code, refusalCode(o))
            assertFalse(code, "rule" in s.calls)
            assertFalse(code, "live" in s.calls)
        }
    }

    @Test
    fun taintRefusalIsAuditedAsIngressTaint() {
        val o = McpTypedOpDecision.decide(request(), FakeSteps(tainted = true), now) as Outcome.Refuse
        assertTrue(o.taint)
        assertEquals("daily", o.agentId)
    }

    @Test
    fun argumentsAreStrictAndCheckedBeforeTheEpoch() {
        val bad = listOf(
            JSONObject().put("agentId", "daily").put("extra", 1),
            JSONObject().put("agentId", "../x"),
            JSONObject(),
            JSONObject().put("agentId", "daily").put("requestId", "short"),
            JSONObject().put("agentId", "daily").put("requestId", 12345678),
        )
        for (args in bad) {
            val s = FakeSteps(epoch = false)
            assertEquals(args.toString(), "invalid_params", refusalCode(McpTypedOpDecision.decide(request(args), s, now)))
            assertEquals(listOf("typedOps"), s.calls)
        }
        assertEquals("invalid_params", refusalCode(McpTypedOpDecision.decide(request(tool = "run_command"), FakeSteps(), now)))
    }

    @Test
    fun undecidableIsNoMatchNeverExecute() {
        val notLive = FakeSteps(step7 = Decision.UNDECIDABLE, live = false)
        assertEquals("not_attended", refusalCode(McpTypedOpDecision.decide(request(), notLive, now)))
        assertFalse("rule" in notLive.calls)
        val live = FakeSteps(step7 = Decision.UNDECIDABLE, live = true)
        assertTrue(McpTypedOpDecision.decide(request(), live, now) is Outcome.Handoff)
        assertFalse("rule" in live.calls)
    }

    @Test
    fun noRuleHandsOffOnlyToALiveRnAndOnlyWhenFresh() {
        assertEquals("not_attended", refusalCode(McpTypedOpDecision.decide(request(), FakeSteps(rule = null, live = false), now)))
        assertTrue(McpTypedOpDecision.decide(request(), FakeSteps(rule = null, live = true), now) is Outcome.Handoff)
        val old = request(ageMs = McpTypedOpDecision.HANDOFF_MAX_AGE_MS + 1)
        assertEquals("not_attended", refusalCode(McpTypedOpDecision.decide(old, FakeSteps(rule = null, live = true), now)))
    }

    @Test
    fun repeatedRequestIdReturnsTheExistingRunBeforeTheRule() {
        val t = McpRunTickets.Ticket("mr_" + "a".repeat(32), principal, "req-12345678", "daily", "running", null, now - 1000, now - 900, null, null, null, null)
        val s = FakeSteps(existing = t, rule = null)
        val o = McpTypedOpDecision.decide(request(JSONObject().put("agentId", "daily").put("requestId", "req-12345678")), s, now)
        assertTrue(o is Outcome.Existing)
        assertFalse("rule" in s.calls)
        // Without a requestId the ticket store is not asked.
        val s2 = FakeSteps()
        McpTypedOpDecision.decide(request(), s2, now)
        assertFalse("existing" in s2.calls)
    }

    // ── Results (the RN bridge's ToolResult JSON) ─────────────────────────

    @Test
    fun resultShapes() {
        val err = JSONObject(McpTypedOpDecision.errorResult(McpTypedOpDecision.NOT_ATTENDED))
        assertEquals(false, err.get("ok"))
        assertEquals("not_attended", err.getString("code"))
        assertEquals(setOf("ok", "error", "code"), err.keys().asSequence().toSet())
        val ok = JSONObject(McpTypedOpDecision.startedResult("mr_" + "b".repeat(32), "daily", null))
        assertEquals(true, ok.get("ok"))
        val data = ok.getJSONObject("data")
        assertEquals(setOf("runHandle", "agentId", "state", "untrusted"), data.keys().asSequence().toSet())
        assertEquals("accepted", data.getString("state"))
        assertEquals(true, data.get("untrusted"))
        val t = McpRunTickets.Ticket("mr_" + "c".repeat(32), principal, "req-12345678", "other", "running", null, now, null, null, null, null, null)
        assertEquals("invalid_params", JSONObject(McpTypedOpDecision.existingResult(t, "daily")).getString("code"))
        val same = JSONObject(McpTypedOpDecision.existingResult(t.copy(agentId = "daily"), "daily")).getJSONObject("data")
        assertEquals(true, same.get("existing"))
    }

    // ── Verification (shared fixture) ─────────────────────────────────────

    @Test
    fun signedRequestFixture() {
        val fixture = McpFixtures.load("mcp-signed-request-cases.json")
        val key = fixture.getString("bridgeKey")
        val cases = fixture.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val req = c.getJSONObject("request")
            val text = req.toString()
            val received = McpTypedOpDecision.parseIsoMs(req.getString("receivedAt"))!!
            val parsed = McpTypedOpDecision.parseRequest(text, req.getString("callId") + ".json", key, received + 1000L) { false }
            val name = c.getString("name")
            if (c.getBoolean("macValid")) {
                assertTrue(name, parsed is Parsed.Ok)
                assertEquals(name, req.getJSONObject("ingress").getString("principal"), (parsed as Parsed.Ok).request.principal)
            } else {
                assertEquals(name, Parsed.Drop("bad_mac"), parsed)
            }
        }
    }

    @Test
    fun handoffTokenFixture() {
        val fixture = McpFixtures.load("mcp-signed-request-cases.json")
        val key = fixture.getString("bridgeKey")
        val tokens = fixture.getJSONArray("handoffTokens")
        for (i in 0 until tokens.length()) {
            val t = tokens.getJSONObject(i)
            assertEquals(t.getString("callId"), t.getString("token"), McpTypedOpDecision.handoffToken(key, t.getString("callId")))
        }
    }

    @Test
    fun verificationOrderAndDrops() {
        val fixture = McpFixtures.load("mcp-signed-request-cases.json")
        val key = fixture.getString("bridgeKey")
        val req = fixture.getJSONArray("cases").getJSONObject(0).getJSONObject("request")
        val text = req.toString()
        val callId = req.getString("callId")
        val received = McpTypedOpDecision.parseIsoMs(req.getString("receivedAt"))!!
        // Wrong file name (a signed body copied under another name).
        assertEquals(Parsed.Drop("bad_request"), McpTypedOpDecision.parseRequest(text, "other.json", key, received) { false })
        // Too old for a typed request (the client gave up after 100 s), or from the future.
        assertEquals(Parsed.Drop("stale"), McpTypedOpDecision.parseRequest(text, "$callId.json", key, received + McpTypedOpDecision.MAX_REQUEST_AGE_MS + 1) { false })
        assertEquals(Parsed.Drop("stale"), McpTypedOpDecision.parseRequest(text, "$callId.json", key, received - McpTypedOpDecision.FUTURE_TOLERANCE_MS - 1) { false })
        // Replay of an accepted callId.
        assertEquals(Parsed.Drop("replay"), McpTypedOpDecision.parseRequest(text, "$callId.json", key, received) { it == callId })
        // The MAC is checked first: a bad MAC is bad_mac even when stale.
        assertEquals(Parsed.Drop("bad_mac"), McpTypedOpDecision.parseRequest(text, "x.json", "b".repeat(64), received + 10_000_000L) { true })
        assertEquals(Parsed.Drop("bad_mac"), McpTypedOpDecision.parseRequest("not json", "$callId.json", key, received) { false })
        assertEquals(Parsed.Drop("no_key"), McpTypedOpDecision.parseRequest(text, "$callId.json", "short", received) { false })
    }

    @Test
    fun isoParsingIsStrict() {
        assertEquals(1_763_208_000_000L, McpTypedOpDecision.parseIsoMs("2025-11-15T12:00:00.000Z"))
        for (bad in listOf("2025-11-15T12:00:00Z", "2025-11-15 12:00:00.000Z", "2025-13-15T12:00:00.000Z", "x", "")) {
            assertEquals(bad, null, McpTypedOpDecision.parseIsoMs(bad))
        }
    }

    // ── Heartbeat and orphans ─────────────────────────────────────────────

    @Test
    fun heartbeat() {
        assertTrue(McpTypedOpDecision.isRnLive((now - 500).toString(), now))
        assertTrue(McpTypedOpDecision.isRnLive("${now - 1999}\n", now))
        assertFalse(McpTypedOpDecision.isRnLive((now - 2000).toString(), now))
        assertTrue(McpTypedOpDecision.isRnLive((now + 1000).toString(), now))
        assertFalse(McpTypedOpDecision.isRnLive((now + 1001).toString(), now))
        for (bad in listOf(null, "", "0", "-5", "12ab", "1.5e12", "${now - 100}x")) {
            assertFalse(bad.toString(), McpTypedOpDecision.isRnLive(bad, now))
        }
    }

    @Test
    fun expiryIsTheClientsWait() {
        assertFalse(McpTypedOpDecision.isExpired(now - 100_000L, now))
        assertTrue(McpTypedOpDecision.isExpired(now - 100_001L, now))
        assertEquals("approval_timeout", McpTypedOpDecision.EXPIRED.code)
    }

    @Test
    fun orphansOnlyPast120s() {
        assertFalse(McpTypedOpDecision.isOrphan(now - 120_000L, now))
        assertTrue(McpTypedOpDecision.isOrphan(now - 120_001L, now))
        assertFalse(McpTypedOpDecision.isOrphan(now - 5_000L, now))
        assertFalse(McpTypedOpDecision.isOrphan(0L, now))
    }
}
