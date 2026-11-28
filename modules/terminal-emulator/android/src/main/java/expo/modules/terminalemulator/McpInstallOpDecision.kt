package expo.modules.terminalemulator

import org.json.JSONArray
import org.json.JSONObject

/**
 * The pure half of the native drain for `update_delivery_script` and
 * `update_pipeline_config` (background ingress, phase B-2). The script routes
 * both ops to `typed-requests/`; McpTypedOpConsumer answers them with this
 * decision instead of letting the request wait in RN's queue, which RN does
 * not drain while Shelly is in the background.
 *
 * RN's ladder (lib/mcp-server-bridge.ts updateDeliveryScriptTool /
 * updatePipelineConfigTool), in RN's ORDER and with RN's codes, messages and
 * result JSON:
 *   epoch → setting (mcpExecEnabled) → arguments → pre-approval deadline
 *   (receivedAt + INSTALL_CLASS_PRE_APPROVAL_MS) → [content checks] → the tap.
 * Neither op has an always-allow rule or honors "Skip all approvals": RN
 * always asks (approveRawTool). So nothing here can approve, and the native
 * drain never writes the script or the config: past the deadline check the
 * request is handed to RN when RN is live (fresh bridge heartbeat) and the
 * request is fresh (≤ HANDOFF_MAX_AGE_MS), and RN runs its whole ladder again
 * (the content checks, the dialog, the write); otherwise it is `not_attended`
 * at once (before this drain the script answered `bridge_not_live` at enqueue).
 *
 * The content checks (staged file size / digest, the article-pipeline schema,
 * the rebuild pairs, the current config) are RN's only: they need Node and
 * the TS pipeline parser, and with nobody to tap the answer would be
 * `not_attended` anyway. They run unchanged after a handoff.
 *
 * No Android dependency: McpInstallOpDecisionTest covers it, and
 * __tests__/mcp-install-op-native-parity.test.ts replays the shared fixture
 * __tests__/fixtures/mcp-install-op-ladder-cases.json against the real RN ladder.
 */
object McpInstallOpDecision {
    const val OP_DELIVERY_SCRIPT = "update_delivery_script"
    const val OP_PIPELINE_CONFIG = "update_pipeline_config"
    val OPS: Set<String> = setOf(OP_DELIVERY_SCRIPT, OP_PIPELINE_CONFIG)

    /** lib/mcp-server-bridge.ts INSTALL_CLASS_PRE_APPROVAL_MS (RN's deadlineMs = receivedAt + this). */
    const val PRE_APPROVAL_MS = 15_000L
    /** update_delivery_script: expectedBytes 1..this. */
    const val DELIVERY_MAX_BYTES = 1_048_576L
    /** lib/agent-article-pipeline-file.ts ARTICLE_PIPELINE_FILE_MAX_BYTES (256 KiB). */
    const val PIPELINE_MAX_BYTES = 262_144L
    /** At most this many rebuild pairs (the native audit's ID-array cap). */
    const val MAX_REBUILD_PAIRS = 33

    /** The audit kind (= event) of each op, as RN writes it. */
    fun auditKind(op: String): String = if (op == OP_PIPELINE_CONFIG) "mcp_update_pipeline_config" else "mcp_update_delivery_script"

    // ── Messages (verbatim from lib/mcp-server-bridge.ts) ──────────────────

    const val REVOKED_ERROR = "cancelled: pending MCP requests were revoked"
    const val EXEC_DISABLED_ERROR = "exec/write tools are disabled (Settings → Agents → MCP: Allow exec/write)"
    const val DELIVERY_PATH_ERROR = "stagedPath must name a .js file directly under /sdcard/Download"
    const val PIPELINE_PATH_ERROR = "stagedPath must name a .json file directly under /sdcard/Download"
    const val DIGEST_ERROR = "expectedSha256 must be 64 lowercase hex digits"
    const val DELIVERY_SIZE_ERROR = "expectedBytes must be an integer from 1 to 1048576"
    const val PIPELINE_SIZE_ERROR = "expectedBytes must be an integer from 1 to 262144"
    const val REBUILD_TYPE_ERROR = "rebuild must be an array of agentId and pipelineId pairs"
    const val REBUILD_COUNT_ERROR = "rebuild must contain at most 33 pairs"
    const val PIPELINE_TIMEOUT_ERROR = "timed out: the result window expired before the update could be applied"
    /** Native only (RN shows its dialog instead): nobody can tap. */
    const val NOT_ATTENDED_MESSAGE = "Shelly is not in the foreground on the phone, and this update needs an approval tap there; nobody can approve it now (open Shelly and try again)"
    const val HANDOFF_FAILED_MESSAGE = "Shelly could not pass the request to the app for approval (internal file move failed); nothing was changed"

    // `/^\/sdcard\/Download\/[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` with Regex.matches (whole input:
    // a JS `$` without the m flag never matches before a trailing newline either).
    private val DELIVERY_PATH_RE = Regex("/sdcard/Download/[A-Za-z0-9][A-Za-z0-9._-]*\\.js")
    private val PIPELINE_PATH_RE = Regex("/sdcard/Download/[A-Za-z0-9][A-Za-z0-9._-]*\\.json")
    private val CONTROL_RE = Regex("[\\x00-\\x1f\\x7f]")
    private val SHA256_RE = Regex("[0-9a-f]{64}")

    data class Refusal(val code: String, val message: String)

    sealed class Outcome {
        /** Write the op's audit line with [auditCode], answer [result]. */
        data class Answer(val auditCode: String, val result: String) : Outcome()
        /** RN is live: move the original file into requests/ (with the handoff token). */
        object Handoff : Outcome()
    }

    interface Steps {
        fun epochCurrent(): Boolean
        /** RN's settings.mcpExecEnabled (natively: the server's switch and the Keystore mirror). */
        fun execOn(): Boolean
        /** The RN bridge heartbeat is fresh. */
        fun rnLive(): Boolean
    }

    private fun isString(v: Any?): Boolean = v is String

    /** JS: typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max. */
    private fun integerInRange(v: Any?, max: Long): Boolean {
        if (v !is Number) return false
        val d = v.toDouble()
        if (d.isNaN() || d.isInfinite() || d != Math.floor(d)) return false
        return d >= 1.0 && d <= max.toDouble()
    }

    private fun pathOk(v: Any?, re: Regex): Boolean =
        v is String && re.matches(v) && !v.contains("..") && !CONTROL_RE.containsMatchIn(v)

    private fun digestOk(v: Any?): Boolean = v is String && v.length == 64 && SHA256_RE.matches(v)

    /** RN's argument checks, in its order. Null when they pass. */
    fun validate(tool: String, args: JSONObject): Refusal? {
        val pipeline = tool == OP_PIPELINE_CONFIG
        val stagedPath = args.opt("stagedPath")
        if (!pathOk(stagedPath, if (pipeline) PIPELINE_PATH_RE else DELIVERY_PATH_RE)) {
            return Refusal("invalid_path", if (pipeline) PIPELINE_PATH_ERROR else DELIVERY_PATH_ERROR)
        }
        if (!digestOk(args.opt("expectedSha256"))) return Refusal("invalid_digest", DIGEST_ERROR)
        if (!integerInRange(args.opt("expectedBytes"), if (pipeline) PIPELINE_MAX_BYTES else DELIVERY_MAX_BYTES)) {
            return Refusal("invalid_size", if (pipeline) PIPELINE_SIZE_ERROR else DELIVERY_SIZE_ERROR)
        }
        if (pipeline) {
            val rebuild = args.opt("rebuild") as? JSONArray ?: return Refusal("invalid_rebuild", REBUILD_TYPE_ERROR)
            if (rebuild.length() > MAX_REBUILD_PAIRS) return Refusal("invalid_rebuild", REBUILD_COUNT_ERROR)
        }
        return null
    }

    fun isExpired(receivedAtMs: Long, nowMs: Long): Boolean = nowMs >= receivedAtMs + PRE_APPROVAL_MS

    /** RN's timeout(): update_delivery_script answers ok with status timeout; the config is an error. */
    fun timeoutResult(tool: String): String =
        if (tool == OP_PIPELINE_CONFIG) errorResult(Refusal("timeout", PIPELINE_TIMEOUT_ERROR))
        else "{\"ok\":true,\"data\":{\"status\":\"timeout\"}}"

    fun revokedResult(): String = errorResult(Refusal("revoked", REVOKED_ERROR))

    fun decide(req: McpTypedOpDecision.Request, s: Steps, nowMs: Long): Outcome {
        if (!s.epochCurrent()) return Outcome.Answer("revoked", revokedResult())
        if (!s.execOn()) return refuse(Refusal("disabled", EXEC_DISABLED_ERROR))
        validate(req.tool, req.args)?.let { return refuse(it) }
        if (isExpired(req.receivedAtMs, nowMs)) return Outcome.Answer("timeout", timeoutResult(req.tool))
        // RN would now run its content checks and ask. Only RN can ask.
        val fresh = nowMs - req.receivedAtMs <= McpTypedOpDecision.HANDOFF_MAX_AGE_MS
        if (fresh && s.rnLive()) return Outcome.Handoff
        return refuse(Refusal("not_attended", NOT_ATTENDED_MESSAGE))
    }

    private fun refuse(r: Refusal) = Outcome.Answer(r.code, errorResult(r))

    /**
     * RN's refuse(): the line with the code is written first; if the epoch
     * ended meanwhile the answer is `revoked`, and update_delivery_script
     * (whose refuse() calls revoked()) writes a second, `revoked` line.
     * Returns the extra audit code (or null) and the final result.
     */
    fun afterAudit(tool: String, answer: Outcome.Answer, epochCurrent: Boolean): Pair<String?, String> {
        if (answer.auditCode == "revoked" || epochCurrent) return null to answer.result
        return (if (tool == OP_DELIVERY_SCRIPT) "revoked" else null) to revokedResult()
    }

    /** `{ok:false, error, code}` with RN's key order (bytes independent of org.json). */
    fun errorResult(r: Refusal): String = "{\"ok\":false,\"error\":${jsonString(r.message)},\"code\":${jsonString(r.code)}}"

    /** The op's audit line, RN's shape: {kind, event, principal, code}. */
    fun auditJson(tool: String, principal: String, code: String): String {
        val kind = auditKind(tool)
        return "{\"kind\":${jsonString(kind)},\"event\":${jsonString(kind)},\"principal\":${jsonString(principal)},\"code\":${jsonString(code)}}"
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
}
