package expo.modules.terminalemulator

import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

/**
 * The pure half of the headless typed-op consumer (McpTypedOpConsumer.kt,
 * PR 6): request verification, the RN-liveness check, the orphan rule and
 * the run_agent decision order. No Android dependency, so the JVM tests
 * (McpTypedOpDecisionTest) cover all of it.
 *
 * After setting / arguments / epoch / target / STOP-ALL / definition taint,
 * first check action consent bound to the exact verified policy snapshot.
 * Without it, use the conservative legacy step 7 and dialog-only rule path.
 * A changed/unverified policy cannot use action consent; RN may ask again.
 */
object McpTypedOpDecision {
    // ── Request verification (lib/mcp-request-auth.ts verifyMcpRequest) ────

    private val MAC_RE = Regex("^[0-9a-f]{64}$")
    private val BRIDGE_KEY_RE = Regex("^[0-9a-f]{64}$")
    private val CALL_ID_RE = Regex("^[0-9A-Za-z-]{1,64}$")
    private val PRINCIPAL_RE = Regex("^[0-9a-f]{32}$")
    private val AGENT_ID_RE = Regex("^[A-Za-z0-9_-]{1,128}$")
    private val REQUEST_ID_RE = Regex("^[A-Za-z0-9_-]{8,64}$")

    /** A request file name the consumer claims (the script's `${callId}.json`; never `.tmp`). */
    val REQUEST_FILE_RE = Regex("^[0-9A-Za-z-]{1,64}\\.json$")

    /**
     * Typed requests are answered within the script's RESULT_TIMEOUT_MS
     * (100 s) or never: an older request's client has given up, so it is
     * dropped unanswered instead of run late (stricter than RN's 10 min,
     * which is for replay only). Future tolerance as RN.
     */
    const val MAX_REQUEST_AGE_MS = 100_000L
    const val FUTURE_TOLERANCE_MS = 60_000L
    /** A no-match older than this is not handed to RN (it would only stall; plan addendum §3.6). */
    const val HANDOFF_MAX_AGE_MS = 5_000L
    /** Heartbeat freshness (plan addendum §3.6). */
    const val HEARTBEAT_LIVE_MS = 2_000L
    const val HEARTBEAT_FUTURE_MS = 1_000L
    /** claimed/ files older than this are orphans (> the script's 100 s RESULT_TIMEOUT_MS). */
    const val ORPHAN_AGE_MS = 120_000L

    data class Request(
        val callId: String,
        val tool: String,
        val args: JSONObject,
        val principal: String,
        val receivedAtMs: Long,
    )

    sealed class Parsed {
        data class Ok(val request: Request) : Parsed()
        /** Dropped without an answer (RN's processRequestFile drops these too). [reason] is an audit code. */
        data class Drop(val reason: String) : Parsed()
    }

    /** hex(HMAC-SHA256(utf8(bridgeKey), utf8(message))). */
    fun hmacHex(bridgeKey: String, message: String): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(bridgeKey.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        return mac.doFinal(message.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    /**
     * lib/mcp-request-auth.ts mcpHandoffToken: the single-use proof, written to
     * `handoffs/<callId>` before a handoff, that RN requires (and consumes)
     * before it runs a typed op from requests/.
     */
    fun handoffToken(bridgeKey: String, callId: String): String = hmacHex(bridgeKey, "shelly-mcp-handoff-v1:$callId")

    /** mcpRequestMac: the MAC over canonicalJson of the request without `mac`. */
    fun requestMac(bridgeKey: String, request: JSONObject): String {
        val unsigned = JSONObject()
        val it = request.keys()
        while (it.hasNext()) {
            val k = it.next()
            if (k != "mac") unsigned.put(k, request.opt(k))
        }
        return hmacHex(bridgeKey, McpAgentBinding.canonicalJson(unsigned))
    }

    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) return false
        var diff = 0
        for (i in a.indices) diff = diff or (a[i].code xor b[i].code)
        return diff == 0
    }

    /** The script's `new Date().toISOString()` form only (strict; anything else is not fresh). */
    fun parseIsoMs(s: String): Long? {
        if (!Regex("^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$").matches(s)) return null
        return try {
            val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            fmt.timeZone = TimeZone.getTimeZone("UTC")
            fmt.isLenient = false
            val pos = ParsePosition(0)
            val d = fmt.parse(s, pos) ?: return null
            if (pos.index != s.length) null else d.time
        } catch (e: Exception) {
            null
        }
    }

    /**
     * verifyMcpRequest, in its order: MAC first (a file not signed with this
     * server's bridge key is `bad_mac`), then callId / file name, freshness,
     * replay ([seen]: callIds this consumer already accepted), the fields.
     * Never throws.
     */
    fun parseRequest(text: String, fileName: String, bridgeKey: String, nowMs: Long, seen: (String) -> Boolean): Parsed {
        return try {
            if (!BRIDGE_KEY_RE.matches(bridgeKey)) return Parsed.Drop("no_key")
            val o = try { JSONObject(text) } catch (e: Exception) { return Parsed.Drop("bad_mac") }
            val mac = o.opt("mac") as? String
            if (mac == null || !MAC_RE.matches(mac)) return Parsed.Drop("bad_mac")
            if (!constantTimeEquals(requestMac(bridgeKey, o), mac)) return Parsed.Drop("bad_mac")
            val callId = o.opt("callId") as? String
            if (callId == null || !CALL_ID_RE.matches(callId)) return Parsed.Drop("bad_request")
            if (fileName != "$callId.json") return Parsed.Drop("bad_request")
            val received = (o.opt("receivedAt") as? String)?.let { parseIsoMs(it) } ?: return Parsed.Drop("stale")
            if (received > nowMs + FUTURE_TOLERANCE_MS || nowMs - received > MAX_REQUEST_AGE_MS) return Parsed.Drop("stale")
            if (seen(callId)) return Parsed.Drop("replay")
            val tool = o.opt("tool") as? String
            if (tool.isNullOrEmpty()) return Parsed.Drop("bad_request")
            val rawArgs = if (o.has("args")) o.opt("args") else null
            val args = when {
                rawArgs == null -> JSONObject()
                rawArgs is JSONObject -> rawArgs
                else -> return Parsed.Drop("bad_request")
            }
            val ingress = o.opt("ingress") as? JSONObject ?: return Parsed.Drop("bad_request")
            if (ingress.opt("kind") != "mcp") return Parsed.Drop("bad_request")
            val principal = ingress.opt("principal") as? String
            if (principal == null || !PRINCIPAL_RE.matches(principal)) return Parsed.Drop("bad_request")
            Parsed.Ok(Request(callId, tool, args, principal, received))
        } catch (e: Exception) {
            Parsed.Drop("bad_request")
        }
    }

    // ── RN liveness and orphans ───────────────────────────────────────────

    /**
     * The bridge heartbeat (lib/mcp-server-bridge.ts writeBridgeHeartbeat):
     * live iff it is a plain decimal epoch-ms, not more than 1 s in the future
     * and less than 2 s old. Missing (null), torn, `0`, stale: not live.
     */
    fun isRnLive(heartbeat: String?, nowMs: Long): Boolean {
        val t = heartbeat?.trim() ?: return false
        if (!Regex("^[0-9]{1,15}$").matches(t)) return false
        val v = t.toLongOrNull() ?: return false
        if (v <= 0L || v > nowMs + HEARTBEAT_FUTURE_MS) return false
        return nowMs - v < HEARTBEAT_LIVE_MS
    }

    /** A claimed/ file is an orphan only when its mtime is known and older than [ORPHAN_AGE_MS]. */
    fun isOrphan(mtimeMs: Long, nowMs: Long): Boolean = mtimeMs > 0L && nowMs - mtimeMs > ORPHAN_AGE_MS

    // ── Decision ──────────────────────────────────────────────────────────

    data class Refusal(val code: String, val message: String)

    const val TYPED_OPS_DISABLED_MESSAGE = "typed operations are disabled (Settings → Agents → MCP: Allow typed operations)"
    val DISABLED = Refusal("disabled", TYPED_OPS_DISABLED_MESSAGE)
    val REVOKED = Refusal("revoked", "cancelled: the MCP token is no longer valid")
    val UNKNOWN_AGENT = Refusal("unknown_agent", "no enabled agent with that id (see list_agents)")
    val HALTED = Refusal("halted", "all agents are stopped (STOP-ALL is on)")
    val TAINTED = Refusal("tainted", "this agent was created or changed over MCP (or the ingress-mark store is unreadable); it is not started over MCP")
    val POLICY_DENIED = Refusal("policy_denied", "refused by your agent safety rules (deny) for this agent's actions")
    val NOT_ATTENDED = Refusal("not_attended", "Shelly is not in the foreground on the phone and no always-allow rule matches; nobody can approve this now")
    /**
     * RN was live and the request was to be handed to it, but the move into
     * requests/ failed (McpHandoffMove.Result.Failed; the errno is in logcat
     * and the audit line). Never reported as [NOT_ATTENDED]: that one means
     * nobody was there to approve, this one means Shelly could not pass the
     * request on.
     */
    val HANDOFF_FAILED = Refusal("handoff_failed", "Shelly could not pass the request to the app for approval (internal file move failed); nothing was started")
    val TARGET_CHANGED = Refusal("target_changed", "the agent was edited before the run could start; call run_agent again")
    val BUSY = Refusal("busy", "this client already has ${McpRunTickets.MAX_LIVE_RUNS_PER_PRINCIPAL} runs queued or running; poll get_run_result and retry later")
    val LAUNCH_FAILED = Refusal("launch_failed", "the run could not be started")
    val AUDIT_FAILED = Refusal("launch_failed", "the run was not started: its audit line could not be written")
    val REQUEST_ID_REUSED = Refusal("invalid_params", "requestId was already used for another agent")
    /** lib/mcp-server-bridge.ts EXPIRED: the client's 100 s wait ended before the launch. */
    val EXPIRED = Refusal("approval_timeout", "the request expired before the run could start")

    /** Past the client's wait (receivedAt + [MAX_REQUEST_AGE_MS]). */
    fun isExpired(receivedAtMs: Long, nowMs: Long): Boolean = nowMs - receivedAtMs > MAX_REQUEST_AGE_MS

    data class RunAgentArgs(val agentId: String, val requestId: String?)

    /** validateRunAgentArgs (lib/mcp-typed-ops.ts): exactly agentId and optional requestId. */
    fun validateArgs(args: JSONObject): Any /* RunAgentArgs | Refusal */ {
        fun bad(m: String) = Refusal("invalid_params", m)
        val it = args.keys()
        while (it.hasNext()) {
            val k = it.next()
            if (k != "agentId" && k != "requestId") return bad("unknown argument: ${k.take(40)}")
        }
        val agentId = args.opt("agentId") as? String
        if (agentId == null || !AGENT_ID_RE.matches(agentId)) return bad("agentId must match ^[A-Za-z0-9_-]{1,128}$")
        val rawReq = if (args.has("requestId")) args.opt("requestId") else null
        if (rawReq != null) {
            val r = rawReq as? String
            if (r == null || !REQUEST_ID_RE.matches(r)) return bad("requestId must match ^[A-Za-z0-9_-]{8,64}$")
            return RunAgentArgs(agentId, r)
        }
        return RunAgentArgs(agentId, null)
    }

    /** The facts, read lazily and in order. Implementations must not throw (fail closed inside). */
    interface Steps {
        fun typedOpsOn(): Boolean
        fun epochCurrent(): Boolean
        /** `~/.shelly/agents/<id>.json` with a matching id and `enabled: true`, else null. */
        fun resolveAgent(agentId: String): JSONObject?
        fun halted(): Boolean
        fun tainted(agentId: String): Boolean
        fun actionRule(principal: String, target: String, bind: String): String? = null
        fun step7(agent: JSONObject): McpTypedOpPolicy.Decision
        /** McpRunTickets.findIdempotent for this principal (read only), or null. */
        fun existingTicket(principal: String, requestId: String): McpRunTickets.Ticket?
        /** The id of the always-allow rule matching (principal, run_agent, target, bind), or null. */
        fun matchRule(principal: String, target: String, bind: String): String?
        fun rnLive(): Boolean
    }

    sealed class Outcome {
        /** Answer with an error result. [taint]: audit as `ingress_tainted_refused`. */
        data class Refuse(val refusal: Refusal, val agentId: String?, val taint: Boolean = false) : Outcome()
        /** A repeated requestId: answer with this run, launch nothing. */
        data class Existing(val agentId: String, val ticket: McpRunTickets.Ticket) : Outcome()
        /** A rule matched a fully cleared request: audit, then launch. */
        data class Execute(val agentId: String, val requestId: String?, val ruleId: String, val target: String, val bind: String) : Outcome()
        /** No match / undecidable, RN live: move the original file into requests/; never answer it here. */
        data class Handoff(val agentId: String?) : Outcome()
    }

    /**
     * run_agent's decision, through the shared stage order
     * (IngressDecision.evaluate, op run_agent). The stages and what each
     * returns are unchanged from before the generalisation.
     */
    fun decide(req: Request, s: Steps, nowMs: Long): Outcome {
        val ageMs = nowMs - req.receivedAtMs
        fun noMatch(agentId: String): Outcome =
            if (ageMs <= HANDOFF_MAX_AGE_MS && s.rnLive()) Outcome.Handoff(agentId) else Outcome.Refuse(NOT_ATTENDED, agentId)

        // Filled in by the stages, in order; a later stage runs only after the one that sets it.
        var args: RunAgentArgs? = null
        var agent: JSONObject? = null
        var bind: String? = null
        fun agentId(): String = args!!.agentId
        fun target(): String = "agent:${agentId()}"

        val hooks: Map<IngressDecision.Stage, () -> Outcome?> = mapOf(
            // 1. setting
            IngressDecision.Stage.SETTING to { if (!s.typedOpsOn()) Outcome.Refuse(DISABLED, null) else null },
            // 2. arguments (strict). The script routes only run_agent here.
            IngressDecision.Stage.ARGS to {
                if (req.tool != "run_agent") {
                    Outcome.Refuse(Refusal("invalid_params", "unknown tool: ${req.tool.take(40)}"), null)
                } else {
                    val parsed = validateArgs(req.args)
                    if (parsed is Refusal) Outcome.Refuse(parsed, null) else { args = parsed as RunAgentArgs; null }
                }
            },
            // 3. epoch
            IngressDecision.Stage.EPOCH to { if (!s.epochCurrent()) Outcome.Refuse(REVOKED, agentId()) else null },
            // 4. target
            IngressDecision.Stage.TARGET to {
                val a = s.resolveAgent(agentId())
                if (a == null) Outcome.Refuse(UNKNOWN_AGENT, agentId()) else { agent = a; null }
            },
            // 5. STOP-ALL
            IngressDecision.Stage.STOP_ALL to { if (s.halted()) Outcome.Refuse(HALTED, agentId()) else null },
            // 6. taint (audited as ingress_tainted_refused)
            IngressDecision.Stage.TAINT to { if (s.tainted(agentId())) Outcome.Refuse(TAINTED, agentId(), taint = true) else null },
            // RN already evaluated this exact binding against this exact sealed policy.
            // STOP-ALL and definition taint still precede every kind of consent.
            IngressDecision.Stage.ACTION_CONSENT to {
                val b = try { McpAgentBinding.bindingHash(agent!!) } catch (e: Exception) { null }
                if (b == null) {
                    noMatch(agentId())
                } else {
                    bind = b
                    val actionRuleId = s.actionRule(req.principal, target(), b)
                    if (actionRuleId == null) {
                        null
                    } else {
                        val requestId = args!!.requestId
                        val existing = if (requestId != null) s.existingTicket(req.principal, requestId) else null
                        if (existing != null) Outcome.Existing(agentId(), existing) else Outcome.Execute(agentId(), requestId, actionRuleId, target(), b)
                    }
                }
            },
            // 7. Legacy dialog-only rule: conservative native evaluation.
            IngressDecision.Stage.STEP7 to {
                when (s.step7(agent!!)) {
                    McpTypedOpPolicy.Decision.POLICY_DENIED -> Outcome.Refuse(POLICY_DENIED, agentId())
                    McpTypedOpPolicy.Decision.UNDECIDABLE -> noMatch(agentId())
                    McpTypedOpPolicy.Decision.CLEARABLE -> null
                }
            },
            // A repeated requestId returns the existing run (RN does the same before the rule).
            IngressDecision.Stage.IDEMPOTENT to {
                val requestId = args!!.requestId
                val existing = if (requestId != null) s.existingTicket(req.principal, requestId) else null
                if (existing != null) Outcome.Existing(agentId(), existing) else null
            },
            // 8. always-allow rule — only now, after every deny class.
            IngressDecision.Stage.ALWAYS_ALLOW to {
                val ruleId = s.matchRule(req.principal, target(), bind!!)
                if (ruleId == null) noMatch(agentId()) else Outcome.Execute(agentId(), args!!.requestId, ruleId, target(), bind!!)
            },
        )
        // ALWAYS_ALLOW always answers, so null never reaches here; fail closed if it did.
        return IngressDecision.evaluate(IngressDecision.OP_RUN_AGENT, hooks) ?: Outcome.Refuse(NOT_ATTENDED, args?.agentId)
    }

    // ── Result files (exactly the RN bridge's JSON.stringify(ToolResult)) ──

    fun errorResult(r: Refusal): String = JSONObject().put("ok", false).put("error", r.message).put("code", r.code).toString()

    fun startedResult(handle: String, agentId: String, requestId: String?): String {
        val data = JSONObject().put("runHandle", handle).put("agentId", agentId).put("state", "accepted").put("untrusted", true)
        if (requestId != null) data.put("requestId", requestId)
        return JSONObject().put("ok", true).put("data", data).toString()
    }

    /** existingRunResult (lib/mcp-server-bridge.ts). */
    fun existingResult(t: McpRunTickets.Ticket, agentId: String): String {
        if (t.agentId != agentId) return errorResult(REQUEST_ID_REUSED)
        val data = JSONObject().put("runHandle", t.handle).put("agentId", t.agentId).put("state", t.state)
        if (t.requestId != null) data.put("requestId", t.requestId)
        data.put("existing", true).put("untrusted", true)
        return JSONObject().put("ok", true).put("data", data).toString()
    }
}
