package expo.modules.terminalemulator

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** StreamFeedCore: put_stream_feed validation and decision, stored format, get_stream_feed response (C7). */
class StreamFeedCoreTest {
    private val principal = "0123456789abcdef0123456789abcdef"

    private fun args(text: String, bytes: Int? = null, sha: String? = null): JSONObject {
        val b = text.toByteArray(Charsets.UTF_8)
        return JSONObject().put("feedJson", text).put("expectedSha256", sha ?: StreamFeedCore.sha256Hex(b))
            .put("expectedBytes", bytes ?: b.size)
    }

    private fun code(r: Any): String = (r as McpTypedOpDecision.Refusal).code

    // ── validate ──────────────────────────────────────────────────────────

    @Test
    fun acceptsAV1ObjectAndCountsItems() {
        val r = StreamFeedCore.validate(args("""{"v":1,"updatedAt":"x","items":[{"id":"a"},{"id":"b"}]}"""))
        assertTrue(r is StreamFeedCore.Feed)
        assertEquals(2, (r as StreamFeedCore.Feed).items)
        assertNull((StreamFeedCore.validate(args("""{"v":1}""")) as StreamFeedCore.Feed).items)
    }

    @Test
    fun argumentsAreStrict() {
        assertEquals("invalid_params", code(StreamFeedCore.validate(args("""{"v":1}""").put("extra", 1))))
        assertEquals("invalid_params", code(StreamFeedCore.validate(JSONObject().put("feedJson", 5).put("expectedSha256", "0".repeat(64)).put("expectedBytes", 1))))
        assertEquals("invalid_params", code(StreamFeedCore.validate(args("""{"v":1}""", sha = "ABC"))))
        assertEquals("invalid_params", code(StreamFeedCore.validate(args("""{"v":1}""", bytes = 0))))
        assertEquals("invalid_params", code(StreamFeedCore.validate(args("""{"v":1}""", bytes = StreamFeedCore.MAX_BYTES + 1))))
    }

    @Test
    fun sizeCapIsUtf8BytesAndNeverTruncates() {
        // "あ" is 3 bytes in UTF-8: pad to exactly the cap, then one byte over.
        val head = """{"v":1,"p":""""
        val tail = """"}"""
        val room = StreamFeedCore.MAX_BYTES - head.length - tail.length
        val exact = head + "あ".repeat(room / 3) + "x".repeat(room % 3) + tail
        assertEquals(StreamFeedCore.MAX_BYTES, exact.toByteArray(Charsets.UTF_8).size)
        assertTrue(StreamFeedCore.validate(args(exact)) is StreamFeedCore.Feed)
        val over = head + "あ".repeat(room / 3) + "x".repeat(room % 3 + 1) + tail
        val b = over.toByteArray(Charsets.UTF_8)
        assertEquals("too_large", code(StreamFeedCore.checkBytes(b, b.size, StreamFeedCore.sha256Hex(b))))
    }

    @Test
    fun sizeThenDigestThenDocument() {
        assertEquals("size_mismatch", code(StreamFeedCore.validate(args("""{"v":1}""", bytes = 8))))
        assertEquals("digest_mismatch", code(StreamFeedCore.validate(args("""{"v":1}""", sha = "0".repeat(64)))))
        for (bad in listOf("""[1]""", """{"v":"1"}""", """{"v":2}""", """{"x":1}""", """{"v":1} {}""", """{"v":1""", "")) {
            if (bad.isEmpty()) continue
            assertEquals(bad, "invalid_feed", code(StreamFeedCore.validate(args(bad))))
        }
        assertTrue(StreamFeedCore.validate(args("""{"v":1.0}""")) is StreamFeedCore.Feed)
    }

    @Test
    fun unpairedSurrogateIsInvalidParams() {
        val a = JSONObject().put("feedJson", "{\"v\":1,\"p\":\"\uD800\"}").put("expectedSha256", "0".repeat(64)).put("expectedBytes", 10)
        assertEquals("invalid_params", code(StreamFeedCore.validate(a)))
    }

    @Test
    fun strictJsonMatchesJsonParse() {
        for (bad in listOf("{v:1}", "{'v':1}", """{"v":1,}""", """{"v":01}""", """{"v":1}x""", """{"v":"\x"}""", """{"v":1,"a":[1,]}""", "{\"v\":1,\"a\":\"\\u\uFF10\uFF10\uFF14\uFF11\"}")) {
            assertFalse(bad, StrictJson.isObject(bad))
        }
        for (ok in listOf("""{"v":1}""", """ {"v":1.5e-3,"a":[true,false,null,"\u00e9\n"],"b":{}} """)) {
            assertTrue(ok, StrictJson.isObject(ok))
        }
        assertFalse(StrictJson.isObject("""{"a":""" + "[".repeat(200) + "]".repeat(200) + "}"))
        assertEquals("invalid_feed", code(StreamFeedCore.validate(args("{v:1}"))))
    }

    @Test
    fun malformedUtf8IsInvalid() {
        val b = byteArrayOf('{'.code.toByte(), '"'.code.toByte(), 'v'.code.toByte(), '"'.code.toByte(), ':'.code.toByte(), '1'.code.toByte(),
            ','.code.toByte(), '"'.code.toByte(), 0xC3.toByte(), '"'.code.toByte(), ':'.code.toByte(), '1'.code.toByte(), '}'.code.toByte())
        assertEquals("invalid_feed", code(StreamFeedCore.checkBytes(b, b.size, StreamFeedCore.sha256Hex(b))))
    }

    // ── decide ────────────────────────────────────────────────────────────

    private class FakeSteps(
        var on: Boolean = true,
        var epoch: Boolean = true,
        var halted: Boolean = false,
        var rule: String? = null,
        var live: Boolean = true,
    ) : StreamFeedCore.Steps {
        val asked = ArrayList<String>()
        override fun typedOpsOn(): Boolean { asked.add("setting"); return on }
        override fun epochCurrent(): Boolean { asked.add("epoch"); return epoch }
        override fun halted(): Boolean { asked.add("halted"); return halted }
        override fun matchRule(principal: String): String? { asked.add("rule"); return rule }
        override fun rnLive(): Boolean { asked.add("live"); return live }
    }

    private fun req(a: JSONObject = args("""{"v":1}"""), tool: String = StreamFeedCore.OP, at: Long = 1_000L) =
        McpTypedOpDecision.Request("c1", tool, a, principal, at)

    @Test
    fun decisionOrderAndOutcomes() {
        assertEquals("disabled", (StreamFeedCore.decide(req(), FakeSteps(on = false), 1_000L) as StreamFeedCore.Outcome.Refuse).refusal.code)
        assertEquals("invalid_params", (StreamFeedCore.decide(req(tool = "run_agent"), FakeSteps(), 1_000L) as StreamFeedCore.Outcome.Refuse).refusal.code)
        assertEquals("revoked", (StreamFeedCore.decide(req(), FakeSteps(epoch = false), 1_000L) as StreamFeedCore.Outcome.Refuse).refusal.code)
        val halted = FakeSteps(halted = true, rule = "r_0123456789abcdef")
        assertEquals("halted", (StreamFeedCore.decide(req(), halted, 1_000L) as StreamFeedCore.Outcome.Refuse).refusal.code)
        assertFalse("STOP-ALL wins before the rule is read", "rule" in halted.asked)
        val x = StreamFeedCore.decide(req(), FakeSteps(rule = "r_0123456789abcdef"), 1_000L)
        assertEquals("r_0123456789abcdef", (x as StreamFeedCore.Outcome.Execute).ruleId)
        assertEquals(StreamFeedCore.Outcome.Handoff, StreamFeedCore.decide(req(), FakeSteps(), 1_000L))
        assertEquals("not_attended", (StreamFeedCore.decide(req(), FakeSteps(live = false), 1_000L) as StreamFeedCore.Outcome.Refuse).refusal.code)
        assertEquals("not_attended", (StreamFeedCore.decide(req(), FakeSteps(), 1_000L + McpTypedOpDecision.HANDOFF_MAX_AGE_MS + 1) as StreamFeedCore.Outcome.Refuse).refusal.code)
    }

    @Test
    fun stagesHaveNoTaintOrApproveAll() {
        val stages = IngressDecision.STAGES.getValue(IngressDecision.OP_PUT_STREAM_FEED)
        assertEquals(
            setOf(IngressDecision.Stage.SETTING, IngressDecision.Stage.ARGS, IngressDecision.Stage.EPOCH, IngressDecision.Stage.STOP_ALL, IngressDecision.Stage.ALWAYS_ALLOW),
            stages,
        )
        assertTrue(IngressOrigin.taintFor(IngressOrigin.Facts(IngressOrigin.MCP, StreamFeedCore.OP, 1, setOf("feedJson"))).tainted)
    }

    // ── stored format ─────────────────────────────────────────────────────

    @Test
    fun encodeDecodeRoundTripAndTamperIsRefused() {
        val feed = StreamFeedCore.validate(args("""{"v":1,"items":[]}""")) as StreamFeedCore.Feed
        val file = StreamFeedCore.encode(feed, 42L)
        val back = StreamFeedCore.decode(file)!!
        assertEquals(feed.sha256, back.sha256)
        assertEquals(42L, back.receivedAt)
        assertEquals("""{"v":1,"items":[]}""", back.text)
        val tampered = file.copyOf().also { it[it.size - 2] = 'x'.code.toByte() }
        assertNull(StreamFeedCore.decode(tampered))
        assertNull(StreamFeedCore.decode(file.copyOf(file.size - 1)))
        assertNull(StreamFeedCore.decode("no header".toByteArray()))
    }

    // ── get_stream_feed ───────────────────────────────────────────────────

    @Test
    fun readResponseShapes() {
        val feed = StreamFeedCore.validate(args("""{"v":1}""")) as StreamFeedCore.Feed
        val ok = StreamFeedCore.readResponse(StreamFeedCore.State.Present(StreamFeedCore.decode(StreamFeedCore.encode(feed, 7L))!!))
        assertEquals(
            mapOf("status" to "ok", "response_version" to 1, "feed_json" to """{"v":1}""", "sha256" to feed.sha256, "bytes" to 7, "updated_at" to 7L),
            ok,
        )
        assertEquals(mapOf("status" to "empty", "response_version" to 1), StreamFeedCore.readResponse(StreamFeedCore.State.Empty))
        assertEquals(
            mapOf("status" to "error", "response_version" to 1, "reason" to "INTERNAL_ERROR"),
            StreamFeedCore.readResponse(StreamFeedCore.State.Unreadable),
        )
        assertEquals(mapOf("status" to "denied", "response_version" to 1, "reason" to "VERIFY_FAILED"), StreamFeedCore.deniedResponse("VERIFY_FAILED"))
    }

    // ── audit line ────────────────────────────────────────────────────────

    @Test
    fun auditLineCarriesNoContent() {
        val feed = StreamFeedCore.validate(args("""{"v":1,"items":[{"text":"secret words"}]}""")) as StreamFeedCore.Feed
        val line = IngressAuditWriter.buildStreamFeedLine(0L, principal, "storing", feed.sha256, feed.size, feed.items)!!
        assertFalse(line.contains("secret"))
        val o = JSONObject(line)
        assertEquals(setOf("ts", "kind", "event", "principal", "code", "sha256", "bytes", "items"), o.keys().asSequence().toSet())
        assertNull(IngressAuditWriter.buildStreamFeedLine(0L, principal, "Bad Code", null, null, null))
        assertNull(IngressAuditWriter.buildStreamFeedLine(0L, "launcher:$principal", "stored", null, null, null))
        assertNull(IngressAuditWriter.buildStreamFeedLineFromJson(0L, """{"kind":"mcp_stream_feed","event":"mcp_stream_feed","code":"denied","sha256":"${feed.sha256}"}"""))
        assertTrue(IngressAuditWriter.buildStreamFeedLineFromJson(0L, """{"kind":"mcp_stream_feed","event":"mcp_stream_feed","principal":"$principal","code":"approval_requested"}""") != null)
    }

    // ── always-allow ──────────────────────────────────────────────────────

    @Test
    fun alwaysAllowNamesOnlyTheFixedTargetForAnMcpPrincipal() {
        assertTrue(McpAlwaysAllowStore.isTypedOp(StreamFeedCore.OP))
        assertTrue(McpAlwaysAllowStore.isValidTarget(StreamFeedCore.OP, StreamFeedCore.TARGET))
        assertFalse(McpAlwaysAllowStore.isValidTarget(StreamFeedCore.OP, "stream-feed2"))
        assertTrue(McpAlwaysAllowStore.isValidPrincipalFor(StreamFeedCore.OP, principal))
        assertFalse(McpAlwaysAllowStore.isValidPrincipalFor(StreamFeedCore.OP, "launcher:$principal"))
    }
}
