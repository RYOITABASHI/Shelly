package expo.modules.terminalemulator

import android.app.ActivityOptions
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.util.TypedValue
import android.view.Display
import android.view.Gravity
import android.view.View
import android.view.ViewTreeObserver
import android.view.WindowManager
import android.widget.TextView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * "Foreground for approval" (owner decision 2026-11-29) for the approval-every-
 * time MCP write ops (update_pipeline_config / update_delivery_script /
 * stage_install; McpInstallOpDecision.Outcome.Foreground): when one needs the
 * tap and RN is not live, bring Shelly to the front so RN's existing approval
 * dialog can be shown. Nothing here approves anything.
 *
 * How: a small, non-focusable overlay window (TYPE_APPLICATION_OVERLAY, needs
 * the SYSTEM_ALERT_WINDOW grant) on the default display, and — once it has
 * been drawn — Shelly's launch activity started on the default display.
 * Android exempts an app with a VISIBLE overlay window from the
 * background-activity-start restriction (Android 15+: the overlay must be
 * visible when the start happens; that is why the start waits for the first
 * draw). A blocked start fails silently, so success is judged only by RN's
 * heartbeat coming up (the consumer's wait).
 *
 * Never on the lock screen: [blocker] requires PowerManager.isInteractive and
 * an unlocked keyguard (the consumer reads it right before [show]).
 */
internal object McpApprovalForeground {
    private const val TAG = "McpApprovalForeground"
    /** The caller (consumer thread) waits at most this long for the main thread. */
    private const val SHOW_WAIT_MS = 2_000L
    /** Start anyway if the overlay was not drawn within this (the start may then be blocked; the wait sees it). */
    private const val DRAW_FALLBACK_MS = 500L
    /** The overlay removes itself this long after the wait's end, whatever happens to its owner. */
    private const val AUTO_HIDE_SLACK_MS = 1_000L

    class Handle internal constructor(internal val wm: WindowManager, internal val view: View) {
        internal val removed = AtomicBoolean(false)
    }

    private val main = Handler(Looper.getMainLooper())

    /** Null when Shelly may be brought to the front now; else McpInstallOpDecision.FG_LOCKED / FG_NO_OVERLAY. */
    fun blocker(context: Context): String? {
        val pm = context.getSystemService(PowerManager::class.java)
        val km = context.getSystemService(KeyguardManager::class.java)
        if (pm == null || km == null || !pm.isInteractive || km.isKeyguardLocked) return McpInstallOpDecision.FG_LOCKED
        val overlay = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
            runCatching { Settings.canDrawOverlays(context) }.getOrDefault(false)
        return if (overlay) null else McpInstallOpDecision.FG_NO_OVERLAY
    }

    /**
     * Shows the overlay and starts the activity (both on the main thread).
     * Blocks the caller ≤ [SHOW_WAIT_MS]. Null when the overlay could not be
     * added or the start threw (the overlay is then removed); the overlay
     * removes itself at [waitUntilMs] + [AUTO_HIDE_SLACK_MS] at the latest.
     */
    fun show(context: Context, waitUntilMs: Long): Handle? {
        val app = context.applicationContext
        val latch = CountDownLatch(1)
        var result: Handle? = null
        val abandoned = AtomicBoolean(false)
        main.post {
            var handle: Handle? = null
            try {
                handle = addOverlay(app)
                val h = handle
                val started = AtomicBoolean(false)
                val start = Runnable {
                    if (!started.compareAndSet(false, true)) return@Runnable
                    try {
                        if (abandoned.get()) throw IllegalStateException("abandoned")
                        startActivity(app)
                        result = h
                    } catch (e: Exception) {
                        Log.w(TAG, "activity start failed type=${e.javaClass.simpleName}")
                        hide(h)
                    } finally {
                        latch.countDown()
                    }
                }
                // Start only after the overlay was drawn (Android 15+ needs it visible).
                h.view.viewTreeObserver.addOnDrawListener(object : ViewTreeObserver.OnDrawListener {
                    override fun onDraw() {
                        // Not removable from inside onDraw: post both.
                        main.post { runCatching { h.view.viewTreeObserver.removeOnDrawListener(this) } }
                        main.post(start)
                    }
                })
                main.postDelayed(start, DRAW_FALLBACK_MS)
                val delay = (waitUntilMs - System.currentTimeMillis() + AUTO_HIDE_SLACK_MS).coerceAtLeast(AUTO_HIDE_SLACK_MS)
                main.postDelayed({ hide(h) }, delay)
            } catch (e: Exception) {
                Log.w(TAG, "overlay not shown type=${e.javaClass.simpleName}")
                handle?.let { hide(it) }
                latch.countDown()
            }
        }
        val done = try { latch.await(SHOW_WAIT_MS, TimeUnit.MILLISECONDS) } catch (e: InterruptedException) { false }
        if (!done) {
            // The main thread is stuck: give up; a late start is refused and the overlay removed.
            abandoned.set(true)
            main.post { result?.let { hide(it) } }
            return null
        }
        return result
    }

    /** Removes the overlay (any thread, idempotent). */
    fun hide(handle: Handle?) {
        if (handle == null) return
        val run = Runnable {
            if (!handle.removed.compareAndSet(false, true)) return@Runnable
            try {
                handle.wm.removeViewImmediate(handle.view)
            } catch (e: Exception) {
                Log.w(TAG, "overlay removal failed type=${e.javaClass.simpleName}")
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) run.run() else main.post(run)
    }

    private fun defaultDisplayContext(app: Context): Context {
        val dm = app.getSystemService(DisplayManager::class.java)
        val display = dm?.getDisplay(Display.DEFAULT_DISPLAY) ?: throw IllegalStateException("no default display")
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            app.createWindowContext(display, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY, null)
        } else {
            app.createDisplayContext(display)
        }
    }

    private fun addOverlay(app: Context): Handle {
        val ctx = defaultDisplayContext(app)
        val wm = ctx.getSystemService(WindowManager::class.java) ?: throw IllegalStateException("no window manager")
        val dp = { v: Float -> TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.resources.displayMetrics) }
        // Theme-neutral: a dark translucent pill with white text reads on light and dark screens alike.
        val view = TextView(ctx).apply {
            text = ctx.getString(R.string.mcp_approval_foreground_overlay)
            setTextColor(0xFFFFFFFF.toInt())
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            val ph = dp(16f).toInt()
            val pv = dp(10f).toInt()
            setPadding(ph, pv, ph, pv)
            background = GradientDrawable().apply {
                cornerRadius = dp(20f)
                setColor(0xE6202124.toInt())
            }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        }
        @Suppress("DEPRECATION")
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        } else {
            WindowManager.LayoutParams.TYPE_PHONE
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            type,
            // Never takes focus or input outside its own small area.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
            y = dp(48f).toInt()
            title = "ShellyApprovalForeground"
        }
        wm.addView(view, lp)
        return Handle(wm, view)
    }

    private fun startActivity(app: Context) {
        val intent = app.packageManager.getLaunchIntentForPackage(app.packageName)
            ?: throw IllegalStateException("no launch intent")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        val options = ActivityOptions.makeBasic()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) options.launchDisplayId = Display.DEFAULT_DISPLAY
        app.startActivity(intent, options.toBundle())
    }
}
