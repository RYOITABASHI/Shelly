package expo.modules.terminalemulator

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Lock-screen "wake, prompt, continue after genuine unlock" bridge for
 * `app.act` (docs/superpowers/specs/2026-07-11-app-act-design.md §0.1).
 *
 * §0.1 documents a hard OS wall: once the device locks,
 * `AccessibilityService.rootInActiveWindow` only ever returns the keyguard
 * window, never the target app's node tree — `app.act` cannot act at all
 * while locked, and Shelly cannot dismiss a secured (PIN/pattern/biometric)
 * lock screen from user code at any privilege level; that boundary is
 * hardware-security-backed, not a permission gap SHELL-001's shell-uid
 * access (or any other privilege Shelly holds) can close.
 *
 * This class is explicitly NOT a bypass of that boundary. It is the
 * well-established "incoming call screen / alarm app" pattern:
 * `setShowWhenLocked` + `setTurnScreenOn` bring this Activity's UI up over
 * the lock screen, and `KeyguardManager.requestDismissKeyguard` then hands
 * control to the OS's own unlock challenge — the exact same PIN/pattern/
 * biometric prompt the user would see anywhere else. Shelly never sees or
 * handles the credential; it only ever learns whether the OS reports the
 * dismiss attempt as succeeded, cancelled, or errored.
 *
 * [ensureUnlocked] is the only public surface: a synchronous/blocking call
 * (deliberately `CountDownLatch`-based rather than a `suspend` function —
 * there is no existing coroutine-bridging precedent anywhere in this native
 * module) that callers such as `ShellyAccessibilityService.ensureForeground`
 * and a `TerminalEmulatorModule` `AsyncFunction` body can call directly from
 * a background thread, mirroring how `ShellyAccessibilityService.
 * debugSendLineMessage` already blocks its calling thread synchronously
 * today.
 */
class LockPromptActivity : Activity() {

    /** This instance's own copy of the in-flight ensureUnlocked() call's
     *  latch/result, captured once in [onCreate] (see the comment there for
     *  why capturing rather than reading the companion fields live on every
     *  callback matters). */
    private var myLatch: CountDownLatch? = null
    private var myResult: AtomicBoolean? = null

    /** Guards against recording an outcome more than once. All three
     *  KeyguardDismissCallback methods plus the defensive [onDestroy] path
     *  funnel through [completeOnce] — only the first arrival is allowed to
     *  write [myResult] and count down [myLatch]; later arrivals are
     *  logged and dropped. */
    private val completedOnce = AtomicBoolean(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Snapshot the in-flight call's latch/result at the moment this
        // instance is created. The companion's `busy` guard guarantees at
        // most one ensureUnlocked() call is in flight at a time, so these
        // are guaranteed to be THIS call's pair, not some other call's —
        // and because we capture them into instance fields here rather
        // than reading the companion's (mutable) fields later from the
        // KeyguardDismissCallback, this instance can never clobber a LATER
        // ensureUnlocked() invocation's latch/result even if this call
        // already timed out on the caller side (busy released, a fresh
        // call started, reassigning the companion fields) before the user
        // finally responds to this still-visible prompt.
        val pending = pendingCall
        myLatch = pending?.latch
        myResult = pending?.result
        if (myLatch == null || myResult == null) {
            Log.w(TAG, "onCreate: no in-flight ensureUnlocked() call registered, finishing")
            finish()
            return
        }
        // Tracked so ensureUnlocked()'s timeout path can finish() this
        // instance if the user never responds in time (see that method) —
        // found missing by independent review 2026-07-11: without this, a
        // timed-out prompt would linger over the lock screen indefinitely.
        currentInstance = this

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            // API 26 (O) has requestDismissKeyguard but not the Activity-level
            // setShowWhenLocked/setTurnScreenOn convenience methods (added in
            // O_MR1 / API 27) — fall back to the equivalent window flags.
            // ensureUnlocked() already refuses to run below API 26 entirely.
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or
                    WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
            )
        }

        setContentView(buildContentView())

        val keyguardManager = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        if (keyguardManager == null) {
            Log.w(TAG, "onCreate: KeyguardManager unavailable")
            completeOnce(false, "KeyguardManager unavailable")
            finish()
            return
        }

        keyguardManager.requestDismissKeyguard(
            this,
            object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() {
                    Log.i(TAG, "requestDismissKeyguard: onDismissSucceeded")
                    completeOnce(true, "onDismissSucceeded")
                    finish()
                }

                override fun onDismissError() {
                    Log.w(TAG, "requestDismissKeyguard: onDismissError")
                    completeOnce(false, "onDismissError")
                    finish()
                }

                override fun onDismissCancelled() {
                    Log.i(TAG, "requestDismissKeyguard: onDismissCancelled (user backed out)")
                    completeOnce(false, "onDismissCancelled")
                    finish()
                }
            }
        )
    }

    /** Defensive fallback: if the OS destroys this Activity before any
     *  KeyguardDismissCallback method ever fires (task killed, user force-
     *  swiped it from Recents, low-memory reclaim), the latch must still
     *  count down — otherwise ensureUnlocked() would block its calling
     *  thread until timeoutMs regardless of what actually happened on
     *  screen. [completeOnce]'s guard makes this a no-op whenever a real
     *  callback already recorded an outcome (mirrors the identity-guarded
     *  defensive clear in ShellyAccessibilityService.onDestroy). */
    override fun onDestroy() {
        completeOnce(false, "onDestroy fired with no prior keyguard callback")
        super.onDestroy()
    }

    private fun completeOnce(success: Boolean, reason: String) {
        if (!completedOnce.compareAndSet(false, true)) {
            Log.i(TAG, "completeOnce(success=$success, reason=$reason) ignored — outcome already recorded")
            return
        }
        if (currentInstance === this) {
            currentInstance = null
        }
        myResult?.set(success)
        Log.i(TAG, "LockPromptActivity outcome: success=$success reason=$reason")
        myLatch?.countDown()
    }

    private fun buildContentView(): FrameLayout {
        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()
        val message = TextView(this).apply {
            text = "Shelly wants to continue an action — unlock to proceed"
            setTextColor(COLOR_TEXT)
            textSize = 16f
            gravity = Gravity.CENTER
        }
        return FrameLayout(this).apply {
            setBackgroundColor(COLOR_BACKGROUND)
            addView(
                message,
                FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    FrameLayout.LayoutParams.WRAP_CONTENT,
                    Gravity.CENTER
                ).apply {
                    leftMargin = dp(32)
                    rightMargin = dp(32)
                }
            )
        }
    }

    companion object {
        private const val TAG = "ShellyLockPrompt"
        private val COLOR_BACKGROUND = Color.rgb(0, 12, 4)
        private val COLOR_TEXT = Color.rgb(230, 255, 236)

        /** Re-entrancy guard: only one ensureUnlocked() call (and therefore
         *  one live LockPromptActivity) may be in flight at a time. A
         *  second concurrent call fails fast (returns false) instead of
         *  reassigning [pendingCall] out from under the first call's
         *  already-launched Activity — mirrors ShellyAccessibilityService's
         *  own `busy` AtomicBoolean guard on debugSendLineMessage/
         *  debugPostToX. */
        private val busy = AtomicBoolean(false)

        /** Bundles the latch and its result holder so they are always
         *  assigned/read as a single atomic unit — found as a theoretical
         *  tear risk by independent review 2026-07-11 (two independently
         *  @Volatile fields could in principle be observed as a mismatched
         *  pair by onCreate() if it ran concurrently with a reassignment;
         *  a single @Volatile reference makes that impossible). */
        private data class PendingCall(val latch: CountDownLatch, val result: AtomicBoolean)

        /** Set by [ensureUnlocked] immediately before launching the
         *  Activity; read once by the new Activity's [onCreate] to capture
         *  its own local copy — see that method's comment for why the
         *  capture (rather than reading this field live from callbacks)
         *  matters. */
        @Volatile private var pendingCall: PendingCall? = null

        /** The currently-live instance for the in-flight call, if any —
         *  set in [onCreate], cleared by [completeOnce] once an outcome is
         *  recorded (identity-guarded, mirrors ShellyAccessibilityService.
         *  onDestroy's pattern). Lets [ensureUnlocked]'s timeout path
         *  actively dismiss a prompt the user never responded to, instead
         *  of leaving it sitting over the lock screen indefinitely (found
         *  by independent review 2026-07-11). */
        @Volatile private var currentInstance: LockPromptActivity? = null

        /**
         * Blocks the calling thread until the device is confirmed unlocked,
         * [timeoutMs] elapses, or the user declines/cancels the unlock
         * prompt. Safe to call from any background thread — deliberately
         * NOT a suspend function (see the class doc comment for why).
         * Returns true iff the device is unlocked by the time this
         * returns: either it already was (cheap fast path, no Activity
         * launched), or the user completed the OS's own unlock challenge in
         * response to the prompt this method raises.
         *
         * Pre-API-26 devices: requestDismissKeyguard/setShowWhenLocked need
         * API 26/27, so a locked pre-O device returns false immediately.
         * This is an acceptable simplification — app.act's own
         * minSdkVersion floor is 24, but this specific bridge only helps on
         * 26+; on an older locked device app.act simply stays blocked
         * while locked, exactly as it was before this feature existed.
         */
        fun ensureUnlocked(context: Context, timeoutMs: Long = 60_000L): Boolean {
            val keyguardManager = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            if (keyguardManager == null || !keyguardManager.isKeyguardLocked) {
                return true
            }
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                Log.w(TAG, "ensureUnlocked: device is locked but SDK ${Build.VERSION.SDK_INT} < 26 (O), unsupported")
                return false
            }
            if (!busy.compareAndSet(false, true)) {
                Log.w(TAG, "ensureUnlocked: another unlock prompt is already in flight, failing fast")
                return false
            }
            return try {
                val newLatch = CountDownLatch(1)
                val newResult = AtomicBoolean(false)
                pendingCall = PendingCall(newLatch, newResult)

                val intent = Intent(context, LockPromptActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)

                val completed = try {
                    newLatch.await(timeoutMs, TimeUnit.MILLISECONDS)
                } catch (e: InterruptedException) {
                    Thread.currentThread().interrupt()
                    false
                }
                val result = completed && newResult.get()
                Log.i(TAG, "ensureUnlocked: completed=$completed result=$result")
                if (!completed) {
                    // The Activity never called completeOnce in time (no
                    // KeyguardDismissCallback fired, and the OS never
                    // destroyed it either) — actively dismiss it rather than
                    // leaving a stale "unlock to proceed" prompt sitting
                    // over the lock screen forever after this caller has
                    // already given up (found by independent review
                    // 2026-07-11). finish() is safe to call even if the
                    // instance is already finishing/gone (currentInstance
                    // may be null if a callback raced in right at the
                    // timeout boundary).
                    Log.w(TAG, "ensureUnlocked: timed out, finishing lingering prompt if still alive")
                    currentInstance?.finish()
                }
                result
            } finally {
                // Release for the NEXT call. Note this does not affect an
                // Activity instance that is still alive past a timeout —
                // it already captured its own latch/result copies in
                // onCreate and keeps writing to those, never to whatever
                // this companion field gets reassigned to next.
                pendingCall = null
                busy.set(false)
            }
        }
    }
}
