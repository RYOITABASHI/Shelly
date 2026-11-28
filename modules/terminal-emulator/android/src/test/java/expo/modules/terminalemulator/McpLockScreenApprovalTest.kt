package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** McpLockScreenApproval: the per-request decision machine and the token RN accepts. */
class McpLockScreenApprovalTest {
    private val now = 1_800_000_000_000L
    private val key = "ab".repeat(32)
    private val callId = "0f8e2d3c-1111-4222-8333-944455556666"

    @Test
    fun denyNeedsNoAuthentication() {
        val m = McpLockScreenApproval.Machine(now + 60_000)
        assertTrue(m.deny(now))
        assertEquals(McpLockScreenApproval.State.DENIED, m.state(now))
        // Final: nothing changes it.
        assertFalse(m.approveTapped(now))
        assertFalse(m.dismissSucceeded(now))
        assertFalse(m.deny(now))
        assertEquals(McpLockScreenApproval.State.DENIED, m.state(now + 120_000))
    }

    @Test
    fun approveCountsOnlyAfterTheKeyguardWasDismissed() {
        val m = McpLockScreenApproval.Machine(now + 60_000)
        // A dismiss without a tap is nothing.
        assertFalse(m.dismissSucceeded(now))
        assertEquals(McpLockScreenApproval.State.PENDING, m.state(now))
        assertTrue(m.approveTapped(now))
        assertEquals(McpLockScreenApproval.State.AUTHENTICATING, m.state(now))
        // Cancelled / error: no decision, back to waiting.
        assertTrue(m.dismissFailed(now))
        assertEquals(McpLockScreenApproval.State.PENDING, m.state(now))
        assertFalse(m.dismissSucceeded(now))
        assertTrue(m.approveTapped(now))
        assertFalse(m.approveTapped(now)) // already authenticating
        assertTrue(m.dismissSucceeded(now))
        assertEquals(McpLockScreenApproval.State.APPROVED, m.state(now))
        assertFalse(m.deny(now))
        assertFalse(m.dismissFailed(now))
        assertEquals(McpLockScreenApproval.State.APPROVED, m.state(now + 120_000))
    }

    @Test
    fun denyDuringAuthenticationWins() {
        val m = McpLockScreenApproval.Machine(now + 60_000)
        assertTrue(m.approveTapped(now))
        assertTrue(m.deny(now))
        assertFalse(m.dismissSucceeded(now))
        assertEquals(McpLockScreenApproval.State.DENIED, m.state(now))
    }

    @Test
    fun expiresAndThenIgnoresEverything() {
        val m = McpLockScreenApproval.Machine(now + 60_000)
        assertTrue(m.approveTapped(now))
        // The keyguard came back after the deadline: not an approval.
        assertFalse(m.dismissSucceeded(now + 60_000))
        assertEquals(McpLockScreenApproval.State.EXPIRED, m.state(now + 60_000))
        assertFalse(m.deny(now + 60_001))
        val idle = McpLockScreenApproval.Machine(now + 1)
        assertEquals(McpLockScreenApproval.State.PENDING, idle.state(now))
        assertEquals(McpLockScreenApproval.State.EXPIRED, idle.state(now + 1))
        assertFalse(idle.approveTapped(now + 1))
    }

    @Test
    fun tokenIsBoundToCallIdToolAndExpiry() {
        val deadline = now + 300_000
        val t = McpLockScreenApproval.token(key, callId, "update_delivery_script", deadline)
        assertTrue(Regex("[0-9]{13}\\.[0-9a-f]{64}").matches(t))
        assertTrue(McpLockScreenApproval.verify(t, key, callId, "update_delivery_script", deadline, now))
        assertTrue(McpLockScreenApproval.verify("$t\n", key, callId, "update_delivery_script", deadline, now))
        // Another call, another tool, another key.
        assertFalse(McpLockScreenApproval.verify(t, key, "0f8e2d3c-1111-4222-8333-944455556667", "update_delivery_script", deadline, now))
        assertFalse(McpLockScreenApproval.verify(t, key, callId, "stage_install", deadline, now))
        assertFalse(McpLockScreenApproval.verify(t, "cd".repeat(32), callId, "update_delivery_script", deadline, now))
        // Expired, or outliving the request's deadline.
        assertFalse(McpLockScreenApproval.verify(t, key, callId, "update_delivery_script", deadline, deadline))
        assertFalse(McpLockScreenApproval.verify(t, key, callId, "update_delivery_script", deadline - 1, now))
        // The expiry is under the MAC: changing it breaks the token.
        val forged = "${deadline - 1}" + t.substring(13)
        assertFalse(McpLockScreenApproval.verify(forged, key, callId, "update_delivery_script", deadline, now))
        assertFalse(McpLockScreenApproval.verify("x", key, callId, "update_delivery_script", deadline, now))
    }

    @Test
    fun tokenMatchesTheTsDomain() {
        // lib/mcp-request-auth.ts MCP_LOCK_APPROVAL_DOMAIN + callId:tool:exp (Jest checks the TS side with this vector).
        assertEquals(
            McpTypedOpDecision.hmacHex(key, "shelly-mcp-lock-approval-v1:$callId:stage_install:1800000300000"),
            McpLockScreenApproval.token(key, callId, "stage_install", 1_800_000_300_000L).substringAfter('.'),
        )
    }
}
