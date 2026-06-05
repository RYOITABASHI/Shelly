package expo.modules.terminalemulator.scouter

import android.content.Context
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

data class ScouterWidgetConversation(
    val lastPrompt: String?,
    val lastPromptAt: Long?,
    val lastAnswer: String?,
    val lastAnswerAt: Long?,
    val lastApproval: String?,
    val lastApprovalAt: Long?,
    val widgetPrompt: String?,
    val widgetPromptAt: Long?,
    val widgetStatus: String?,
    val widgetStatusAt: Long?,
    val widgetError: String?
)

data class ScouterWidgetCodexBinding(
    val codexSessionId: String?,
    val ptySessionId: String?,
    val shellySessionId: String?,
    val cwd: String?,
    val updatedAt: Long
)

data class ScouterWidgetPendingPrompt(
    val prompt: String,
    val queuedAt: Long,
    val codexSessionId: String?,
    val ptySessionId: String?,
    val shellySessionId: String?
)

data class ScouterWidgetPendingPromptTarget(
    val queuedAt: Long,
    val codexSessionId: String?,
    val ptySessionId: String?,
    val shellySessionId: String?
)

class ScouterStateStore(context: Context) {
    private val prefs = context.getSharedPreferences("scouter_state", Context.MODE_PRIVATE)
    private val helperStateFile = File(context.filesDir, "home/.scouter-state.json")
    private val lock = Any()

    fun isEnabled(): Boolean = prefs.getBoolean(KEY_ENABLED, false)

    fun setEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_ENABLED, enabled).commit()
        writeHelperState()
    }

    fun getSessionToken(): String {
        val existing = prefs.getString(KEY_TOKEN, null)
        if (!existing.isNullOrBlank()) return existing
        val generated = java.util.UUID.randomUUID().toString().replace("-", "")
        prefs.edit().putString(KEY_TOKEN, generated).commit()
        writeHelperState()
        return generated
    }

    fun setRuntimePort(port: Int) {
        prefs.edit().putInt(KEY_PORT, port).commit()
        writeHelperState()
    }

    fun getRuntimePort(): Int = prefs.getInt(KEY_PORT, -1)

    fun upsert(event: ScouterEvent): SessionSnapshot {
        synchronized(lock) {
            val all = readAllMutable()
            val previous = all[event.sessionId]
            val snapshot = event.toSnapshot(previous)
            all[event.sessionId] = snapshot
            appendRecentEventLocked(event)
            expireStaleWidgetPromptLocked()
            markWidgetPromptAnsweredLocked(event)
            writeAll(all)
            writeHelperStateLocked(all)
            return snapshot
        }
    }

    fun latest(): SessionSnapshot? {
        synchronized(lock) {
            return readAllMutable().values.maxByOrNull { it.lastEventAt }
        }
    }

    fun all(): List<SessionSnapshot> {
        synchronized(lock) {
            return readAllMutable().values.sortedByDescending { it.lastEventAt }
        }
    }

    fun clearSnapshots() {
        synchronized(lock) {
            prefs.edit()
                .putString(KEY_SNAPSHOTS, "[]")
                .putString(KEY_RECENT_EVENTS, "[]")
                .commit()
            writeHelperStateLocked(emptyMap())
        }
    }

    fun debugJson(): JSONObject {
        val recentEvents = readRecentEventJsons()
        return JSONObject().apply {
            put("enabled", isEnabled())
            put("port", getRuntimePort())
            put("recentEventCount", recentEvents.size)
            put("sessions", JSONArray().also { arr ->
                all().forEach { arr.put(it.toJson()) }
            })
            put("recentEvents", JSONArray().also { arr ->
                recentEvents.forEach { arr.put(it) }
            })
            put("widgetConversation", widgetConversation().toJson())
        }
    }

    fun recordWidgetPromptQueued(prompt: String) {
        val now = System.currentTimeMillis()
        prefs.edit()
            .putString(KEY_WIDGET_PROMPT, prompt.take(MAX_WIDGET_TEXT_LENGTH))
            .putLong(KEY_WIDGET_PROMPT_AT, now)
            .putString(KEY_WIDGET_STATUS, "queued")
            .putLong(KEY_WIDGET_STATUS_AT, now)
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_ERROR)
            .commit()
        writeHelperState()
    }

    fun recordWidgetPromptPending(prompt: String) {
        val now = System.currentTimeMillis()
        val binding = widgetCodexBinding()
        prefs.edit()
            .putString(KEY_WIDGET_PROMPT, prompt.take(MAX_WIDGET_TEXT_LENGTH))
            .putString(KEY_WIDGET_PENDING_PROMPT, prompt)
            .putLong(KEY_WIDGET_PROMPT_AT, now)
            .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_PENDING_TERMINAL)
            .putLong(KEY_WIDGET_STATUS_AT, now)
            .putString(KEY_WIDGET_PENDING_CODEX_SESSION_ID, binding?.codexSessionId?.takeIf { it.isNotBlank() })
            .putString(KEY_WIDGET_PENDING_PTY_SESSION_ID, binding?.ptySessionId?.takeIf { it.isNotBlank() })
            .putString(KEY_WIDGET_PENDING_SHELLY_SESSION_ID, binding?.shellySessionId?.takeIf { it.isNotBlank() })
            .remove(KEY_WIDGET_ERROR)
            .commit()
        writeHelperState()
    }

    fun recordWidgetPromptFailed(message: String) {
        prefs.edit()
            .putString(KEY_WIDGET_STATUS, "failed")
            .putLong(KEY_WIDGET_STATUS_AT, System.currentTimeMillis())
            .putString(KEY_WIDGET_ERROR, message.take(MAX_WIDGET_TEXT_LENGTH))
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .commit()
        writeHelperState()
    }

    fun recordWidgetApprovalDecision(decision: String) {
        val normalized = if (decision == "deny") "deny" else "allow"
        prefs.edit()
            .putString(KEY_WIDGET_STATUS, "approval_$normalized")
            .putLong(KEY_WIDGET_STATUS_AT, System.currentTimeMillis())
            .remove(KEY_WIDGET_ERROR)
            .commit()
        writeHelperState()
    }

    fun consumeWidgetPromptPending(
        codexSessionId: String?,
        ptySessionId: String?,
        shellySessionId: String?
    ): ScouterWidgetPendingPrompt? {
        synchronized(lock) {
            if (expireStaleWidgetPromptLocked()) return null
            val status = prefs.getString(KEY_WIDGET_STATUS, null)
            val statusAt = prefs.getLong(KEY_WIDGET_STATUS_AT, 0L)
            val now = System.currentTimeMillis()
            val retrySending = status == WIDGET_STATUS_SENDING &&
                (statusAt <= 0L || now - statusAt > WIDGET_SENDING_RETRY_AFTER_MS)
            if (status != WIDGET_STATUS_PENDING_TERMINAL && !retrySending) return null
            val prompt = prefs.getString(KEY_WIDGET_PENDING_PROMPT, null)?.ifBlank { null }
                ?: return null
            val queuedAt = prefs.getLong(KEY_WIDGET_PROMPT_AT, 0L).takeIf { it > 0L } ?: now
            val pendingCodexSessionId = prefs.getString(KEY_WIDGET_PENDING_CODEX_SESSION_ID, null)?.ifBlank { null }
            val pendingPtySessionId = prefs.getString(KEY_WIDGET_PENDING_PTY_SESSION_ID, null)?.ifBlank { null }
            val pendingShellySessionId = prefs.getString(KEY_WIDGET_PENDING_SHELLY_SESSION_ID, null)?.ifBlank { null }
            if (!pendingTargetMatches(
                    pendingCodexSessionId,
                    pendingPtySessionId,
                    pendingShellySessionId,
                    codexSessionId,
                    ptySessionId,
                    shellySessionId
                )
            ) {
                return null
            }
            prefs.edit()
                .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_SENDING)
                .putLong(KEY_WIDGET_STATUS_AT, now)
                .remove(KEY_WIDGET_ERROR)
                .commit()
            writeHelperStateLocked(readAllMutable())
            return ScouterWidgetPendingPrompt(
                prompt,
                queuedAt,
                pendingCodexSessionId,
                pendingPtySessionId,
                pendingShellySessionId
            )
        }
    }

    fun widgetPendingPromptTarget(): ScouterWidgetPendingPromptTarget? {
        synchronized(lock) {
            if (expireStaleWidgetPromptLocked()) return null
            val status = prefs.getString(KEY_WIDGET_STATUS, null)
            if (status != WIDGET_STATUS_PENDING_TERMINAL && status != WIDGET_STATUS_SENDING) return null
            prefs.getString(KEY_WIDGET_PENDING_PROMPT, null)?.ifBlank { null } ?: return null
            val queuedAt = prefs.getLong(KEY_WIDGET_PROMPT_AT, 0L)
                .takeIf { it > 0L }
                ?: System.currentTimeMillis()
            return ScouterWidgetPendingPromptTarget(
                queuedAt,
                prefs.getString(KEY_WIDGET_PENDING_CODEX_SESSION_ID, null)?.ifBlank { null },
                prefs.getString(KEY_WIDGET_PENDING_PTY_SESSION_ID, null)?.ifBlank { null },
                prefs.getString(KEY_WIDGET_PENDING_SHELLY_SESSION_ID, null)?.ifBlank { null }
            )
        }
    }

    fun widgetConversation(): ScouterWidgetConversation {
        synchronized(lock) {
            expireStaleWidgetPromptLocked()
            val recent = readRecentEventJsons().sortedBy { it.optLong("timestamp", 0L) }
            val lastPrompt = recent.lastOrNull { event ->
                event.optString("source") == ScouterSource.CODEX.name &&
                    event.optString("eventType") == ScouterEventType.USER_PROMPT.name &&
                    event.optString("lastMessage").isNotBlank()
            }
            val lastAnswer = recent.lastOrNull { event ->
                isCodexAnswerEvent(event)
            }
            val lastApproval = recent.lastOrNull { event ->
                isCodexApprovalEvent(event)
            }
            return ScouterWidgetConversation(
                lastPrompt = lastPrompt?.optString("lastMessage")?.ifBlank { null },
                lastPromptAt = lastPrompt?.optLong("timestamp", 0L)?.takeIf { it > 0L },
                lastAnswer = lastAnswer?.optString("lastMessage")?.ifBlank { null },
                lastAnswerAt = lastAnswer?.optLong("timestamp", 0L)?.takeIf { it > 0L },
                lastApproval = firstNonBlank(
                    lastApproval?.optString("lastMessage"),
                    lastApproval?.optString("commandSummary"),
                    lastApproval?.optString("toolName")
                ),
                lastApprovalAt = lastApproval?.optLong("timestamp", 0L)?.takeIf { it > 0L },
                widgetPrompt = prefs.getString(KEY_WIDGET_PROMPT, null)?.ifBlank { null },
                widgetPromptAt = prefs.getLong(KEY_WIDGET_PROMPT_AT, 0L).takeIf { it > 0L },
                widgetStatus = prefs.getString(KEY_WIDGET_STATUS, null)?.ifBlank { null },
                widgetStatusAt = prefs.getLong(KEY_WIDGET_STATUS_AT, 0L).takeIf { it > 0L },
                widgetError = prefs.getString(KEY_WIDGET_ERROR, null)?.ifBlank { null }
            )
        }
    }

    fun setWidgetCodexBinding(
        codexSessionId: String?,
        ptySessionId: String?,
        shellySessionId: String?,
        cwd: String?
    ) {
        if (ptySessionId.isNullOrBlank()) {
            clearWidgetCodexBinding()
            return
        }
        prefs.edit()
            .putString(KEY_WIDGET_CODEX_SESSION_ID, codexSessionId?.takeIf { it.isNotBlank() })
            .putString(KEY_WIDGET_PTY_SESSION_ID, ptySessionId)
            .putString(KEY_WIDGET_SHELLY_SESSION_ID, shellySessionId?.takeIf { it.isNotBlank() })
            .putString(KEY_WIDGET_CWD, cwd?.takeIf { it.isNotBlank() })
            .putLong(KEY_WIDGET_BINDING_AT, System.currentTimeMillis())
            .commit()
        writeHelperState()
    }

    fun clearWidgetCodexBinding() {
        prefs.edit()
            .remove(KEY_WIDGET_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PTY_SESSION_ID)
            .remove(KEY_WIDGET_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_CWD)
            .remove(KEY_WIDGET_BINDING_AT)
            .commit()
        writeHelperState()
    }

    fun widgetCodexBinding(): ScouterWidgetCodexBinding? {
        synchronized(lock) {
            val ptySessionId = prefs.getString(KEY_WIDGET_PTY_SESSION_ID, null)?.ifBlank { null }
                ?: return null
            return ScouterWidgetCodexBinding(
                codexSessionId = prefs.getString(KEY_WIDGET_CODEX_SESSION_ID, null)?.ifBlank { null },
                ptySessionId = ptySessionId,
                shellySessionId = prefs.getString(KEY_WIDGET_SHELLY_SESSION_ID, null)?.ifBlank { null },
                cwd = prefs.getString(KEY_WIDGET_CWD, null)?.ifBlank { null },
                updatedAt = prefs.getLong(KEY_WIDGET_BINDING_AT, 0L)
            )
        }
    }

    private fun readAllMutable(): MutableMap<String, SessionSnapshot> {
        val raw = prefs.getString(KEY_SNAPSHOTS, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
        val out = mutableMapOf<String, SessionSnapshot>()
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val snapshot = runCatching { SessionSnapshot.fromJson(obj) }.getOrNull() ?: continue
            out[snapshot.sessionId] = snapshot
        }
        return out
    }

    private fun writeAll(values: Map<String, SessionSnapshot>) {
        val arr = JSONArray()
        values.values.sortedByDescending { it.lastEventAt }.take(20).forEach {
            arr.put(it.toJson())
        }
        prefs.edit().putString(KEY_SNAPSHOTS, arr.toString()).commit()
    }

    private fun appendRecentEventLocked(event: ScouterEvent) {
        if (!shouldKeepRecentEvent(event)) return
        val events = readRecentEventJsons()
        events.add(event.toJson())
        writeRecentEventsLocked(events)
    }

    private fun readRecentEventJsons(): MutableList<JSONObject> {
        val raw = prefs.getString(KEY_RECENT_EVENTS, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
        val out = mutableListOf<JSONObject>()
        for (i in 0 until arr.length()) {
            arr.optJSONObject(i)?.let(out::add)
        }
        return out
    }

    private fun writeRecentEventsLocked(events: List<JSONObject>) {
        val byEventId = LinkedHashMap<String, JSONObject>()
        events
            .sortedBy { it.optLong("timestamp", 0L) }
            .forEach { event ->
                val id = event.optString("eventId").ifBlank {
                    listOf(
                        event.optString("sessionId"),
                        event.optString("eventType"),
                        event.optLong("timestamp", 0L).toString(),
                        event.optString("lastMessage"),
                        event.optString("toolName")
                    ).joinToString("|")
                }
                byEventId[id] = event
            }
        val arr = JSONArray()
        byEventId.values
            .sortedBy { it.optLong("timestamp", 0L) }
            .takeLast(MAX_RECENT_EVENTS)
            .forEach { arr.put(it) }
        prefs.edit().putString(KEY_RECENT_EVENTS, arr.toString()).commit()
    }

    private fun markWidgetPromptAnsweredLocked(event: ScouterEvent) {
        if (event.source != ScouterSource.CODEX) return
        val widgetStatus = prefs.getString(KEY_WIDGET_STATUS, null)
        val widgetStatusAt = prefs.getLong(KEY_WIDGET_STATUS_AT, 0L)
        val widgetPromptAt = prefs.getLong(KEY_WIDGET_PROMPT_AT, 0L)
        val widgetPrompt = prefs.getString(KEY_WIDGET_PROMPT, null)
        if (
            widgetStatus == "failed" &&
            (widgetStatusAt <= 0L || event.timestamp >= widgetStatusAt) &&
            (event.eventType == ScouterEventType.USER_PROMPT || isCodexAnswerEvent(event))
        ) {
            prefs.edit()
                .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_OBSERVED)
                .putLong(KEY_WIDGET_STATUS_AT, event.timestamp)
                .remove(KEY_WIDGET_ERROR)
                .commit()
        }
        if (
            widgetStatus in WIDGET_AWAITING_ANSWER_STATUSES &&
            event.eventType == ScouterEventType.USER_PROMPT &&
            widgetPromptAt > 0L &&
            event.timestamp >= widgetPromptAt &&
            widgetPromptMatches(widgetPrompt, event.lastMessage)
        ) {
            prefs.edit()
                .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_OBSERVED)
                .putLong(KEY_WIDGET_STATUS_AT, event.timestamp)
                .remove(KEY_WIDGET_PENDING_PROMPT)
                .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
                .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
                .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
                .remove(KEY_WIDGET_ERROR)
                .commit()
        }
        if (!isCodexAnswerEvent(event)) return
        if (widgetStatus !in WIDGET_AWAITING_ANSWER_STATUSES) return
        val cutoff = maxOf(widgetPromptAt, widgetStatusAt)
        if (cutoff <= 0L || event.timestamp < cutoff) return
        prefs.edit()
            .putString(KEY_WIDGET_STATUS, "answered")
            .putLong(KEY_WIDGET_STATUS_AT, event.timestamp)
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_ERROR)
            .commit()
    }

    private fun expireStaleWidgetPromptLocked(now: Long = System.currentTimeMillis()): Boolean {
        val status = prefs.getString(KEY_WIDGET_STATUS, null)
        if (status !in WIDGET_EXPIRABLE_STATUSES) return false
        val promptAt = prefs.getLong(KEY_WIDGET_PROMPT_AT, 0L)
            .takeIf { it > 0L }
            ?: prefs.getLong(KEY_WIDGET_STATUS_AT, 0L)
        if (promptAt <= 0L || now - promptAt <= WIDGET_PROMPT_EXPIRE_AFTER_MS) return false
        prefs.edit()
            .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_EXPIRED)
            .putLong(KEY_WIDGET_STATUS_AT, now)
            .remove(KEY_WIDGET_PROMPT)
            .remove(KEY_WIDGET_PROMPT_AT)
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_ERROR)
            .commit()
        writeHelperStateLocked(readAllMutable())
        return true
    }

    private fun shouldKeepRecentEvent(event: ScouterEvent): Boolean {
        if (event.source != ScouterSource.CODEX) return false
        if (event.eventType == ScouterEventType.USER_PROMPT && !event.lastMessage.isNullOrBlank()) return true
        if (isCodexAnswerEvent(event)) return true
        if (event.eventType == ScouterEventType.PRE_TOOL_USE && !event.toolName.isNullOrBlank()) return true
        if (event.eventType == ScouterEventType.POST_TOOL_USE && (!event.toolName.isNullOrBlank() || !event.commandSummary.isNullOrBlank())) return true
        if (event.eventType == ScouterEventType.POST_TOOL_USE_FAILURE) return true
        if (event.eventType == ScouterEventType.PERMISSION_REQUEST) return true
        if (event.derivedStatus == ScouterStatus.WAITING_PERMISSION) return true
        if (event.derivedStatus == ScouterStatus.ERROR) return true
        return false
    }

    private fun isCodexAnswerEvent(event: ScouterEvent): Boolean {
        return event.source == ScouterSource.CODEX &&
            !event.lastMessage.isNullOrBlank() &&
            event.eventType != ScouterEventType.USER_PROMPT &&
            event.derivedStatus in WIDGET_ANSWER_STATUSES
    }

    private fun isCodexAnswerEvent(event: JSONObject): Boolean {
        return event.optString("source") == ScouterSource.CODEX.name &&
            event.optString("lastMessage").isNotBlank() &&
            event.optString("eventType") != ScouterEventType.USER_PROMPT.name &&
            event.optString("derivedStatus") in WIDGET_ANSWER_STATUS_NAMES
    }

    private fun isCodexApprovalEvent(event: ScouterEvent): Boolean {
        return event.source == ScouterSource.CODEX &&
            (
                event.eventType == ScouterEventType.PERMISSION_REQUEST ||
                    event.derivedStatus == ScouterStatus.WAITING_PERMISSION
                ) &&
            (
                !event.lastMessage.isNullOrBlank() ||
                    !event.commandSummary.isNullOrBlank() ||
                    !event.toolName.isNullOrBlank()
                )
    }

    private fun isCodexApprovalEvent(event: JSONObject): Boolean {
        return event.optString("source") == ScouterSource.CODEX.name &&
            (
                event.optString("eventType") == ScouterEventType.PERMISSION_REQUEST.name ||
                    event.optString("derivedStatus") == ScouterStatus.WAITING_PERMISSION.name
                ) &&
            (
                event.optString("lastMessage").isNotBlank() ||
                    event.optString("commandSummary").isNotBlank() ||
                    event.optString("toolName").isNotBlank()
                )
    }

    private fun writeHelperState() {
        synchronized(lock) {
            writeHelperStateLocked(readAllMutable())
        }
    }

    private fun writeHelperStateLocked(values: Map<String, SessionSnapshot>) {
        val token = prefs.getString(KEY_TOKEN, "") ?: ""
        val json = JSONObject().apply {
            put("enabled", isEnabled())
            put("port", getRuntimePort())
            put("hookTokenPreview", if (token.isNotBlank()) token.take(6) + "…" else "")
            put("hookToken", token)
            val recentEvents = readRecentEventJsons()
            put("recentEventCount", recentEvents.size)
            put("sessions", JSONArray().also { arr ->
                values.values.sortedByDescending { it.lastEventAt }.take(20).forEach { arr.put(it.toJson()) }
            })
            put("recentEvents", JSONArray().also { arr ->
                recentEvents.forEach { arr.put(it) }
            })
        }
        helperStateFile.parentFile?.mkdirs()
        val tmp = File(helperStateFile.parentFile, helperStateFile.name + ".tmp")
        tmp.writeText(json.toString(2))
        if (!tmp.renameTo(helperStateFile)) {
            tmp.copyTo(helperStateFile, overwrite = true)
            tmp.delete()
        }
    }

    companion object {
        private const val KEY_ENABLED = "enabled"
        private const val KEY_TOKEN = "session_token"
        private const val KEY_PORT = "runtime_port"
        private const val KEY_SNAPSHOTS = "snapshots"
        private const val KEY_RECENT_EVENTS = "recent_events"
        private const val KEY_WIDGET_PROMPT = "widget_prompt"
        private const val KEY_WIDGET_PENDING_PROMPT = "widget_pending_prompt"
        private const val KEY_WIDGET_PROMPT_AT = "widget_prompt_at"
        private const val KEY_WIDGET_STATUS = "widget_status"
        private const val KEY_WIDGET_STATUS_AT = "widget_status_at"
        private const val KEY_WIDGET_ERROR = "widget_error"
        private const val KEY_WIDGET_CODEX_SESSION_ID = "widget_codex_session_id"
        private const val KEY_WIDGET_PTY_SESSION_ID = "widget_pty_session_id"
        private const val KEY_WIDGET_SHELLY_SESSION_ID = "widget_shelly_session_id"
        private const val KEY_WIDGET_CWD = "widget_cwd"
        private const val KEY_WIDGET_BINDING_AT = "widget_binding_at"
        private const val KEY_WIDGET_PENDING_CODEX_SESSION_ID = "widget_pending_codex_session_id"
        private const val KEY_WIDGET_PENDING_PTY_SESSION_ID = "widget_pending_pty_session_id"
        private const val KEY_WIDGET_PENDING_SHELLY_SESSION_ID = "widget_pending_shelly_session_id"
        private const val WIDGET_STATUS_PENDING_TERMINAL = "pending_terminal"
        private const val WIDGET_STATUS_SENDING = "sending"
        private const val WIDGET_STATUS_OBSERVED = "observed"
        private const val WIDGET_STATUS_EXPIRED = "expired"
        private const val WIDGET_SENDING_RETRY_AFTER_MS = 90_000L
        private const val WIDGET_PROMPT_EXPIRE_AFTER_MS = 2 * 60 * 1000L
        private const val MAX_RECENT_EVENTS = 120
        private const val MAX_WIDGET_TEXT_LENGTH = 500
        private val WIDGET_ANSWER_STATUSES = setOf(
            ScouterStatus.IDLE,
            ScouterStatus.COMPLETED
        )
        private val WIDGET_ANSWER_STATUS_NAMES = WIDGET_ANSWER_STATUSES.map { it.name }.toSet()
        private val WIDGET_AWAITING_ANSWER_STATUSES = setOf("queued", WIDGET_STATUS_SENDING)
        private val WIDGET_EXPIRABLE_STATUSES = setOf(WIDGET_STATUS_PENDING_TERMINAL, WIDGET_STATUS_SENDING)
    }
}

private fun ScouterWidgetConversation.toJson(): JSONObject = JSONObject().apply {
    lastPrompt?.let { put("lastPrompt", it) }
    lastPromptAt?.let { put("lastPromptAt", it) }
    lastAnswer?.let { put("lastAnswer", it) }
    lastAnswerAt?.let { put("lastAnswerAt", it) }
    lastApproval?.let { put("lastApproval", it) }
    lastApprovalAt?.let { put("lastApprovalAt", it) }
    widgetPrompt?.let { put("widgetPrompt", it) }
    widgetPromptAt?.let { put("widgetPromptAt", it) }
    widgetStatus?.let { put("widgetStatus", it) }
    widgetStatusAt?.let { put("widgetStatusAt", it) }
    widgetError?.let { put("widgetError", it) }
}

private fun pendingTargetMatches(
    pendingCodexSessionId: String?,
    pendingPtySessionId: String?,
    pendingShellySessionId: String?,
    codexSessionId: String?,
    ptySessionId: String?,
    shellySessionId: String?
): Boolean {
    if (pendingPtySessionId.isNullOrBlank() &&
        pendingShellySessionId.isNullOrBlank() &&
        pendingCodexSessionId.isNullOrBlank()
    ) {
        return true
    }
    return (!pendingPtySessionId.isNullOrBlank() && pendingPtySessionId == ptySessionId) ||
        (!pendingShellySessionId.isNullOrBlank() && pendingShellySessionId == shellySessionId) ||
        (!pendingCodexSessionId.isNullOrBlank() && pendingCodexSessionId == codexSessionId)
}

private fun firstNonBlank(vararg values: String?): String? {
    return values.firstOrNull { !it.isNullOrBlank() }?.trim()
}

private fun widgetPromptMatches(expected: String?, actual: String?): Boolean {
    val expectedValue = expected?.trim()?.replace(Regex("\\s+"), " ")
    val actualValue = actual?.trim()?.replace(Regex("\\s+"), " ")
    return !expectedValue.isNullOrBlank() && expectedValue == actualValue
}
