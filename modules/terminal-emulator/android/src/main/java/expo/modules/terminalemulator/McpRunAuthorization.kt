package expo.modules.terminalemulator

/**
 * What authorized one MCP `run_agent` launch, kept from the launch until the
 * service actually starts the run (TerminalSessionService -> McpRunTickets
 * .markRunning), and the decision whether it still holds at that moment.
 *
 * Both launch paths go through McpRunLauncher, which checks the grant under
 * the ticket lock before the `accepted` ticket is written and [register]s it
 * with the handle; the service [take]s it (single use) inside markRunning,
 * under the same lock as McpRunTickets.cancelLive (token revoke), and starts
 * the run only when [refusal] is null. No grant (process restarted, never
 * registered, already used) = no run. The registry is process memory only: a
 * same-uid file can't forge one, and the app runs in one process.
 *
 * [refusal] is pure (McpRunAuthorizationTest); McpRunLauncher.currentFacts
 * reads the facts on the device.
 */
object McpRunAuthorization {
    /** Ticket reasons for a run refused when it was about to start (McpRunTickets.REASONS). */
    const val REASON_EXPIRED = McpRunTickets.REASON_EXPIRED
    const val REASON_TARGET_CHANGED = McpRunTickets.REASON_TARGET_CHANGED
    const val REASON_UNAUTHORIZED = McpRunTickets.REASON_UNAUTHORIZED

    /** Grants beyond this many live ones are refused (fail closed); far above 2 live runs per principal. */
    const val MAX_GRANTS = 256
    /** A grant is kept this long past its deadline before it is pruned unused. */
    const val GRANT_SLACK_MS = 5_000L

    private val BIND_RE = Regex("^[0-9a-f]{64}$")
    private val RULE_ID_RE = Regex("^r_[0-9a-f]{16}$")

    /**
     * [deadlineMs]: the signed receivedAt + 100 s (the client stops waiting
     * then). [bind]: the agent binding the tap or rule approved. [ruleId]: the
     * always-allow rule that authorized the run without a tap, with its
     * [target]; null = a tap on RN's dialog.
     */
    data class Grant(
        val agentId: String,
        val principal: String,
        val deadlineMs: Long,
        val bind: String,
        val ruleId: String?,
        val target: String?,
        /**
         * The `policy.json` state RN evaluated the deny classes against: the
         * SHA-256 of its bytes, "absent" when it did not exist; null = not
         * known (the headless consumer, which only launches agents that
         * declare no action). For an agent that declares actions the file on
         * disk must still be exactly this at acceptance and at the start:
         * native can't evaluate every POLICY-001 rule, so a policy changed
         * (or replaced / deleted) after RN's check never starts the run.
         */
        val policyPin: String? = null,
    )

    /** The facts at the moment of the check. Each read fails closed (see McpRunLauncher.currentFacts). */
    data class Facts(
        val nowMs: Long,
        /** `~/.shelly/agents/<id>.json` with a matching id and `enabled: true`. */
        val agentEnabled: Boolean,
        /** McpAgentBinding.bindingHash of that file; null when unreadable. */
        val currentBind: String?,
        /** STOP-ALL sentinel present (or not checkable). */
        val halted: Boolean,
        /** The agent's ingress taint mark (or the store unreadable). */
        val tainted: Boolean,
        /** McpTypedOpPolicy said POLICY_DENIED for the agent's declared actions. */
        val policyDenied: Boolean,
        /** The agent file declares at least one action (`action` / `actions`); true when unreadable. */
        val declaresActions: Boolean,
        /** `policy.json` now: SHA-256 of its bytes, "absent" when missing; null when unreadable. */
        val policyPin: String?,
        /**
         * `policy.json` now passes the native seal check (AgentPolicySeal,
         * [isSealed]) and is well-formed — RN's `unavailable` is false.
         */
        val policyVerified: Boolean,
        /** The typed-ops mirror (McpAutostartStore) says ON. */
        val typedOpsOn: Boolean,
        /** The id of the always-allow rule matching (principal, run_agent, target, bind) now; null = none. */
        val matchedRuleId: String?,
        val matchedActionPolicyPin: String? = null,
    )

    /** Well-formed: fields in shape, deadline finite and positive. */
    fun isValid(g: Grant): Boolean =
        McpRunTickets.isValidAgentId(g.agentId) && McpRunTickets.isValidPrincipal(g.principal) &&
            g.deadlineMs > 0L && BIND_RE.matches(g.bind) &&
            (g.ruleId == null || (RULE_ID_RE.matches(g.ruleId) && g.target == "agent:${g.agentId}")) &&
            (g.policyPin == null || g.policyPin == POLICY_ABSENT || BIND_RE.matches(g.policyPin))

    /**
     * Null when the run may start now; otherwise the ticket reason. Order:
     * grant present and for this agent / principal, deadline, STOP-ALL, the
     * typed-ops setting, target (enabled, same binding), taint, policy deny,
     * for an agent with declared actions the very policy RN evaluated (pin),
     * then for a rule-based grant: a verified policy (when the agent declares
     * actions) and the very same rule.
     */
    fun refusal(grant: Grant?, agentId: String, principal: String?, f: Facts): String? {
        if (grant == null || !isValid(grant)) return REASON_UNAUTHORIZED
        if (grant.agentId != agentId || principal == null || grant.principal != principal) return REASON_UNAUTHORIZED
        if (f.nowMs > grant.deadlineMs) return REASON_EXPIRED
        if (f.halted) return McpRunTickets.REASON_HALTED
        if (!f.typedOpsOn) return McpRunTickets.REASON_DISABLED
        if (!f.agentEnabled) return McpRunTickets.REASON_DISABLED
        if (f.currentBind == null || f.currentBind != grant.bind) return REASON_TARGET_CHANGED
        if (f.tainted || f.policyDenied) return McpRunTickets.REASON_REFUSED
        if (grant.ruleId != null && f.matchedActionPolicyPin != null &&
            (grant.policyPin != f.matchedActionPolicyPin || f.policyPin != f.matchedActionPolicyPin || !f.policyVerified)) return McpRunTickets.REASON_REFUSED
        if (f.declaresActions) {
            if (grant.policyPin == null || f.policyPin == null || f.policyPin != grant.policyPin) return McpRunTickets.REASON_REFUSED
            if (grant.ruleId != null && !f.policyVerified) return McpRunTickets.REASON_REFUSED
        }
        if (grant.ruleId != null && f.matchedRuleId != grant.ruleId) return McpRunTickets.REASON_REVOKED
        return null
    }

    /** [Facts.policyPin] / [Grant.policyPin] of a missing `policy.json`. */
    const val POLICY_ABSENT = "absent"

    /**
     * RN's isSealedPolicyState (lib/agent-user-policy-store.ts) over the
     * verified AgentPolicySeal state: an invalid seal fails; an empty seal
     * passes only when nothing was ever sealed and the file is missing or
     * blank; otherwise the file must exist and its hash be in the seal.
     */
    fun isSealed(sealValid: Boolean, everSealed: Boolean, seal: String, filePin: String?, fileBlank: Boolean): Boolean {
        if (!sealValid || filePin == null) return false
        if (seal.isEmpty()) return !everSealed && (filePin == POLICY_ABSENT || fileBlank)
        if (filePin == POLICY_ABSENT || !BIND_RE.matches(filePin)) return false
        return seal.split(',').contains(filePin)
    }

    // ── Registry (handle -> grant), process memory ──────────────────────────

    private val grants = HashMap<String, Grant>()

    /** Drops grants past deadline + slack (their run can't start any more). */
    @Synchronized
    fun prune(nowMs: Long) {
        val it = grants.entries.iterator()
        while (it.hasNext()) if (nowMs - it.next().value.deadlineMs > GRANT_SLACK_MS) it.remove()
    }

    /** False (nothing registered) when the grant is malformed, the handle is taken, or the registry is full. */
    @Synchronized
    fun register(handle: String, grant: Grant, nowMs: Long): Boolean {
        if (!McpRunTickets.isValidHandle(handle) || !isValid(grant)) return false
        prune(nowMs)
        if (grants.containsKey(handle) || grants.size >= MAX_GRANTS) return false
        grants[handle] = grant
        return true
    }

    /** The grant for [handle], removed (single use); null when none. */
    @Synchronized
    fun take(handle: String): Grant? = grants.remove(handle)

    @Synchronized
    fun remove(handle: String) {
        grants.remove(handle)
    }

    @Synchronized
    internal fun clearForTests() {
        grants.clear()
    }
}
