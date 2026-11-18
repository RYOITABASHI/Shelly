package expo.modules.terminalemulator

import java.security.MessageDigest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * McpRawToolDecision (headless MCP run_command / write_file). The shared
 * fixture mcp-raw-tool-cases.json is also checked against the TS code by
 * __tests__/mcp-raw-tool-native.test.ts. Dummy values only.
 */
class McpRawToolDecisionTest {
    private val fixture = McpFixtures.load("mcp-raw-tool-cases.json")

    // ── Route ──

    @Test
    fun executesOnlyWithTheSwitchExecAndNoStopAll() {
        assertEquals(McpRawToolDecision.Route.EXECUTE, McpRawToolDecision.route(true, true, false))
        assertEquals(McpRawToolDecision.Route.HAND_OFF, McpRawToolDecision.route(false, true, false))
        assertEquals(McpRawToolDecision.Route.HAND_OFF, McpRawToolDecision.route(true, false, false))
        assertEquals(McpRawToolDecision.Route.HAND_OFF, McpRawToolDecision.route(true, true, true))
    }

    // ── Strings shared with TS ──

    @Test
    fun execScriptMatchesTheFixture() {
        assertEquals(fixture.getString("lazyFn"), McpRawToolDecision.SHELLY_LAZY_FN)
        val cases = fixture.getJSONArray("execScript")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val cwd = if (c.isNull("cwd")) null else c.getString("cwd")
            assertEquals(c.getString("expected"), McpRawToolDecision.execScript(c.getString("command"), cwd, c.getString("principal"), c.getString("callId")))
        }
    }

    @Test
    fun shellQuoteAndNormalizeMatchTheFixture() {
        val q = fixture.getJSONArray("shellQuote")
        for (i in 0 until q.length()) assertEquals(q.getJSONArray(i).getString(1), McpRawToolDecision.shellQuote(q.getJSONArray(i).getString(0)))
        val n = fixture.getJSONArray("normalizePath")
        for (i in 0 until n.length()) assertEquals(n.getJSONArray(i).getString(1), McpRawToolDecision.normalizePath(n.getJSONArray(i).getString(0)))
    }

    @Test
    fun snapshotVerifiesOnlyWithTheToken() {
        val s = fixture.getJSONObject("snapshot")
        assertEquals(s.getString("mac"), McpRawToolDecision.snapshotMac(s.getString("token"), s.getString("body")))
        val file = JSONObject().put("body", s.getString("body")).put("mac", s.getString("mac")).toString()
        assertEquals(listOf("/sdcard/repo"), McpRawToolDecision.repoPathsFromSnapshot(file, s.getString("token")))
        assertNull(McpRawToolDecision.repoPathsFromSnapshot(file, "another-token-000000000000000000"))
        val forged = JSONObject().put("body", """{"v":1,"agents":[],"repoPaths":["/"]}""").put("mac", s.getString("mac")).toString()
        assertNull(McpRawToolDecision.repoPathsFromSnapshot(forged, s.getString("token")))
        assertNull(McpRawToolDecision.repoPathsFromSnapshot(null, s.getString("token")))
        assertNull(McpRawToolDecision.repoPathsFromSnapshot("{", s.getString("token")))
    }

    // ── Arguments / timeout ──

    @Test
    fun runCommandArgsAsRn() {
        assertNull(McpRawToolDecision.parseRunCommand(JSONObject()))
        assertNull(McpRawToolDecision.parseRunCommand(JSONObject().put("command", "   ")))
        val a = McpRawToolDecision.parseRunCommand(JSONObject().put("command", "ls").put("cwd", "").put("timeoutMs", 5000))!!
        assertNull(a.cwd)
        assertEquals(5000L, a.requestedTimeoutMs)
        assertNull(McpRawToolDecision.parseRunCommand(JSONObject().put("command", "ls").put("timeoutMs", "9"))!!.requestedTimeoutMs)
    }

    @Test
    fun timeoutIsCappedAndEndsBeforeTheClientGivesUp() {
        val t0 = 1_000_000L
        assertEquals(30_000L, McpRawToolDecision.effectiveTimeoutMs(null, t0, t0))
        assertEquals(90_000L, McpRawToolDecision.effectiveTimeoutMs(10_000_000L, t0, t0))
        assertEquals(30_000L, McpRawToolDecision.effectiveTimeoutMs(-5, t0, t0))
        // 70 s after receipt: 100 - 70 - 3 = 27 s left
        assertEquals(27_000L, McpRawToolDecision.effectiveTimeoutMs(60_000L, t0, t0 + 70_000L))
        assertNull(McpRawToolDecision.effectiveTimeoutMs(60_000L, t0, t0 + 97_000L))
    }

    // ── write_file resolution ──

    private class FakeFs(
        private val entries: Map<String, McpRawToolDecision.Stat>,
        private val dirs: Set<String>,
        private val real: Map<String, String>,
    ) : McpRawToolDecision.Fs {
        override fun lstat(path: String) = entries[path]
        override fun isDirFollow(path: String) = path in dirs
        override fun realPath(path: String) = real[path]
    }

    private val dir = McpRawToolDecision.Stat(McpRawToolDecision.Kind.DIR, 2)
    private val file1 = McpRawToolDecision.Stat(McpRawToolDecision.Kind.FILE, 1)
    private val home = "/data/user/0/app/files/home"
    private val homeReal = "/data/data/app/files/home"

    private fun fs(extra: Map<String, McpRawToolDecision.Stat> = emptyMap(), extraDirs: Set<String> = emptySet(), extraReal: Map<String, String> = emptyMap()) = FakeFs(
        mapOf("/" to dir, home to dir, "$home/src" to dir) + extra,
        setOf("/", home, "$home/src") + extraDirs,
        mapOf(home to homeReal, "$home/src" to "$homeReal/src", "/" to "/") + extraReal,
    )

    @Test
    fun resolvesToTheRealPathIncludingMissingComponents() {
        val r = McpRawToolDecision.resolveWriteTarget("$home/src/new/a.txt", listOf(home), fs())
        assertEquals(McpRawToolDecision.Target.Ok("$homeReal/src/new/a.txt", existed = false), r)
        val e = McpRawToolDecision.resolveWriteTarget("file://$home/src/a.txt", listOf(home), fs(mapOf("$home/src/a.txt" to file1)))
        assertEquals(McpRawToolDecision.Target.Ok("$homeReal/src/a.txt", existed = true), e)
    }

    private fun err(path: String, f: FakeFs = fs(), roots: List<String> = listOf(home)): String =
        (McpRawToolDecision.resolveWriteTarget(path, roots, f) as McpRawToolDecision.Target.Err).error

    @Test
    fun refusesWithRnMessages() {
        val msgs = fixture.getJSONArray("writeTargetErrors")
        val all = (0 until msgs.length()).map { msgs.getString(it) }.toSet()
        val got = listOf(
            err("relative/x"),
            err("$home/a\nb"),
            err("$home/../etc/x"),
            err("/"),
            err("/etc/passwd"),
            err("$home/l", fs(mapOf("$home/l" to McpRawToolDecision.Stat(McpRawToolDecision.Kind.LINK, 1)))),
            err("$home/d", fs(mapOf("$home/d" to dir))),
            err("$home/h", fs(mapOf("$home/h" to McpRawToolDecision.Stat(McpRawToolDecision.Kind.FILE, 2)))),
            // dangling symlink parent
            err("$home/dl/x", fs(mapOf("$home/dl" to McpRawToolDecision.Stat(McpRawToolDecision.Kind.LINK, 1)))),
            // a symlinked directory pointing outside every root
            err("$home/out/x", fs(mapOf("$home/out" to McpRawToolDecision.Stat(McpRawToolDecision.Kind.LINK, 1)), setOf("$home/out"), mapOf("$home/out" to "/etc"))),
        )
        for (g in got) assertTrue("unexpected message: $g", g in all)
        assertEquals(all, got.toSet())
    }

    @Test
    fun aConfiguredRepoIsAnAllowedRoot() {
        val f = fs(mapOf("/sdcard" to dir, "/sdcard/repo" to dir), setOf("/sdcard", "/sdcard/repo"), mapOf("/sdcard/repo" to "/storage/emulated/0/repo"))
        assertEquals(
            McpRawToolDecision.Target.Ok("/storage/emulated/0/repo/a.md", existed = false),
            McpRawToolDecision.resolveWriteTarget("/sdcard/repo/a.md", listOf(home, "/sdcard/repo"), f),
        )
    }

    // ── Policy seal ──

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    @Test
    fun policySealAsTheDriver() {
        val bytes = "{\"kind\":\"shelly.user-policy\"}".toByteArray()
        assertTrue(McpRawToolDecision.policySealAccepts(sha(bytes), true, true, bytes))
        assertTrue(McpRawToolDecision.policySealAccepts("${"0".repeat(64)},${sha(bytes)}", true, true, bytes))
        assertFalse(McpRawToolDecision.policySealAccepts(sha(bytes), true, false, bytes))
        assertFalse(McpRawToolDecision.policySealAccepts(sha(bytes), true, true, null))
        assertFalse(McpRawToolDecision.policySealAccepts("0".repeat(64), true, true, bytes))
        assertFalse(McpRawToolDecision.policySealAccepts("zz", false, true, null))
        assertTrue(McpRawToolDecision.policySealAccepts("", false, true, null))
        assertFalse(McpRawToolDecision.policySealAccepts("", true, true, null))
        assertFalse(McpRawToolDecision.policySealAccepts("", false, true, bytes))
    }

    // ── Gate helper I/O ──

    @Test
    fun gateOutputFailsClosed() {
        assertFalse(McpRawToolDecision.parseGateOutput("""{"v":1,"refused":false,"summary":"allow","rulesUnavailable":false}""", 0).refused)
        assertTrue(McpRawToolDecision.parseGateOutput("""{"v":1,"refused":true,"summary":"deny: x","rulesUnavailable":false}""", 0).refused)
        assertTrue(McpRawToolDecision.parseGateOutput("""{"v":1,"refused":false,"summary":"gray","rulesUnavailable":true}""", 0).refused)
        assertTrue(McpRawToolDecision.parseGateOutput("""{"v":1,"refused":false,"summary":"allow"}""", 0).refused)
        assertTrue(McpRawToolDecision.parseGateOutput("""{"v":1,"refused":false,"summary":"allow","rulesUnavailable":false}""", 1).refused)
        assertTrue(McpRawToolDecision.parseGateOutput("""{"v":1,"refused":"no","summary":"allow","rulesUnavailable":false}""", 0).refused)
        assertTrue(McpRawToolDecision.parseGateOutput("garbage", 0).refused)
        assertTrue(McpRawToolDecision.parseGateOutput(null, null).refused)
    }

    @Test
    fun gateInputCarriesBothPathsOnlyWhenDifferent() {
        val same = McpRawToolDecision.gateInputWriteFile("/h", "/h/a", "/h/a", null, true)
        assertEquals(1, same.getJSONArray("paths").length())
        val diff = McpRawToolDecision.gateInputWriteFile("/h", "/h/real", "/h/link/a", "{}", false)
        assertEquals(2, diff.getJSONArray("paths").length())
        assertEquals(false, diff.getJSONObject("policy").getBoolean("sealOk"))
        val script = McpRawToolDecision.gateScript(McpRawToolDecision.gateInputRunCommand("/h", "ls", null, null, true), "BUNDLE")
        assertTrue(script.startsWith("globalThis.__SHELLY_MCP_RAW_GATE_INPUT = {"))
        assertTrue(script.endsWith(";\nBUNDLE"))
        assertTrue(McpRawToolDecision.gateInputRunCommand("/h", "ls", null, null, true).isNull("cwd"))
    }

    // ── Results / agent requests ──

    @Test
    fun resultShapesAsRn() {
        val c = JSONObject(McpRawToolDecision.commandResult("o", "e", 3))
        assertTrue(c.getBoolean("ok"))
        assertEquals(3, c.getJSONObject("data").getInt("exitCode"))
        val w = JSONObject(McpRawToolDecision.writeResult("/p", 5))
        assertEquals("/p", w.getJSONObject("data").getString("path"))
        assertEquals(5, w.getJSONObject("data").getInt("bytes"))
        val e = JSONObject(McpRawToolDecision.errorResult("x"))
        assertFalse(e.getBoolean("ok"))
        assertEquals("x", e.getString("error"))
    }

    @Test
    fun agentRequestIdsFromAListing() {
        val ids = McpRawToolDecision.agentRequestIds(arrayOf(".shelly-agent-req-1700000000000-0000abcd", ".shelly-agent-pending-1700000000001-0000abce", ".shelly-agent-req-x", "other"))
        assertEquals(setOf("1700000000000-0000abcd", "1700000000001-0000abce"), ids)
        assertNull(McpRawToolDecision.agentRequestIds(null))
    }

    @Test
    fun nativeIngressKeepsWindowsAndRequests() {
        McpNativeIngress.clearForTests()
        McpNativeIngress.begin("call-1", "p".repeat(32), 1_000L)
        McpNativeIngress.noteRequest("1700000000000-0000abcd", "call-1", "p".repeat(32), 1_500L)
        McpNativeIngress.end("call-1", 2_000L)
        val s = JSONObject(McpNativeIngress.snapshotJson(3_000L))
        assertEquals(2_000L, s.getJSONArray("windows").getJSONObject(0).getLong("end"))
        assertEquals("1700000000000-0000abcd", s.getJSONArray("requests").getJSONObject(0).getString("reqId"))
        val later = JSONObject(McpNativeIngress.snapshotJson(2_000L + McpNativeIngress.RETAIN_MS + 1))
        assertEquals(0, later.getJSONArray("windows").length())
        McpNativeIngress.begin("\$(id)", "x y", 1L)
        assertEquals("unknown", JSONObject(McpNativeIngress.snapshotJson(2L)).getJSONArray("windows").getJSONObject(0).getString("callId"))
        McpNativeIngress.clearForTests()
    }

    @Test
    fun rawToolAuditLinesCarryNoFreeText() {
        val line = IngressAuditWriter.buildNativeMcpLine(0L, "mcp_raw_tool_executing", "mcp_run_command", null, "0".repeat(32), null)
        assertTrue(line != null && line.contains("mcp_run_command"))
        assertNull(IngressAuditWriter.buildNativeMcpLine(0L, "mcp_raw_tool_done", "mcp_run_command", null, null, "exit 0"))
        assertNull(IngressAuditWriter.buildNativeMcpLine(0L, "mcp_raw_tool_done", "rm -rf", null, null, "ok"))
        // RN-supplied lines still only accept the run_agent event.
        assertEquals(setOf("mcp_run_agent"), IngressAuditWriter.MCP_EVENTS)
    }
}
