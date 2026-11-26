package expo.modules.terminalemulator

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The pure half of IngressAuditWriter: the MCP typed-op audit line is rebuilt
 * from a closed set of short fields, never copied. The file append needs a
 * device. Like McpRunTicketsTest, not compiled on the VM this was written on.
 */
class IngressAuditWriterTest {
    private val p = "0123456789abcdef0123456789abcdef"
    private val committedSha256 = "a".repeat(64)
    private val previousSha256 = "b".repeat(64)
    private val ts = 1_731_650_000_000L

    private fun json(vararg kv: Pair<String, Any>): String {
        val o = JSONObject()
        for ((k, v) in kv) o.put(k, v)
        return o.toString()
    }

    @Test
    fun buildsTheFixedLine() {
        val line = IngressAuditWriter.buildMcpLine(
            ts, "daily",
            json("kind" to "ingress_tainted_refused", "event" to "mcp_run_agent", "agentId" to "daily", "principal" to p, "code" to "tainted"),
        )
        assertNotNull(line)
        val o = JSONObject(line!!)
        assertEquals("ingress_tainted_refused", o.getString("kind"))
        assertEquals("mcp_run_agent", o.getString("event"))
        assertEquals("daily", o.getString("agentId"))
        assertEquals(p, o.getString("principal"))
        assertEquals("tainted", o.getString("code"))
        assertEquals("2024-11-15T05:53:20.000Z", o.getString("ts"))
        assertFalse(line.contains("\n"))
    }

    @Test
    fun agentlessLineHasNoAgentId() {
        val line = IngressAuditWriter.buildMcpLine(ts, null, json("kind" to "mcp_typed_op_refused", "event" to "mcp_run_agent", "code" to "not_attended"))
        assertNotNull(line)
        assertFalse(JSONObject(line!!).has("agentId"))
    }

    @Test
    fun buildsTheAgentlessDeliveryScriptLine() {
        val line = IngressAuditWriter.buildMcpLine(
            ts, null,
            json("kind" to "mcp_update_delivery_script", "event" to "mcp_update_delivery_script", "principal" to p, "code" to "updated"),
        )
        assertNotNull(line)
        val o = JSONObject(line!!)
        assertEquals("mcp_update_delivery_script", o.getString("kind"))
        assertEquals("mcp_update_delivery_script", o.getString("event"))
        assertEquals(p, o.getString("principal"))
        assertEquals("updated", o.getString("code"))
        assertEquals("2024-11-15T05:53:20.000Z", o.getString("ts"))
        assertFalse(o.has("agentId"))
        assertFalse(line.contains("\n"))
    }

    @Test
    fun buildsTheAgentlessPipelineConfigLine() {
        val line = IngressAuditWriter.buildMcpLine(
            ts, null,
            json("kind" to "mcp_update_pipeline_config", "event" to "mcp_update_pipeline_config", "principal" to p, "code" to "updated"),
        )
        assertNotNull(line)
        val o = JSONObject(line!!)
        assertEquals("mcp_update_pipeline_config", o.getString("kind"))
        assertEquals("mcp_update_pipeline_config", o.getString("event"))
        assertEquals(p, o.getString("principal"))
        assertEquals("updated", o.getString("code"))
        assertEquals("2024-11-15T05:53:20.000Z", o.getString("ts"))
        assertFalse(o.has("agentId"))
        assertFalse(line.contains("\n"))
    }

    @Test
    fun pipelineConfigAuditAcceptsOnlyFixedCountsAndPipelineIds() {
        val kind = "mcp_update_pipeline_config"
        val valid = json(
            "kind" to kind, "event" to kind, "principal" to p, "code" to "updated", "swapStatus" to "updated",
            "changedPipelineIds" to org.json.JSONArray(listOf("example-a", "digest")),
            "rebuiltCount" to 1, "rebuildFailedCount" to 0,
            "sha256" to committedSha256, "bytes" to 1,
            "backupCreated" to true, "previousSha256" to previousSha256,
        )
        val line = IngressAuditWriter.buildMcpLine(ts, null, valid)
        assertNotNull(line)
        val output = JSONObject(line!!)
        assertEquals("example-a", output.getJSONArray("changedPipelineIds").getString(0))
        assertEquals(1, output.getInt("rebuiltCount"))
        assertEquals(0, output.getInt("rebuildFailedCount"))
        assertEquals(committedSha256, output.getString("sha256"))
        assertEquals(1, output.getInt("bytes"))
        assertEquals(true, output.getBoolean("backupCreated"))
        assertEquals(previousSha256, output.getString("previousSha256"))
        for ((key, invalid) in listOf(
            "sha256" to "A".repeat(64),
            "bytes" to 0, "bytes" to 262145, "bytes" to 1.5,
            "backupCreated" to "true",
            "previousSha256" to "b".repeat(63), "previousSha256" to JSONObject.NULL,
        )) {
            assertNull(IngressAuditWriter.buildMcpLine(ts, null, JSONObject(valid).put(key, invalid).toString()))
        }
        for (key in listOf("sha256", "bytes", "backupCreated", "previousSha256")) {
            val missing = JSONObject(valid).apply { remove(key) }
            assertNull(IngressAuditWriter.buildMcpLine(ts, null, missing.toString()))
        }
        val created = JSONObject(valid).put("code", "created").put("swapStatus", "created")
            .put("backupCreated", false)
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, created.toString()))
        created.remove("previousSha256")
        val createdLine = IngressAuditWriter.buildMcpLine(ts, null, created.toString())
        assertNotNull(createdLine)
        val createdOutput = JSONObject(createdLine!!)
        assertEquals(committedSha256, createdOutput.getString("sha256"))
        assertEquals(1, createdOutput.getInt("bytes"))
        assertFalse(createdOutput.getBoolean("backupCreated"))
        assertFalse(createdOutput.has("previousSha256"))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, valid.replace("example-a", "/sdcard/path")))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, JSONObject(valid).put("content", "secret").toString()))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, JSONObject(valid).put("rebuiltCount", -1).toString()))
        assertNull(IngressAuditWriter.buildMcpLine(ts, "agent-a", valid))
    }

    @Test
    fun pipelineConfigRevocationCanRecordCommittedWork() {
        val kind = "mcp_update_pipeline_config"
        val revoked = JSONObject(json("kind" to kind, "event" to kind, "principal" to p, "code" to "revoked"))
        assertNotNull(IngressAuditWriter.buildMcpLine(ts, null, revoked.toString()))
        revoked.put("changedPipelineIds", org.json.JSONArray(listOf("example-a")))
            .put("rebuiltCount", 1).put("rebuildFailedCount", 2)
            .put("sha256", committedSha256).put("bytes", 1)
            .put("backupCreated", true).put("previousSha256", previousSha256).put("swapStatus", "updated")
        val line = IngressAuditWriter.buildMcpLine(ts, null, revoked.toString())
        assertNotNull(line)
        val output = JSONObject(line!!)
        assertEquals("revoked", output.getString("code"))
        assertEquals(committedSha256, output.getString("sha256"))
        assertEquals(1, output.getInt("bytes"))
        assertEquals(true, output.getBoolean("backupCreated"))
        assertEquals(previousSha256, output.getString("previousSha256"))
        assertEquals("example-a", output.getJSONArray("changedPipelineIds").getString(0))
        assertEquals(1, output.getInt("rebuiltCount"))
        assertEquals(2, output.getInt("rebuildFailedCount"))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, revoked.toString().replace("example-a", "/sdcard/path")))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, JSONObject(revoked.toString()).put("rebuildFailedCount", -1).toString()))
        revoked.remove("rebuiltCount")
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, revoked.toString()))
    }

    @Test
    fun pipelineConfigTimeoutCanRecordCommittedWork() {
        val kind = "mcp_update_pipeline_config"
        val input = json(
            "kind" to kind, "event" to kind, "code" to "timeout",
            "changedPipelineIds" to org.json.JSONArray(listOf("example-a")),
            "rebuiltCount" to 1, "rebuildFailedCount" to 2,
            "sha256" to committedSha256, "bytes" to 262144,
            "backupCreated" to true, "previousSha256" to previousSha256,
            "rebuiltAgentIds" to org.json.JSONArray(listOf("agent-1")),
            "failedAgentIds" to org.json.JSONArray(listOf("agent-2", "agent_3")),
            "swapStatus" to "updated",
            "failedReasonCodes" to org.json.JSONArray(listOf("timeout", "revoked")),
        )
        val line = IngressAuditWriter.buildMcpLine(ts, null, input)
        assertNotNull(line)
        val output = JSONObject(line!!)
        assertEquals("timeout", output.getString("code"))
        assertEquals(committedSha256, output.getString("sha256"))
        assertEquals(262144, output.getInt("bytes"))
        assertEquals(true, output.getBoolean("backupCreated"))
        assertEquals(previousSha256, output.getString("previousSha256"))
        assertEquals("example-a", output.getJSONArray("changedPipelineIds").getString(0))
        assertEquals(1, output.getInt("rebuiltCount"))
        assertEquals(2, output.getInt("rebuildFailedCount"))
        assertEquals(org.json.JSONArray(listOf("agent-1")).toString(), output.getJSONArray("rebuiltAgentIds").toString())
        assertEquals(org.json.JSONArray(listOf("agent-2", "agent_3")).toString(), output.getJSONArray("failedAgentIds").toString())

        assertEquals("updated", output.getString("swapStatus"))
        assertEquals(org.json.JSONArray(listOf("timeout", "revoked")).toString(), output.getJSONArray("failedReasonCodes").toString())

        for (invalid in listOf("timeout", 1)) {
            assertNull(IngressAuditWriter.buildMcpLine(ts, null, JSONObject(input).put("swapStatus", invalid).toString()))
        }
        for (invalid in listOf("timeout", org.json.JSONArray(listOf("timeout")),
            org.json.JSONArray(listOf("timeout", "unexpected")), org.json.JSONArray(listOf("timeout", 1)))) {
            assertNull(IngressAuditWriter.buildMcpLine(ts, null, JSONObject(input).put("failedReasonCodes", invalid).toString()))
        }
        val missingFailedIds = JSONObject(input).apply { remove("failedAgentIds") }
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, missingFailedIds.toString()))

        for (key in listOf("rebuiltAgentIds", "failedAgentIds")) {
            for (invalid in listOf("agent-1", org.json.JSONArray(listOf("../agent")), org.json.JSONArray(listOf(1)),
                org.json.JSONArray(List(34) { "agent-$it" }))) {
                assertNull(IngressAuditWriter.buildMcpLine(ts, null, JSONObject(input).put(key, invalid).toString()))
            }
        }
    }

    @Test
    fun pipelineConfigAuditFitsMaximumBridgeCounts() {
        val kind = "mcp_update_pipeline_config"
        val input = json(
            "kind" to kind, "event" to kind, "principal" to p, "code" to "revoked",
            "changedPipelineIds" to org.json.JSONArray(List(32) { "p".repeat(30) + it.toString().padStart(2, '0') } + "digest"),
            "rebuiltCount" to 0, "rebuildFailedCount" to 33,
            "rebuiltAgentIds" to org.json.JSONArray(),
            "failedAgentIds" to org.json.JSONArray(List(33) { "a".repeat(126) + it.toString().padStart(2, '0') }),
            "failedReasonCodes" to org.json.JSONArray(List(33) { "agent_not_found" }),
            "swapStatus" to "updated", "sha256" to committedSha256, "bytes" to 262144,
            "backupCreated" to true, "previousSha256" to previousSha256,
        )
        assertNotNull(IngressAuditWriter.buildMcpLine(ts, null, input))
    }

    @Test
    fun onlyPipelineConfigNativeErrorsCanRecordAValidObservedHash() {
        val kind = "mcp_update_pipeline_config"
        val hash = "abcdef0123456789".repeat(4)
        val input = JSONObject(json("kind" to kind, "event" to kind, "code" to "native_error", "observedSha256" to hash))
        val line = IngressAuditWriter.buildMcpLine(ts, null, input.toString())
        assertNotNull(line)
        assertEquals(hash, JSONObject(line!!).getString("observedSha256"))

        for (code in listOf("created", "updated", "revoked", "timeout", "verify_failed")) {
            assertNull(IngressAuditWriter.buildMcpLine(ts, null, input.put("code", code).toString()))
        }
        input.put("code", "native_error")
        for (invalid in listOf(hash.uppercase(), hash.dropLast(1), "g".repeat(64))) {
            assertNull(IngressAuditWriter.buildMcpLine(ts, null, input.put("observedSha256", invalid).toString()))
        }
        input.put("observedSha256", hash)
            .put("kind", "mcp_update_delivery_script").put("event", "mcp_update_delivery_script")
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, input.toString()))
    }

    @Test
    fun refusesAnythingOutsideTheClosedSet() {
        val base = arrayOf("kind" to "mcp_typed_op_refused", "event" to "mcp_run_agent")
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, json(*base, "message" to "free text")))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, json("kind" to "other", "event" to "mcp_run_agent")))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, json("kind" to "other", "event" to "other")))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, json("kind" to "mcp_typed_op_refused", "event" to "run_command")))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, json(*base, "principal" to "not-hex")))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, json(*base, "code" to "Bad Code")))
        // agentId must equal the argument.
        assertNull(IngressAuditWriter.buildMcpLine(ts, "a", json(*base, "agentId" to "b")))
        assertNull(IngressAuditWriter.buildMcpLine(ts, "a", json(*base)))
        assertNull(IngressAuditWriter.buildMcpLine(ts, "../x", json(*base, "agentId" to "../x")))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, json(*base, "ts" to "1999")))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, "not json"))
    }

    // ── Launcher ingress lines (C2, A2, D1 audit) ──────────────────────────

    private val lp = "launcher:$p"
    private val sid = "ls_" + "c".repeat(32)
    private fun launcher(kind: String = "launcher_submit_pending", code: String = "pending") = IngressAuditWriter.LauncherLine(
        kind = kind, event = IngressAuditWriter.LAUNCHER_EVENT_SUBMIT, code = code, principal = lp,
        certDigest = committedSha256, schemaVersion = 1, submissionId = sid, correlationRef = "task:42/a.b-c",
        tainted = true, exemptApplied = false, textSha256 = previousSha256, textCodePoints = 12,
    )

    @Test
    fun buildsTheFixedLauncherLineWithoutText() {
        val o = JSONObject(IngressAuditWriter.buildLauncherLine(ts, launcher())!!)
        assertEquals("launcher_submit_pending", o.getString("kind"))
        assertEquals("launcher_submit_instruction", o.getString("event"))
        assertEquals("launcher", o.getString("origin"))
        assertEquals("submit_instruction", o.getString("op"))
        assertEquals(lp, o.getString("principal"))
        assertEquals(committedSha256, o.getString("certDigest"))
        assertEquals(1, o.getInt("schemaVersion"))
        assertEquals(sid, o.getString("submission_id"))
        assertEquals("task:42/a.b-c", o.getString("correlation_ref"))
        assertEquals(true, o.getBoolean("tainted"))
        assertEquals(false, o.getBoolean("exemptApplied"))
        assertEquals(previousSha256, o.getString("textSha256"))
        assertEquals(12, o.getInt("textCodePoints"))
        assertEquals("2024-11-15T05:53:20.000Z", o.getString("ts"))
        val keys = HashSet<String>()
        o.keys().forEach { keys.add(it) }
        assertEquals(
            setOf("ts", "kind", "event", "origin", "code", "principal", "certDigest", "op", "schemaVersion", "submission_id",
                "correlation_ref", "tainted", "exemptApplied", "textSha256", "textCodePoints"),
            keys,
        )
    }

    @Test
    fun everyLauncherSubmitKindIsWritable() {
        for (k in IngressAuditWriter.LAUNCHER_KINDS - "launcher_feed_read") assertNotNull(k, IngressAuditWriter.buildLauncherLine(ts, launcher(kind = k)))
        // A denied verification line: only the check that failed, no principal.
        val denied = IngressAuditWriter.LauncherLine(kind = "launcher_submit_denied", event = IngressAuditWriter.LAUNCHER_EVENT_SUBMIT, code = "verify_signature")
        val d = JSONObject(IngressAuditWriter.buildLauncherLine(ts, denied)!!)
        assertEquals("verify_signature", d.getString("code"))
        // Fact sheet §2: no origin is issued to a caller that failed verification.
        assertFalse(d.has("origin"))
        assertFalse(d.has("principal"))
    }

    @Test
    fun refusesOffShapeLauncherFields() {
        val bad = listOf(
            launcher(kind = "launcher_submit_whatever"),
            launcher(code = "Has Spaces"),
            launcher().copy(event = "mcp_run_agent"),
            launcher().copy(principal = p), // an MCP principal is not a launcher principal
            launcher().copy(submissionId = "mr_" + "c".repeat(32)),
            launcher().copy(correlationRef = "free text with spaces"),
            launcher().copy(correlationRef = "x".repeat(257)),
            launcher().copy(textSha256 = "nothex"),
            launcher().copy(textCodePoints = LauncherIngressLimits.MAX_TEXT_CODE_POINTS + 1),
            launcher().copy(feedBytes = 10),
            IngressAuditWriter.LauncherLine(kind = "launcher_feed_read", event = IngressAuditWriter.LAUNCHER_EVENT_SUBMIT, code = "ok"),
            IngressAuditWriter.LauncherLine(kind = "launcher_feed_read", event = IngressAuditWriter.LAUNCHER_EVENT_FEED, code = "ok", submissionId = sid),
        )
        for (l in bad) assertNull(l.toString(), IngressAuditWriter.buildLauncherLine(ts, l))
        val feed = IngressAuditWriter.LauncherLine(
            kind = "launcher_feed_read", event = IngressAuditWriter.LAUNCHER_EVENT_FEED, code = "ok", principal = lp,
            certDigest = committedSha256, feedSha256 = previousSha256, feedBytes = 20_000,
        )
        val o = JSONObject(IngressAuditWriter.buildLauncherLine(ts, feed)!!)
        assertFalse(o.has("op"))
        assertEquals(20_000, o.getInt("feedBytes"))
    }
}
