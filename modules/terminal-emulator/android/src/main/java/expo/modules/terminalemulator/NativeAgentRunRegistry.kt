package expo.modules.terminalemulator

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

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
 *
 * It also owns the "at most one pre-approved ClosePaw hand-off per run" flag
 * (claimClosePawHandoff), so a JS reload cannot reset it.
 */
object NativeAgentRunRegistry {
    private class ActiveRun(val startedAt: Long) {
        val closePawHandoffClaimed = AtomicBoolean(false)
    }

    /** agentId -> the run in progress. */
    private val active = ConcurrentHashMap<String, ActiveRun>()

    fun begin(agentId: String): Long {
        val now = System.currentTimeMillis()
        active[agentId] = ActiveRun(now)
        return now
    }

    fun end(agentId: String, startedAt: Long) {
        active.computeIfPresent(agentId) { _, run -> if (run.startedAt == startedAt) null else run }
    }

    /** Start time (ms) of the run AgentRuntime is executing for [agentId], or null. */
    fun activeRunStartedAt(agentId: String): Long? = active[agentId]?.startedAt

    /** True while [agentId] has a run in progress whose single pre-approved
     *  ClosePaw hand-off has not been claimed yet. */
    fun closePawHandoffAvailable(agentId: String): Boolean =
        active[agentId]?.closePawHandoffClaimed?.get() == false

    /** Atomically claim the run's single pre-approved ClosePaw hand-off.
     *  True exactly once per run; false with no run in progress. */
    fun claimClosePawHandoff(agentId: String): Boolean =
        active[agentId]?.closePawHandoffClaimed?.compareAndSet(false, true) == true
}
