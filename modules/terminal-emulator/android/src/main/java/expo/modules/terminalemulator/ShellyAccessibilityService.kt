package expo.modules.terminalemulator

import android.accessibilityservice.AccessibilityService
import android.os.Bundle
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * UI-AUTOMATION-001 / app.act.
 *
 * Originally a throwaway observe-only diagnostic (dump the node tree, prove
 * LINE's key elements carry stable resourceId/contentDescription values —
 * see DEFERRED.md's continuation-25 entry, confirmed: `chat_ui_message_edit`
 * for the input field, `chat_ui_send_button_image` for send), then grew a
 * narrow hardcoded action capability (Milestone 0), then Track 1's
 * hand-written search/navigate flow for LINE. As of the 2026-07-12
 * implementation-detail plan (docs/superpowers/specs/2026-07-11-app-act
 * -design.md, 2026-07-11-post-ui-automation-agent-architecture.md), the
 * general recipe/step-walker engine (see [AppActExecutor] and
 * [AppActRecipeStore]) now does the node-finding/polling/clicking work;
 * this file keeps only what has no recipe equivalent:
 * [debugSendLineMessage] (sends into whatever LINE conversation is already
 * open — no search/navigate step, so it can't be expressed as one of the
 * bundled recipes) plus the AccessibilityService lifecycle/diagnostics
 * machinery every entry point (recipe-driven or not) depends on
 * ([rootInActiveWindow] access, [diagnoseCurrentScreen],
 * [summarizeClickableCandidates], [dumpNode], [activeInstance]).
 * [debugSendLineMessageToContact] and [debugPostToX] are now thin wrappers
 * around [AppActExecutor.execute] running the bundled `line.send-message`
 * / `x.post` recipes.
 *
 * All three debug entry points remain deliberately NOT wired into the
 * agent/PlanSpec pipeline — only reachable from temporary debug buttons
 * (SettingsDropdown.tsx's AppActDebugSection) that a human taps directly.
 *
 * Scoped to an explicit package allowlist (see LINE_PACKAGE/X_PACKAGE
 * below) — this is not a general screen-reader and should never receive
 * events from arbitrary apps. Requires a MANUAL one-time grant in Android
 * Settings -> Accessibility (or SHELL-001's `settings put secure
 * enabled_accessibility_services`, verified working on-device 2026-07-11).
 */
class ShellyAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "ShellyA11yDump"

        // LINE's real Android package name (well-established public fact,
        // stable across LINE's own app history).
        private const val LINE_PACKAGE = "jp.naver.line.android"

        // X's (formerly Twitter's) Android package name — the app kept its
        // original com.twitter.android package through the rebrand.
        private const val X_PACKAGE = "com.twitter.android"

        /** Live reference to the connected service instance, set/cleared in
         *  [onServiceConnected]/[onDestroy] — same pattern as
         *  ShellyNotificationListener.activeInstance. Null whenever the
         *  service isn't currently bound (OS toggle off, or not yet
         *  connected). Callers (TerminalEmulatorModule) must null-check. */
        @Volatile
        var activeInstance: ShellyAccessibilityService? = null

        // findNodeByContentDescription / collectNodesByResourceId /
        // findClickableAncestor / pollForNodeByResourceId /
        // pollForNodeByContentDescription / pollForStableLineSearchResults /
        // ensureForeground and the companion `busy` guard were ported into
        // AppActExecutor.kt (Track 2's generic pollForCandidates +
        // findClickableAncestor + ensureForeground + runGuarded) and removed
        // from here — see docs/superpowers/specs/2026-07-11-app-act-design.md
        // and the 2026-07-12 implementation-detail plan.

        /** Recursively finds the first descendant (or the node itself)
         *  whose viewIdResourceName exactly matches [resourceId]. Every
         *  visited node that is NOT the match is recycled before returning;
         *  the caller owns recycling the returned node. Kept (unlike its
         *  former siblings above) because [sendLineMessageOnCurrentScreen]
         *  — the one send-flow with no recipe equivalent — still needs a
         *  single first-match node lookup and the plan requires that
         *  function to stay "essentially unchanged" rather than routing
         *  through AppActExecutor's generic (and slower, poll-based)
         *  candidate collector for this simple case. */
        private fun findNodeByResourceId(node: AccessibilityNodeInfo, resourceId: String): AccessibilityNodeInfo? {
            if (node.viewIdResourceName == resourceId) return node
            for (i in 0 until node.childCount) {
                val child = node.getChild(i) ?: continue
                val found = findNodeByResourceId(child, resourceId)
                if (found != null) {
                    if (found !== child) child.recycle()
                    return found
                }
                child.recycle()
            }
            return null
        }

        /** Diagnostic-only, added 2026-07-12: walks [node] (a freshly-fetched
         *  root) up to [maxDepth] levels and collects a terse one-line-per-node
         *  summary of every CLICKABLE descendant that has non-blank text or
         *  contentDescription, capped at [maxCount] entries. This exists to
         *  enrich a fail-closed message with what's actually on screen right
         *  now, in place of a real on-device uiautomator dump — remote
         *  debugging sessions on this project have no adb/logcat access path,
         *  so [dumpNode]'s always-on logcat trail (tag "ShellyA11yDump") isn't
         *  reachable; this surfaces the same kind of data through the existing
         *  AppActDebugResult.message -> Alert/Toast plumbing instead. Recycles
         *  every node it visits except [node] itself (caller-owned, matching
         *  this file's usual convention). Remove once the "検索" contentDescription
         *  assumption this was added to investigate is confirmed/replaced. */
        private fun summarizeClickableCandidates(node: AccessibilityNodeInfo, maxDepth: Int, maxCount: Int, out: MutableList<String> = mutableListOf()): List<String> {
            if (out.size < maxCount) {
                if (node.isClickable) {
                    val resId = node.viewIdResourceName?.substringAfterLast('/')?.take(24) ?: ""
                    val desc = node.contentDescription?.toString()?.take(18) ?: ""
                    val text = node.text?.toString()?.take(18) ?: ""
                    if (resId.isNotEmpty() || desc.isNotEmpty() || text.isNotEmpty()) {
                        out.add("id=$resId desc=\"$desc\" text=\"$text\"")
                    }
                }
                if (maxDepth > 0) {
                    for (i in 0 until node.childCount) {
                        if (out.size >= maxCount) break
                        val child = node.getChild(i) ?: continue
                        summarizeClickableCandidates(child, maxDepth - 1, maxCount, out)
                        child.recycle()
                    }
                }
            }
            return out
        }

    }

    /** Diagnostic-only, added 2026-07-12 (see [summarizeClickableCandidates]'s
     *  doc comment for why this exists in place of a real uiautomator dump).
     *  Fetches a fresh [rootInActiveWindow] snapshot and appends a compact
     *  summary of its foreground package plus up to 10 clickable
     *  candidates to a failure message. Safe to call with no active window
     *  (returns a short "no active window" note instead). `internal` (not
     *  private) so [AppActExecutor] can call it too, to enrich its own
     *  zero/ambiguous-match failure messages the same way this file's
     *  hand-written flows always have. */
    internal fun diagnoseCurrentScreen(): String {
        val root = rootInActiveWindow ?: return " (no active window right now)"
        return try {
            val pkg = root.packageName?.toString() ?: "?"
            val candidates = summarizeClickableCandidates(root, 6, 10)
            " Current foreground pkg=$pkg. Clickable candidates: " +
                if (candidates.isEmpty()) "(none with text/desc)" else candidates.joinToString(" | ")
        } finally {
            root.recycle()
        }
    }

    // pollForStableLineSearchResults was ported into AppActExecutor.kt as
    // the generic pollForCandidates (see that file's doc comment for the
    // exact "never treat an all-zero streak as stable" fix this preserves).

    /** app.act Milestone 0's entire action surface: type [text] into LINE's
     *  message field and tap send, against whatever conversation is
     *  currently foregrounded. Has no recipe equivalent (both bundled
     *  recipes always search/navigate first) — kept as a standalone
     *  hand-written entry point, routed through
     *  [AppActExecutor.runGuarded]/[AppActExecutor.ensureForeground] so it
     *  shares the same single re-entrancy guard and foreground-bringing
     *  logic every recipe-driven run uses, rather than duplicating either.
     *  Fails closed with a specific reason at every step — including on an
     *  unexpected exception (node traversal / performAction() on a stale/
     *  disconnected node is not assumed exception-free, matching
     *  ShellyNotificationListener's convention of never letting
     *  AccessibilityService/NotificationListenerService calls throw past
     *  this boundary) — rather than crashing or propagating an
     *  uninformative rejection. */
    fun debugSendLineMessage(text: String): AppActDebugResult = AppActExecutor.runGuarded {
        if (!AppActExecutor.ensureForeground(this, LINE_PACKAGE)) {
            AppActDebugResult(false, "Could not bring LINE to the foreground (not installed, or didn't respond in time)")
        } else {
            sendLineMessageOnCurrentScreen(text)
        }
    }

    /** The post-navigation portion of Milestone 0's send flow — kept
     *  essentially unchanged (per the app.act implementation-detail plan)
     *  as the one piece of send logic with no recipe equivalent, since
     *  [debugSendLineMessage] deliberately sends into whatever LINE
     *  conversation is already open rather than searching/navigating
     *  first. */
    private fun sendLineMessageOnCurrentScreen(text: String): AppActDebugResult {
        val root = rootInActiveWindow
            ?: return AppActDebugResult(false, "No active window when attempting to send")
        try {
            if (root.packageName?.toString() != LINE_PACKAGE) {
                return AppActDebugResult(false, "Foreground app is not LINE when attempting to send (found ${root.packageName})")
            }
            val inputNode = findNodeByResourceId(root, "$LINE_PACKAGE:id/chat_ui_message_edit")
                ?: return AppActDebugResult(false, "Message input field not found — is a LINE conversation open?")
            try {
                val setTextArgs = Bundle()
                setTextArgs.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
                val setOk = inputNode.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, setTextArgs)
                if (!setOk) return AppActDebugResult(false, "performAction(ACTION_SET_TEXT) failed")
            } finally {
                // inputNode may be identical to `root` itself (findNodeByResourceId
                // returns the root unchanged if IT is the match) — the outer
                // `finally` below recycles `root` unconditionally, so recycling
                // here too would double-recycle the same object on API <33
                // (minSdkVersion 24; recycle() only became a no-op around API 33).
                if (inputNode !== root) inputNode.recycle()
            }

            // Re-fetch: the send button's contentDescription flips once text
            // is present (continuation-25's finding), so the tree may have
            // changed since `root` was captured.
            val root2 = rootInActiveWindow
                ?: return AppActDebugResult(false, "Window disappeared after setText")
            try {
                // LINE may have navigated internally between setText and here
                // (share sheet, incoming-call overlay, a deep link reopening a
                // different chat) — re-assert we're still looking at LINE
                // before blindly tapping whatever now matches the send
                // button's resourceId.
                if (root2.packageName?.toString() != LINE_PACKAGE) {
                    return AppActDebugResult(false, "Foreground app changed away from LINE mid-action (found ${root2.packageName})")
                }
                val sendNode = findNodeByResourceId(root2, "$LINE_PACKAGE:id/chat_ui_send_button_image")
                    ?: return AppActDebugResult(false, "Send button not found after setText")
                try {
                    val clickOk = sendNode.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    return if (clickOk) {
                        AppActDebugResult(true, "Sent")
                    } else {
                        AppActDebugResult(false, "performAction(ACTION_CLICK) failed")
                    }
                } finally {
                    if (sendNode !== root2) sendNode.recycle()
                }
            } finally {
                root2.recycle()
            }
        } finally {
            root.recycle()
        }
    }

    /** app.act Track 1 (navigation): types [message] into LINE's message
     *  field and taps send, after first navigating to [targetName]'s
     *  conversation via LINE's search screen. Now a thin wrapper around
     *  [AppActExecutor.execute] running the bundled `line.send-message`
     *  recipe — the hand-written search/match/click flow this used to
     *  contain moved to that recipe + AppActExecutor.kt's generic walker.
     *  Trims [targetName] and rejects an empty result up front (preserved
     *  from the original hand-written flow) — this is call-specific input
     *  validation, not something the generic recipe engine should own. */
    fun debugSendLineMessageToContact(targetName: String, message: String): AppActDebugResult {
        val trimmedTarget = targetName.trim()
        if (trimmedTarget.isEmpty()) {
            return AppActDebugResult(false, "Target contact/conversation name is empty")
        }
        return AppActExecutor.execute(this, applicationContext, "line.send-message", mapOf("contact" to trimmedTarget, "message" to message))
    }

    /** app.act Milestone 0's X (Twitter) action surface: type [text] into
     *  the compose screen's body field and tap post. Now a thin wrapper
     *  around [AppActExecutor.execute] running the bundled `x.post`
     *  recipe. */
    fun debugPostToX(text: String): AppActDebugResult =
        AppActExecutor.execute(this, applicationContext, "x.post", mapOf("text" to text))

    override fun onServiceConnected() {
        super.onServiceConnected()
        activeInstance = this
    }

    override fun onDestroy() {
        super.onDestroy()
        // Identity guard: if the OS ever creates a new instance (setting
        // activeInstance = B) before this (old) instance's onDestroy fires
        // — overlapping lifecycles during a service restart/rebind — this
        // must not null out the live B reference.
        if (activeInstance === this) {
            activeInstance = null
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val pkg = event.packageName?.toString() ?: return
        if (pkg != LINE_PACKAGE && pkg != X_PACKAGE) return

        val eventTypeName = AccessibilityEvent.eventTypeToString(event.eventType)
        Log.i(TAG, "==== event=$eventTypeName pkg=$pkg ====")

        val root = rootInActiveWindow ?: run {
            Log.i(TAG, "rootInActiveWindow is null, nothing to dump")
            return
        }
        dumpNode(root, 0)
        root.recycle()
    }

    /**
     * Recursively logs each node's class name, resourceId, contentDescription,
     * text, and clickable/editable flags. Deliberately verbose (one log line
     * per node) — this is a short-lived manual diagnostic session, not
     * something that runs continuously in production.
     */
    private fun dumpNode(node: AccessibilityNodeInfo, depth: Int) {
        val indent = "  ".repeat(depth)
        val resId = node.viewIdResourceName ?: "-"
        val desc = node.contentDescription?.toString()?.take(60) ?: "-"
        val text = node.text?.toString()?.take(60) ?: "-"
        val cls = node.className?.toString() ?: "-"
        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)
        Log.i(
            TAG,
            "$indent[$cls] id=$resId desc=\"$desc\" text=\"$text\" " +
                "clickable=${node.isClickable} editable=${node.isEditable} bounds=$bounds",
        )
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            dumpNode(child, depth + 1)
            child.recycle()
        }
    }

    override fun onInterrupt() {
        Log.i(TAG, "onInterrupt")
    }
}

/** Result of [ShellyAccessibilityService.debugSendLineMessage] /
 *  [ShellyAccessibilityService.debugSendLineMessageToContact] /
 *  [ShellyAccessibilityService.debugPostToX] — [message] is always a
 *  specific, human-readable reason (success or the exact precondition that
 *  failed), never a generic "failed". */
data class AppActDebugResult(val success: Boolean, val message: String)
