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

    /** The fixture models the foreground step as unavailable (phone locked) unless a test says otherwise. */
    private class Facts(
        var epoch: Boolean = true,
        var exec: Boolean = true,
        var rnLive: Boolean = true,
        var blocker: String? = McpInstallOpDecision.FG_LOCKED,
    ) : McpInstallOpDecision.Steps {
        val reads = mutableListOf<String>()
        override fun epochCurrent(): Boolean { reads += "epoch"; return epoch }
        override fun execOn(): Boolean { reads += "exec"; return exec }
        override fun rnLive(): Boolean { reads += "rnLive"; return rnLive }
        override fun foregroundBlocker(): String? { reads += "foreground"; return blocker }
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
        assertTrue(ladder.length() >= 130)
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
                    // RN paused: the foreground step was refused (locked); RN live but stale: not tried.
                    assertEquals(name, if (f.getBoolean("rnLive")) null else McpInstallOpDecision.FG_LOCKED, a.foregroundFailure)
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
        assertEquals(listOf("epoch", "exec", "rnLive", "foreground"), facts.reads)
        val refused = Facts()
        McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_PIPELINE_CONFIG, JSONObject()), refused, now)
        assertEquals(listOf("epoch", "exec"), refused.reads)
        // Past the handoff window with RN live: not_attended, the foreground preconditions are not read.
        val old = Facts()
        McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_PIPELINE_CONFIG, pipeline, 6_000), old, now)
        assertEquals(listOf("epoch", "exec", "rnLive"), old.reads)
        // stage_install: RN's order (exec, arguments, then the epoch).
        val stage = Facts(rnLive = false)
        McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_STAGE_INSTALL, apk), stage, now)
        assertEquals(listOf("exec", "epoch", "rnLive", "foreground"), stage.reads)
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
            for (code in listOf("invalid_path", "not_attended", "handed_off", "handoff_failed", "timeout", "revoked", "foregrounded")) {
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

    // -- stage_install --

    private val apk = JSONObject().put("path", "/storage/emulated/0/Download/a.apk")

    @Test
    fun stageInstallReadsTheEpochAfterItsArgumentsAndRefusesWithoutCode() {
        // Exec off and an invalid path both win over an ended epoch (RN reads it after resolving).
        val off = McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_STAGE_INSTALL, JSONObject()), Facts(epoch = false, exec = false), now)
            as McpInstallOpDecision.Outcome.Answer
        assertEquals("disabled", off.auditCode)
        assertEquals("{\"ok\":false,\"error\":\"${McpInstallOpDecision.EXEC_DISABLED_ERROR}\"}", off.result)
        val badPath = McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_STAGE_INSTALL, JSONObject()), Facts(epoch = false), now)
            as McpInstallOpDecision.Outcome.Answer
        assertEquals("invalid_path", badPath.auditCode)
        assertEquals("{\"ok\":false,\"error\":\"${McpInstallOpDecision.APK_PATH_ERROR}\"}", badPath.result)
        val revoked = McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_STAGE_INSTALL, apk), Facts(epoch = false), now)
            as McpInstallOpDecision.Outcome.Answer
        assertEquals("revoked", revoked.auditCode)
        assertEquals(McpInstallOpDecision.revokedResult(), revoked.result)
        // not_attended (native only) carries its code.
        val na = McpInstallOpDecision.decide(req(McpInstallOpDecision.OP_STAGE_INSTALL, apk), Facts(rnLive = false), now)
            as McpInstallOpDecision.Outcome.Answer
        assertEquals("{\"ok\":false,\"error\":\"${McpInstallOpDecision.NOT_ATTENDED_MESSAGE}\",\"code\":\"not_attended\"}", na.result)
        // Its refuse() never re-reads the epoch: no extra line, no rewrite.
        assertEquals(null to badPath.result, McpInstallOpDecision.afterAudit(McpInstallOpDecision.OP_STAGE_INSTALL, badPath, false))
        assertEquals("mcp_stage_install", McpInstallOpDecision.auditKind(McpInstallOpDecision.OP_STAGE_INSTALL))
    }

    // -- Foreground for approval --

    private fun fg(tool: String = McpInstallOpDecision.OP_DELIVERY_SCRIPT, args: JSONObject = delivery, ageMs: Long = 0, facts: Facts = Facts(rnLive = false, blocker = null)) =
        McpInstallOpDecision.decide(req(tool, args, ageMs), facts, now)

    @Test
    fun rnPausedAndPreconditionsHoldBringsShellyForwardForEveryOp() {
        for ((tool, args) in listOf(
            McpInstallOpDecision.OP_DELIVERY_SCRIPT to delivery,
            McpInstallOpDecision.OP_PIPELINE_CONFIG to pipeline,
            McpInstallOpDecision.OP_STAGE_INSTALL to apk,
        )) {
            // Fresh request: the deadline cap (receipt + 15 s - 3 s) is earlier than now + 15 s.
            assertEquals(tool, McpInstallOpDecision.Outcome.Foreground(now + 12_000), fg(tool, args))
        }
    }

    @Test
    fun preconditionFailuresStayNotAttendedWithTheReason() {
        for (reason in listOf(McpInstallOpDecision.FG_LOCKED, McpInstallOpDecision.FG_NO_OVERLAY)) {
            val out = fg(facts = Facts(rnLive = false, blocker = reason)) as McpInstallOpDecision.Outcome.Answer
            assertEquals("not_attended", out.auditCode)
            assertEquals(reason, out.foregroundFailure)
            assertEquals(McpInstallOpDecision.errorResult(McpInstallOpDecision.Refusal("not_attended", McpInstallOpDecision.NOT_ATTENDED_MESSAGE)), out.result)
        }
    }

    @Test
    fun noTimeLeftBeforeTheMarginIsNotAttendedWithoutReadingThePreconditions() {
        val facts = Facts(rnLive = false, blocker = null)
        // 12 s old: receipt + 15 s - 3 s = now, nothing to wait for (but not yet expired).
        val out = fg(ageMs = 12_000, facts = facts) as McpInstallOpDecision.Outcome.Answer
        assertEquals("not_attended", out.auditCode)
        assertEquals(McpInstallOpDecision.FG_NO_TIME, out.foregroundFailure)
        assertEquals(listOf("epoch", "exec", "rnLive"), facts.reads)
        // 11.999 s old: 1 ms to wait.
        assertEquals(McpInstallOpDecision.Outcome.Foreground(now + 1), fg(ageMs = 11_999))
        // A stale request (6 s) while RN is paused is still brought forward: the RN-live rule applies later.
        assertEquals(McpInstallOpDecision.Outcome.Foreground(now + 6_000), fg(ageMs = 6_000))
    }

    @Test
    fun rnLiveKeepsTheGeneralFreshnessRule() {
        // RN live: no foreground step at all, the ≤ 5 s rule from receipt as before.
        assertEquals(McpInstallOpDecision.Outcome.Handoff, fg(facts = Facts(blocker = null)))
        val stale = fg(ageMs = 5_001, facts = Facts(blocker = null)) as McpInstallOpDecision.Outcome.Answer
        assertEquals("not_attended", stale.auditCode)
        assertNull(stale.foregroundFailure)
    }

    @Test
    fun waitEndsAtTheEarlierOfFifteenSecondsAndTheDeadlineMinusTheMargin() {
        assertEquals(now + 12_000, McpInstallOpDecision.foregroundWaitUntil(now, now))
        // A receipt in the "future" (clock skew) cannot stretch the wait past 15 s.
        assertEquals(now + 15_000, McpInstallOpDecision.foregroundWaitUntil(now + 10_000, now))
        assertEquals(now + 2_000, McpInstallOpDecision.foregroundWaitUntil(now - 10_000, now))
    }

    private fun poll(ageMs: Long, waitUntil: Long, rnLiveSince: Long?, facts: Facts = Facts(rnLive = false, blocker = null), tool: String = McpInstallOpDecision.OP_DELIVERY_SCRIPT) =
        McpInstallOpDecision.afterForeground(req(tool, delivery, ageMs), facts, now, waitUntil, rnLiveSince)

    @Test
    fun afterForegroundWaitsThenHandsOffMeasuringFreshnessFromRnLive() {
        assertEquals(McpInstallOpDecision.Outcome.Wait, poll(2_000, now + 10_000, null))
        // The request is 10 s old (past the general 5 s rule), RN came up just now: hand off.
        assertEquals(McpInstallOpDecision.Outcome.Handoff, poll(10_000, now + 2_000, now))
        // Boundary: ≤ 5 s since RN became live.
        assertEquals(McpInstallOpDecision.Outcome.Handoff, poll(10_000, now + 2_000, now - 5_000))
        val late = poll(10_000, now + 2_000, now - 5_001) as McpInstallOpDecision.Outcome.Answer
        assertEquals("not_attended", late.auditCode)
        assertEquals(McpInstallOpDecision.FG_HANDOFF_WINDOW, late.foregroundFailure)
        // RN live seen after the wait's end but before the deadline: still handed off.
        assertEquals(McpInstallOpDecision.Outcome.Handoff, poll(13_000, now - 1_000, now))
    }

    @Test
    fun afterForegroundGivesUpAtTheWaitEndOrTheDeadline() {
        val end = poll(12_000, now, null) as McpInstallOpDecision.Outcome.Answer
        assertEquals("not_attended", end.auditCode)
        assertEquals(McpInstallOpDecision.FG_RN_NOT_LIVE, end.foregroundFailure)
        assertEquals(McpInstallOpDecision.Outcome.Wait, poll(11_999, now + 1, null))
        // Past the pre-approval deadline (a stalled worker): RN's timeout, even if RN came up.
        for (since in listOf(null, now)) {
            val expired = poll(15_000, now + 1_000, since) as McpInstallOpDecision.Outcome.Answer
            assertEquals("timeout", expired.auditCode)
            assertEquals("{\"ok\":true,\"data\":{\"status\":\"timeout\"}}", expired.result)
            assertEquals(McpInstallOpDecision.FG_RN_NOT_LIVE, expired.foregroundFailure)
        }
        val cfg = poll(15_000, now + 1_000, null, tool = McpInstallOpDecision.OP_PIPELINE_CONFIG) as McpInstallOpDecision.Outcome.Answer
        assertEquals(McpInstallOpDecision.timeoutResult(McpInstallOpDecision.OP_PIPELINE_CONFIG), cfg.result)
        // The epoch ended while waiting: revoked, nothing else read.
        val facts = Facts(epoch = false, rnLive = false, blocker = null)
        val revoked = poll(1_000, now + 10_000, now, facts) as McpInstallOpDecision.Outcome.Answer
        assertEquals("revoked", revoked.auditCode)
        assertEquals(listOf("epoch"), facts.reads)
    }

    @Test
    fun foregroundAuditLinesPassTheWriterAndReasonOnlyOnForegroundFailed() {
        for (tool in McpInstallOpDecision.OPS) {
            for (reason in listOf(
                McpInstallOpDecision.FG_LOCKED, McpInstallOpDecision.FG_NO_OVERLAY, McpInstallOpDecision.FG_START_FAILED,
                McpInstallOpDecision.FG_RN_NOT_LIVE, McpInstallOpDecision.FG_NO_TIME, McpInstallOpDecision.FG_HANDOFF_WINDOW,
            )) {
                val json = McpInstallOpDecision.auditJson(tool, principal, "foreground_failed", reason)
                val line = IngressAuditWriter.buildMcpLine(now, null, json) ?: throw AssertionError("$tool $reason refused by the writer")
                val o = JSONObject(line)
                assertEquals("foreground_failed", o.getString("code"))
                assertEquals(reason, o.getString("reason"))
            }
            assertNull(IngressAuditWriter.buildMcpLine(now, null, McpInstallOpDecision.auditJson(tool, principal, "not_attended", "locked")))
            assertNull(IngressAuditWriter.buildMcpLine(now, null, McpInstallOpDecision.auditJson(tool, principal, "foreground_failed", "Bad Reason")))
        }
    }
}
