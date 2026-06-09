package expo.modules.terminalemulator.scouter

import org.json.JSONObject
import java.time.Instant
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

enum class ScouterRateLimitStatus {
    UNKNOWN,
    OK,
    HOT,
    LIMITED
}

data class ScouterRateLimitProbe(
    val status: ScouterRateLimitStatus? = null,
    val remainingRequests: Long? = null,
    val remainingTokens: Long? = null,
    val resetAt: Long? = null,
    val retryAfterSeconds: Long? = null
) {
    val hasSignal: Boolean
        get() = status != null ||
            remainingRequests != null ||
            remainingTokens != null ||
            resetAt != null ||
            retryAfterSeconds != null
}

fun parseScouterRateLimitStatus(raw: String?): ScouterRateLimitStatus? {
    val value = raw?.trim()?.lowercase(Locale.US)?.replace('-', '_') ?: return null
    if (value.isBlank()) return null
    return when {
        value in setOf("ok", "clear", "normal", "healthy", "available", "not_limited") -> ScouterRateLimitStatus.OK
        value in setOf("hot", "warn", "warning", "near_limit", "near_limited", "low") -> ScouterRateLimitStatus.HOT
        value in setOf("limited", "rate_limited", "rate_limit", "throttled", "cooldown", "blocked") -> ScouterRateLimitStatus.LIMITED
        value in setOf("unknown", "none", "n/a") -> ScouterRateLimitStatus.UNKNOWN
        "limit" in value && ("exceed" in value || "hit" in value || "reach" in value) -> ScouterRateLimitStatus.LIMITED
        else -> null
    }
}

fun inferScouterRateLimitFromText(message: String?): ScouterRateLimitProbe {
    val retryAfter = retryAfterSecondsFromText(message, loose = true)
    val limited = isRateLimitText(message)
    val resetAt = retryAfter?.let { System.currentTimeMillis() + it * 1000L }
    return ScouterRateLimitProbe(
        status = if (limited || retryAfter != null) ScouterRateLimitStatus.LIMITED else null,
        resetAt = resetAt,
        retryAfterSeconds = retryAfter
    )
}

fun extractScouterRateLimit(message: String?, vararg roots: JSONObject?): ScouterRateLimitProbe {
    val objects = roots.flatMap { rateLimitObjects(it) }
    val namedRateLimitObjects = roots.flatMap { namedRateLimitObjects(it) }
    val explicitStatus = parseScouterRateLimitStatus(
        firstNonBlankString(
            objects,
            "rateLimitStatus",
            "rate_limit_status",
            "rate_status",
            "x-ratelimit-status"
        )
    ) ?: parseScouterRateLimitStatus(firstNonBlankString(namedRateLimitObjects, "status"))
    val remainingRequests = firstLong(
        objects,
        "rateLimitRemainingRequests",
        "rate_limit_remaining_requests",
        "remainingRequests",
        "remaining_requests",
        "requestsRemaining",
        "requests_remaining",
        "x-ratelimit-remaining-requests",
        "x_rate_limit_remaining_requests"
    )
    val remainingTokens = firstLong(
        objects,
        "rateLimitRemainingTokens",
        "rate_limit_remaining_tokens",
        "remainingTokens",
        "remaining_tokens",
        "tokensRemaining",
        "tokens_remaining",
        "x-ratelimit-remaining-tokens",
        "x_rate_limit_remaining_tokens"
    )
    val retryAfter = firstDurationSeconds(
        objects,
        "retryAfterSeconds",
        "retry_after_seconds",
        "retryAfter",
        "retry_after",
        "retry-after",
        "x-ratelimit-reset-after"
    )?.takeIf { it >= 0L } ?: retryAfterSecondsFromText(message, loose = false)
    val rawResetAtMillis = firstLong(
        objects,
        "rateLimitResetMs",
        "rate_limit_reset_ms"
    )
    val rawResetAt = firstLong(
        objects,
        "rateLimitResetAt",
        "rate_limit_reset_at",
        "resetAt",
        "reset_at",
        "reset",
        "x-ratelimit-reset",
        "x_rate_limit_reset"
    )
    val resetAt = rawResetAtMillis
        ?.takeIf { it > 0L }
        ?.let { if (it > 10_000_000_000L) it else System.currentTimeMillis() + it }
        ?: normalizeResetAt(rawResetAt)
        ?: retryAfter?.let { System.currentTimeMillis() + it * 1000L }
    val textLimited = isRateLimitText(message)
    val status = explicitStatus ?: when {
        textLimited || retryAfter != null -> ScouterRateLimitStatus.LIMITED
        remainingRequests == 0L || remainingTokens == 0L -> ScouterRateLimitStatus.LIMITED
        remainingRequests != null && remainingRequests <= 1L -> ScouterRateLimitStatus.HOT
        remainingTokens != null && remainingTokens <= 1_000L -> ScouterRateLimitStatus.HOT
        remainingRequests != null || remainingTokens != null || resetAt != null -> ScouterRateLimitStatus.OK
        else -> null
    }
    return ScouterRateLimitProbe(status, remainingRequests, remainingTokens, resetAt, retryAfter)
}

private fun rateLimitObjects(root: JSONObject?): List<JSONObject> {
    if (root == null) return emptyList()
    val out = mutableListOf(root)
    listOf(
        "headers",
        "metadata",
        "rateLimit",
        "rate_limit",
        "limits",
        "usage",
        "response"
    ).mapNotNull { root.optJSONObject(it) }.forEach { nested ->
        out += nested
        nested.optJSONObject("headers")?.let { out += it }
        nested.optJSONObject("rateLimit")?.let { out += it }
        nested.optJSONObject("rate_limit")?.let { out += it }
    }
    return out
}

private fun namedRateLimitObjects(root: JSONObject?): List<JSONObject> {
    if (root == null) return emptyList()
    return listOfNotNull(
        root.optJSONObject("rateLimit"),
        root.optJSONObject("rate_limit"),
        root.optJSONObject("limits")?.optJSONObject("rateLimit"),
        root.optJSONObject("limits")?.optJSONObject("rate_limit"),
        root.optJSONObject("response")?.optJSONObject("rateLimit"),
        root.optJSONObject("response")?.optJSONObject("rate_limit")
    )
}

private fun firstNonBlankString(objects: List<JSONObject>, vararg keys: String): String? {
    for (json in objects) {
        for (key in keys) {
            if (!json.has(key) || json.isNull(key)) continue
            val value = json.opt(key)?.toString()?.trim()
            if (!value.isNullOrBlank()) return value
        }
    }
    return null
}

private fun firstLong(objects: List<JSONObject>, vararg keys: String): Long? {
    for (json in objects) {
        for (key in keys) {
            if (!json.has(key) || json.isNull(key)) continue
            json.opt(key)?.toLongOrNullFlexible()?.let { return it }
        }
    }
    return null
}

private fun firstDurationSeconds(objects: List<JSONObject>, vararg keys: String): Long? {
    for (json in objects) {
        for (key in keys) {
            if (!json.has(key) || json.isNull(key)) continue
            parseRetryAfterValue(json.opt(key))?.let { return it }
        }
    }
    return null
}

private fun Any.toLongOrNullFlexible(): Long? {
    return when (this) {
        is Number -> toLong()
        is String -> trim().toLongOrNull()
            ?: Regex("-?\\d+").find(this)?.value?.toLongOrNull()
        else -> toString().trim().toLongOrNull()
    }
}

private fun parseRetryAfterValue(value: Any?): Long? {
    return when (value) {
        null -> null
        is Number -> value.toLong()
        is String -> parseHttpRetryAfterDate(value)
            ?: parseDurationSeconds(
                Regex("(?i)^\\s*(\\d+)\\s*(ms|millisecond|milliseconds|second|seconds|sec|s|minute|minutes|min|m)?\\s*$").find(value)
            )
        else -> value.toString().trim().toLongOrNull()
    }
}

private fun normalizeResetAt(raw: Long?): Long? {
    if (raw == null || raw <= 0L) return null
    return when {
        raw > 10_000_000_000L -> raw
        raw > 1_000_000_000L -> raw * 1000L
        else -> System.currentTimeMillis() + raw * 1000L
    }
}

private fun retryAfterSecondsFromText(message: String?, loose: Boolean): Long? {
    val text = message ?: return null
    parseHttpRetryAfterDate(text)?.let { return it }
    parseDurationSeconds(Regex("(?i)retry[-_ ]?after\\D{0,12}(\\d+)\\s*(ms|millisecond|milliseconds|second|seconds|sec|s|minute|minutes|min|m)?").find(text))
        ?.let { return it }
    parseDurationSeconds(Regex("(?i)try again in\\D{0,12}(\\d+)\\s*(ms|millisecond|milliseconds|second|seconds|sec|s|minute|minutes|min|m)?").find(text))
        ?.let { return it }
    if (!loose) return null
    return Regex("(?i)\\b(\\d+)\\s*(second|seconds|sec|s|minute|minutes|min|m)\\b").find(text)
        ?.let { parseDurationSeconds(it) }
}

fun isScouterRateLimitText(message: String?): Boolean {
    val text = message?.lowercase(Locale.US) ?: return false
    return "429" in text ||
        "rate limit" in text ||
        "rate_limit" in text ||
        "rate-limit" in text ||
        "too many requests" in text ||
        "usage limit" in text ||
        "quota exceeded" in text ||
        "limit reached" in text ||
        "throttled" in text
}

private fun isRateLimitText(message: String?): Boolean = isScouterRateLimitText(message)

private fun parseDurationSeconds(match: MatchResult?): Long? {
    if (match == null) return null
    val value = match.groupValues.getOrNull(1)?.toLongOrNull() ?: return null
    val unit = match.groupValues.getOrNull(2)?.lowercase(Locale.US).orEmpty()
    return when {
        unit.startsWith("ms") || unit.startsWith("milli") -> (value / 1000L).coerceAtLeast(1L)
        unit.startsWith("m") -> value * 60L
        else -> value
    }
}

private fun parseHttpRetryAfterDate(text: String): Long? {
    val normalized = text.trim()
        .replace(Regex("(?i)^retry[-_ ]?after\\s*:\\s*"), "")
        .trim()
    val retryAt = runCatching { ZonedDateTime.parse(normalized, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant() }
        .getOrNull()
        ?: runCatching { Instant.parse(normalized) }.getOrNull()
        ?: return null
    return ((retryAt.toEpochMilli() - System.currentTimeMillis()) / 1000L).coerceAtLeast(0L)
}
