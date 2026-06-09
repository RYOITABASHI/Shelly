package expo.modules.terminalemulator.scouter

import org.json.JSONObject
import java.util.Locale
import java.util.UUID

enum class ScouterSource {
    CODEX,
    LOCAL_LLM,
    SHELLY;

    fun badge(): String = when (this) {
        CODEX -> "CX"
        LOCAL_LLM -> "LL"
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
    val modelName: String? = null,
    val tokensUsed: Long = 0,
    val inputTokens: Long = 0,
    val outputTokens: Long = 0,
    val reasoningOutputTokens: Long = 0,
    val cacheCreationInputTokens: Long = 0,
    val cacheReadInputTokens: Long = 0,
    val totalCostUsd: Double = 0.0,
    val contextPercentRemaining: Double? = null,
    val lastMessage: String? = null,
    val localBackend: String? = null,
    val localEndpoint: String? = null,
    val tokensPerSecond: Double? = null,
    val queueSize: Int? = null,
    val latencyMs: Long? = null,
    val firstTokenLatencyMs: Long? = null,
    val rateLimitStatus: ScouterRateLimitStatus? = null,
    val rateLimitRemainingRequests: Long? = null,
    val rateLimitRemainingTokens: Long? = null,
    val rateLimitResetAt: Long? = null,
    val retryAfterSeconds: Long? = null,
    // Structured Codex rate_limits snapshot (remaining derived later as 100 - used).
    val rateLimitPrimaryUsedPercent: Double? = null,
    val rateLimitSecondaryUsedPercent: Double? = null,
    val rateLimitPrimaryResetAt: Long? = null,
    val rateLimitSecondaryResetAt: Long? = null
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("schemaVersion", schemaVersion)
        put("eventId", eventId)
        put("timestamp", timestamp)
        put("source", source.name)
        put("sourceBadge", source.badge())
        put("sourceVersion", sourceVersion)
        put("sessionId", sessionId)
        put("projectName", projectName)
        put("gitBranch", gitBranch)
        put("cwd", cwd)
        put("eventType", eventType.name)
        put("derivedStatus", derivedStatus.name)
        put("toolName", toolName)
        put("targetFile", targetFile)
        put("commandSummary", commandSummary)
        put("errorMessage", errorMessage)
        put("notificationMessage", notificationMessage)
        put("modelName", modelName)
        put("tokensUsed", tokensUsed)
        put("inputTokens", inputTokens)
        put("outputTokens", outputTokens)
        put("reasoningOutputTokens", reasoningOutputTokens)
        put("cacheCreationInputTokens", cacheCreationInputTokens)
        put("cacheReadInputTokens", cacheReadInputTokens)
        put("totalCostUsd", totalCostUsd)
        put("contextPercentRemaining", contextPercentRemaining)
        put("lastMessage", lastMessage)
        put("localBackend", localBackend)
        put("localEndpoint", localEndpoint)
        put("tokensPerSecond", tokensPerSecond)
        put("queueSize", queueSize)
        put("latencyMs", latencyMs)
        put("firstTokenLatencyMs", firstTokenLatencyMs)
        put("rateLimitStatus", rateLimitStatus?.name)
        put("rateLimitRemainingRequests", rateLimitRemainingRequests)
        put("rateLimitRemainingTokens", rateLimitRemainingTokens)
        put("rateLimitResetAt", rateLimitResetAt)
        put("retryAfterSeconds", retryAfterSeconds)
        put("rateLimitPrimaryUsedPercent", rateLimitPrimaryUsedPercent)
        put("rateLimitSecondaryUsedPercent", rateLimitSecondaryUsedPercent)
        put("rateLimitPrimaryResetAt", rateLimitPrimaryResetAt)
        put("rateLimitSecondaryResetAt", rateLimitSecondaryResetAt)
    }

    fun toSnapshot(previous: SessionSnapshot? = null): SessionSnapshot {
        val isTerminalState = derivedStatus == ScouterStatus.COMPLETED ||
            derivedStatus == ScouterStatus.IDLE ||
            derivedStatus == ScouterStatus.ERROR
        val clearsRateLimitDetails = rateLimitStatus == ScouterRateLimitStatus.OK
        return SessionSnapshot(
            sessionId = sessionId,
            source = source,
            projectName = projectName,
            gitBranch = gitBranch ?: previous?.gitBranch,
            cwd = cwd,
            currentStatus = derivedStatus,
            currentTool = if (isTerminalState) null else toolName ?: previous?.currentTool,
            currentFile = if (isTerminalState) null else targetFile ?: previous?.currentFile,
            lastEventAt = timestamp,
            sessionStartAt = previous?.sessionStartAt ?: timestamp,
            modelName = modelName ?: previous?.modelName,
            totalCostUsd = if (totalCostUsd > 0.0) totalCostUsd else previous?.totalCostUsd ?: 0.0,
            tokensUsed = if (tokensUsed > 0L) tokensUsed else previous?.tokensUsed ?: 0L,
            inputTokens = if (inputTokens > 0L) inputTokens else previous?.inputTokens ?: 0L,
            outputTokens = if (outputTokens > 0L) outputTokens else previous?.outputTokens ?: 0L,
            reasoningOutputTokens = if (reasoningOutputTokens > 0L) reasoningOutputTokens else previous?.reasoningOutputTokens ?: 0L,
            cacheCreationInputTokens = if (cacheCreationInputTokens > 0L) cacheCreationInputTokens else previous?.cacheCreationInputTokens ?: 0L,
            cacheReadInputTokens = if (cacheReadInputTokens > 0L) cacheReadInputTokens else previous?.cacheReadInputTokens ?: 0L,
            contextPercentRemaining = contextPercentRemaining ?: previous?.contextPercentRemaining,
            lastError = errorMessage ?: previous?.lastError,
            lastMessage = lastMessage ?: previous?.lastMessage,
            localBackend = localBackend ?: previous?.localBackend,
            localEndpoint = localEndpoint ?: previous?.localEndpoint,
            tokensPerSecond = tokensPerSecond ?: previous?.tokensPerSecond,
            queueSize = queueSize ?: previous?.queueSize,
            latencyMs = latencyMs ?: previous?.latencyMs,
            firstTokenLatencyMs = firstTokenLatencyMs ?: previous?.firstTokenLatencyMs,
            rateLimitStatus = rateLimitStatus ?: previous?.rateLimitStatus,
            rateLimitRemainingRequests = if (clearsRateLimitDetails) rateLimitRemainingRequests else rateLimitRemainingRequests ?: previous?.rateLimitRemainingRequests,
            rateLimitRemainingTokens = if (clearsRateLimitDetails) rateLimitRemainingTokens else rateLimitRemainingTokens ?: previous?.rateLimitRemainingTokens,
            rateLimitResetAt = if (clearsRateLimitDetails) rateLimitResetAt else rateLimitResetAt ?: previous?.rateLimitResetAt,
            retryAfterSeconds = if (clearsRateLimitDetails) retryAfterSeconds else retryAfterSeconds ?: previous?.retryAfterSeconds,
            // Carry forward so a later token_count without rate_limits doesn't wipe a prior value.
            rateLimitPrimaryUsedPercent = rateLimitPrimaryUsedPercent ?: previous?.rateLimitPrimaryUsedPercent,
            rateLimitSecondaryUsedPercent = rateLimitSecondaryUsedPercent ?: previous?.rateLimitSecondaryUsedPercent,
            rateLimitPrimaryResetAt = rateLimitPrimaryResetAt ?: previous?.rateLimitPrimaryResetAt,
            rateLimitSecondaryResetAt = rateLimitSecondaryResetAt ?: previous?.rateLimitSecondaryResetAt
        )
    }
}

data class SessionSnapshot(
    val sessionId: String,
    val source: ScouterSource,
    val projectName: String,
    val gitBranch: String?,
    val cwd: String,
    val currentStatus: ScouterStatus,
    val currentTool: String?,
    val currentFile: String?,
    val lastEventAt: Long,
    val sessionStartAt: Long,
    val modelName: String?,
    val totalCostUsd: Double,
    val tokensUsed: Long,
    val inputTokens: Long,
    val outputTokens: Long,
    val reasoningOutputTokens: Long,
    val cacheCreationInputTokens: Long,
    val cacheReadInputTokens: Long,
    val contextPercentRemaining: Double?,
    val lastError: String?,
    val lastMessage: String?,
    val localBackend: String?,
    val localEndpoint: String?,
    val tokensPerSecond: Double?,
    val queueSize: Int?,
    val latencyMs: Long?,
    val firstTokenLatencyMs: Long?,
    val rateLimitStatus: ScouterRateLimitStatus?,
    val rateLimitRemainingRequests: Long?,
    val rateLimitRemainingTokens: Long?,
    val rateLimitResetAt: Long?,
    val retryAfterSeconds: Long?,
    // Structured Codex rate_limits snapshot (remaining derived later as 100 - used).
    val rateLimitPrimaryUsedPercent: Double? = null,
    val rateLimitSecondaryUsedPercent: Double? = null,
    val rateLimitPrimaryResetAt: Long? = null,
    val rateLimitSecondaryResetAt: Long? = null
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("sessionId", sessionId)
        put("source", source.name)
        put("sourceBadge", source.badge())
        put("projectName", projectName)
        put("gitBranch", gitBranch)
        put("cwd", cwd)
        put("currentStatus", currentStatus.name)
        put("currentTool", currentTool)
        put("currentFile", currentFile)
        put("lastEventAt", lastEventAt)
        put("sessionStartAt", sessionStartAt)
        put("modelName", modelName)
        put("totalCostUsd", totalCostUsd)
        put("tokensUsed", tokensUsed)
        put("inputTokens", inputTokens)
        put("outputTokens", outputTokens)
        put("reasoningOutputTokens", reasoningOutputTokens)
        put("cacheCreationInputTokens", cacheCreationInputTokens)
        put("cacheReadInputTokens", cacheReadInputTokens)
        put("contextPercentRemaining", contextPercentRemaining)
        put("lastError", lastError)
        put("lastMessage", lastMessage)
        put("localBackend", localBackend)
        put("localEndpoint", localEndpoint)
        put("tokensPerSecond", tokensPerSecond)
        put("queueSize", queueSize)
        put("latencyMs", latencyMs)
        put("firstTokenLatencyMs", firstTokenLatencyMs)
        put("rateLimitStatus", rateLimitStatus?.name)
        put("rateLimitRemainingRequests", rateLimitRemainingRequests)
        put("rateLimitRemainingTokens", rateLimitRemainingTokens)
        put("rateLimitResetAt", rateLimitResetAt)
        put("retryAfterSeconds", retryAfterSeconds)
        put("rateLimitPrimaryUsedPercent", rateLimitPrimaryUsedPercent)
        put("rateLimitSecondaryUsedPercent", rateLimitSecondaryUsedPercent)
        put("rateLimitPrimaryResetAt", rateLimitPrimaryResetAt)
        put("rateLimitSecondaryResetAt", rateLimitSecondaryResetAt)
    }

    companion object {
        fun fromJson(json: JSONObject): SessionSnapshot {
            return SessionSnapshot(
                sessionId = json.optString("sessionId"),
                source = runCatching { ScouterSource.valueOf(json.optString("source")) }.getOrDefault(ScouterSource.SHELLY),
                projectName = json.optString("projectName", "Shelly"),
                gitBranch = json.optString("gitBranch").ifBlank { null },
                cwd = json.optString("cwd").ifBlank { null } ?: "",
                currentStatus = runCatching { ScouterStatus.valueOf(json.optString("currentStatus")) }.getOrDefault(ScouterStatus.IDLE),
                currentTool = json.optString("currentTool").ifBlank { null },
                currentFile = json.optString("currentFile").ifBlank { null },
                lastEventAt = json.optLong("lastEventAt", System.currentTimeMillis()),
                sessionStartAt = json.optLong("sessionStartAt", System.currentTimeMillis()),
                modelName = json.optString("modelName").ifBlank { null },
                totalCostUsd = json.optDouble("totalCostUsd", 0.0),
                tokensUsed = json.optLong("tokensUsed", 0L),
                inputTokens = json.optLong("inputTokens", 0L),
                outputTokens = json.optLong("outputTokens", 0L),
                reasoningOutputTokens = json.optLong("reasoningOutputTokens", 0L),
                cacheCreationInputTokens = json.optLong("cacheCreationInputTokens", 0L),
                cacheReadInputTokens = json.optLong("cacheReadInputTokens", 0L),
                contextPercentRemaining = if (json.has("contextPercentRemaining") && !json.isNull("contextPercentRemaining")) {
                    json.optDouble("contextPercentRemaining")
                } else null,
                lastError = json.optString("lastError").ifBlank { null },
                lastMessage = json.optString("lastMessage").ifBlank { null },
                localBackend = json.optString("localBackend").ifBlank { null },
                localEndpoint = json.optString("localEndpoint").ifBlank { null },
                tokensPerSecond = if (json.has("tokensPerSecond") && !json.isNull("tokensPerSecond")) {
                    json.optDouble("tokensPerSecond")
                } else null,
                queueSize = if (json.has("queueSize") && !json.isNull("queueSize")) {
                    json.optInt("queueSize")
                } else null,
                latencyMs = if (json.has("latencyMs") && !json.isNull("latencyMs")) {
                    json.optLong("latencyMs")
                } else null,
                firstTokenLatencyMs = if (json.has("firstTokenLatencyMs") && !json.isNull("firstTokenLatencyMs")) {
                    json.optLong("firstTokenLatencyMs")
                } else null,
                rateLimitStatus = parseScouterRateLimitStatus(json.optString("rateLimitStatus").ifBlank { null }),
                rateLimitRemainingRequests = if (json.has("rateLimitRemainingRequests") && !json.isNull("rateLimitRemainingRequests")) {
                    json.optLong("rateLimitRemainingRequests")
                } else null,
                rateLimitRemainingTokens = if (json.has("rateLimitRemainingTokens") && !json.isNull("rateLimitRemainingTokens")) {
                    json.optLong("rateLimitRemainingTokens")
                } else null,
                rateLimitResetAt = if (json.has("rateLimitResetAt") && !json.isNull("rateLimitResetAt")) {
                    json.optLong("rateLimitResetAt")
                } else null,
                retryAfterSeconds = if (json.has("retryAfterSeconds") && !json.isNull("retryAfterSeconds")) {
                    json.optLong("retryAfterSeconds")
                } else null,
                rateLimitPrimaryUsedPercent = if (json.has("rateLimitPrimaryUsedPercent") && !json.isNull("rateLimitPrimaryUsedPercent")) {
                    json.optDouble("rateLimitPrimaryUsedPercent")
                } else null,
                rateLimitSecondaryUsedPercent = if (json.has("rateLimitSecondaryUsedPercent") && !json.isNull("rateLimitSecondaryUsedPercent")) {
                    json.optDouble("rateLimitSecondaryUsedPercent")
                } else null,
                rateLimitPrimaryResetAt = if (json.has("rateLimitPrimaryResetAt") && !json.isNull("rateLimitPrimaryResetAt")) {
                    json.optLong("rateLimitPrimaryResetAt")
                } else null,
                rateLimitSecondaryResetAt = if (json.has("rateLimitSecondaryResetAt") && !json.isNull("rateLimitSecondaryResetAt")) {
                    json.optLong("rateLimitSecondaryResetAt")
                } else null
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
        "local" in value || "llm" in value || "llama" in value || "ollama" in value -> ScouterSource.LOCAL_LLM
        else -> ScouterSource.SHELLY
    }
}
