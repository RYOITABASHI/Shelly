package expo.modules.terminalemulator

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * McpInstallOpDecision (background ingress, phase B-2). The ladder cases are
 * the shared fixture __tests__/fixtures/mcp-install-op-ladder-cases.json,
 * which __tests__/mcp-install-op-native-parity.test.ts replays against the
 * real RN handlers: same result JSON and audit code for every refusal before
 * the tap; `handoff` / `not_attended` where RN shows its dialog.
 */
class McpInstallOpDecisionTest {
    private val fixture = McpFixtures.load("mcp-install-op-ladder-cases.json")
    private val principal = fixture.getString("principal")
    private val now = 1_800_000_000_000L

    private class Facts(
        var epoch: Boolean = true,
        var exec: Boolean = true,
        var rnLive: Boolean = true,
    ) : McpInstallOpDecision.Steps {
        val reads = mutableListOf<String>()
        override fun epochCurrent(): Boolean { reads += "epoch"; return epoch }
        override fun execOn(): Boolean { reads += "exec"; return exec }
        override fun rnLive(): Boolean { reads += "rnLive"; return rnLive }
    }

    private fun req(tool: String, args: JSONObject, ageMs: Long = 0) =
        McpTypedOpDecision.Request("c1", tool, args, principal, now - ageMs)

    /** Compare JSON by value (the fixture is pretty-printed). */
    private fun assertJson(name: String, expected: JSONObject, actual: String) {
        assertEquals(name, canonical(expected), canonical(JSONObject(actual)))
    }

    private fun canonical(v: Any?): String = when (v) {
        is JSONObject -> v.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { "$it=${canonical(v.opt(it))}" }
        else -> "${v?.javaClass?.simpleName}:$v"
    }

    @Test
    fun everyLadderCaseGivesTheFixtureOutcome() {
        val ladder = fixture.getJSONArray("ladder")
        assertTrue(ladder.length() >= 80)
        val notAttended = fixture.getJSONObject("notAttended")
        assertEquals(McpInstallOpDecision.NOT_ATTENDED_MESSAGE, notAttended.getString("message"))
        for (i in 0 until ladder.length()) {
            val c = ladder.getJSONObject(i)
            val name = c.getString("name")
            val f = c.getJSONObject("facts")
            val facts = Facts(exec = f.getBoolean("exec"), rnLive = f.getBoolean("rnLive"))
            val out = McpInstallOpDecision.decide(req(c.getString("tool"), c.getJSONObject("args"), f.getLong("ageMs")), facts, now)
            val e = c.getJSONObject("expect")
            when (e.getString("outcome")) {
                "handoff" -> assertEquals(name, McpInstallOpDecision.Outcome.Handoff, out)
                "not_attended" -> {
                    val a = out as? McpInstallOpDecision.Outcome.Answer ?: throw AssertionError("$name: $out")
                    assertEquals(name, "not_attended", a.auditCode)
                    assertJson(name, JSONObject().put("ok", false).put("error", notAttended.getString("message")).put("code", "not_attended"), a.result)
                }
                "answer" -> {
                    val a = out as? McpInstallOpDecision.Outcome.Answer ?: throw AssertionError("$name: $out")
                    assertEquals(name, e.getString("audit"), a.auditCode)
                    assertJson(name, e.getJSONObject("result"), a.result)
                }
                else -> throw AssertionError(name)
            }
        }
    }

    private val delivery = JSONObject()
        .put("stagedPath", "/sdcard/Download/d.js").put("expectedSha256", "ab".repeat(32)).put("expectedBytes", 3)
    private val pipeline = JSONObject()
        .put("stagedPath", "/sdcard/Download/c.json").put("expectedSha256", "ab".repeat(32)).put("expectedBytes", 3)
        .put("rebuild", org.json.JSONArray())

    @Test
    fun epochIsCheckedFirstAndAlone() {
        for (args in listOf(delivery, pipeline)) {
            val tool = if (args === delivery) McpInstallOpDecision.OP_DELIVERY_SCRIPT else McpInstallOpDecision.OP_PIPELINE_CONFIG
            val facts = Facts(epoch = false, exec = false)
            val out = McpInstallOpDecision.decide(req(tool, JSONObject().put("stagedPath", 1)), facts, now) as McpInstallOpDecision.Outcome.Answer
            assertEquals("revoked", out.auditCode)
            assertEquals("{\"ok\":false,\"error\":\"cancelled: pending MCP requests were revoked\",\"code\":\"revoked\"}", out.result)
            assertEquals(listOf("epoch"), facts.reads)
        }
    }

    @Test
    fun readsInRnOrderAndRnLiveOnlyAtTheEnd() {
        val facts = Facts(rnLive = false)
        McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_DELIVERY_SCRIPT, delivery), facts, now)
        assertEquals(listOf("epoch", "exec", "rnLive"), facts.reads)
        val refused = Facts()
        McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_PIPELINE_CONFIG, JSONObject()), refused, now)
        assertEquals(listOf("epoch", "exec"), refused.reads)
        // Past the handoff window RN liveness is not even read.
        val old = Facts()
        McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_PIPELINE_CONFIG, pipeline, 6_000), old, now)
        assertEquals(listOf("epoch", "exec"), old.reads)
    }

    @Test
    fun deadlineBoundaryIsRnsGreaterOrEqual() {
        val at = McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_DELIVERY_SCRIPT, delivery, 15_000), Facts(), now)
        assertEquals("timeout", (at as McpInstallOpDecision.Outcome.Answer).auditCode)
        assertEquals("{\"ok\":true,\"data\":{\"status\":\"timeout\"}}", at.result)
        val before = McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_DELIVERY_SCRIPT, delivery, 14_999), Facts(), now)
        assertEquals("not_attended", (before as McpInstallOpDecision.Outcome.Answer).auditCode)
        // Handoff window boundary: ≤ 5 s.
        assertEquals(McpInstallOpDecision.Outcome.Handoff, McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_DELIVERY_SCRIPT, delivery, 5_000), Facts(), now))
    }

    @Test
    fun numberShapesFollowNumberIsInteger() {
        fun size(v: Any) = McpInstallOpDecision.validate(McpInstallOpDecision.OP_DELIVERY_SCRIPT, JSONObject(delivery.toString()).put("expectedBytes", v))
        assertNull(size(3.0))
        assertNull(size(3L))
        assertNull(size(1_048_576.0))
        assertEquals("invalid_size", size(2.5)?.code)
        assertEquals("invalid_size", size(1_048_577L)?.code)
        // Parsed from JSON text as RN parses it.
        assertNull(McpInstallOpDecision.validate(McpInstallOpDecision.OP_DELIVERY_SCRIPT,
            JSONObject("{\"stagedPath\":\"/sdcard/Download/d.js\",\"expectedSha256\":\"${"ab".repeat(32)}\",\"expectedBytes\":1e3}")))
    }

    @Test
    fun afterAuditMatchesRnRefuse() {
        val refusal = McpInstallOpDecision.Outcome.Answer("invalid_path", McpInstallOpDecision.errorResult(McpInstallOpDecision.Refusal("invalid_path", "x")))
        // Epoch still current: unchanged, no extra line.
        assertEquals(null to refusal.result, McpInstallOpDecision.afterAudit(McpInstallOpDecision.OP_DELIVERY_SCRIPT, refusal, true))
        // Ended meanwhile: delivery writes a second `revoked` line (refuse → revoked()); the config does not.
        assertEquals("revoked" to McpInstallOpDecision.revokedResult(), McpInstallOpDecision.afterAudit(McpInstallOpDecision.OP_DELIVERY_SCRIPT, refusal, false))
        assertEquals(null to McpInstallOpDecision.revokedResult(), McpInstallOpDecision.afterAudit(McpInstallOpDecision.OP_PIPELINE_CONFIG, refusal, false))
        val revoked = McpInstallOpDecision.Outcome.Answer("revoked", McpInstallOpDecision.revokedResult())
        assertEquals(null to revoked.result, McpInstallOpDecision.afterAudit(McpInstallOpDecision.OP_DELIVERY_SCRIPT, revoked, false))
    }

    @Test
    fun auditLineIsRnsShapeAndPassesTheWriter() {
        for (tool in McpInstallOpDecision.OPS) {
            for (code in listOf("invalid_path", "not_attended", "handed_off", "handoff_failed", "timeout", "revoked")) {
                val json = McpInstallOpDecision.auditJson(tool, principal, code)
                val kind = McpInstallOpDecision.auditKind(tool)
                assertEquals("{\"kind\":\"$kind\",\"event\":\"$kind\",\"principal\":\"$principal\",\"code\":\"$code\"}", json)
                val line = IngressAuditWriter.buildMcpLine(now, null, json) ?: throw AssertionError("$tool $code refused by the writer")
                val o = JSONObject(line)
                assertEquals(kind, o.getString("kind"))
                assertEquals(code, o.getString("code"))
            }
        }
    }
}
