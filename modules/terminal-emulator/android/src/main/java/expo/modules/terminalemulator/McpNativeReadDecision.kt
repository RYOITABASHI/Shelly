package expo.modules.terminalemulator

import org.json.JSONObject

/**
 * The pure half of the native answer for `read_terminal_output` (background
 * ingress, phase B-1). While the RN bridge is live the script queues the call
 * to RN exactly as before (lib/mcp-server-bridge.ts callTool
 * 'read_terminal_output'). While it is not live (Shelly in the background),
 * the script resolves the requested id to the native session id from the
 * signed snapshot's `terminal` section and routes the call to
 * `typed-requests/`, where McpTypedOpConsumer answers it with this decision —
 * the transcript lives natively (TerminalSessionService.sessionRegistry), so
 * nothing here needs RN.
 *
 * Same gate and answer as RN's tool:
 *  - "MCP: Allow reading terminal output" (settings.mcpReadTerminalEnabled):
 *    natively the wanted server's switch AND the Keystore mirror RN writes on
 *    every settings change (McpAutostartStore; missing / unreadable = OFF, fail
 *    closed), with RN's message;
 *  - the epoch (a consumer that was stopped or replaced answers `revoked`);
 *  - `maxLines`: a number (default 200), passed to getTranscriptText like the
 *    Expo bridge does (Double → Int, ≤ 0 = the whole transcript);
 *  - no redaction (RN returns the transcript as is; the switch is the gate);
 *  - data = the transcript text; an unknown session is
 *    `no such terminal session: <id>`.
 * No audit line: RN writes none for reads.
 *
 * No Android dependency (JVM tests: McpNativeReadDecisionTest).
 */
object McpNativeReadDecision {
    const val OP_READ_TERMINAL = "read_terminal_output"
    val OPS: Set<String> = setOf(OP_READ_TERMINAL)

    /** lib/mcp-server-bridge.ts (callTool 'read_terminal_output'). */
    const val READ_TERMINAL_DISABLED = "read_terminal_output is disabled (Settings → Agents → MCP: Allow reading terminal output)"
    const val REVOKED_ERROR = "cancelled: pending MCP requests were revoked"
    const val DEFAULT_MAX_LINES = 200

    /** Native session ids (`session-<timestamp>` and the like); anything else is never looked up or echoed. */
    private val SESSION_ID_RE = Regex("^[A-Za-z0-9._:-]{1,128}$")

    interface Steps {
        fun readTerminalOn(): Boolean
        fun epochCurrent(): Boolean
        /** The transcript, or null when there is no such native session. May throw. */
        fun transcript(sessionId: String, maxLines: Int): String?
    }

    /** RN passes `args.maxLines` when it is a number, else 200; Expo converts the Double to Int. */
    fun maxLines(args: JSONObject): Int {
        val v = args.opt("maxLines")
        if (v !is Number) return DEFAULT_MAX_LINES
        val d = v.toDouble()
        if (d.isNaN()) return DEFAULT_MAX_LINES
        return d.toInt()
    }

    /** The result JSON for one request (never throws). */
    fun answerTerminal(args: JSONObject, steps: Steps): String {
        return try {
            if (!steps.readTerminalOn()) return error(READ_TERMINAL_DISABLED, null)
            if (!steps.epochCurrent()) return error(REVOKED_ERROR, "revoked")
            val id = args.opt("sessionId") as? String
            if (id == null || !SESSION_ID_RE.matches(id)) {
                return error("no such terminal session: ${if (id != null && id.length <= 128) clean(id) else ""}".trimEnd(), null)
            }
            val text = steps.transcript(id, maxLines(args)) ?: return error("no such terminal session: $id", null)
            // The setting may have been turned off while reading: answer nothing then.
            if (!steps.readTerminalOn()) return error(READ_TERMINAL_DISABLED, null)
            JSONObject().put("ok", true).put("data", text).toString()
        } catch (e: Exception) {
            error(e.message ?: e.javaClass.simpleName, null)
        }
    }

    private fun clean(s: String): String = s.replace(Regex("[^\\x20-\\x7E]"), "?")

    fun error(message: String, code: String?): String {
        val o = JSONObject().put("ok", false).put("error", message)
        if (code != null) o.put("code", code)
        return o.toString()
    }
}
