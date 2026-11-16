package expo.modules.terminalemulator

import org.json.JSONArray
import org.json.JSONObject

/**
 * Step 7 (POLICY-001 deny / draft_only, CRITICAL cli) of the run_agent deny
 * order on the HEADLESS path (McpTypedOpConsumer; plan addendum §4, option (b):
 * a conservative native subset). The full evaluator (lib/agent-action-policy.ts
 * evaluateActionPolicy + checkCommandSafety) is TS/RN-only, and the user policy
 * file's seal lives in RN's SecureStore. So native decides only what it can
 * decide exactly, and everything else is UNDECIDABLE, which the consumer
 * treats as NO rule match (hand off to RN when RN is live — RN then runs the
 * full step 7 — otherwise `not_attended`). Undecidable never executes.
 *
 * What runs natively:
 *  - Each declared action (`action` and `actions`, as lib/mcp-typed-ops.ts
 *    declaredActions) goes through a copy of actionTypeCapabilities. ANY
 *    side-effecting one (everything except draft / __suppressed__ / notify,
 *    unknown types included, every cli action — commands are never rated here,
 *    so CRITICAL is never "cleared" natively) makes the agent UNDECIDABLE.
 *  - An agent with no declared action: CLEARABLE — the only clearable case
 *    (the TS loop has nothing to evaluate, so RN never refuses it at step 7).
 *  - Read-only actions only (draft / notify): NEVER clearable. RN decides
 *    from its sealed, cached user policy; native can verify neither the seal
 *    (RN SecureStore) nor the cache, so a deleted or replaced policy.json must
 *    not let native clear what RN would deny (Codex review 2026-11-15). The
 *    file is still read WITHOUT its seal for one thing only: a deny rule whose
 *    match is exactly {capability} with a capability the actions have is a
 *    certain user deny, so it refuses POLICY_DENIED (refusing is the safe
 *    direction). Otherwise: UNDECIDABLE.
 *
 * Direction of every gap: native may refuse or defer where RN would allow
 * (e.g. an invalid policy file RN would read as "unavailable, no rules"), never
 * allow where RN would refuse — pinned by __tests__/fixtures/
 * mcp-typed-op-capabilities.json (TS side: mcp-typed-op-native-parity.test.ts,
 * JVM: McpTypedOpPolicyTest). Residual (stated in the plan): a user policy
 * edit after a rule was created is NOT covered by the rule's binding hash; for
 * read-only agents this subset still re-reads the file on every request.
 *
 * Pure: no Android dependency.
 */
object McpTypedOpPolicy {
    /** lib/agent-action-policy.ts READ_ONLY_CAPABILITIES. */
    val READ_ONLY_CAPABILITIES: Set<String> = setOf("read", "draft", "notify")

    enum class Decision { CLEARABLE, POLICY_DENIED, UNDECIDABLE }

    /** One declared action: its `type` (null when missing / not a string) and `intentMode`. */
    data class DeclaredAction(val type: String?, val intentMode: String?)

    /**
     * actionTypeCapabilities for every type but `cli`, which returns null: its
     * capabilities depend on the command, which native does not classify (a cli
     * action always includes `exec` in TS, so it is side-effecting either way).
     */
    fun capabilities(actionType: String, intentMode: String?): List<String>? = when (actionType) {
        "draft", "__suppressed__" -> listOf("draft")
        "notify" -> listOf("notify")
        "webhook", "api-call" -> listOf("network", "post")
        "social-post" -> listOf("network", "post")
        "dm-reply" -> listOf("network", "message")
        "intent" -> if (intentMode == "launch" || intentMode == "closepaw") listOf("exec") else listOf("message")
        "browser-pane" -> listOf("network", "post")
        "cli" -> null
        else -> listOf("exec")
    }

    fun isSideEffecting(actionType: String, intentMode: String?): Boolean {
        val caps = capabilities(actionType, intentMode) ?: return true
        return caps.any { it !in READ_ONLY_CAPABILITIES }
    }

    private fun declared(v: Any?): DeclaredAction? = when (v) {
        is JSONObject -> DeclaredAction(v.opt("type") as? String, v.opt("intentMode") as? String)
        // `typeof [] === 'object'` in TS: an array entry is an action without a type.
        is JSONArray -> DeclaredAction(null, null)
        else -> null
    }

    /** lib/mcp-typed-ops.ts declaredActions over the agent JSON: `action` then `actions`. */
    fun declaredActions(agent: JSONObject): List<DeclaredAction> {
        val out = ArrayList<DeclaredAction>()
        declared(agent.opt("action"))?.let { out.add(it) }
        val arr = agent.opt("actions")
        if (arr is JSONArray) {
            for (i in 0 until arr.length()) declared(arr.opt(i))?.let { out.add(it) }
        }
        return out
    }

    private fun keysOf(o: JSONObject): Set<String> {
        val out = HashSet<String>()
        val it = o.keys()
        while (it.hasNext()) out.add(it.next())
        return out
    }

    /**
     * True when non-blank [policyText] is not a `shelly.user-policy` document
     * with a `userPolicy.rules` array (RN's loader: `unavailable`). Blank = the
     * empty policy, not malformed.
     */
    fun isMalformed(policyText: String): Boolean {
        if (policyText.isBlank()) return false
        return try {
            val root = JSONObject(policyText.trim())
            val up = root.opt("userPolicy") as? JSONObject
            root.opt("kind") != "shelly.user-policy" || up == null || up.opt("rules") !is JSONArray
        } catch (e: Exception) {
            true
        }
    }

    /**
     * The headless step-7 decision. [policyText]: the policy file's text, null
     * when the file does not exist. [policyUnreadable]: it exists but could not
     * be read (not a regular file, too big, I/O error) — UNDECIDABLE unless the
     * agent declares no action.
     */
    fun decide(actions: List<DeclaredAction>, policyText: String?, policyUnreadable: Boolean = false): Decision {
        if (actions.isEmpty()) return Decision.CLEARABLE
        val caps = HashSet<String>()
        for (a in actions) {
            val type = a.type ?: "unknown"
            if (isSideEffecting(type, a.intentMode)) return Decision.UNDECIDABLE
            caps.addAll(capabilities(type, a.intentMode) ?: return Decision.UNDECIDABLE)
        }
        // Read-only actions from here on: never CLEARABLE (see the class doc).
        if (policyUnreadable || policyText == null || policyText.isBlank()) return Decision.UNDECIDABLE
        val rules: JSONArray = try {
            val root = JSONObject(policyText.trim())
            if (root.opt("kind") != "shelly.user-policy") return Decision.UNDECIDABLE
            val up = root.opt("userPolicy") as? JSONObject ?: return Decision.UNDECIDABLE
            up.opt("rules") as? JSONArray ?: return Decision.UNDECIDABLE
        } catch (e: Exception) {
            return Decision.UNDECIDABLE
        }
        for (i in 0 until rules.length()) {
            val rule = rules.opt(i) as? JSONObject ?: continue
            if (rule.opt("effect") != "deny") continue
            val match = rule.opt("match") as? JSONObject ?: continue
            val cap = match.opt("capability") as? String ?: continue
            if (cap in caps && keysOf(match) == setOf("capability")) return Decision.POLICY_DENIED
        }
        return Decision.UNDECIDABLE
    }
}
