package expo.modules.terminalemulator

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * McpAgentBinding must hash exactly what lib/mcp-typed-ops.ts agentBindingHash
 * hashes: __tests__/fixtures/mcp-agent-binding-cases.json (TS side:
 * __tests__/mcp-typed-op-native-parity.test.ts). Like the other JVM tests in
 * this module, not wired into CI's Gradle run yet and not compiled on the VM
 * this was written on (no Gradle there).
 */
class McpAgentBindingTest {
    private val fixture = McpFixtures.load("mcp-agent-binding-cases.json")

    @Test
    fun fieldsMatchTheTsList() {
        val fields = fixture.getJSONArray("fields")
        assertEquals(McpAgentBinding.BIND_FIELDS.size, fields.length())
        for (i in 0 until fields.length()) assertEquals(fields.getString(i), McpAgentBinding.BIND_FIELDS[i])
    }

    @Test
    fun everyCaseCanonicalAndHashMatch() {
        val cases = fixture.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val name = c.getString("name")
            // Round-trip through text, as the consumer reads the agent file.
            val agent = JSONObject(c.getJSONObject("agent").toString())
            assertEquals(name, c.getString("canonical"), McpAgentBinding.canonicalJson(McpAgentBinding.projection(agent)))
            assertEquals(name, c.getString("bind"), McpAgentBinding.bindingHash(agent))
        }
    }

    @Test
    fun anEditChangesTheHash() {
        val agent = JSONObject(fixture.getJSONArray("cases").getJSONObject(0).getJSONObject("agent").toString())
        val before = McpAgentBinding.bindingHash(agent)
        agent.put("prompt", "changed")
        assertNotEquals(before, McpAgentBinding.bindingHash(agent))
    }

    @Test
    fun jsNumberFormatting() {
        val cases = mapOf(
            0.0 to "0", -0.0 to "0", 1.0 to "1", -1.5 to "-1.5", 0.1 to "0.1", 1e21 to "1e+21", 1e20 to "100000000000000000000",
            1e-7 to "1e-7", 0.000001 to "0.000001", 123456789012.5 to "123456789012.5", 5e-324 to "5e-324",
            Double.NaN to "null", Double.POSITIVE_INFINITY to "null",
        )
        for ((d, s) in cases) assertEquals(d.toString(), s, McpAgentBinding.jsNumber(d))
    }

    @Test
    fun quoteEscapesLikeJsonStringify() {
        val sb = StringBuilder()
        McpAgentBinding.quote(sb, "a\"\\\b\u000C\n\r\t\u0001\u001f\u007f\ud800x\udc00😀")
        assertEquals("\"a\\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f\u007f\\ud800x\\udc00😀\"", sb.toString())
    }
}
