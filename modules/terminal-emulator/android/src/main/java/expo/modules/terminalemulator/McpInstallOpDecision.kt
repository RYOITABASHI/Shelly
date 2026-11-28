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
    const val OP_STAGE_INSTALL = "stage_install"
    val OPS: Set<String> = setOf(OP_DELIVERY_SCRIPT, OP_PIPELINE_CONFIG, OP_STAGE_INSTALL)

    // -- Foreground for approval (owner decision 2026-11-29) --
    //
    // When one of these ops needs the tap and RN is NOT live, native no longer
    // answers `not_attended` at once: if the phone is interactive and unlocked
    // and Shelly may draw overlays, it shows a small overlay, starts Shelly's
    // activity while the overlay is visible (Android's background-activity-start
    // exemption for a visible overlay window) and waits for RN's heartbeat; then
    // it hands off exactly as above. The tap in RN's dialog is still the only
    // approval. Otherwise (locked, no overlay grant, no time left, the start
    // failed, RN did not come up) the answer is today's `not_attended`.

    /** The longest wait for RN after the activity was started. */
    const val FOREGROUND_WAIT_MS = 15_000L
    /** Hand off at least this long before the pre-approval deadline, so RN can still show its dialog. */
    const val FOREGROUND_DEADLINE_MARGIN_MS = 3_000L
    /** How often the consumer re-reads the heartbeat while waiting. */
    const val FOREGROUND_POLL_MS = 200L

    const val FG_LOCKED = "locked"
    const val FG_NO_OVERLAY = "no_overlay_permission"
    const val FG_START_FAILED = "start_failed"
    const val FG_RN_NOT_LIVE = "rn_not_live"
    /** No time is left before the deadline margin; nothing was shown. */
    const val FG_NO_TIME = "no_time"
    /** RN came up, but the handoff could not follow within HANDOFF_MAX_AGE_MS of that (a stalled worker). */
    const val FG_HANDOFF_WINDOW = "handoff_window"

    // -- Lock-screen approval (owner decision 2026-11-29; McpLockScreenApproval) --
    //
    // Locked (or screen off) instead of FG_LOCKED: a full-screen notification
    // opens McpLockScreenApprovalActivity; 拒否 decides at once, 承認 counts
    // only after the keyguard was dismissed (onDismissSucceeded). An approval
    // is handed to RN with a single-use lock-approval token, and RN runs it
    // without a second tap; a denial is answered here with RN's `denied`.

    /** Android 14+: the full-screen-intent special access is not granted. */
    const val FG_NO_FULL_SCREEN_INTENT = "no_full_screen_intent"
    /** Shelly's notifications are off. */
    const val FG_NOTIFICATIONS_OFF = "notifications_off"
    /** Nobody decided on the lock screen before the deadline margin. */
    const val FG_NO_DECISION = "no_decision"
    /** RN's deny message (all three ops). */
    const val DENIED_MESSAGE = "denied by user (or timed out waiting for a response)"

    /**
     * lib/mcp-server-bridge.ts INSTALL_CLASS_PRE_APPROVAL_MS (RN's deadlineMs = receivedAt + this):
     * the approval deadline, 5 min (owner decision 2026-11-29, was 15 s).
     */
    const val PRE_APPROVAL_MS = 300_000L
    /** update_delivery_script: expectedBytes 1..this. */
    const val DELIVERY_MAX_BYTES = 1_048_576L
    /** lib/agent-article-pipeline-file.ts ARTICLE_PIPELINE_FILE_MAX_BYTES (256 KiB). */
    const val PIPELINE_MAX_BYTES = 262_144L
    /** At most this many rebuild pairs (the native audit's ID-array cap). */
    const val MAX_REBUILD_PAIRS = 33

    /** The audit kind (= event) of each op, as RN writes it. */
    fun auditKind(op: String): String = when (op) {
        OP_PIPELINE_CONFIG -> "mcp_update_pipeline_config"
        OP_STAGE_INSTALL -> "mcp_stage_install"
        else -> "mcp_update_delivery_script"
    }

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
    // stage_install (lib/mcp-server-bridge.ts stageInstallTool).
    const val APK_PATH_ERROR = "path must be an absolute .apk file path without control characters"
    const val APK_DOTDOT_ERROR = "path must not contain \"..\""

    // `/^\/sdcard\/Download\/[A-Za-z0-9][A-Za-z0-9._-]*\.js$/` with Regex.matches (whole input:
    // a JS `$` without the m flag never matches before a trailing newline either).
    private val DELIVERY_PATH_RE = Regex("/sdcard/Download/[A-Za-z0-9][A-Za-z0-9._-]*\\.js")
    private val PIPELINE_PATH_RE = Regex("/sdcard/Download/[A-Za-z0-9][A-Za-z0-9._-]*\\.json")
    private val CONTROL_RE = Regex("[\\x00-\\x1f\\x7f]")
    private val SHA256_RE = Regex("[0-9a-f]{64}")

    data class Refusal(val code: String, val message: String)

    sealed class Outcome {
        /**
         * Write the op's audit line with [auditCode], answer [result]. With
         * [foregroundFailure], a `foreground_failed` line with that reason comes first.
         */
        data class Answer(val auditCode: String, val result: String, val foregroundFailure: String? = null) : Outcome()
        /** RN is live: move the original file into requests/ (with the handoff token). */
        object Handoff : Outcome()
        /** RN is not live: show the overlay, start the activity, wait for RN until [waitUntilMs]. */
        data class Foreground(val waitUntilMs: Long) : Outcome()
        /** Still waiting (afterForeground / afterLockScreen only). */
        object Wait : Outcome()
        /** Phone locked (or screen off), RN not live: the lock-screen prompt, decided until [waitUntilMs]. */
        data class LockScreen(val waitUntilMs: Long) : Outcome()
    }

    interface Steps {
        fun epochCurrent(): Boolean
        /** RN's settings.mcpExecEnabled (natively: the server's switch and the Keystore mirror). */
        fun execOn(): Boolean
        /** The RN bridge heartbeat is fresh. */
        fun rnLive(): Boolean
        /**
         * Null when Shelly may be brought to the front now (interactive,
         * keyguard unlocked, overlay grant); else the reason (FG_LOCKED /
         * FG_NO_OVERLAY). Read only when RN is not live.
         */
        fun foregroundBlocker(): String?
        /**
         * Read only when [foregroundBlocker] said FG_LOCKED: null when the
         * lock-screen prompt can be shown (notifications on, full-screen
         * intent allowed); else FG_NOTIFICATIONS_OFF / FG_NO_FULL_SCREEN_INTENT.
         */
        fun lockScreenBlocker(): String?
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

    /** JS `/\.apk$/i` (no u flag: ASCII case folding only). */
    private fun endsWithApk(v: String): Boolean {
        if (v.length < 4) return false
        val t = v.substring(v.length - 4)
        return t[0] == '.' && (t[1] == 'a' || t[1] == 'A') && (t[2] == 'p' || t[2] == 'P') && (t[3] == 'k' || t[3] == 'K')
    }

    /** stage_install's argument checks (RN's stageInstallTool), in its order. */
    private fun validateStageInstall(args: JSONObject): Refusal? {
        val path = args.opt("path")
        if (path !is String || !path.startsWith("/") || !endsWithApk(path) || CONTROL_RE.containsMatchIn(path)) {
            return Refusal("invalid_path", APK_PATH_ERROR)
        }
        if (path.split('/').contains("..")) return Refusal("invalid_path", APK_DOTDOT_ERROR)
        // `expectedSha256 !== undefined`: a present key (JSON null included) must be a digest.
        if (args.has("expectedSha256") && !digestOk(args.opt("expectedSha256"))) return Refusal("invalid_digest", DIGEST_ERROR)
        return null
    }

    /** RN's argument checks, in its order. Null when they pass. */
    fun validate(tool: String, args: JSONObject): Refusal? {
        if (tool == OP_STAGE_INSTALL) return validateStageInstall(args)
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
        if (req.tool == OP_STAGE_INSTALL) {
            // RN's stageInstallTool: no epoch check before its arguments; it
            // reads the epoch after resolving the path (RN-only, rerun after
            // the handoff), right before its deadline check.
            if (!s.execOn()) return refuse(req.tool, Refusal("disabled", EXEC_DISABLED_ERROR))
            validate(req.tool, req.args)?.let { return refuse(req.tool, it) }
            if (!s.epochCurrent()) return Outcome.Answer("revoked", revokedResult())
        } else {
            if (!s.epochCurrent()) return Outcome.Answer("revoked", revokedResult())
            if (!s.execOn()) return refuse(req.tool, Refusal("disabled", EXEC_DISABLED_ERROR))
            validate(req.tool, req.args)?.let { return refuse(req.tool, it) }
        }
        if (isExpired(req.receivedAtMs, nowMs)) return Outcome.Answer("timeout", timeoutResult(req.tool))
        // RN would now run its content checks and ask. Only RN can ask.
        val fresh = nowMs - req.receivedAtMs <= McpTypedOpDecision.HANDOFF_MAX_AGE_MS
        if (s.rnLive()) {
            // RN is in front: hand off a fresh request; a stale one is
            // `not_attended` as before (nothing to bring forward).
            return if (fresh) Outcome.Handoff else notAttended(req.tool, null)
        }
        // RN is not live: bring Shelly to the front (see FOREGROUND_WAIT_MS).
        val waitUntil = foregroundWaitUntil(req.receivedAtMs, nowMs)
        if (waitUntil <= nowMs) return notAttended(req.tool, FG_NO_TIME)
        when (val blocker = s.foregroundBlocker()) {
            null -> return Outcome.Foreground(waitUntil)
            FG_LOCKED -> {
                s.lockScreenBlocker()?.let { return notAttended(req.tool, it) }
                return Outcome.LockScreen(lockScreenWaitUntil(req.receivedAtMs))
            }
            else -> return notAttended(req.tool, blocker)
        }
    }

    /** The lock-screen prompt is decided until the approval deadline minus [FOREGROUND_DEADLINE_MARGIN_MS]. */
    fun lockScreenWaitUntil(receivedAtMs: Long): Long = receivedAtMs + PRE_APPROVAL_MS - FOREGROUND_DEADLINE_MARGIN_MS

    /**
     * One poll of the lock-screen prompt. [state] is the request's
     * McpLockScreenApproval.Machine state (it expires itself at the wait's end).
     * APPROVED → Handoff (the consumer writes the lock-approval token first);
     * DENIED → RN's `denied`; the end of the wait → `not_attended`.
     */
    fun afterLockScreen(req: McpTypedOpDecision.Request, s: Steps, nowMs: Long, waitUntilMs: Long, state: McpLockScreenApproval.State): Outcome {
        if (!s.epochCurrent()) return Outcome.Answer("revoked", revokedResult())
        if (isExpired(req.receivedAtMs, nowMs)) return Outcome.Answer("timeout", timeoutResult(req.tool), FG_NO_DECISION)
        return when (state) {
            McpLockScreenApproval.State.APPROVED -> Outcome.Handoff
            McpLockScreenApproval.State.DENIED -> deniedAnswer(req.tool)
            McpLockScreenApproval.State.EXPIRED -> notAttended(req.tool, FG_NO_DECISION)
            McpLockScreenApproval.State.PENDING, McpLockScreenApproval.State.AUTHENTICATING ->
                if (nowMs >= waitUntilMs) notAttended(req.tool, FG_NO_DECISION) else Outcome.Wait
        }
    }

    /** RN's deny: audit `denied`, `{ok:false,error,code:"denied"}` (stage_install: without code). */
    fun deniedAnswer(tool: String): Outcome.Answer {
        val r = Refusal("denied", DENIED_MESSAGE)
        return Outcome.Answer(r.code, refusalResult(tool, r))
    }

    /**
     * The wait for RN ends at the earlier of [FOREGROUND_WAIT_MS] from now and
     * the pre-approval deadline minus [FOREGROUND_DEADLINE_MARGIN_MS].
     */
    fun foregroundWaitUntil(receivedAtMs: Long, nowMs: Long): Long =
        minOf(nowMs + FOREGROUND_WAIT_MS, receivedAtMs + PRE_APPROVAL_MS - FOREGROUND_DEADLINE_MARGIN_MS)

    /**
     * One poll of the foreground wait (the overlay is up and the activity was
     * started). [rnLiveSinceMs] is when the consumer first saw RN's heartbeat
     * live during this wait (null = not yet). On this path the handoff
     * freshness rule (HANDOFF_MAX_AGE_MS) is measured from that moment, not
     * from the request's receipt; the general rule in [decide] is unchanged.
     * The handoff must still come before the pre-approval deadline.
     */
    fun afterForeground(req: McpTypedOpDecision.Request, s: Steps, nowMs: Long, waitUntilMs: Long, rnLiveSinceMs: Long?): Outcome {
        if (!s.epochCurrent()) return Outcome.Answer("revoked", revokedResult())
        if (isExpired(req.receivedAtMs, nowMs)) {
            return Outcome.Answer("timeout", timeoutResult(req.tool), FG_RN_NOT_LIVE)
        }
        if (rnLiveSinceMs != null) {
            return if (nowMs - rnLiveSinceMs <= McpTypedOpDecision.HANDOFF_MAX_AGE_MS) Outcome.Handoff
            else notAttended(req.tool, FG_HANDOFF_WINDOW)
        }
        if (nowMs >= waitUntilMs) return notAttended(req.tool, FG_RN_NOT_LIVE)
        return Outcome.Wait
    }

    /** `not_attended` (today's answer when nobody can tap), optionally after a `foreground_failed` line. */
    fun notAttended(tool: String, foregroundFailure: String?): Outcome.Answer {
        val r = Refusal("not_attended", NOT_ATTENDED_MESSAGE)
        return Outcome.Answer(r.code, refusalResult(tool, r), foregroundFailure)
    }

    private fun refuse(tool: String, r: Refusal) = Outcome.Answer(r.code, refusalResult(tool, r))

    private val STAGE_INSTALL_CODED = setOf("digest_changed", "revoked", "not_attended", "handoff_failed")

    /**
     * RN's result for a refusal. stage_install's refuse() carries `code` only
     * for digest_changed / revoked; the native-only codes (not_attended,
     * handoff_failed) always carry it.
     */
    fun refusalResult(tool: String, r: Refusal): String =
        if (tool == OP_STAGE_INSTALL && r.code !in STAGE_INSTALL_CODED) errorResultNoCode(r.message) else errorResult(r)

    /**
     * RN's refuse(): the line with the code is written first; if the epoch
     * ended meanwhile the answer is `revoked`, and update_delivery_script
     * (whose refuse() calls revoked()) writes a second, `revoked` line.
     * Returns the extra audit code (or null) and the final result.
     */
    fun afterAudit(tool: String, answer: Outcome.Answer, epochCurrent: Boolean): Pair<String?, String> {
        // stage_install's refuse() does not look at the epoch again.
        if (answer.auditCode == "revoked" || epochCurrent || tool == OP_STAGE_INSTALL) return null to answer.result
        return (if (tool == OP_DELIVERY_SCRIPT) "revoked" else null) to revokedResult()
    }

    /** `{ok:false, error, code}` with RN's key order (bytes independent of org.json). */
    fun errorResult(r: Refusal): String = "{\"ok\":false,\"error\":${jsonString(r.message)},\"code\":${jsonString(r.code)}}"

    /** `{ok:false, error}` (stage_install's refuse() for most codes). */
    fun errorResultNoCode(message: String): String = "{\"ok\":false,\"error\":${jsonString(message)}}"

    /** The op's audit line, RN's shape: {kind, event, principal, code}. */
    fun auditJson(tool: String, principal: String, code: String, reason: String? = null): String {
        val kind = auditKind(tool)
        val tail = if (reason != null) ",\"reason\":${jsonString(reason)}" else ""
        return "{\"kind\":${jsonString(kind)},\"event\":${jsonString(kind)},\"principal\":${jsonString(principal)},\"code\":${jsonString(code)}$tail}"
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
