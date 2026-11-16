package expo.modules.terminalemulator

import expo.modules.terminalemulator.McpHandoffMove.Result
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The handoff move (claimed/ → requests/) with injected errnos. Regression for
 * build 2964: SELinux refused the old hard link (EACCES) and the failure was
 * reported as `not_attended`. Like the other Mcp* JVM tests, not compiled on
 * the VM this was written on (no JDK / Gradle there), and not yet run by CI
 * (build-android.yml runs assembleRelease only).
 */
class McpHandoffMoveTest {
    private class FakeFs(
        var noReplace: Int = 0,
        var present: Boolean = false,
        var renameErrno: Int = 0,
    ) : McpHandoffMove.Fs {
        val calls = ArrayList<String>()
        override fun renameNoReplace(src: String, dst: String): Int { calls.add("renameNoReplace"); return noReplace }
        override fun exists(path: String): Boolean { calls.add("exists"); return present }
        override fun rename(src: String, dst: String): Int { calls.add("rename"); return renameErrno }
    }

    private fun move(fs: FakeFs) = McpHandoffMove.move("/h/claimed/x.json.0011", "/h/requests/x.json", fs)

    @Test
    fun renameat2SuccessMovesWithoutTheFallback() {
        val fs = FakeFs(noReplace = 0)
        assertEquals(Result.Moved(McpHandoffMove.ROUTE_NOREPLACE), move(fs))
        assertEquals(listOf("renameNoReplace"), fs.calls)
    }

    @Test
    fun renameat2EexistIsTakenAndNeverRenames() {
        val fs = FakeFs(noReplace = McpHandoffMove.EEXIST)
        assertEquals(Result.Taken, move(fs))
        assertEquals(listOf("renameNoReplace"), fs.calls)
    }

    @Test
    fun renameat2EaccesFailsWithoutTheWeakerFallback() {
        val fs = FakeFs(noReplace = McpHandoffMove.EACCES)
        val r = move(fs)
        assertEquals(Result.Failed(McpHandoffMove.EACCES, McpHandoffMove.ROUTE_NOREPLACE), r)
        assertEquals(listOf("renameNoReplace"), fs.calls)
        assertEquals("eacces", McpHandoffMove.failureCode(r))
    }

    @Test
    fun unavailableEnosysEinvalTakeTheCheckedRename() {
        for (e in listOf(McpHandoffMove.UNAVAILABLE, McpHandoffMove.ENOSYS, McpHandoffMove.EINVAL)) {
            val fs = FakeFs(noReplace = e)
            assertEquals("errno $e", Result.Moved(McpHandoffMove.ROUTE_CHECKED), move(fs))
            assertEquals("errno $e", listOf("renameNoReplace", "exists", "rename"), fs.calls)
        }
    }

    @Test
    fun checkedRenameDoesNotRenameOverADestinationPresentAtTheCheck() {
        val fs = FakeFs(noReplace = McpHandoffMove.UNAVAILABLE, present = true)
        assertEquals(Result.Taken, move(fs))
        assertEquals(listOf("renameNoReplace", "exists"), fs.calls)
    }

    /**
     * The ACCEPTED weakness of route 2 (documented in McpHandoffMove): a
     * destination created by a same-uid process after the check is replaced.
     * The moved file still needs the bridge-key MAC and the single-use token.
     * Route 1 (renameat2) has no such window.
     */
    @Test
    fun checkedRenameWindowIsDocumentedNotClosed() {
        var created = false
        val fs = object : McpHandoffMove.Fs {
            override fun renameNoReplace(src: String, dst: String): Int = McpHandoffMove.UNAVAILABLE
            override fun exists(path: String): Boolean { val was = created; created = true; return was } // created right after the check
            override fun rename(src: String, dst: String): Int = 0 // rename(2) replaces it
        }
        assertEquals(Result.Moved(McpHandoffMove.ROUTE_CHECKED), McpHandoffMove.move("/h/c", "/h/r", fs))
        assertTrue(created)
    }

    /** The scenario of the brief: the fallback runs, rename is refused (EACCES), the request is refused handoff_failed. */
    @Test
    fun fallbackEaccesSurfacesAsHandoffFailedNotNotAttended() {
        val fs = FakeFs(noReplace = McpHandoffMove.UNAVAILABLE, renameErrno = McpHandoffMove.EACCES)
        val r = move(fs)
        assertEquals(listOf("renameNoReplace", "exists", "rename"), fs.calls) // the fallback ran
        assertEquals(Result.Failed(McpHandoffMove.EACCES, McpHandoffMove.ROUTE_CHECKED), r)
        assertEquals("eacces", McpHandoffMove.failureCode(r))
        val refusal = McpHandoffMove.refusalAfterFailure(claimedStillThere = true, destExists = false)
        assertEquals("handoff_failed", refusal?.code)
        assertNotEquals(McpTypedOpDecision.NOT_ATTENDED.code, refusal?.code)
        assertEquals("handoff_failed", org.json.JSONObject(McpTypedOpDecision.errorResult(refusal!!)).getString("code"))
    }

    @Test
    fun ambiguousStateIsNeverAnswered() {
        assertNull(McpHandoffMove.refusalAfterFailure(claimedStillThere = false, destExists = false))
        assertNull(McpHandoffMove.refusalAfterFailure(claimedStillThere = true, destExists = true))
        assertNull(McpHandoffMove.refusalAfterFailure(claimedStillThere = false, destExists = true))
    }

    @Test
    fun failureCodesFitTheAuditCodeShape() {
        val codeRe = Regex("^[a-z_]{1,32}$")
        val results = listOf<Result?>(null, Result.Taken, Result.Failed(McpHandoffMove.EPERM, "x"), Result.Failed(999, "x")) +
            listOf(2, 5, 13, 17, 18, 22, 28, 30, 38).map { Result.Failed(it, "x") }
        for (r in results) assertTrue(r.toString(), codeRe.matches(McpHandoffMove.failureCode(r)))
        assertEquals("token_not_written", McpHandoffMove.failureCode(null))
        assertEquals("errno_other", McpHandoffMove.failureCode(Result.Failed(999, "x")))
        assertTrue(IngressAuditWriter.NATIVE_MCP_KINDS.contains("mcp_typed_op_handoff_failed"))
    }
}
