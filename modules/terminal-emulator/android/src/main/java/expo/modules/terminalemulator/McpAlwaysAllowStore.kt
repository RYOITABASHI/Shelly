package expo.modules.terminalemulator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import org.json.JSONArray
import org.json.JSONObject

/**
 * MCP "always allow" rules for TYPED operations (DEFERRED.md「MCP の入口」 item 3;
 * plan: typed MCP operations with always-allow rules, section (a)).
 *
 * A rule says: requests from this MCP client (its principal, derived from the
 * bearer token: sha256("shelly-mcp-principal:" + token)[:32]) for this typed
 * operation on this one target run without the approval tap. Raw operations
 * (`run_command`, `write_file`) can never have a rule: [decode] rejects them and
 * [add] refuses them. Legacy rules only remove the launch dialog. New action
 * consent carries actionPolicyPin: RN evaluated the full deny/CRITICAL policy
 * for this binding; native verifies that exact sealed snapshot before launch.
 * STOP-ALL and agent-definition taint always win.
 *
 * Who can add a rule: only TerminalEmulatorModule's `mcpAlwaysAllowAdd`, which
 * RN's MCP bridge calls after a human "always allow" tap won the approval
 * (nothing calls it yet; the writer arrives with the typed ops). There is no
 * shell command, file, queue field or env that reaches [add]. Removing rules
 * ([remove], [purgeExcept]) is safe from anywhere.
 *
 * Storage: this app's SharedPreferences, MAC'd with a non-exportable Android
 * Keystore HMAC key (the ClosePawDraftPreapproval pattern). Native code reads it
 * (the headless MCP path has no RN), which is why it is not in expo-secure-store.
 * Every write makes a NEW key, so an older copy of the prefs (a rollback to a
 * revoked rule) never verifies again. Anything that does not verify, or does not
 * decode strictly, reads as NO rules: the dialog comes back, nothing more.
 *
 * Token cascade: regenerating the MCP token calls [purgeExcept] with null before
 * the new token exists and with the new principal after it is saved
 * (lib/mcp-server-bridge.ts revokePendingMCPRequests, hooks/use-mcp-server-bridge.ts).
 *
 * Boundary, as for ClosePawDraftPreapproval: code running as this uid that can
 * drive AndroidKeyStore itself could forge rules. Shell writes to files cannot.
 */
object McpAlwaysAllowStore {
    private const val TAG = "McpAlwaysAllowStore"
    private const val PREFS = "shelly_mcp_always_allow"
    private const val KEY_STATE = "state"
    private const val KEY_MAC = "mac"
    private const val KEY_ALIAS = "shelly_mcp_always_allow_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val DOMAIN = "shelly-mcp-always-allow-v1:"

    const val VERSION = 1
    const val MAX_RULES = 200
    const val MAX_STATE_CHARS = 64 * 1024
    const val MAX_LABEL_CHARS = 64

    /**
     * The closed set of TYPED operations a rule may name. Raw operations
     * (run_command, write_file) are deliberately absent and never added here.
     * Keep in step with TYPED_OPS in lib/mcp-always-allow.ts.
     */
    val TYPED_OPS: Set<String> = setOf("run_agent", "service_control")

    private val PRINCIPAL_RE = Regex("^[0-9a-f]{32}$")
    private val BIND_RE = Regex("^[0-9a-f]{64}$")
    private val ID_RE = Regex("^r_[0-9a-f]{16}$")
    private val TARGET_RES: Map<String, Regex> = mapOf(
        "run_agent" to Regex("^agent:[A-Za-z0-9_-]{1,128}$"),
        // Same as SERVICE_CONTROL_TARGET_RE in lib/mcp-service-control.ts.
        "service_control" to Regex("^service:(article-delivery|council-facade):(start|status|stop)$"),
    )
    private val RULE_KEYS = setOf("id", "principal", "op", "target", "bind", "label", "createdAt", "actionPolicyPin")
    private val ROOT_KEYS = setOf("version", "rules")
    // Control, bidi and zero-width characters (the same set as lib/mcp-request-auth.ts
    // UNSAFE_NAME_CHARS): the label is shown in Settings.
    private val UNSAFE_LABEL_CHARS = Regex("[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u2069\\uFEFF]")

    /** [bind] null: the rule does not depend on the target's definition. [label] is display only. */
    data class Rule(
        val id: String,
        val principal: String,
        val op: String,
        val target: String,
        val bind: String?,
        val label: String,
        val createdAt: Long,
        /** RN evaluated this definition against this exact sealed policy after action consent. */
        val actionPolicyPin: String? = null,
    )

    enum class Status { EMPTY, OK, UNREADABLE }

    data class Classified(val status: Status, val rules: List<Rule>)

    fun isTypedOp(op: String?): Boolean = op != null && op in TYPED_OPS

    fun isValidPrincipal(p: String?): Boolean = p != null && PRINCIPAL_RE.matches(p)

    fun isValidBind(b: String?): Boolean = b == null || BIND_RE.matches(b)

    fun isValidTarget(op: String?, target: String?): Boolean {
        val re = op?.let { TARGET_RES[it] } ?: return false
        return target != null && isTypedOp(op) && re.matches(target)
    }

    fun isValidLabel(label: String?): Boolean =
        label != null && label.length <= MAX_LABEL_CHARS && !UNSAFE_LABEL_CHARS.containsMatchIn(label)

    /** Display text only: unsafe characters dropped, at most [MAX_LABEL_CHARS] chars, no split surrogate pair. */
    fun sanitizeLabel(label: String?): String {
        var s = UNSAFE_LABEL_CHARS.replace(label ?: "", "").trim()
        if (s.length > MAX_LABEL_CHARS) {
            s = s.substring(0, MAX_LABEL_CHARS)
            if (s.isNotEmpty() && Character.isHighSurrogate(s[s.length - 1])) s = s.substring(0, s.length - 1)
        }
        return s
    }

    /** The unique key: principal, op, target. */
    fun ruleKey(principal: String, op: String, target: String): String = "$principal\u0000$op\u0000$target"

    fun ruleKey(r: Rule): String = ruleKey(r.principal, r.op, r.target)

    fun isValidRule(r: Rule): Boolean =
        ID_RE.matches(r.id) && isValidPrincipal(r.principal) && isTypedOp(r.op) && isValidTarget(r.op, r.target) &&
            isValidBind(r.bind) && isValidLabel(r.label) && r.createdAt >= 0 &&
            (r.actionPolicyPin == null || (r.bind != null && isValidPolicyPin(r.actionPolicyPin)))

    fun isValidPolicyPin(pin: String?): Boolean = pin == "absent" || (pin != null && BIND_RE.matches(pin))

    private fun ruleJson(r: Rule): JSONObject {
        val o = JSONObject().put("id", r.id).put("principal", r.principal).put("op", r.op).put("target", r.target)
            .put("label", r.label).put("createdAt", r.createdAt)
        if (r.bind != null) o.put("bind", r.bind)
        if (r.actionPolicyPin != null) o.put("actionPolicyPin", r.actionPolicyPin)
        return o
    }

    fun encode(rules: List<Rule>): String {
        val arr = JSONArray()
        for (r in rules) arr.put(ruleJson(r))
        return JSONObject().put("version", VERSION).put("rules", arr).toString()
    }

    private fun keysOf(o: JSONObject): Set<String> {
        val out = HashSet<String>()
        val it = o.keys()
        while (it.hasNext()) out.add(it.next())
        return out
    }

    /**
     * Null when anything is off: an unknown version or key, a raw or unknown op, a
     * malformed id / principal / target / bind / label, a duplicate id or key, too
     * many rules, too long a state. Strict on purpose: the whole state is then NO rules.
     */
    fun decode(text: String): List<Rule>? {
        try {
            if (text.length > MAX_STATE_CHARS) return null
            val root = JSONObject(text)
            if (!ROOT_KEYS.containsAll(keysOf(root))) return null
            if (root.opt("version") != VERSION) return null
            val arr = root.getJSONArray("rules")
            if (arr.length() > MAX_RULES) return null
            val out = ArrayList<Rule>()
            val ids = HashSet<String>()
            val keys = HashSet<String>()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                if (!RULE_KEYS.containsAll(keysOf(o))) return null
                val created = o.get("createdAt")
                if (created !is Int && created !is Long) return null
                val bind = if (o.has("bind")) (o.get("bind") as? String ?: return null) else null
                val r = Rule(
                    id = o.get("id") as? String ?: return null,
                    principal = o.get("principal") as? String ?: return null,
                    op = o.get("op") as? String ?: return null,
                    target = o.get("target") as? String ?: return null,
                    bind = bind,
                    label = o.get("label") as? String ?: return null,
                    createdAt = (created as Number).toLong(),
                    actionPolicyPin = if (o.has("actionPolicyPin")) o.get("actionPolicyPin") as? String ?: return null else null,
                )
                if (!isValidRule(r)) return null
                if (!ids.add(r.id) || !keys.add(ruleKey(r))) return null
                out.add(r)
            }
            return out
        } catch (e: Exception) {
            return null
        }
    }

    /**
     * Pure: what the stored prefs mean. [expectedMac] is the MAC of [state] under the
     * current key, or null when there is no key. Both absent: EMPTY. Anything that
     * does not verify or decode: UNREADABLE, with no rules (fail closed: dialogs).
     */
    fun classify(state: String?, storedMac: String?, expectedMac: String?): Classified {
        if (state == null && storedMac == null) return Classified(Status.EMPTY, emptyList())
        if (state == null || storedMac == null || expectedMac == null) return Classified(Status.UNREADABLE, emptyList())
        if (!MessageDigest.isEqual(expectedMac.toByteArray(Charsets.UTF_8), storedMac.toByteArray(Charsets.UTF_8))) {
            return Classified(Status.UNREADABLE, emptyList())
        }
        val rules = decode(state) ?: return Classified(Status.UNREADABLE, emptyList())
        return Classified(if (rules.isEmpty()) Status.EMPTY else Status.OK, rules)
    }

    /**
     * Pure: the rule that allows (principal, op, target) with binding [bind], or null.
     * A rule with a bind matches only that exact bind; a rule without one matches any.
     * Invalid inputs (a raw op, a malformed principal / target / bind) match nothing.
     */
    fun findMatch(rules: List<Rule>, principal: String?, op: String?, target: String?, bind: String?): Rule? {
        if (!isValidPrincipal(principal) || !isTypedOp(op) || !isValidTarget(op, target) || !isValidBind(bind)) return null
        return rules.firstOrNull {
            it.principal == principal && it.op == op && it.target == target && (it.bind == null || it.bind == bind)
        }
    }

    sealed class AddResult {
        data class Added(val rules: List<Rule>, val rule: Rule, val replaced: Boolean) : AddResult()
        data class Refused(val code: String) : AddResult()
    }

    /**
     * Pure: [rules] with [rule] added. An existing rule with the same key keeps its
     * id and takes the new bind / label / createdAt. Refused (never evicting
     * anything) when invalid, or when the result would exceed [MAX_RULES] or
     * [MAX_STATE_CHARS].
     */
    fun withAdded(rules: List<Rule>, rule: Rule): AddResult {
        if (!isValidRule(rule)) return AddResult.Refused("invalid")
        val key = ruleKey(rule)
        val idx = rules.indexOfFirst { ruleKey(it) == key }
        val next: List<Rule>
        val stored: Rule
        if (idx >= 0) {
            // The new grant replaces the whole rule except its id, including
            // actionPolicyPin: RN just evaluated that pin. Keeping the old pin
            // froze a rule granted before the first policy write at "absent",
            // so no later grant could ever match (build 2968 device report).
            stored = rule.copy(id = rules[idx].id)
            next = rules.toMutableList().also { it[idx] = stored }
        } else {
            if (rules.any { it.id == rule.id }) return AddResult.Refused("invalid")
            if (rules.size >= MAX_RULES) return AddResult.Refused("full")
            stored = rule
            next = rules + rule
        }
        if (encode(next).length > MAX_STATE_CHARS) return AddResult.Refused("full")
        return AddResult.Added(next, stored, idx >= 0)
    }

    fun withRemoved(rules: List<Rule>, ids: Collection<String>): List<Rule> = rules.filter { it.id !in ids }

    /** Pure: only [principal]'s rules; null keeps none (token revoked). */
    fun purgedExcept(rules: List<Rule>, principal: String?): List<Rule> =
        if (principal == null) emptyList() else rules.filter { it.principal == principal }

    private val random = SecureRandom()

    fun newRuleId(existing: Collection<String>): String {
        while (true) {
            val bytes = ByteArray(8)
            random.nextBytes(bytes)
            val id = "r_" + bytes.joinToString("") { "%02x".format(it) }
            if (id !in existing) return id
        }
    }

    fun statusJson(c: Classified): String {
        val arr = JSONArray()
        for (r in c.rules) arr.put(ruleJson(r))
        return JSONObject()
            .put("version", VERSION)
            .put("status", c.status.name.lowercase())
            .put("rules", arr)
            .toString()
    }

    // ── Keystore + prefs ─────────────────────────────────────────────────────

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

    /** Verified rules; NO rules when anything fails to verify. Never throws. */
    @Synchronized
    fun read(context: Context): Classified = try {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val state = prefs.getString(KEY_STATE, null)
        val stored = prefs.getString(KEY_MAC, null)
        val key = if (state != null && stored != null) existingKey() else null
        val c = classify(state, stored, if (key != null && state != null) mac(key, state) else null)
        if (c.status == Status.UNREADABLE) Log.w(TAG, "always-allow state does not verify - treating as no rules")
        c
    } catch (e: Exception) {
        Log.w(TAG, "always-allow read failed - treating as no rules type=${e.javaClass.simpleName}")
        Classified(Status.UNREADABLE, emptyList())
    }

    /**
     * A fresh key for every write: no older copy of the prefs verifies after it. Throws on failure.
     * Clearing deletes the key FIRST and confirms it is gone (a crash before the prefs are
     * removed leaves prefs nothing can verify), and only then removes the prefs.
     */
    private fun write(context: Context, rules: List<Rule>) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (rules.isEmpty()) {
            val ks = keyStore()
            runCatching { ks.deleteEntry(KEY_ALIAS) }
                .onFailure { Log.w(TAG, "could not delete the always-allow key type=${it.javaClass.simpleName}") }
            if (keyStore().containsAlias(KEY_ALIAS)) {
                // Replacing the alias also voids the old key; the empty state it signs means no rules.
                val state = encode(emptyList())
                val key = newKey()
                if (!prefs.edit().putString(KEY_STATE, state).putString(KEY_MAC, mac(key, state)).commit()) {
                    error("prefs commit failed")
                }
                return
            }
            if (!prefs.edit().remove(KEY_STATE).remove(KEY_MAC).commit()) {
                // The key is gone, so what is left can never verify again (reads as no rules).
                Log.w(TAG, "always-allow prefs not removed after the key was deleted")
            }
            return
        }
        val state = encode(rules)
        val key = newKey()
        if (!prefs.edit().putString(KEY_STATE, state).putString(KEY_MAC, mac(key, state)).commit()) error("prefs commit failed")
    }

    /**
     * Writes [rules], or — when that fails — clears everything (narrowing is always
     * the safe side). True only when the stored state is confirmed to hold no rule
     * outside [rules].
     */
    private fun writeNarrowing(context: Context, rules: List<Rule>): Boolean {
        try {
            write(context, rules)
        } catch (e: Exception) {
            Log.w(TAG, "always-allow write failed while narrowing - clearing type=${e.javaClass.simpleName}")
            try {
                write(context, emptyList())
            } catch (e2: Exception) {
                Log.w(TAG, "always-allow clear failed type=${e2.javaClass.simpleName}")
                return false
            }
        }
        val after = read(context).rules
        val keep = rules.map { it.id }.toSet()
        return after.all { it.id in keep }
    }

    /** Status JSON {version, status: 'empty'|'ok'|'unreadable', rules}. For Settings; no secrets in here. */
    fun list(context: Context): String = statusJson(read(context))

    /** No write. Fail closed: an unreadable store matches nothing. */
    fun match(context: Context, principal: String?, op: String?, target: String?, bind: String?): Boolean =
        findMatch(read(context).rules, principal, op, target, bind) != null

    /**
     * Only from RN's MCP bridge after a human "always allow" tap (see the class
     * comment). Returns `{ok, code: 'added'|'replaced'|'invalid'|'full'|'failed', id?}`.
     * An unreadable store is replaced (its rules were already void).
     */
    @Synchronized
    fun add(
        context: Context,
        principal: String,
        op: String,
        target: String,
        bind: String?,
        label: String,
        now: Long = System.currentTimeMillis(),
        actionPolicyPin: String? = null,
    ): String {
        val out = JSONObject()
        if (!isTypedOp(op)) return out.put("ok", false).put("code", "invalid").toString()
        val current = read(context).rules
        // bind is taken as given: null is the only "any definition"; "" or anything malformed is refused.
        val rule = Rule(newRuleId(current.map { it.id }), principal, op, target, bind, sanitizeLabel(label), now, actionPolicyPin)
        return when (val r = withAdded(current, rule)) {
            is AddResult.Refused -> out.put("ok", false).put("code", r.code).toString()
            is AddResult.Added -> try {
                write(context, r.rules)
                Log.i(TAG, "always-allow rule ${r.rule.id} ${if (r.replaced) "replaced" else "added"} op=$op")
                out.put("ok", true).put("code", if (r.replaced) "replaced" else "added").put("id", r.rule.id).toString()
            } catch (e: Exception) {
                Log.w(TAG, "always-allow add failed type=${e.javaClass.simpleName}")
                out.put("ok", false).put("code", "failed").toString()
            }
        }
    }

    /** Settings revoke. Safe from anywhere. Returns status JSON plus `ok`. */
    @Synchronized
    fun remove(context: Context, ids: List<String>): String {
        val left = withRemoved(read(context).rules, ids.toSet())
        val ok = writeNarrowing(context, left)
        Log.i(TAG, "always-allow rules removed: ${ids.size} ok=$ok")
        return JSONObject(statusJson(read(context))).put("ok", ok).toString()
    }

    /**
     * Token cascade: keeps only [principal]'s rules; null removes everything. True
     * only when confirmed (callers fail closed on false).
     */
    @Synchronized
    fun purgeExcept(context: Context, principal: String?): Boolean {
        if (principal != null && !isValidPrincipal(principal)) return writeNarrowing(context, emptyList())
        val ok = writeNarrowing(context, purgedExcept(read(context).rules, principal))
        Log.i(TAG, "always-allow purge (keep=${if (principal == null) "none" else "current client"}) ok=$ok")
        return ok
    }
}
