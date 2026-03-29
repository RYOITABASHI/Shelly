package expo.modules.terminalview

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import com.termux.terminal.TerminalSession
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import expo.modules.terminalemulator.ShellyTerminalSession

/**
 * ShellyTerminalView — Overlay Architecture
 *
 * The ExpoView acts as a **transparent placeholder** within React Native's
 * Yoga layout tree. The actual TerminalView is added directly to the
 * Activity's content frame (android.R.id.content), completely bypassing
 * Yoga's layout engine.
 *
 * This eliminates the 3-5 rapid layout passes that React Native fires
 * during fold/unfold/split transitions on foldable devices (Z Fold6).
 * The TerminalView receives exactly ONE layout pass from Android's native
 * layout system — identical to how Termux handles it.
 *
 * Two concerns are cleanly separated:
 *   1. Position sync — instant, every frame (margin updates only)
 *   2. Terminal resize — debounced 200ms (emulator reset + tmux sync)
 *
 * Prior art: react-native-navigation (Wix) uses the same pattern for
 * their overlay system. react-native-screens uses it for modals.
 */
class ShellyTerminalView(
    context: Context,
    appContext: AppContext
) : ExpoView(context, appContext), TerminalViewClient {

    companion object {
        private const val TAG = "ShellyTerminalView"
        private const val DEFAULT_FONT_SIZE = 14
        private const val RESIZE_DEBOUNCE_MS = 200L
    }

    // TerminalView lives OUTSIDE the ExpoView hierarchy — added to Activity's content frame
    val terminalView: TerminalView = TerminalView(context, null)
    private val inputHandler = ShellyInputHandler()
    private var isViewVisible = true
    private var currentSessionId: String? = null
    private var currentShellySession: ShellyTerminalSession? = null
    private var isOverlayAttached = false

    // tmux session name — set via prop so we can resize directly from Kotlin
    var tmuxSessionName: String? = null

    // Track last synced size to avoid redundant tmux resize calls
    private var lastSyncedCols = -1
    private var lastSyncedRows = -1

    // Track last overlay dimensions for debounced resize
    private var lastOverlayWidth = -1
    private var lastOverlayHeight = -1

    // Debounce handler for terminal resize (NOT for position sync)
    private val resizeHandler = Handler(Looper.getMainLooper())

    // Position tracking — uses window-relative coordinates
    private val location = IntArray(2)

    // Event callbacks set by the Expo module
    var onOutputEvent: ((text: String, isError: Boolean) -> Unit)? = null
    var onBlockCompletedEvent: ((command: String, output: String, exitCode: Int) -> Unit)? = null
    var onSelectionChangedEvent: ((text: String) -> Unit)? = null
    var onUrlDetectedEvent: ((url: String, type: String) -> Unit)? = null
    var onBellEvent: (() -> Unit)? = null
    var onTitleChangedEvent: ((title: String) -> Unit)? = null

    private val blockDetector = BlockDetector(
        onBlockCompleted = { block ->
            onBlockCompletedEvent?.invoke(
                block.command,
                block.output,
                block.exitCode ?: -1
            )
        }
    )

    private val linkDetector = LinkDetector

    /**
     * OnGlobalLayoutListener — fires after every layout pass in the view tree.
     * Syncs the overlay TerminalView's position to match this placeholder.
     * Position updates are instant (margin changes only — no emulator reset).
     * Size changes are debounced to avoid rapid emulator resets during transitions.
     */
    private val globalLayoutListener = ViewTreeObserver.OnGlobalLayoutListener {
        syncOverlayPosition()
    }

    init {
        // ExpoView is transparent — it's just a position/size reference
        setBackgroundColor(0x00000000)

        terminalView.setTerminalViewClient(this)
        terminalView.isFocusable = true
        terminalView.isFocusableInTouchMode = true

        // Request RUN_COMMAND permission at runtime (dangerous permission)
        ensureRunCommandPermission()

        // Set default font and size (convert sp to px)
        val defaultTypeface = FontManager.getTypeface(context, "jetbrains-mono")
        val defaultPx = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_SP, DEFAULT_FONT_SIZE.toFloat(), context.resources.displayMetrics
        ).toInt()
        terminalView.setTextSize(defaultPx)
        terminalView.setTypeface(defaultTypeface)
    }

    // ===== Overlay Lifecycle =====

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        attachOverlay()
        viewTreeObserver.addOnGlobalLayoutListener(globalLayoutListener)
    }

    override fun onDetachedFromWindow() {
        viewTreeObserver.removeOnGlobalLayoutListener(globalLayoutListener)
        detachOverlay()
        resizeHandler.removeCallbacksAndMessages(null)
        super.onDetachedFromWindow()
    }

    /**
     * Add TerminalView to Activity's content frame (android.R.id.content).
     * This places it outside React Native's Yoga layout tree.
     */
    private fun attachOverlay() {
        if (isOverlayAttached) return
        val contentFrame = getContentFrame() ?: return
        val lp = FrameLayout.LayoutParams(0, 0).apply {
            leftMargin = 0
            topMargin = 0
        }
        contentFrame.addView(terminalView, lp)
        isOverlayAttached = true
        Log.i(TAG, "attachOverlay: TerminalView added to content frame")
    }

    /**
     * Remove TerminalView from Activity's content frame.
     */
    private fun detachOverlay() {
        if (!isOverlayAttached) return
        (terminalView.parent as? ViewGroup)?.removeView(terminalView)
        isOverlayAttached = false
        Log.i(TAG, "detachOverlay: TerminalView removed from content frame")
    }

    /**
     * Sync overlay position to match this ExpoView placeholder.
     * Position updates are instant. Size changes trigger debounced resize.
     */
    private fun syncOverlayPosition() {
        if (!isOverlayAttached) return
        if (width == 0 || height == 0) return

        // Get this placeholder's position relative to the window
        getLocationInWindow(location)
        val x = location[0]
        val y = location[1]
        val w = width
        val h = height

        // Update overlay position/size via LayoutParams
        val lp = terminalView.layoutParams as? FrameLayout.LayoutParams ?: return
        var changed = false
        if (lp.leftMargin != x || lp.topMargin != y) {
            lp.leftMargin = x
            lp.topMargin = y
            changed = true
        }
        if (lp.width != w || lp.height != h) {
            lp.width = w
            lp.height = h
            changed = true
        }
        if (changed) {
            Log.i(TAG, "syncOverlay: placeholder=${w}x${h}@($x,$y) tv=${terminalView.width}x${terminalView.height}")
            terminalView.layoutParams = lp
        }

        // Show/hide overlay to match placeholder visibility
        val shouldBeVisible = isShown
        if (shouldBeVisible && terminalView.visibility != View.VISIBLE) {
            terminalView.visibility = View.VISIBLE
        } else if (!shouldBeVisible && terminalView.visibility == View.VISIBLE) {
            terminalView.visibility = View.GONE
        }

        // Debounced terminal resize — only when size actually changes
        if (w != lastOverlayWidth || h != lastOverlayHeight) {
            lastOverlayWidth = w
            lastOverlayHeight = h
            scheduleTerminalResize(w, h)
        }
    }

    /**
     * Debounced terminal resize. Only the final stable size triggers
     * updateSize() + syncTmuxSize(). This fires once per fold/unfold/split
     * transition, not 3-5 times.
     */
    private fun scheduleTerminalResize(w: Int, h: Int) {
        resizeHandler.removeCallbacksAndMessages(null)
        resizeHandler.postDelayed({
            if (terminalView.width > 0 && terminalView.height > 0) {
                Log.i(TAG, "terminalResize: ${terminalView.width}x${terminalView.height}")
                terminalView.updateSize()
            }
        }, RESIZE_DEBOUNCE_MS)
    }

    private fun getContentFrame(): FrameLayout? {
        val activity = (context as? android.app.Activity)
            ?: (context as? android.content.ContextWrapper)?.baseContext as? android.app.Activity
        return activity?.findViewById(android.R.id.content)
    }

    // ===== ExpoView layout — placeholder only, does NOT drive TerminalView =====

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // ExpoView measures normally for Yoga's benefit, but has no children to measure
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        // Position sync is handled by OnGlobalLayoutListener
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        // No children to layout — TerminalView is in the content frame
    }

    // ===== Session Management =====

    fun attachShellySession(shellySession: ShellyTerminalSession, sessionId: String) {
        currentShellySession = shellySession
        currentSessionId = sessionId
        terminalView.attachSession(shellySession.terminalSession)
        // Post updateSize for cases where the overlay hasn't received its final size yet
        terminalView.post {
            if (terminalView.width > 0 && terminalView.height > 0) {
                Log.i(TAG, "attachSession.post: TerminalView=${terminalView.width}x${terminalView.height}")
                terminalView.updateSize()
                terminalView.invalidate()
            }
        }
    }

    fun detachCurrentSession() {
        currentShellySession = null
        currentSessionId = null
    }

    // ===== Font & Appearance =====

    fun setFontFamily(family: String) {
        val typeface = FontManager.getTypeface(context, family)
        terminalView.setTypeface(typeface)
    }

    fun setFontSizeDp(size: Int) {
        val px = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_SP, size.toFloat(), context.resources.displayMetrics
        ).toInt()
        terminalView.setTextSize(px)
    }

    fun setCursorShape(shape: String) {
        val emulator = terminalView.mEmulator ?: return
        val style = when (shape) {
            "underline" -> 1
            "bar" -> 2
            else -> 0
        }
        try {
            val field = emulator.javaClass.getDeclaredField("mCursorStyle")
            field.isAccessible = true
            field.setInt(emulator, style)
            terminalView.invalidate()
        } catch (e: Exception) {
            Log.w(TAG, "Could not set cursor style", e)
        }
    }

    fun setCursorBlinkEnabled(enabled: Boolean) {
        setTerminalCursorBlinkerRate(if (enabled) 500 else 0)
    }

    // ===== Visibility / Focus =====

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        isViewVisible = (visibility == View.VISIBLE)
        if (!isViewVisible) {
            terminalView.visibility = View.GONE
            setTerminalCursorBlinkerRate(0)
        }
        // Visibility sync is also handled by syncOverlayPosition
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        isViewVisible = hasWindowFocus
    }

    // ===== Touch — forward from placeholder to overlay =====

    override fun onInterceptTouchEvent(event: MotionEvent?): Boolean {
        // Placeholder is transparent; touches go through to the overlay
        // which is positioned on top via content frame
        return false
    }

    // ===== Output Processing =====

    fun processTerminalOutput(text: String) {
        blockDetector.processOutput(text)
        val links = linkDetector.detect(text)
        for (link in links) {
            onUrlDetectedEvent?.invoke(link.text, link.type.name)
        }
        onOutputEvent?.invoke(text, false)
    }

    // ===== Cleanup =====

    fun destroy() {
        detachOverlay()
        resizeHandler.removeCallbacksAndMessages(null)
        blockDetector.destroy()
        inputHandler.resetModifiers()
        detachCurrentSession()
    }

    // ===== View Commands =====

    fun scrollToBottomCommand() {
        terminalView.mEmulator ?: return
        terminalView.setTopRow(0)
        terminalView.invalidate()
    }

    fun scrollToTopCommand() {
        val emulator = terminalView.mEmulator ?: return
        terminalView.setTopRow(-(emulator.screen.activeTranscriptRows))
        terminalView.invalidate()
    }

    fun selectAllCommand() {}

    fun clearSelectionCommand() {
        terminalView.stopTextSelectionMode()
    }

    fun getSelectedTextCommand(): String? = terminalView.getSelectedText()

    fun copyToClipboardCommand(): Boolean {
        val text = terminalView.getSelectedText() ?: return false
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            ?: return false
        clipboard.setPrimaryClip(ClipData.newPlainText("Terminal", text))
        terminalView.stopTextSelectionMode()
        return true
    }

    fun focusCommand() {
        terminalView.requestFocus()
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(terminalView, InputMethodManager.SHOW_IMPLICIT)
    }

    // ===== TerminalViewClient Implementation =====

    override fun onScale(scale: Float): Float = scale.coerceIn(0.5f, 2.0f)

    override fun onSingleTapUp(e: MotionEvent) {
        terminalView.requestFocus()
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(terminalView, 0)
        // Immediate resize on tap — user explicitly interacted
        terminalView.updateSize()
    }

    override fun shouldBackButtonBeMappedToEscape(): Boolean = true
    override fun shouldEnforceCharBasedInput(): Boolean = false
    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false
    override fun isTerminalViewSelected(): Boolean = terminalView.hasFocus()

    override fun copyModeChanged(copyMode: Boolean) {
        if (copyMode) {
            terminalView.getSelectedText()?.let { onSelectionChangedEvent?.invoke(it) }
        }
    }

    override fun onKeyDown(keyCode: Int, e: KeyEvent, session: TerminalSession): Boolean =
        inputHandler.onKeyDown(keyCode, e, session)

    override fun onKeyUp(keyCode: Int, e: KeyEvent): Boolean =
        inputHandler.onKeyUp(keyCode, e)

    override fun onLongPress(event: MotionEvent): Boolean = false

    override fun readControlKey(): Boolean = inputHandler.ctrlDown
    override fun readAltKey(): Boolean = inputHandler.altDown
    override fun readShiftKey(): Boolean = inputHandler.shiftDown
    override fun readFnKey(): Boolean = inputHandler.fnDown

    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession): Boolean =
        inputHandler.onCodePoint(codePoint, ctrlDown, session)

    // Expo EventDispatcher — emits to JS for size tracking
    private val onResize by EventDispatcher()

    /**
     * Called by TerminalView when the emulator is (re)set after updateSize().
     * Syncs tmux size from Kotlin via RunCommandService Intent.
     */
    override fun onEmulatorSet() {
        terminalView.invalidate()
        val emulator = terminalView.mEmulator ?: return
        val cols = emulator.mColumns
        val rows = emulator.mRows
        Log.i(TAG, "onEmulatorSet: cols=$cols, rows=$rows, view=${terminalView.width}x${terminalView.height}")

        // Skip if size hasn't changed
        if (cols == lastSyncedCols && rows == lastSyncedRows) return
        lastSyncedCols = cols
        lastSyncedRows = rows

        syncTmuxSize(cols, rows)
        onResize(mapOf("cols" to cols, "rows" to rows))
    }

    // ===== Permissions =====

    private fun ensureRunCommandPermission() {
        val perm = "com.termux.permission.RUN_COMMAND"
        val activity = (context as? android.app.Activity)
            ?: (context as? android.content.ContextWrapper)?.baseContext as? android.app.Activity
            ?: return
        if (androidx.core.content.ContextCompat.checkSelfPermission(context, perm)
            != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "RUN_COMMAND permission not granted, requesting...")
            androidx.core.app.ActivityCompat.requestPermissions(activity, arrayOf(perm), 9999)
        }
    }

    // ===== tmux Resize =====

    private fun syncTmuxSize(cols: Int, rows: Int) {
        val tmuxName = tmuxSessionName ?: return
        try {
            val cmd = "tmux set-option -g window-size manual 2>/dev/null; tmux set-option -g status off 2>/dev/null; tmux resize-window -t \"$tmuxName\" -x $cols -y $rows 2>/dev/null; true"
            val intent = android.content.Intent("com.termux.RUN_COMMAND").apply {
                component = android.content.ComponentName(
                    "com.termux",
                    "com.termux.app.RunCommandService"
                )
                putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/sh")
                putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-c", cmd))
                putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home")
                putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            }
            context.startService(intent)
            Log.i(TAG, "syncTmuxSize: tmux resize -t $tmuxName -x $cols -y $rows")
        } catch (e: SecurityException) {
            Log.e(TAG, "syncTmuxSize PERMISSION DENIED: ${e.message}")
        } catch (e: Exception) {
            Log.w(TAG, "syncTmuxSize failed (${e.javaClass.simpleName}): ${e.message}")
        }
    }

    // ===== Logging =====

    override fun logError(tag: String, message: String) { Log.e(tag, message) }
    override fun logWarn(tag: String, message: String) { Log.w(tag, message) }
    override fun logInfo(tag: String, message: String) { Log.i(tag, message) }
    override fun logDebug(tag: String, message: String) { Log.d(tag, message) }
    override fun logVerbose(tag: String, message: String) { Log.v(tag, message) }
    override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) { Log.e(tag, message, e) }
    override fun logStackTrace(tag: String, e: Exception) { Log.e(tag, "Exception", e) }

    // ===== Cursor blinker helper =====

    private fun setTerminalCursorBlinkerRate(rate: Int) {
        try {
            val field = TerminalView::class.java.getDeclaredField("mTerminalCursorBlinkerRate")
            field.isAccessible = true
            field.setInt(terminalView, rate)
        } catch (e: Exception) {
            Log.w(TAG, "Could not set cursor blink rate", e)
        }
    }
}
