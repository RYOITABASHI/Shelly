package expo.modules.terminalemulator

import android.content.Context

/**
 * The native body of MCP request_pipeline_refire (search parity item 4),
 * callable with only a Context: TerminalEmulatorModule.requestPipelineRefire
 * (RN's ladder, after the tap) and McpTypedOpConsumer (the headless drain,
 * after a rule or "Skip all approvals") both run exactly this.
 *
 * STOP-ALL first, then the pipeline's web-search opt-in (read only, the
 * Settings check), then the recovery script decides on today's run and
 * records the request (RunRecovery.requestRefire). Blocking: call it off the
 * main thread.
 */
object McpPipelineRefire {
    data class Answer(val code: String, val requestId: String?) {
        fun toMap(): Map<String, Any?> = mapOf("code" to code, "requestId" to requestId)
    }

    private val PIPELINE_ID_RE = Regex("^[a-z0-9-]{1,32}$")

    fun request(context: Context, pipelineId: String, principal: String?): Answer {
        if (!PIPELINE_ID_RE.matches(pipelineId)) return Answer("invalid_params", null)
        if (StopAllSwitches.halted(context)) return Answer("halted", null)
        val optIn = WebSearchOptInStore.optedInAgentForPipeline(context, pipelineId) {
            AgentRuntime.webSearchOptInCandidatesOutput(it)
        }
        val agentId = optIn.agentId
        val sha = optIn.definitionSha256
        if (optIn.code != "ok" || agentId == null || sha == null) {
            return Answer(if (optIn.code == "ok") "native_error" else optIn.code, null)
        }
        val r = RunRecovery.requestRefire(context, agentId, pipelineId, sha, principal)
        return Answer(r.code, r.requestId)
    }
}
