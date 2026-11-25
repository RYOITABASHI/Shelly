package expo.modules.terminalemulator

import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

/**
 * The pure half of the stream feed (fact sheet §6.2 P1–P7; C7): the MCP typed
 * op `put_stream_feed` that lands the feed in Shelly, and the response the
 * launcher's `get_stream_feed` read gets. No Android dependency, so the JVM
 * test StreamFeedCoreTest covers all of it. Storage is StreamFeedStore.
 *
 * The feed is an opaque v1 document from external sources (mail, social): it
 * is ALWAYS tainted (IngressOrigin.taintFor(mcp)). Shelly checks only that it
 * is a JSON object with `v == 1`, inside the size cap, with the digest and
 * size the supplier declared; it never reads, reorders or edits the items.
 * The stored copy is handed to the verified launcher only. No run, prompt,
 * agent input, log line or audit line ever gets its content (audit: sha256,
 * bytes, item count, code). Mirrored by lib/mcp-stream-feed.ts.
 */
object StreamFeedCore {
    const val OP = IngressDecision.OP_PUT_STREAM_FEED
    /** The one always-allow target of [OP] (McpAlwaysAllowStore TARGET_RES). */
    const val TARGET = "stream-feed"
    /** Inline in one signed MCP request, under its 64 KiB file cap (R6, D3). */
    const val MAX_BYTES = LauncherIngressLimits.MAX_FEED_BYTES
    const val FEED_VERSION = 1
    /** get_stream_feed's own contract version (the Bundle shape below). */
    const val RESPONSE_VERSION = 1

    private val SHA256_RE = Regex("^[0-9a-f]{64}$")
    private val ARG_KEYS = setOf("feedJson", "expectedSha256", "expectedBytes")

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** A feed that passed [validate]: the exact bytes, their digest and (audit only) the item count. */
    class Feed(val bytes: ByteArray, val sha256: String, val items: Int?) {
        val size: Int get() = bytes.size
    }

    val INVALID_FEED = McpTypedOpDecision.Refusal("invalid_feed", "feedJson is not a JSON object with \"v\": 1")
    val TOO_LARGE = McpTypedOpDecision.Refusal("too_large", "feedJson is larger than $MAX_BYTES bytes (UTF-8); send fewer items")
    val SIZE_MISMATCH = McpTypedOpDecision.Refusal("size_mismatch", "feedJson is not expectedBytes long (UTF-8)")
    val DIGEST_MISMATCH = McpTypedOpDecision.Refusal("digest_mismatch", "the SHA-256 of feedJson (UTF-8) is not expectedSha256")

    private fun bad(m: String) = McpTypedOpDecision.Refusal("invalid_params", m)

    /**
     * The op's arguments, strictly (spec order: arguments, size cap, size,
     * digest, document). Returns [Feed] or [Refusal]. Never throws.
     */
    fun validate(args: JSONObject): Any /* Feed | McpTypedOpDecision.Refusal */ {
        try {
            val it = args.keys()
            while (it.hasNext()) {
                val k = it.next()
                if (k !in ARG_KEYS) return bad("unknown argument: ${k.take(40)}")
            }
            val text = args.opt("feedJson") as? String ?: return bad("feedJson must be a string")
            // An unpaired surrogate would encode differently here (?) and in node (EF BF BD):
            // refused, as the script and the TS mirror do.
            if (!wellFormed(text)) return bad("feedJson contains an unpaired UTF-16 surrogate")
            val sha = args.opt("expectedSha256") as? String ?: return bad("expectedSha256 must match ^[0-9a-f]{64}\$")
            if (!SHA256_RE.matches(sha)) return bad("expectedSha256 must match ^[0-9a-f]{64}\$")
            val declared = wholeNumber(args.opt("expectedBytes")) ?: return bad("expectedBytes must be an integer 1..$MAX_BYTES")
            if (declared < 1L || declared > MAX_BYTES.toLong()) return bad("expectedBytes must be an integer 1..$MAX_BYTES")
            return checkBytes(text.toByteArray(Charsets.UTF_8), declared.toInt(), sha)
        } catch (e: Exception) {
            return bad("invalid arguments")
        }
    }

    /** Size cap, size, digest, then the document. Also used on the RN path (streamFeedPut). */
    fun checkBytes(bytes: ByteArray, expectedBytes: Int, expectedSha256: String): Any /* Feed | McpTypedOpDecision.Refusal */ {
        if (bytes.size > MAX_BYTES) return TOO_LARGE
        if (bytes.size != expectedBytes) return SIZE_MISMATCH
        val sha = sha256Hex(bytes)
        if (sha != expectedSha256) return DIGEST_MISMATCH
        val doc = parseObject(bytes) ?: return INVALID_FEED
        if (!isVersionOne(doc.opt("v"))) return INVALID_FEED
        val items = (doc.opt("items") as? JSONArray)?.length()
        return Feed(bytes, sha, items)
    }

    /** One JSON object and nothing after it; null otherwise (org.json is lenient, the script checked strictly). */
    private fun parseObject(bytes: ByteArray): JSONObject? = try {
        // Strict UTF-8: malformed input throws instead of becoming U+FFFD.
        val text = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
            .toString()
        // org.json is lenient (unquoted keys, single quotes, ...): the text must
        // first pass a strict RFC 8259 check, as JSON.parse in the script does.
        if (!StrictJson.isObject(text)) {
            null
        } else {
            val tok = JSONTokener(text)
            val v = tok.nextValue()
            if (v is JSONObject && tok.nextClean() == 0.toChar()) v else null
        }
    } catch (e: Exception) {
        null
    }

    private fun wellFormed(s: String): Boolean {
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= s.length || !Character.isLowSurrogate(s[i + 1])) return false
                i += 2
                continue
            }
            if (Character.isLowSurrogate(c)) return false
            i++
        }
        return true
    }

    private fun isVersionOne(v: Any?): Boolean = when (v) {
        is Int -> v == FEED_VERSION
        is Long -> v == FEED_VERSION.toLong()
        is Double -> v == FEED_VERSION.toDouble()
        else -> false
    }

    private fun wholeNumber(v: Any?): Long? = when (v) {
        is Int -> v.toLong()
        is Long -> v
        is Double -> if (v == Math.floor(v) && !v.isInfinite() && Math.abs(v) < 1e9) v.toLong() else null
        else -> null
    }

    // ── Decision (McpTypedOpConsumer, op put_stream_feed) ─────────────────

    val DISABLED = McpTypedOpDecision.Refusal("disabled", McpTypedOpDecision.TYPED_OPS_DISABLED_MESSAGE)
    val REVOKED = McpTypedOpDecision.Refusal("revoked", "cancelled: the MCP token is no longer valid")
    val HALTED = McpTypedOpDecision.Refusal("halted", "all agents are stopped (STOP-ALL is on); the feed was not stored")
    val NOT_ATTENDED = McpTypedOpDecision.Refusal(
        "not_attended",
        "Shelly is not in the foreground on the phone and no always-allow rule matches put_stream_feed; nobody can approve this now",
    )
    val EXPIRED = McpTypedOpDecision.Refusal("approval_timeout", "the request expired before the feed could be stored")
    val TARGET_CHANGED = McpTypedOpDecision.Refusal("target_changed", "the always-allow rule no longer applies; call put_stream_feed again")
    val AUDIT_FAILED = McpTypedOpDecision.Refusal("audit_failed", "the feed was not stored: its audit line could not be written")
    val STORE_FAILED = McpTypedOpDecision.Refusal("store_failed", "the feed could not be written; the previous feed is kept")

    /** The facts, read lazily and in order. Implementations must not throw (fail closed inside). */
    interface Steps {
        fun typedOpsOn(): Boolean
        fun epochCurrent(): Boolean
        fun halted(): Boolean
        /** The id of the always-allow rule matching (principal, [OP], [TARGET], no bind), or null. */
        fun matchRule(principal: String): String?
        fun rnLive(): Boolean
    }

    sealed class Outcome {
        data class Refuse(val refusal: McpTypedOpDecision.Refusal) : Outcome()
        /** A rule matched a fully checked request: store it (re-checked under the consumer's commit lock). */
        data class Execute(val feed: Feed, val ruleId: String) : Outcome()
        /** No rule, RN live: move the original file into requests/ for the approval tap. */
        object Handoff : Outcome()
    }

    /** put_stream_feed through the shared stage order (IngressDecision.evaluate). */
    fun decide(req: McpTypedOpDecision.Request, s: Steps, nowMs: Long): Outcome {
        var feed: Feed? = null
        val hooks: Map<IngressDecision.Stage, () -> Outcome?> = mapOf(
            IngressDecision.Stage.SETTING to { if (!s.typedOpsOn()) Outcome.Refuse(DISABLED) else null },
            IngressDecision.Stage.ARGS to {
                if (req.tool != OP) {
                    Outcome.Refuse(bad("unknown tool: ${req.tool.take(40)}"))
                } else {
                    when (val v = validate(req.args)) {
                        is Feed -> { feed = v; null }
                        is McpTypedOpDecision.Refusal -> Outcome.Refuse(v)
                        else -> Outcome.Refuse(bad("invalid arguments"))
                    }
                }
            },
            IngressDecision.Stage.EPOCH to { if (!s.epochCurrent()) Outcome.Refuse(REVOKED) else null },
            IngressDecision.Stage.STOP_ALL to { if (s.halted()) Outcome.Refuse(HALTED) else null },
            IngressDecision.Stage.ALWAYS_ALLOW to {
                val ruleId = s.matchRule(req.principal)
                when {
                    ruleId != null -> Outcome.Execute(feed!!, ruleId)
                    nowMs - req.receivedAtMs <= McpTypedOpDecision.HANDOFF_MAX_AGE_MS && s.rnLive() -> Outcome.Handoff
                    else -> Outcome.Refuse(NOT_ATTENDED)
                }
            },
        )
        return IngressDecision.evaluate(OP, hooks) ?: Outcome.Refuse(NOT_ATTENDED)
    }

    // ── Results (the RN bridge's JSON.stringify(ToolResult) shape) ─────────

    fun errorResult(r: McpTypedOpDecision.Refusal): String = JSONObject().put("ok", false).put("error", r.message).put("code", r.code).toString()

    fun storedResult(sha256: String, bytes: Int, receivedAt: Long): String {
        val data = JSONObject().put("stored", true).put("sha256", sha256).put("bytes", bytes)
            .put("receivedAt", receivedAt).put("untrusted", true)
        return JSONObject().put("ok", true).put("data", data).toString()
    }

    // ── Stored file format (StreamFeedStore) ──────────────────────────────

    /** Header line + raw bytes. The header holds no feed content. */
    fun encode(feed: Feed, receivedAt: Long): ByteArray {
        val header = JSONObject().put("v", FEED_VERSION).put("receivedAt", receivedAt)
            .put("sha256", feed.sha256).put("bytes", feed.size).toString()
        return (header + "\n").toByteArray(Charsets.UTF_8) + feed.bytes
    }

    class Stored(val bytes: ByteArray, val sha256: String, val receivedAt: Long) {
        val text: String get() = String(bytes, Charsets.UTF_8)
    }

    /** The stored file back, or null when it is not exactly what [encode] wrote (size and digest re-checked). */
    fun decode(file: ByteArray): Stored? {
        try {
            val nl = file.indexOf('\n'.code.toByte())
            if (nl <= 0 || nl > 256) return null
            val h = JSONObject(String(file, 0, nl, Charsets.UTF_8))
            val body = file.copyOfRange(nl + 1, file.size)
            if (!isVersionOne(h.opt("v"))) return null
            val sha = h.opt("sha256") as? String ?: return null
            if (!SHA256_RE.matches(sha)) return null
            val size = wholeNumber(h.opt("bytes")) ?: return null
            val at = wholeNumber(h.opt("receivedAt")) ?: return null
            if (at <= 0L || body.size.toLong() != size || body.size > MAX_BYTES) return null
            if (sha256Hex(body) != sha) return null
            return Stored(body, sha, at)
        } catch (e: Exception) {
            return null
        }
    }

    // ── get_stream_feed response (the launcher read; Provider call()) ─────

    object Read {
        const val STATUS = "status"
        const val RESPONSE_VERSION_KEY = "response_version"
        const val FEED_JSON = "feed_json"
        const val SHA256 = "sha256"
        const val BYTES = "bytes"
        const val UPDATED_AT = "updated_at"
        const val REASON = "reason"

        const val OK = "ok"
        const val EMPTY = "empty"
        const val DENIED = "denied"
        const val ERROR = "error"
    }

    /** What the store holds, for [readResponse]. */
    sealed class State {
        object Empty : State()
        object Unreadable : State()
        class Present(val stored: Stored) : State()
    }

    /**
     * The `get_stream_feed` answer for a VERIFIED caller (the Provider puts each
     * entry into the Bundle as String / Int / Long). Unverified callers and a
     * disabled ingress get [deniedResponse] and never reach the store.
     */
    fun readResponse(state: State): Map<String, Any> = when (state) {
        is State.Present -> linkedMapOf(
            Read.STATUS to Read.OK,
            Read.RESPONSE_VERSION_KEY to RESPONSE_VERSION,
            Read.FEED_JSON to state.stored.text,
            Read.SHA256 to state.stored.sha256,
            Read.BYTES to state.stored.bytes.size,
            Read.UPDATED_AT to state.stored.receivedAt,
        )
        State.Empty -> linkedMapOf(Read.STATUS to Read.EMPTY, Read.RESPONSE_VERSION_KEY to RESPONSE_VERSION)
        State.Unreadable -> linkedMapOf(Read.STATUS to Read.ERROR, Read.RESPONSE_VERSION_KEY to RESPONSE_VERSION, Read.REASON to "INTERNAL_ERROR")
    }

    /** [reason]: VERIFY_FAILED or DISABLED (fact sheet §1.3; no detail of which check failed). */
    fun deniedResponse(reason: String): Map<String, Any> =
        linkedMapOf(Read.STATUS to Read.DENIED, Read.RESPONSE_VERSION_KEY to RESPONSE_VERSION, Read.REASON to reason)
}

/**
 * A strict RFC 8259 well-formedness check (JSON.parse's grammar) with a
 * nesting cap, so the native side accepts exactly what the script accepted.
 * Pure; never throws.
 */
internal object StrictJson {
    const val MAX_DEPTH = 64

    fun isObject(s: String): Boolean = try {
        val p = P(s)
        p.ws()
        if (p.peek() != '{') false else {
            p.value(0)
            p.ws()
            p.i == s.length
        }
    } catch (e: Exception) {
        false
    }

    private class P(val s: String) {
        var i = 0

        fun peek(): Char = if (i < s.length) s[i] else '\u0000'

        fun ws() {
            while (i < s.length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\n' || s[i] == '\r')) i++
        }

        fun expect(c: Char) {
            if (peek() != c || i >= s.length) throw IllegalArgumentException()
            i++
        }

        fun value(depth: Int) {
            if (depth > MAX_DEPTH) throw IllegalArgumentException()
            ws()
            when (peek()) {
                '{' -> obj(depth)
                '[' -> arr(depth)
                '"' -> str()
                't' -> lit("true")
                'f' -> lit("false")
                'n' -> lit("null")
                else -> num()
            }
        }

        fun obj(depth: Int) {
            expect('{')
            ws()
            if (peek() == '}') { i++; return }
            while (true) {
                ws()
                str()
                ws()
                expect(':')
                value(depth + 1)
                ws()
                if (peek() == ',') { i++; continue }
                expect('}')
                return
            }
        }

        fun arr(depth: Int) {
            expect('[')
            ws()
            if (peek() == ']') { i++; return }
            while (true) {
                value(depth + 1)
                ws()
                if (peek() == ',') { i++; continue }
                expect(']')
                return
            }
        }

        fun str() {
            expect('"')
            while (true) {
                if (i >= s.length) throw IllegalArgumentException()
                val c = s[i++]
                when {
                    c == '"' -> return
                    c < ' ' -> throw IllegalArgumentException()
                    c == '\\' -> {
                        if (i >= s.length) throw IllegalArgumentException()
                        when (s[i++]) {
                            '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> Unit
                            'u' -> {
                                if (i + 4 > s.length) throw IllegalArgumentException()
                                for (k in 0 until 4) if (s[i + k] !in '0'..'9' && s[i + k] !in 'a'..'f' && s[i + k] !in 'A'..'F') throw IllegalArgumentException()
                                i += 4
                            }
                            else -> throw IllegalArgumentException()
                        }
                    }
                }
            }
        }

        fun lit(w: String) {
            if (!s.startsWith(w, i)) throw IllegalArgumentException()
            i += w.length
        }

        fun num() {
            val start = i
            if (peek() == '-') i++
            if (peek() == '0') {
                i++
            } else if (peek() in '1'..'9') {
                while (peek() in '0'..'9') i++
            } else {
                throw IllegalArgumentException()
            }
            if (peek() == '.') {
                i++
                if (peek() !in '0'..'9') throw IllegalArgumentException()
                while (peek() in '0'..'9') i++
            }
            if (peek() == 'e' || peek() == 'E') {
                i++
                if (peek() == '+' || peek() == '-') i++
                if (peek() !in '0'..'9') throw IllegalArgumentException()
                while (peek() in '0'..'9') i++
            }
            if (i == start) throw IllegalArgumentException()
        }
    }
}
