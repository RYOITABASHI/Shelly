package expo.modules.terminalemulator

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure half of TrustedCallerStore (D6 registry, D1 exemption binding). Made-up values only. */
class TrustedCallerStoreTest {
    private val pkg = "com.example.launcher"
    private val pinA = "0a".repeat(32)
    private val pinB = "0b".repeat(32)
    private val colonA = (0 until 32).joinToString(":") { "0A" }

    @Test
    fun pinsRoundTripBetweenColonAndPlainForms() {
        assertEquals(pinA, TrustedCallerStore.normalizePin(colonA))
        assertEquals(pinA, TrustedCallerStore.normalizePin(pinA.uppercase()))
        assertEquals(pinA, TrustedCallerStore.normalizePin("  $pinA "))
        for (bad in listOf(null, "", "zz".repeat(32), pinA.dropLast(1), "0a:".repeat(31) + "0", "$colonA:0A")) {
            assertNull(bad.toString(), TrustedCallerStore.normalizePin(bad))
        }
        val bytes = TrustedCallerStore.pinBytes(pinA)!!
        assertEquals(32, bytes.size)
        assertEquals(pinA, bytes.joinToString("") { "%02x".format(it) })
    }

    private fun set(entries: List<TrustedCallerStore.Entry>, pins: List<String>, p: String = pkg) =
        TrustedCallerStore.withCaller(entries, IngressOrigin.LAUNCHER, p, pins, true, 1L) as TrustedCallerStore.SetResult.Ok

    @Test
    fun onlyNonMcpOriginsAndValidValuesRegister() {
        assertTrue(TrustedCallerStore.withCaller(emptyList(), IngressOrigin.MCP, pkg, listOf(pinA), true, 1L) is TrustedCallerStore.SetResult.Refused)
        assertTrue(TrustedCallerStore.withCaller(emptyList(), "other", pkg, listOf(pinA), true, 1L) is TrustedCallerStore.SetResult.Refused)
        assertTrue(TrustedCallerStore.withCaller(emptyList(), IngressOrigin.LAUNCHER, "nodots", listOf(pinA), true, 1L) is TrustedCallerStore.SetResult.Refused)
        assertTrue(TrustedCallerStore.withCaller(emptyList(), IngressOrigin.LAUNCHER, pkg, emptyList(), true, 1L) is TrustedCallerStore.SetResult.Refused)
        assertTrue(TrustedCallerStore.withCaller(emptyList(), IngressOrigin.LAUNCHER, pkg, List(5) { "%064x".format(it) }, true, 1L) is TrustedCallerStore.SetResult.Refused)
        val ok = set(emptyList(), listOf(pinB, colonA, pinA))
        assertEquals(listOf(pinA, pinB), ok.entry.pins) // normalized, deduplicated, sorted
        assertEquals(ok.entries, TrustedCallerStore.decode(TrustedCallerStore.encode(ok.entries)))
    }

    @Test
    fun theExemptionIsBoundToThePinSetAndARotationVoidsIt() {
        val first = set(emptyList(), listOf(pinA))
        val digest = TrustedCallerStore.pinsDigest(first.entry)
        // A grant must name the digest the owner confirmed.
        assertTrue(TrustedCallerStore.withExemption(first.entries, IngressOrigin.LAUNCHER, "submit_instruction", true, "f".repeat(64), 2L) is TrustedCallerStore.SetResult.Refused)
        assertTrue(TrustedCallerStore.withExemption(first.entries, IngressOrigin.LAUNCHER, "forward_content", true, digest, 2L) is TrustedCallerStore.SetResult.Refused)
        val granted = TrustedCallerStore.withExemption(first.entries, IngressOrigin.LAUNCHER, "submit_instruction", true, digest, 2L) as TrustedCallerStore.SetResult.Ok
        assertTrue(TrustedCallerStore.exemptionBound(granted.entry, "submit_instruction"))
        assertFalse(TrustedCallerStore.exemptionBound(granted.entry, "forward_content"))
        // Same identity again (enabled toggled): the grant survives.
        val toggled = TrustedCallerStore.withCaller(granted.entries, IngressOrigin.LAUNCHER, pkg, listOf(pinA), false, 3L) as TrustedCallerStore.SetResult.Ok
        assertFalse(toggled.identityChanged)
        assertTrue(TrustedCallerStore.exemptionBound(toggled.entry, "submit_instruction"))
        // Adding a pin (rotation) or changing the package drops it, and the principal changes.
        for (r in listOf(set(granted.entries, listOf(pinA, pinB)), set(granted.entries, listOf(pinA), "com.example.other"))) {
            assertTrue(r.identityChanged)
            assertNull(r.entry.exemption)
            assertFalse(TrustedCallerStore.exemptionBound(r.entry, "submit_instruction"))
            assertNotEquals(TrustedCallerStore.principalOf(granted.entry), TrustedCallerStore.principalOf(r.entry))
        }
        // A stale grant left in state (digest of another set) is not bound.
        val stale = granted.entry.copy(pins = listOf(pinA, pinB))
        assertFalse(TrustedCallerStore.exemptionBound(stale, "submit_instruction"))
    }

    @Test
    fun theStatusForSettingsCarriesTheDigestAndPrincipal() {
        val e = set(emptyList(), listOf(pinA)).entry
        val o = JSONObject(TrustedCallerStore.statusJson(TrustedCallerStore.Classified(TrustedCallerStore.Status.OK, listOf(e))))
        val c = o.getJSONArray("callers").getJSONObject(0)
        assertEquals(TrustedCallerStore.pinsDigest(e), c.getString("pinsDigest"))
        assertEquals("launcher:" + TrustedCallerStore.pinsDigest(e).substring(0, 32), c.getString("principal"))
        assertFalse(c.getBoolean("exemptionBound"))
        assertEquals(TrustedCallerStore.Status.UNREADABLE, TrustedCallerStore.classify("{}", "x", "y").status)
        assertEquals(TrustedCallerStore.Status.EMPTY, TrustedCallerStore.classify(null, null, null).status)
        assertNull(TrustedCallerStore.decode(JSONObject(TrustedCallerStore.encode(listOf(e))).put("extra", 1).toString()))
    }
}
