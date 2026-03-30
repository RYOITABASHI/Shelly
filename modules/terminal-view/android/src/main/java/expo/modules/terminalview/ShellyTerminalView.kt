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
import android.view.inputmethod.InputMethodManager
import android.widget.LinearLayout
import com.termux.terminal.TerminalSession
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import expo.modules.terminalemulator.ShellyTerminalSession

/**
 * ShellyTerminalView — Direct Child Architecture
 *
 * TerminalView is added as a direct child of this ExpoView using
 * MATCH_PARENT layout. This ensures natural Android touch dispatch,
 * IME focus, and scroll handling — identical to how Termux works.
 *
 * Yoga layout passes during fold/unfold are handled by debouncing
 * the terminal resize (updateSize) so only the final stable size
 * triggers an emulator reset.
 */
class ShellyTerminalView(
    context: Context,
    appContext: AppContext
) : ExpoView(context, appContext), TerminalViewClient {

    companion object {
        private const val TAG = "ShellyTerminalView"
        private const val DEFAULT_FONT_SIZE = 14
        private const val RESIZE_DEBOUNCE_MS = 150L
    }

    // Yoga layout gives correct full-width sizing from React Native.
    // Keyboard resize is handled via OnGlobalLayoutListener below.

    // TerminalView is a direct child of this ExpoView
    val terminalView: TerminalView = TerminalView(context, null)
    private val inputHandler = ShellyInputHandler()
    private var isViewVisible = true
    private var currentSessionId: String? = null
    private var currentShellySession: ShellyTerminalSession? = null

    // Track last synced size to avoid redundant resize calls
    private var lastSyncedCols = -1
    private var lastSyncedRows = -1

    // Debounce handler for terminal resize
    private val resizeHandler = Handler(Looper.getMainLooper())

    // Track last size to detect actual changes
    private var lastWidth = -1
    private var lastHeight = -1

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
        // Black background like a real terminal
        setBackgroundColor(0xFF000000.toInt())

        terminalView.setTerminalViewClient(this)
        terminalView.isFocusable = true
        terminalView.isFocusableInTouchMode = true
        terminalView.setScrollStateListener { isScrolledUp ->
            onScrollStateChanged(mapOf("isScrolledUp" to isScrolledUp))
        }

        // Add TerminalView as direct child with MATCH_PARENT
        addView(terminalView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.MATCH_PARENT
        ))

        // Wire Ctrl+Shift+C/V clipboard handlers
        inputHandler.clipboardCopy = {
            copyToClipboardCommand()
        }
        inputHandler.clipboardPaste = { session ->
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            val text = clipboard?.primaryClip?.getItemAt(0)?.text?.toString()
            if (text != null) {
                session.write(text.toByteArray(Charsets.UTF_8), 0, text.toByteArray(Charsets.UTF_8).size)
                true
            } else {
                false
            }
        }

        // Request RUN_COMMAND permission at runtime (dangerous permission)
        ensureRunCommandPermission()

        // Set default font and size (convert sp to px)
        val defaultTypeface = FontManager.getTypeface(context, "jetbrains-mono")
        val defaultPx = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_SP, DEFAULT_FONT_SIZE.toFloat(), context.resources.displayMetrics
        ).toInt()
        terminalView.setTextSize(defaultPx)
        terminalView.setTypeface(defaultTypeface)

        Log.i(TAG, "init: TerminalView added as direct child")
    }

    // ===== Touch — prevent React Native from intercepting =====

    override fun dispatchTouchEvent(ev: MotionEvent?): Boolean {
        // Tell all parent views (including React Native's touch system)
        // to NOT intercept touch events meant for the terminal
        parent?.requestDisallowInterceptTouchEvent(true)
        return super.dispatchTouchEvent(ev)
    }

    // ===== Layout — debounce Yoga's rapid layout passes =====

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (w == 0 || h == 0) return
        if (w == lastWidth && h == lastHeight) return
        lastWidth = w
        lastHeight = h
        Log.i(TAG, "onSizeChanged: ${w}x${h} (was ${oldw}x${oldh})")
        scheduleTerminalResize()
    }

    /**
     * Debounced terminal resize. Yoga fires 3-5 layout passes during
     * fold/unfold/split transitions. Only the final stable size triggers
     * updateSize() + syncTmuxSize().
     */
    private fun scheduleTerminalResize() {
        resizeHandler.removeCallbacksAndMessages(null)
        resizeHandler.postDelayed({
            if (terminalView.width > 0 && terminalView.height > 0) {
                Log.i(TAG, "terminalResize: ${terminalView.width}x${terminalView.height}")
                terminalView.updateSize()
            }
        }, RESIZE_DEBOUNCE_MS)
    }

    override fun onDetachedFromWindow() {
        resizeHandler.removeCallbacksAndMessages(null)
        super.onDetachedFromWindow()
    }

    // ===== Session Management =====

    fun attachShellySession(shellySession: ShellyTerminalSession, sessionId: String) {
        currentShellySession = shellySession
        currentSessionId = sessionId
        terminalView.attachSession(shellySession.terminalSession)

        // Wire up screen update callback so TerminalView redraws on new output.
        // onTextChanged is called from TerminalSession's I/O thread,
        // so we post to main thread for safe UI update.
        shellySession.onScreenUpdateCallback = {
            terminalView.post { terminalView.onScreenUpdated() }
        }

        // Post updateSize to ensure layout is complete
        terminalView.post {
            if (terminalView.width > 0 && terminalView.height > 0) {
                Log.i(TAG, "attachSession.post: TerminalView=${terminalView.width}x${terminalView.height}")
                terminalView.updateSize()
                terminalView.invalidate()
            }
        }
    }

    fun detachCurrentSession() {
        currentShellySession?.onScreenUpdateCallback = null
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
            setTerminalCursorBlinkerRate(0)
        }
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        isViewVisible = hasWindowFocus
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
        inputHandler.onCodePoint(codePoint, ctrlDown || inputHandler.ctrlDown, session)

    // Expo EventDispatchers — emit to JS
    private val onResize by EventDispatcher()
    private val onScrollStateChanged by EventDispatcher()

    /**
     * Called by TerminalView when the emulator is (re)set after updateSize().
     * Sends resize command directly to pty-helper via Unix Domain Socket.
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

        // Direct PTY resize via socket (replaces syncTmuxSize)
        currentShellySession?.sendResizeCommand(cols, rows)
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
