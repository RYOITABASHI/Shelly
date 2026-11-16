package expo.modules.terminalemulator

import expo.modules.terminalemulator.McpTypedOpPolicy.Decision
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The native step-7 subset against __tests__/fixtures/mcp-typed-op-capabilities.json
 * (TS side: __tests__/mcp-typed-op-native-parity.test.ts checks the same
 * table against actionTypeCapabilities and that "clearable" / "policy_denied"
 * never disagree with classifyRunAgentDeny in the unsafe direction). Not wired
 * into CI's Gradle run yet; not compiled on the VM this was written on.
 */
class McpTypedOpPolicyTest {
    private val fixture = McpFixtures.load("mcp-typed-op-capabilities.json")

    @Test
    fun readOnlySetMatches() {
        val ro = fixture.getJSONArray("readOnlyCapabilities")
        val set = HashSet<String>()
        for (i in 0 until ro.length()) set.add(ro.getString(i))
        assertEquals(McpTypedOpPolicy.READ_ONLY_CAPABILITIES, set)
    }

    @Test
    fun capabilityTableMatches() {
        val cases = fixture.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val type = c.getString("actionType")
            val mode = c.opt("intentMode") as? String
            val name = "$type ${mode ?: ""}"
            val expected = c.opt("capabilities") as? JSONArray
            val got = McpTypedOpPolicy.capabilities(type, mode)
            if (type == "cli") {
                // Native never rates commands: cli has no native capability list.
                assertNull(name, got)
            } else if (expected != null) {
                val list = ArrayList<String>()
                for (j in 0 until expected.length()) list.add(expected.getString(j))
                assertEquals(name, list, got)
            }
            assertEquals(name, c.getBoolean("sideEffecting"), McpTypedOpPolicy.isSideEffecting(type, mode))
        }
    }

    @Test
    fun policyCasesMatch() {
        val cases = fixture.getJSONArray("policyCases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val agent = JSONObject().put("actions", c.getJSONArray("actions"))
            val policy = c.opt("policy")
            val text = if (policy is JSONObject) policy.toString() else null
            val got = McpTypedOpPolicy.decide(McpTypedOpPolicy.declaredActions(agent), text)
            val expected = when (c.getString("expected")) {
                "clearable" -> Decision.CLEARABLE
                "policy_denied" -> Decision.POLICY_DENIED
                else -> Decision.UNDECIDABLE
            }
            assertEquals(c.getString("name"), expected, got)
        }
    }

    @Test
    fun unreadablePolicyFileIsUndecidableUnlessNoActions() {
        val draft = listOf(McpTypedOpPolicy.DeclaredAction("draft", null))
        assertEquals(Decision.UNDECIDABLE, McpTypedOpPolicy.decide(draft, null, policyUnreadable = true))
        assertEquals(Decision.CLEARABLE, McpTypedOpPolicy.decide(emptyList(), null, policyUnreadable = true))
        assertEquals(Decision.UNDECIDABLE, McpTypedOpPolicy.decide(draft, "{not json"))
    }

    @Test
    fun malformedPolicyMatchesRnUnavailable() {
        assertFalse(McpTypedOpPolicy.isMalformed(""))
        assertFalse(McpTypedOpPolicy.isMalformed("  \n"))
        assertFalse(McpTypedOpPolicy.isMalformed("""{"kind":"shelly.user-policy","userPolicy":{"rules":[]}}"""))
        assertTrue(McpTypedOpPolicy.isMalformed("{not json"))
        assertTrue(McpTypedOpPolicy.isMalformed("""{"kind":"other","userPolicy":{"rules":[]}}"""))
        assertTrue(McpTypedOpPolicy.isMalformed("""{"kind":"shelly.user-policy","userPolicy":{}}"""))
        assertTrue(McpTypedOpPolicy.isMalformed("""{"kind":"shelly.user-policy"}"""))
    }
}
