package expo.modules.terminalemulator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

/**
 * The registry of trusted callers for the non-MCP ingress (fact sheet §2, D6
 * decided 2026-11-25): which installed app, signed by which certificate(s),
 * may call LauncherIngressProvider as a given origin. Generic on purpose —
 * Shelly ships NO package name, certificate or other owner value; the owner
 * enters them on the device (Settings), and until then nobody verifies.
 *
 * One entry per non-MCP origin (today only `launcher`):
 *  - packageName, and 1..[MAX_PINS] SHA-256 certificate pins (several
 *    generations for rotation, D4). Stored as lower-case hex without colons.
 *  - enabled: the ingress is on (off → DISABLED).
 *  - exemption (D1): the owner's grant of the taint exemption, bound to the
 *    exact pin set ([pinsDigest]), op and schema version it was given for.
 *    Changing the package or any pin drops it (and the origin's always-allow
 *    rules); it must be granted again for the new set.
 *
 * The principal of a verified caller is derived from the same digest, so a
 * new certificate set is a new principal (old rules never match it).
 *
 * Storage: SharedPreferences MAC'd with a non-exportable Android Keystore HMAC
 * key, re-keyed on every write (McpAlwaysAllowStore's pattern). Anything that
 * does not verify or decode strictly reads as NO callers: nothing verifies.
 * Writers: only TerminalEmulatorModule's trustedCaller* functions, which only
 * Settings calls. No file, queue, shell command or env reaches them.
 */
object TrustedCallerStore {
    private const val TAG = "TrustedCallerStore"
    private const val PREFS = "shelly_trusted_callers"
    private const val KEY_STATE = "state"
    private const val KEY_MAC = "mac"
    private const val KEY_ALIAS = "shelly_trusted_callers_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val DOMAIN = "shelly-trusted-callers-v1:"
    private const val DIGEST_DOMAIN = "shelly-trusted-caller-v1"

    const val VERSION = 1
    const val MAX_PINS = 4
    const val MAX_STATE_CHARS = 8 * 1024

    private val PACKAGE_RE = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
    private val PIN_RE = Regex("^[0-9a-f]{64}$")
    private val ENTRY_KEYS = setOf("origin", "packageName", "pins", "enabled", "exemption", "updatedAt")
    private val EXEMPTION_KEYS = setOf("pinsDigest", "op", "schemaVersion", "grantedAt")
    private val ROOT_KEYS = setOf("version", "callers")

    data class Exemption(val pinsDigest: String, val op: String, val schemaVersion: Int, val grantedAt: Long)

    data class Entry(
        val origin: String,
        val packageName: String,
        /** Lower-case hex SHA-256, sorted, unique. */
        val pins: List<String>,
        val enabled: Boolean,
        val exemption: Exemption?,
        val updatedAt: Long,
    )

    // ── Pure ─────────────────────────────────────────────────────────────────

    /**
     * A pin as entered: 64 hex digits, optionally colon-separated pairs (the
     * apksigner / keytool form), any case. Lower-case plain hex, or null.
     */
    fun normalizePin(raw: String?): String? {
        if (raw == null) return null
        val t = raw.trim()
        val plain = if (t.contains(':')) {
            val parts = t.split(':')
            if (parts.size != 32 || parts.any { it.length != 2 }) return null
            parts.joinToString("")
        } else t
        val lower = plain.lowercase()
        return if (PIN_RE.matches(lower)) lower else null
    }

    /** The pin's 32 bytes (for PackageManager.hasSigningCertificate), or null. */
    fun pinBytes(pin: String): ByteArray? {
        if (!PIN_RE.matches(pin)) return null
        return ByteArray(32) { i -> pin.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }

    fun isValidPackage(p: String?): Boolean = p != null && p.length <= 255 && PACKAGE_RE.matches(p)

    /** Only non-MCP origins of the IngressOrigin table can be registered callers. */
    fun isRegistrableOrigin(o: String?): Boolean = o != null && o != IngressOrigin.MCP && IngressOrigin.isKnown(o)

    private fun sha256Hex(s: String): String =
        MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    /** The digest the exemption is bound to and the principal is derived from: origin, package and the sorted pin set. */
    fun pinsDigest(origin: String, packageName: String, pins: List<String>): String =
        sha256Hex("$DIGEST_DOMAIN\u0000$origin\u0000$packageName\u0000${pins.sorted().joinToString(",")}")

    fun pinsDigest(e: Entry): String = pinsDigest(e.origin, e.packageName, e.pins)

    /** The verified caller's principal: the origin and the first 32 hex of [pinsDigest]. */
    fun principalOf(e: Entry): IngressDecision.Principal = IngressDecision.Principal(e.origin, pinsDigest(e).substring(0, 32))

    fun isValidEntry(e: Entry): Boolean {
        if (!isRegistrableOrigin(e.origin) || !isValidPackage(e.packageName)) return false
        if (e.pins.isEmpty() || e.pins.size > MAX_PINS || e.pins.any { !PIN_RE.matches(it) }) return false
        if (e.pins.toSet().size != e.pins.size || e.pins != e.pins.sorted()) return false
        if (e.updatedAt < 0) return false
        val x = e.exemption ?: return true
        val schema = IngressOrigin.exemptSchema(e.origin, x.op) ?: return false
        return PIN_RE.matches(x.pinsDigest) && x.schemaVersion == schema.schemaVersion && x.grantedAt >= 0
    }

    /**
     * D1: the exemption grant holds for [op] only when it exists and is bound to
     * this entry's CURRENT pin set and the op's current schema version.
     */
    fun exemptionBound(e: Entry?, op: String): Boolean {
        val x = e?.exemption ?: return false
        val schema = IngressOrigin.exemptSchema(e.origin, op) ?: return false
        return x.op == op && x.schemaVersion == schema.schemaVersion &&
            MessageDigest.isEqual(x.pinsDigest.toByteArray(Charsets.US_ASCII), pinsDigest(e).toByteArray(Charsets.US_ASCII))
    }

    private fun entryJson(e: Entry): JSONObject {
        val o = JSONObject().put("origin", e.origin).put("packageName", e.packageName)
            .put("pins", JSONArray(e.pins)).put("enabled", e.enabled).put("updatedAt", e.updatedAt)
        val x = e.exemption
        if (x != null) {
            o.put("exemption", JSONObject().put("pinsDigest", x.pinsDigest).put("op", x.op)
                .put("schemaVersion", x.schemaVersion).put("grantedAt", x.grantedAt))
        }
        return o
    }

    fun encode(entries: List<Entry>): String {
        val arr = JSONArray()
        for (e in entries) arr.put(entryJson(e))
        return JSONObject().put("version", VERSION).put("callers", arr).toString()
    }

    private fun keysOf(o: JSONObject): Set<String> {
        val out = HashSet<String>()
        val it = o.keys()
        while (it.hasNext()) out.add(it.next())
        return out
    }

    private fun longOf(v: Any?): Long? = if (v is Int || v is Long) (v as Number).toLong() else null

    /** Null when anything is off (strict: the whole state then means no callers). */
    fun decode(text: String): List<Entry>? {
        try {
            if (text.length > MAX_STATE_CHARS) return null
            val root = JSONObject(text)
            if (!ROOT_KEYS.containsAll(keysOf(root)) || root.opt("version") != VERSION) return null
            val arr = root.getJSONArray("callers")
            val out = ArrayList<Entry>()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                if (!ENTRY_KEYS.containsAll(keysOf(o))) return null
                val pinsArr = o.get("pins") as? JSONArray ?: return null
                val pins = ArrayList<String>()
                for (j in 0 until pinsArr.length()) pins.add(pinsArr.get(j) as? String ?: return null)
                val x = if (o.has("exemption")) {
                    val xo = o.get("exemption") as? JSONObject ?: return null
                    if (!EXEMPTION_KEYS.containsAll(keysOf(xo))) return null
                    val sv = longOf(xo.opt("schemaVersion")) ?: return null
                    if (sv !in 1L..99L) return null
                    Exemption(
                        pinsDigest = xo.get("pinsDigest") as? String ?: return null,
                        op = xo.get("op") as? String ?: return null,
                        schemaVersion = sv.toInt(),
                        grantedAt = longOf(xo.opt("grantedAt")) ?: return null,
                    )
                } else null
                val e = Entry(
                    origin = o.get("origin") as? String ?: return null,
                    packageName = o.get("packageName") as? String ?: return null,
                    pins = pins,
                    enabled = o.get("enabled") as? Boolean ?: return null,
                    exemption = x,
                    updatedAt = longOf(o.opt("updatedAt")) ?: return null,
                )
                if (!isValidEntry(e)) return null
                if (out.any { it.origin == e.origin }) return null
                out.add(e)
            }
            return out
        } catch (e: Exception) {
            return null
        }
    }

    enum class Status { EMPTY, OK, UNREADABLE }

    data class Classified(val status: Status, val entries: List<Entry>)

    /** McpAlwaysAllowStore.classify, for this state. */
    fun classify(state: String?, storedMac: String?, expectedMac: String?): Classified {
        if (state == null && storedMac == null) return Classified(Status.EMPTY, emptyList())
        if (state == null || storedMac == null || expectedMac == null) return Classified(Status.UNREADABLE, emptyList())
        if (!MessageDigest.isEqual(expectedMac.toByteArray(Charsets.UTF_8), storedMac.toByteArray(Charsets.UTF_8))) {
            return Classified(Status.UNREADABLE, emptyList())
        }
        val entries = decode(state) ?: return Classified(Status.UNREADABLE, emptyList())
        return Classified(if (entries.isEmpty()) Status.EMPTY else Status.OK, entries)
    }

    sealed class SetResult {
        data class Ok(val entries: List<Entry>, val entry: Entry, val identityChanged: Boolean) : SetResult()
        data class Refused(val code: String) : SetResult()
    }

    /**
     * Pure: [entries] with [origin]'s caller set to [packageName] / [rawPins]
     * (each normalized) / [enabled]. If the package or the pin set changes, the
     * exemption is dropped (D1: "adding or rotating a pin voids it").
     */
    fun withCaller(entries: List<Entry>, origin: String, packageName: String, rawPins: List<String>, enabled: Boolean, now: Long): SetResult {
        if (!isRegistrableOrigin(origin)) return SetResult.Refused("invalid_origin")
        if (!isValidPackage(packageName)) return SetResult.Refused("invalid_package")
        val pins = rawPins.map { normalizePin(it) ?: return SetResult.Refused("invalid_pin") }.toSortedSet().toList()
        if (pins.isEmpty() || pins.size > MAX_PINS) return SetResult.Refused("invalid_pin")
        val old = entries.firstOrNull { it.origin == origin }
        val identityChanged = old == null || old.packageName != packageName || old.pins != pins
        val e = Entry(origin, packageName, pins, enabled, if (identityChanged) null else old?.exemption, now)
        if (!isValidEntry(e)) return SetResult.Refused("invalid")
        val next = entries.filter { it.origin != origin } + e
        if (encode(next).length > MAX_STATE_CHARS) return SetResult.Refused("full")
        return SetResult.Ok(next, e, identityChanged)
    }

    /**
     * Pure, D1: grant (or withdraw) the exemption for [op] on [origin]'s caller.
     * A grant must name the digest the owner confirmed ([expectedDigest], shown
     * in Settings): if the pins changed in between, it is refused.
     */
    fun withExemption(entries: List<Entry>, origin: String, op: String, grant: Boolean, expectedDigest: String?, now: Long): SetResult {
        val old = entries.firstOrNull { it.origin == origin } ?: return SetResult.Refused("no_caller")
        val next = if (!grant) {
            old.copy(exemption = null, updatedAt = now)
        } else {
            val schema = IngressOrigin.exemptSchema(origin, op) ?: return SetResult.Refused("not_exemptable")
            val digest = pinsDigest(old)
            if (expectedDigest == null || expectedDigest != digest) return SetResult.Refused("digest_changed")
            old.copy(exemption = Exemption(digest, op, schema.schemaVersion, now), updatedAt = now)
        }
        if (!isValidEntry(next)) return SetResult.Refused("invalid")
        return SetResult.Ok(entries.map { if (it.origin == origin) next else it }, next, false)
    }

    /** For Settings: no secrets in here (pins are public certificate digests). */
    fun statusJson(c: Classified): String {
        val arr = JSONArray()
        for (e in c.entries) {
            arr.put(entryJson(e).put("pinsDigest", pinsDigest(e)).put("principal", principalOf(e).wire)
                .put("exemptionBound", exemptionBound(e, IngressDecision.OP_SUBMIT_INSTRUCTION)))
        }
        return JSONObject().put("version", VERSION).put("status", c.status.name.lowercase()).put("callers", arr).toString()
    }

    // ── Keystore + prefs (device only) ───────────────────────────────────────

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    private fun newKey(): SecretKey {
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE)
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN).build())
        return generator.generateKey()
    }

    private fun mac(key: SecretKey, state: String): String {
        val m = Mac.getInstance("HmacSHA256")
        m.init(key)
        return m.doFinal("$DOMAIN$state".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    /** Verified entries; NONE when anything fails to verify. Never throws. */
    @Synchronized
    fun read(context: Context): Classified = try {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val state = prefs.getString(KEY_STATE, null)
        val stored = prefs.getString(KEY_MAC, null)
        val key = if (state != null && stored != null) existingKey() else null
        val c = classify(state, stored, if (key != null && state != null) mac(key, state) else null)
        if (c.status == Status.UNREADABLE) Log.w(TAG, "trusted caller state does not verify - treating as none")
        c
    } catch (e: Exception) {
        Log.w(TAG, "trusted caller read failed - treating as none type=${e.javaClass.simpleName}")
        Classified(Status.UNREADABLE, emptyList())
    }

    /** [origin]'s verified entry, or null. */
    fun entry(context: Context, origin: String): Entry? = read(context).entries.firstOrNull { it.origin == origin }

    /** A fresh key for every write. Throws on failure. */
    private fun write(context: Context, entries: List<Entry>) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val state = encode(entries)
        val key = newKey()
        if (!prefs.edit().putString(KEY_STATE, state).putString(KEY_MAC, mac(key, state)).commit()) error("prefs commit failed")
    }

    private fun result(ok: Boolean, code: String, context: Context): String =
        JSONObject(statusJson(read(context))).put("ok", ok).put("code", code).toString()

    /**
     * Settings: register / update [origin]'s caller. A changed identity drops
     * the exemption and narrows the origin's always-allow rules to the new
     * principal (none yet). Returns status JSON plus `ok` and `code`.
     */
    @Synchronized
    fun setCaller(context: Context, origin: String, packageName: String, pins: List<String>, enabled: Boolean): String {
        val current = read(context)
        return when (val r = withCaller(current.entries, origin, packageName, pins, enabled, System.currentTimeMillis())) {
            is SetResult.Refused -> result(false, r.code, context)
            is SetResult.Ok -> try {
                write(context, r.entries)
                if (r.identityChanged) McpAlwaysAllowStore.purgeOriginExcept(context, origin, principalOf(r.entry).wire)
                Log.i(TAG, "trusted caller set origin=$origin identityChanged=${r.identityChanged} enabled=$enabled")
                result(true, if (r.identityChanged) "set" else "updated", context)
            } catch (e: Exception) {
                Log.w(TAG, "trusted caller write failed type=${e.javaClass.simpleName}")
                result(false, "failed", context)
            }
        }
    }

    /** Settings: grant / withdraw the D1 exemption. */
    @Synchronized
    fun setExemption(context: Context, origin: String, op: String, grant: Boolean, expectedDigest: String?): String {
        val current = read(context)
        return when (val r = withExemption(current.entries, origin, op, grant, expectedDigest, System.currentTimeMillis())) {
            is SetResult.Refused -> result(false, r.code, context)
            is SetResult.Ok -> try {
                write(context, r.entries)
                Log.i(TAG, "trusted caller exemption origin=$origin grant=$grant")
                result(true, if (grant) "granted" else "withdrawn", context)
            } catch (e: Exception) {
                Log.w(TAG, "trusted caller write failed type=${e.javaClass.simpleName}")
                result(false, "failed", context)
            }
        }
    }

    /** Settings: remove [origin]'s caller and its always-allow rules. Narrowing: on a failed write, clears everything. */
    @Synchronized
    fun removeCaller(context: Context, origin: String): String {
        val left = read(context).entries.filter { it.origin != origin }
        val ok = try {
            write(context, left)
            true
        } catch (e: Exception) {
            runCatching { write(context, emptyList()) }.isSuccess
        }
        if (isRegistrableOrigin(origin)) McpAlwaysAllowStore.purgeOriginExcept(context, origin, null)
        Log.i(TAG, "trusted caller removed origin=$origin ok=$ok")
        return result(ok, "removed", context)
    }

    fun list(context: Context): String = statusJson(read(context))
}
