package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Caller verification (fact sheet §2). All values are made up; Shelly ships none (D6). */
class LauncherCallerVerifierCoreTest {
    private val pkg = "com.example.launcher"
    private val pinA = "a".repeat(64)
    private val pinB = "b".repeat(64)
    private val entry = TrustedCallerStore.Entry(IngressOrigin.LAUNCHER, pkg, listOf(pinA, pinB), true, null, 1L)

    private class Facts(
        var sdk: Int = 34,
        var pkgs: Array<String>? = arrayOf("com.example.launcher"),
        var signedBy: Set<String> = setOf("b".repeat(64)),
        var throws: Boolean = false,
    ) : LauncherCallerVerifierCore.Facts {
        override fun sdkInt(): Int = sdk
        override fun packagesForUid(uid: Int): Array<String>? {
            if (throws) throw SecurityException("x")
            return pkgs
        }
        override fun hasCert(packageName: String, sha256: ByteArray): Boolean =
            sha256.joinToString("") { "%02x".format(it) } in signedBy
    }

    private fun code(r: LauncherCallerVerifierCore.Result) = (r as LauncherCallerVerifierCore.Result.Failed).code

    @Test
    fun aRegisteredPackageSignedByAPinnedCertVerifies() {
        val r = LauncherCallerVerifierCore.verify(10123, entry, Facts())
        assertTrue(r is LauncherCallerVerifierCore.Result.Verified)
        r as LauncherCallerVerifierCore.Result.Verified
        assertEquals(IngressOrigin.LAUNCHER, r.principal.origin)
        assertEquals(TrustedCallerStore.principalOf(entry), r.principal)
        assertEquals(pinB, r.certDigest) // the second generation pin matched (rotation, D4)
    }

    @Test
    fun everyFailedCheckHasItsOwnAuditCodeAndNoPrincipal() {
        assertEquals("verify_no_caller", code(LauncherCallerVerifierCore.verify(1, null, Facts())))
        assertEquals("verify_api_level", code(LauncherCallerVerifierCore.verify(1, entry, Facts(sdk = 27))))
        assertEquals("verify_uid", code(LauncherCallerVerifierCore.verify(1, entry, Facts(pkgs = null))))
        assertEquals("verify_uid", code(LauncherCallerVerifierCore.verify(1, entry, Facts(pkgs = emptyArray()))))
        // sharedUserId: several packages on the UID, even if one is the right one.
        assertEquals("verify_shared_uid", code(LauncherCallerVerifierCore.verify(1, entry, Facts(pkgs = arrayOf(pkg, "com.example.other")))))
        assertEquals("verify_package", code(LauncherCallerVerifierCore.verify(1, entry, Facts(pkgs = arrayOf("com.example.other")))))
        assertEquals("verify_signature", code(LauncherCallerVerifierCore.verify(1, entry, Facts(signedBy = setOf("c".repeat(64))))))
        assertEquals("verify_error", code(LauncherCallerVerifierCore.verify(1, entry, Facts(throws = true))))
        val malformed = entry.copy(pins = listOf("nothex"))
        assertEquals("verify_no_caller", code(LauncherCallerVerifierCore.verify(1, malformed, Facts())))
    }
}
