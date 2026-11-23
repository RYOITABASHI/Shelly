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
    private val MCP_KEYS: Set<String> = setOf("kind", "event", "agentId", "principal", "code")
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
        if (json.length > 1024) throw IllegalArgumentException("too long")
        val o = JSONObject(json)
        val keys = HashSet<String>()
        val it = o.keys()
        while (it.hasNext()) keys.add(it.next())
        if (!MCP_KEYS.containsAll(keys)) throw IllegalArgumentException("unknown key")
        val kind = o.get("kind") as? String ?: throw IllegalArgumentException("kind")
        val event = o.get("event") as? String ?: throw IllegalArgumentException("event")
        val agentlessOp = agentId == null && kind == event &&
            (kind == "mcp_stage_install" || kind == "mcp_stage_install_result" || kind == "mcp_update_delivery_script")
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
            val flags = OsConstants.O_WRONLY or OsConstants.O_APPEND or OsConstants.O_CREAT or
                OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC
            val fd = Os.open(target.path, flags, 384 /* 0600 */)
            FileOutputStream(fd).use { out ->
                out.write((line + "\n").toByteArray(Charsets.UTF_8))
            }
            return true
        } catch (e: Exception) {
            Log.w(TAG, "audit line not written type=${e.javaClass.simpleName}")
            return false
        }
    }

    /** RN's appendMcpIngressAudit: validates and rebuilds the line, then appends it. */
    fun appendMcpLine(context: Context, agentId: String?, json: String): Boolean {
        val line = buildMcpLine(System.currentTimeMillis(), agentId, json) ?: return false
        return append(context, agentId, MCP_AGENTLESS_FILE, line)
    }
}
