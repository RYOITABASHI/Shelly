package expo.modules.terminalemulator

import java.security.MessageDigest
import org.json.JSONObject

/**
 * The pure half of the native drain for `service_control` and
 * `request_pipeline_refire` (background ingress, phase A). The script routes
 * both ops to `typed-requests/`; McpTypedOpConsumer answers them with this
 * decision instead of waiting for RN's poller, which stops while Shelly is in
 * the background.
 *
 * It reproduces RN's ladder (lib/mcp-server-bridge.ts serviceControlTool /
 * pipelineRefireTool) in RN's ORDER and with RN's codes and messages:
 *   arguments → epoch → setting (exec for service_control, typed ops for the
 *   re-fire) → deadline → STOP-ALL (a service start; every re-fire)
 *   → (1) always-allow rule → (2) "Skip all approvals" → (3) nobody to ask.
 * Step (3) differs only in where the dialog lives: when RN is live (fresh
 * bridge heartbeat = Shelly in the foreground) and the request is fresh, the
 * request is handed to RN (McpHandoffMove + single-use token, as run_agent),
 * and RN runs its whole ladder again and shows McpApprovalModal; otherwise it
 * is `not_attended` at once, exactly what RN answers in the background.
 *
 * This order is not IngressDecision.ORDER (that puts the setting before the
 * arguments): RN checks the arguments first, and the outcome when several
 * refusals apply at once must stay the same, so the op is not in that table.
 *
 * No Android dependency: the JVM tests (ServiceControlDecisionTest) cover all
 * of it, and __tests__/mcp-service-control-native-parity.test.ts pins the
 * messages, the lists and the binding against the TS sources.
 */
object ServiceControlDecision {
    const val OP_SERVICE_CONTROL = "service_control"
    const val OP_PIPELINE_REFIRE = "request_pipeline_refire"
    val OPS: Set<String> = setOf(OP_SERVICE_CONTROL, OP_PIPELINE_REFIRE)

    /** lib/mcp-typed-ops.ts TYPED_REQUEST_DEADLINE_MS (= the script's RESULT_TIMEOUT_MS). */
    const val DEADLINE_MS = 100_000L

    // ── Lists (keep in step with lib/mcp-service-control.ts / ManagedServices) ──

    /** SERVICE_CONTROL_ACTIONS, in its order (the message lists them). */
    val ACTIONS: List<String> = listOf("start", "status", "stop")
    /** SERVICE_IDS, in its order. */
    val SERVICE_IDS: List<String> = listOf("article-delivery", "council-facade")
    val SERVICE_STATES: Set<String> = setOf("running", "starting", "unhealthy", "stopped", "dead", "not_configured")
    val SERVICE_RESULT_CODES: Set<String> = setOf(
        "started", "already_running", "stopped", "not_running", "status", "halted",
        "not_configured", "not_installed", "launch_failed", "stop_failed",
    )
    /** SERVICE_FAILURE_CODES: the action did not happen (an MCP error with the status attached). */
    val SERVICE_FAILURE_CODES: Set<String> = setOf("halted", "not_configured", "not_installed", "launch_failed", "stop_failed")

    /** lib/mcp-pipeline-refire.ts */
    val PIPELINE_ID_RE = Regex("^[a-z0-9-]{1,32}$")
    val REFIRE_ACCEPT_CODES: Set<String> = setOf("accepted", "duplicate")
    val REFIRE_NATIVE_REFUSALS: Set<String> = setOf(
        "invalid_params", "halted", "unknown_pipeline", "not_opted_in", "no_run_today", "run_active",
        "delivered", "not_recoverable", "daily_limit", "audit_unreadable", "not_recorded", "native_error",
    )
    private val REFIRE_REQUEST_ID_RE = Regex("^rq-[0-9]{1,16}-[0-9a-f]{8}$")

    const val SERVICE_CONTROL_BIND_DOMAIN = "shelly-service-control-bind-v2:"
    const val PIPELINE_REFIRE_BIND_DOMAIN = "shelly-pipeline-refire-bind-v1:"

    // ── Messages (verbatim from lib/mcp-server-bridge.ts) ──────────────────

    const val REVOKED_ERROR = "cancelled: pending MCP requests were revoked"
    const val EXEC_DISABLED_ERROR = "exec/write tools are disabled (Settings → Agents → MCP: Allow exec/write)"
    const val EXPIRED_BEFORE_APPROVAL = "the request expired before it could be shown for approval"
    const val EXPIRED_BEFORE_RUN = "the request expired before it could run"
    const val HALTED_MESSAGE = "all agents are stopped (STOP-ALL is on)"
    const val NOT_ATTENDED_MESSAGE = "Shelly is not in the foreground on the phone and no always-allow rule matches; nobody can approve this now"
    const val SERVICE_RULE_GONE = "the always-allow rule no longer applies (removed, or the rules became unreadable); call service_control again"
    const val REFIRE_RULE_GONE = "the always-allow rule no longer applies (removed, or the rules became unreadable); call request_pipeline_refire again"
    const val SERVICE_NATIVE_ERROR = "could not control the service"
    const val SERVICE_STATE_UNREADABLE = "could not read the service state"
    const val REFIRE_NATIVE_ERROR = "could not request the re-run"
    const val REFIRE_OUTCOME_UNREADABLE = "could not read the re-run request outcome"
    const val HANDOFF_FAILED_MESSAGE = "Shelly could not pass the request to the app for approval (internal file move failed); nothing was run"

    // ── Arguments ─────────────────────────────────────────────────────────

    sealed class Args {
        abstract val op: String
        /** The always-allow target (serviceControlRuleTarget / pipelineRefireRuleTarget). */
        abstract val target: String

        data class Service(val action: String, val serviceId: String) : Args() {
            override val op: String get() = OP_SERVICE_CONTROL
            override val target: String get() = "service:$serviceId:$action"
        }

        data class Refire(val pipelineId: String) : Args() {
            override val op: String get() = OP_PIPELINE_REFIRE
            override val target: String get() = "pipeline:$pipelineId"
        }
    }

    /** One refusal: the result code and message, and the audit code (null = no line). */
    data class Refusal(val code: String, val message: String)

    private fun firstExtraKey(args: JSONObject, allowed: Set<String>): String? {
        val it = args.keys()
        while (it.hasNext()) {
            val k = it.next()
            if (k !in allowed) return k
        }
        return null
    }

    /** JS `String.prototype.slice(0, 40)`: 40 UTF-16 code units, as Kotlin's take. */
    private fun unknownArgument(k: String) = Refusal("invalid_params", "unknown argument: ${k.take(40)}")

    /** validateServiceControlArgs: exactly {action, serviceId}, checked in that order. */
    fun validateService(args: JSONObject): Any /* Args.Service | Refusal */ {
        firstExtraKey(args, setOf("action", "serviceId"))?.let { return unknownArgument(it) }
        val action = args.opt("action") as? String
        if (action == null || action !in ACTIONS) return Refusal("invalid_params", "action must be one of: ${ACTIONS.joinToString(", ")}")
        val serviceId = args.opt("serviceId") as? String
        if (serviceId == null || serviceId !in SERVICE_IDS) return Refusal("invalid_params", "serviceId must be one of: ${SERVICE_IDS.joinToString(", ")}")
        return Args.Service(action, serviceId)
    }

    /** validatePipelineRefireArgs: exactly {pipelineId}. */
    fun validateRefire(args: JSONObject): Any /* Args.Refire | Refusal */ {
        firstExtraKey(args, setOf("pipelineId"))?.let { return unknownArgument(it) }
        val id = args.opt("pipelineId") as? String
        if (id == null || !PIPELINE_ID_RE.matches(id)) {
            return Refusal("invalid_params", "pipelineId must be an article pipeline id (a-z, 0-9, -; 1-32 characters)")
        }
        return Args.Refire(id)
    }

    fun validate(tool: String, args: JSONObject): Any = when (tool) {
        OP_SERVICE_CONTROL -> validateService(args)
        OP_PIPELINE_REFIRE -> validateRefire(args)
        else -> Refusal("invalid_params", "unknown tool: ${tool.take(40)}")
    }

    /** serviceControlRuleBind / pipelineRefireRuleBind: sha256 hex of domain + target. */
    fun ruleBind(a: Args): String {
        val domain = if (a is Args.Service) SERVICE_CONTROL_BIND_DOMAIN else PIPELINE_REFIRE_BIND_DOMAIN
        val d = MessageDigest.getInstance("SHA-256").digest("$domain${a.target}".toByteArray(Charsets.UTF_8))
        return d.joinToString("") { "%02x".format(it) }
    }

    // ── Decision ──────────────────────────────────────────────────────────

    /** The facts, read lazily and in order. Implementations must not throw (fail closed inside). */
    interface Steps {
        fun epochCurrent(): Boolean
        /** service_control: RN's settings.mcpExecEnabled (natively: the server's switch and the Keystore mirror). */
        fun execOn(): Boolean
        /** request_pipeline_refire: settings.mcpTypedOpsEnabled (same two halves). */
        fun typedOpsOn(): Boolean
        /** STOP-ALL: `.halted` present or uncheckable. */
        fun halted(): Boolean
        /** The id of the always-allow rule matching (principal, op, target, bind), or null. */
        fun matchRule(principal: String, op: String, target: String, bind: String): String?
        /** "Skip all approvals" (ApproveAllStore). */
        fun approveAllOn(): Boolean
        /** The RN bridge heartbeat is fresh (Shelly in the foreground, poller running). */
        fun rnLive(): Boolean
    }

    enum class Via { RULE, SWITCH }

    sealed class Outcome {
        /**
         * Answer with an error result. [audit]: write the op's line with
         * [Refusal.code] ([args] null = no action / id / pipeline on it).
         * RN writes no line for an argument refusal that is also revoked.
         */
        data class Refuse(val refusal: Refusal, val args: Args?, val audit: Boolean = true) : Outcome()
        /** A rule or the switch cleared it. [auditCode]: `always_allowed` / `auto_approved`. */
        data class Execute(val args: Args, val via: Via, val ruleId: String?, val bind: String, val auditCode: String) : Outcome()
        /** Nobody here decided and RN is live: move the original file into requests/. */
        data class Handoff(val args: Args) : Outcome()
    }

    fun isExpired(receivedAtMs: Long, nowMs: Long): Boolean = nowMs >= receivedAtMs + DEADLINE_MS

    private fun settingRefusal(a: Args, s: Steps): Refusal? = when (a) {
        is Args.Service -> if (!s.execOn()) Refusal("disabled", EXEC_DISABLED_ERROR) else null
        is Args.Refire -> if (!s.typedOpsOn()) Refusal("disabled", McpTypedOpDecision.TYPED_OPS_DISABLED_MESSAGE) else null
    }

    /** STOP-ALL refuses a service start and every re-fire (status / stop still go through). */
    private fun stopAllApplies(a: Args): Boolean = a is Args.Refire || (a is Args.Service && a.action == "start")

    private val REVOKED = Refusal("revoked", REVOKED_ERROR)

    fun decide(req: McpTypedOpDecision.Request, s: Steps, nowMs: Long): Outcome {
        val parsed = validate(req.tool, req.args)
        if (parsed is Refusal) {
            return if (!s.epochCurrent()) Outcome.Refuse(REVOKED, null, audit = false) else Outcome.Refuse(parsed, null)
        }
        val a = parsed as Args
        if (!s.epochCurrent()) return Outcome.Refuse(REVOKED, a)
        settingRefusal(a, s)?.let { return Outcome.Refuse(it, a) }
        if (isExpired(req.receivedAtMs, nowMs)) return Outcome.Refuse(Refusal("timeout", EXPIRED_BEFORE_APPROVAL), a)
        if (stopAllApplies(a) && s.halted()) return Outcome.Refuse(Refusal("halted", HALTED_MESSAGE), a)

        val bind = ruleBind(a)
        // 1. always-allow rule (only after every refusal class above).
        s.matchRule(req.principal, a.op, a.target, bind)?.let { return Outcome.Execute(a, Via.RULE, it, bind, "always_allowed") }
        // 2. "Skip all approvals": a one-time 'once', no rule written.
        if (s.approveAllOn()) return Outcome.Execute(a, Via.SWITCH, null, bind, "auto_approved")
        // 3. Nobody here to ask: RN (and its dialog) when it is live, else at once.
        val fresh = nowMs - req.receivedAtMs <= McpTypedOpDecision.HANDOFF_MAX_AGE_MS
        if (fresh && s.rnLive()) return Outcome.Handoff(a)
        return Outcome.Refuse(Refusal("not_attended", NOT_ATTENDED_MESSAGE), a)
    }

    /**
     * RN's execute(): every check the authorization relied on, in RN's order,
     * right before the native call. Null when it may run.
     */
    fun recheck(req: McpTypedOpDecision.Request, x: Outcome.Execute, s: Steps, nowMs: Long): Refusal? {
        val a = x.args
        if (x.via == Via.RULE && s.matchRule(req.principal, a.op, a.target, x.bind) != x.ruleId) {
            return Refusal("target_changed", if (a is Args.Service) SERVICE_RULE_GONE else REFIRE_RULE_GONE)
        }
        settingRefusal(a, s)?.let { return it }
        if (stopAllApplies(a) && s.halted()) return Refusal("halted", HALTED_MESSAGE)
        if (!s.epochCurrent()) return REVOKED
        if (isExpired(req.receivedAtMs, nowMs)) return Refusal("timeout", EXPIRED_BEFORE_RUN)
        return null
    }

    // ── Results (exactly the RN bridge's JSON.stringify(ToolResult)) ───────

    /** Built by hand (as the other results here) so the bytes do not depend on which org.json runs. */
    fun errorResult(r: Refusal): String = "{\"ok\":false,\"error\":${jsonString(r.message)},\"code\":${jsonString(r.code)}}"

    /** What the native supervisor returned, checked as parseServiceControlResult does. */
    data class ServiceStatus(
        val code: String,
        val serviceId: String,
        val state: String,
        val pid: Long?,
        val startedAt: Long?,
        val lastHeartbeatAt: Long?,
        val supervised: Boolean,
        val exitCode: Long?,
        val exitedAt: Long?,
    )

    private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991L

    /** Number.isSafeInteger for what native puts in the map (Int / Long only). */
    private fun safeInt(v: Any?): Long? = when (v) {
        is Int -> v.toLong()
        is Long -> if (v in -MAX_SAFE_INTEGER..MAX_SAFE_INTEGER) v else null
        else -> null
    }

    private object Bad

    /** nullableTime: null/absent → null; a non-negative safe integer → it; else [Bad]. */
    private fun nullableTime(v: Any?): Any? {
        if (v == null) return null
        val n = safeInt(v) ?: return Bad
        return if (n >= 0) n else Bad
    }

    /** parseServiceControlResult. Null when anything is off (→ native_error). */
    fun parseServiceResult(raw: Map<String, Any?>?, expectedId: String): ServiceStatus? {
        if (raw == null) return null
        val code = raw["code"] as? String ?: return null
        if (code !in SERVICE_RESULT_CODES) return null
        if (raw["serviceId"] != expectedId) return null
        val state = raw["state"] as? String ?: return null
        if (state !in SERVICE_STATES) return null
        val pidRaw = raw["pid"]
        val pid = if (pidRaw == null) null else (safeInt(pidRaw)?.takeIf { it > 1 } ?: return null)
        val s = nullableTime(raw["startedAt"])
        val hb = nullableTime(raw["lastHeartbeatAt"])
        if (s === Bad || hb === Bad) return null
        val supervised = raw["supervised"] as? Boolean ?: return null
        val exitRaw = raw["exitCode"]
        val exitCode = if (exitRaw == null) null else (safeInt(exitRaw) ?: return null)
        val exitedRaw = raw["exitedAt"]
        val exitedAt = if (exitedRaw == null) null else ((nullableTime(exitedRaw) as? Long) ?: return null)
        return ServiceStatus(code, expectedId, state, pid, s as Long?, hb as Long?, supervised, exitCode, exitedAt)
    }

    private fun jsonString(s: String): String {
        val b = StringBuilder("\"")
        for (c in s) {
            when {
                c == '"' -> b.append("\\\"")
                c == '\\' -> b.append("\\\\")
                c == '\n' -> b.append("\\n")
                c == '\r' -> b.append("\\r")
                c == '\t' -> b.append("\\t")
                c == '\b' -> b.append("\\b")
                c == '\u000c' -> b.append("\\f")
                c < ' ' -> b.append(String.format("\\u%04x", c.code))
                else -> b.append(c)
            }
        }
        return b.append('"').toString()
    }

    /** `JSON.stringify(parsed.status)`: RN's key order, optional exit fields only when set. */
    fun statusJson(st: ServiceStatus): String {
        val parts = mutableListOf(
            "\"serviceId\":${jsonString(st.serviceId)}",
            "\"state\":${jsonString(st.state)}",
            "\"pid\":${st.pid ?: "null"}",
            "\"startedAt\":${st.startedAt ?: "null"}",
            "\"lastHeartbeatAt\":${st.lastHeartbeatAt ?: "null"}",
            "\"supervised\":${st.supervised}",
        )
        if (st.exitCode != null) parts.add("\"exitCode\":${st.exitCode}")
        if (st.exitedAt != null) parts.add("\"exitedAt\":${st.exitedAt}")
        return parts.joinToString(",", "{", "}")
    }

    /**
     * The answer after the native call: `{ok:true, data:{action, code, ...status}}`,
     * or for a failure code `{ok:false, error:"<action> <id>: <code> <status json>", code}`.
     */
    fun serviceResult(action: String, st: ServiceStatus): String {
        if (st.code in SERVICE_FAILURE_CODES) {
            return errorResult(Refusal(st.code, "$action ${st.serviceId}: ${st.code} ${statusJson(st)}"))
        }
        return "{\"ok\":true,\"data\":{\"action\":${jsonString(action)},\"code\":${jsonString(st.code)},${statusJson(st).removePrefix("{")}}"
    }

    data class RefireAnswer(val code: String, val requestId: String?)

    /** parsePipelineRefireResult. Null when anything is off (→ native_error). */
    fun parseRefireResult(code: String?, requestId: String?): RefireAnswer? {
        if (code == null || (code !in REFIRE_ACCEPT_CODES && code !in REFIRE_NATIVE_REFUSALS)) return null
        if (requestId != null && !REFIRE_REQUEST_ID_RE.matches(requestId)) return null
        return RefireAnswer(code, requestId)
    }

    fun isRefireAccepted(code: String): Boolean = code in REFIRE_ACCEPT_CODES

    /** A refused re-run (RN: `re-run of <id> refused: <code>`). */
    fun refireRefusal(pipelineId: String, code: String) = Refusal(code, "re-run of $pipelineId refused: $code")

    /** `{ok:true, data:{pipelineId, code, requestId}}` (requestId null when native gave none). */
    fun refireResult(pipelineId: String, a: RefireAnswer): String =
        "{\"ok\":true,\"data\":{\"pipelineId\":${jsonString(pipelineId)},\"code\":${jsonString(a.code)},\"requestId\":${a.requestId?.let { jsonString(it) } ?: "null"}}}"
}
