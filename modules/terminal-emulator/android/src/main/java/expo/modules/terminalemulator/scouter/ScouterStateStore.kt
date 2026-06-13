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
    val widgetError: String?,
    val privacySuppressed: Boolean = false,
    val choiceOptions: List<ChoiceOption> = emptyList()
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

data class ScouterWidgetPendingApproval(
    val decision: String,
    val queuedAt: Long,
    val approvalAt: Long?,
    val approvalText: String?,
    val codexSessionId: String?,
    val ptySessionId: String?,
    val shellySessionId: String?
)

// Live usage-limit override surfaced by the PTS poll. Codex shows a rate-limit
// banner with no JSONL event, so the widget's structured/JSONL rate line goes
// stale (e.g. "WK 4% left" while actually capped). This carries the live banner
// text so render can overwrite that stale line with "RATE LIMITED". recordedAt
// drives a freshness window so a dead poll thread can't pin it forever.
data class ScouterWidgetUsageLimited(
    val summary: String,
    val recordedAt: Long,
    val resetAt: Long?
)

class ScouterStateStore(context: Context) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences("scouter_state", Context.MODE_PRIVATE)
    private val helperStateFile = File(appContext.filesDir, "home/.scouter-state.json")
    private val lock = STORE_LOCK

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
            put("widgetCodexBinding", widgetCodexBinding()?.let { binding ->
                JSONObject().apply {
                    put("codexSessionId", binding.codexSessionId)
                    put("ptySessionId", binding.ptySessionId)
                    put("shellySessionId", binding.shellySessionId)
                    put("cwd", binding.cwd)
                    put("updatedAt", binding.updatedAt)
                }
            } ?: JSONObject.NULL)
            put("widgetConversation", widgetConversation().toJson())
            put("codexPet", ScouterCodexPet.debugJson(appContext))
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
            .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
            .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_ERROR)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_AT)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID)
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
            .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
            .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
            .remove(KEY_WIDGET_ERROR)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_AT)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID)
            .commit()
        writeHelperState()
    }

    fun recordWidgetPromptFailed(message: String) {
        prefs.edit()
            .putString(KEY_WIDGET_STATUS, "failed")
            .putLong(KEY_WIDGET_STATUS_AT, System.currentTimeMillis())
            .putString(KEY_WIDGET_ERROR, message.take(MAX_WIDGET_TEXT_LENGTH))
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
            .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_AT)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID)
            .commit()
        writeHelperState()
    }

    fun recordWidgetChoicePending(message: String, options: List<ChoiceOption> = emptyList()) {
        val editor = prefs.edit()
            .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_CHOICE_PENDING)
            .putLong(KEY_WIDGET_STATUS_AT, System.currentTimeMillis())
            .putString(KEY_WIDGET_ERROR, message.take(MAX_WIDGET_TEXT_LENGTH))
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
            .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
        if (options.isEmpty()) {
            editor.remove(KEY_WIDGET_CHOICE_OPTIONS)
        } else {
            editor.putString(KEY_WIDGET_CHOICE_OPTIONS, ChoiceOption.listToJson(options).toString())
        }
        editor.remove(KEY_WIDGET_PRIVACY_SUPPRESSED_AT)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID)
        editor.commit()
        writeHelperState()
    }

    // Records that a numbered choice was written to the bound terminal so the
    // widget pills stop re-firing (mirrors recordWidgetApprovalDecision).
    fun recordWidgetChoiceSelected(index: Int) {
        prefs.edit()
            .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_CHOICE_SENT)
            .putLong(KEY_WIDGET_STATUS_AT, System.currentTimeMillis())
            .putString(KEY_WIDGET_ERROR, "Sent choice $index to Codex")
            .remove(KEY_WIDGET_CHOICE_OPTIONS)
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
            .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_AT)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID)
            .commit()
        writeHelperState()
    }

    fun recordWidgetApprovalPending(decision: String): Boolean {
        val normalized = normalizeApprovalDecision(decision)
        val now = System.currentTimeMillis()
        val binding = widgetCodexBinding()
        if (binding?.codexSessionId.isNullOrBlank() || binding?.ptySessionId.isNullOrBlank()) {
            return false
        }
        val approval = latestApprovalForSession(binding?.codexSessionId) ?: return false
        val approvalAt = approval.optLong("timestamp", 0L).takeIf { it > 0L } ?: return false
        val approvalText = approvalTextFromEvent(approval)
        prefs.edit()
            .putString(KEY_WIDGET_STATUS, approvalPendingStatus(normalized))
            .putLong(KEY_WIDGET_STATUS_AT, now)
            .putString(KEY_WIDGET_PENDING_APPROVAL_DECISION, normalized)
            .putLong(KEY_WIDGET_PENDING_APPROVAL_AT, approvalAt)
            .putString(KEY_WIDGET_PENDING_APPROVAL_TEXT, approvalText?.take(MAX_WIDGET_TEXT_LENGTH))
            .putString(KEY_WIDGET_PENDING_CODEX_SESSION_ID, binding?.codexSessionId?.takeIf { it.isNotBlank() })
            .putString(KEY_WIDGET_PENDING_PTY_SESSION_ID, binding?.ptySessionId?.takeIf { it.isNotBlank() })
            .putString(KEY_WIDGET_PENDING_SHELLY_SESSION_ID, binding?.shellySessionId?.takeIf { it.isNotBlank() })
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_ERROR)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_AT)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID)
            .commit()
        writeHelperState()
        return true
    }

    fun recordWidgetApprovalDecision(decision: String) {
        val normalized = normalizeApprovalDecision(decision)
        prefs.edit()
            .putString(KEY_WIDGET_STATUS, "approval_$normalized")
            .putLong(KEY_WIDGET_STATUS_AT, System.currentTimeMillis())
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
            .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_ERROR)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_AT)
            .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID)
            .commit()
        writeHelperState()
    }

    fun recordWidgetApprovalFailed(message: String) {
        prefs.edit()
            .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_APPROVAL_FAILED)
            .putLong(KEY_WIDGET_STATUS_AT, System.currentTimeMillis())
            .putString(KEY_WIDGET_ERROR, message.take(MAX_WIDGET_TEXT_LENGTH))
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
            .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .commit()
        writeHelperState()
    }

    fun recordWidgetApprovalResolved() {
        prefs.edit()
            .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_OBSERVED)
            .putLong(KEY_WIDGET_STATUS_AT, System.currentTimeMillis())
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
            .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_ERROR)
            .commit()
        writeHelperState()
    }

    // Live usage-limit override (PTS poll). Widget-only: does NOT writeHelperState
    // since no shell helper consumes it, which keeps the per-poll re-record cheap.
    // The poll re-records on every active tick (~6s) while the banner is up and
    // clears it when the banner is gone, so the freshness window below is just a
    // safety net against a stalled poll thread.
    fun recordWidgetUsageLimited(summary: String, resetAt: Long? = null) {
        val trimmed = summary.trim().take(MAX_WIDGET_TEXT_LENGTH).ifBlank { "RATE LIMITED" }
        val editor = prefs.edit()
            .putString(KEY_WIDGET_USAGE_LIMITED_SUMMARY, trimmed)
            .putLong(KEY_WIDGET_USAGE_LIMITED_AT, System.currentTimeMillis())
        if (resetAt != null && resetAt > 0L) {
            editor.putLong(KEY_WIDGET_USAGE_LIMITED_RESET_AT, resetAt)
        } else {
            editor.remove(KEY_WIDGET_USAGE_LIMITED_RESET_AT)
        }
        editor.commit()
    }

    // Returns true when an override was actually present and cleared, so callers
    // can decide whether a widget refresh is worth firing.
    fun clearWidgetUsageLimited(): Boolean {
        if (!prefs.contains(KEY_WIDGET_USAGE_LIMITED_AT)) return false
        prefs.edit()
            .remove(KEY_WIDGET_USAGE_LIMITED_SUMMARY)
            .remove(KEY_WIDGET_USAGE_LIMITED_AT)
            .remove(KEY_WIDGET_USAGE_LIMITED_RESET_AT)
            .commit()
        return true
    }

    fun widgetUsageLimited(now: Long = System.currentTimeMillis()): ScouterWidgetUsageLimited? {
        val recordedAt = prefs.getLong(KEY_WIDGET_USAGE_LIMITED_AT, 0L).takeIf { it > 0L } ?: return null
        if (now - recordedAt > WIDGET_USAGE_LIMITED_FRESH_MS) return null
        val summary = prefs.getString(KEY_WIDGET_USAGE_LIMITED_SUMMARY, null)?.ifBlank { null } ?: return null
        return ScouterWidgetUsageLimited(
            summary = summary,
            recordedAt = recordedAt,
            resetAt = prefs.getLong(KEY_WIDGET_USAGE_LIMITED_RESET_AT, 0L).takeIf { it > 0L }
        )
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

    fun consumeWidgetApprovalPending(
        codexSessionId: String?,
        ptySessionId: String?,
        shellySessionId: String?
    ): ScouterWidgetPendingApproval? {
        synchronized(lock) {
            if (expireStaleWidgetPromptLocked()) return null
            val status = prefs.getString(KEY_WIDGET_STATUS, null)
            val storedDecision = prefs.getString(KEY_WIDGET_PENDING_APPROVAL_DECISION, null)
            val decision = firstNonBlank(storedDecision, approvalDecisionFromStatus(status))
                ?.let(::normalizeApprovalDecision)
                ?: return null
            val statusAt = prefs.getLong(KEY_WIDGET_STATUS_AT, 0L)
            val now = System.currentTimeMillis()
            val retrySending = status == approvalSendingStatus(decision) &&
                (statusAt <= 0L || now - statusAt > WIDGET_SENDING_RETRY_AFTER_MS)
            if (status != approvalPendingStatus(decision) && !retrySending) return null
            val pendingCodexSessionId = prefs.getString(KEY_WIDGET_PENDING_CODEX_SESSION_ID, null)?.ifBlank { null }
            val pendingPtySessionId = prefs.getString(KEY_WIDGET_PENDING_PTY_SESSION_ID, null)?.ifBlank { null }
            val pendingShellySessionId = prefs.getString(KEY_WIDGET_PENDING_SHELLY_SESSION_ID, null)?.ifBlank { null }
            val currentBinding = widgetCodexBinding()
            if (!approvalPendingTargetMatches(
                    pendingCodexSessionId,
                    pendingPtySessionId,
                    pendingShellySessionId,
                    codexSessionId,
                    ptySessionId,
                    shellySessionId,
                    currentBinding
                )
            ) {
                return null
            }
            val pendingApprovalAt = prefs.getLong(KEY_WIDGET_PENDING_APPROVAL_AT, 0L).takeIf { it > 0L }
                ?: return null
            val pendingApprovalText = prefs.getString(KEY_WIDGET_PENDING_APPROVAL_TEXT, null)?.ifBlank { null }
            val latestApproval = latestApprovalForSession(pendingCodexSessionId ?: codexSessionId) ?: return null
            val latestApprovalAt = latestApproval.optLong("timestamp", 0L).takeIf { it > 0L } ?: return null
            val latestApprovalText = approvalTextFromEvent(latestApproval)
            if (
                latestApprovalAt != pendingApprovalAt ||
                !approvalTextMatches(pendingApprovalText, latestApprovalText)
            ) {
                return null
            }
            prefs.edit()
                .putString(KEY_WIDGET_STATUS, approvalSendingStatus(decision))
                .putLong(KEY_WIDGET_STATUS_AT, now)
                .remove(KEY_WIDGET_ERROR)
                .commit()
            writeHelperStateLocked(readAllMutable())
            return ScouterWidgetPendingApproval(
                decision,
                statusAt.takeIf { it > 0L } ?: now,
                pendingApprovalAt,
                pendingApprovalText,
                pendingCodexSessionId,
                pendingPtySessionId,
                pendingShellySessionId
            )
        }
    }

    fun widgetPendingApprovalTarget(): ScouterWidgetPendingPromptTarget? {
        synchronized(lock) {
            if (expireStaleWidgetPromptLocked()) return null
            val status = prefs.getString(KEY_WIDGET_STATUS, null)
            val decision = firstNonBlank(
                prefs.getString(KEY_WIDGET_PENDING_APPROVAL_DECISION, null),
                approvalDecisionFromStatus(status)
            ) ?: return null
            if (status != approvalPendingStatus(decision) && status != approvalSendingStatus(decision)) return null
            prefs.getLong(KEY_WIDGET_PENDING_APPROVAL_AT, 0L).takeIf { it > 0L } ?: return null
            val queuedAt = prefs.getLong(KEY_WIDGET_STATUS_AT, 0L)
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

    fun widgetConversation(codexSessionId: String? = widgetCodexBinding()?.codexSessionId): ScouterWidgetConversation {
        synchronized(lock) {
            expireStaleWidgetPromptLocked()
            val privacyClearedAt = prefs.getLong(KEY_WIDGET_PRIVACY_CLEARED_AT, 0L)
            val privacySuppressed = isWidgetConversationPrivacySuppressedLocked(codexSessionId)
            val recent = if (codexSessionId.isNullOrBlank()) {
                emptyList()
            } else if (privacySuppressed) {
                emptyList()
            } else {
                readRecentEventJsons()
                    .filter { event ->
                        val timestamp = event.optLong("timestamp", 0L)
                        matchesCodexSession(event.optString("sessionId"), codexSessionId) &&
                            (privacyClearedAt <= 0L || timestamp > privacyClearedAt)
                    }
                    .sortedBy { it.optLong("timestamp", 0L) }
            }
            val lastPrompt = recent.lastOrNull { event ->
                event.optString("source") == ScouterSource.CODEX.name &&
                    event.optString("eventType") == ScouterEventType.USER_PROMPT.name &&
                    event.optString("lastMessage").isNotBlank()
            }
            val lastPromptAt = lastPrompt?.optLong("timestamp", 0L)?.takeIf { it > 0L }
            val lastAnswer = recent.lastOrNull { event ->
                isCodexAnswerEvent(event) &&
                    (privacyClearedAt <= 0L || (lastPromptAt != null && event.optLong("timestamp", 0L) >= lastPromptAt))
            }
            val lastApproval = recent.lastOrNull { event ->
                isCodexApprovalEvent(event) &&
                    (privacyClearedAt <= 0L || (lastPromptAt != null && event.optLong("timestamp", 0L) >= lastPromptAt))
            }
            val widgetPromptAt = prefs.getLong(KEY_WIDGET_PROMPT_AT, 0L).takeIf { it > 0L }
            val widgetStatusAt = prefs.getLong(KEY_WIDGET_STATUS_AT, 0L).takeIf { it > 0L }
            val widgetPromptVisible = isWidgetValueVisibleAfterPrivacy(widgetPromptAt, privacyClearedAt)
            val widgetStatusVisible = isWidgetValueVisibleAfterPrivacy(widgetStatusAt, privacyClearedAt)
            val widgetStatus = prefs.getString(KEY_WIDGET_STATUS, null)
                ?.ifBlank { null }
                ?.takeIf { widgetStatusVisible }
                ?.takeUnless { privacySuppressed }
            return ScouterWidgetConversation(
                lastPrompt = lastPrompt?.optString("lastMessage")?.ifBlank { null },
                lastPromptAt = lastPromptAt,
                lastAnswer = lastAnswer?.optString("lastMessage")?.ifBlank { null },
                lastAnswerAt = lastAnswer?.optLong("timestamp", 0L)?.takeIf { it > 0L },
                lastApproval = firstNonBlank(
                    lastApproval?.optString("lastMessage"),
                    lastApproval?.optString("commandSummary"),
                    lastApproval?.optString("toolName")
                ),
                lastApprovalAt = lastApproval?.optLong("timestamp", 0L)?.takeIf { it > 0L },
                widgetPrompt = prefs.getString(KEY_WIDGET_PROMPT, null)?.ifBlank { null }
                    ?.takeIf { widgetPromptVisible && !privacySuppressed },
                widgetPromptAt = widgetPromptAt?.takeIf { widgetPromptVisible && !privacySuppressed },
                widgetStatus = widgetStatus,
                widgetStatusAt = widgetStatusAt?.takeIf { widgetStatusVisible && !privacySuppressed },
                widgetError = prefs.getString(KEY_WIDGET_ERROR, null)?.ifBlank { null }
                    ?.takeIf { widgetStatusVisible && !privacySuppressed },
                privacySuppressed = privacySuppressed,
                choiceOptions = if (widgetStatus == WIDGET_STATUS_CHOICE_PENDING) {
                    ChoiceOption.listFromJson(prefs.getString(KEY_WIDGET_CHOICE_OPTIONS, null))
                } else {
                    emptyList()
                }
            )
        }
    }

    private fun emptyWidgetConversation(): ScouterWidgetConversation =
        ScouterWidgetConversation(
            lastPrompt = null,
            lastPromptAt = null,
            lastAnswer = null,
            lastAnswerAt = null,
            lastApproval = null,
            lastApprovalAt = null,
            widgetPrompt = null,
            widgetPromptAt = null,
            widgetStatus = null,
            widgetStatusAt = null,
            widgetError = null,
            privacySuppressed = false,
            choiceOptions = emptyList()
        )

    private fun isWidgetValueVisibleAfterPrivacy(timestamp: Long?, privacyClearedAt: Long): Boolean =
        privacyClearedAt <= 0L || (timestamp != null && timestamp > privacyClearedAt)

    fun setWidgetCodexBinding(
        codexSessionId: String?,
        ptySessionId: String?,
        shellySessionId: String?,
        cwd: String?
    ) {
        if (ptySessionId.isNullOrBlank()) {
            clearWidgetConversationForPrivacy()
            return
        }
        val suppressedSessionId = prefs.getString(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID, null)
            ?.ifBlank { null }
        val editor = prefs.edit()
            .putString(KEY_WIDGET_CODEX_SESSION_ID, codexSessionId?.takeIf { it.isNotBlank() })
            .putString(KEY_WIDGET_PTY_SESSION_ID, ptySessionId)
            .putString(KEY_WIDGET_SHELLY_SESSION_ID, shellySessionId?.takeIf { it.isNotBlank() })
            .putString(KEY_WIDGET_CWD, cwd?.takeIf { it.isNotBlank() })
            .putLong(KEY_WIDGET_BINDING_AT, System.currentTimeMillis())
        if (suppressedSessionId != null && !sameCodexSession(suppressedSessionId, codexSessionId)) {
            editor.remove(KEY_WIDGET_PRIVACY_SUPPRESSED_AT)
                .remove(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID)
        }
        editor.commit()
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

    fun clearWidgetConversationForPrivacy() {
        val currentCodexSessionId = prefs.getString(KEY_WIDGET_CODEX_SESSION_ID, null)?.ifBlank { null }
        val suppressedSessionId = prefs.getString(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID, null)
            ?.ifBlank { null }
        val now = System.currentTimeMillis()
        val editor = prefs.edit()
            .remove(KEY_WIDGET_PROMPT)
            .remove(KEY_WIDGET_PROMPT_AT)
            .remove(KEY_WIDGET_STATUS)
            .remove(KEY_WIDGET_STATUS_AT)
            .remove(KEY_WIDGET_ERROR)
            .remove(KEY_WIDGET_CHOICE_OPTIONS)
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
            .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PTY_SESSION_ID)
            .remove(KEY_WIDGET_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_CWD)
            .remove(KEY_WIDGET_BINDING_AT)
            .putLong(KEY_WIDGET_PRIVACY_CLEARED_AT, now)
            .putLong(KEY_WIDGET_PRIVACY_SUPPRESSED_AT, now)
        val nextSuppressedSessionId = currentCodexSessionId ?: suppressedSessionId
        if (nextSuppressedSessionId.isNullOrBlank()) {
            editor.remove(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID)
        } else {
            editor.putString(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID, nextSuppressedSessionId)
        }
        editor.commit()
        writeHelperState()
    }

    private fun isWidgetConversationPrivacySuppressedLocked(codexSessionId: String?): Boolean {
        val suppressedAt = prefs.getLong(KEY_WIDGET_PRIVACY_SUPPRESSED_AT, 0L)
        if (suppressedAt <= 0L) return false
        val suppressedSessionId = prefs.getString(KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID, null)
            ?.ifBlank { null }
        if (suppressedSessionId == null) return true
        if (codexSessionId.isNullOrBlank()) return true
        return sameCodexSession(suppressedSessionId, codexSessionId)
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
            widgetStatus == WIDGET_STATUS_APPROVAL_FAILED &&
            (widgetStatusAt <= 0L || event.timestamp >= widgetStatusAt) &&
            (event.eventType == ScouterEventType.USER_PROMPT || isCodexAnswerEvent(event) || isCodexApprovalEvent(event))
        ) {
            prefs.edit()
                .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_OBSERVED)
                .putLong(KEY_WIDGET_STATUS_AT, event.timestamp)
                .remove(KEY_WIDGET_ERROR)
                .commit()
        }
        if (
            widgetStatus == WIDGET_STATUS_CHOICE_PENDING &&
            (widgetStatusAt <= 0L || event.timestamp >= widgetStatusAt) &&
            (
                event.eventType == ScouterEventType.USER_PROMPT ||
                    event.eventType == ScouterEventType.PRE_TOOL_USE ||
                    event.eventType == ScouterEventType.POST_TOOL_USE ||
                    event.eventType == ScouterEventType.POST_TOOL_USE_FAILURE ||
                    isCodexAnswerEvent(event) ||
                    isCodexApprovalEvent(event)
                )
        ) {
            prefs.edit()
                .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_OBSERVED)
                .putLong(KEY_WIDGET_STATUS_AT, event.timestamp)
                .remove(KEY_WIDGET_CHOICE_OPTIONS)
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
                .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
                .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
                .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
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
            .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
            .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
            .remove(KEY_WIDGET_PENDING_CODEX_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_PTY_SESSION_ID)
            .remove(KEY_WIDGET_PENDING_SHELLY_SESSION_ID)
            .remove(KEY_WIDGET_ERROR)
            .commit()
    }

    private fun expireStaleWidgetPromptLocked(now: Long = System.currentTimeMillis()): Boolean {
        val status = prefs.getString(KEY_WIDGET_STATUS, null)
        if (status !in WIDGET_EXPIRABLE_STATUSES) return false
        val statusAt = prefs.getLong(KEY_WIDGET_STATUS_AT, 0L)
        val promptAt = if (approvalDecisionFromStatus(status) != null) {
            statusAt
        } else {
            prefs.getLong(KEY_WIDGET_PROMPT_AT, 0L)
                .takeIf { it > 0L }
                ?: statusAt
        }
        if (promptAt <= 0L || now - promptAt <= WIDGET_PROMPT_EXPIRE_AFTER_MS) return false
        prefs.edit()
            .putString(KEY_WIDGET_STATUS, WIDGET_STATUS_EXPIRED)
            .putLong(KEY_WIDGET_STATUS_AT, now)
            .remove(KEY_WIDGET_PROMPT)
            .remove(KEY_WIDGET_PROMPT_AT)
            .remove(KEY_WIDGET_PENDING_PROMPT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_DECISION)
            .remove(KEY_WIDGET_PENDING_APPROVAL_AT)
            .remove(KEY_WIDGET_PENDING_APPROVAL_TEXT)
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

    private fun latestApprovalForSession(codexSessionId: String?): JSONObject? {
        return readRecentEventJsons()
            .asSequence()
            .filter { event -> matchesCodexSession(event.optString("sessionId"), codexSessionId) }
            .filter { event -> isCodexApprovalEvent(event) }
            .maxByOrNull { event -> event.optLong("timestamp", 0L) }
    }

    private fun approvalTextFromEvent(event: JSONObject): String? {
        return firstNonBlank(
            event.optString("lastMessage"),
            event.optString("commandSummary"),
            event.optString("toolName")
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
        val parent = helperStateFile.parentFile ?: return
        parent.mkdirs()
        val tmp = File(parent, "${helperStateFile.name}.${android.os.Process.myTid()}.${System.nanoTime()}.tmp")
        tmp.writeText(json.toString(2))
        if (!tmp.renameTo(helperStateFile)) {
            tmp.copyTo(helperStateFile, overwrite = true)
            tmp.delete()
        }
    }

    companion object {
        private val STORE_LOCK = Any()
        private const val KEY_ENABLED = "enabled"
        private const val KEY_TOKEN = "session_token"
        private const val KEY_PORT = "runtime_port"
        private const val KEY_SNAPSHOTS = "snapshots"
        private const val KEY_RECENT_EVENTS = "recent_events"
        private const val KEY_WIDGET_PROMPT = "widget_prompt"
        private const val KEY_WIDGET_PENDING_PROMPT = "widget_pending_prompt"
        private const val KEY_WIDGET_PENDING_APPROVAL_DECISION = "widget_pending_approval_decision"
        private const val KEY_WIDGET_PENDING_APPROVAL_AT = "widget_pending_approval_at"
        private const val KEY_WIDGET_PENDING_APPROVAL_TEXT = "widget_pending_approval_text"
        private const val KEY_WIDGET_PROMPT_AT = "widget_prompt_at"
        private const val KEY_WIDGET_STATUS = "widget_status"
        private const val KEY_WIDGET_STATUS_AT = "widget_status_at"
        private const val KEY_WIDGET_ERROR = "widget_error"
        private const val KEY_WIDGET_CHOICE_OPTIONS = "widget_choice_options"
        private const val KEY_WIDGET_PRIVACY_CLEARED_AT = "widget_privacy_cleared_at"
        private const val KEY_WIDGET_PRIVACY_SUPPRESSED_AT = "widget_privacy_suppressed_at"
        private const val KEY_WIDGET_PRIVACY_SUPPRESSED_CODEX_SESSION_ID = "widget_privacy_suppressed_codex_session_id"
        private const val KEY_WIDGET_CODEX_SESSION_ID = "widget_codex_session_id"
        private const val KEY_WIDGET_PTY_SESSION_ID = "widget_pty_session_id"
        private const val KEY_WIDGET_SHELLY_SESSION_ID = "widget_shelly_session_id"
        private const val KEY_WIDGET_CWD = "widget_cwd"
        private const val KEY_WIDGET_BINDING_AT = "widget_binding_at"
        private const val KEY_WIDGET_PENDING_CODEX_SESSION_ID = "widget_pending_codex_session_id"
        private const val KEY_WIDGET_PENDING_PTY_SESSION_ID = "widget_pending_pty_session_id"
        private const val KEY_WIDGET_PENDING_SHELLY_SESSION_ID = "widget_pending_shelly_session_id"
        private const val KEY_WIDGET_USAGE_LIMITED_SUMMARY = "widget_usage_limited_summary"
        private const val KEY_WIDGET_USAGE_LIMITED_AT = "widget_usage_limited_at"
        private const val KEY_WIDGET_USAGE_LIMITED_RESET_AT = "widget_usage_limited_reset_at"
        private const val WIDGET_STATUS_PENDING_TERMINAL = "pending_terminal"
        private const val WIDGET_STATUS_SENDING = "sending"
        private const val WIDGET_STATUS_CHOICE_PENDING = "choice_pending"
        private const val WIDGET_STATUS_CHOICE_SENT = "choice_sent"
        private const val WIDGET_STATUS_OBSERVED = "observed"
        private const val WIDGET_STATUS_EXPIRED = "expired"
        private const val WIDGET_STATUS_APPROVAL_FAILED = "approval_failed"
        private const val WIDGET_STATUS_APPROVAL_PENDING_PREFIX = "approval_pending_"
        private const val WIDGET_STATUS_APPROVAL_SENDING_PREFIX = "approval_sending_"
        private const val WIDGET_SENDING_RETRY_AFTER_MS = 90_000L
        private const val WIDGET_PROMPT_EXPIRE_AFTER_MS = 2 * 60 * 1000L
        // Safety net only: the poll re-records on every active tick (~6s) and
        // clears on resolve, so the override should never actually age out while
        // the banner is up. This just frees it if the poll thread dies.
        private const val WIDGET_USAGE_LIMITED_FRESH_MS = 3 * 60 * 1000L
        private const val MAX_RECENT_EVENTS = 120
        private const val MAX_WIDGET_TEXT_LENGTH = 500
        private val WIDGET_ANSWER_STATUSES = setOf(
            ScouterStatus.IDLE,
            ScouterStatus.COMPLETED
        )
        private val WIDGET_ANSWER_STATUS_NAMES = WIDGET_ANSWER_STATUSES.map { it.name }.toSet()
        private val WIDGET_AWAITING_ANSWER_STATUSES = setOf("queued", WIDGET_STATUS_SENDING)
        private val WIDGET_EXPIRABLE_STATUSES = setOf(
            WIDGET_STATUS_PENDING_TERMINAL,
            WIDGET_STATUS_SENDING,
            approvalPendingStatus("allow"),
            approvalPendingStatus("deny"),
            approvalSendingStatus("allow"),
            approvalSendingStatus("deny")
        )

        fun normalizeApprovalDecision(decision: String): String = if (decision == "deny") "deny" else "allow"

        fun approvalPendingStatus(decision: String): String =
            WIDGET_STATUS_APPROVAL_PENDING_PREFIX + normalizeApprovalDecision(decision)

        fun approvalSendingStatus(decision: String): String =
            WIDGET_STATUS_APPROVAL_SENDING_PREFIX + normalizeApprovalDecision(decision)

        fun approvalDecisionFromStatus(status: String?): String? = when (status) {
            approvalPendingStatus("allow"), approvalSendingStatus("allow"), "approval_allow" -> "allow"
            approvalPendingStatus("deny"), approvalSendingStatus("deny"), "approval_deny" -> "deny"
            else -> null
        }

        fun approvalFailedStatus(): String = WIDGET_STATUS_APPROVAL_FAILED
        fun choicePendingStatus(): String = WIDGET_STATUS_CHOICE_PENDING
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
    put("privacySuppressed", privacySuppressed)
    if (choiceOptions.isNotEmpty()) put("choiceOptions", ChoiceOption.listToJson(choiceOptions))
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
        sameCodexSession(pendingCodexSessionId, codexSessionId)
}

private fun approvalPendingTargetMatches(
    pendingCodexSessionId: String?,
    pendingPtySessionId: String?,
    pendingShellySessionId: String?,
    codexSessionId: String?,
    ptySessionId: String?,
    shellySessionId: String?,
    currentBinding: ScouterWidgetCodexBinding?
): Boolean {
    if (pendingCodexSessionId.isNullOrBlank() || pendingPtySessionId.isNullOrBlank()) {
        return false
    }
    if (!sameCodexSession(pendingCodexSessionId, codexSessionId)) return false
    if (pendingPtySessionId == ptySessionId) {
        return pendingShellySessionId.isNullOrBlank() || pendingShellySessionId == shellySessionId
    }

    return currentBinding != null &&
        sameCodexSession(pendingCodexSessionId, currentBinding.codexSessionId) &&
        currentBinding.ptySessionId == ptySessionId &&
        (currentBinding.shellySessionId.isNullOrBlank() || currentBinding.shellySessionId == shellySessionId)
}

private fun firstNonBlank(vararg values: String?): String? {
    return values.firstOrNull { !it.isNullOrBlank() }?.trim()
}

private fun matchesCodexSession(candidate: String?, expected: String?): Boolean {
    val expectedValue = normalizeScouterCodexSessionId(expected) ?: return true
    val candidateValue = normalizeScouterCodexSessionId(candidate) ?: return false
    return candidateValue == expectedValue
}

private fun sameCodexSession(left: String?, right: String?): Boolean {
    val leftValue = normalizeScouterCodexSessionId(left) ?: return false
    val rightValue = normalizeScouterCodexSessionId(right) ?: return false
    return leftValue == rightValue
}

private fun approvalTextMatches(expected: String?, actual: String?): Boolean {
    val expectedValue = normalizeApprovalText(expected) ?: return false
    val actualValue = normalizeApprovalText(actual) ?: return false
    return expectedValue == actualValue
}

private fun normalizeApprovalText(value: String?): String? {
    return value
        ?.trim()
        ?.replace(Regex("\\s+"), " ")
        ?.takeIf { it.isNotBlank() }
}

private fun normalizeScouterCodexSessionId(sessionId: String?): String? {
    val trimmed = sessionId?.trim().orEmpty()
    if (trimmed.isBlank()) return null
    return CODEX_SESSION_UUID_SUFFIX_RE.find(trimmed)?.groupValues?.getOrNull(1) ?: trimmed
}

private fun widgetPromptMatches(expected: String?, actual: String?): Boolean {
    val expectedValue = expected?.trim()?.replace(Regex("\\s+"), " ")
    val actualValue = actual?.trim()?.replace(Regex("\\s+"), " ")
    return !expectedValue.isNullOrBlank() && expectedValue == actualValue
}

private val CODEX_SESSION_UUID_SUFFIX_RE =
    Regex("""([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$""")
