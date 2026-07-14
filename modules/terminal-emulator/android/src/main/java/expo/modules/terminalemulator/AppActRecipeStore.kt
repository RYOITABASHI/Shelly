package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * app.act Track 1/2 (docs/superpowers/specs/2026-07-11-app-act-design.md,
 * 2026-07-11-post-ui-automation-agent-architecture.md, 2026-07-12
 * implementation-detail plan) — recipe schema, storage, and loader.
 *
 * Recipes are bundled as plain JSON under APK assets
 * (`app-act-recipes/<id>.json`) and loaded on demand via
 * [Context.getAssets]. No `$HOME/.shelly/app-act-recipes/` mirror or
 * override layer exists — that's explicitly deferred Track 3 machinery
 * with no consumer yet.
 *
 * The matcher schema deliberately has NO `textRegex` field: only exact
 * (case-insensitive) [Matcher.text] matching is supported, mirroring the
 * already-proven `it.text?.toString()?.equals(trimmedTarget,
 * ignoreCase = true)` pattern from ShellyAccessibilityService's hardcoded
 * LINE flow. This avoids the unescaped-regex-metacharacter bug a
 * `textRegex` design would introduce.
 */
object AppActRecipeStore {
    private const val TAG = "AppActRecipeStore"

    /** One step of a [Recipe]. [matcher] is null only for `op == "launch"`
     *  (which targets a package, not a node). [param] names which entry of
     *  the caller-supplied params map to type, for `op == "setText"`.
     *  [target] is the package name to launch, for `op == "launch"`.
     *  [intent] is a required free-text human-readable description of what
     *  the step does — every step must carry one, purely for
     *  diagnostics/logging, never parsed. [timeoutMs] overrides the
     *  per-op default poll timeout when present.
     *
     *  [recoverOnZeroMatch] (`click` steps only; null/empty = disabled,
     *  the default) — added 2026-07-12 after finding on-device that
     *  `launch`/`ensureForeground` resumes whatever screen the target app
     *  was LAST showing (standard Android task-stack behavior), which for
     *  a messaging app is often an individual conversation screen or a
     *  scrolled list with its header/search affordance hidden. A recipe's
     *  first real navigational `click` step (e.g. "open the search
     *  screen") can therefore start from an arbitrary nav depth or scroll
     *  position. This ordered list lets that one step opt into bounded
     *  recovery actions such as `back` and `scrollToTop`, re-polling after
     *  each action before falling through to the existing zero-match
     *  fail-close. Deliberately a per-step opt-in, not a blanket engine
     *  behavior: only the FIRST navigational step after `launch` should
     *  ever set this — a zero-match on a LATER step (e.g. "no search
     *  result matched this contact name") is a genuine failure, and
     *  blindly navigating there could leave the target app somewhere the
     *  human didn't expect. */
    data class RecipeStep(
        val op: String,
        val matcher: Matcher? = null,
        val param: String? = null,
        val target: String? = null,
        val intent: String,
        val timeoutMs: Long? = null,
        val recoverOnZeroMatch: List<String>? = null,
    )

    /** A node matches iff ALL non-null fields here match (AND semantics).
     *  [resourceId] is compared against [android.view.accessibility.AccessibilityNodeInfo.getViewIdResourceName]
     *  exactly; [contentDescription] against
     *  [android.view.accessibility.AccessibilityNodeInfo.getContentDescription]
     *  exactly; [text] against
     *  [android.view.accessibility.AccessibilityNodeInfo.getText]
     *  case-insensitively. `{{param}}` placeholders inside [text] are
     *  substituted with the caller-supplied params map (literal string
     *  replace) before matching.
     *
     *  [label] is a separate OR-across-two-fields matcher (exact,
     *  case-sensitive): matches if EITHER `contentDescription` OR `text`
     *  equals [label]. Exists because some icon-only buttons expose their
     *  label via contentDescription while equivalent buttons on other
     *  screens of the SAME app expose the identical label as visible text
     *  instead — found on-device 2026-07-12 for LINE's search entry point,
     *  which is a pill-shaped bar with "検索" as placeholder TEXT on the
     *  ホーム/トーク/ニュース tabs, but a bare icon whose label (if any)
     *  lives in contentDescription on VOOM/ミニアプリ. A plain
     *  `contentDescription`-only matcher missed the text-based tabs
     *  entirely. [label] ANDs with any other non-null matcher field, same
     *  as every other field here. */
    data class Matcher(
        val resourceId: String? = null,
        val contentDescription: String? = null,
        val text: String? = null,
        val label: String? = null,
    )

    data class ParamSpec(
        val name: String,
        val description: String,
        val required: Boolean,
    )

    data class Recipe(
        val id: String,
        val pkg: String,
        val operation: String,
        val displayName: String,
        val tier: String,
        val params: List<ParamSpec>,
        val steps: List<RecipeStep>,
    )

    /** Loads and parses `app-act-recipes/$recipeId.json` from APK assets.
     *  Returns null (logging the reason) on any I/O or parse failure —
     *  never throws past this boundary, matching this module's general
     *  fail-closed-with-a-reason convention. */
    fun load(context: Context, recipeId: String): Recipe? =
        try {
            val json = context.assets.open("app-act-recipes/$recipeId.json").use { stream ->
                JSONObject(stream.readBytes().decodeToString())
            }
            parseRecipe(json)
        } catch (e: Exception) {
            Log.e(TAG, "load($recipeId) failed: ${e.message}", e)
            null
        }

    private fun parseRecipe(o: JSONObject): Recipe {
        val paramsArray = o.optJSONArray("params") ?: JSONArray()
        val params = mutableListOf<ParamSpec>()
        for (i in 0 until paramsArray.length()) {
            val p = paramsArray.getJSONObject(i)
            params.add(
                ParamSpec(
                    name = p.getString("name"),
                    description = p.optString("description", ""),
                    required = p.optBoolean("required", false),
                ),
            )
        }

        val stepsArray = o.getJSONArray("steps")
        val steps = mutableListOf<RecipeStep>()
        for (i in 0 until stepsArray.length()) {
            val s = stepsArray.getJSONObject(i)
            val matcherObj = s.optJSONObject("matcher")
            val matcher = if (matcherObj == null) {
                null
            } else {
                Matcher(
                    resourceId = if (matcherObj.has("resourceId") && !matcherObj.isNull("resourceId")) matcherObj.getString("resourceId") else null,
                    contentDescription = if (matcherObj.has("contentDescription") && !matcherObj.isNull("contentDescription")) matcherObj.getString("contentDescription") else null,
                    text = if (matcherObj.has("text") && !matcherObj.isNull("text")) matcherObj.getString("text") else null,
                    label = if (matcherObj.has("label") && !matcherObj.isNull("label")) matcherObj.getString("label") else null,
                )
            }
            steps.add(
                RecipeStep(
                    op = s.getString("op"),
                    matcher = matcher,
                    param = if (s.has("param") && !s.isNull("param")) s.getString("param") else null,
                    target = if (s.has("target") && !s.isNull("target")) s.getString("target") else null,
                    intent = s.getString("intent"),
                    timeoutMs = if (s.has("timeoutMs") && !s.isNull("timeoutMs")) s.getLong("timeoutMs") else null,
                    recoverOnZeroMatch = parseRecoverOnZeroMatch(s),
                ),
            )
        }

        return Recipe(
            id = o.getString("id"),
            pkg = o.getString("pkg"),
            operation = o.getString("operation"),
            displayName = o.optString("displayName", o.getString("id")),
            tier = o.optString("tier", "C"),
            params = params,
            steps = steps,
        )
    }

    private fun parseRecoverOnZeroMatch(step: JSONObject): List<String>? {
        val recoverArray = step.optJSONArray("recoverOnZeroMatch")
        if (recoverArray != null) {
            val actions = mutableListOf<String>()
            for (i in 0 until recoverArray.length()) {
                val action = recoverArray.getString(i).trim()
                if (action.isNotEmpty()) actions.add(action)
            }
            return actions.ifEmpty { null }
        }

        // Backward-compatible loader for recipes built before the
        // generalized recovery list existed.
        val legacyBackRetries = if (step.has("retryBackOnZeroMatch") && !step.isNull("retryBackOnZeroMatch")) {
            step.getInt("retryBackOnZeroMatch").coerceAtLeast(0)
        } else {
            0
        }
        return if (legacyBackRetries > 0) List(legacyBackRetries) { "back" } else null
    }
}
