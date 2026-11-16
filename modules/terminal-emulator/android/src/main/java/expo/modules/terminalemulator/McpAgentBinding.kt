package expo.modules.terminalemulator

import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/**
 * Kotlin port of the run_agent binding hash (lib/mcp-typed-ops.ts
 * agentBindingProjection / agentBindingHash) and of the canonical JSON both
 * the binding and the queue request MAC use (lib/mcp-request-auth.ts
 * canonicalJson, scripts/shelly-mcp-server.js canonicalJson).
 *
 *   bind = hex(sha256(utf8(canonicalJson(projection))))
 *
 * where the projection holds exactly [BIND_FIELDS] of the agent JSON on disk
 * (`~/.shelly/agents/<id>.json`), an absent field as null. canonicalJson sorts
 * object keys by UTF-16 code units (JS `Array.prototype.sort`) and prints
 * leaves exactly as JS `JSON.stringify` does — strings with JSON.stringify's
 * escapes (incl. lone surrogates as \udxxx), numbers in ECMAScript
 * Number::toString form (shortest round-trip digits; exponent form below 1e-6
 * and from 1e21 up).
 *
 * Shared fixtures keep this byte-identical with TS:
 * __tests__/fixtures/mcp-agent-binding-cases.json (binding) and
 * __tests__/fixtures/mcp-signed-request-cases.json (request MAC); see
 * McpAgentBindingTest (JVM) and __tests__/mcp-typed-op-native-parity.test.ts.
 *
 * Pure: no Android dependency.
 */
object McpAgentBinding {
    /** lib/mcp-typed-ops.ts AGENT_BIND_FIELDS — the same list, the same order. Do not add fields. */
    val BIND_FIELDS: List<String> = listOf(
        "prompt",
        "tool",
        "toolPinned",
        "autonomous",
        "requireActionApproval",
        "autonomyLevel",
        "workspaceRoot",
        "outputPath",
        "action",
        "actions",
        "orchestration",
        "skillId",
        "notificationTrigger",
        "runOn",
        "memory",
    )

    /** The projection of [agent]: every bind field, an absent one as JSON null. */
    fun projection(agent: JSONObject): JSONObject {
        val out = JSONObject()
        for (f in BIND_FIELDS) {
            val v = if (agent.has(f)) agent.opt(f) else null
            out.put(f, v ?: JSONObject.NULL)
        }
        return out
    }

    /** 64 lowercase hex. Throws on a value canonicalJson cannot print (never for parsed JSON). */
    fun bindingHash(agent: JSONObject): String = sha256Hex(canonicalJson(projection(agent)))

    fun sha256Hex(text: String): String =
        MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    // ── canonicalJson ────────────────────────────────────────────────────

    fun canonicalJson(value: Any?): String {
        val sb = StringBuilder()
        append(sb, value)
        return sb.toString()
    }

    private fun keysOf(o: JSONObject): List<String> {
        val out = ArrayList<String>()
        val it = o.keys()
        while (it.hasNext()) out.add(it.next())
        // String.compareTo compares UTF-16 code units, like JS's default sort.
        out.sort()
        return out
    }

    private fun append(sb: StringBuilder, v: Any?) {
        when {
            v == null || v === JSONObject.NULL -> sb.append("null")
            v is JSONObject -> {
                sb.append('{')
                var first = true
                for (k in keysOf(v)) {
                    if (!first) sb.append(',')
                    first = false
                    quote(sb, k)
                    sb.append(':')
                    append(sb, v.opt(k))
                }
                sb.append('}')
            }
            v is JSONArray -> {
                sb.append('[')
                for (i in 0 until v.length()) {
                    if (i > 0) sb.append(',')
                    append(sb, v.opt(i))
                }
                sb.append(']')
            }
            v is Map<*, *> -> append(sb, JSONObject(v))
            v is Collection<*> -> append(sb, JSONArray(v))
            v is String -> quote(sb, v)
            v is Boolean -> sb.append(if (v) "true" else "false")
            v is Number -> sb.append(jsNumber(v.toDouble()))
            else -> throw IllegalArgumentException("not a JSON value: ${v.javaClass.simpleName}")
        }
    }

    /** JSON.stringify(string). */
    fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        var i = 0
        val n = s.length
        while (i < n) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> sb.append("\\u").append(hex4(c.code))
                Character.isHighSurrogate(c) -> {
                    if (i + 1 < n && Character.isLowSurrogate(s[i + 1])) {
                        sb.append(c).append(s[i + 1])
                        i++
                    } else {
                        sb.append("\\u").append(hex4(c.code))
                    }
                }
                Character.isLowSurrogate(c) -> sb.append("\\u").append(hex4(c.code))
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }

    private fun hex4(code: Int): String {
        val h = Integer.toHexString(code)
        return "0000".substring(h.length) + h
    }

    /**
     * ECMAScript Number::toString(x) (what JSON.stringify prints for a finite
     * number; NaN / Infinity print as null). The digits are the shortest that
     * round-trip, the closest such when several do: for each precision p the
     * correctly rounded value of the exact binary double is tried first, then
     * its two neighbours (the rounding interval is asymmetric at powers of two).
     */
    fun jsNumber(d: Double): String {
        if (d.isNaN() || d.isInfinite()) return "null"
        if (d == 0.0) return "0" // also -0
        val exact = BigDecimal(d)
        var chosen: BigDecimal? = null
        loop@ for (p in 1..17) {
            for (mode in arrayOf(RoundingMode.HALF_EVEN, RoundingMode.FLOOR, RoundingMode.CEILING)) {
                val r = exact.round(MathContext(p, mode))
                if (java.lang.Double.parseDouble(r.toString()) == d) {
                    chosen = r
                    break@loop
                }
            }
        }
        val r = (chosen ?: BigDecimal(java.lang.Double.toString(d))).stripTrailingZeros()
        val digits = r.unscaledValue().abs().toString()
        val k = digits.length
        val nExp = k - r.scale() // value = 0.digits × 10^nExp
        val sign = if (d < 0) "-" else ""
        val body = when {
            nExp in k..21 -> digits + "0".repeat(nExp - k)
            nExp in 1..21 -> digits.substring(0, nExp) + "." + digits.substring(nExp)
            nExp in -5..0 -> "0." + "0".repeat(-nExp) + digits
            else -> {
                val e = nExp - 1
                val es = if (e >= 0) "+$e" else "-${-e}"
                if (k == 1) "${digits}e$es" else "${digits[0]}.${digits.substring(1)}e$es"
            }
        }
        return sign + body
    }
}
