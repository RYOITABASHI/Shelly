package expo.modules.terminalemulator

/**
 * The decision order every typed ingress op is judged by, whatever its
 * origin (fact sheet §3 C1). McpTypedOpDecision.decide (run_agent over MCP)
 * and LauncherIngressCore.decide (submit_instruction from a verified
 * launcher) both run through [evaluate]: one ORDER, and per op the explicit
 * set of stages that apply. A stage that does not apply to an op (run_agent's
 * target / action consent / step 7 for submit_instruction) is skipped because
 * the table says so, never by a branch inside an op's code; the JVM test
 * IngressDecisionTest and __tests__/ingress-decision-order.test.ts pin it.
 *
 * Pure. No Android dependency.
 */
object IngressDecision {
    /** Who sent a request: a verified origin (IngressOrigin) and the id inside it. */
    data class Principal(val origin: String, val id: String) {
        /**
         * The string stored in rules, tickets and audit lines. MCP keeps its bare
         * 32-hex form (unchanged on disk); every other origin is prefixed, so an
         * MCP rule and a launcher rule can never collide (fact sheet §3.1).
         */
        val wire: String get() = if (origin == IngressOrigin.MCP) id else "$origin:$id"

        val isValid: Boolean get() = IngressOrigin.isKnown(origin) && ID_RE.matches(id)

        companion object {
            private val ID_RE = Regex("^[0-9a-f]{32}$")

            fun mcp(id: String) = Principal(IngressOrigin.MCP, id)

            /** Parses [wire]; null when it is not a known origin's form. */
            fun parse(wire: String?): Principal? {
                if (wire == null) return null
                val colon = wire.indexOf(':')
                val p = if (colon < 0) Principal(IngressOrigin.MCP, wire) else Principal(wire.substring(0, colon), wire.substring(colon + 1))
                if (colon >= 0 && p.origin == IngressOrigin.MCP) return null
                return if (p.isValid) p else null
            }
        }
    }

    enum class Stage { SETTING, ARGS, EPOCH, TARGET, STOP_ALL, TAINT, ACTION_CONSENT, STEP7, IDEMPOTENT, ALWAYS_ALLOW, APPROVE_ALL }

    /** THE order. */
    val ORDER: List<Stage> = listOf(
        Stage.SETTING, Stage.ARGS, Stage.EPOCH, Stage.TARGET, Stage.STOP_ALL, Stage.TAINT,
        Stage.ACTION_CONSENT, Stage.STEP7, Stage.IDEMPOTENT, Stage.ALWAYS_ALLOW, Stage.APPROVE_ALL,
    )

    const val OP_RUN_AGENT = "run_agent"
    const val OP_SUBMIT_INSTRUCTION = "submit_instruction"
    const val OP_PUT_STREAM_FEED = "put_stream_feed"

    /**
     * The stages each op runs, in [ORDER]. run_agent's APPROVE_ALL (the RN
     * step 8b switch) is RN-only, so the native run_agent path does not list
     * it. submit_instruction has no epoch (no MCP token), no target to resolve
     * (`hayato` is fixed), no action consent / step 7 (it starts nothing: no
     * command, file write or agent run), and no bind.
     */
    val STAGES: Map<String, Set<Stage>> = mapOf(
        OP_RUN_AGENT to setOf(
            Stage.SETTING, Stage.ARGS, Stage.EPOCH, Stage.TARGET, Stage.STOP_ALL, Stage.TAINT,
            Stage.ACTION_CONSENT, Stage.STEP7, Stage.IDEMPOTENT, Stage.ALWAYS_ALLOW,
        ),
        OP_SUBMIT_INSTRUCTION to setOf(
            Stage.SETTING, Stage.ARGS, Stage.STOP_ALL, Stage.TAINT, Stage.IDEMPOTENT, Stage.ALWAYS_ALLOW, Stage.APPROVE_ALL,
        ),
        // The stream feed (StreamFeedCore, fact sheet §6.2). Its content is
        // ALWAYS tainted (IngressOrigin.taintFor(mcp)), so there is no TAINT
        // stage to pass and no APPROVE_ALL: the blanket switch never covers
        // tainted content. What lets it run unattended is only a per-op
        // always-allow rule (D9): the op stores one opaque file that the
        // launcher reads and nothing in Shelly executes. No TARGET (the sink is
        // fixed), no action consent / step 7 / idempotency (it starts nothing).
        OP_PUT_STREAM_FEED to setOf(
            Stage.SETTING, Stage.ARGS, Stage.EPOCH, Stage.STOP_ALL, Stage.ALWAYS_ALLOW,
        ),
    )

    /**
     * Runs [hooks] in [ORDER] for the stages of [op]; the first non-null
     * result ends the decision. Null when every stage passed. [hooks] must
     * name exactly the op's stages (a programming error otherwise).
     */
    fun <T : Any> evaluate(op: String, hooks: Map<Stage, () -> T?>): T? {
        val applicable = STAGES[op] ?: throw IllegalArgumentException("unknown op")
        if (hooks.keys != applicable) throw IllegalStateException("hooks do not match the stages of the op")
        for (stage in ORDER) {
            if (stage !in applicable) continue
            val out = hooks.getValue(stage).invoke()
            if (out != null) return out
        }
        return null
    }
}
