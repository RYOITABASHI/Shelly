package expo.modules.terminalemulator

/**
 * The pure half of the lock-screen approval (owner decision 2026-11-29) for
 * update_pipeline_config / update_delivery_script / stage_install
 * (McpInstallOpDecision.Outcome.LockScreen): when one needs the tap while the
 * phone is locked (or the screen is off) and RN is not live, a full-screen
 * notification opens McpLockScreenApprovalActivity over the keyguard.
 *
 * [Machine] is the decision of ONE request:
 *   PENDING --deny--> DENIED                (no authentication needed)
 *   PENDING --approveTapped--> AUTHENTICATING  (the activity calls
 *       KeyguardManager.requestDismissKeyguard)
 *   AUTHENTICATING --dismissSucceeded--> APPROVED  (ONLY this approves)
 *   AUTHENTICATING --dismissFailed (cancelled / error)--> PENDING  (no decision)
 *   AUTHENTICATING --deny--> DENIED
 *   any non-final state at or past [Machine.expiresAtMs] --> EXPIRED
 * APPROVED / DENIED / EXPIRED are final: a later event changes nothing.
 *
 * [token] is what RN accepts instead of showing its own dialog (no second
 * tap): `<expiresAtMs>.<hex HMAC-SHA256(bridgeKey, DOMAIN + callId + ":" +
 * tool + ":" + expiresAtMs)>`, written to `lock-approvals/<callId>` by the
 * consumer only after APPROVED, bound to the request (callId), its tool and
 * the request's approval deadline; RN deletes it before checking and records
 * the callId (single use): lib/mcp-request-auth.ts verifyMcpLockApproval.
 *
 * No Android dependency: McpLockScreenApprovalTest covers it.
 */
object McpLockScreenApproval {
    /** KEEP IN SYNC: lib/mcp-request-auth.ts MCP_LOCK_APPROVAL_DOMAIN. */
    const val DOMAIN = "shelly-mcp-lock-approval-v1:"

    /** How often the consumer re-reads the decision while the prompt is up. */
    const val POLL_MS = 500L

    enum class State { PENDING, AUTHENTICATING, APPROVED, DENIED, EXPIRED }

    fun token(bridgeKey: String, callId: String, tool: String, expiresAtMs: Long): String =
        "$expiresAtMs." + McpTypedOpDecision.hmacHex(bridgeKey, "$DOMAIN$callId:$tool:$expiresAtMs")

    /** Kotlin mirror of RN's check (tests only; RN is the one that accepts the token). */
    fun verify(content: String, bridgeKey: String, callId: String, tool: String, deadlineMs: Long, nowMs: Long): Boolean {
        val m = Regex("([0-9]{13})\\.([0-9a-f]{64})").matchEntire(content.trim()) ?: return false
        val exp = m.groupValues[1].toLongOrNull() ?: return false
        if (nowMs >= exp || exp > deadlineMs) return false
        val expected = McpTypedOpDecision.hmacHex(bridgeKey, "$DOMAIN$callId:$tool:$exp")
        return java.security.MessageDigest.isEqual(expected.toByteArray(), m.groupValues[2].toByteArray())
    }

    /** One request's decision. Thread-safe (the activity's UI thread and the consumer's thread). */
    class Machine(val expiresAtMs: Long) {
        private var state = State.PENDING

        @Synchronized
        fun state(nowMs: Long): State {
            expireIfDue(nowMs)
            return state
        }

        /** 拒否: final at once, no authentication. False when already final. */
        @Synchronized
        fun deny(nowMs: Long): Boolean {
            expireIfDue(nowMs)
            if (state != State.PENDING && state != State.AUTHENTICATING) return false
            state = State.DENIED
            return true
        }

        /** 承認 tapped: true = ask the keyguard to authenticate now. Never approves by itself. */
        @Synchronized
        fun approveTapped(nowMs: Long): Boolean {
            expireIfDue(nowMs)
            if (state != State.PENDING) return false
            state = State.AUTHENTICATING
            return true
        }

        /** KeyguardDismissCallback.onDismissSucceeded: the only approval. */
        @Synchronized
        fun dismissSucceeded(nowMs: Long): Boolean {
            expireIfDue(nowMs)
            if (state != State.AUTHENTICATING) return false
            state = State.APPROVED
            return true
        }

        /** onDismissCancelled / onDismissError: no decision; the prompt stays open. */
        @Synchronized
        fun dismissFailed(nowMs: Long): Boolean {
            expireIfDue(nowMs)
            if (state != State.AUTHENTICATING) return false
            state = State.PENDING
            return true
        }

        private fun expireIfDue(nowMs: Long) {
            if ((state == State.PENDING || state == State.AUTHENTICATING) && nowMs >= expiresAtMs) state = State.EXPIRED
        }
    }
}
