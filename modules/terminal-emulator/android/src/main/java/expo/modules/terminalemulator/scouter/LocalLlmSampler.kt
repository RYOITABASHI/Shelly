package expo.modules.terminalemulator.scouter

import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import kotlin.math.max

class LocalLlmSampler(private val homeDir: File) {
    fun sample(): ScouterEvent {
        val llama = probeLlama()
        if (llama != null) return llama
        val ollama = probeOllama()
        if (ollama != null) return ollama
        return event(
            backend = "offline",
            endpoint = "127.0.0.1:8080/11434",
            status = ScouterStatus.IDLE,
            modelName = "local-offline",
            lastMessage = "No local LLM endpoint",
            latencyMs = null
        )
    }

    private fun probeLlama(): ScouterEvent? {
        val health = getText("http://127.0.0.1:8080/health") ?: return null
        if (health.code !in 200..299) return null
        val models = getText("http://127.0.0.1:8080/v1/models", maxBytes = JSON_MAX_BYTES)
        val metrics = getText("http://127.0.0.1:8080/metrics", timeoutMs = 500, maxBytes = METRICS_MAX_BYTES)
        val parsedMetrics = parseMetrics(metrics?.body.orEmpty())
        val queue = parsedMetrics.queueSize
        return event(
            backend = "llama.cpp",
            endpoint = "127.0.0.1:8080",
            status = if ((queue ?: 0) > 0) ScouterStatus.TOOL_RUNNING else ScouterStatus.IDLE,
            modelName = parseOpenAiModel(models?.body) ?: "llama-server",
            lastMessage = if ((queue ?: 0) > 0) "Local generation active" else "Local model ready",
            tokensPerSecond = parsedMetrics.tokensPerSecond,
            queueSize = queue,
            latencyMs = health.elapsedMs
        )
    }

    private fun probeOllama(): ScouterEvent? {
        val tags = getText("http://127.0.0.1:11434/api/tags", maxBytes = JSON_MAX_BYTES) ?: return null
        if (tags.code !in 200..299) return null
        val model = parseOllamaModel(tags.body)
        return event(
            backend = "ollama",
            endpoint = "127.0.0.1:11434",
            status = ScouterStatus.IDLE,
            modelName = model ?: "ollama",
            lastMessage = model?.let { "Ollama model available" } ?: "Ollama ready",
            latencyMs = tags.elapsedMs
        )
    }

    private fun event(
        backend: String,
        endpoint: String,
        status: ScouterStatus,
        modelName: String,
        lastMessage: String,
        tokensPerSecond: Double? = null,
        queueSize: Int? = null,
        latencyMs: Long? = null
    ): ScouterEvent {
        return ScouterEvent(
            source = ScouterSource.LOCAL_LLM,
            sourceVersion = "probe",
            sessionId = "local-llm",
            projectName = "Local LLM",
            cwd = homeDir.absolutePath.redactForScouter(),
            eventType = ScouterEventType.SNAPSHOT,
            derivedStatus = status,
            toolName = if (status == ScouterStatus.TOOL_RUNNING) backend else null,
            modelName = modelName,
            lastMessage = lastMessage,
            localBackend = backend,
            localEndpoint = endpoint,
            tokensPerSecond = tokensPerSecond,
            queueSize = queueSize,
            latencyMs = latencyMs
        )
    }

    private fun getText(
        url: String,
        timeoutMs: Int = 700,
        maxBytes: Int = JSON_MAX_BYTES,
        maxElapsedMs: Long = 2_000L
    ): HttpResult? {
        val started = System.currentTimeMillis()
        return runCatching {
            val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                useCaches = false
            }
            try {
                val code = connection.responseCode
                val stream = if (code in 200..399) connection.inputStream else connection.errorStream
                val body = stream?.use { readLimited(it, maxBytes, started, maxElapsedMs) }.orEmpty()
                HttpResult(code, body, System.currentTimeMillis() - started)
            } finally {
                connection.disconnect()
            }
        }.getOrNull()
    }

    private fun readLimited(
        stream: InputStream,
        maxBytes: Int,
        started: Long,
        maxElapsedMs: Long
    ): String {
        val buffer = ByteArray(4096)
        val output = StringBuilder()
        var total = 0
        while (true) {
            if (System.currentTimeMillis() - started > maxElapsedMs) return ""
            val read = stream.read(buffer)
            if (read <= 0) break
            total += read
            if (total > maxBytes) return ""
            output.append(String(buffer, 0, read, Charsets.UTF_8))
        }
        return output.toString()
    }

    private fun parseOpenAiModel(body: String?): String? {
        if (body.isNullOrBlank()) return null
        return runCatching {
            val data = JSONObject(body).optJSONArray("data")
            data?.optJSONObject(0)?.optString("id")?.ifBlank { null }
        }.getOrNull()
    }

    private fun parseOllamaModel(body: String): String? {
        return runCatching {
            val models = JSONObject(body).optJSONArray("models")
            models?.optJSONObject(0)?.optString("name")?.ifBlank { null }
        }.getOrNull()
    }

    private fun parseMetrics(body: String): LocalMetrics {
        var queueSize: Int? = null
        var predictedTokens: Double? = null
        var predictedSeconds: Double? = null
        for (line in body.lineSequence()) {
            val trimmed = line.trim()
            if (trimmed.isBlank() || trimmed.startsWith("#")) continue
            val match = METRIC_LINE.matchEntire(trimmed) ?: continue
            val name = match.groupValues[1].lowercase(Locale.US)
            val value = match.groupValues[2].toDoubleOrNull() ?: continue
            when {
                "requests_processing" in name || "requests_deferred" in name || "queue" in name -> {
                    queueSize = max(queueSize ?: 0, value.toInt())
                }
                "tokens_predicted_total" in name || "predicted_tokens_total" in name -> {
                    predictedTokens = value
                }
                "predicted_tokens_seconds" in name || "tokens_predicted_seconds" in name -> {
                    predictedSeconds = value
                }
            }
        }
        val tps = if ((predictedTokens ?: 0.0) > 0.0 && (predictedSeconds ?: 0.0) > 0.0) {
            predictedTokens!! / predictedSeconds!!
        } else null
        return LocalMetrics(queueSize, tps)
    }

    private data class HttpResult(val code: Int, val body: String, val elapsedMs: Long)
    private data class LocalMetrics(val queueSize: Int?, val tokensPerSecond: Double?)

    companion object {
        private const val JSON_MAX_BYTES = 64 * 1024
        private const val METRICS_MAX_BYTES = 32 * 1024
        private val METRIC_LINE = Regex("^([A-Za-z_:][A-Za-z0-9_:]*)(?:\\{[^}]*})?\\s+([-+0-9.eE]+)")
    }
}
