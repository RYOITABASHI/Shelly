package expo.modules.terminalview

import android.app.Activity
import android.content.Context
import android.os.Looper
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
 * with each pane's `TerminalView` declaring `onCheckIsTextEditor() = true`,
 * Samsung OneUI 6/7 (Android 14-16) fails to migrate IMM's `mServedView`
 * when focus moves between sibling panes. Every attempted workaround
 * (post/clearFocus, WeakReference tracker, reflection-based focusOut,
 * hide+show postDelayed retries) failed to reset mServedView — IMM kept
 * routing keystrokes and CJK composition to the stale sibling.
 *
 * Architectural fix (Codex, refined 2026-04-25): if only ONE view in the
 * window ever claims to be an IME editor, IMM has nothing to migrate to.
 * The host stays bound forever; the "active pane" is just a field on the
 * host that gets swapped on tap. `restartInput(host)` rebuilds the
 * InputConnection so CJK composition is reset cleanly.
 *
 * Attached once per Activity at `android.R.id.content`, position 0 so
 * it's behind normal content. Rendered with `alpha = 0f` (kept
 * hit-testable + focusable + attached, just not visible) rather than
 * INVISIBLE/GONE, which would break focus/IMM eligibility.
 */
class TerminalImeHostView private constructor(context: Context) : View(context) {

    private var activeTerminal: TerminalView? = null

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        isClickable = false
        // Not visible to the user but remains a fully-attached focusable
        // editor as far as IMM is concerned. GONE/INVISIBLE would take
        // it out of the focus chain and IMM might refuse to serve it.
        alpha = 0f
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    fun bindToTerminal(terminal: TerminalView) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            post { bindToTerminal(terminal) }
            return
        }
        activeTerminal = terminal
        if (!isAttachedToWindow) {
            Log.i(TAG, "bindToTerminal: host not attached yet, deferring focus/IMM")
            return
        }
        // Intentionally steals Android view focus from the pane — this
        // is the whole point of the design. Pane "active" state lives
        // separately on the React side and in TerminalImeHostView's
        // activeTerminal field, not in Android's view-focus tree.
        requestFocusFromTouch()
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.restartInput(this)
        imm?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
        Log.i(TAG, "bindToTerminal active=${System.identityHashCode(terminal)} hostFocused=$isFocused")
    }

    fun unbindIfActive(terminal: TerminalView) {
        if (activeTerminal === terminal) {
            activeTerminal = null
            val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
            imm?.restartInput(this)
            Log.i(TAG, "unbindIfActive cleared active terminal")
        }
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        return activeTerminal?.createDelegatingInputConnection(outAttrs)
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val t = activeTerminal
        return (t != null && t.dispatchKeyEvent(event)) || super.dispatchKeyEvent(event)
    }

    override fun dispatchKeyEventPreIme(event: KeyEvent): Boolean {
        val t = activeTerminal
        return (t != null && t.dispatchKeyEventPreIme(event)) || super.dispatchKeyEventPreIme(event)
    }

    override fun onKeyMultiple(keyCode: Int, repeatCount: Int, event: KeyEvent): Boolean {
        val t = activeTerminal
        return (t != null && t.onKeyMultiple(keyCode, repeatCount, event)) || super.onKeyMultiple(keyCode, repeatCount, event)
    }

    companion object {
        private const val TAG = "TerminalImeHost"

        @Volatile
        private var instance: TerminalImeHostView? = null

        /**
         * Attach (or return the existing) host view for this Activity.
         * Fails closed — if we can't resolve a real Activity, returns
         * null and leaves IMM in whatever state it was. Callers should
         * still function (the pre-host per-pane behaviour is the
         * fallback; less reliable on OneUI but not broken on Pixel etc.).
         *
         * IMPORTANT: this function does NOT request focus. Focus is
         * only claimed on `bindToTerminal()` so the host doesn't steal
         * focus from React Native's view hierarchy during attach.
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
                val host = TerminalImeHostView(activity)
                // Position 0 so the host is BEHIND normal content in the
                // FrameLayout z-order. 1×1 pixel footprint so even if it
                // ever got in front of something, it only intercepts a
                // single pixel at (0,0).
                val lp = FrameLayout.LayoutParams(1, 1)
                contentRoot.addView(host, 0, lp)
                instance = host
                Log.i(TAG, "host attached to android.R.id.content hash=${System.identityHashCode(host)}")
                return host
            }
        }

        /** Swap the active terminal + rebuild the IME connection. */
        fun bindToTerminal(tv: TerminalView) {
            val host = instance ?: run {
                Log.w(TAG, "bindToTerminal: host not attached; skipping")
                return
            }
            host.bindToTerminal(tv)
        }

        /** Force-show the soft keyboard via the host. */
        fun showKeyboard(reason: String): Boolean {
            val host = instance ?: return false
            if (!host.isAttachedToWindow) return false
            if (!host.isFocused) host.requestFocusFromTouch()
            val imm = host.context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                ?: return false
            val shown = imm.showSoftInput(host, InputMethodManager.SHOW_IMPLICIT)
            Log.i(TAG, "showKeyboard($reason) shown=$shown")
            return shown
        }

        /** Unbind a terminal if it was active — called from destroy(). */
        fun unbindIfActive(tv: TerminalView) {
            val host = instance ?: return
            host.unbindIfActive(tv)
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
