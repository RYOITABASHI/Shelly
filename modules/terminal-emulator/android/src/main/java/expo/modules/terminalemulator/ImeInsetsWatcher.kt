package expo.modules.terminalemulator

import android.app.Activity
import android.util.Log
import android.view.View
import android.view.ViewGroup
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference

/**
 * Reports the real soft-keyboard (IME) inset of the activity window to JS.
 *
 * Why not React Native's Keyboard events: RN's KeyboardListener only emits
 * keyboardDidShow when IME *visibility* flips, and reports the height of that
 * moment. IMEs that grow their content inset after becoming visible (e.g.
 * FUTO Keyboard, whose toolbar rows are laid out after the first inset pass)
 * leave RN's height stale: build 2487 logged height 317.59dp while
 * `dumpsys window` showed the ime InsetsSource at frame top 1033px (ime
 * inset bottom 1127px = 388.6dp). The pane grid then reserved ~56dp too
 * little and the key bar slid under the keyboard.
 *
 * This installs a zero-size probe View inside android.R.id.content with its
 * own OnApplyWindowInsetsListener — insets are dispatched to every child, so
 * this never displaces a listener installed by RN or anyone else — and emits
 * every change of the ime inset. [snapshot] lets JS poll as a fallback.
 *
 * All values are px relative to the window bottom; ime bottom already
 * includes the navigation-bar area under edge-to-edge.
 */
internal object ImeInsetsWatcher {
    private const val TAG = "ShellyIme"
    private const val PROBE_TAG = "shelly-ime-insets-probe"

    private var probeRef: WeakReference<View>? = null
    private var lastSent: Triple<Int, Int, Boolean>? = null

    fun snapshotFrom(view: View): Map<String, Any?> {
        val density = view.resources.displayMetrics.density.toDouble()
        val raw = view.rootWindowInsets
            ?: return mapOf("available" to false, "density" to density)
        val insets = WindowInsetsCompat.toWindowInsetsCompat(raw, view)
        return build(insets, density)
    }

    private fun build(insets: WindowInsetsCompat, density: Double): Map<String, Any?> {
        val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
        val nav = insets.getInsets(WindowInsetsCompat.Type.navigationBars())
        return mapOf(
            "available" to true,
            "visible" to insets.isVisible(WindowInsetsCompat.Type.ime()),
            "imeBottomPx" to ime.bottom,
            "navBottomPx" to nav.bottom,
            "density" to density,
        )
    }

    /** Must be called on the UI thread. Idempotent per activity. */
    fun install(activity: Activity, emit: (Map<String, Any?>) -> Unit): Map<String, Any?> {
        val content = activity.findViewById<ViewGroup>(android.R.id.content)
            ?: return mapOf("available" to false)
        val existing = probeRef?.get()
        val probe = if (existing != null && existing.parent === content) {
            existing
        } else {
            View(activity).also { v ->
                v.tag = PROBE_TAG
                v.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
                content.addView(v, ViewGroup.LayoutParams(0, 0))
                probeRef = WeakReference(v)
                Log.i(TAG, "probe installed")
            }
        }
        ViewCompat.setOnApplyWindowInsetsListener(probe) { v, insets ->
            val density = v.resources.displayMetrics.density.toDouble()
            val snap = build(insets, density)
            val key = Triple(snap["imeBottomPx"] as Int, snap["navBottomPx"] as Int, snap["visible"] as Boolean)
            if (key != lastSent) {
                lastSent = key
                Log.d(TAG, "ime insets $snap")
                emit(snap)
            }
            insets
        }
        ViewCompat.requestApplyInsets(probe)
        return snapshotFrom(probe)
    }

    fun snapshot(activity: Activity?): Map<String, Any?> {
        val view = probeRef?.get() ?: activity?.window?.decorView
            ?: return mapOf("available" to false)
        return snapshotFrom(view)
    }
}
