package expo.modules.terminalemulator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.Os
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

/**
 * The persistent, fail-closed journal of MCP commands native ran headless
 * (McpRawToolConsumer, "MCP: Run without approval") — the native counterpart
 * of the window half of lib/mcp-ingress-origin.ts. Purpose: a `shelly agent
 * add` / `confirm` request written by such a command is MCP-originated (so the
 * agent created from it is marked tainted, and the "Skip all approvals" switch
 * never auto-approves it), even if Shelly's process dies before RN drains it.
 *
 * Journal (pure state: [McpIngressJournalCore]):
 *  - a window {callId, principal, start, end|null, owner, before[]} is written
 *    BEFORE the command starts (a failed write refuses the command); `before`
 *    is the set of agent request ids that existed then;
 *  - when the command ends, the ids that appeared (now − before) are recorded
 *    as MCP-originated requests and the window gets its `end`;
 *  - a window still open whose owner is not a command running in THIS process
 *    (the process died mid-command) is recovered on the next read: every id on
 *    disk that is not in its `before` is recorded, and it is closed.
 * RN pulls the verified journal before it classifies agent requests
 * (lib/mcp-native-ingress.ts), so the marks survive a restart.
 *
 * Storage: `noBackupFilesDir/mcp-ingress-journal.json` (outside $HOME, not
 * backed up) as {state, mac}, the MAC from a non-exportable Android Keystore
 * HMAC key that is re-created on every write (the AgentIngressTaint pattern),
 * so an older copy of the file never verifies again.
 *
 * Fail closed:
 *  - file missing while the key exists, key missing while the file exists, a
 *    MAC that does not verify, a state that does not decode: INVALID. The next
 *    read repairs it by recording EVERY agent request id currently on disk
 *    (req / pending / ctl / claim) as MCP-originated and writing a fresh state.
 *    Requests created after the repair are judged normally again.
 *  - a read or repair that cannot complete reports `ok:false`; RN then treats
 *    every agent request it drains as MCP-originated.
 *  - a recorded request is never dropped before it is [McpIngressJournalCore.RETAIN_MS]
 *    old (no count cap on requests: dropping one would untaint it); only
 *    CLOSED windows past RN's grace are trimmed beyond MAX_WINDOWS (their
 *    appeared requests are already recorded).
 * Retention: entries are kept [RETAIN_MS] (24 h). An agent request is valid
 * for 10 minutes (AGENT_ADD_MAX_AGE_MS) and RN marks the agent (AgentIngressTaint)
 * when it is confirmed, so an entry is never dropped while its request can
 * still be used.
 *
 * Boundary as AgentIngressTaint: code that can drive AndroidKeyStore itself
 * could write a valid state; shell file edits cannot drop a mark.
 */
object McpNativeIngress {
    private const val TAG = "McpNativeIngress"
    private const val FILE = "mcp-ingress-journal.json"
    private const val KEY_ALIAS = "shelly_mcp_ingress_journal_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val DOMAIN = "shelly-mcp-ingress-journal-v1:"

    /** Unique per process: a window whose owner differs belongs to a dead process. */
    val processOwner: String = ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    /** callIds of commands running in this process right now. */
    private val running = HashSet<String>()

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun newKey(): SecretKey {
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE)
        g.init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN).build())
        return g.generateKey()
    }

    private fun mac(key: SecretKey, state: String): String {
        val m = Mac.getInstance("HmacSHA256")
        m.init(key)
        return m.doFinal("$DOMAIN$state".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    private fun file(context: Context): File = File(context.applicationContext.noBackupFilesDir, FILE)

    /** The verified state, or null when INVALID. Throws on a Keystore failure. */
    private fun load(context: Context): McpIngressJournalCore.State? {
        val f = file(context)
        val ks = keyStore()
        val hasKey = ks.containsAlias(KEY_ALIAS)
        val exists = try { Os.lstat(f.path); true } catch (e: Exception) { false }
        if (!exists && !hasKey) return McpIngressJournalCore.State() // fresh install
        if (!exists || !hasKey) return null
        val outer = try { JSONObject(f.readText(Charsets.UTF_8)) } catch (e: Exception) { return null }
        val state = outer.opt("state") as? String ?: return null
        val stored = outer.opt("mac") as? String ?: return null
        val key = ks.getKey(KEY_ALIAS, null) as? SecretKey ?: return null
        if (!MessageDigest.isEqual(mac(key, state).toByteArray(Charsets.US_ASCII), stored.toByteArray(Charsets.US_ASCII))) return null
        return McpIngressJournalCore.decode(state)
    }

    /** New key, then tmp + rename. Throws on failure (callers fail closed). */
    private fun store(context: Context, s: McpIngressJournalCore.State) {
        val state = McpIngressJournalCore.encode(s)
        val key = newKey()
        val f = file(context)
        f.parentFile?.mkdirs()
        val tmp = File(f.parentFile, "$FILE.tmp")
        FileOutputStream(tmp).use {
            it.write(JSONObject().put("state", state).put("mac", mac(key, state)).toString().toByteArray(Charsets.UTF_8))
            it.fd.sync()
        }
        Os.rename(tmp.path, f.path)
    }

    private fun idsOnDisk(home: File): Set<String>? = McpRawToolDecision.agentRequestIds(runCatching { home.list() }.getOrNull())

    /** Load, repair if INVALID, recover dead windows, prune. Null when it cannot be made valid. */
    private fun current(context: Context, nowMs: Long): McpIngressJournalCore.State? {
        val home = HomeInitializer.getHomeDir(context)
        var s = load(context)
        var dirty = false
        if (s == null) {
            val ids = idsOnDisk(home) ?: return null
            Log.w(TAG, "ingress journal invalid; every agent request on disk is treated as MCP-originated")
            s = McpIngressJournalCore.repair(ids, nowMs)
            dirty = true
        }
        val stale = s.windows.any { it.end == null && !(it.owner == processOwner && it.callId in running) }
        if (stale) {
            val ids = idsOnDisk(home) ?: return null
            s = McpIngressJournalCore.recover(s, ids, { w -> w.owner == processOwner && w.callId in running }, nowMs)
            dirty = true
        }
        val pruned = McpIngressJournalCore.prune(s, nowMs)
        if (pruned != s) { s = pruned; dirty = true }
        if (dirty) store(context, s)
        return s
    }

    /** Before a headless command runs. False ⇒ the command must not run. */
    @Synchronized
    fun openWindow(context: Context, callId: String, principal: String, before: Set<String>, nowMs: Long = System.currentTimeMillis()): Boolean = try {
        val s = current(context, nowMs) ?: throw IllegalStateException("journal")
        store(context, McpIngressJournalCore.open(s, callId, principal, before, processOwner, nowMs))
        running.add(McpRawToolDecision.safeIngressValue(callId))
        true
    } catch (e: Exception) {
        Log.w(TAG, "ingress window not recorded type=${e.javaClass.simpleName}; command refused")
        false
    }

    /** After the command (any outcome). [after] null ⇒ left open, recovered on the next read. */
    @Synchronized
    fun closeWindow(context: Context, callId: String, after: Set<String>?, nowMs: Long = System.currentTimeMillis()) {
        val id = McpRawToolDecision.safeIngressValue(callId)
        try {
            if (after == null) return
            val s = current(context, nowMs) ?: return
            store(context, McpIngressJournalCore.close(s, id, after, nowMs))
        } catch (e: Exception) {
            Log.w(TAG, "ingress window not closed type=${e.javaClass.simpleName} (recovered on the next read)")
        } finally {
            running.remove(id)
        }
    }

    /** For RN (getMcpNativeIngress): the verified journal, or {ok:false} (RN then taints every request). */
    @Synchronized
    fun snapshotJson(context: Context, nowMs: Long = System.currentTimeMillis()): String = try {
        val s = current(context, nowMs)
        if (s == null) JSONObject().put("ok", false).toString() else McpIngressJournalCore.forRn(s)
    } catch (e: Exception) {
        Log.w(TAG, "ingress journal unreadable type=${e.javaClass.simpleName}")
        JSONObject().put("ok", false).toString()
    }
}

/** The pure journal state and its transitions (JVM-tested, McpIngressJournalCoreTest). */
object McpIngressJournalCore {
    const val RETAIN_MS = 24 * 60 * 60 * 1000L
    /** RN's window grace (lib/mcp-ingress-origin.ts MCP_WINDOW_GRACE_MS). KEEP IN SYNC. */
    const val GRACE_MS = 60_000L
    const val MAX_WINDOWS = 64

    data class Window(val callId: String, val principal: String, val start: Long, val end: Long?, val owner: String, val before: Set<String>)
    data class Req(val reqId: String, val callId: String, val principal: String, val at: Long)
    data class State(val windows: List<Window> = emptyList(), val requests: List<Req> = emptyList())

    fun open(s: State, callId: String, principal: String, before: Set<String>, owner: String, now: Long): State =
        capped(s.copy(windows = s.windows + Window(McpRawToolDecision.safeIngressValue(callId), McpRawToolDecision.safeIngressValue(principal), now, null, owner, before)), now)

    private fun record(reqs: List<Req>, ids: Collection<String>, w: Window, now: Long): List<Req> {
        val have = reqs.map { it.reqId }.toHashSet()
        return reqs + ids.filter { it !in have }.sorted().map { Req(it, w.callId, w.principal, now) }
    }

    /** The command ended: ids not in `before` are MCP-originated; the window gets its end. */
    fun close(s: State, callId: String, after: Set<String>, now: Long): State {
        var reqs = s.requests
        val ws = s.windows.map { w ->
            if (w.callId == callId && w.end == null) {
                reqs = record(reqs, after - w.before, w, now)
                w.copy(end = now)
            } else {
                w
            }
        }
        return capped(State(ws, reqs), now)
    }

    /** Open windows that are not running ([live] false): recorded against [onDisk] and closed. */
    fun recover(s: State, onDisk: Set<String>, live: (Window) -> Boolean, now: Long): State {
        var reqs = s.requests
        val ws = s.windows.map { w ->
            if (w.end == null && !live(w)) {
                reqs = record(reqs, onDisk - w.before, w, now)
                w.copy(end = now)
            } else {
                w
            }
        }
        return capped(State(ws, reqs), now)
    }

    /** INVALID journal: every id on disk becomes MCP-originated (principal / callId unknown). */
    fun repair(onDisk: Set<String>, now: Long): State {
        val w = Window("unknown", "unknown", now, now, "repair", emptySet())
        return capped(State(emptyList(), record(emptyList(), onDisk, w, now)), now)
    }

    /** Drops what is older than [RETAIN_MS] (closed windows by their end, requests by when recorded). */
    fun prune(s: State, now: Long): State =
        State(s.windows.filter { it.end == null || now - it.end <= RETAIN_MS }, s.requests.filter { now - it.at <= RETAIN_MS })

    /** Trims the oldest closed windows past RN's grace beyond [MAX_WINDOWS]. Requests are never trimmed. */
    private fun capped(s: State, now: Long): State {
        var ws = s.windows
        while (ws.size > MAX_WINDOWS) {
            val i = ws.indexOfFirst { it.end != null && now - it.end > GRACE_MS }
            if (i < 0) break
            ws = ws.filterIndexed { j, _ -> j != i }
        }
        return State(ws, s.requests)
    }

    fun encode(s: State): String {
        val ws = JSONArray()
        for (w in s.windows) {
            ws.put(JSONObject().put("callId", w.callId).put("principal", w.principal).put("start", w.start)
                .put("end", w.end ?: JSONObject.NULL).put("owner", w.owner).put("before", JSONArray(w.before.sorted())))
        }
        val rs = JSONArray()
        for (r in s.requests) rs.put(JSONObject().put("reqId", r.reqId).put("callId", r.callId).put("principal", r.principal).put("at", r.at))
        return JSONObject().put("v", 1).put("windows", ws).put("requests", rs).toString()
    }

    /** Strict; null when anything is off (the caller treats that as INVALID). */
    fun decode(text: String): State? = try {
        val o = JSONObject(text)
        if (o.opt("v") != 1) throw IllegalArgumentException()
        val wa = o.getJSONArray("windows")
        val ws = (0 until wa.length()).map { i ->
            val w = wa.getJSONObject(i)
            val b = w.getJSONArray("before")
            Window(
                w.getString("callId"), w.getString("principal"), w.getLong("start"),
                if (w.isNull("end")) null else w.getLong("end"), w.getString("owner"),
                (0 until b.length()).map { b.getString(it) }.toSet(),
            )
        }
        val ra = o.getJSONArray("requests")
        val rs = (0 until ra.length()).map { i ->
            val r = ra.getJSONObject(i)
            Req(r.getString("reqId"), r.getString("callId"), r.getString("principal"), r.getLong("at"))
        }
        State(ws, rs)
    } catch (e: Exception) {
        null
    }

    /** {ok, windows:[{callId,principal,start,end|null}], requests:[{reqId,callId,principal}]}. */
    fun forRn(s: State): String {
        val ws = JSONArray()
        for (w in s.windows) ws.put(JSONObject().put("callId", w.callId).put("principal", w.principal).put("start", w.start).put("end", w.end ?: JSONObject.NULL))
        val rs = JSONArray()
        for (r in s.requests) rs.put(JSONObject().put("reqId", r.reqId).put("callId", r.callId).put("principal", r.principal))
        return JSONObject().put("ok", true).put("windows", ws).put("requests", rs).toString()
    }
}
