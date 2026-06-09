package expo.modules.terminalemulator.scouter

import java.util.Locale

/**
 * Static per-token pricing for the models Scouter surfaces, so the widget can
 * compute a live `$X.XX` cost from token counts.
 *
 * Codex never emits a usable `totalCostUsd` — the rollout JSONL only carries
 * raw token counts — so `SessionSnapshot.totalCostUsd` is structurally always
 * 0 for Codex sessions. The widget instead calls [costUsd] with the model name
 * plus cumulative input/output token counts and renders the result.
 *
 * Pricing data is a snapshot of LiteLLM's
 * `model_prices_and_context_window.json` (BerriAI/litellm, fetched 2026-06).
 * Values are USD **per token** (not per 1K/1M). Refresh from upstream when the
 * model lineup changes; this is a deliberate point-in-time copy, not a live feed.
 */
object ScouterModelPricing {

    /**
     * @param inputPerToken USD per input token.
     * @param outputPerToken USD per output token.
     * @param contextWindow max context window in tokens (for the Stage-2 ctx gauge).
     */
    data class ModelPrice(
        val inputPerToken: Double,
        val outputPerToken: Double,
        val contextWindow: Long
    )

    // Keys are the canonical lowercase model identifiers. Lookup normalizes the
    // incoming name (provider prefix + date suffix stripped) and then takes the
    // longest matching key prefix, so e.g. "gpt-5.1-codex-2026-01-15" resolves
    // to the "gpt-5.1-codex" entry rather than the shorter "gpt-5.1".
    private val PRICES: Map<String, ModelPrice> = linkedMapOf(
        "gpt-5" to ModelPrice(1.25e-6, 1e-5, 272_000),
        "gpt-5-codex" to ModelPrice(1.25e-6, 1e-5, 272_000),
        "gpt-5-mini" to ModelPrice(2.5e-7, 2e-6, 272_000),
        "gpt-5-nano" to ModelPrice(5e-8, 4e-7, 272_000),
        "gpt-5-pro" to ModelPrice(1.5e-5, 1.2e-4, 128_000),
        "gpt-5.1" to ModelPrice(1.25e-6, 1e-5, 272_000),
        "gpt-5.1-codex" to ModelPrice(1.25e-6, 1e-5, 272_000),
        "gpt-5.1-codex-mini" to ModelPrice(2.5e-7, 2e-6, 272_000),
        "gpt-5.2" to ModelPrice(1.75e-6, 1.4e-5, 272_000),
        "gpt-5.2-codex" to ModelPrice(1.75e-6, 1.4e-5, 272_000),
        "gpt-5.3-codex" to ModelPrice(1.75e-6, 1.4e-5, 272_000),
        "gpt-5.4" to ModelPrice(2.5e-6, 1.5e-5, 1_050_000),
        "gpt-5.4-mini" to ModelPrice(7.5e-7, 4.5e-6, 272_000),
        "gpt-5.4-nano" to ModelPrice(2e-7, 1.25e-6, 272_000),
        "gpt-5.4-pro" to ModelPrice(3e-5, 1.8e-4, 1_050_000),
        "gpt-5.5" to ModelPrice(5e-6, 3e-5, 1_050_000),
        "gpt-5.5-pro" to ModelPrice(3e-5, 1.8e-4, 1_050_000),
        "codex-mini-latest" to ModelPrice(1.5e-6, 6e-6, 200_000)
    )

    // Trailing date suffix, e.g. "-2025-08-07", "-2026", "-2025-12".
    private val DATE_SUFFIX_RE = Regex("""-20\d{2}(?:-\d{2}){0,2}$""")

    /**
     * Look up the static price record for [model], or null when unknown.
     *
     * Matching is provider-prefix and date-suffix insensitive, and falls back to
     * the longest pricing-table key that prefixes the normalized name.
     */
    fun priceFor(model: String?): ModelPrice? {
        val key = normalize(model) ?: return null
        PRICES[key]?.let { return it }
        // Longest-prefix fallback: pick the most specific key the name starts with.
        return PRICES.entries
            .filter { key.startsWith(it.key) }
            .maxByOrNull { it.key.length }
            ?.value
    }

    /**
     * Compute the USD cost of [inputTokens] + [outputTokens] for [model].
     * Returns null when the model is unknown or both token counts are zero, so
     * callers can omit the `$` segment rather than render a misleading `$0.00`.
     */
    fun costUsd(model: String?, inputTokens: Long, outputTokens: Long): Double? {
        if (inputTokens <= 0L && outputTokens <= 0L) return null
        val price = priceFor(model) ?: return null
        val cost = inputTokens.coerceAtLeast(0L) * price.inputPerToken +
            outputTokens.coerceAtLeast(0L) * price.outputPerToken
        return if (cost > 0.0) cost else null
    }

    // Lowercase, drop any provider prefix ("openai/gpt-5" -> "gpt-5"), and strip a
    // trailing release-date suffix so dated model ids match the undated keys.
    private fun normalize(model: String?): String? {
        val raw = model?.trim()?.lowercase(Locale.US)?.takeIf { it.isNotBlank() } ?: return null
        val withoutProvider = raw.substringAfterLast('/')
        return DATE_SUFFIX_RE.replace(withoutProvider, "").takeIf { it.isNotBlank() }
    }
}
