package expo.modules.terminalemulator

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.graphics.Rect
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.atomic.AtomicBoolean

/**
 * app.act Track 2 (docs/superpowers/specs/2026-07-11-app-act-design.md,
 * 2026-07-11-post-ui-automation-agent-architecture.md, 2026-07-12
 * implementation-detail plan) — the general recipe/step-walker engine.
 *
 * Replaces the three hand-written, hardcoded flows in
 * [ShellyAccessibilityService] (`debugSendLineMessageToContactInner`,
 * `debugPostToXInner`, and their shared node-finding helpers) with a single
 * generic walker driven by [AppActRecipeStore.Recipe] data. Every node/
 * candidate-list resolution goes through [pollForCandidates] — one polling
 * primitive generalizing what used to be three separate hand-written
 * pollers (`pollForNodeByResourceId`, `pollForNodeByContentDescription`,
 * `pollForStableLineSearchResults`).
 *
 * Still reachable ONLY from the same debug entry points as before
 * (SettingsDropdown.tsx's AppActDebugSection, via
 * [ShellyAccessibilityService.debugSendLineMessageToContact] /
 * [ShellyAccessibilityService.debugPostToX]) — NOT wired into the agent/
 * PlanSpec pipeline. [resolveMatcherMiss] is a Track 3 (LLM fallback) stub
 * that always returns null (fail-closed, identical to today's zero-match
 * behavior); Track 3 will fill it in later without needing to change any
 * step's control flow.
 */
object AppActExecutor {
    private const val TAG = "AppActExecutor"
    private const val DEFAULT_STEP_TIMEOUT_MS = 3000L
    private const val LAUNCH_TIMEOUT_MS = 5000L
    private const val POLL_INTERVAL_MS = 150L
    private const val SCROLL_TO_TOP_MAX_STEPS = 10
    private const val SCROLL_STABLE_SAMPLES_TO_STOP = 2

    /** Single re-entrancy guard for ALL app.act runs — replaces
     *  [ShellyAccessibilityService]'s own per-file `busy` companion val.
     *  All recipes act through the same single AccessibilityService
     *  instance, so one guard across every recipe is correct, same as
     *  before. */
    private val busy = AtomicBoolean(false)

    fun execute(service: ShellyAccessibilityService, context: Context, recipeId: String, params: Map<String, String>): AppActDebugResult =
        runGuarded { executeInner(service, context, recipeId, params) }

    /** Shared re-entrancy guard + exception boundary for EVERY app.act
     *  entry point — recipe-driven ([execute]) and the two remaining
     *  hand-written entry points in [ShellyAccessibilityService]
     *  ([ShellyAccessibilityService.debugSendLineMessage], which has no
     *  recipe equivalent since it deliberately skips the search/navigate
     *  steps and sends into whatever conversation is already open). All
     *  app.act actions go through the same single AccessibilityService
     *  instance, so one guard across every call site is correct — mirrors
     *  [ShellyAccessibilityService]'s former per-file `busy` companion val,
     *  now centralized here since it must also cover recipe-driven runs. */
    internal fun runGuarded(action: () -> AppActDebugResult): AppActDebugResult {
        if (!busy.compareAndSet(false, true)) {
            return AppActDebugResult(false, "Another app.act run is already in progress")
        }
        return try {
            action()
        } catch (e: Exception) {
            Log.e(TAG, "runGuarded action threw", e)
            AppActDebugResult(false, "Exception: ${e.message}")
        } finally {
            busy.set(false)
        }
    }

    private fun executeInner(service: ShellyAccessibilityService, context: Context, recipeId: String, params: Map<String, String>): AppActDebugResult {
        val recipe = AppActRecipeStore.load(context, recipeId)
            ?: return AppActDebugResult(false, "Recipe not found: $recipeId")
        for (spec in recipe.params) {
            if (spec.required && params[spec.name].isNullOrEmpty()) {
                return AppActDebugResult(false, "Missing required param \"${spec.name}\" for recipe $recipeId")
            }
        }
        recipe.steps.forEachIndexed { index, step ->
            val outcome = executeStep(service, recipeId, index, recipe.pkg, step, params)
            if (!outcome.success) return outcome
        }
        return AppActDebugResult(true, "Recipe $recipeId completed")
    }

    private fun executeStep(
        service: ShellyAccessibilityService,
        recipeId: String,
        stepIndex: Int,
        pkg: String,
        step: AppActRecipeStore.RecipeStep,
        params: Map<String, String>,
    ): AppActDebugResult = when (step.op) {
        "launch" -> executeLaunch(service, step)
        "click" -> executeClick(service, recipeId, stepIndex, pkg, step, params)
        "setText" -> executeSetText(service, recipeId, stepIndex, pkg, step, params)
        "scroll" -> executeScroll(service, recipeId, stepIndex, pkg, step, params)
        else -> AppActDebugResult(false, "Unknown recipe step op \"${step.op}\" at step $stepIndex")
    }

    // ---- launch --------------------------------------------------------

    private fun executeLaunch(service: ShellyAccessibilityService, step: AppActRecipeStore.RecipeStep): AppActDebugResult {
        val target = step.target
            ?: return AppActDebugResult(false, "launch step missing target package")
        val timeoutMs = step.timeoutMs ?: LAUNCH_TIMEOUT_MS
        return if (ensureForeground(service, target, timeoutMs)) {
            AppActDebugResult(true, "$target foregrounded")
        } else {
            AppActDebugResult(false, "Could not bring $target to the foreground (not installed, didn't respond in time, or device locked)")
        }
    }

    /** Ports [ShellyAccessibilityService]'s former `ensureForeground`
     *  near-verbatim: lock-screen wall FIRST (safety-critical, must not be
     *  dropped — see the original doc comment for why: rootInActiveWindow
     *  only ever returns the keyguard while locked), then "already active"
     *  short-circuit, then launch intent + poll. Shared by [executeLaunch]
     *  (recipe `launch` steps) AND
     *  [ShellyAccessibilityService.debugSendLineMessage] (the one entry
     *  point with no recipe equivalent, since it deliberately skips
     *  search/navigate and needs the exact same "bring LINE back to
     *  whatever it was last showing" behavior tonight's hardcoded flow
     *  relied on). `internal` (not private) so that call site can reach
     *  it. */
    internal fun ensureForeground(service: ShellyAccessibilityService, targetPackage: String, timeoutMs: Long = LAUNCH_TIMEOUT_MS): Boolean {
        if (!LockPromptActivity.ensureUnlocked(service)) {
            return false
        }
        service.rootInActiveWindow?.let { current ->
            val alreadyActive = current.packageName?.toString() == targetPackage
            current.recycle()
            if (alreadyActive) return true
        }
        val launchIntent = service.packageManager.getLaunchIntentForPackage(targetPackage) ?: return false
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        service.startActivity(launchIntent)
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(POLL_INTERVAL_MS)
            service.rootInActiveWindow?.let { root ->
                val active = root.packageName?.toString() == targetPackage
                root.recycle()
                if (active) return true
            }
        }
        return false
    }

    // ---- click -----------------------------------------------------------

    private fun executeClick(
        service: ShellyAccessibilityService,
        recipeId: String,
        stepIndex: Int,
        pkg: String,
        step: AppActRecipeStore.RecipeStep,
        params: Map<String, String>,
    ): AppActDebugResult {
        val matcher = step.matcher
            ?: return AppActDebugResult(false, "click step at $stepIndex missing matcher")
        val substituted = substituteMatcher(matcher, params)
        val timeoutMs = step.timeoutMs ?: DEFAULT_STEP_TIMEOUT_MS
        var candidates = pollForCandidates(service, pkg, substituted, timeoutMs)

        // See RecipeStep.recoverOnZeroMatch's doc comment: launch/ensureForeground
        // resumes the target app's last task state, so the first navigational
        // click can start from a deeper screen or a scrolled list. Recovery is
        // ordered, bounded, and per-step opt-in.
        val recoveryActions = step.recoverOnZeroMatch.orEmpty()
        val recoveryNotes = mutableListOf<String>()
        for (action in recoveryActions) {
            if (candidates.isNotEmpty()) break
            val recovery = recoverZeroMatch(service, pkg, action)
            recoveryNotes.add(recovery.note)
            if (!recovery.shouldRepoll) break
            candidates = pollForCandidates(service, pkg, substituted, timeoutMs)
        }

        if (candidates.size == 1) {
            return performClick(service, pkg, candidates[0])
        }

        if (candidates.isEmpty()) {
            val fallback = resolveMatcherMiss(recipeId, stepIndex, step, service)
            if (fallback != null) return performClick(service, pkg, fallback)
            val diag = service.diagnoseCurrentScreen()
            val recoveryNote = if (recoveryNotes.isNotEmpty()) " (recoveries: ${recoveryNotes.joinToString(", ")})" else ""
            return AppActDebugResult(false, "Zero-match: no node under $pkg matched click step $stepIndex (${step.intent}) after ${timeoutMs}ms$recoveryNote.$diag")
        }

        val diag = service.diagnoseCurrentScreen()
        candidates.forEach { it.recycle() }
        return AppActDebugResult(false, "Ambiguous-multiple-match: ${candidates.size} nodes matched click step $stepIndex (${step.intent}) — refusing to guess, nothing was tapped.$diag")
    }

    private data class ZeroMatchRecovery(
        val shouldRepoll: Boolean,
        val note: String,
    )

    private data class ScrollableLookup(
        val foregroundMatches: Boolean,
        val foregroundPackage: String?,
        val node: AccessibilityNodeInfo?,
        val signature: String?,
    )

    private fun recoverZeroMatch(service: ShellyAccessibilityService, pkg: String, action: String): ZeroMatchRecovery =
        when (action) {
            "back" -> {
                if (pressBackIfStillForeground(service, pkg)) {
                    ZeroMatchRecovery(shouldRepoll = true, note = "back:ok")
                } else {
                    ZeroMatchRecovery(shouldRepoll = false, note = "back:foreground-mismatch-or-no-window")
                }
            }
            "scrollToTop" -> scrollForegroundToTop(service, pkg)
            else -> ZeroMatchRecovery(shouldRepoll = false, note = "unknown:$action")
        }

    /** `back` recovery action: fires the
     *  Android system BACK global action, but ONLY after re-confirming the
     *  foreground package still matches [pkg] immediately before acting —
     *  a back-press is state-changing (can dismiss a dialog, discard a
     *  draft, exit the app entirely) unlike a click on an already-resolved
     *  node, so it needs its own pre-action foreground check rather than
     *  relying on the next poll's package-mismatch tolerance (review
     *  finding, 2026-07-12). Returns false — and presses nothing — if the
     *  foreground has already drifted away from [pkg]; the caller treats
     *  that as "stop retrying," not "try again." A short sleep after a
     *  successful press lets the back-navigation settle before the caller
     *  re-polls. */
    private fun pressBackIfStillForeground(service: ShellyAccessibilityService, pkg: String): Boolean {
        val stillForeground = service.rootInActiveWindow?.let { r ->
            val ok = r.packageName?.toString() == pkg
            r.recycle()
            ok
        } ?: false
        if (!stillForeground) return false
        service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK)
        Thread.sleep(POLL_INTERVAL_MS)
        return true
    }

    /** `scrollToTop` recovery action: used when the desired node is absent
     *  because the target app's list is already visible but scrolled far
     *  enough that its header/search entry has left the accessibility tree.
     *
     *  The target node itself is missing, so this deliberately does NOT use
     *  the step matcher. Instead it picks the most likely vertical,
     *  high-content scrollable descendant of the current foreground root
     *  (favoring RecyclerView/ListView/ScrollView and penalizing short
     *  horizontal strips), then sends ACTION_SCROLL_BACKWARD up to a small
     *  fixed bound. `performAction` returning false is treated as "probably
     *  already at top"; a fresh-root signature check stops early if a widget
     *  keeps returning true without changing visible children. */
    private fun scrollForegroundToTop(service: ShellyAccessibilityService, pkg: String): ZeroMatchRecovery {
        var moved = 0
        var unchangedSamples = 0
        var previousSignature: String? = null

        repeat(SCROLL_TO_TOP_MAX_STEPS) {
            val before = findBestScrollableInForeground(service, pkg)
            if (!before.foregroundMatches) {
                before.node?.recycle()
                return ZeroMatchRecovery(
                    shouldRepoll = false,
                    note = "scrollToTop:foreground=${before.foregroundPackage ?: "none"}",
                )
            }
            val node = before.node
                ?: return ZeroMatchRecovery(shouldRepoll = true, note = "scrollToTop:no-scrollable")
            val beforeSignature = before.signature
            val ok = try {
                node.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
            } finally {
                node.recycle()
            }
            if (!ok) {
                return ZeroMatchRecovery(shouldRepoll = true, note = "scrollToTop:top-after-$moved")
            }

            moved++
            Thread.sleep(POLL_INTERVAL_MS)

            val after = findBestScrollableInForeground(service, pkg)
            if (!after.foregroundMatches) {
                after.node?.recycle()
                return ZeroMatchRecovery(
                    shouldRepoll = false,
                    note = "scrollToTop:foreground-after=${after.foregroundPackage ?: "none"}",
                )
            }
            val afterSignature = after.signature
            after.node?.recycle()
            if (afterSignature == beforeSignature || afterSignature == previousSignature) {
                unchangedSamples++
            } else {
                unchangedSamples = 0
            }
            previousSignature = afterSignature
            if (unchangedSamples >= SCROLL_STABLE_SAMPLES_TO_STOP) {
                return ZeroMatchRecovery(shouldRepoll = true, note = "scrollToTop:stable-after-$moved")
            }
        }

        return ZeroMatchRecovery(shouldRepoll = true, note = "scrollToTop:max-after-$moved")
    }

    private fun findBestScrollableInForeground(service: ShellyAccessibilityService, pkg: String): ScrollableLookup {
        val root = service.rootInActiveWindow
            ?: return ScrollableLookup(false, null, null, null)
        val foregroundPackage = root.packageName?.toString()
        if (foregroundPackage != pkg) {
            root.recycle()
            return ScrollableLookup(false, foregroundPackage, null, null)
        }
        val scrollable = findBestScrollableDescendant(root)
        val signature = scrollable?.let { scrollableSignature(it) }
        root.recycle()
        return ScrollableLookup(true, foregroundPackage, scrollable, signature)
    }

    private fun findBestScrollableDescendant(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        val candidates = mutableListOf<AccessibilityNodeInfo>()
        collectScrollableNodes(root, candidates)
        var best: AccessibilityNodeInfo? = null
        var bestScore = Int.MIN_VALUE
        for (candidate in candidates) {
            val score = scoreScrollableCandidate(root, candidate)
            if (score > bestScore) {
                best?.recycle()
                best = candidate
                bestScore = score
            } else {
                candidate.recycle()
            }
        }
        return best
    }

    private fun collectScrollableNodes(node: AccessibilityNodeInfo, out: MutableList<AccessibilityNodeInfo>) {
        if (node.isScrollable) {
            out.add(AccessibilityNodeInfo.obtain(node))
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            try {
                collectScrollableNodes(child, out)
            } finally {
                child.recycle()
            }
        }
    }

    private fun scoreScrollableCandidate(root: AccessibilityNodeInfo, node: AccessibilityNodeInfo): Int {
        val rootBounds = Rect()
        val bounds = Rect()
        root.getBoundsInScreen(rootBounds)
        node.getBoundsInScreen(bounds)

        val rootWidth = rootBounds.width().coerceAtLeast(1)
        val rootHeight = rootBounds.height().coerceAtLeast(1)
        val width = bounds.width().coerceAtLeast(0)
        val height = bounds.height().coerceAtLeast(0)
        val className = node.className?.toString().orEmpty()

        var score = height * 2 + width / 4
        if (className.contains("RecyclerView", ignoreCase = true)) score += 10_000
        if (className.contains("ListView", ignoreCase = true)) score += 8_000
        if (className.contains("ScrollView", ignoreCase = true)) score += 4_000
        if (height.toDouble() >= rootHeight * 0.35) score += 3_000
        if (width.toDouble() >= rootWidth * 0.60) score += 1_000
        if (height < minOf(160, rootHeight / 5)) score -= 5_000
        if (width > height * 2) score -= 2_000
        score += minOf(node.childCount, 8) * 250
        if (node.childCount <= 1) score -= 1_500
        return score
    }

    private fun scrollableSignature(node: AccessibilityNodeInfo): String {
        val bounds = Rect()
        node.getBoundsInScreen(bounds)
        val out = StringBuilder()
        out.append(node.className?.toString().orEmpty())
            .append('|')
            .append(rectSignature(bounds))
            .append('|')
            .append(node.childCount)

        val childSampleCount = minOf(node.childCount, 6)
        for (i in 0 until childSampleCount) {
            val child = node.getChild(i) ?: continue
            try {
                val childBounds = Rect()
                child.getBoundsInScreen(childBounds)
                out.append('|')
                    .append(child.className?.toString().orEmpty())
                    .append(':')
                    .append(child.viewIdResourceName.orEmpty())
                    .append(':')
                    .append(child.text?.toString()?.take(32).orEmpty())
                    .append(':')
                    .append(child.contentDescription?.toString()?.take(32).orEmpty())
                    .append(':')
                    .append(rectSignature(childBounds))
            } finally {
                child.recycle()
            }
        }
        return out.toString()
    }

    private fun rectSignature(rect: Rect): String =
        "${rect.left},${rect.top},${rect.right},${rect.bottom}"

    /** [node] is caller-owned going in; always recycled (directly or via
     *  [findClickableAncestor]'s ancestor-walk) by the time this returns. */
    private fun performClick(service: ShellyAccessibilityService, pkg: String, node: AccessibilityNodeInfo): AppActDebugResult {
        val stillForeground = service.rootInActiveWindow?.let { r ->
            val ok = r.packageName?.toString() == pkg
            r.recycle()
            ok
        } ?: false
        if (!stillForeground) {
            node.recycle()
            return AppActDebugResult(false, "Foreground app changed away from $pkg before tapping the matched node")
        }

        val clickable = findClickableAncestor(node, 4)
        if (clickable == null) {
            node.recycle()
            return AppActDebugResult(false, "Matched node found but has no clickable ancestor within 4 levels")
        }
        val ok = try {
            clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        } finally {
            if (clickable !== node) node.recycle()
            clickable.recycle()
        }
        return if (ok) AppActDebugResult(true, "Clicked") else AppActDebugResult(false, "performAction(ACTION_CLICK) failed")
    }

    // ---- setText -----------------------------------------------------------

    private fun executeSetText(
        service: ShellyAccessibilityService,
        recipeId: String,
        stepIndex: Int,
        pkg: String,
        step: AppActRecipeStore.RecipeStep,
        params: Map<String, String>,
    ): AppActDebugResult {
        val matcher = step.matcher
            ?: return AppActDebugResult(false, "setText step at $stepIndex missing matcher")
        val paramName = step.param
            ?: return AppActDebugResult(false, "setText step at $stepIndex missing param")
        val rawValue = params[paramName]
            ?: return AppActDebugResult(false, "setText step at $stepIndex references unknown param \"$paramName\"")
        val value = substitute(rawValue, params)
        val substituted = substituteMatcher(matcher, params)
        val timeoutMs = step.timeoutMs ?: DEFAULT_STEP_TIMEOUT_MS
        val candidates = pollForCandidates(service, pkg, substituted, timeoutMs)

        if (candidates.size == 1) {
            return performSetText(service, pkg, candidates[0], value)
        }

        if (candidates.isEmpty()) {
            val fallback = resolveMatcherMiss(recipeId, stepIndex, step, service)
            if (fallback != null) return performSetText(service, pkg, fallback, value)
            val diag = service.diagnoseCurrentScreen()
            return AppActDebugResult(false, "Zero-match: no node under $pkg matched setText step $stepIndex (${step.intent}) after ${timeoutMs}ms.$diag")
        }

        val diag = service.diagnoseCurrentScreen()
        candidates.forEach { it.recycle() }
        return AppActDebugResult(false, "Ambiguous-multiple-match: ${candidates.size} nodes matched setText step $stepIndex (${step.intent}) — refusing to guess, nothing was typed.$diag")
    }

    /** [node] is caller-owned going in; always recycled by the time this
     *  returns (no ancestor-walk for setText — matches the original file's
     *  contract). */
    private fun performSetText(service: ShellyAccessibilityService, pkg: String, node: AccessibilityNodeInfo, value: String): AppActDebugResult {
        try {
            val stillForeground = service.rootInActiveWindow?.let { r ->
                val ok = r.packageName?.toString() == pkg
                r.recycle()
                ok
            } ?: false
            if (!stillForeground) {
                return AppActDebugResult(false, "Foreground app changed away from $pkg before typing into the matched node")
            }
            if (!node.isEditable) {
                return AppActDebugResult(false, "Matched node is not editable, refusing to setText")
            }
            val args = Bundle()
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
            val ok = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
            return if (ok) AppActDebugResult(true, "Typed") else AppActDebugResult(false, "performAction(ACTION_SET_TEXT) failed")
        } finally {
            node.recycle()
        }
    }

    // ---- scroll (untested — no current recipe exercises this; kept simple) --

    private fun executeScroll(
        service: ShellyAccessibilityService,
        recipeId: String,
        stepIndex: Int,
        pkg: String,
        step: AppActRecipeStore.RecipeStep,
        params: Map<String, String>,
    ): AppActDebugResult {
        val matcher = step.matcher
            ?: return AppActDebugResult(false, "scroll step at $stepIndex missing matcher")
        val substituted = substituteMatcher(matcher, params)
        val timeoutMs = step.timeoutMs ?: DEFAULT_STEP_TIMEOUT_MS
        val candidates = pollForCandidates(service, pkg, substituted, timeoutMs)

        if (candidates.size != 1) {
            val diag = service.diagnoseCurrentScreen()
            candidates.forEach { it.recycle() }
            return if (candidates.isEmpty()) {
                AppActDebugResult(false, "Zero-match: no node under $pkg matched scroll step $stepIndex (${step.intent}) after ${timeoutMs}ms.$diag")
            } else {
                AppActDebugResult(false, "Ambiguous-multiple-match: ${candidates.size} nodes matched scroll step $stepIndex (${step.intent}) — refusing to guess, nothing was scrolled.$diag")
            }
        }

        val node = candidates[0]
        val stillForeground = service.rootInActiveWindow?.let { r ->
            val ok = r.packageName?.toString() == pkg
            r.recycle()
            ok
        } ?: false
        if (!stillForeground) {
            node.recycle()
            return AppActDebugResult(false, "Foreground app changed away from $pkg before scrolling")
        }

        val scrollable = findAncestor(node, 4) { it.isScrollable }
        if (scrollable == null) {
            node.recycle()
            return AppActDebugResult(false, "Matched node found but has no scrollable ancestor within 4 levels")
        }
        val ok = try {
            scrollable.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
        } finally {
            if (scrollable !== node) node.recycle()
            scrollable.recycle()
        }
        return if (ok) AppActDebugResult(true, "Scrolled") else AppActDebugResult(false, "performAction(ACTION_SCROLL_FORWARD) failed")
    }

    // ---- shared polling / matching primitives ---------------------------

    /** THE single node/candidate-list resolution primitive for every step.
     *  Generalizes what used to be three separate hand-written pollers in
     *  [ShellyAccessibilityService] (`pollForNodeByResourceId`,
     *  `pollForNodeByContentDescription`, `pollForStableLineSearchResults`).
     *
     *  Two phases, deliberately kept separate (2026-07-12 review fix):
     *  1. [pollStructural] polls using every [matcher] field EXCEPT [text]
     *     until that STRUCTURAL candidate list is non-zero and
     *     size-stable, or [timeoutMs] elapses.
     *  2. If [matcher.text] is non-null, it is applied as a filter AFTER
     *     structural stability is reached — never as part of what
     *     determines stability.
     *
     *  Phase 1/2 must stay separate: determining "stability" against an
     *  ALREADY text-filtered set would hide a second, identically-named
     *  candidate that renders on a delay — e.g. LINE search results for a
     *  duplicate-named contact/group — silently defeating the zero/multiple
     *  exact-match safety check `text` filtering exists to enforce. The
     *  original hand-written `pollForStableLineSearchResults` collected
     *  every unfiltered `name_text_view` row and waited for THAT raw count
     *  to stabilize before separately counting exact-text matches; this is
     *  that same two-phase shape, generalized. For a matcher with no
     *  [text] field (the common case — resourceId/contentDescription/label
     *  lookups), phase 2 is a no-op and behavior is unchanged from a
     *  single-phase poll. */
    private fun pollForCandidates(service: ShellyAccessibilityService, pkg: String, matcher: AppActRecipeStore.Matcher, timeoutMs: Long): List<AccessibilityNodeInfo> {
        val structural = pollStructural(service, pkg, matcher, timeoutMs)
        val text = matcher.text ?: return structural
        val matched = mutableListOf<AccessibilityNodeInfo>()
        for (node in structural) {
            if (nodeMatchesText(node, text)) matched.add(node) else node.recycle()
        }
        return matched
    }

    /** Polls on every [AppActRecipeStore.Matcher] field EXCEPT [text] (see
     *  [pollForCandidates]) until the result count is non-zero AND
     *  unchanged across two consecutive [POLL_INTERVAL_MS] samples, or
     *  [timeoutMs] elapses. Deliberately never treats an all-zero streak as
     *  "stable" (ported from `pollForStableLineSearchResults`'s 2026-07-12
     *  fix) — a persistent zero-match always costs the full [timeoutMs],
     *  matching every other poller's "never fail fast on absence"
     *  philosophy. Re-checks the foreground package on EVERY iteration (a
     *  root snapshot whose package doesn't match [pkg] counts as "not
     *  ready yet", i.e. empty, not an error). Recycles every discarded
     *  intermediate sample; the caller owns recycling whatever list is
     *  finally returned. */
    private fun pollStructural(service: ShellyAccessibilityService, pkg: String, matcher: AppActRecipeStore.Matcher, timeoutMs: Long): List<AccessibilityNodeInfo> {
        val deadline = System.currentTimeMillis() + timeoutMs
        var previous: List<AccessibilityNodeInfo>? = null
        while (System.currentTimeMillis() < deadline) {
            val root = service.rootInActiveWindow
            val snapshot = if (root != null && root.packageName?.toString() == pkg) {
                val out = mutableListOf<AccessibilityNodeInfo>()
                val rootConsumed = collectMatchingNodes(root, matcher, out)
                if (!rootConsumed) root.recycle()
                out
            } else {
                root?.recycle()
                emptyList()
            }
            val prev = previous
            if (prev != null && prev.isNotEmpty() && prev.size == snapshot.size) {
                prev.forEach { it.recycle() }
                return snapshot
            }
            prev?.forEach { it.recycle() }
            previous = snapshot
            Thread.sleep(POLL_INTERVAL_MS)
        }
        return previous ?: emptyList()
    }

    /** Recursively collects every descendant of [node] that
     *  [nodeMatchesStructural] [matcher] into [out] (the [Matcher.text]
     *  field, if any, is NOT applied here — see [pollForCandidates]).
     *  Returns true iff [node] itself was appended (so the caller knows
     *  not to also recycle it). Every visited node NOT appended to [out]
     *  is recycled before returning; nodes appended to [out] are owned by
     *  the caller. Mirrors `collectNodesByResourceId`'s exact contract,
     *  generalized to [AppActRecipeStore.Matcher]'s structural fields. */
    private fun collectMatchingNodes(node: AccessibilityNodeInfo, matcher: AppActRecipeStore.Matcher, out: MutableList<AccessibilityNodeInfo>): Boolean {
        if (nodeMatchesStructural(node, matcher)) {
            out.add(node)
            return true
        }
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val consumed = collectMatchingNodes(child, matcher, out)
            if (!consumed) child.recycle()
        }
        return false
    }

    /** Matches every field of [matcher] EXCEPT [Matcher.text] — see
     *  [pollForCandidates]'s doc comment for why `text` is deliberately
     *  excluded from the "structural" matcher used to determine polling
     *  stability. */
    private fun nodeMatchesStructural(node: AccessibilityNodeInfo, matcher: AppActRecipeStore.Matcher): Boolean {
        if (matcher.resourceId != null && node.viewIdResourceName != matcher.resourceId) return false
        if (matcher.contentDescription != null && node.contentDescription?.toString() != matcher.contentDescription) return false
        if (matcher.label != null && node.contentDescription?.toString() != matcher.label && node.text?.toString() != matcher.label) return false
        return true
    }

    private fun nodeMatchesText(node: AccessibilityNodeInfo, text: String): Boolean =
        node.text?.toString()?.equals(text, ignoreCase = true) == true

    /** Substitutes every `{{name}}` placeholder in [matcher.text] with
     *  `params[name]` (literal string replace, no regex) — the only field
     *  of [AppActRecipeStore.Matcher] that ever carries a template. */
    private fun substituteMatcher(matcher: AppActRecipeStore.Matcher, params: Map<String, String>): AppActRecipeStore.Matcher =
        if (matcher.text == null) matcher else matcher.copy(text = substitute(matcher.text, params))

    private fun substitute(template: String, params: Map<String, String>): String {
        var result = template
        for ((key, value) in params) {
            result = result.replace("{{$key}}", value)
        }
        return result
    }

    /** Walks up from [node] via [AccessibilityNodeInfo.getParent] (up to
     *  [maxLevels] ancestors) looking for the first node matching
     *  [predicate], [node] itself included. Does NOT recycle [node] itself
     *  (caller-owned); every intermediate parent fetched along the way
     *  that is NOT the returned node is recycled before returning. Returns
     *  null (having recycled every parent visited) if no match is found
     *  within [maxLevels]. Ported from [ShellyAccessibilityService]'s
     *  former `findClickableAncestor`, generalized with a predicate so
     *  both [findClickableAncestor] and the scroll step's ancestor-walk
     *  share one implementation. */
    private fun findAncestor(node: AccessibilityNodeInfo, maxLevels: Int, predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (predicate(node)) return node
        var current = node
        var ownsCurrent = false
        repeat(maxLevels) {
            val parent = current.parent
            if (ownsCurrent) current.recycle()
            if (parent == null) return null
            if (predicate(parent)) return parent
            current = parent
            ownsCurrent = true
        }
        if (ownsCurrent) current.recycle()
        return null
    }

    private fun findClickableAncestor(node: AccessibilityNodeInfo, maxLevels: Int = 4): AccessibilityNodeInfo? =
        findAncestor(node, maxLevels) { it.isClickable }

    /** Track 3 (LLM fallback) stub — always returns null (fail closed,
     *  identical to today's zero-match behavior). This is the ONLY
     *  function Track 3 will need to fill in later; [executeClick] /
     *  [executeSetText] / [executeScroll]'s control flow must not need to
     *  change when that happens. */
    private fun resolveMatcherMiss(recipeId: String, stepIndex: Int, step: AppActRecipeStore.RecipeStep, service: ShellyAccessibilityService): AccessibilityNodeInfo? = null
}
