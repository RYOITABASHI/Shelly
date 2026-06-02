package expo.modules.terminalemulator.scouter

import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.Instant

class JsonlSessionParser(
    private val source: ScouterSource,
    private val file: File
) {
    private var inputTokens: Long = 0
    private var outputTokens: Long = 0
    private var reasoningOutputTokens: Long = 0
    private var cacheCreationInputTokens: Long = 0
    private var cacheReadInputTokens: Long = 0
    private var totalTokensObserved: Long = 0
    private var totalCostUsd: Double = 0.0
    private var modelName: String? = null
    private var previousCodexTotal: CodexUsage? = null
    private var codexCwd: String? = null

    fun parse(line: String): ScouterEvent? {
        val json = runCatching { JSONObject(line) }.getOrNull() ?: return null
        return when (source) {
            ScouterSource.CODEX -> parseCodex(json, line)
            ScouterSource.LOCAL_LLM -> EventNormalizer.fromJsonl(source, file, line)
            ScouterSource.SHELLY -> EventNormalizer.fromJsonl(source, file, line)
        }
    }

    private fun parseCodex(json: JSONObject, line: String): ScouterEvent? {
        val entryType = json.optString("type")
        val payload = json.optJSONObject("payload")
        if (entryType == "turn_context") {
            modelName = extractCodexModel(payload)
            codexCwd = extractCodexCwd(json, payload) ?: codexCwd
            return null
        }
        if (entryType != "event_msg") {
            return EventNormalizer.fromJsonl(source, file, json.toString())
        }
        if (payload?.optString("type") != "token_count") {
            return payload?.let { codexEventFromPayload(json, it, line) }
                ?: EventNormalizer.fromJsonl(source, file, json.toString())
        }

        val info = payload.optJSONObject("info")
        codexCwd = extractCodexCwd(json, payload, info) ?: codexCwd
        val totalUsage = normalizeCodexUsage(info?.optJSONObject("total_token_usage") ?: info?.optJSONObject("totalTokenUsage"))
        val rateLimit = extractScouterRateLimit(null, payload, info)
        val raw = if (totalUsage != null) {
            val delta = totalUsage.minus(previousCodexTotal)
            previousCodexTotal = totalUsage
            delta
        } else {
            val lastUsage = normalizeCodexUsage(info?.optJSONObject("last_token_usage") ?: info?.optJSONObject("lastTokenUsage")) ?: return null
            previousCodexTotal = (previousCodexTotal ?: CodexUsage.ZERO).plus(lastUsage)
            lastUsage
        }
        if (raw.totalTokens <= 0L) return null

        modelName = extractCodexModel(payload) ?: extractCodexModel(info) ?: modelName ?: "gpt-5"
        inputTokens += raw.inputTokens
        outputTokens += raw.outputTokens
        cacheReadInputTokens += raw.cachedInputTokens
        reasoningOutputTokens += raw.reasoningOutputTokens
        totalTokensObserved += raw.totalTokens
        val cwd = codexCwd ?: file.parentFile?.absolutePath.orEmpty()

        return ScouterEvent(
            eventId = stableJsonlEventId(line),
            source = ScouterSource.CODEX,
            sourceVersion = "jsonl",
            timestamp = parseTimestamp(json.optString("timestamp")),
            sessionId = file.nameWithoutExtension,
            projectName = projectNameFromCwd(cwd),
            cwd = cwd.redactForScouter(),
            eventType = ScouterEventType.SNAPSHOT,
            derivedStatus = ScouterStatus.THINKING,
            modelName = modelName,
            tokensUsed = totalTokensObserved.takeIf { it > 0L } ?: (inputTokens + outputTokens + reasoningOutputTokens),
            inputTokens = inputTokens,
            outputTokens = outputTokens,
            reasoningOutputTokens = reasoningOutputTokens,
            cacheReadInputTokens = cacheReadInputTokens,
            totalCostUsd = totalCostUsd,
            lastMessage = "Codex tokens updated",
            rateLimitStatus = rateLimit.status ?: ScouterRateLimitStatus.OK,
            rateLimitRemainingRequests = rateLimit.remainingRequests,
            rateLimitRemainingTokens = rateLimit.remainingTokens,
            rateLimitResetAt = rateLimit.resetAt,
            retryAfterSeconds = rateLimit.retryAfterSeconds
        )
    }

    private fun codexEventFromPayload(json: JSONObject, payload: JSONObject, line: String): ScouterEvent? {
        val payloadType = payload.optString("type").lowercase()
        if (payloadType.isBlank()) return null
        codexCwd = extractCodexCwd(json, payload) ?: codexCwd
        modelName = extractCodexModel(payload) ?: modelName
        val cwd = codexCwd ?: file.parentFile?.absolutePath.orEmpty()
        val toolName = firstNonBlank(
            payload.optString("toolName"),
            payload.optString("tool_name"),
            payload.optString("name"),
            inferCodexToolName(payloadType)
        )
        val message = firstNonBlank(
            payload.optString("message"),
            payload.optString("text"),
            payload.optString("content"),
            payload.optString("error"),
            payload.optString("stderr"),
            payload.optString("command")
        )
        val rateLimitMessage = firstNonBlank(
            payload.optString("error"),
            payload.optString("stderr"),
            if ("error" in payloadType) message else null
        )
        val rateLimit = extractScouterRateLimit(rateLimitMessage, payload)
        val hasErrorValue = payload.hasNonBlankValue("error")
        val hasExplicitRateLimitError = rateLimit.status == ScouterRateLimitStatus.LIMITED && (
            "error" in payloadType ||
                isScouterRateLimitText(payload.optString("error")) ||
                isScouterRateLimitText(payload.optString("stderr")) ||
                (hasErrorValue && rateLimitMessage != null)
            )
        val status = when {
            hasExplicitRateLimitError -> ScouterStatus.ERROR
            "error" in payloadType || hasErrorValue -> ScouterStatus.ERROR
            "user_message" in payloadType -> ScouterStatus.THINKING
            "exec_command_begin" in payloadType || "tool_call" in payloadType || "apply_patch_begin" in payloadType -> ScouterStatus.TOOL_RUNNING
            "exec_command" in payloadType && "end" !in payloadType -> ScouterStatus.TOOL_RUNNING
            "tool_result" in payloadType || "exec_command_end" in payloadType || "apply_patch_end" in payloadType -> ScouterStatus.THINKING
            "agent_message" in payloadType || "assistant_message" in payloadType || payloadType == "message" -> ScouterStatus.IDLE
            else -> ScouterStatus.THINKING
        }
        val eventType = when {
            "user_message" in payloadType -> ScouterEventType.USER_PROMPT
            status == ScouterStatus.ERROR -> ScouterEventType.POST_TOOL_USE_FAILURE
            status == ScouterStatus.TOOL_RUNNING -> ScouterEventType.PRE_TOOL_USE
            status == ScouterStatus.IDLE -> ScouterEventType.SNAPSHOT
            else -> ScouterEventType.POST_TOOL_USE
        }
        return ScouterEvent(
            eventId = stableJsonlEventId(line),
            source = ScouterSource.CODEX,
            sourceVersion = "jsonl",
            timestamp = parseTimestamp(json.optString("timestamp")),
            sessionId = file.nameWithoutExtension,
            projectName = projectNameFromCwd(cwd),
            cwd = cwd.redactForScouter(),
            eventType = eventType,
            derivedStatus = status,
            toolName = toolName,
            commandSummary = firstNonBlank(payload.optString("command"), message)?.redactForScouter()?.take(160),
            errorMessage = if (status == ScouterStatus.ERROR) message?.redactForScouter() else null,
            modelName = modelName,
            tokensUsed = totalTokensObserved.takeIf { it > 0L } ?: (inputTokens + outputTokens + reasoningOutputTokens),
            inputTokens = inputTokens,
            outputTokens = outputTokens,
            reasoningOutputTokens = reasoningOutputTokens,
            cacheReadInputTokens = cacheReadInputTokens,
            totalCostUsd = totalCostUsd,
            lastMessage = message?.redactForScouter()?.take(240),
            rateLimitStatus = rateLimit.status,
            rateLimitRemainingRequests = rateLimit.remainingRequests,
            rateLimitRemainingTokens = rateLimit.remainingTokens,
            rateLimitResetAt = rateLimit.resetAt,
            retryAfterSeconds = rateLimit.retryAfterSeconds
        )
    }

    private fun stableJsonlEventId(line: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("${file.absolutePath}\n$line".toByteArray(Charsets.UTF_8))
        val lineHash = digest.take(12).joinToString("") { "%02x".format(it.toInt() and 0xff) }
        return "codex-jsonl-${file.nameWithoutExtension}-$lineHash"
    }

    private fun extractCodexModel(json: JSONObject?): String? {
        if (json == null) return null
        val info = json.optJSONObject("info")
        val metadata = json.optJSONObject("metadata") ?: info?.optJSONObject("metadata")
        return firstNonBlank(
            json.optString("model"),
            json.optString("model_name"),
            json.optString("modelName"),
            info?.optString("model"),
            info?.optString("model_name"),
            info?.optString("modelName"),
            metadata?.optString("model")
        )
    }

    private fun extractCodexCwd(vararg jsonObjects: JSONObject?): String? {
        for (json in jsonObjects) {
            if (json == null) continue
            val cwd = firstNonBlank(
                json.optString("cwd"),
                json.optString("current_working_directory"),
                json.optString("currentWorkingDirectory"),
                json.optString("project_path")
            )
            if (cwd != null) return cwd
            val payload = json.optJSONObject("payload")
            val nested = firstNonBlank(
                payload?.optString("cwd"),
                payload?.optString("current_working_directory"),
                payload?.optString("currentWorkingDirectory"),
                payload?.optString("project_path")
            )
            if (nested != null) return nested
        }
        return null
    }

    private fun normalizeCodexUsage(json: JSONObject?): CodexUsage? {
        if (json == null) return null
        val input = json.optLongAny("input_tokens", "inputTokens")
        val cached = json.optLongAny("cached_input_tokens", "cachedInputTokens").takeIf { it > 0L }
            ?: json.optLongAny("cache_read_input_tokens", "cacheReadInputTokens")
        val output = json.optLongAny("output_tokens", "outputTokens")
        val reasoning = json.optLongAny("reasoning_output_tokens", "reasoningOutputTokens")
        val total = json.optLongAny("total_tokens", "totalTokens").takeIf { it > 0L } ?: (input + output + reasoning)
        if (input + cached + output + reasoning + total <= 0L) return null
        return CodexUsage(input, cached.coerceAtMost(input), output, reasoning, total)
    }

    private fun inferCodexToolName(payloadType: String): String? = when {
        "apply_patch" in payloadType || "patch" in payloadType -> "apply_patch"
        "exec" in payloadType || "bash" in payloadType || "command" in payloadType -> "exec"
        "tool" in payloadType -> "tool"
        else -> null
    }

    private data class CodexUsage(
        val inputTokens: Long,
        val cachedInputTokens: Long,
        val outputTokens: Long,
        val reasoningOutputTokens: Long,
        val totalTokens: Long
    ) {
        fun plus(other: CodexUsage): CodexUsage {
            return CodexUsage(
                inputTokens = inputTokens + other.inputTokens,
                cachedInputTokens = cachedInputTokens + other.cachedInputTokens,
                outputTokens = outputTokens + other.outputTokens,
                reasoningOutputTokens = reasoningOutputTokens + other.reasoningOutputTokens,
                totalTokens = totalTokens + other.totalTokens
            )
        }

        fun minus(previous: CodexUsage?): CodexUsage {
            if (previous == null) return this
            return CodexUsage(
                inputTokens = (inputTokens - previous.inputTokens).coerceAtLeast(0),
                cachedInputTokens = (cachedInputTokens - previous.cachedInputTokens).coerceAtLeast(0),
                outputTokens = (outputTokens - previous.outputTokens).coerceAtLeast(0),
                reasoningOutputTokens = (reasoningOutputTokens - previous.reasoningOutputTokens).coerceAtLeast(0),
                totalTokens = (totalTokens - previous.totalTokens).coerceAtLeast(0)
            )
        }

        companion object {
            val ZERO = CodexUsage(0L, 0L, 0L, 0L, 0L)
        }
    }

    companion object {
        private fun JSONObject?.optLongAny(vararg keys: String): Long {
            if (this == null) return 0L
            for (key in keys) {
                if (has(key) && !isNull(key)) return optLong(key, 0L)
            }
            return 0L
        }

        private fun JSONObject.hasNonBlankValue(key: String): Boolean {
            if (!has(key) || isNull(key)) return false
            val value = opt(key) ?: return false
            if (value is Boolean) return value
            return value.toString().isNotBlank()
        }

        private fun firstNonBlank(vararg values: String?): String? {
            return values.firstOrNull { !it.isNullOrBlank() }
        }

        private fun parseTimestamp(value: String?): Long {
            if (value.isNullOrBlank()) return System.currentTimeMillis()
            return runCatching { Instant.parse(value).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
        }
    }
}
