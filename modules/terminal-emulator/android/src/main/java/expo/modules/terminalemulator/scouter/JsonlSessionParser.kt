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
    private var codexSessionId: String = extractCodexSessionIdFromFileName(file.nameWithoutExtension)
        ?: file.nameWithoutExtension

    fun parse(line: String): ScouterEvent? {
        val json = runCatching { JSONObject(line) }.getOrNull() ?: return null
        return when (source) {
            ScouterSource.CODEX -> parseCodex(json, line)
            ScouterSource.LOCAL_LLM -> EventNormalizer.fromJsonl(source, file, line)
            ScouterSource.SHELLY -> EventNormalizer.fromJsonl(source, file, line)
        }
    }

    fun primeCodexMetadata(line: String) {
        if (source != ScouterSource.CODEX) return
        val json = runCatching { JSONObject(line) }.getOrNull() ?: return
        val payload = json.optJSONObject("payload")
        when (json.optString("type")) {
            "session_meta", "turn_context" -> updateCodexMetadata(json, payload)
            "event_msg" -> {
                if (payload?.optString("type") != "token_count") return
                updateCodexMetadata(json, payload, payload.optJSONObject("info"))
            }
        }
    }

    private fun parseCodex(json: JSONObject, line: String): ScouterEvent? {
        val entryType = json.optString("type")
        val payload = json.optJSONObject("payload")
        if (entryType == "turn_context") {
            updateCodexMetadata(json, payload)
            return null
        }
        if (entryType == "session_meta") {
            updateCodexMetadata(json, payload)
            return null
        }
        if (entryType == "response_item") {
            return parseCodexResponseItem(json, payload, line)
        }
        if (entryType != "event_msg") {
            return EventNormalizer.fromJsonl(source, file, json.toString())
        }
        if (payload?.optString("type") != "token_count") {
            return payload?.let { codexEventFromPayload(json, it, line) }
                ?: EventNormalizer.fromJsonl(source, file, json.toString())
        }

        val info = payload.optJSONObject("info")
        updateCodexMetadata(json, payload, info)
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
            sessionId = codexSessionId,
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
            payload.optString("last_agent_message"),
            payload.optString("message"),
            payload.optString("text"),
            payload.optString("content"),
            payload.optString("error"),
            payload.optString("stderr"),
            payload.optString("command")
        )
        val role = payload.optString("role").lowercase()
        if (payloadType == "message" && (role == "developer" || role == "system")) return null
        if (isCodexUserMessagePayload(payloadType, role) && isCodexSyntheticUserMessage(message)) return null
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
        val isApproval = isCodexApprovalPayload(payloadType, toolName)
        val approvalSummary = if (isApproval) approvalSummaryFromPayload(payload, message, toolName) else null
        val status = when {
            hasExplicitRateLimitError -> ScouterStatus.ERROR
            "error" in payloadType || hasErrorValue -> ScouterStatus.ERROR
            isApproval -> ScouterStatus.WAITING_PERMISSION
            isCodexUserMessagePayload(payloadType, role) -> ScouterStatus.THINKING
            "exec_command_begin" in payloadType || "tool_call" in payloadType || "apply_patch_begin" in payloadType || "patch_apply_begin" in payloadType -> ScouterStatus.TOOL_RUNNING
            "exec_command" in payloadType && "end" !in payloadType -> ScouterStatus.TOOL_RUNNING
            "tool_result" in payloadType || "exec_command_end" in payloadType || "apply_patch_end" in payloadType || "patch_apply_end" in payloadType -> ScouterStatus.THINKING
            "task_complete" in payloadType || "turn_complete" in payloadType -> ScouterStatus.COMPLETED
            "agent_message" in payloadType || "assistant_message" in payloadType || payloadType == "message" -> ScouterStatus.IDLE
            else -> ScouterStatus.THINKING
        }
        val eventType = when {
            isCodexUserMessagePayload(payloadType, role) -> ScouterEventType.USER_PROMPT
            status == ScouterStatus.ERROR -> ScouterEventType.POST_TOOL_USE_FAILURE
            status == ScouterStatus.WAITING_PERMISSION -> ScouterEventType.PERMISSION_REQUEST
            status == ScouterStatus.TOOL_RUNNING -> ScouterEventType.PRE_TOOL_USE
            status == ScouterStatus.COMPLETED -> ScouterEventType.STOP
            status == ScouterStatus.IDLE -> ScouterEventType.SNAPSHOT
            else -> ScouterEventType.POST_TOOL_USE
        }
        val chatMessage = if (
            eventType == ScouterEventType.USER_PROMPT ||
            eventType == ScouterEventType.SNAPSHOT ||
            eventType == ScouterEventType.STOP ||
            eventType == ScouterEventType.POST_TOOL_USE_FAILURE
        ) {
            message?.redactForScouter()?.take(240)
        } else {
            null
        }
        return ScouterEvent(
            eventId = stableJsonlEventId(line),
            source = ScouterSource.CODEX,
            sourceVersion = "jsonl",
            timestamp = parseTimestamp(json.optString("timestamp")),
            sessionId = codexSessionId,
            projectName = projectNameFromCwd(cwd),
            cwd = cwd.redactForScouter(),
            eventType = eventType,
            derivedStatus = status,
            toolName = toolName,
            commandSummary = firstNonBlank(approvalSummary, payload.optString("command"), message)?.redactForScouter()?.take(160),
            errorMessage = if (status == ScouterStatus.ERROR) message?.redactForScouter() else null,
            modelName = modelName,
            tokensUsed = totalTokensObserved.takeIf { it > 0L } ?: (inputTokens + outputTokens + reasoningOutputTokens),
            inputTokens = inputTokens,
            outputTokens = outputTokens,
            reasoningOutputTokens = reasoningOutputTokens,
            cacheReadInputTokens = cacheReadInputTokens,
            totalCostUsd = totalCostUsd,
            lastMessage = approvalSummary?.redactForScouter()?.take(240) ?: chatMessage,
            rateLimitStatus = rateLimit.status,
            rateLimitRemainingRequests = rateLimit.remainingRequests,
            rateLimitRemainingTokens = rateLimit.remainingTokens,
            rateLimitResetAt = rateLimit.resetAt,
            retryAfterSeconds = rateLimit.retryAfterSeconds
        )
    }

    private fun parseCodexResponseItem(json: JSONObject, payload: JSONObject?, line: String): ScouterEvent? {
        if (payload == null) return null
        val payloadType = payload.optString("type").lowercase()
        if (payloadType.isBlank()) return null

        codexCwd = extractCodexCwd(json, payload) ?: codexCwd
        modelName = extractCodexModel(json) ?: extractCodexModel(payload) ?: modelName
        val cwd = codexCwd ?: file.parentFile?.absolutePath.orEmpty()
        val role = payload.optString("role").lowercase()
        val message = extractCodexContentText(payload)

        if (payloadType == "message") {
            if (role == "developer" || role == "system") return null
            if (role == "user" && isCodexSyntheticUserMessage(message)) return null
            val status = when (role) {
                "user" -> ScouterStatus.THINKING
                "assistant" -> ScouterStatus.IDLE
                else -> if (message != null) ScouterStatus.IDLE else return null
            }
            val eventType = if (role == "user") ScouterEventType.USER_PROMPT else ScouterEventType.SNAPSHOT
            return codexJsonlEvent(json, line, cwd, eventType, status, lastMessage = message)
        }

        val toolName = firstNonBlank(
            payload.optString("name"),
            payload.optString("tool_name"),
            payload.optString("toolName"),
            inferCodexToolName(payloadType)
        )
        val commandSummary = firstNonBlank(
            payload.optString("command"),
            payload.optString("arguments"),
            payload.optString("input"),
            payload.optString("status"),
            message,
            toolName
        )
        val isApproval = isCodexApprovalPayload(payloadType, toolName)
        val approvalSummary = if (isApproval) approvalSummaryFromPayload(payload, message, toolName) else null
        val status = when {
            isApproval -> ScouterStatus.WAITING_PERMISSION
            "function_call_output" in payloadType || "tool_call_output" in payloadType || "tool_result" in payloadType -> ScouterStatus.THINKING
            "web_search_call" in payloadType && payload.optString("status").lowercase() == "completed" -> ScouterStatus.THINKING
            "function_call" in payloadType || "tool_call" in payloadType || "web_search_call" in payloadType -> ScouterStatus.TOOL_RUNNING
            else -> return null
        }
        val eventType = when (status) {
            ScouterStatus.WAITING_PERMISSION -> ScouterEventType.PERMISSION_REQUEST
            ScouterStatus.TOOL_RUNNING -> ScouterEventType.PRE_TOOL_USE
            else -> ScouterEventType.POST_TOOL_USE
        }
        return codexJsonlEvent(
            json = json,
            line = line,
            cwd = cwd,
            eventType = eventType,
            status = status,
            toolName = toolName,
            commandSummary = firstNonBlank(approvalSummary, commandSummary)?.redactForScouter()?.take(160),
            lastMessage = approvalSummary
        )
    }

    private fun codexJsonlEvent(
        json: JSONObject,
        line: String,
        cwd: String,
        eventType: ScouterEventType,
        status: ScouterStatus,
        toolName: String? = null,
        commandSummary: String? = null,
        lastMessage: String? = null
    ): ScouterEvent {
        return ScouterEvent(
            eventId = stableJsonlEventId(line),
            source = ScouterSource.CODEX,
            sourceVersion = "jsonl",
            timestamp = parseTimestamp(json.optString("timestamp")),
            sessionId = codexSessionId,
            projectName = projectNameFromCwd(cwd),
            cwd = cwd.redactForScouter(),
            eventType = eventType,
            derivedStatus = status,
            toolName = toolName,
            commandSummary = commandSummary,
            modelName = modelName,
            tokensUsed = totalTokensObserved.takeIf { it > 0L } ?: (inputTokens + outputTokens + reasoningOutputTokens),
            inputTokens = inputTokens,
            outputTokens = outputTokens,
            reasoningOutputTokens = reasoningOutputTokens,
            cacheReadInputTokens = cacheReadInputTokens,
            totalCostUsd = totalCostUsd,
            lastMessage = lastMessage?.redactForScouter()?.take(240)
        )
    }

    private fun extractCodexContentText(payload: JSONObject): String? {
        val content = payload.opt("content") ?: return firstNonBlank(
            payload.optString("text"),
            payload.optString("message"),
            payload.optString("output")
        )
        if (content is String) return content.ifBlank { null }
        val arr = payload.optJSONArray("content") ?: return null
        val parts = mutableListOf<String>()
        for (i in 0 until arr.length()) {
            val item = arr.optJSONObject(i) ?: continue
            val text = firstNonBlank(
                item.optString("text"),
                item.optString("message"),
                item.optString("content"),
                item.optString("output")
            )
            if (text != null) parts.add(text)
        }
        return parts.joinToString("\n").ifBlank { null }
    }

    private fun updateCodexMetadata(vararg jsonObjects: JSONObject?) {
        codexSessionId = jsonObjects.asSequence().mapNotNull { extractCodexSessionId(it) }.firstOrNull()
            ?: codexSessionId
        modelName = jsonObjects.asSequence().mapNotNull { extractCodexModel(it) }.firstOrNull() ?: modelName
        codexCwd = extractCodexCwd(*jsonObjects) ?: codexCwd
    }

    private fun isCodexSyntheticUserMessage(message: String?): Boolean {
        val value = message?.trim() ?: return false
        if (value.startsWith("<environment_context>")) {
            return value.contains("<cwd>") || value.contains("<current_date>") || value.contains("<timezone>")
        }
        return value.startsWith("# AGENTS.md instructions") && value.contains("<INSTRUCTIONS>")
    }

    private fun isCodexUserMessagePayload(payloadType: String, role: String): Boolean {
        return "user_message" in payloadType || (payloadType == "message" && role == "user")
    }

    private fun isCodexApprovalPayload(vararg values: String?): Boolean {
        return values.any { value ->
            val normalized = value?.lowercase() ?: return@any false
            "approval" in normalized || "permission" in normalized
        }
    }

    private fun approvalSummaryFromPayload(payload: JSONObject, message: String?, toolName: String?): String? {
        val approval = payload.optJSONObject("approval")
            ?: payload.optJSONObject("approval_request")
            ?: payload.optJSONObject("approvalRequest")
            ?: payload.optJSONObject("permission")
            ?: payload.optJSONObject("request")
        val arguments = payload.optJsonObjectValue("arguments")
            ?: approval.optJsonObjectValue("arguments")
        val input = payload.optJsonObjectValue("input")
            ?: approval.optJsonObjectValue("input")
        return firstNonBlank(
            payload.optString("command"),
            approval?.optString("command"),
            arguments?.optString("command"),
            input?.optString("command"),
            payload.optString("description"),
            approval?.optString("description"),
            arguments?.optString("description"),
            input?.optString("description"),
            payload.optString("reason"),
            approval?.optString("reason"),
            arguments?.optString("reason"),
            input?.optString("reason"),
            payload.optString("prompt"),
            approval?.optString("prompt"),
            arguments?.optString("prompt"),
            input?.optString("prompt"),
            payload.optPlainStringValue("arguments"),
            approval.optPlainStringValue("arguments"),
            payload.optPlainStringValue("input"),
            approval.optPlainStringValue("input"),
            message,
            toolName
        )
    }

    private fun JSONObject?.optJsonObjectValue(key: String): JSONObject? {
        if (this == null || !has(key) || isNull(key)) return null
        val value = opt(key) ?: return null
        if (value is JSONObject) return value
        val text = value.toString().trim()
        if (!text.startsWith("{")) return null
        return runCatching { JSONObject(text) }.getOrNull()
    }

    private fun JSONObject?.optPlainStringValue(key: String): String? {
        if (this == null || !has(key) || isNull(key)) return null
        val value = opt(key) ?: return null
        if (value is JSONObject) return null
        val text = value.toString().trim()
        if (text.startsWith("{")) return null
        return text.ifBlank { null }
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

    private fun extractCodexSessionId(json: JSONObject?): String? {
        if (json == null) return null
        val payload = json.optJSONObject("payload")
        return when (json.optString("type")) {
            "session_meta" -> firstNonBlank(
                payload?.optString("id"),
                payload?.optString("session_id"),
                payload?.optString("sessionId"),
                json.optString("session_id"),
                json.optString("sessionId")
            )
            "turn_context" -> firstNonBlank(
                payload?.optString("session_id"),
                payload?.optString("sessionId"),
                payload?.optString("conversation_id"),
                payload?.optString("conversationId"),
                json.optString("session_id"),
                json.optString("sessionId"),
                json.optString("conversation_id"),
                json.optString("conversationId")
            )
            else -> firstNonBlank(
                json.optString("session_id"),
                json.optString("sessionId"),
                json.optString("conversation_id"),
                json.optString("conversationId"),
                payload?.optString("session_id"),
                payload?.optString("sessionId"),
                payload?.optString("conversation_id"),
                payload?.optString("conversationId")
            )
        }?.let { normalizeCodexSessionId(it) }
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
        "web_search" in payloadType -> "web_search"
        "apply_patch" in payloadType || "patch" in payloadType -> "apply_patch"
        "exec" in payloadType || "bash" in payloadType || "command" in payloadType -> "exec"
        "tool" in payloadType -> "tool"
        "function" in payloadType -> "function"
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

        private fun normalizeCodexSessionId(value: String): String {
            val trimmed = value.trim()
            return extractCodexSessionIdFromFileName(trimmed) ?: trimmed
        }

        private fun extractCodexSessionIdFromFileName(value: String): String? {
            return Regex("([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$")
                .find(value)
                ?.groupValues
                ?.getOrNull(1)
        }

        private fun parseTimestamp(value: String?): Long {
            if (value.isNullOrBlank()) return System.currentTimeMillis()
            return runCatching { Instant.parse(value).toEpochMilli() }.getOrDefault(System.currentTimeMillis())
        }
    }
}
