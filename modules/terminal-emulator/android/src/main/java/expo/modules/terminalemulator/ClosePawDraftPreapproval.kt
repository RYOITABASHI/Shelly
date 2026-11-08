package expo.modules.terminalemulator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.security.KeyStore
import java.security.MessageDigest
import java.util.TimeZone
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

/**
 * "Save drafts without approval", per destination (owner decision 2026-11-08,
 * option 2 of DEFERRED.md "ClosePaw save-draft").
 *
 * When a destination (`note`, `substack:<subdomain>`) is on, [ClosePawDrafts]
 * sends queued drafts for it at the first unlock without the notification tap,
 * up to [Entry.cap] drafts a day, and tells the owner afterwards. Everything else
 * about a draft is unchanged: the destinations file still decides the allowed
 * Substack subdomains and image hosts, the item is re-hashed before it goes, and
 * the broadcast is the save-draft routine, which cannot publish.
 *
 * Who can turn it on: only [enable], called only by TerminalEmulatorModule's
 * `setDraftPreapproval`, which RN calls only for words the owner typed in the AI
 * pane composer (lib/closepaw-draft-preapproval.ts). There is no shell command,
 * file, queue field or env that reaches it. OFF ([disable]) is safe from anywhere.
 *
 * Storage: this app's SharedPreferences, MAC'd with a non-exportable Android
 * Keystore HMAC key (the CodexRemoteAutostart pattern). The state is read here by
 * native code, which is why it is not in expo-secure-store (RN only). Every write,
 * including each draft counted against the cap, makes a NEW key, so an older copy
 * of the prefs (a rollback to "on", or to a lower count) never verifies again.
 * Anything that does not verify reads as OFF, with no entries. A process of this
 * uid can delete the prefs, which only turns it off.
 *
 * Boundary, as for CodexRemoteAutostart: code running as this uid that can drive
 * AndroidKeyStore itself (an `app_process` with this APK on the classpath) could
 * call [enable]. Shell writes to files cannot.
 */
object ClosePawDraftPreapproval {
    private const val TAG = "ClosePawDraftPreapproval"
    private const val PREFS = "shelly_draft_preapproval"
    private const val KEY_STATE = "state"
    private const val KEY_MAC = "mac"
    private const val KEY_ALIAS = "shelly_draft_preapproval_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val DOMAIN = "shelly-draft-preapproval-v1:"

    const val DEFAULT_DAILY_CAP = 5
    const val MAX_DAILY_CAP = 20
    private const val MAX_ENTRIES = 8
    private const val MAX_STATE_CHARS = 4096
    private val DEST_RE = Regex("^(note|substack:[a-z0-9-]{1,63})$")

    /** [day] is the local epoch day [used] counts for. */
    data class Entry(val dest: String, val cap: Int, val enabledAt: Long, val day: Long, val used: Int)

    fun isValidDest(dest: String): Boolean = DEST_RE.matches(dest)

    /** The destination a draft binds to. Substack needs the subdomain the destinations file resolved. */
    fun destinationKey(platform: String, subdomain: String?): String? = when {
        platform == "note" -> "note"
        platform == "substack" && subdomain != null -> "substack:$subdomain".takeIf(::isValidDest)
        else -> null
    }

    /** Local calendar day, so the cap resets at the owner's midnight. */
    fun localDay(now: Long, tz: TimeZone = TimeZone.getDefault()): Long =
        Math.floorDiv(now + tz.getOffset(now), 24L * 60L * 60L * 1000L)

    /** Drafts still allowed today. A clock moved back before the last count allows none. */
    fun remaining(entry: Entry, today: Long): Int = when {
        today < entry.day -> 0
        today > entry.day -> entry.cap
        else -> (entry.cap - entry.used).coerceAtLeast(0)
    }

    /**
     * Pure: which of [dests] (in order) may go now, and the entries after counting
     * them. A destination that is off, or out of drafts for today, is false.
     */
    fun allot(entries: List<Entry>, dests: List<String?>, today: Long): Pair<List<Entry>, BooleanArray> {
        val byDest = LinkedHashMap<String, Entry>()
        for (e in entries) byDest[e.dest] = e
        val mask = BooleanArray(dests.size)
        for ((i, dest) in dests.withIndex()) {
            val e = dest?.let { byDest[it] } ?: continue
            if (remaining(e, today) <= 0) continue
            val used = if (today == e.day) e.used else 0
            byDest[e.dest] = e.copy(day = today, used = used + 1)
            mask[i] = true
        }
        return Pair(byDest.values.toList(), mask)
    }

    fun encode(entries: List<Entry>): String {
        val arr = JSONArray()
        for (e in entries) {
            arr.put(
                JSONObject().put("dest", e.dest).put("cap", e.cap).put("enabledAt", e.enabledAt)
                    .put("day", e.day).put("used", e.used),
            )
        }
        return JSONObject().put("version", 1).put("entries", arr).toString()
    }

    /** Null when anything is off: an unknown version, a bad destination, a cap out of range. */
    fun decode(text: String): List<Entry>? {
        try {
            if (text.length > MAX_STATE_CHARS) return null
            val root = JSONObject(text)
            val arr = root.getJSONArray("entries")
            if (root.optInt("version") != 1 || arr.length() > MAX_ENTRIES) return null
            val out = ArrayList<Entry>()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val e = Entry(o.getString("dest"), o.getInt("cap"), o.getLong("enabledAt"), o.getLong("day"), o.getInt("used"))
                if (!isValidDest(e.dest) || e.cap !in 1..MAX_DAILY_CAP || e.used < 0) return null
                if (out.any { it.dest == e.dest }) return null
                out.add(e)
            }
            return out
        } catch (e: Exception) {
            return null
        }
    }

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

    /** Verified entries; empty when off or when anything fails to verify. Never throws. */
    @Synchronized
    fun read(context: Context): List<Entry> = try {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val state = prefs.getString(KEY_STATE, null)
        val stored = prefs.getString(KEY_MAC, null)
        val key = if (state != null && stored != null) existingKey() else null
        if (key == null || state == null || stored == null) {
            emptyList()
        } else if (!MessageDigest.isEqual(mac(key, state).toByteArray(Charsets.UTF_8), stored.toByteArray(Charsets.UTF_8))) {
            Log.w(TAG, "draft pre-approval state does not verify - treating as off")
            emptyList()
        } else {
            decode(state) ?: emptyList()
        }
    } catch (e: Exception) {
        Log.w(TAG, "draft pre-approval read failed - treating as off type=${e.javaClass.simpleName}")
        emptyList()
    }

    /** A fresh key for every write: no older copy of the prefs verifies after it. */
    private fun write(context: Context, entries: List<Entry>) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (entries.isEmpty()) {
            prefs.edit().remove(KEY_STATE).remove(KEY_MAC).commit()
            runCatching { keyStore().deleteEntry(KEY_ALIAS) }
                .onFailure { Log.w(TAG, "could not delete the pre-approval key type=${it.javaClass.simpleName}") }
            return
        }
        val state = encode(entries)
        val key = newKey()
        prefs.edit().putString(KEY_STATE, state).putString(KEY_MAC, mac(key, state)).commit()
    }

    /**
     * Only from the owner's typed chat words (see the class comment). Turns [dests]
     * on with [cap] drafts a day; a destination already on keeps today's count.
     */
    @Synchronized
    fun enable(context: Context, dests: List<String>, cap: Int, now: Long = System.currentTimeMillis()): List<Entry> {
        require(dests.isNotEmpty() && dests.all(::isValidDest)) { "invalid destination" }
        require(cap in 1..MAX_DAILY_CAP) { "invalid cap" }
        val byDest = LinkedHashMap<String, Entry>()
        for (e in read(context)) byDest[e.dest] = e
        val today = localDay(now)
        for (dest in dests.distinct()) {
            val old = byDest[dest]
            byDest[dest] = old?.copy(cap = cap) ?: Entry(dest, cap, now, today, 0)
        }
        require(byDest.size <= MAX_ENTRIES) { "too many destinations" }
        val entries = byDest.values.toList()
        write(context, entries)
        Log.i(TAG, "draft pre-approval on: ${dests.distinct().joinToString(",")} cap=$cap")
        return entries
    }

    /** OFF for [dests], or for everything when null. Safe from anywhere. */
    @Synchronized
    fun disable(context: Context, dests: List<String>?): List<Entry> {
        val current = try { read(context) } catch (e: Exception) { emptyList() }
        val left = if (dests == null) emptyList() else current.filter { it.dest !in dests }
        try {
            write(context, left)
        } catch (e: Exception) {
            // Could not re-key: drop everything rather than leave a destination on.
            Log.w(TAG, "pre-approval write failed while turning off - clearing type=${e.javaClass.simpleName}")
            write(context, emptyList())
            return emptyList()
        }
        Log.i(TAG, "draft pre-approval off: ${dests?.joinToString(",") ?: "all"}")
        return left
    }

    @Synchronized
    fun isOn(context: Context, dest: String?): Boolean = dest != null && read(context).any { it.dest == dest }

    /**
     * Counts the drafts that may go now against today's cap, and stores the count
     * before anything is sent. False for every draft when the count cannot be stored.
     */
    @Synchronized
    fun reserve(context: Context, dests: List<String?>, now: Long = System.currentTimeMillis()): BooleanArray {
        val entries = read(context)
        if (entries.isEmpty()) return BooleanArray(dests.size)
        val (next, mask) = allot(entries, dests, localDay(now))
        if (mask.none { it }) return mask
        return try {
            write(context, next)
            mask
        } catch (e: Exception) {
            Log.w(TAG, "pre-approval count not stored - asking instead type=${e.javaClass.simpleName}")
            BooleanArray(dests.size)
        }
    }

    /** For RN (Settings, chat replies). No secrets in here. */
    fun statusJson(context: Context, now: Long = System.currentTimeMillis()): String {
        val today = localDay(now)
        val arr = JSONArray()
        for (e in read(context)) {
            arr.put(
                JSONObject().put("dest", e.dest).put("cap", e.cap).put("enabledAt", e.enabledAt)
                    .put("usedToday", if (today == e.day) e.used else 0).put("remainingToday", remaining(e, today)),
            )
        }
        return JSONObject().put("entries", arr).toString()
    }

    /**
     * The module's `setDraftPreapproval`. [requests]: `note`, `substack` (the only
     * subdomain the destinations file lists) or `substack:<subdomain>` (must be listed
     * there). Returns `{ok, code, entries, subdomains?}`.
     */
    fun enableFromChat(context: Context, requests: List<String>, cap: Int): String {
        val out = JSONObject()
        val allowed = ClosePawDrafts.allowedSubdomains(context)
        val dests = ArrayList<String>()
        for (r in requests) {
            val dest = when {
                r == "note" -> "note"
                r == "substack" -> {
                    val list = allowed
                    when {
                        list == null || list.isEmpty() -> return out.put("ok", false).put("code", "no-substack").toString()
                        list.size > 1 -> return out.put("ok", false).put("code", "ambiguous-substack")
                            .put("subdomains", JSONArray(list)).toString()
                        else -> "substack:${list[0]}"
                    }
                }
                r.startsWith("substack:") -> {
                    val sub = r.removePrefix("substack:")
                    if (allowed == null || ClosePawDrafts.resolveSubdomain(sub, allowed) == null) {
                        return out.put("ok", false).put("code", "substack-not-allowed").put("subdomains", JSONArray(allowed.orEmpty())).toString()
                    }
                    "substack:$sub"
                }
                else -> return out.put("ok", false).put("code", "invalid").toString()
            }
            if (!isValidDest(dest)) return out.put("ok", false).put("code", "invalid").toString()
            dests.add(dest)
        }
        if (dests.isEmpty() || cap !in 1..MAX_DAILY_CAP) return out.put("ok", false).put("code", "invalid").toString()
        return try {
            enable(context, dests, cap)
            JSONObject(statusJson(context)).put("ok", true).put("code", "on").put("enabled", JSONArray(dests.distinct())).toString()
        } catch (e: Exception) {
            Log.w(TAG, "draft pre-approval enable failed type=${e.javaClass.simpleName}")
            out.put("ok", false).put("code", "failed").toString()
        }
    }
}
