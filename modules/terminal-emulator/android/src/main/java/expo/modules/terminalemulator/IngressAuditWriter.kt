package expo.modules.terminalemulator

import android.content.Context
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/**
 * The safe audit-line appender shared by AgentIngressTaint (mark / clear /
 * reset lines) and the MCP typed-op refusals (appendMcpIngressAudit in
 * TerminalEmulatorModule; plan "typed MCP operations", section (b) "Audit
 * writer"). Factored out of AgentIngressTaint.audit so the two can't drift.
 *
 * Where a line goes: the live per-agent file `~/.shelly/agents/logs/<id>/
 * agent-driver-audit.jsonl` if that directory exists, otherwise the deletion
 * mirror `~/.shelly/agents/audits/<id>-agent-driver-audit.jsonl` (a deleted
 * agent's log directory is never re-created). A line with no agent goes to
 * `audits/<agentlessFileName>`. The parent must resolve to itself under the
 * canonical home (no symlinked directory), and the file is opened O_NOFOLLOW;
 * android.system.Os has no openat, so a per-component O_DIRECTORY|O_NOFOLLOW
 * walk is not done (same limit as before the refactor).
 *
 * Best effort: false when the line was not written. Callers never block or
 * undo anything on a failed audit write.
 */
object IngressAuditWriter {
    private const val TAG = "IngressAuditWriter"

    private val AGENT_ID_RE = Regex("^[A-Za-z0-9_-]{1,128}$")
    private val FILE_NAME_RE = Regex("^[a-z0-9-]{1,64}\\.jsonl$")

    // ---- MCP typed-op lines (pure) -------------------------------------------------

    /** Kinds an MCP typed-op refusal may write. */
    val MCP_KINDS: Set<String> = setOf("ingress_tainted_refused", "mcp_typed_op_refused")
    /** Events (the typed op that was refused). */
    val MCP_EVENTS: Set<String> = setOf("mcp_run_agent")
    // `reason`: only on a `foreground_failed` line (McpInstallOpDecision FG_*), same charset as `code`.
    private val MCP_KEYS: Set<String> = setOf("kind", "event", "agentId", "principal", "code", "reason")
    private const val PIPELINE_CONFIG_KIND = "mcp_update_pipeline_config"
    private val PIPELINE_CONFIG_AGENT_ID_KEYS = setOf("rebuiltAgentIds", "failedAgentIds")
    private const val MAX_PIPELINE_CONFIG_AGENT_IDS = 33
    // The bridge can send 33 rebuild outcomes and 33 changed pipeline IDs.
    private const val MAX_PIPELINE_CONFIG_JSON_LENGTH = 7 * 1024
    private val PIPELINE_CONFIG_KEYS = setOf(
        "changedPipelineIds", "rebuiltCount", "rebuildFailedCount", "swapStatus", "failedReasonCodes",
        "sha256", "bytes", "backupCreated", "previousSha256",
    ) + PIPELINE_CONFIG_AGENT_ID_KEYS
    private val PIPELINE_CONFIG_FAILED_REASON_CODES = setOf("timeout", "revoked", "agent_not_found", "other")
    private val SHA256_RE = Regex("^[0-9a-f]{64}$")
    private val PIPELINE_ID_RE = Regex("^[a-z0-9-]{1,32}$")
    private val PRINCIPAL_RE = Regex("^[0-9a-f]{32}$")
    private val CODE_RE = Regex("^[a-z_]{1,32}$")

    /** Agent-less MCP lines go here (under `audits/`). */
    const val MCP_AGENTLESS_FILE = "mcp-ingress-audit.jsonl"

    private fun isoUtc(ts: Long): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return fmt.format(Date(ts))
    }

    /**
     * Rebuilds an MCP typed-op audit line from [json] (sent by RN) with only the
     * fixed, short fields: kind and event from closed sets, agentId (must equal
     * [agentId]), a 32-hex principal, a short code. Anything else (an unknown or
     * malformed field, a mismatched agentId) is refused: null. The timestamp is
     * this side's clock, never the caller's.
     */
    fun buildMcpLine(ts: Long, agentId: String?, json: String): String? = try {
        if (json.length > MAX_PIPELINE_CONFIG_JSON_LENGTH) throw IllegalArgumentException("too long")
        val o = JSONObject(json)
        val keys = HashSet<String>()
        val it = o.keys()
        while (it.hasNext()) keys.add(it.next())
        val kind = o.get("kind") as? String ?: throw IllegalArgumentException("kind")
        val event = o.get("event") as? String ?: throw IllegalArgumentException("event")
        val pipelineConfig = agentId == null && kind == PIPELINE_CONFIG_KIND && event == kind
        val allowedKeys = if (pipelineConfig) MCP_KEYS + PIPELINE_CONFIG_KEYS + "observedSha256" else MCP_KEYS
        if ((!pipelineConfig && json.length > 1024) || !allowedKeys.containsAll(keys)) {
            throw IllegalArgumentException("invalid fields")
        }
        val agentlessOp = agentId == null && kind == event &&
            (kind == "mcp_stage_install" || kind == "mcp_stage_install_result" || kind == "mcp_update_delivery_script" || pipelineConfig)
        if (!agentlessOp && (kind !in MCP_KINDS || event !in MCP_EVENTS)) throw IllegalArgumentException("kind/event")
        val lineAgent = if (o.has("agentId")) o.get("agentId") as? String ?: throw IllegalArgumentException("agentId") else null
        if (lineAgent != agentId) throw IllegalArgumentException("agentId mismatch")
        if (agentId != null && !AGENT_ID_RE.matches(agentId)) throw IllegalArgumentException("agentId")
        val principal = if (o.has("principal")) o.get("principal") as? String ?: throw IllegalArgumentException("principal") else null
        if (principal != null && !PRINCIPAL_RE.matches(principal)) throw IllegalArgumentException("principal")
        val code = if (o.has("code")) o.get("code") as? String ?: throw IllegalArgumentException("code") else null
        if (code != null && !CODE_RE.matches(code)) throw IllegalArgumentException("code")
        val out = JSONObject().put("ts", isoUtc(ts)).put("kind", kind).put("event", event)
        if (agentId != null) out.put("agentId", agentId)
        if (principal != null) out.put("principal", principal)
        if (code != null) out.put("code", code)
        if (o.has("reason")) {
            val reason = o.get("reason") as? String ?: throw IllegalArgumentException("reason")
            if (code != "foreground_failed" || !CODE_RE.matches(reason)) throw IllegalArgumentException("reason")
            out.put("reason", reason)
        }
        if (pipelineConfig && o.has("observedSha256")) {
            val hash = o.get("observedSha256") as? String ?: throw IllegalArgumentException("observedSha256")
            if (code != "native_error" || !SHA256_RE.matches(hash)) throw IllegalArgumentException("observedSha256")
            out.put("observedSha256", hash)
        }
        if (pipelineConfig && keys.any { it in PIPELINE_CONFIG_KEYS }) {
            if (code != "created" && code != "updated" && code != "revoked" && code != "timeout") throw IllegalArgumentException("code")
            val sha256 = o.get("sha256") as? String ?: throw IllegalArgumentException("sha256")
            if (!SHA256_RE.matches(sha256)) throw IllegalArgumentException("sha256")
            out.put("sha256", sha256)
            val bytes = o.get("bytes") as? Int ?: throw IllegalArgumentException("bytes")
            if (bytes !in 1..262144) throw IllegalArgumentException("bytes")
            out.put("bytes", bytes)
            val backupCreated = o.get("backupCreated") as? Boolean ?: throw IllegalArgumentException("backupCreated")
            out.put("backupCreated", backupCreated)
            if (o.has("previousSha256")) {
                val hash = o.get("previousSha256") as? String ?: throw IllegalArgumentException("previousSha256")
                if (!SHA256_RE.matches(hash)) throw IllegalArgumentException("previousSha256")
                out.put("previousSha256", hash)
            }
            val ids = o.getJSONArray("changedPipelineIds")
            // Up to sixteen old and sixteen new pipeline IDs, plus digest.
            if (ids.length() > 33) throw IllegalArgumentException("pipeline ids")
            for (index in 0 until ids.length()) {
                val id = ids.get(index) as? String ?: throw IllegalArgumentException("pipeline id")
                if (!PIPELINE_ID_RE.matches(id)) throw IllegalArgumentException("pipeline id")
            }
            out.put("changedPipelineIds", ids)
            for (key in listOf("rebuiltCount", "rebuildFailedCount")) {
                val count = o.get(key) as? Int ?: throw IllegalArgumentException("count")
                if (count < 0) throw IllegalArgumentException("count")
                out.put(key, count)
            }
            for (key in PIPELINE_CONFIG_AGENT_ID_KEYS) {
                if (!o.has(key)) continue
                val agentIds = o.getJSONArray(key)
                if (agentIds.length() > MAX_PIPELINE_CONFIG_AGENT_IDS) throw IllegalArgumentException(key)
                for (index in 0 until agentIds.length()) {
                    val id = agentIds.get(index) as? String ?: throw IllegalArgumentException(key)
                    if (!AGENT_ID_RE.matches(id)) throw IllegalArgumentException(key)
                }
                out.put(key, agentIds)
            }
            if (o.has("swapStatus")) {
                val status = o.get("swapStatus") as? String ?: throw IllegalArgumentException("swapStatus")
                if (status != "created" && status != "updated") throw IllegalArgumentException("swapStatus")
                if ((status == "updated") != o.has("previousSha256")) throw IllegalArgumentException("previousSha256")
                out.put("swapStatus", status)
            }
            if (o.has("failedReasonCodes")) {
                val reasons = o.get("failedReasonCodes") as? JSONArray ?: throw IllegalArgumentException("failedReasonCodes")
                if (!o.has("failedAgentIds") || reasons.length() != o.getJSONArray("failedAgentIds").length()) {
                    throw IllegalArgumentException("failedReasonCodes")
                }
                for (index in 0 until reasons.length()) {
                    val reason = reasons.get(index) as? String ?: throw IllegalArgumentException("failedReasonCodes")
                    if (reason !in PIPELINE_CONFIG_FAILED_REASON_CODES) throw IllegalArgumentException("failedReasonCodes")
                }
                out.put("failedReasonCodes", reasons)
            }
        }
        out.toString()
    } catch (e: Exception) {
        null
    }

    // ---- Headless typed-op lines (McpTypedOpConsumer; pure) -------------------------

    /**
     * Kinds only the native consumer writes (RN's appendMcpLine cannot): a rule
     * matched and the run is about to start (written BEFORE the launch; a failed
     * write stops the launch), the request was handed to RN, or a request file
     * was dropped without an answer (bad MAC, stale, replay, orphan sweep), or
     * the handoff move to RN failed (code = the errno name, McpHandoffMove.failureCode).
     */
    val NATIVE_MCP_KINDS: Set<String> = setOf(
        "mcp_typed_op_executing", "mcp_typed_op_handed_off", "mcp_typed_op_handoff_failed", "mcp_typed_op_dropped",
        // Headless raw tools (McpRawToolConsumer, "MCP: Run without approval"):
        // about to run (written BEFORE the command / write; a failed write
        // stops it), finished (code ok / failed), refused (code), handed to RN
        // for the approval tap, or dropped unanswered (bad MAC, stale, replay, orphan).
        "mcp_raw_tool_executing", "mcp_raw_tool_done", "mcp_raw_tool_refused",
        "mcp_raw_tool_handed_off", "mcp_raw_tool_handoff_failed", "mcp_raw_tool_dropped",
    )
    /** Events only native lines carry: [MCP_EVENTS] plus the raw tools. No command, path or content is ever written. */
    val NATIVE_MCP_EVENTS: Set<String> = MCP_EVENTS + setOf("mcp_run_command", "mcp_write_file")
    private val RULE_ID_RE = Regex("^r_[0-9a-f]{16}$")
    private val TARGET_RE = Regex("^agent:[A-Za-z0-9_-]{1,128}$")

    /**
     * One headless typed-op line from fixed, validated fields only (null when
     * any is off). [kind] from [MCP_KINDS] or [NATIVE_MCP_KINDS], [event] from
     * [MCP_EVENTS]; principal 32 hex; code short; ruleId / target in the
     * always-allow store's shapes. No free text.
     */
    fun buildNativeMcpLine(
        ts: Long,
        kind: String,
        event: String,
        agentId: String?,
        principal: String?,
        code: String?,
        ruleId: String? = null,
        target: String? = null,
    ): String? {
        if (kind !in MCP_KINDS && kind !in NATIVE_MCP_KINDS) return null
        if (event !in NATIVE_MCP_EVENTS) return null
        if (agentId != null && !AGENT_ID_RE.matches(agentId)) return null
        if (principal != null && !PRINCIPAL_RE.matches(principal)) return null
        if (code != null && !CODE_RE.matches(code)) return null
        if (ruleId != null && !RULE_ID_RE.matches(ruleId)) return null
        if (target != null && !TARGET_RE.matches(target)) return null
        return try {
            val out = JSONObject().put("ts", isoUtc(ts)).put("kind", kind).put("event", event)
            if (agentId != null) out.put("agentId", agentId)
            if (principal != null) out.put("principal", principal)
            if (code != null) out.put("code", code)
            if (ruleId != null) out.put("ruleId", ruleId)
            if (target != null) out.put("target", target)
            out.toString()
        } catch (e: Exception) {
            null
        }
    }

    /** Appends a [buildNativeMcpLine] line. False when invalid or not written. */
    fun appendNativeMcpLine(
        context: Context,
        kind: String,
        agentId: String?,
        principal: String?,
        code: String?,
        ruleId: String? = null,
        target: String? = null,
        event: String = "mcp_run_agent",
    ): Boolean {
        val line = buildNativeMcpLine(System.currentTimeMillis(), kind, event, agentId, principal, code, ruleId, target)
            ?: return false
        return append(context, agentId, MCP_AGENTLESS_FILE, line)
    }

    // ---- service_control lines (ManagedServiceSupervisor + RN bridge; pure) ---------

    const val SERVICE_CONTROL_KIND = "mcp_service_control"
    private val SERVICE_CONTROL_ACTIONS = setOf("start", "status", "stop")

    /**
     * One `mcp_service_control` line: kind == event, no agent, principal 32 hex
     * (or absent: a STOP-ALL stop), action from the closed set, serviceId a
     * registered id, code short. Action and serviceId are absent only on a
     * refusal of unchecked arguments (`invalid_params`). Null when any field is
     * off. No path, command or output is ever written.
     */
    fun buildServiceControlLine(ts: Long, principal: String?, action: String?, serviceId: String?, code: String): String? {
        if (principal != null && !PRINCIPAL_RE.matches(principal)) return null
        if (action != null && action !in SERVICE_CONTROL_ACTIONS) return null
        if (serviceId != null && ManagedServices.spec(serviceId) == null) return null
        if ((action == null || serviceId == null) && code != "invalid_params") return null
        if (!CODE_RE.matches(code)) return null
        return try {
            val out = JSONObject().put("ts", isoUtc(ts)).put("kind", SERVICE_CONTROL_KIND).put("event", SERVICE_CONTROL_KIND)
            if (principal != null) out.put("principal", principal)
            if (action != null) out.put("action", action)
            if (serviceId != null) out.put("serviceId", serviceId)
            out.put("code", code)
            out.toString()
        } catch (e: Exception) {
            null
        }
    }

    /** Appends a [buildServiceControlLine] line to `audits/mcp-ingress-audit.jsonl`. */
    fun appendServiceControlLine(context: Context, principal: String?, action: String, serviceId: String, code: String): Boolean {
        val line = buildServiceControlLine(System.currentTimeMillis(), principal, action, serviceId, code) ?: return false
        return append(context, null, MCP_AGENTLESS_FILE, line)
    }

    /**
     * The headless drain's lines for this op (McpTypedOpConsumer: the same
     * stages and codes RN writes through appendMcpIngressAudit). Action and
     * serviceId are null only for `invalid_params`, as RN's.
     */
    fun appendServiceControlDrainLine(context: Context, principal: String?, action: String?, serviceId: String?, code: String): Boolean {
        val line = buildServiceControlLine(System.currentTimeMillis(), principal, action, serviceId, code) ?: return false
        return append(context, null, MCP_AGENTLESS_FILE, line)
    }

    /**
     * RN's lines for this op (approval stages, refusals before the native call)
     * arrive as JSON through appendMcpIngressAudit: rebuilt here from the same
     * closed fields, or refused (null).
     */
    fun buildServiceControlLineFromJson(ts: Long, json: String): String? = try {
        if (json.length > 1024) null else {
            val o = JSONObject(json)
            val keys = HashSet<String>()
            val it = o.keys()
            while (it.hasNext()) keys.add(it.next())
            if (!setOf("kind", "event", "principal", "action", "serviceId", "code").containsAll(keys)) null
            else if (o.optString("kind") != SERVICE_CONTROL_KIND || o.optString("event") != SERVICE_CONTROL_KIND) null
            else {
                val principal = if (o.has("principal")) o.get("principal") as? String ?: throw IllegalArgumentException() else null
                val action = if (o.has("action")) o.get("action") as? String ?: throw IllegalArgumentException() else null
                val serviceId = if (o.has("serviceId")) o.get("serviceId") as? String ?: throw IllegalArgumentException() else null
                val code = o.get("code") as? String ?: throw IllegalArgumentException()
                buildServiceControlLine(ts, principal, action, serviceId, code)
            }
        }
    } catch (e: Exception) {
        null
    }

    // ---- request_pipeline_refire lines (RN bridge; pure) ----------------------------

    const val PIPELINE_REFIRE_KIND = "mcp_pipeline_refire"
    private val REFIRE_REQUEST_ID_RE = Regex("^rq-[0-9]{1,16}-[0-9a-f]{8}$")

    /**
     * One `mcp_pipeline_refire` line (search parity item 4): kind == event, no
     * agent, principal 32 hex, pipelineId the op's closed id form (absent only
     * on `invalid_params`), code short, requestId only the script's own form.
     * Null when any field is off. No free text is ever written.
     */
    fun buildPipelineRefireLine(ts: Long, principal: String?, pipelineId: String?, code: String, requestId: String?): String? {
        if (principal != null && !PRINCIPAL_RE.matches(principal)) return null
        if (pipelineId != null && !PIPELINE_ID_RE.matches(pipelineId)) return null
        if (pipelineId == null && code != "invalid_params") return null
        if (!CODE_RE.matches(code)) return null
        if (requestId != null && !REFIRE_REQUEST_ID_RE.matches(requestId)) return null
        return try {
            val out = JSONObject().put("ts", isoUtc(ts)).put("kind", PIPELINE_REFIRE_KIND).put("event", PIPELINE_REFIRE_KIND)
            if (principal != null) out.put("principal", principal)
            if (pipelineId != null) out.put("pipelineId", pipelineId)
            out.put("code", code)
            if (requestId != null) out.put("requestId", requestId)
            out.toString()
        } catch (e: Exception) {
            null
        }
    }

    /** The headless drain's request_pipeline_refire lines (same stages and codes as RN's). */
    fun appendPipelineRefireLine(context: Context, principal: String?, pipelineId: String?, code: String, requestId: String?): Boolean {
        val line = buildPipelineRefireLine(System.currentTimeMillis(), principal, pipelineId, code, requestId) ?: return false
        return append(context, null, MCP_AGENTLESS_FILE, line)
    }

    /** RN's lines for request_pipeline_refire, rebuilt from the closed fields, or refused (null). */
    fun buildPipelineRefireLineFromJson(ts: Long, json: String): String? = try {
        if (json.length > 1024) null else {
            val o = JSONObject(json)
            val keys = HashSet<String>()
            val it = o.keys()
            while (it.hasNext()) keys.add(it.next())
            if (!setOf("kind", "event", "principal", "pipelineId", "code", "requestId").containsAll(keys)) null
            else if (o.optString("kind") != PIPELINE_REFIRE_KIND || o.optString("event") != PIPELINE_REFIRE_KIND) null
            else {
                val principal = if (o.has("principal")) o.get("principal") as? String ?: throw IllegalArgumentException() else null
                val pipelineId = if (o.has("pipelineId")) o.get("pipelineId") as? String ?: throw IllegalArgumentException() else null
                val requestId = if (o.has("requestId")) o.get("requestId") as? String ?: throw IllegalArgumentException() else null
                val code = o.get("code") as? String ?: throw IllegalArgumentException()
                buildPipelineRefireLine(ts, principal, pipelineId, code, requestId)
            }
        }
    } catch (e: Exception) {
        null
    }

    // ---- service_control spec resolution (council-facade; native-only, pure) -------

    const val SERVICE_CONTROL_SPEC_KIND = "mcp_service_control_spec"

    /**
     * One `mcp_service_control_spec` line, written only by
     * ManagedServiceSupervisor (never from RN/JSON) each time its reading of a
     * service's on-device launch spec changes: [serviceId] a registered id,
     * [ok] whether a Launch/HealthCheck came out of it, [reason] the closed,
     * short code (ManagedServices.ExternalSpec.Result.reason — never the raw
     * file text), [digest] the sha256 hex of the file's bytes when [ok] (null
     * refused when ok but no digest, or digest present but not 64 hex).
     */
    fun buildServiceControlSpecLine(ts: Long, serviceId: String, ok: Boolean, reason: String, digest: String?): String? {
        if (ManagedServices.spec(serviceId) == null) return null
        if (!CODE_RE.matches(reason)) return null
        if (digest != null && !SHA256_RE.matches(digest)) return null
        if (ok && digest == null) return null
        return try {
            val out = JSONObject().put("ts", isoUtc(ts)).put("kind", SERVICE_CONTROL_SPEC_KIND).put("event", SERVICE_CONTROL_SPEC_KIND)
                .put("serviceId", serviceId).put("ok", ok).put("reason", reason)
            if (digest != null) out.put("digest", digest)
            out.toString()
        } catch (e: Exception) {
            null
        }
    }

    /** Appends a [buildServiceControlSpecLine] line to `audits/mcp-ingress-audit.jsonl`. */
    fun appendServiceControlSpecLine(context: Context, serviceId: String, ok: Boolean, reason: String, digest: String?): Boolean {
        val line = buildServiceControlSpecLine(System.currentTimeMillis(), serviceId, ok, reason, digest) ?: return false
        return append(context, null, MCP_AGENTLESS_FILE, line)
    }

    // ---- Residency / overlay guard lines (ResidencyLedger, OverlayGuard; native-only, pure) ----

    const val RESIDENCY_GUARD_KIND = "residency_guard"
    private val RESIDENCY_GUARD_EVENTS = setOf("overlay", "residency")

    /**
     * One `residency_guard` line, written only natively: [event] `overlay`
     * (Settings.Global overlay_display_devices set to a display, code
     * `overlay_detected`, [valueLength] the setting's length only — never its
     * value) or `residency` (the ledger's own checks, [serviceId] a registered
     * id). Null when any field is off.
     */
    fun buildResidencyGuardLine(ts: Long, event: String, code: String, serviceId: String?, valueLength: Int?): String? {
        if (event !in RESIDENCY_GUARD_EVENTS || !CODE_RE.matches(code)) return null
        if (serviceId != null && ManagedServices.spec(serviceId) == null) return null
        if (valueLength != null && valueLength !in 0..100_000) return null
        return try {
            val out = JSONObject().put("ts", isoUtc(ts)).put("kind", RESIDENCY_GUARD_KIND).put("event", event)
                .put("action", event).put("code", code)
            if (serviceId != null) out.put("serviceId", serviceId)
            if (valueLength != null) out.put("valueLength", valueLength)
            out.toString()
        } catch (e: Exception) {
            null
        }
    }

    /** Appends a [buildResidencyGuardLine] line to `audits/mcp-ingress-audit.jsonl`. */
    fun appendResidencyGuardLine(context: Context, event: String, code: String, serviceId: String?, valueLength: Int?): Boolean {
        val line = buildResidencyGuardLine(System.currentTimeMillis(), event, code, serviceId, valueLength) ?: return false
        return append(context, null, MCP_AGENTLESS_FILE, line)
    }

    // ---- Stream feed lines (put_stream_feed: StreamFeedStore, McpTypedOpConsumer, RN; pure) ----

    const val STREAM_FEED_KIND = "mcp_stream_feed"

    /**
     * One `mcp_stream_feed` line: kind == event, no agent, principal 32 hex
     * (or absent), a short code, and for a feed that passed validation its
     * sha256, size and item count. Never any of the feed's content (fact
     * sheet §6.2 P4). Null when any field is off.
     */
    fun buildStreamFeedLine(ts: Long, principal: String?, code: String, sha256: String?, bytes: Int?, items: Int?): String? {
        if (principal != null && !PRINCIPAL_RE.matches(principal)) return null
        if (!CODE_RE.matches(code)) return null
        if (sha256 != null && !SHA256_RE.matches(sha256)) return null
        if (bytes != null && bytes !in 1..LauncherIngressLimits.MAX_FEED_BYTES) return null
        if (items != null && items !in 0..LauncherIngressLimits.MAX_FEED_BYTES) return null
        if ((sha256 == null) != (bytes == null)) return null
        if (items != null && sha256 == null) return null
        return try {
            val out = JSONObject().put("ts", isoUtc(ts)).put("kind", STREAM_FEED_KIND).put("event", STREAM_FEED_KIND)
            if (principal != null) out.put("principal", principal)
            out.put("code", code)
            if (sha256 != null) out.put("sha256", sha256)
            if (bytes != null) out.put("bytes", bytes)
            if (items != null) out.put("items", items)
            out.toString()
        } catch (e: Exception) {
            null
        }
    }

    /** Appends a [buildStreamFeedLine] line to `audits/mcp-ingress-audit.jsonl`. */
    fun appendStreamFeedLine(context: Context, principal: String?, code: String, sha256: String?, bytes: Int?, items: Int?): Boolean {
        val line = buildStreamFeedLine(System.currentTimeMillis(), principal, code, sha256, bytes, items) ?: return false
        return append(context, null, MCP_AGENTLESS_FILE, line)
    }

    /**
     * RN's lines for this op (approval stages, its refusals) through
     * appendMcpIngressAudit: exactly {kind, event, principal?, code}, rebuilt
     * here. RN never sends a digest or size; native writes those itself.
     */
    fun buildStreamFeedLineFromJson(ts: Long, json: String): String? = try {
        if (json.length > 512) null else {
            val o = JSONObject(json)
            val keys = HashSet<String>()
            val it = o.keys()
            while (it.hasNext()) keys.add(it.next())
            if (!setOf("kind", "event", "principal", "code").containsAll(keys)) null
            else if (o.optString("kind") != STREAM_FEED_KIND || o.optString("event") != STREAM_FEED_KIND) null
            else {
                val principal = if (o.has("principal")) o.get("principal") as? String ?: throw IllegalArgumentException() else null
                val code = o.get("code") as? String ?: throw IllegalArgumentException()
                buildStreamFeedLine(ts, principal, code, null, null, null)
            }
        }
    } catch (e: Exception) {
        null
    }

    // ---- Launcher ingress lines (LauncherIngressProvider; pure) ---------------------

    /**
     * Kinds the launcher ingress writes (fact sheet §3 C2, A2, D1 audit). Every
     * submission outcome is a line: accepted (approved at once), pending,
     * denied (any reason, with a short code: a VERIFY_FAILED line carries which
     * check failed, the caller never learns it), and the later approval
     * outcomes. `launcher_feed_read` is the light read line for get_stream_feed.
     */
    val LAUNCHER_KINDS: Set<String> = setOf(
        "launcher_submit_accepted", "launcher_submit_pending", "launcher_submit_denied",
        "launcher_submit_approved", "launcher_submit_user_denied", "launcher_submit_expired",
        "launcher_feed_read",
    )
    const val LAUNCHER_EVENT_SUBMIT = "launcher_submit_instruction"
    const val LAUNCHER_EVENT_FEED = "launcher_get_stream_feed"
    private val LAUNCHER_PRINCIPAL_RE = Regex("^launcher:[0-9a-f]{32}$")
    private val SUBMISSION_ID_RE = Regex("^ls_[0-9a-f]{32}$")
    /** Fact sheet §8 R5: opaque, but no free text can ride on it. */
    val CORRELATION_REF_RE = Regex("^[A-Za-z0-9._:/-]{1,256}$")

    /**
     * One launcher line's fields. Fixed shapes only; the instruction text, the
     * feed body and anything the caller sent besides these are never written.
     */
    data class LauncherLine(
        val kind: String,
        val event: String,
        val code: String,
        val principal: String? = null,
        /** SHA-256 (lower hex) of the caller certificate that verified. */
        val certDigest: String? = null,
        val schemaVersion: Int? = null,
        val submissionId: String? = null,
        val correlationRef: String? = null,
        val tainted: Boolean? = null,
        val exemptApplied: Boolean? = null,
        val textSha256: String? = null,
        val textCodePoints: Int? = null,
        val duplicate: Boolean? = null,
        val feedSha256: String? = null,
        val feedBytes: Int? = null,
    )

    /** Null when any field is off. `origin` is `launcher` when the line has a (verified) principal, absent otherwise; the ts is this side's clock. */
    fun buildLauncherLine(ts: Long, l: LauncherLine): String? {
        if (l.kind !in LAUNCHER_KINDS) return null
        val feed = l.kind == "launcher_feed_read"
        if (l.event != (if (feed) LAUNCHER_EVENT_FEED else LAUNCHER_EVENT_SUBMIT)) return null
        if (!CODE_RE.matches(l.code)) return null
        if (l.principal != null && !LAUNCHER_PRINCIPAL_RE.matches(l.principal)) return null
        if (l.certDigest != null && !SHA256_RE.matches(l.certDigest)) return null
        if (l.schemaVersion != null && l.schemaVersion !in 1..99) return null
        if (l.submissionId != null && !SUBMISSION_ID_RE.matches(l.submissionId)) return null
        if (l.correlationRef != null && !CORRELATION_REF_RE.matches(l.correlationRef)) return null
        if (l.textSha256 != null && !SHA256_RE.matches(l.textSha256)) return null
        if (l.textCodePoints != null && l.textCodePoints !in 0..LauncherIngressLimits.MAX_TEXT_CODE_POINTS) return null
        if (l.feedSha256 != null && !SHA256_RE.matches(l.feedSha256)) return null
        if (l.feedBytes != null && l.feedBytes !in 0..LauncherIngressLimits.MAX_FEED_BYTES) return null
        if (feed && (l.submissionId != null || l.textSha256 != null || l.textCodePoints != null || l.exemptApplied != null)) return null
        if (!feed && (l.feedSha256 != null || l.feedBytes != null)) return null
        return try {
            val out = JSONObject().put("ts", isoUtc(ts)).put("kind", l.kind).put("event", l.event)
            // Fact sheet §2: origin `launcher` belongs only to a verified caller (one
            // that has a principal); a caller that failed verification gets none.
            if (l.principal != null) out.put("origin", IngressOrigin.LAUNCHER)
            out.put("code", l.code)
            if (l.principal != null) out.put("principal", l.principal)
            if (l.certDigest != null) out.put("certDigest", l.certDigest)
            if (!feed) out.put("op", IngressDecision.OP_SUBMIT_INSTRUCTION)
            if (l.schemaVersion != null) out.put("schemaVersion", l.schemaVersion)
            // The join keys use the contract's names (fact sheet §1.2 / C2), the same as the Binder answer.
            if (l.submissionId != null) out.put("submission_id", l.submissionId)
            if (l.correlationRef != null) out.put("correlation_ref", l.correlationRef)
            if (l.tainted != null) out.put("tainted", l.tainted)
            if (l.exemptApplied != null) out.put("exemptApplied", l.exemptApplied)
            if (l.textSha256 != null) out.put("textSha256", l.textSha256)
            if (l.textCodePoints != null) out.put("textCodePoints", l.textCodePoints)
            if (l.duplicate != null) out.put("duplicate", l.duplicate)
            if (l.feedSha256 != null) out.put("feedSha256", l.feedSha256)
            if (l.feedBytes != null) out.put("feedBytes", l.feedBytes)
            out.toString()
        } catch (e: Exception) {
            null
        }
    }

    /** Appends a [buildLauncherLine] line to `audits/mcp-ingress-audit.jsonl`. False when invalid or not written. */
    fun appendLauncherLine(context: Context, l: LauncherLine): Boolean {
        val line = buildLauncherLine(System.currentTimeMillis(), l) ?: return false
        return append(context, null, MCP_AGENTLESS_FILE, line)
    }

    // ---- Launcher submission reader lines (phase 2 D2: McpTypedOpConsumer; pure) ----

    /**
     * Kinds the D2 reader writes, one per op (kind == event): a read of one
     * submission, a list, a consume. Each carries only the MCP principal that
     * asked, the submission id (absent for a list or unchecked arguments), a
     * short code and, for a list, the count returned. Never the text.
     */
    val SUBMISSION_READER_KINDS: Set<String> = setOf(
        "launcher_submission_get", "launcher_submission_list", "launcher_submission_consume",
    )

    /** One reader line from fixed fields only; null when any is off. `origin` is `mcp` (the reader is an MCP principal). */
    fun buildSubmissionReaderLine(ts: Long, kind: String, principal: String?, submissionId: String?, code: String, count: Int?): String? {
        if (kind !in SUBMISSION_READER_KINDS) return null
        if (principal != null && !PRINCIPAL_RE.matches(principal)) return null
        if (submissionId != null && !SUBMISSION_ID_RE.matches(submissionId)) return null
        if (!CODE_RE.matches(code)) return null
        if (count != null && (kind != "launcher_submission_list" || count !in 0..LauncherIngressLimits.READER_LIST_MAX)) return null
        if (kind == "launcher_submission_list" && submissionId != null) return null
        return try {
            val out = JSONObject().put("ts", isoUtc(ts)).put("kind", kind).put("event", kind)
            if (principal != null) out.put("origin", IngressOrigin.MCP).put("principal", principal)
            if (submissionId != null) out.put("submission_id", submissionId)
            out.put("code", code)
            if (count != null) out.put("count", count)
            out.toString()
        } catch (e: Exception) {
            null
        }
    }

    /** Appends a [buildSubmissionReaderLine] line to `audits/mcp-ingress-audit.jsonl`. False when invalid or not written. */
    fun appendSubmissionReaderLine(context: Context, kind: String, principal: String?, submissionId: String?, code: String, count: Int?): Boolean {
        val line = buildSubmissionReaderLine(System.currentTimeMillis(), kind, principal, submissionId, code, count) ?: return false
        return append(context, null, MCP_AGENTLESS_FILE, line)
    }

    // ---- Writer --------------------------------------------------------------------

    /**
     * Appends [line] (one JSON object, no newline) as described in the class doc.
     * [agentlessFileName] names the `audits/` file used when [agentId] is null.
     */
    fun append(context: Context, agentId: String?, agentlessFileName: String, line: String): Boolean {
        try {
            if (agentId != null && !AGENT_ID_RE.matches(agentId)) return false
            if (!FILE_NAME_RE.matches(agentlessFileName)) return false
            if (line.contains('\n') || line.contains('\r')) return false
            val home = File(context.filesDir, "home").canonicalFile
            val agentsDir = File(home, ".shelly/agents")
            if (!agentsDir.isDirectory) return false
            val liveDir = agentId?.let { File(agentsDir, "logs/$it") }
            val target = if (liveDir != null && liveDir.isDirectory) {
                File(liveDir, "agent-driver-audit.jsonl")
            } else {
                val audits = File(agentsDir, "audits")
                if (!audits.isDirectory && !audits.mkdirs()) return false
                File(audits, if (agentId != null) "$agentId-agent-driver-audit.jsonl" else agentlessFileName)
            }
            val parent = target.parentFile ?: return false
            if (parent.canonicalFile.path != parent.absoluteFile.path) {
                Log.w(TAG, "audit directory is a link - skipped")
                return false
            }
            // O_NONBLOCK: a FIFO planted at the audit path must not park the caller
            // (the exported launcher Provider reaches this on a Binder thread); with
            // no reader the open fails (ENXIO). It changes nothing for a regular file,
            // and anything that is not a regular file is refused below.
            val flags = OsConstants.O_WRONLY or OsConstants.O_APPEND or OsConstants.O_CREAT or
                OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC or OsConstants.O_NONBLOCK
            val fd = Os.open(target.path, flags, 384 /* 0600 */)
            try {
                if (!OsConstants.S_ISREG(Os.fstat(fd).st_mode)) {
                    Log.w(TAG, "audit target is not a regular file - skipped")
                    return false
                }
                // A stream over a FileDescriptor does not own it on Android, so
                // closing the stream leaves the fd open: close it here. (The
                // exported launcher Provider can reach this on every denied call.)
                FileOutputStream(fd).use { out ->
                    out.write((line + "\n").toByteArray(Charsets.UTF_8))
                }
            } finally {
                runCatching { Os.close(fd) }
            }
            return true
        } catch (e: Exception) {
            Log.w(TAG, "audit line not written type=${e.javaClass.simpleName}")
            return false
        }
    }

    /** RN's appendMcpIngressAudit: validates and rebuilds the line, then appends it. */
    fun appendMcpLine(context: Context, agentId: String?, json: String): Boolean {
        val now = System.currentTimeMillis()
        val line = (if (agentId == null && json.contains("\"$SERVICE_CONTROL_KIND\"")) buildServiceControlLineFromJson(now, json) else null)
            ?: (if (agentId == null && json.contains("\"$PIPELINE_REFIRE_KIND\"")) buildPipelineRefireLineFromJson(now, json) else null)
            ?: (if (agentId == null && json.contains("\"$STREAM_FEED_KIND\"")) buildStreamFeedLineFromJson(now, json) else null)
            ?: buildMcpLine(now, agentId, json) ?: return false
        return append(context, agentId, MCP_AGENTLESS_FILE, line)
    }
}
