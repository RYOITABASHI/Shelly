package expo.modules.terminalemulator

import expo.modules.terminalemulator.WebSearchOptInStore.Candidate
import expo.modules.terminalemulator.WebSearchOptInStore.Entry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure half of WebSearchOptInStore (state codec, executor-output parsing,
 * on/off/lapsed, launch exports, audit line). Like ClosePawDraftPreapprovalTest,
 * not wired into CI's Gradle run yet.
 */
class WebSearchOptInStoreTest {
    private val a = "a".repeat(64)
    private val b = "b".repeat(64)

    @Test
    fun stateRoundTripsAndRejectsAnythingOff() {
        val entries = listOf(Entry("agent-1", a, 5L), Entry("agent_2", b, 6L))
        assertEquals(entries, WebSearchOptInStore.decode(WebSearchOptInStore.encode(entries)))
        assertNull(WebSearchOptInStore.decode("""{"version":2,"entries":[]}"""))
        assertNull(WebSearchOptInStore.decode("""{"version":1,"entries":[{"agentId":"../x","sha256":"$a","enabledAt":1}]}"""))
        assertNull(WebSearchOptInStore.decode("""{"version":1,"entries":[{"agentId":"x","sha256":"ABC","enabledAt":1}]}"""))
        assertNull(
            WebSearchOptInStore.decode(
                """{"version":1,"entries":[{"agentId":"x","sha256":"$a","enabledAt":1},{"agentId":"x","sha256":"$b","enabledAt":2}]}""",
            ),
        )
        assertNull(WebSearchOptInStore.decode("not json"))
    }

    @Test
    fun candidatesParseStrictly() {
        val ok = """{"pipelines":[{"agentId":"agent-1","name":"A","pipelineId":"p-1","definitionSha256":"$a","webSearchStep":true},""" +
            """{"agentId":"agent-2","name":null,"pipelineId":"Bad Id","definitionSha256":"$b","webSearchStep":false}]}"""
        val list = WebSearchOptInStore.parseCandidates(ok)!!
        assertEquals(listOf(Candidate("agent-1", "A", "p-1", a, true), Candidate("agent-2", null, null, b, false)), list)
        assertNull(WebSearchOptInStore.parseCandidates("""{"pipelines":[{"agentId":"x","definitionSha256":"$a","webSearchStep":"yes"}]}"""))
        assertNull(WebSearchOptInStore.parseCandidates("""{"pipelines":[{"agentId":"x y","definitionSha256":"$a","webSearchStep":true}]}"""))
        assertNull(
            WebSearchOptInStore.parseCandidates(
                """{"pipelines":[{"agentId":"x","definitionSha256":"$a","webSearchStep":true},{"agentId":"x","definitionSha256":"$b","webSearchStep":true}]}""",
            ),
        )
        assertNull(WebSearchOptInStore.parseCandidates("{}"))
        assertNull(WebSearchOptInStore.parseCandidates(""))
        assertNull(WebSearchOptInStore.parseCandidates(null))
    }

    @Test
    fun aChangedDefinitionReadsAsLapsed() {
        val c = Candidate("agent-1", null, null, a, true)
        assertEquals("off", WebSearchOptInStore.stateOf(null, c))
        assertEquals("on", WebSearchOptInStore.stateOf(Entry("agent-1", a, 1L), c))
        assertEquals("lapsed", WebSearchOptInStore.stateOf(Entry("agent-1", b, 1L), c))
        assertEquals("lapsed", WebSearchOptInStore.stateOf(Entry("agent-1", a, 1L), c.copy(webSearchStep = false)))
        assertEquals("lapsed", WebSearchOptInStore.stateOf(Entry("agent-1", a, 1L), null))
    }

    @Test
    fun exportsOnlyOnATaintedNonIngressRun() {
        assertEquals(
            " && export SHELLY_WEB_SEARCH_OPT_IN_SHA256=$a && readonly SHELLY_WEB_SEARCH_OPT_IN_SHA256",
            WebSearchOptInStore.launchExports(true, null, a),
        )
        assertEquals("", WebSearchOptInStore.launchExports(false, null, a))
        assertEquals("", WebSearchOptInStore.launchExports(true, "mcp", a))
        assertEquals("", WebSearchOptInStore.launchExports(true, null, null))
        assertEquals("", WebSearchOptInStore.launchExports(true, null, "a; rm -rf /"))
    }

    @Test
    fun auditLineHasOnlyFixedFields() {
        val line = WebSearchOptInStore.buildAuditLine(0L, "enabled", "agent-1", a)!!
        val o = JSONObject(line)
        assertEquals("web_search_opt_in", o.getString("kind"))
        assertEquals("enabled", o.getString("event"))
        assertEquals("agent-1", o.getString("agentId"))
        assertEquals(a.substring(0, 16), o.getString("definitionSha256"))
        assertEquals("settings", o.getString("source"))
        assertEquals("1970-01-01T00:00:00.000Z", o.getString("ts"))
        assertTrue(WebSearchOptInStore.buildAuditLine(0L, "disabled", "agent-1", null) != null)
        assertNull(WebSearchOptInStore.buildAuditLine(0L, "other", "agent-1", a))
        assertNull(WebSearchOptInStore.buildAuditLine(0L, "enabled", "../x", a))
    }
}
