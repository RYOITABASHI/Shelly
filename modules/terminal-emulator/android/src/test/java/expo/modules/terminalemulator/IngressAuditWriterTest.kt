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
    fun refusesAnythingOutsideTheClosedSet() {
        val base = arrayOf("kind" to "mcp_typed_op_refused", "event" to "mcp_run_agent")
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, json(*base, "message" to "free text")))
        assertNull(IngressAuditWriter.buildMcpLine(ts, null, json("kind" to "other", "event" to "mcp_run_agent")))
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
}
