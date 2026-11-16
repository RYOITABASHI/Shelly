package expo.modules.terminalemulator

import expo.modules.terminalemulator.McpAlwaysAllowStore.AddResult
import expo.modules.terminalemulator.McpAlwaysAllowStore.Rule
import expo.modules.terminalemulator.McpAlwaysAllowStore.Status
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure half of McpAlwaysAllowStore (encode / decode / classify / match /
 * add / remove / purge). The Keystore + prefs half needs a device. Like
 * ClosePawDraftPreapprovalTest, not wired into CI's Gradle run yet, and not
 * compiled on the VM this was written on (no Gradle there).
 */
class McpAlwaysAllowStoreTest {
    private val p1 = "0123456789abcdef0123456789abcdef"
    private val p2 = "fedcba9876543210fedcba9876543210"
    private val bindA = "a".repeat(64)
    private val bindB = "b".repeat(64)

    private fun rule(
        id: String = "r_0000000000000001",
        principal: String = p1,
        op: String = "run_agent",
        target: String = "agent:daily",
        bind: String? = bindA,
        label: String = "Daily",
        createdAt: Long = 1_731_650_000_000L,
    ) = Rule(id, principal, op, target, bind, label, createdAt)

    private fun ruleObj(r: Rule): JSONObject {
        val o = JSONObject().put("id", r.id).put("principal", r.principal).put("op", r.op).put("target", r.target)
            .put("label", r.label).put("createdAt", r.createdAt)
        if (r.bind != null) o.put("bind", r.bind)
        return o
    }

    private fun state(vararg rules: JSONObject): String =
        JSONObject().put("version", 1).put("rules", JSONArray().also { a -> rules.forEach { a.put(it) } }).toString()

    @Test
    fun encodeDecodeRoundTrip() {
        val rules = listOf(rule(), rule(id = "r_0000000000000002", target = "agent:other", bind = null, label = ""))
        assertEquals(rules, McpAlwaysAllowStore.decode(McpAlwaysAllowStore.encode(rules)))
        assertEquals(emptyList<Rule>(), McpAlwaysAllowStore.decode(McpAlwaysAllowStore.encode(emptyList())))
    }

    @Test
    fun decodeRejectsRawAndUnknownOps() {
        for (op in listOf("run_command", "write_file", "list_agents", "RUN_AGENT", "")) {
            val bad = ruleObj(rule()).put("op", op)
            assertNull(op, McpAlwaysAllowStore.decode(state(ruleObj(rule(id = "r_0000000000000009", target = "agent:x")), bad)))
        }
    }

    @Test
    fun decodeRejectsMalformedFields() {
        val good = ruleObj(rule())
        val bads = listOf(
            JSONObject(good.toString()).put("principal", "0123"),
            JSONObject(good.toString()).put("principal", p1.uppercase()),
            JSONObject(good.toString()).put("target", "agent:*"),
            JSONObject(good.toString()).put("target", "agent:"),
            JSONObject(good.toString()).put("target", "repo:x"),
            JSONObject(good.toString()).put("target", "agent:" + "a".repeat(129)),
            JSONObject(good.toString()).put("bind", "zz"),
            JSONObject(good.toString()).put("bind", ""),
            JSONObject(good.toString()).put("bind", JSONObject.NULL),
            JSONObject(good.toString()).put("id", "r_xyz"),
            JSONObject(good.toString()).put("label", "x".repeat(65)),
            JSONObject(good.toString()).put("label", "a\u202Eb"),
            JSONObject(good.toString()).put("createdAt", -1),
            JSONObject(good.toString()).put("createdAt", 1.5),
            JSONObject(good.toString()).put("createdAt", "1"),
            JSONObject(good.toString()).put("extra", true),
            JSONObject(good.toString()).also { it.remove("target") },
        )
        for (bad in bads) assertNull(bad.toString(), McpAlwaysAllowStore.decode(state(bad)))
        assertNotNull(McpAlwaysAllowStore.decode(state(good)))
    }

    @Test
    fun decodeRejectsDuplicatesVersionsAndExtraKeys() {
        val a = ruleObj(rule())
        // Same key, different id.
        assertNull(McpAlwaysAllowStore.decode(state(a, ruleObj(rule(id = "r_0000000000000002", bind = bindB)))))
        // Same id, different key.
        assertNull(McpAlwaysAllowStore.decode(state(a, ruleObj(rule(target = "agent:other")))))
        // Same target for another principal is a different key.
        assertNotNull(McpAlwaysAllowStore.decode(state(a, ruleObj(rule(id = "r_0000000000000002", principal = p2)))))
        assertNull(McpAlwaysAllowStore.decode(JSONObject(state(a)).put("version", 2).toString()))
        assertNull(McpAlwaysAllowStore.decode(JSONObject(state(a)).put("version", "1").toString()))
        assertNull(McpAlwaysAllowStore.decode(JSONObject(state(a)).put("more", 1).toString()))
        assertNull(McpAlwaysAllowStore.decode("not json"))
        assertNull(McpAlwaysAllowStore.decode("{\"version\":1}"))
    }

    @Test
    fun decodeEnforcesTheLimits() {
        val many = (0..McpAlwaysAllowStore.MAX_RULES).map {
            ruleObj(rule(id = "r_%016x".format(it + 1), target = "agent:a$it", bind = null, label = ""))
        }
        assertNull(McpAlwaysAllowStore.decode(state(*many.toTypedArray())))
        assertNotNull(McpAlwaysAllowStore.decode(state(*many.dropLast(1).toTypedArray())))
        val padded = state(ruleObj(rule())) + " ".repeat(McpAlwaysAllowStore.MAX_STATE_CHARS)
        assertNull(McpAlwaysAllowStore.decode(padded))
    }

    @Test
    fun classifyFailsToEmpty() {
        val s = McpAlwaysAllowStore.encode(listOf(rule()))
        assertEquals(Status.EMPTY, McpAlwaysAllowStore.classify(null, null, null).status)
        assertEquals(Status.OK, McpAlwaysAllowStore.classify(s, "m", "m").status)
        assertEquals(1, McpAlwaysAllowStore.classify(s, "m", "m").rules.size)
        for (c in listOf(
            McpAlwaysAllowStore.classify(s, "m", "other"), // bad MAC (rolled-back prefs, new key)
            McpAlwaysAllowStore.classify(s, "m", null), // no key
            McpAlwaysAllowStore.classify(s, null, "m"), // MAC missing
            McpAlwaysAllowStore.classify(null, "m", "m"), // state missing
            McpAlwaysAllowStore.classify("{corrupt", "m", "m"), // verifies but does not decode
            McpAlwaysAllowStore.classify(state(ruleObj(rule()).put("op", "run_command")), "m", "m"),
        )) {
            assertEquals(Status.UNREADABLE, c.status)
            assertTrue(c.rules.isEmpty())
        }
    }

    @Test
    fun matchSemantics() {
        val bound = rule()
        val unbound = rule(id = "r_0000000000000002", target = "agent:free", bind = null)
        val rules = listOf(bound, unbound)
        assertEquals(bound, McpAlwaysAllowStore.findMatch(rules, p1, "run_agent", "agent:daily", bindA))
        assertNull(McpAlwaysAllowStore.findMatch(rules, p1, "run_agent", "agent:daily", bindB)) // definition changed
        assertNull(McpAlwaysAllowStore.findMatch(rules, p1, "run_agent", "agent:daily", null))
        assertNull(McpAlwaysAllowStore.findMatch(rules, p2, "run_agent", "agent:daily", bindA)) // other client
        assertNull(McpAlwaysAllowStore.findMatch(rules, p1, "run_agent", "agent:Daily", bindA)) // case-sensitive
        assertNull(McpAlwaysAllowStore.findMatch(rules, p1, "run_command", "agent:daily", bindA))
        // A rule without a bind matches any bind, and none.
        assertEquals(unbound, McpAlwaysAllowStore.findMatch(rules, p1, "run_agent", "agent:free", bindB))
        assertEquals(unbound, McpAlwaysAllowStore.findMatch(rules, p1, "run_agent", "agent:free", null))
        // Malformed inputs match nothing.
        assertNull(McpAlwaysAllowStore.findMatch(rules, p1, "run_agent", "agent:free", "nothex"))
        assertNull(McpAlwaysAllowStore.findMatch(rules, null, "run_agent", "agent:free", null))
        assertNull(McpAlwaysAllowStore.findMatch(emptyList(), p1, "run_agent", "agent:daily", bindA))
    }

    @Test
    fun addReplacesTheSameKeyAndKeepsItsId() {
        val first = McpAlwaysAllowStore.withAdded(emptyList(), rule()) as AddResult.Added
        assertFalse(first.replaced)
        val again = McpAlwaysAllowStore.withAdded(
            first.rules,
            rule(id = "r_0000000000000002", bind = bindB, label = "Renamed", createdAt = 5),
        ) as AddResult.Added
        assertTrue(again.replaced)
        assertEquals(1, again.rules.size)
        assertEquals(rule(bind = bindB, label = "Renamed", createdAt = 5), again.rules[0])
        // Another principal is another rule.
        val other = McpAlwaysAllowStore.withAdded(again.rules, rule(id = "r_0000000000000003", principal = p2)) as AddResult.Added
        assertEquals(2, other.rules.size)
    }

    @Test
    fun addRefusesRawOpsMalformedRulesAndAFullStore() {
        assertEquals(AddResult.Refused("invalid"), McpAlwaysAllowStore.withAdded(emptyList(), rule(op = "run_command")))
        assertEquals(AddResult.Refused("invalid"), McpAlwaysAllowStore.withAdded(emptyList(), rule(op = "write_file")))
        assertEquals(AddResult.Refused("invalid"), McpAlwaysAllowStore.withAdded(emptyList(), rule(target = "agent:../x")))
        assertEquals(AddResult.Refused("invalid"), McpAlwaysAllowStore.withAdded(emptyList(), rule(principal = "x")))
        assertEquals(AddResult.Refused("invalid"), McpAlwaysAllowStore.withAdded(emptyList(), rule(bind = "x")))
        // An empty bind is malformed, never "any definition" (only null means that).
        assertEquals(AddResult.Refused("invalid"), McpAlwaysAllowStore.withAdded(emptyList(), rule(bind = "")))
        // An id clash with a different key.
        assertEquals(AddResult.Refused("invalid"), McpAlwaysAllowStore.withAdded(listOf(rule()), rule(target = "agent:other")))

        val full = (0 until McpAlwaysAllowStore.MAX_RULES).map {
            rule(id = "r_%016x".format(it + 1), target = "agent:a$it", bind = null, label = "")
        }
        assertEquals(AddResult.Refused("full"), McpAlwaysAllowStore.withAdded(full, rule(id = "r_ffffffffffffffff", target = "agent:new")))
        // Replacing an existing key is not refused for count.
        assertTrue(McpAlwaysAllowStore.withAdded(full, rule(id = "r_ffffffffffffffff", target = "agent:a0", bind = null)) is AddResult.Added)

        // The size limit: long targets, binds and labels fill 64 KiB before 200 rules.
        var big = emptyList<Rule>()
        var refused: AddResult? = null
        for (i in 0 until McpAlwaysAllowStore.MAX_RULES) {
            val r = rule(id = "r_%016x".format(i + 1), target = "agent:" + "%03d".format(i) + "x".repeat(125), label = "L".repeat(64))
            when (val res = McpAlwaysAllowStore.withAdded(big, r)) {
                is AddResult.Added -> big = res.rules
                is AddResult.Refused -> { refused = res; break }
            }
        }
        assertEquals(AddResult.Refused("full"), refused)
        assertTrue(McpAlwaysAllowStore.encode(big).length <= McpAlwaysAllowStore.MAX_STATE_CHARS)
        assertNotNull(McpAlwaysAllowStore.decode(McpAlwaysAllowStore.encode(big)))
    }

    @Test
    fun removeAndPurge() {
        val a = rule()
        val b = rule(id = "r_0000000000000002", principal = p2)
        val c = rule(id = "r_0000000000000003", target = "agent:other")
        val all = listOf(a, b, c)
        assertEquals(listOf(a, c), McpAlwaysAllowStore.withRemoved(all, listOf(b.id, "r_ffffffffffffffff")))
        assertEquals(all, McpAlwaysAllowStore.withRemoved(all, emptyList()))
        assertEquals(listOf(a, c), McpAlwaysAllowStore.purgedExcept(all, p1))
        assertEquals(listOf(b), McpAlwaysAllowStore.purgedExcept(all, p2))
        // Token revoked: nothing survives.
        assertEquals(emptyList<Rule>(), McpAlwaysAllowStore.purgedExcept(all, null))
    }

    @Test
    fun labelsAndIds() {
        assertEquals("ab", McpAlwaysAllowStore.sanitizeLabel(" a\u0000\u202Eb\n "))
        assertEquals(64, McpAlwaysAllowStore.sanitizeLabel("x".repeat(100)).length)
        // A surrogate pair is never split at the cut.
        val emoji = "x".repeat(63) + "\uD83D\uDE00"
        assertEquals("x".repeat(63), McpAlwaysAllowStore.sanitizeLabel(emoji))
        assertTrue(McpAlwaysAllowStore.isValidLabel(McpAlwaysAllowStore.sanitizeLabel(emoji)))
        val id = McpAlwaysAllowStore.newRuleId(emptyList())
        assertTrue(Regex("^r_[0-9a-f]{16}$").matches(id))
        assertTrue(McpAlwaysAllowStore.isTypedOp("run_agent"))
        assertFalse(McpAlwaysAllowStore.isTypedOp("run_command"))
        assertFalse(McpAlwaysAllowStore.isTypedOp("write_file"))
    }

    @Test
    fun statusJsonIsWhatTheRnParserExpects() {
        val json = JSONObject(McpAlwaysAllowStore.statusJson(McpAlwaysAllowStore.Classified(Status.OK, listOf(rule(bind = null)))))
        assertEquals(1, json.getInt("version"))
        assertEquals("ok", json.getString("status"))
        val r = json.getJSONArray("rules").getJSONObject(0)
        assertFalse(r.has("bind"))
        assertEquals("agent:daily", r.getString("target"))
        assertEquals("unreadable", JSONObject(McpAlwaysAllowStore.statusJson(McpAlwaysAllowStore.Classified(Status.UNREADABLE, emptyList()))).getString("status"))
    }
}
