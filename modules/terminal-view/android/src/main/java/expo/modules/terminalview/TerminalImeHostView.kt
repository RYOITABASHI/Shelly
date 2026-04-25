package expo.modules.terminalview

import android.app.Activity
import android.content.Context
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import com.termux.view.TerminalView

/**
 * TerminalImeHostView — single stable IME-editor view for the Activity.
 *
 * Problem it solves (bug #116, 2026-04-24/25 on-device verification):
 * With each pane's `TerminalView` declaring `onCheckIsTextEditor() = true`,
 * Samsung OneUI 6/7 (Android 14-16) fails to migrate IMM's `mServedView`
 * when focus moves between sibling panes. `requestFocus`, `clearFocus`,
 * `hideSoftInputFromWindow`, `postDelayed` retries, WeakReference
 * trackers, and reflection-based `focusOut` all failed to reset
 * `mServedView`. IMM keeps routing keystrokes + IME composition
 * (including Japanese setComposingText) to the stale sibling — input
 * "dies" from the user's perspective.
 *
 * Architectural fix (Codex insight): IMM only hands `mServedView`
 * between views during an explicit focus transfer. If only ONE view
 * in the window ever claims to be an IME editor, IMM has nothing to
 * migrate to. The host view stays bound forever; the "active pane"
 * is just a field on the host that gets swapped on tap. A
 * `restartInput(host)` call rebuilds the InputConnection so CJK
 * composition is reset cleanly across pane switches.
 *
 * Attach once per Activity at the `android.R.id.content` FrameLayout.
 * The host view itself is a 1×1 invisible View — it never takes any
 * rendering surface, only IME bookkeeping.
 */
class TerminalImeHostView private constructor(context: Context) : View(context) {

    /** Currently selected TerminalView whose session receives IME events. */
    var activeTerminal: TerminalView? = null

    init {
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val t = activeTerminal ?: return null
        return t.createDelegatingInputConnection(outAttrs)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val t = activeTerminal
        return (t != null && t.dispatchKeyEvent(event)) || super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        val t = activeTerminal
        return (t != null && t.dispatchKeyEvent(event)) || super.onKeyUp(keyCode, event)
    }

    companion object {
        private const val TAG = "TerminalImeHost"

        @Volatile
        private var instance: TerminalImeHostView? = null

        /**
         * Attach (or return the existing) host view for this Activity.
         * Safe to call from any TerminalView init — idempotent.
         */
        fun ensureAttached(context: Context): TerminalImeHostView? {
            instance?.let { return it }
            synchronized(this) {
                instance?.let { return it }
                val activity = resolveActivity(context) ?: run {
                    Log.w(TAG, "ensureAttached: context has no Activity; IME host disabled")
                    return null
                }
                val contentRoot = activity.findViewById<ViewGroup>(android.R.id.content)
                    ?: run {
                        Log.w(TAG, "ensureAttached: android.R.id.content missing")
                        return null
                    }
                val host = TerminalImeHostView(context)
                val lp = FrameLayout.LayoutParams(1, 1).apply {
                    // Pin to top-left, off the interactive area.
                    // Host view is invisible to users; only IMM cares
                    // about its existence and focus state.
                }
                contentRoot.addView(host, 0, lp)
                instance = host
                Log.i(TAG, "host attached to android.R.id.content hash=${System.identityHashCode(host)}")
                return host
            }
        }

        /**
         * Swap the host's active terminal and force IMM to re-read
         * editor info. Typically called from a pane's onSingleTapUp.
         */
        fun bindToTerminal(tv: TerminalView) {
            val host = instance ?: run {
                Log.w(TAG, "bindToTerminal: host not attached; skipping")
                return
            }
            host.activeTerminal = tv
            // Give the host focus if it doesn't already have it. IMM
            // needs `mServedView == host` for the next restartInput
            // to actually refresh the connection.
            if (!host.isFocused) {
                host.requestFocus()
            }
            val imm = host.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
            imm?.restartInput(host)
            Log.i(TAG, "bindToTerminal active=${System.identityHashCode(tv)} hostFocused=${host.isFocused}")
        }

        /**
         * Show the soft keyboard via the host. Fallbacks preserve
         * behaviour on devices where the implicit show is dropped.
         */
        fun showKeyboard(reason: String): Boolean {
            val host = instance ?: return false
            val imm = host.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                ?: return false
            if (!host.isFocused) host.requestFocus()
            val shown = imm.showSoftInput(host, InputMethodManager.SHOW_IMPLICIT)
            Log.i(TAG, "showKeyboard($reason) shown=$shown")
            return shown
        }

        /** Unbind a terminal if it was the active one — called from destroy(). */
        fun unbindIfActive(tv: TerminalView) {
            val host = instance ?: return
            if (host.activeTerminal === tv) {
                host.activeTerminal = null
                val imm = host.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                imm?.restartInput(host)
                Log.i(TAG, "unbindIfActive cleared active terminal")
            }
        }

        private fun resolveActivity(context: Context): Activity? {
            var c: Context? = context
            while (c != null) {
                if (c is Activity) return c
                c = (c as? android.content.ContextWrapper)?.baseContext
            }
            return null
        }
    }
}
