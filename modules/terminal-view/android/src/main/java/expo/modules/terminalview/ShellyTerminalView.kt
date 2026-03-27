package expo.modules.terminalview

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.FrameLayout
import com.termux.terminal.TerminalSession
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import expo.modules.terminalemulator.ShellyTerminalSession

/**
 * ShellyTerminalView wraps the vendored Termux TerminalView using composition.
 *
 * This is an ExpoView (FrameLayout) that contains a TerminalView child and
 * implements TerminalViewClient to handle all terminal interactions.
 *
 * Features:
 * - Font injection via FontManager
 * - Theme color application
 * - Battery optimization (stop rendering when not visible)
 * - Auto-resize on size change
 * - Scroll ownership (intercepts vertical scroll)
 * - BlockDetector and LinkDetector integration
 * - Event emission to React Native
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
        // Add TerminalView as child, filling the entire frame
        addView(terminalView, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))

        terminalView.setTerminalViewClient(this)
        terminalView.isFocusable = true
        terminalView.isFocusableInTouchMode = true

        // Set default font and size
        val defaultTypeface = FontManager.getTypeface(context, "jetbrains-mono")
        terminalView.setTextSize(DEFAULT_FONT_SIZE)
        terminalView.setTypeface(defaultTypeface)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        // Ensure TerminalView fills the entire ExpoView frame
        terminalView.layout(0, 0, right - left, bottom - top)
    }

    // --- Session Management ---

    fun attachShellySession(shellySession: ShellyTerminalSession, sessionId: String) {
        currentShellySession = shellySession
        currentSessionId = sessionId
        terminalView.attachSession(shellySession.terminalSession)
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
        terminalView.setTextSize(size)
    }

    fun setCursorShape(shape: String) {
        // TerminalEmulator cursor styles: 0=block, 1=underline, 2=bar
        val emulator = terminalView.mEmulator ?: return
        val style = when (shape) {
            "underline" -> 1
            "bar" -> 2
            else -> 0 // block
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
        if (enabled) {
            setTerminalCursorBlinkerRate(500)
        } else {
            setTerminalCursorBlinkerRate(0)
        }
    }

    // --- Battery Optimization ---

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

    // --- Scroll Ownership ---

    override fun onInterceptTouchEvent(event: MotionEvent?): Boolean {
        // Intercept vertical scroll events so parent ScrollView doesn't steal them
        return true
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
        val emulator = terminalView.mEmulator ?: return
        terminalView.setTopRow(0)
        terminalView.invalidate()
    }

    fun scrollToTopCommand() {
        val emulator = terminalView.mEmulator ?: return
        val topRow = -(emulator.screen.activeTranscriptRows)
        terminalView.setTopRow(topRow)
        terminalView.invalidate()
    }

    fun selectAllCommand() {
        // Not directly supported; use getTranscriptText from session
    }

    fun clearSelectionCommand() {
        terminalView.stopTextSelectionMode()
    }

    fun getSelectedTextCommand(): String? {
        return terminalView.getSelectedText()
    }

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

    override fun onScale(scale: Float): Float {
        return scale.coerceIn(0.5f, 2.0f)
    }

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
            val text = terminalView.getSelectedText()
            if (text != null) {
                onSelectionChangedEvent?.invoke(text)
            }
        }
    }

    override fun onKeyDown(keyCode: Int, e: KeyEvent, session: TerminalSession): Boolean {
        return inputHandler.onKeyDown(keyCode, e, session)
    }

    override fun onKeyUp(keyCode: Int, e: KeyEvent): Boolean {
        return inputHandler.onKeyUp(keyCode, e)
    }

    override fun onLongPress(event: MotionEvent): Boolean {
        return false
    }

    override fun readControlKey(): Boolean = inputHandler.ctrlDown
    override fun readAltKey(): Boolean = inputHandler.altDown
    override fun readShiftKey(): Boolean = inputHandler.shiftDown
    override fun readFnKey(): Boolean = inputHandler.fnDown

    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession): Boolean {
        return inputHandler.onCodePoint(codePoint, ctrlDown, session)
    }

    override fun onEmulatorSet() {
        terminalView.invalidate()
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
