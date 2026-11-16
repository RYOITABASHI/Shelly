package expo.modules.terminalemulator

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * The one native launch of an MCP `run_agent` run, shared by RN's
 * TerminalEmulatorModule.runAgentForMcp (foreground path, PR 5) and the
 * headless McpTypedOpConsumer (PR 6). Invariants (plan (c) "How a run is
 * started"), kept in exactly this one place:
 *  - the `accepted` ticket is written BEFORE the intent is sent (a lost intent
 *    shows up as `lost`, never as a silent hole), through
 *    McpRunTickets.acceptForMcp — the single requestId create-if-absent and
 *    busy check both paths share;
 *  - the intent carries EXTRA_MCP_RUN_HANDLE / EXTRA_MCP_PRINCIPAL and NO
 *    EXTRA_RUN_ORIGIN (so the run is origin "event", proactive) and NO
 *    EXTRA_TAINTED (the run is ingress-tainted by AgentRuntime's
 *    ingressRunReason = "mcp" instead);
 *  - a failed service start ends the ticket failed/launch_failed;
 *  - the launch [McpRunAuthorization.Grant] (signed deadline, approved
 *    binding, rule id for a rule-based run) is checked against the current
 *    state under the ticket lock before the ticket is written, kept with the
 *    handle, and checked again by [authorizeStart] when the service actually
 *    starts the run (McpRunTickets.markRunning, under the same lock as
 *    cancelLive). A launch delayed past its deadline, whose agent was disabled
 *    or edited, whose rule was removed, or whose ticket was revoked in between
 *    never starts.
 */
object McpRunLauncher {
    private const val TAG = "McpRunLauncher"

    sealed class Result {
        object Started : Result()
        data class Existing(val ticket: McpRunTickets.Ticket) : Result()
        object Busy : Result()
        /** The caller's beforeWrite refused; nothing written, nothing sent. */
        object Refused : Result()
        object Failed : Result()
    }

    fun launch(
        context: Context,
        agentId: String,
        handle: String,
        principal: String,
        requestId: String?,
        grant: McpRunAuthorization.Grant,
        beforeWrite: () -> Boolean = { true },
    ): Result {
        val accept = McpRunTickets.acceptForMcp(context, handle, principal, requestId, agentId) {
            // Under the ticket lock: the grant must hold now, then it is kept
            // for the start-time check, then the caller's last re-check.
            val refused = authorizeNow(context, grant, agentId, principal)
            if (refused != null) {
                Log.w(TAG, "MCP run: launch authorization does not hold ($refused)")
                false
            } else if (!McpRunAuthorization.register(handle, grant, System.currentTimeMillis())) {
                Log.w(TAG, "MCP run: launch grant not registered")
                false
            } else if (!beforeWrite()) {
                McpRunAuthorization.remove(handle)
                false
            } else {
                true
            }
        }
        when (accept) {
            is McpRunTickets.Accept.Existing -> return Result.Existing(accept.ticket)
            McpRunTickets.Accept.Busy -> return Result.Busy
            McpRunTickets.Accept.Refused -> {
                McpRunAuthorization.remove(handle)
                return Result.Refused
            }
            McpRunTickets.Accept.Failed -> {
                McpRunAuthorization.remove(handle)
                return Result.Failed
            }
            McpRunTickets.Accept.Written -> Unit
        }
        val intent = Intent(context, TerminalSessionService::class.java).apply {
            action = TerminalSessionService.ACTION_RUN_AGENT
            putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)
            putExtra(TerminalSessionService.EXTRA_MCP_RUN_HANDLE, handle)
            putExtra(TerminalSessionService.EXTRA_MCP_PRINCIPAL, principal)
            // Deliberately no EXTRA_RUN_ORIGIN and no EXTRA_TAINTED (see the class doc).
        }
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            Result.Started
        } catch (e: Exception) {
            Log.w(TAG, "MCP run: service start failed type=${e.javaClass.simpleName}")
            McpRunAuthorization.remove(handle)
            McpRunTickets.markEndedWithoutRun(
                context, handle, agentId, principal,
                McpRunTickets.STATE_FAILED, McpRunTickets.REASON_LAUNCH_FAILED,
            )
            Result.Failed
        }
    }

    /**
     * The service's start-time check (McpRunTickets.markRunning's authorize,
     * under the ticket lock): takes the grant registered for [handle] (single
     * use) and decides it against the current state. Null = may start; else
     * the ticket reason. Never throws.
     */
    fun authorizeStart(context: Context, handle: String, agentId: String, principal: String?, onAuthorized: (Boolean) -> Unit = {}): String? = try {
        val grant = McpRunAuthorization.take(handle)
        if (grant == null) McpRunAuthorization.REASON_UNAUTHORIZED else {
            val refusal = authorizeNow(context, grant, agentId, principal)
            if (refusal == null) onAuthorized(grant.ruleId != null && actionRule(context, grant.principal, "agent:$agentId", grant.bind)?.id == grant.ruleId)
            refusal
        }
    } catch (e: Exception) {
        McpRunAuthorization.REASON_UNAUTHORIZED
    }

    /** Exact RN-evaluated snapshot, not a native approximation of policy. */
    fun actionRule(context: Context, principal: String, target: String, bind: String): McpAlwaysAllowStore.Rule? {
        val rule = McpAlwaysAllowStore.findMatch(McpAlwaysAllowStore.read(context).rules, principal, "run_agent", target, bind) ?: return null
        if (rule.bind != bind || rule.actionPolicyPin == null) return null
        val file = McpTypedOpConsumer.policyFileOnDisk(McpTypedOpConsumer.agentsDir(context)) ?: return null
        if (file.malformed || file.pin != rule.actionPolicyPin) return null
        val seal = AgentPolicySeal.read(context)
        if (!McpRunAuthorization.isSealed(seal.valid, seal.everSealed, seal.seal, file.pin, file.blank)) return null
        return rule
    }

    private fun authorizeNow(context: Context, grant: McpRunAuthorization.Grant, agentId: String, principal: String?): String? = try {
        McpRunAuthorization.refusal(grant, agentId, principal, currentFacts(context, grant))
    } catch (e: Exception) {
        McpRunAuthorization.REASON_UNAUTHORIZED
    }

    /** The facts [McpRunAuthorization.refusal] needs, each read failing closed. */
    private fun currentFacts(context: Context, grant: McpRunAuthorization.Grant): McpRunAuthorization.Facts {
        val now = System.currentTimeMillis()
        val agentsDir = McpTypedOpConsumer.agentsDir(context)
        val agent = McpTypedOpConsumer.resolveAgentOnDisk(agentsDir, grant.agentId)
        val bind = agent?.let { a -> try { McpAgentBinding.bindingHash(a) } catch (e: Exception) { null } }
        val policyDenied = agent?.let { a ->
            McpTypedOpConsumer.policyDecisionOnDisk(agentsDir, a) == McpTypedOpPolicy.Decision.POLICY_DENIED
        } ?: false
        val tainted = try { AgentIngressTaint.runTaintReason(context, grant.agentId) != null } catch (e: Exception) { true }
        val ruleBased = grant.ruleId != null
        val declaresActions = agent?.let { a -> try { McpTypedOpPolicy.declaredActions(a).isNotEmpty() } catch (e: Exception) { true } } ?: true
        val policyFile = McpTypedOpConsumer.policyFileOnDisk(agentsDir)
        val policyVerified = policyFile != null && !policyFile.malformed && try {
            val seal = AgentPolicySeal.read(context)
            McpRunAuthorization.isSealed(seal.valid, seal.everSealed, seal.seal, policyFile.pin, policyFile.blank)
        } catch (e: Exception) {
            false
        }
        val typedOpsOn = try { McpAutostartStore.read(context)?.typedOps == true } catch (e: Exception) { false }
        val matched = if (ruleBased && bind != null && grant.target != null) {
            try {
                McpAlwaysAllowStore.findMatch(McpAlwaysAllowStore.read(context).rules, grant.principal, "run_agent", grant.target, bind)
            } catch (e: Exception) {
                null
            }
        } else {
            null
        }
        return McpRunAuthorization.Facts(
            nowMs = now,
            agentEnabled = agent != null,
            currentBind = bind,
            halted = McpTypedOpConsumer.haltedOnDisk(agentsDir),
            tainted = tainted,
            policyDenied = policyDenied,
            declaresActions = declaresActions,
            policyPin = policyFile?.pin,
            policyVerified = policyVerified,
            typedOpsOn = typedOpsOn,
            matchedRuleId = matched?.id,
            matchedActionPolicyPin = matched?.actionPolicyPin,
        )
    }
}
