package expo.modules.terminalemulator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

/**
 * Per-agent "ingress taint": the agent was created or changed by a request that
 * came in through Shelly's MCP server (DEFERRED.md P1 "MCP の入口（ingress）に
 * 外部入力の印（taint）を付ける", item 2). Inc 3 is storage only: nothing reads
 * [isTainted] to refuse anything yet.
 *
 * Storage: this app's SharedPreferences, MAC'd with a non-exportable Android
 * Keystore HMAC key, re-keyed on every write (the ClosePawDraftPreapproval /
 * CodexRemoteAutostart pattern), so restoring an older copy of the prefs (one
 * from before an agent was marked) never verifies again.
 *
 * Fail closed (owner decision 2026-11-14), unlike ClosePawDraftPreapproval
 * which fails to OFF: here "off" would mean "not tainted", the unsafe side.
 *  - no Keystore alias and no prefs  -> [Status.EMPTY]: fresh install, nothing tainted,
 *    but only while MCP has never been enabled. Callers pass `mcpEverEnabled`
 *    (RN: an MCP token exists in SecureStore; [mark] always passes true), and
 *    [seal] (MCPBridge.start) writes a verified empty state before the server
 *    first runs. With MCP ever enabled, "both missing" is [Status.UNREADABLE].
 *  - verified state                   -> [Status.OK]: tainted = listed agents.
 *  - anything else (alias without prefs, prefs without alias, half a blob, a MAC
 *    that does not verify, a state that does not decode, the Keystore throwing)
 *                                      -> [Status.UNREADABLE]: every agent is tainted.
 *  - more than [MAX_ENTRIES] marks    -> [Status.OVERFLOW]: sticky, every agent is
 *    tainted. Dropping the oldest entry would silently untaint an agent.
 * Deleting the prefs from the shell therefore taints everything instead of
 * clearing the marks. UNREADABLE / OVERFLOW stay until the owner calls [reset].
 * A prefs commit that fails sets an in-process flag that reads UNREADABLE at once
 * (SharedPreferencesImpl has already updated its memory copy), cleared only by a
 * successful [reset].
 *
 * Who may call what (enforced by later increments, not here):
 *  - [mark]: the MCP ingress path, whenever an MCP request creates or changes an agent.
 *  - [clear], [reset]: the owner only (typed chat / Settings), never the shell or a file.
 *  - [remove]: ONLY the owner's explicit agent-delete path. Never a sync,
 *    cleanup or reconcile step that reacts to a missing agent JSON: deleting the
 *    JSON from the shell would then untaint the agent when it is recreated.
 * None of these adds an approval prompt.
 *
 * Every mark / clear / remove / reset appends one `kind: "ingress_taint"` line to
 * the agent's audit file (`~/.shelly/agents/logs/<id>/agent-driver-audit.jsonl`,
 * or the deletion mirror `~/.shelly/agents/audits/<id>-agent-driver-audit.jsonl`
 * when the live directory is gone). The audit is informational; the prefs are
 * the truth, and an audit failure never undoes or blocks a write. Audit lines are
 * forgeable by anything running as this uid (the files are shell-writable) and
 * must NEVER be read to decide taint. The write checks that the parent directory
 * does not resolve through a link and opens the file O_NOFOLLOW; android.system.Os
 * has no openat, so a per-component O_DIRECTORY|O_NOFOLLOW walk is not done (a
 * race that swaps a directory for a link can redirect one JSON line, nothing more).
 *
 * Boundary, as for CodexRemoteAutostart: code running as this uid that can drive
 * AndroidKeyStore itself (an `app_process` with this APK on the classpath, or a
 * keystore2 deleteKey over binder) could write a verified state or delete the
 * alias. Deleting alias + prefs together only reaches EMPTY while MCP was never
 * enabled; after that it reads UNREADABLE. Residual: `mcpEverEnabled` comes from
 * the MCP token in SecureStore (also this uid's Keystore-backed prefs), so code
 * that can delete the alias, the prefs AND the SecureStore token entry can still
 * reach EMPTY. It then also removed the MCP token, so the server accepts nothing
 * until the owner re-enables MCP (MCPBridge.start seals again). Shell writes to
 * files alone cannot untaint.
 */
object AgentIngressTaint {
    private const val TAG = "AgentIngressTaint"
    private const val PREFS = "shelly_agent_ingress_taint"
    private const val KEY_STATE = "state"
    private const val KEY_MAC = "mac"
    private const val KEY_ALIAS = "shelly_agent_ingress_taint_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val DOMAIN = "shelly-agent-ingress-taint-v1:"
    private const val AUDIT_KIND = "ingress_taint"

    const val MAX_ENTRIES = 500
    private const val MAX_STATE_CHARS = 200_000
    val SOURCES: Set<String> = setOf("mcp")
    private val AGENT_ID_RE = Regex("^[A-Za-z0-9_-]{1,128}$")
    /** The MCP principal is a truncated token hash; nothing else (no names, no tokens) fits. */
    private val PRINCIPAL_RE = Regex("^[A-Za-z0-9_.:-]{0,64}$")

    enum class Status(val wire: String) { EMPTY("empty"), OK("ok"), UNREADABLE("unreadable"), OVERFLOW("overflow") }

    data class Entry(val agentId: String, val source: String, val principal: String, val at: Long)

    /** [overflow] is only meaningful with [Status.OK] state on disk; [Status.OVERFLOW] is derived from it. */
    data class Snapshot(val status: Status, val entries: List<Entry>, val overflow: Boolean = false) {
        /** Fail closed: anything but a verified, non-overflowing state taints every agent. */
        fun isTainted(agentId: String): Boolean = when (status) {
            Status.EMPTY -> false
            Status.OK -> entries.any { it.agentId == agentId }
            Status.UNREADABLE, Status.OVERFLOW -> true
        }
    }

    fun isValidAgentId(agentId: String): Boolean = AGENT_ID_RE.matches(agentId)
    fun isValidSource(source: String): Boolean = source in SOURCES
    fun isValidPrincipal(principal: String): Boolean = PRINCIPAL_RE.matches(principal)

    // ---- pure: encode / decode / verify / transitions ---------------------------------

    fun encode(entries: List<Entry>, overflow: Boolean): String {
        val arr = JSONArray()
        for (e in entries) {
            arr.put(JSONObject().put("agentId", e.agentId).put("source", e.source).put("principal", e.principal).put("at", e.at))
        }
        return JSONObject().put("version", 1).put("overflow", overflow).put("entries", arr).toString()
    }

    /** Null when anything is off: unknown version, bad id/source/principal, duplicates, too many. */
    fun decode(text: String): Pair<List<Entry>, Boolean>? {
        try {
            if (text.length > MAX_STATE_CHARS) return null
            val root = JSONObject(text)
            if (root.optInt("version") != 1) return null
            val overflowRaw = root.opt("overflow")
            if (overflowRaw !is Boolean) return null
            val arr = root.getJSONArray("entries")
            if (arr.length() > MAX_ENTRIES) return null
            val out = ArrayList<Entry>()
            val seen = HashSet<String>()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val e = Entry(o.getString("agentId"), o.getString("source"), o.getString("principal"), o.getLong("at"))
                if (!isValidAgentId(e.agentId) || !isValidSource(e.source) || !isValidPrincipal(e.principal)) return null
                if (!seen.add(e.agentId)) return null
                out.add(e)
            }
            return Pair(out, overflowRaw)
        } catch (e: Exception) {
            return null
        }
    }

    /** Hex MAC over the domain-separated state; [hmac] is the keyed function. */
    fun macOf(state: String, hmac: (ByteArray) -> ByteArray): String =
        hmac("$DOMAIN$state".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    /**
     * Pure classification of what is on disk. [hasAlias]: the Keystore alias exists.
     * [expectedMac]: the MAC of [state] under that key, or null when it could not be
     * computed. Any partial or unverifiable combination is UNREADABLE.
     */
    fun classify(hasAlias: Boolean, state: String?, storedMac: String?, expectedMac: String?, mcpEverEnabled: Boolean = false): Snapshot {
        if (!hasAlias && state == null && storedMac == null) {
            return Snapshot(if (mcpEverEnabled) Status.UNREADABLE else Status.EMPTY, emptyList())
        }
        if (!hasAlias || state == null || storedMac == null || expectedMac == null) return Snapshot(Status.UNREADABLE, emptyList())
        if (!MessageDigest.isEqual(expectedMac.toByteArray(Charsets.UTF_8), storedMac.toByteArray(Charsets.UTF_8))) {
            return Snapshot(Status.UNREADABLE, emptyList())
        }
        val (entries, overflow) = decode(state) ?: return Snapshot(Status.UNREADABLE, emptyList())
        return Snapshot(if (overflow) Status.OVERFLOW else Status.OK, entries, overflow)
    }

    /**
     * Pure: the state after marking. Null when the current state cannot be written
     * over (UNREADABLE stays UNREADABLE until [reset]). A mark on an agent already
     * listed keeps its first `at` and records the latest principal. Past
     * [MAX_ENTRIES] the state becomes sticky overflow instead of evicting.
     */
    fun afterMark(current: Snapshot, entry: Entry): Pair<List<Entry>, Boolean>? {
        if (current.status == Status.UNREADABLE) return null
        val list = ArrayList(current.entries)
        val i = list.indexOfFirst { it.agentId == entry.agentId }
        if (i >= 0) {
            list[i] = list[i].copy(principal = entry.principal, source = entry.source)
            return Pair(list, current.overflow)
        }
        if (list.size >= MAX_ENTRIES) return Pair(list, true)
        list.add(entry)
        return Pair(list, current.overflow)
    }

    /** Pure: the state without [agentId]. Null when UNREADABLE (nothing trustworthy to remove from). */
    fun afterDrop(current: Snapshot, agentId: String): Pair<List<Entry>, Boolean>? {
        if (current.status == Status.UNREADABLE) return null
        return Pair(current.entries.filter { it.agentId != agentId }, current.overflow)
    }

    // ---- Keystore / prefs --------------------------------------------------------------

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun newKey(): SecretKey {
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE)
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN).build())
        return generator.generateKey()
    }

    private fun mac(key: SecretKey, state: String): String {
        val m = Mac.getInstance("HmacSHA256")
        m.init(key)
        return macOf(state) { m.doFinal(it) }
    }

    /** Set when a prefs commit fails; reads as UNREADABLE until a successful [reset]. */
    @Volatile
    private var poisoned = false

    /** Never throws; a Keystore or prefs failure reads as UNREADABLE (fail closed). */
    @Synchronized
    fun snapshot(context: Context, mcpEverEnabled: Boolean = false): Snapshot = if (poisoned) {
        Snapshot(Status.UNREADABLE, emptyList())
    } else try {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val state = prefs.getString(KEY_STATE, null)
        val stored = prefs.getString(KEY_MAC, null)
        val ks = keyStore()
        val hasAlias = ks.containsAlias(KEY_ALIAS)
        val key = if (hasAlias) ks.getKey(KEY_ALIAS, null) as? SecretKey else null
        val expected = if (key != null && state != null) mac(key, state) else null
        classify(hasAlias, state, stored, expected, mcpEverEnabled).also {
            if (it.status == Status.UNREADABLE) Log.w(TAG, "ingress taint state unreadable - every agent is treated as tainted")
        }
    } catch (e: Exception) {
        Log.w(TAG, "ingress taint read failed - every agent is treated as tainted type=${e.javaClass.simpleName}")
        Snapshot(Status.UNREADABLE, emptyList())
    }

    /** A fresh key for every write: no older copy of the prefs verifies after it. Throws on failure. */
    private fun write(context: Context, entries: List<Entry>, overflow: Boolean) {
        val state = encode(entries, overflow)
        val key = newKey()
        val ok = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_STATE, state).putString(KEY_MAC, mac(key, state)).commit()
        if (!ok) {
            // The in-memory prefs already hold the new state under the new key, so
            // without this a failed write would read as applied until restart.
            poisoned = true
            throw IllegalStateException("prefs commit failed")
        }
    }

    // ---- API ---------------------------------------------------------------------------

    /**
     * Marks [agentId] as changed through [source] (`mcp`). Returns the status after
     * the call. If the state is UNREADABLE nothing is written (every agent is already
     * tainted). If the write fails the old key is gone, so the state reads UNREADABLE:
     * the failure also fails closed.
     */
    @Synchronized
    fun mark(context: Context, agentId: String, source: String, principal: String, now: Long = System.currentTimeMillis()): Status {
        require(isValidAgentId(agentId)) { "invalid agent id" }
        require(isValidSource(source)) { "invalid source" }
        require(isValidPrincipal(principal)) { "invalid principal" }
        val current = snapshot(context, mcpEverEnabled = true)
        val next = afterMark(current, Entry(agentId, source, principal, now))
        if (next != null) {
            try {
                write(context, next.first, next.second)
            } catch (e: Exception) {
                Log.w(TAG, "ingress taint mark not stored - state now fails closed type=${e.javaClass.simpleName}")
            }
        }
        audit(context, "mark", agentId, source, principal)
        return snapshot(context, mcpEverEnabled = true).status
    }

    @Synchronized
    fun isTainted(context: Context, agentId: String, mcpEverEnabled: Boolean): Boolean =
        snapshot(context, mcpEverEnabled).isTainted(agentId)

    /** Owner action: the agent is trusted again. No effect while UNREADABLE (use [reset]). */
    @Synchronized
    fun clear(context: Context, agentId: String, mcpEverEnabled: Boolean): Status =
        drop(context, agentId, "clear", mcpEverEnabled)

    /**
     * The agent was deleted. ONLY from the owner's explicit agent-delete path.
     * Never from a sync, cleanup or reconcile step that reacts to a missing agent
     * JSON: the shell can delete that JSON, and an agent recreated under the same
     * id would then be untainted. No effect while UNREADABLE.
     */
    @Synchronized
    fun remove(context: Context, agentId: String, mcpEverEnabled: Boolean): Status =
        drop(context, agentId, "remove", mcpEverEnabled)

    private fun drop(context: Context, agentId: String, action: String, mcpEverEnabled: Boolean): Status {
        require(isValidAgentId(agentId)) { "invalid agent id" }
        val current = snapshot(context, mcpEverEnabled)
        val had = current.entries.firstOrNull { it.agentId == agentId }
        val next = afterDrop(current, agentId)
        if (next != null && had != null) {
            try {
                write(context, next.first, next.second)
            } catch (e: Exception) {
                Log.w(TAG, "ingress taint $action not stored type=${e.javaClass.simpleName}")
            }
        }
        // Agent deletion calls remove for every agent; only log it when it mattered.
        if (action != "remove" || had != null || current.status == Status.UNREADABLE || current.status == Status.OVERFLOW) {
            audit(context, action, agentId, had?.source ?: "", "")
        }
        return snapshot(context, mcpEverEnabled).status
    }

    /**
     * Owner action only: forget every mark and the overflow flag, and start a fresh
     * verified state. The way out of UNREADABLE / OVERFLOW; the owner accepts that
     * marks that could not be read are lost.
     */
    @Synchronized
    fun reset(context: Context): Status {
        val before = snapshot(context, mcpEverEnabled = true).status
        try {
            poisoned = false
            write(context, emptyList(), false)
        } catch (e: Exception) {
            Log.w(TAG, "ingress taint reset not stored type=${e.javaClass.simpleName}")
        }
        audit(context, "reset", null, "", "", extra = before.wire)
        return snapshot(context, mcpEverEnabled = true).status
    }

    /**
     * Called by MCPBridge.start before the server runs: turns a fresh-install EMPTY
     * into a verified empty state, so deleting the prefs and the alias afterwards
     * reads UNREADABLE even where `mcpEverEnabled` is not known. No-op otherwise.
     */
    @Synchronized
    fun seal(context: Context): Status {
        if (snapshot(context, mcpEverEnabled = false).status == Status.EMPTY) {
            try {
                write(context, emptyList(), false)
                audit(context, "seal", null, "", "")
            } catch (e: Exception) {
                Log.w(TAG, "ingress taint seal not stored type=${e.javaClass.simpleName}")
            }
        }
        return snapshot(context, mcpEverEnabled = true).status
    }

    @Synchronized
    fun list(context: Context, mcpEverEnabled: Boolean): List<Entry> = snapshot(context, mcpEverEnabled).entries

    fun status(context: Context, mcpEverEnabled: Boolean): Status = snapshot(context, mcpEverEnabled).status

    /** For RN: `{status, overflow, entries: [{agentId, source, principal, at}]}`. No secrets. */
    fun statusJson(context: Context, mcpEverEnabled: Boolean): String {
        val s = snapshot(context, mcpEverEnabled)
        val arr = JSONArray()
        for (e in s.entries) {
            arr.put(JSONObject().put("agentId", e.agentId).put("source", e.source).put("principal", e.principal).put("at", e.at))
        }
        return JSONObject().put("status", s.status.wire).put("overflow", s.overflow).put("entries", arr).toString()
    }

    // ---- audit -------------------------------------------------------------------------

    fun auditLine(ts: Long, action: String, agentId: String?, source: String, principal: String, extra: String? = null): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        val o = JSONObject().put("ts", fmt.format(Date(ts))).put("kind", AUDIT_KIND).put("action", action)
        if (agentId != null) o.put("agentId", agentId)
        if (source.isNotEmpty()) o.put("source", source)
        if (principal.isNotEmpty()) o.put("principal", principal)
        if (extra != null) o.put("statusBefore", extra)
        return o.toString()
    }

    /**
     * Appends one line, best effort. The live per-agent file if `logs/<id>/` exists,
     * otherwise the deletion mirror under `audits/` (never re-creates a deleted
     * agent's log directory). Reset (no agent) goes to `audits/ingress-taint-audit.jsonl`.
     * The parent must resolve to itself under the canonical home (no symlinked
     * directory), and the file is opened O_NOFOLLOW.
     */
    private fun audit(context: Context, action: String, agentId: String?, source: String, principal: String, extra: String? = null) {
        try {
            val home = File(context.filesDir, "home").canonicalFile
            val agentsDir = File(home, ".shelly/agents")
            if (!agentsDir.isDirectory) return
            val liveDir = agentId?.let { File(agentsDir, "logs/$it") }
            val target = if (liveDir != null && liveDir.isDirectory) {
                File(liveDir, "agent-driver-audit.jsonl")
            } else {
                val audits = File(agentsDir, "audits")
                if (!audits.isDirectory && !audits.mkdirs()) return
                File(audits, if (agentId != null) "$agentId-agent-driver-audit.jsonl" else "ingress-taint-audit.jsonl")
            }
            val parent = target.parentFile ?: return
            if (parent.canonicalFile.path != parent.absoluteFile.path) {
                Log.w(TAG, "audit directory is a link - skipped")
                return
            }
            val flags = OsConstants.O_WRONLY or OsConstants.O_APPEND or OsConstants.O_CREAT or
                OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC
            val fd = Os.open(target.path, flags, 384 /* 0600 */)
            FileOutputStream(fd).use { out ->
                out.write((auditLine(System.currentTimeMillis(), action, agentId, source, principal, extra) + "\n").toByteArray(Charsets.UTF_8))
            }
        } catch (e: Exception) {
            Log.w(TAG, "ingress taint audit line not written type=${e.javaClass.simpleName}")
        }
    }
}
