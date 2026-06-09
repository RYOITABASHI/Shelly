package expo.modules.terminalemulator.scouter

import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.Locale

object EventNormalizer {
    fun fromHook(sourceHint: ScouterSource?, eventName: String, body: String): ScouterEvent {
        val json = runCatching { JSONObject(body.ifBlank { "{}" }) }.getOrElse { JSONObject() }
        val source = sourceHint ?: inferSource(json.optString("source"))
        val payload = json.optJSONObject("payload") ?: json
        val toolInput = payload.optJSONObject("tool_input")
            ?: payload.optJSONObject("toolInput")
            ?: json.optJSONObject("tool_input")
            ?: json.optJSONObject("toolInput")
        val cwd = firstNonBlank(
            json.optString("cwd"),
            payload.optString("cwd"),
            toolInput?.optString("cwd")
        ) ?: ""
        val eventType = eventTypeFromName(eventName, json.optString("eventType"))
        val status = statusFromEvent(eventType)
        val toolName = firstNonBlank(
            payload.optString("tool_name"),
            payload.optString("toolName"),
            json.optString("tool_name"),
            json.optString("toolName")
        )
        val targetFile = firstNonBlank(
            toolInput?.optString("file_path"),
            toolInput?.optString("path"),
            payload.optString("file_path"),
            payload.optString("path")
        )?.redactForScouter()
        val commandSummary = firstNonBlank(
            toolInput?.optString("command"),
            payload.optString("command")
        )?.redactForScouter()?.take(160)
        val sessionId = firstNonBlank(
            json.optString("session_id"),
            json.optString("sessionId"),
            payload.optString("session_id"),
            payload.optString("sessionId")
        ) ?: "${source.name.lowercase(Locale.US)}:${projectNameFromCwd(cwd)}"
        val projectName = firstNonBlank(
            json.optString("projectName"),
            json.optString("project_name"),
            payload.optString("projectName"),
            payload.optString("project_name")
        ) ?: projectNameFromCwd(cwd)
        val errorMessage = errorMessageFromPayload(payload, eventType)
        val message = safeText(payload.opt("message"))?.redactForScouter()?.take(240)
        val rateLimitText = errorMessage ?: if (eventType == ScouterEventType.POST_TOOL_USE_FAILURE) message else null
        val rateLimit = extractScouterRateLimit(rateLimitText, payload, json)
        return ScouterEvent(
            source = source,
            sourceVersion = firstNonBlank(json.optString("sourceVersion"), json.optString("version")) ?: "unknown",
            sessionId = sessionId,
            projectName = projectName,
            gitBranch = firstNonBlank(json.optString("gitBranch"), json.optString("git_branch")),
            cwd = cwd.redactForScouter(),
            eventType = eventType,
            derivedStatus = status,
            toolName = toolName,
            targetFile = targetFile,
            commandSummary = commandSummary,
            errorMessage = errorMessage,
            notificationMessage = firstNonBlank(payload.optString("notification"), payload.optString("message"))?.redactForScouter(),
            modelName = firstNonBlank(payload.optString("model"), json.optString("model")),
            tokensUsed = extractLong(payload, "tokensUsed", "tokens_used", "total_tokens"),
            inputTokens = extractLong(payload, "inputTokens", "input_tokens"),
            outputTokens = extractLong(payload, "outputTokens", "output_tokens"),
            reasoningOutputTokens = extractLong(payload, "reasoningOutputTokens", "reasoning_output_tokens"),
            cacheCreationInputTokens = extractLong(payload, "cacheCreationInputTokens", "cache_creation_input_tokens"),
            cacheReadInputTokens = extractLong(payload, "cacheReadInputTokens", "cache_read_input_tokens", "cached_input_tokens"),
            totalCostUsd = extractDouble(payload, "totalCostUsd", "total_cost_usd", "cost_usd"),
            contextPercentRemaining = extractNullableDouble(payload, "contextPercentRemaining", "context_percent_remaining"),
            lastMessage = message,
            localBackend = firstNonBlank(payload.optString("localBackend"), payload.optString("local_backend"), payload.optString("backend")),
            localEndpoint = firstNonBlank(payload.optString("localEndpoint"), payload.optString("local_endpoint"), payload.optString("endpoint")),
            tokensPerSecond = extractNullableDouble(payload, "tokensPerSecond", "tokens_per_second", "tps"),
            queueSize = extractNullableInt(payload, "queueSize", "queue_size", "queue"),
            latencyMs = extractNullableLong(payload, "latencyMs", "latency_ms"),
            firstTokenLatencyMs = extractNullableLong(payload, "firstTokenLatencyMs", "first_token_latency_ms", "ttftMs", "ttft_ms"),
            rateLimitStatus = rateLimit.status,
            rateLimitRemainingRequests = rateLimit.remainingRequests,
            rateLimitRemainingTokens = rateLimit.remainingTokens,
            rateLimitResetAt = rateLimit.resetAt,
            retryAfterSeconds = rateLimit.retryAfterSeconds
        )
    }

    fun fromJsonl(source: ScouterSource, file: File, line: String): ScouterEvent? {
        val json = runCatching { JSONObject(line) }.getOrNull() ?: return null
        val eventName = firstNonBlank(
            json.optString("eventType"),
            json.optString("event_type"),
            json.optString("type")
        ) ?: "snapshot"
        val cwd = firstNonBlank(json.optString("cwd"), json.optString("project_path")) ?: file.parentFile?.absolutePath.orEmpty()
        val sessionId = firstNonBlank(json.optString("sessionId"), json.optString("session_id")) ?: file.nameWithoutExtension
        val message = safeText(json.opt("message"))?.redactForScouter()?.take(240)
        val errorMessage = firstNonBlank(json.optString("error"))?.redactForScouter()
        val eventType = eventTypeFromName(eventName, eventName)
        val rateLimitText = errorMessage ?: if (eventType == ScouterEventType.POST_TOOL_USE_FAILURE) message else null
        val rateLimit = extractScouterRateLimit(rateLimitText, json)
        return ScouterEvent(
            source = source,
            sourceVersion = firstNonBlank(json.optString("version"), json.optString("sourceVersion")) ?: "jsonl",
            timestamp = parseTimestamp(firstNonBlank(json.optString("timestamp"), json.optString("time"))),
            sessionId = sessionId,
            projectName = projectNameFromCwd(cwd),
            cwd = cwd.redactForScouter(),
            eventType = eventType,
            derivedStatus = statusFromEvent(eventType),
            toolName = firstNonBlank(json.optString("toolName"), json.optString("tool_name")),
            targetFile = firstNonBlank(json.optString("file_path"), json.optString("path"))?.redactForScouter(),
            commandSummary = firstNonBlank(json.optString("command"), json.optString("prompt"))?.redactForScouter()?.take(160),
            errorMessage = errorMessage,
            modelName = firstNonBlank(json.optString("model"), json.optJSONObject("message")?.optString("model")),
            tokensUsed = extractLong(json, "tokensUsed", "tokens_used", "total_tokens"),
            inputTokens = extractLong(json, "inputTokens", "input_tokens"),
            outputTokens = extractLong(json, "outputTokens", "output_tokens"),
            reasoningOutputTokens = extractLong(json, "reasoningOutputTokens", "reasoning_output_tokens"),
            cacheCreationInputTokens = extractLong(json, "cacheCreationInputTokens", "cache_creation_input_tokens"),
            cacheReadInputTokens = extractLong(json, "cacheReadInputTokens", "cache_read_input_tokens", "cached_input_tokens"),
            totalCostUsd = extractDouble(json, "totalCostUsd", "total_cost_usd", "cost_usd"),
            lastMessage = message,
            localBackend = firstNonBlank(json.optString("localBackend"), json.optString("local_backend"), json.optString("backend")),
            localEndpoint = firstNonBlank(json.optString("localEndpoint"), json.optString("local_endpoint"), json.optString("endpoint")),
            tokensPerSecond = extractNullableDouble(json, "tokensPerSecond", "tokens_per_second", "tps"),
            queueSize = extractNullableInt(json, "queueSize", "queue_size", "queue"),
            latencyMs = extractNullableLong(json, "latencyMs", "latency_ms"),
            firstTokenLatencyMs = extractNullableLong(json, "firstTokenLatencyMs", "first_token_latency_ms", "ttftMs", "ttft_ms"),
            rateLimitStatus = rateLimit.status,
            rateLimitRemainingRequests = rateLimit.remainingRequests,
            rateLimitRemainingTokens = rateLimit.remainingTokens,
            rateLimitResetAt = rateLimit.resetAt,
            retryAfterSeconds = rateLimit.retryAfterSeconds
        )
    }

    private fun eventTypeFromName(name: String?, fallback: String?): ScouterEventType {
        val value = listOfNotNull(name, fallback).joinToString(" ").lowercase(Locale.US)
        return when {
            "session" in value && "start" in value -> ScouterEventType.SESSION_START
            "user" in value && "prompt" in value -> ScouterEventType.USER_PROMPT
            "permission" in value || "approval" in value -> ScouterEventType.PERMISSION_REQUEST
            "pre" in value && "tool" in value -> ScouterEventType.PRE_TOOL_USE
            "post" in value && "tool" in value && "failure" in value -> ScouterEventType.POST_TOOL_USE_FAILURE
            "post" in value && "tool" in value -> ScouterEventType.POST_TOOL_USE
            "notification" in value -> ScouterEventType.NOTIFICATION
            "compact" in value -> ScouterEventType.PRE_COMPACT
            "stop" in value || "complete" in value -> ScouterEventType.STOP
            else -> ScouterEventType.SNAPSHOT
        }
    }

    private fun statusFromEvent(eventType: ScouterEventType): ScouterStatus = when (eventType) {
        ScouterEventType.SESSION_START,
        ScouterEventType.USER_PROMPT -> ScouterStatus.THINKING
        ScouterEventType.PRE_TOOL_USE -> ScouterStatus.TOOL_RUNNING
        ScouterEventType.POST_TOOL_USE -> ScouterStatus.THINKING
        ScouterEventType.POST_TOOL_USE_FAILURE -> ScouterStatus.ERROR
        ScouterEventType.PERMISSION_REQUEST -> ScouterStatus.WAITING_PERMISSION
        ScouterEventType.NOTIFICATION -> ScouterStatus.WAITING_PERMISSION
        ScouterEventType.PRE_COMPACT -> ScouterStatus.THINKING
        ScouterEventType.STOP -> ScouterStatus.COMPLETED
        ScouterEventType.SNAPSHOT -> ScouterStatus.IDLE
    }

    private fun firstNonBlank(vararg values: String?): String? {
        return values.firstOrNull { !it.isNullOrBlank() }
    }

    private fun extractLong(json: JSONObject, vararg keys: String): Long {
        for (key in keys) if (json.has(key)) return json.optLong(key, 0L)
        return 0L
    }

    private fun extractDouble(json: JSONObject, vararg keys: String): Double {
        for (key in keys) if (json.has(key)) return json.optDouble(key, 0.0)
        return 0.0
    }

    private fun extractNullableDouble(json: JSONObject, vararg keys: String): Double? {
        for (key in keys) if (json.has(key) && !json.isNull(key)) return json.optDouble(key)
        return null
    }

    private fun extractNullableLong(json: JSONObject, vararg keys: String): Long? {
        for (key in keys) if (json.has(key) && !json.isNull(key)) return json.optLong(key)
        return null
    }

    private fun extractNullableInt(json: JSONObject, vararg keys: String): Int? {
        for (key in keys) if (json.has(key) && !json.isNull(key)) return json.optInt(key)
        return null
    }

    private fun errorMessageFromPayload(payload: JSONObject, eventType: ScouterEventType): String? {
        val explicit = firstNonBlank(payload.optString("error"), payload.optString("errorMessage"))
        if (explicit != null) return explicit.redactForScouter()
        if (eventType == ScouterEventType.POST_TOOL_USE_FAILURE) {
            return safeText(payload.opt("message"))?.redactForScouter()
        }
        return null
    }

    private fun safeText(value: Any?): String? {
        return when (value) {
            is String -> value.ifBlank { null }
            else -> null
        }
    }

    private fun parseTimestamp(value: String?): Long {
        if (value.isNullOrBlank()) return System.currentTimeMillis()
        value.toLongOrNull()?.let { return it }
        return runCatching { Instant.parse(value).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
    }
}
