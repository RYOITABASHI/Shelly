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
 * ShellyTerminalView wraps the vendored Termux TerminalView using composition.
 *
 * Resize strategy (modeled after Termux):
 *   onSizeChanged → updateSize() → onEmulatorSet() → syncTmuxSize()
 * No debouncing. tmux resize-window is called directly from Kotlin via
 * Runtime.exec(), bypassing the JS bridge entirely. This mirrors Termux's
 * synchronous JNI.setPtyWindowSize() approach.
 */
class ShellyTerminalView(
    context: Context,
    appContext: AppContext
) : ExpoView(context, appContext), TerminalViewClient {

    companion object {
        private const val TAG = "ShellyTerminalView"
        private const val DEFAULT_FONT_SIZE = 14
    }

    val terminalView: TerminalView = TerminalView(context, null)
    private val inputHandler = ShellyInputHandler()
    private var isViewVisible = true
    private var currentSessionId: String? = null
    private var currentShellySession: ShellyTerminalSession? = null

    // tmux session name — set via prop so we can resize directly from Kotlin
    var tmuxSessionName: String? = null

    // Track last synced size to avoid redundant tmux resize calls
    private var lastSyncedCols = -1
    private var lastSyncedRows = -1

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

    init {
        addView(terminalView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        terminalView.setTerminalViewClient(this)
        terminalView.isFocusable = true
        terminalView.isFocusableInTouchMode = true

        // Set default font and size (convert sp to px)
        val defaultTypeface = FontManager.getTypeface(context, "jetbrains-mono")
        val defaultPx = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_SP, DEFAULT_FONT_SIZE.toFloat(), context.resources.displayMetrics
        ).toInt()
        terminalView.setTextSize(defaultPx)
        terminalView.setTypeface(defaultTypeface)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
        val w = measuredWidth
        val h = measuredHeight
        if (w > 0 && h > 0) {
            val exactW = View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY)
            val exactH = View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY)
            terminalView.measure(exactW, exactH)
        }
    }

    // Mirrors Termux: onSizeChanged → updateSize() synchronously. No post, no debounce.
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        Log.i(TAG, "onSizeChanged: ${oldw}x${oldh} → ${w}x${h}")
        // updateSize is called by the child TerminalView's own onSizeChanged.
        // We also call it here in case the ExpoView wrapper resizes but the
        // child hasn't laid out yet.
        if (w > 0 && h > 0) {
            terminalView.updateSize()
        }
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        val w = right - left
        val h = bottom - top
        terminalView.layout(0, 0, w, h)
        Log.i(TAG, "onLayout: ExpoView=${w}x${h}, TerminalView=${terminalView.width}x${terminalView.height}, emulator=${terminalView.mEmulator?.mColumns ?: -1}x${terminalView.mEmulator?.mRows ?: -1}")
    }

    // --- Session Management ---

    fun attachShellySession(shellySession: ShellyTerminalSession, sessionId: String) {
        currentShellySession = shellySession
        currentSessionId = sessionId
        terminalView.attachSession(shellySession.terminalSession)
        // attachSession calls updateSize() internally. If the view already has
        // valid dimensions, this will trigger onEmulatorSet → syncTmuxSize.
        // Post one additional updateSize to cover the case where layout hasn't
        // settled yet (view width/height still 0 at attach time).
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

    // --- Font & Appearance ---

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

    // --- Visibility / Focus ---

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        isViewVisible = (visibility == View.VISIBLE)
        if (isViewVisible) {
            terminalView.updateSize()
        } else {
            setTerminalCursorBlinkerRate(0)
        }
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        isViewVisible = hasWindowFocus
        if (hasWindowFocus) {
            terminalView.updateSize()
        }
    }

    // --- Scroll Ownership ---

    override fun onInterceptTouchEvent(event: MotionEvent?): Boolean {
        parent?.requestDisallowInterceptTouchEvent(true)
        return false
    }

    // --- Output Processing ---

    fun processTerminalOutput(text: String) {
        blockDetector.processOutput(text)
        val links = linkDetector.detect(text)
        for (link in links) {
            onUrlDetectedEvent?.invoke(link.text, link.type.name)
        }
        onOutputEvent?.invoke(text, false)
    }

    // --- Cleanup ---

    fun destroy() {
        blockDetector.destroy()
        inputHandler.resetModifiers()
        detachCurrentSession()
    }

    // --- View Commands ---

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
        // Force size sync on tap — same as Termux behavior
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

    // Expo EventDispatcher — still emits to JS for any UI updates that need size info
    private val onResize by EventDispatcher()

    /**
     * Called by TerminalView when the emulator is (re)set after updateSize().
     * Mirrors Termux's approach: NO debouncing. Immediately syncs tmux size
     * from Kotlin via Runtime.exec(), bypassing the JS bridge.
     */
    override fun onEmulatorSet() {
        terminalView.invalidate()
        val emulator = terminalView.mEmulator ?: return
        val cols = emulator.mColumns
        val rows = emulator.mRows
        Log.i(TAG, "onEmulatorSet: cols=$cols, rows=$rows, viewSize=${terminalView.width}x${terminalView.height}")

        // Skip if size hasn't changed
        if (cols == lastSyncedCols && rows == lastSyncedRows) return

        lastSyncedCols = cols
        lastSyncedRows = rows

        // 1. Sync tmux directly from Kotlin — no JS bridge, no debounce
        syncTmuxSize(cols, rows)

        // 2. Also emit to JS for any UI that needs to know the size
        onResize(mapOf("cols" to cols, "rows" to rows))
    }

    /**
     * Resize tmux window directly from Kotlin via Termux RunCommandService.
     * This is the equivalent of Termux's JNI.setPtyWindowSize() — we can't
     * use ioctl because the PTY lives in Termux's UID, so we send an Intent
     * to Termux's RunCommandService to execute tmux resize-window.
     * This bypasses the JS bridge entirely for minimal latency.
     */
    private fun syncTmuxSize(cols: Int, rows: Int) {
        val tmuxName = tmuxSessionName ?: return
        try {
            val cmd = "tmux resize-window -t \"$tmuxName\" -x $cols -y $rows 2>/dev/null; true"
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
            Log.i(TAG, "syncTmuxSize: sent tmux resize -t $tmuxName -x $cols -y $rows")
        } catch (e: SecurityException) {
            Log.e(TAG, "syncTmuxSize PERMISSION DENIED: ${e.message} — RUN_COMMAND permission missing from APK?")
        } catch (e: Exception) {
            Log.w(TAG, "syncTmuxSize failed (${e.javaClass.simpleName}): ${e.message}")
        }
    }

    // --- Logging ---

    override fun logError(tag: String, message: String) { Log.e(tag, message) }
    override fun logWarn(tag: String, message: String) { Log.w(tag, message) }
    override fun logInfo(tag: String, message: String) { Log.i(tag, message) }
    override fun logDebug(tag: String, message: String) { Log.d(tag, message) }
    override fun logVerbose(tag: String, message: String) { Log.v(tag, message) }

    override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) {
        Log.e(tag, message, e)
    }

    override fun logStackTrace(tag: String, e: Exception) {
        Log.e(tag, "Exception", e)
    }

    // --- Cursor blinker helper ---

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
