package expo.modules.terminalemulator

import java.security.MessageDigest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ServiceControlDecision (background ingress, phase A). The ladder cases are
 * the shared fixture __tests__/fixtures/mcp-service-control-ladder-cases.json,
 * which __tests__/mcp-service-control-native-parity.test.ts replays against
 * the real RN ladder: same outcome, code, message and first audit line.
 */
class ServiceControlDecisionTest {
    private val fixture = McpFixtures.load("mcp-service-control-ladder-cases.json")
    private val principal = fixture.getString("principal")
    private val now = 1_800_000_000_000L

    private fun sha(s: String) = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    private inner class Facts(
        var epoch: Boolean = true,
        var exec: Boolean = true,
        var typedOps: Boolean = true,
        var halted: Boolean = false,
        /** target -> bind of the one stored rule (id r1), or null. */
        var rule: Pair<String, String>? = null,
        var approveAll: Boolean = false,
        var rnLive: Boolean = true,
    ) : ServiceControlDecision.Steps {
        val reads = mutableListOf<String>()
        override fun epochCurrent(): Boolean { reads += "epoch"; return epoch }
        override fun execOn(): Boolean { reads += "exec"; return exec }
        override fun typedOpsOn(): Boolean { reads += "typedOps"; return typedOps }
        override fun halted(): Boolean { reads += "halted"; return halted }
        override fun matchRule(principal: String, op: String, target: String, bind: String): String? {
            reads += "rule"
            val r = rule ?: return null
            return if (principal == this@ServiceControlDecisionTest.principal && r.first == target && r.second == bind) "r1" else null
        }
        override fun approveAllOn(): Boolean { reads += "approveAll"; return approveAll }
        override fun rnLive(): Boolean { reads += "rnLive"; return rnLive }
    }

    private fun req(tool: String, args: JSONObject, ageMs: Long = 0) =
        McpTypedOpDecision.Request("c1", tool, args, principal, now - ageMs)

    @Test
    fun bindsMatchTheTsDerivation() {
        val binds = fixture.getJSONArray("binds")
        assertTrue(binds.length() >= 9)
        for (i in 0 until binds.length()) {
            val b = binds.getJSONObject(i)
            val a = ServiceControlDecision.validate(b.getString("tool"), b.getJSONObject("args")) as ServiceControlDecision.Args
            assertEquals(b.getString("target"), a.target)
            assertEquals(b.getString("bind"), ServiceControlDecision.ruleBind(a))
        }
    }

    @Test
    fun everyLadderCaseGivesTheFixtureOutcome() {
        val ladder = fixture.getJSONArray("ladder")
        assertTrue(ladder.length() >= 20)
        for (i in 0 until ladder.length()) {
            val c = ladder.getJSONObject(i)
            val name = c.getString("name")
            val tool = c.getString("tool")
            val args = c.getJSONObject("args")
            val f = c.getJSONObject("facts")
            val parsed = ServiceControlDecision.validate(tool, args)
            val target = (parsed as? ServiceControlDecision.Args)?.target
            val rule = when (if (f.isNull("rule")) null else f.getString("rule")) {
                "current" -> target?.let { it to ServiceControlDecision.ruleBind(parsed as ServiceControlDecision.Args) }
                "stale" -> target?.let { it to sha("stale:$it") }
                else -> null
            }
            val facts = Facts(
                exec = f.getBoolean("exec"), typedOps = f.getBoolean("typedOps"), halted = f.getBoolean("halted"),
                rule = rule, approveAll = f.getBoolean("approveAll"), rnLive = f.getBoolean("rnLive"),
            )
            val out = ServiceControlDecision.decide(req(tool, args, f.getLong("ageMs")), facts, now)
            val e = c.getJSONObject("expect")
            when (e.getString("outcome")) {
                "refuse" -> {
                    assertTrue(name, out is ServiceControlDecision.Outcome.Refuse)
                    out as ServiceControlDecision.Outcome.Refuse
                    assertEquals(name, e.getString("code"), out.refusal.code)
                    assertEquals(name, e.getString("message"), out.refusal.message)
                    val audit = e.getJSONArray("audit")
                    assertTrue(name, out.audit)
                    assertEquals(name, audit.getString(0), out.refusal.code)
                    assertEquals(name, audit.getBoolean(1), out.args != null)
                    // The result RN writes, byte for byte the same fields.
                    val r = JSONObject(ServiceControlDecision.errorResult(out.refusal))
                    assertEquals(false, r.getBoolean("ok"))
                    assertEquals(e.getString("message"), r.getString("error"))
                    assertEquals(e.getString("code"), r.getString("code"))
                }
                "execute" -> {
                    assertTrue(name, out is ServiceControlDecision.Outcome.Execute)
                    assertEquals(name, e.getJSONArray("audit").getString(0), (out as ServiceControlDecision.Outcome.Execute).auditCode)
                }
                "handoff" -> assertTrue(name, out is ServiceControlDecision.Outcome.Handoff)
                else -> throw AssertionError(name)
            }
        }
    }

    private val start = JSONObject().put("action", "start").put("serviceId", "article-delivery")

    @Test
    fun ladderOrderIsRns() {
        val f = Facts(rnLive = false)
        ServiceControlDecision.decide(req("service_control", start), f, now)
        assertEquals(listOf("epoch", "exec", "halted", "rule", "approveAll"), f.reads.take(5))
        val g = Facts(rnLive = false)
        ServiceControlDecision.decide(req("request_pipeline_refire", JSONObject().put("pipelineId", "devja")), g, now)
        assertEquals(listOf("epoch", "typedOps", "halted", "rule", "approveAll"), g.reads.take(5))
        // status never reads STOP-ALL before the rule.
        val s = Facts(rnLive = false)
        ServiceControlDecision.decide(req("service_control", JSONObject().put("action", "status").put("serviceId", "article-delivery")), s, now)
        assertFalse("halted" in s.reads)
    }

    @Test
    fun epochEndedIsRevoked() {
        val out = ServiceControlDecision.decide(req("service_control", start), Facts(epoch = false, exec = false), now) as ServiceControlDecision.Outcome.Refuse
        assertEquals("revoked", out.refusal.code)
        assertTrue(out.audit)
        // Unchecked arguments with the epoch gone: RN answers revoked without a line.
        val bad = ServiceControlDecision.decide(req("service_control", JSONObject().put("action", "x")), Facts(epoch = false), now) as ServiceControlDecision.Outcome.Refuse
        assertEquals("revoked", bad.refusal.code)
        assertFalse(bad.audit)
    }

    @Test
    fun aStaleNoMatchIsNotHandedOff() {
        // RN live but the request older than the handoff window: answered here.
        val out = ServiceControlDecision.decide(req("service_control", start, ageMs = 6_000), Facts(), now)
        assertEquals("not_attended", (out as ServiceControlDecision.Outcome.Refuse).refusal.code)
        assertTrue(ServiceControlDecision.decide(req("service_control", start, ageMs = 5_000), Facts(), now) is ServiceControlDecision.Outcome.Handoff)
    }

    @Test
    fun recheckFollowsRnsExecuteOrder() {
        val a = ServiceControlDecision.validate("service_control", start) as ServiceControlDecision.Args
        val bind = ServiceControlDecision.ruleBind(a)
        val x = ServiceControlDecision.Outcome.Execute(a, ServiceControlDecision.Via.RULE, "r1", bind, "always_allowed")
        val ok = Facts(rule = a.target to bind)
        assertNull(ServiceControlDecision.recheck(req("service_control", start), x, ok, now))
        // Rule gone first, even when everything else changed too.
        val gone = Facts(rule = null, exec = false, halted = true, epoch = false)
        assertEquals("target_changed", ServiceControlDecision.recheck(req("service_control", start), x, gone, now)!!.code)
        assertEquals(ServiceControlDecision.SERVICE_RULE_GONE, ServiceControlDecision.recheck(req("service_control", start), x, gone, now)!!.message)
        assertEquals("disabled", ServiceControlDecision.recheck(req("service_control", start), x, Facts(rule = a.target to bind, exec = false, halted = true), now)!!.code)
        assertEquals("halted", ServiceControlDecision.recheck(req("service_control", start), x, Facts(rule = a.target to bind, halted = true, epoch = false), now)!!.code)
        assertEquals("revoked", ServiceControlDecision.recheck(req("service_control", start), x, Facts(rule = a.target to bind, epoch = false), now)!!.code)
        val late = ServiceControlDecision.recheck(req("service_control", start, ageMs = 100_000), x, Facts(rule = a.target to bind), now)!!
        assertEquals("timeout", late.code)
        assertEquals("the request expired before it could run", late.message)
        // The switch path does not re-match a rule.
        val sw = x.copy(via = ServiceControlDecision.Via.SWITCH, ruleId = null, auditCode = "auto_approved")
        assertNull(ServiceControlDecision.recheck(req("service_control", start), sw, Facts(rule = null), now))
        // A re-fire re-checks typed ops and STOP-ALL, never exec.
        val p = ServiceControlDecision.validate("request_pipeline_refire", JSONObject().put("pipelineId", "devja")) as ServiceControlDecision.Args
        val px = ServiceControlDecision.Outcome.Execute(p, ServiceControlDecision.Via.SWITCH, null, ServiceControlDecision.ruleBind(p), "auto_approved")
        val pr = req("request_pipeline_refire", JSONObject().put("pipelineId", "devja"))
        assertNull(ServiceControlDecision.recheck(pr, px, Facts(exec = false), now))
        assertEquals("disabled", ServiceControlDecision.recheck(pr, px, Facts(typedOps = false), now)!!.code)
        assertEquals("halted", ServiceControlDecision.recheck(pr, px, Facts(halted = true), now)!!.code)
        assertEquals(ServiceControlDecision.REFIRE_RULE_GONE, ServiceControlDecision.recheck(pr, px.copy(via = ServiceControlDecision.Via.RULE, ruleId = "r1"), Facts(), now)!!.message)
    }

    private fun nativeMap(over: Map<String, Any?> = emptyMap()): Map<String, Any?> = mapOf(
        "code" to "status", "serviceId" to "article-delivery", "state" to "running", "pid" to 6293,
        "startedAt" to 1_764_000_000_000L, "lastHeartbeatAt" to 1_764_000_100_000L, "supervised" to true,
        "exitCode" to null, "exitedAt" to null,
    ) + over

    @Test
    fun serviceResultIsRnsJson() {
        val st = ServiceControlDecision.parseServiceResult(nativeMap(), "article-delivery")!!
        assertEquals(
            """{"ok":true,"data":{"action":"status","code":"status","serviceId":"article-delivery","state":"running","pid":6293,"startedAt":1764000000000,"lastHeartbeatAt":1764000100000,"supervised":true}}""",
            ServiceControlDecision.serviceResult("status", st),
        )
        val dead = ServiceControlDecision.parseServiceResult(
            nativeMap(mapOf("code" to "launch_failed", "state" to "dead", "pid" to null, "exitCode" to 1, "exitedAt" to 1_764_000_200_000L, "supervised" to false)),
            "article-delivery",
        )!!
        assertEquals(
            """{"ok":false,"error":"start article-delivery: launch_failed {\"serviceId\":\"article-delivery\",\"state\":\"dead\",\"pid\":null,\"startedAt\":1764000000000,\"lastHeartbeatAt\":1764000100000,\"supervised\":false,\"exitCode\":1,\"exitedAt\":1764000200000}","code":"launch_failed"}""",
            ServiceControlDecision.serviceResult("start", dead),
        )
    }

    @Test
    fun serviceResultParsingIsStrict() {
        val p = { over: Map<String, Any?> -> ServiceControlDecision.parseServiceResult(nativeMap(over), "article-delivery") }
        assertNull(p(mapOf("code" to "exploded")))
        assertNull(p(mapOf("serviceId" to "council-facade")))
        assertNull(p(mapOf("state" to "zombie")))
        assertNull(p(mapOf("pid" to 1)))
        assertNull(p(mapOf("pid" to "6293")))
        assertNull(p(mapOf("startedAt" to -1L)))
        assertNull(p(mapOf("lastHeartbeatAt" to 9_007_199_254_740_992L)))
        assertNull(p(mapOf("supervised" to "true")))
        assertNull(p(mapOf("exitCode" to 1.5)))
        assertNull(ServiceControlDecision.parseServiceResult(null, "article-delivery"))
    }

    @Test
    fun refireResultsAreRns() {
        val a = ServiceControlDecision.parseRefireResult("accepted", "rq-1795555200867-0a1b2c3d")!!
        assertEquals(
            """{"ok":true,"data":{"pipelineId":"devja","code":"accepted","requestId":"rq-1795555200867-0a1b2c3d"}}""",
            ServiceControlDecision.refireResult("devja", a),
        )
        assertEquals(
            """{"ok":true,"data":{"pipelineId":"devja","code":"duplicate","requestId":null}}""",
            ServiceControlDecision.refireResult("devja", ServiceControlDecision.parseRefireResult("duplicate", null)!!),
        )
        assertNull(ServiceControlDecision.parseRefireResult("nope", null))
        assertNull(ServiceControlDecision.parseRefireResult("accepted", "rq-x"))
        assertFalse(ServiceControlDecision.isRefireAccepted("daily_limit"))
        assertEquals("re-run of devja refused: daily_limit", ServiceControlDecision.refireRefusal("devja", "daily_limit").message)
    }
}
