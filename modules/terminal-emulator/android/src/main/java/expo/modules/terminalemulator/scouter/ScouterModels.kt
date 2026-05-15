package expo.modules.terminalemulator.scouter

import org.json.JSONObject
import java.util.Locale
import java.util.UUID

enum class ScouterSource {
    CLAUDE_CODE,
    CODEX,
    SHELLY;

    fun badge(): String = when (this) {
        CLAUDE_CODE -> "CC"
        CODEX -> "CX"
        SHELLY -> "SH"
    }
}

enum class ScouterStatus {
    IDLE,
    THINKING,
    TOOL_RUNNING,
    WAITING_PERMISSION,
    COMPLETED,
    ERROR
}

enum class ScouterEventType {
    SESSION_START,
    USER_PROMPT,
    PRE_TOOL_USE,
    POST_TOOL_USE,
    POST_TOOL_USE_FAILURE,
    PERMISSION_REQUEST,
    NOTIFICATION,
    PRE_COMPACT,
    STOP,
    SNAPSHOT
}

data class ScouterEvent(
    val schemaVersion: String = "1.0",
    val eventId: String = UUID.randomUUID().toString(),
    val timestamp: Long = System.currentTimeMillis(),
    val source: ScouterSource,
    val sourceVersion: String = "unknown",
    val sessionId: String,
    val projectName: String,
    val gitBranch: String? = null,
    val cwd: String,
    val eventType: ScouterEventType,
    val derivedStatus: ScouterStatus,
    val toolName: String? = null,
    val targetFile: String? = null,
    val commandSummary: String? = null,
    val errorMessage: String? = null,
    val notificationMessage: String? = null,
    val tokensUsed: Long = 0,
    val totalCostUsd: Double = 0.0,
    val contextPercentRemaining: Double? = null
) {
    fun toSnapshot(previous: SessionSnapshot? = null): SessionSnapshot {
        return SessionSnapshot(
            sessionId = sessionId,
            source = source,
            projectName = projectName,
            gitBranch = gitBranch ?: previous?.gitBranch,
            currentStatus = derivedStatus,
            currentTool = toolName ?: previous?.currentTool,
            currentFile = targetFile ?: previous?.currentFile,
            lastEventAt = timestamp,
            sessionStartAt = previous?.sessionStartAt ?: timestamp,
            totalCostUsd = if (totalCostUsd > 0.0) totalCostUsd else previous?.totalCostUsd ?: 0.0,
            tokensUsed = if (tokensUsed > 0L) tokensUsed else previous?.tokensUsed ?: 0L,
            contextPercentRemaining = contextPercentRemaining ?: previous?.contextPercentRemaining,
            lastError = errorMessage ?: previous?.lastError
        )
    }
}

data class SessionSnapshot(
    val sessionId: String,
    val source: ScouterSource,
    val projectName: String,
    val gitBranch: String?,
    val currentStatus: ScouterStatus,
    val currentTool: String?,
    val currentFile: String?,
    val lastEventAt: Long,
    val sessionStartAt: Long,
    val totalCostUsd: Double,
    val tokensUsed: Long,
    val contextPercentRemaining: Double?,
    val lastError: String?
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("sessionId", sessionId)
        put("source", source.name)
        put("sourceBadge", source.badge())
        put("projectName", projectName)
        put("gitBranch", gitBranch)
        put("currentStatus", currentStatus.name)
        put("currentTool", currentTool)
        put("currentFile", currentFile)
        put("lastEventAt", lastEventAt)
        put("sessionStartAt", sessionStartAt)
        put("totalCostUsd", totalCostUsd)
        put("tokensUsed", tokensUsed)
        put("contextPercentRemaining", contextPercentRemaining)
        put("lastError", lastError)
    }

    companion object {
        fun fromJson(json: JSONObject): SessionSnapshot {
            return SessionSnapshot(
                sessionId = json.optString("sessionId"),
                source = runCatching { ScouterSource.valueOf(json.optString("source")) }.getOrDefault(ScouterSource.SHELLY),
                projectName = json.optString("projectName", "Shelly"),
                gitBranch = json.optString("gitBranch").ifBlank { null },
                currentStatus = runCatching { ScouterStatus.valueOf(json.optString("currentStatus")) }.getOrDefault(ScouterStatus.IDLE),
                currentTool = json.optString("currentTool").ifBlank { null },
                currentFile = json.optString("currentFile").ifBlank { null },
                lastEventAt = json.optLong("lastEventAt", System.currentTimeMillis()),
                sessionStartAt = json.optLong("sessionStartAt", System.currentTimeMillis()),
                totalCostUsd = json.optDouble("totalCostUsd", 0.0),
                tokensUsed = json.optLong("tokensUsed", 0L),
                contextPercentRemaining = if (json.has("contextPercentRemaining") && !json.isNull("contextPercentRemaining")) {
                    json.optDouble("contextPercentRemaining")
                } else null,
                lastError = json.optString("lastError").ifBlank { null }
            )
        }
    }
}

fun String.redactForScouter(): String {
    var out = this
    val patterns = listOf(
        Regex("(?i)(api[_-]?key|token|secret|password)=([^\\s]+)") to "$1=***",
        Regex("(?i)(bearer\\s+)[a-z0-9._\\-]+") to "$1***",
        Regex("(?i)(sk-[a-z0-9_\\-]{12,})") to "sk-***"
    )
    for ((pattern, replacement) in patterns) {
        out = pattern.replace(out, replacement)
    }
    return out
}

fun projectNameFromCwd(cwd: String?): String {
    val value = cwd?.ifBlank { null } ?: "Shelly"
    return value.trimEnd('/').substringAfterLast('/').ifBlank { "Shelly" }
}

fun inferSource(raw: String?): ScouterSource {
    val value = raw.orEmpty().lowercase(Locale.US)
    return when {
        "codex" in value -> ScouterSource.CODEX
        "claude" in value || value == "cc" -> ScouterSource.CLAUDE_CODE
        else -> ScouterSource.SHELLY
    }
}

