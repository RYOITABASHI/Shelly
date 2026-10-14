package expo.modules.terminalemulator

import java.util.concurrent.ConcurrentHashMap

/**
 * Process-memory record of the agent runs AgentRuntime itself is executing
 * right now (2026-10-14, `shelly agent add` review fix).
 *
 * The RN approval choke point honours a ClosePaw registration pre-approval
 * (lib/agent-closepaw-preapproval.ts) only for an action-approval request of
 * an agent that THIS process is currently running. The request files live in
 * $HOME/.shelly/agents/action-approvals, which any same-uid process (the
 * user's shell, Codex) can write, so a forged file for a sealed agent must
 * not be able to fire ClosePaw on its own. This registry is deliberately NOT
 * on disk (SharedPreferences / $HOME are writable by the same uid): it is a
 * plain in-memory map, populated around AgentRuntime.runAgent, and gone with
 * the process — which can only make the check stricter.
 */
object NativeAgentRunRegistry {
    /** agentId -> start time (ms) of the run in progress. */
    private val active = ConcurrentHashMap<String, Long>()

    fun begin(agentId: String): Long {
        val now = System.currentTimeMillis()
        active[agentId] = now
        return now
    }

    fun end(agentId: String, startedAt: Long) {
        active.remove(agentId, startedAt)
    }

    /** Start time of the run AgentRuntime is executing for [agentId], or null. */
    fun activeRunStartedAt(agentId: String): Long? = active[agentId]
}
