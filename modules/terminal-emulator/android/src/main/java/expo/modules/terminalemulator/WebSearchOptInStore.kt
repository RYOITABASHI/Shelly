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
 * "Web search on notification-triggered runs", per article pipeline (search
 * parity, executor v68).
 *
 * A notification-triggered run is tainted (`SHELLY_CAP_TAINTED=1`): the
 * executor refuses the research step's hosted web search on it unless
 * `SHELLY_WEB_SEARCH_OPT_IN_SHA256` equals the definition hash the executor
 * computes for the plan at run start. This store keeps, per agent, the
 * definition hash the owner turned on, and [AgentRuntime] exports it to that
 * agent's tainted PlanSpec runs only (never on MCP ingress, never untainted).
 * Any edit to the pipeline definition changes the hash, so the consent lapses
 * by itself: Settings shows "lapsed" and the executor refuses the search.
 *
 * The hash stored is always the one native computed itself, by running the
 * executor's read-only `--web-search-opt-in-candidates` op
 * ([AgentRuntime.webSearchOptInCandidatesOutput]); the value RN passes in is
 * only checked against it (the plan the owner saw listed must be the plan that
 * is turned on).
 *
 * Who can turn it on: only [setFromSettings] with enabled=true, called only by
 * TerminalEmulatorModule's `setWebSearchOptIn`, which RN calls only from the
 * owner's Settings toggle (lib/web-search-opt-in.ts). There is no MCP op, shell
 * command, file, env or agent-writable path that reaches it, and the executor
 * never calls into native. OFF is safe from anywhere.
 *
 * Storage: this app's SharedPreferences, MAC'd with a non-exportable Android
 * Keystore HMAC key (the ClosePawDraftPreapproval / CodexRemoteAutostart
 * pattern). Every write makes a NEW key, so an older copy of the prefs never
 * verifies again. Anything that does not verify reads as OFF, with no entries.
 *
 * Boundary, as for ClosePawDraftPreapproval: code running as this uid that can
 * drive AndroidKeyStore itself (an `app_process` with this APK on the
 * classpath) could call [enable]. Shell writes to files cannot. The hash comes
 * from `$HOME/.shelly-plan-executor.js` (re-extracted from the APK by
 * HomeInitializer; its version must be the one AgentRuntime expects); code that
 * can rewrite that file controls the run itself anyway.
 */
object WebSearchOptInStore {
    private const val TAG = "WebSearchOptInStore"
    private const val PREFS = "shelly_web_search_opt_in"
    private const val KEY_STATE = "state"
    private const val KEY_MAC = "mac"
    private const val KEY_ALIAS = "shelly_web_search_opt_in_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val DOMAIN = "shelly-web-search-opt-in-v1:"

    const val ENV_NAME = "SHELLY_WEB_SEARCH_OPT_IN_SHA256"
    const val AUDIT_KIND = "web_search_opt_in"
    private const val AUDIT_FILE = "plan-executor-audit.jsonl"
    private const val MAX_ENTRIES = 64
    private const val MAX_STATE_CHARS = 16 * 1024
    private const val MAX_CANDIDATES = 256
    private const val MAX_CANDIDATES_CHARS = 256 * 1024
    private const val MAX_NAME_CHARS = 120

    // Same agent-id rule as IngressAuditWriter and the executor's
    // `plan-agent-<id>.json` match.
    private val AGENT_ID_RE = Regex("^[A-Za-z0-9_-]{1,128}$")
    private val SHA256_RE = Regex("^[0-9a-f]{64}$")
    private val PIPELINE_ID_RE = Regex("^[a-z0-9-]{1,32}$")
    private val CONTROL_RE = Regex("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]")

    data class Entry(val agentId: String, val sha256: String, val enabledAt: Long)

    data class Candidate(
        val agentId: String,
        val name: String?,
        val pipelineId: String?,
        val definitionSha256: String,
        val webSearchStep: Boolean,
    )

    fun isValidAgentId(id: String?): Boolean = id != null && AGENT_ID_RE.matches(id)

    fun isValidSha256(sha: String?): Boolean = sha != null && SHA256_RE.matches(sha)

    // ---- Pure ------------------------------------------------------------------

    fun encode(entries: List<Entry>): String {
        val arr = JSONArray()
        for (e in entries) {
            arr.put(JSONObject().put("agentId", e.agentId).put("sha256", e.sha256).put("enabledAt", e.enabledAt))
        }
        return JSONObject().put("version", 1).put("entries", arr).toString()
    }

    /** Null when anything is off: an unknown version, a bad id or hash, a duplicate. */
    fun decode(text: String): List<Entry>? {
        try {
            if (text.length > MAX_STATE_CHARS) return null
            val root = JSONObject(text)
            val arr = root.getJSONArray("entries")
            if (root.optInt("version") != 1 || arr.length() > MAX_ENTRIES) return null
            val out = ArrayList<Entry>()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                val agentId = o.get("agentId") as? String ?: return null
                val sha = o.get("sha256") as? String ?: return null
                val e = Entry(agentId, sha, o.getLong("enabledAt"))
                if (!isValidAgentId(e.agentId) || !isValidSha256(e.sha256)) return null
                if (out.any { it.agentId == e.agentId }) return null
                out.add(e)
            }
            return out
        } catch (e: Exception) {
            return null
        }
    }

    /**
     * The executor's `--web-search-opt-in-candidates` stdout:
     * `{"pipelines":[{agentId, name, pipelineId, definitionSha256, webSearchStep}]}`.
     * Null when the output is not that shape, an entry has a bad agent id, hash
     * or webSearchStep, or an agent id repeats. A name or pipeline id that is
     * not a plain short string is shown as null (display only).
     */
    fun parseCandidates(stdout: String?): List<Candidate>? {
        try {
            val text = stdout?.trim() ?: return null
            if (text.isEmpty() || text.length > MAX_CANDIDATES_CHARS || text.contains('\n')) return null
            val root = JSONObject(text)
            val arr = root.get("pipelines") as? JSONArray ?: return null
            if (arr.length() > MAX_CANDIDATES) return null
            val out = ArrayList<Candidate>()
            for (i in 0 until arr.length()) {
                val o = arr.get(i) as? JSONObject ?: return null
                val agentId = o.opt("agentId") as? String ?: return null
                val sha = o.opt("definitionSha256") as? String ?: return null
                val webSearchStep = o.opt("webSearchStep") as? Boolean ?: return null
                if (!isValidAgentId(agentId) || !isValidSha256(sha)) return null
                if (out.any { it.agentId == agentId }) return null
                val name = (o.opt("name") as? String)
                    ?.takeIf { it.isNotBlank() && it.length <= MAX_NAME_CHARS && !CONTROL_RE.containsMatchIn(it) }
                val pipelineId = (o.opt("pipelineId") as? String)?.takeIf { PIPELINE_ID_RE.matches(it) }
                out.add(Candidate(agentId, name, pipelineId, sha, webSearchStep))
            }
            return out
        } catch (e: Exception) {
            return null
        }
    }

    /** "on" | "off" | "lapsed" (stored hash is not the current one: treated as off). */
    fun stateOf(entry: Entry?, candidate: Candidate?): String = when {
        entry == null -> "off"
        candidate == null || !candidate.webSearchStep || candidate.definitionSha256 != entry.sha256 -> "lapsed"
        else -> "on"
    }

    /**
     * The PlanSpec executor launch exports: only for a tainted run
     * (notification-triggered), never on MCP ingress ([ingressReason] set), and
     * only for a well-formed stored hash. Empty otherwise.
     */
    fun launchExports(tainted: Boolean, ingressReason: String?, storedSha256: String?): String {
        if (!tainted || ingressReason != null || !isValidSha256(storedSha256)) return ""
        return " && export $ENV_NAME=$storedSha256 && readonly $ENV_NAME"
    }

    private fun isoUtc(ts: Long): String {
        val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        return fmt.format(Date(ts))
    }

    /** One audit line: fixed fields only, the hash cut to 16 hex. Null when a field is off. */
    fun buildAuditLine(ts: Long, event: String, agentId: String, sha256: String?): String? {
        if (event != "enabled" && event != "disabled") return null
        if (!isValidAgentId(agentId)) return null
        if (sha256 != null && !isValidSha256(sha256)) return null
        return try {
            val out = JSONObject().put("ts", isoUtc(ts)).put("kind", AUDIT_KIND).put("event", event).put("agentId", agentId)
            if (sha256 != null) out.put("definitionSha256", sha256.substring(0, 16))
            out.put("source", "settings").toString()
        } catch (e: Exception) {
            null
        }
    }

    // ---- Keystore-sealed prefs ---------------------------------------------------

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
            Log.w(TAG, "web search opt-in state does not verify - treating as off")
            emptyList()
        } else {
            decode(state) ?: emptyList()
        }
    } catch (e: Exception) {
        Log.w(TAG, "web search opt-in read failed - treating as off type=${e.javaClass.simpleName}")
        emptyList()
    }

    /** A fresh key for every write: no older copy of the prefs verifies after it. */
    private fun write(context: Context, entries: List<Entry>) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (entries.isEmpty()) {
            prefs.edit().remove(KEY_STATE).remove(KEY_MAC).commit()
            runCatching { keyStore().deleteEntry(KEY_ALIAS) }
                .onFailure { Log.w(TAG, "could not delete the opt-in key type=${it.javaClass.simpleName}") }
            return
        }
        val state = encode(entries)
        val key = newKey()
        if (!prefs.edit().putString(KEY_STATE, state).putString(KEY_MAC, mac(key, state)).commit()) {
            throw IllegalStateException("prefs commit failed")
        }
    }

    /** The verified stored hash for [agentId], or null. Never throws. For AgentRuntime's launch. */
    fun shaFor(context: Context, agentId: String): String? =
        if (!isValidAgentId(agentId)) null else read(context).firstOrNull { it.agentId == agentId }?.sha256

    /** Stores [sha256] (computed by native, see [setFromSettings]) for [agentId]. */
    @Synchronized
    private fun enable(context: Context, agentId: String, sha256: String, now: Long = System.currentTimeMillis()) {
        require(isValidAgentId(agentId) && isValidSha256(sha256)) { "invalid entry" }
        val byId = LinkedHashMap<String, Entry>()
        for (e in read(context)) byId[e.agentId] = e
        byId[agentId] = Entry(agentId, sha256, now)
        require(byId.size <= MAX_ENTRIES) { "too many entries" }
        write(context, byId.values.toList())
    }

    /** OFF for [agentId]. Safe from anywhere. Returns the hash that was stored, if any. */
    @Synchronized
    fun disable(context: Context, agentId: String): String? {
        val current = read(context)
        val removed = current.firstOrNull { it.agentId == agentId }?.sha256
        val left = current.filter { it.agentId != agentId }
        try {
            write(context, left)
        } catch (e: Exception) {
            // Could not re-key: drop everything rather than leave an entry on.
            Log.w(TAG, "opt-in write failed while turning off - clearing type=${e.javaClass.simpleName}")
            runCatching { write(context, emptyList()) }
        }
        return removed
    }

    // ---- Module entry points (call off the main thread) ---------------------------

    private fun listError(code: String): String =
        JSONObject().put("ok", false).put("code", code).put("pipelines", JSONArray()).toString()

    /**
     * The module's `getWebSearchOptIns`. [runCandidates] runs the executor op
     * and returns (stdout or null, code). Returns
     * `{ok, code, pipelines:[{agentId, name, pipelineId, definitionSha256, webSearchStep, state, enabledAt, missing}]}`.
     * A stored entry whose agent is no longer an article plan is listed with
     * `missing: true` (state lapsed) so the owner can turn it off.
     */
    fun listJson(context: Context, runCandidates: (Context) -> Pair<String?, String>): String {
        val (stdout, code) = try { runCandidates(context) } catch (e: Exception) { Pair(null, "failed") }
        if (stdout == null) return listError(code)
        val candidates = parseCandidates(stdout) ?: return listError("invalid-output")
        val stored = read(context)
        val arr = JSONArray()
        for (c in candidates) {
            val entry = stored.firstOrNull { it.agentId == c.agentId }
            arr.put(
                JSONObject().put("agentId", c.agentId).put("name", c.name ?: JSONObject.NULL)
                    .put("pipelineId", c.pipelineId ?: JSONObject.NULL).put("definitionSha256", c.definitionSha256)
                    .put("webSearchStep", c.webSearchStep).put("state", stateOf(entry, c))
                    .put("enabledAt", entry?.enabledAt ?: JSONObject.NULL).put("missing", false),
            )
        }
        for (e in stored) {
            if (candidates.any { it.agentId == e.agentId }) continue
            arr.put(
                JSONObject().put("agentId", e.agentId).put("name", JSONObject.NULL).put("pipelineId", JSONObject.NULL)
                    .put("definitionSha256", JSONObject.NULL).put("webSearchStep", false).put("state", "lapsed")
                    .put("enabledAt", e.enabledAt).put("missing", true),
            )
        }
        return JSONObject().put("ok", true).put("code", "ok").put("pipelines", arr).toString()
    }

    /**
     * Search parity item 4 (MCP request_pipeline_refire): the agent of the
     * article pipeline [pipelineId], when that pipeline's web-search opt-in is
     * on now (the same check as the Settings list: a verified stored hash equal
     * to the hash the executor computes for the current definition). Read
     * only: nothing is stored or audited here. [PipelineOptIn.code] is ok
     * (agentId and the definition hash the opt-in is bound to are set), or
     * unknown_pipeline (no candidate, or more than one, carries this id),
     * not_opted_in (off or lapsed), native_error (the executor op failed or
     * its output did not parse). The recovery script records the hash with
     * the request and checks the consent again before the re-fire
     * ([optInSnapshot]).
     */
    fun optedInAgentForPipeline(
        context: Context,
        pipelineId: String,
        runCandidates: (Context) -> Pair<String?, String>,
    ): PipelineOptIn {
        val (stdout, _) = try { runCandidates(context) } catch (e: Exception) { Pair(null, "failed") }
        if (stdout == null) return PipelineOptIn(null, null, "native_error")
        val candidates = parseCandidates(stdout) ?: return PipelineOptIn(null, null, "native_error")
        val matching = candidates.filter { it.pipelineId == pipelineId }
        if (matching.size != 1) return PipelineOptIn(null, null, "unknown_pipeline")
        val c = matching[0]
        val entry = read(context).firstOrNull { it.agentId == c.agentId }
        return if (stateOf(entry, c) == "on") PipelineOptIn(c.agentId, c.definitionSha256, "ok")
        else PipelineOptIn(null, null, "not_opted_in")
    }

    data class PipelineOptIn(val agentId: String?, val definitionSha256: String?, val code: String)

    /**
     * The verified opt-ins as the recovery script's --opt-ins argument
     * (`agentId=sha256,...`, or `none`): a sweep re-checks an MCP re-fire
     * request's consent with it before the re-fire. Anything that does not
     * verify reads as no entry (off). Never throws.
     */
    fun optInSnapshot(context: Context): String {
        val entries = try { read(context) } catch (e: Exception) { emptyList() }
        val parts = entries.filter { isValidAgentId(it.agentId) && isValidSha256(it.sha256) }.map { "${it.agentId}=${it.sha256}" }
        return if (parts.isEmpty()) "none" else parts.joinToString(",")
    }

    /**
     * The module's `setWebSearchOptIn`, only from the owner's Settings toggle.
     * ON: runs the executor op, finds [agentId], requires `webSearchStep`, and
     * (when [expectedSha256] is given) that the fresh hash is the one Settings
     * listed; stores the fresh hash. OFF: removes the entry, no executor run.
     * Every change is audited. Returns `{ok, code}`; code is one of on, off,
     * invalid, not-found, no-web-search, changed, executor-missing,
     * stale-executor, runtime-missing, invalid-output, failed.
     */
    fun setFromSettings(
        context: Context,
        agentId: String,
        enabled: Boolean,
        expectedSha256: String?,
        runCandidates: (Context) -> Pair<String?, String>,
    ): String {
        fun result(ok: Boolean, code: String) = JSONObject().put("ok", ok).put("code", code).toString()
        if (!isValidAgentId(agentId)) return result(false, "invalid")
        if (!enabled) {
            val removed = disable(context, agentId)
            val stillOn = shaFor(context, agentId) != null
            audit(context, "disabled", agentId, removed)
            return result(!stillOn, if (stillOn) "failed" else "off")
        }
        if (expectedSha256 != null && !isValidSha256(expectedSha256)) return result(false, "invalid")
        val (stdout, code) = try { runCandidates(context) } catch (e: Exception) { Pair(null, "failed") }
        if (stdout == null) return result(false, code)
        val candidates = parseCandidates(stdout) ?: return result(false, "invalid-output")
        val c = candidates.firstOrNull { it.agentId == agentId } ?: return result(false, "not-found")
        if (!c.webSearchStep) return result(false, "no-web-search")
        if (expectedSha256 != null && expectedSha256 != c.definitionSha256) return result(false, "changed")
        return try {
            enable(context, agentId, c.definitionSha256)
            audit(context, "enabled", agentId, c.definitionSha256)
            result(true, "on")
        } catch (e: Exception) {
            Log.w(TAG, "web search opt-in enable failed type=${e.javaClass.simpleName}")
            result(false, "failed")
        }
    }

    // ---- Audit -------------------------------------------------------------------

    private fun audit(context: Context, event: String, agentId: String, sha256: String?) {
        Log.i(TAG, "web search opt-in $event agent=$agentId sha=${sha256?.take(16) ?: "-"} source=settings")
        val line = buildAuditLine(System.currentTimeMillis(), event, agentId, sha256) ?: return
        appendAudit(context, agentId, line)
    }

    /**
     * Appends [line] to `~/.shelly/agents/logs/<agentId>/plan-executor-audit.jsonl`
     * (the executor's audit file for that agent), with IngressAuditWriter's
     * safety rules: no symlinked directory (canonical == absolute), the file
     * opened O_NOFOLLOW, 0600. The agent's log directory is created only while
     * its plan file exists (a deleted agent's log directory is never
     * re-created). Best effort: false when not written.
     */
    private fun appendAudit(context: Context, agentId: String, line: String): Boolean {
        try {
            if (!isValidAgentId(agentId) || line.contains('\n') || line.contains('\r')) return false
            val home = File(context.filesDir, "home").canonicalFile
            val agentsDir = File(home, ".shelly/agents")
            if (!agentsDir.isDirectory) return false
            val logsDir = File(agentsDir, "logs")
            val dir = File(logsDir, agentId)
            if (!dir.isDirectory) {
                if (!File(agentsDir, "plans/plan-agent-$agentId.json").isFile) return false
                if (logsDir.exists() && logsDir.canonicalFile.path != logsDir.absoluteFile.path) {
                    Log.w(TAG, "audit directory is a link - skipped")
                    return false
                }
                if (!dir.mkdirs() && !dir.isDirectory) return false
            }
            if (dir.canonicalFile.path != dir.absoluteFile.path) {
                Log.w(TAG, "audit directory is a link - skipped")
                return false
            }
            val target = File(dir, AUDIT_FILE)
            val flags = OsConstants.O_WRONLY or OsConstants.O_APPEND or OsConstants.O_CREAT or
                OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC
            val fd = Os.open(target.path, flags, 384 /* 0600 */)
            try {
                FileOutputStream(fd).use { out ->
                    out.write((line + "\n").toByteArray(Charsets.UTF_8))
                }
            } finally {
                runCatching { Os.close(fd) } // the stream does not own the fd
            }
            return true
        } catch (e: Exception) {
            Log.w(TAG, "audit line not written type=${e.javaClass.simpleName}")
            return false
        }
    }
}
