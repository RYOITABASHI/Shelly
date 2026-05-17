package expo.modules.terminalemulator.scouter

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.Locale

class JsonlSessionParser(
    private val source: ScouterSource,
    private val file: File
) {
    private var inputTokens: Long = 0
    private var outputTokens: Long = 0
    private var cacheCreationInputTokens: Long = 0
    private var cacheReadInputTokens: Long = 0
    private var totalCostUsd: Double = 0.0
    private var modelName: String? = null
    private var previousCodexTotal: CodexUsage? = null

    fun parse(line: String): ScouterEvent? {
        val json = runCatching { JSONObject(line) }.getOrNull() ?: return null
        return when (source) {
            ScouterSource.CLAUDE_CODE -> parseClaude(json)
            ScouterSource.CODEX -> parseCodex(json)
            ScouterSource.SHELLY -> EventNormalizer.fromJsonl(source, file, line)
        }
    }

    private fun parseClaude(json: JSONObject): ScouterEvent? {
        val message = json.optJSONObject("message")
        val usage = message?.optJSONObject("usage")
        val lineInputTokens = usage.optLongOrZero("input_tokens")
        val lineOutputTokens = usage.optLongOrZero("output_tokens")
        val lineCacheCreationTokens = usage.optLongOrZero("cache_creation_input_tokens")
        val lineCacheReadTokens = usage.optLongOrZero("cache_read_input_tokens")
        val lineTotalTokens = lineInputTokens + lineOutputTokens + lineCacheCreationTokens + lineCacheReadTokens
        if (lineTotalTokens > 0L) {
            inputTokens += lineInputTokens
            outputTokens += lineOutputTokens
            cacheCreationInputTokens += lineCacheCreationTokens
            cacheReadInputTokens += lineCacheReadTokens
            totalCostUsd += json.optDoubleOrZero("costUSD")
        }

        val lineModel = firstNonBlank(
            json.optString("model"),
            message?.optString("model")
        )
        if (lineModel != null) modelName = lineModel

        val contentSummary = summarizeClaudeContent(message?.opt("content"))
        val toolName = contentSummary.toolName
        val status = when {
            toolName != null -> ScouterStatus.THINKING
            json.optString("type").equals("assistant", ignoreCase = true) -> ScouterStatus.IDLE
            json.optString("type").equals("user", ignoreCase = true) -> ScouterStatus.THINKING
            else -> ScouterStatus.IDLE
        }
        val eventType = when {
            toolName != null -> ScouterEventType.POST_TOOL_USE
            json.optString("type").equals("user", ignoreCase = true) -> ScouterEventType.USER_PROMPT
            else -> ScouterEventType.SNAPSHOT
        }

        return ScouterEvent(
            source = ScouterSource.CLAUDE_CODE,
            sourceVersion = firstNonBlank(json.optString("version"), json.optString("sourceVersion")) ?: "jsonl",
            timestamp = parseTimestamp(json.optString("timestamp")),
            sessionId = firstNonBlank(json.optString("sessionId"), json.optString("session_id")) ?: file.nameWithoutExtension,
            projectName = projectNameFromCwd(firstNonBlank(json.optString("cwd"), json.optString("project_path")) ?: file.parentFile?.absolutePath),
            cwd = (firstNonBlank(json.optString("cwd"), json.optString("project_path")) ?: file.parentFile?.absolutePath.orEmpty()).redactForScouter(),
            eventType = eventType,
            derivedStatus = status,
            toolName = toolName,
            commandSummary = contentSummary.text?.redactForScouter()?.take(160),
            modelName = modelName,
            tokensUsed = inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
            inputTokens = inputTokens,
            outputTokens = outputTokens,
            cacheCreationInputTokens = cacheCreationInputTokens,
            cacheReadInputTokens = cacheReadInputTokens,
            totalCostUsd = totalCostUsd,
            lastMessage = contentSummary.text?.redactForScouter()?.take(240)
        )
    }

    private fun parseCodex(json: JSONObject): ScouterEvent? {
        val entryType = json.optString("type")
        val payload = json.optJSONObject("payload")
        if (entryType == "turn_context") {
            modelName = extractCodexModel(payload)
            return null
        }
        if (entryType != "event_msg" || payload?.optString("type") != "token_count") {
            return EventNormalizer.fromJsonl(source, file, json.toString())
        }

        val info = payload.optJSONObject("info")
        val raw = normalizeCodexUsage(info?.optJSONObject("last_token_usage"))
            ?: normalizeCodexUsage(info?.optJSONObject("total_token_usage"))?.let { total ->
                total.minus(previousCodexTotal)
            }
            ?: return null
        normalizeCodexUsage(info?.optJSONObject("total_token_usage"))?.let { previousCodexTotal = it }
        if (raw.totalTokens <= 0L) return null

        modelName = extractCodexModel(payload) ?: extractCodexModel(info) ?: modelName ?: "gpt-5"
        inputTokens += raw.inputTokens
        outputTokens += raw.outputTokens
        cacheReadInputTokens += raw.cachedInputTokens

        return ScouterEvent(
            source = ScouterSource.CODEX,
            sourceVersion = "jsonl",
            timestamp = parseTimestamp(json.optString("timestamp")),
            sessionId = file.nameWithoutExtension,
            projectName = projectNameFromCwd(file.parentFile?.absolutePath),
            cwd = file.parentFile?.absolutePath.orEmpty().redactForScouter(),
            eventType = ScouterEventType.SNAPSHOT,
            derivedStatus = ScouterStatus.IDLE,
            modelName = modelName,
            tokensUsed = inputTokens + outputTokens + cacheReadInputTokens,
            inputTokens = inputTokens,
            outputTokens = outputTokens,
            cacheReadInputTokens = cacheReadInputTokens,
            totalCostUsd = totalCostUsd
        )
    }

    private fun summarizeClaudeContent(content: Any?): ContentSummary {
        return when (content) {
            is String -> ContentSummary(text = content)
            is JSONArray -> {
                var text: String? = null
                var tool: String? = null
                for (i in 0 until content.length()) {
                    val item = content.optJSONObject(i) ?: continue
                    if (item.optString("type") == "text" && text == null) {
                        text = item.optString("text").ifBlank { null }
                    }
                    if (item.optString("type") == "tool_use" && tool == null) {
                        tool = item.optString("name").ifBlank { null }
                    }
                }
                ContentSummary(text = text, toolName = tool)
            }
            else -> ContentSummary()
        }
    }

    private fun extractCodexModel(json: JSONObject?): String? {
        if (json == null) return null
        val info = json.optJSONObject("info")
        val metadata = json.optJSONObject("metadata") ?: info?.optJSONObject("metadata")
        return firstNonBlank(
            json.optString("model"),
            json.optString("model_name"),
            info?.optString("model"),
            info?.optString("model_name"),
            metadata?.optString("model")
        )
    }

    private fun normalizeCodexUsage(json: JSONObject?): CodexUsage? {
        if (json == null) return null
        val input = json.optLongOrZero("input_tokens")
        val cached = json.optLongOrZero("cached_input_tokens").takeIf { it > 0L }
            ?: json.optLongOrZero("cache_read_input_tokens")
        val output = json.optLongOrZero("output_tokens")
        val reasoning = json.optLongOrZero("reasoning_output_tokens")
        val total = json.optLongOrZero("total_tokens").takeIf { it > 0L } ?: (input + output)
        if (input + cached + output + reasoning + total <= 0L) return null
        return CodexUsage(input, cached.coerceAtMost(input), output, reasoning, total)
    }

    private data class ContentSummary(val text: String? = null, val toolName: String? = null)

    private data class CodexUsage(
        val inputTokens: Long,
        val cachedInputTokens: Long,
        val outputTokens: Long,
        val reasoningOutputTokens: Long,
        val totalTokens: Long
    ) {
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
    }

    companion object {
        private fun JSONObject?.optLongOrZero(key: String): Long {
            return this?.takeIf { it.has(key) }?.optLong(key, 0L) ?: 0L
        }

        private fun JSONObject?.optDoubleOrZero(key: String): Double {
            return this?.takeIf { it.has(key) }?.optDouble(key, 0.0) ?: 0.0
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
