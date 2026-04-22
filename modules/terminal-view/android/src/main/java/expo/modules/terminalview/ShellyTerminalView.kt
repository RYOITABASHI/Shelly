package expo.modules.terminalview

import android.app.ActivityManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.TypedValue
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.inputmethod.InputMethodManager
import android.widget.LinearLayout
import expo.modules.terminalview.gl.GLTerminalView
import expo.modules.terminalview.gl.GLTerminalRenderer
import com.termux.terminal.TerminalColors
import com.termux.terminal.TerminalSession
import com.termux.terminal.TextStyle
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
    private var glTerminalView: GLTerminalView? = null
    private var useGPU = false

    // Track last synced size to avoid redundant resize calls
    private var lastSyncedCols = -1
    private var lastSyncedRows = -1

    // Debounce handler for terminal resize
    private val resizeHandler = Handler(Looper.getMainLooper())

    // Track last size to detect actual changes
    private var lastWidth = -1
    private var lastHeight = -1

    // Phase B: when a wallpaper is set on the JS side, this flips on and
    // both this ExpoView wrapper and the inner TerminalView stop painting
    // an opaque background behind the terminal content. The Termux
    // renderer already skips the default-bg cell fill (TerminalRenderer
    // line 231), so transparency propagates through for free.
    private var transparentBackground = false

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
        // Black background like a real terminal. Flipped off in
        // setTransparentBackground(true) when the user picks a wallpaper.
        setBackgroundColor(0xFF000000.toInt())
        terminalView.setBackgroundColor(0xFF000000.toInt())

        val padPx = (4 * context.resources.displayMetrics.density).toInt()
        terminalView.setPadding(padPx, 0, padPx, 0)

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

        // Wire block start detection for GL renderer
        blockDetector.onBlockStarted = lambda@{ command ->
            val gl = glTerminalView ?: return@lambda
            val emulator = terminalView.mEmulator ?: gl.renderer.session?.terminalSession?.emulator ?: return@lambda
            val cursorRow = emulator.getCursorRow()
            val topRow = emulator.screen.activeTranscriptRows
            val absoluteRow = topRow + cursorRow

            gl.renderer.addBlock(GLTerminalRenderer.BlockRange(
                commandStartRow = absoluteRow,
                outputStartRow = absoluteRow + 1,
                endRow = -1, exitCode = -1,
                command = command,
                isCollapsed = false, isRunning = true
            ))
        }

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

        // Wire BlockDetector + link detection + JS output events to the
        // session's delta-text stream. Under the Plan B architecture PTY
        // output flows directly into the emulator via JNI — nothing else
        // feeds processTerminalOutput, so without this line Command Block
        // chrome never renders and onBlockCompleted never fires on JS.
        shellySession.onOutputDelta = { text -> processTerminalOutput(text) }

        if (useGPU && glTerminalView != null) {
            glTerminalView?.attachSession(shellySession, inputHandler)
            shellySession.onScreenUpdateCallback = {
                glTerminalView?.post { glTerminalView?.renderer?.onScreenUpdated() }
            }
        } else {
            terminalView.attachSession(shellySession.terminalSession)
            shellySession.onScreenUpdateCallback = {
                terminalView.post { terminalView.onScreenUpdated() }
            }
        }

        // Post updateSize to ensure layout is complete.
        //
        // Fix for the "new-session prompt invisible until I switch away and
        // back" bug. TWO root causes had to be addressed:
        //
        //   (1) Layout race (previous fix, retained): on a fresh splitPane
        //       the very first attachShellySession() can run before
        //       TerminalView.onLayout has fired, so .width/.height are
        //       still 0 and updateSize()+invalidate() below would silently
        //       skip. The OnLayoutChangeListener branch defers the blit
        //       until the view actually has dimensions.
        //
        //   (2) Buffer-content race (new, real cause observed on device):
        //       even when the view IS laid out, attach runs ~18ms after
        //       PTY fork — bash hasn't finished reading .bashrc and
        //       emitting PS1 yet. The emulator buffer is empty at blit
        //       time, so the screen paints blank. onScreenUpdateCallback
        //       *should* pick up the later PS1 arrival and re-invalidate,
        //       but on-device logcat showed that handoff is lossy for the
        //       very first screen write (likely a threading race between
        //       registering the callback and the PTY read loop delivering
        //       bytes). Switching panes and coming back worked because the
        //       re-attach blit ran against a now-populated buffer.
        //
        // Fix for (2): schedule follow-up invalidate() passes at 150ms,
        // 400ms, and 1000ms after attach. Bash startup on Android
        // typically completes in 100-300ms; the three passes bracket the
        // fast, normal, and slow cases without observable flicker
        // (invalidate is a no-op when the view area is already up to date).
        terminalView.post {
            if (terminalView.width > 0 && terminalView.height > 0) {
                Log.i(TAG, "attachSession.post: TerminalView=${terminalView.width}x${terminalView.height}")
                terminalView.updateSize()
                terminalView.invalidate()
                scheduleCatchupBlits()
            } else {
                Log.i(TAG, "attachSession.post: TerminalView not laid out yet (w=${terminalView.width}, h=${terminalView.height}) — deferring blit to onLayout")
                terminalView.addOnLayoutChangeListener(object : View.OnLayoutChangeListener {
                    override fun onLayoutChange(
                        v: View?, left: Int, top: Int, right: Int, bottom: Int,
                        oldLeft: Int, oldTop: Int, oldRight: Int, oldBottom: Int
                    ) {
                        val w = right - left
                        val h = bottom - top
                        if (w > 0 && h > 0) {
                            terminalView.removeOnLayoutChangeListener(this)
                            Log.i(TAG, "attachSession.onLayout: TerminalView=${w}x${h}")
                            terminalView.updateSize()
                            terminalView.invalidate()
                            scheduleCatchupBlits()
                        }
                    }
                })
            }
        }
    }

    /**
     * After the initial attach blit, schedule three follow-up invalidate()
     * passes to catch bash's PS1 emission even if it lands after attach
     * and onScreenUpdateCallback loses the first write to a threading
     * race. See the buffer-content race comment in attachShellySession.
     */
    private fun scheduleCatchupBlits() {
        val delays = longArrayOf(150, 400, 1000)
        for (d in delays) {
            terminalView.postDelayed({
                if (terminalView.width > 0 && currentShellySession != null) {
                    terminalView.invalidate()
                }
            }, d)
        }
    }

    fun detachCurrentSession() {
        currentShellySession?.onScreenUpdateCallback = null
        currentShellySession?.onOutputDelta = null
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

    /**
     * Phase B wallpaper support. When `enabled`, both this ExpoView
     * wrapper and the inner Termux TerminalView drop their opaque black
     * background so the wallpaper behind the whole ShellLayout tree can
     * show through. Cells with a non-default background still paint
     * normally (TerminalRenderer guards default-bg cells at line 231),
     * so prompt colours / syntax highlights stay visible as expected.
     *
     * We also flip the inner TerminalView's `transparentBackground`
     * flag so its padding-region paint at onDraw is skipped in the
     * transparent path. Without that, the padding under mode-line-ish
     * prompts would fill with solid black over the wallpaper.
     */
    fun setTransparentBackground(enabled: Boolean) {
        transparentBackground = enabled
        val color = if (enabled) 0x00000000 else 0xFF000000.toInt()
        setBackgroundColor(color)
        terminalView.setBackgroundColor(color)
        terminalView.setTransparentBackground(enabled)
        terminalView.invalidate()
        // GPU path (when gpuRendering=true): flip the GLSurfaceView's
        // own background AND the renderer's clearColor. Without the
        // renderer forward, glClear would still paint opaque black
        // every frame and hide the wallpaper.
        glTerminalView?.setTransparentBackground(enabled)
    }

    /**
     * Apply a terminal color theme. Expects a map with keys:
     * color0-color15 (ANSI 16), foreground, background, cursor.
     * Values are hex color strings like "#FF5555".
     */
    fun applyThemeColors(colors: Map<String, String>) {
        try {
            val props = java.util.Properties()
            for ((key, value) in colors) {
                // Convert "#RRGGBB" to "rgb:RR/GG/BB" format expected by TerminalColorScheme
                val hex = value.removePrefix("#")
                if (hex.length == 6) {
                    val r = hex.substring(0, 2)
                    val g = hex.substring(2, 4)
                    val b = hex.substring(4, 6)
                    props.setProperty(key, "rgb:$r/$g/$b")
                }
            }
            TerminalColors.COLOR_SCHEME.updateWith(props)
            // Reset current session colors to apply the new scheme
            terminalView.mEmulator?.mColors?.reset()
            // Update background color of the view — but only when we are
            // NOT in wallpaper-transparent mode. In transparent mode the
            // view has to stay fully see-through regardless of scheme
            // swaps, otherwise picking a new theme would repaint opaque
            // over the user's wallpaper.
            if (!transparentBackground) {
                val bgColor = TerminalColors.COLOR_SCHEME.mDefaultColors[TextStyle.COLOR_INDEX_BACKGROUND]
                setBackgroundColor(bgColor)
                terminalView.setBackgroundColor(bgColor)
            }
            terminalView.invalidate()
            Log.i(TAG, "applyThemeColors: applied ${colors.size} colors")
        } catch (e: Exception) {
            Log.w(TAG, "applyThemeColors failed", e)
        }
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

    fun setGpuRendering(enabled: Boolean) {
        if (enabled == useGPU) return
        useGPU = enabled && checkGLES30Support()

        if (useGPU) {
            if (glTerminalView == null) {
                glTerminalView = GLTerminalView(context).apply {
                    layoutParams = ViewGroup.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                }
                addView(glTerminalView)
            }
            terminalView.visibility = View.GONE
            glTerminalView?.visibility = View.VISIBLE

            currentShellySession?.let { session ->
                glTerminalView?.attachSession(session, inputHandler)
            }

            glTerminalView?.onBlockLongPressEvent = { command, startRow, endRow, exitCode ->
                onBlockLongPress(mapOf(
                    "command" to command,
                    "startRow" to startRow,
                    "endRow" to endRow,
                    "exitCode" to exitCode
                ))
            }
        } else {
            terminalView.visibility = View.VISIBLE
            glTerminalView?.visibility = View.GONE
        }
    }

    private fun checkGLES30Support(): Boolean {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        return (am?.deviceConfigurationInfo?.reqGlEsVersion ?: 0) >= 0x30000
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
        terminalView.isFocusable = true
        terminalView.isFocusableInTouchMode = true
        terminalView.requestFocusFromTouch()
        showKeyboardWhenServed("focusCommand")
    }

    private fun showKeyboardWhenServed(reason: String) {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
            ?: return

        fun attempt(delayMs: Long) {
            terminalView.postDelayed({
                terminalView.isFocusable = true
                terminalView.isFocusableInTouchMode = true
                terminalView.requestFocusFromTouch()
                imm.restartInput(terminalView)
                val shown = imm.showSoftInput(terminalView, InputMethodManager.SHOW_IMPLICIT)
                if (!shown && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    terminalView.windowInsetsController?.show(WindowInsets.Type.ime())
                }
                Log.i(TAG, "$reason.keyboardRetry delay=$delayMs focused=${terminalView.isFocused} shown=$shown viewHash=${System.identityHashCode(terminalView)}")
            }, delayMs)
        }

        // Samsung/One UI can reject showSoftInput immediately after
        // requestFocus with "view is not served". Wait a few frames so
        // ViewRootImpl has time to bind TerminalView as the served editor.
        attempt(0)
        attempt(50)
        attempt(150)
    }

    fun scrollToRowCommand(row: Int) {
        glTerminalView?.scrollToRow(row) ?: run {
            terminalView.setTopRow(-row)
            terminalView.invalidate()
        }
    }

    fun refreshScreenCommand() {
        if (useGPU && glTerminalView != null) {
            glTerminalView?.post { glTerminalView?.renderer?.onScreenUpdated() }
        } else {
            terminalView.post {
                terminalView.onScreenUpdated()
                terminalView.invalidate()
            }
        }
    }

    // ===== TerminalViewClient Implementation =====

    override fun onScale(scale: Float): Float = scale.coerceIn(0.5f, 2.0f)

    override fun onSingleTapUp(e: MotionEvent) {
        // Speculative fix (bug #116 follow-up 2): in multi-pane layouts,
        // tapping the right pane's body fired onSingleTapUp but the IME
        // stayed hidden because:
        //   (a) a sibling TerminalView (left pane) already owned focus
        //       so requestFocus() could refuse to hand it over, and
        //   (b) some ROMs ignore showSoftInput when the target view isn't
        //       currently the focused one.
        // Force clear any prior focus, flip the focusable flags on, then
        // request focus in touch mode. This matches how Termux's own
        // TerminalView initializes focus in onCreate.
        terminalView.isFocusable = true
        terminalView.isFocusableInTouchMode = true
        val rootFocused = rootView?.findFocus()
        if (rootFocused != null && rootFocused !== terminalView) {
            rootFocused.clearFocus()
        }
        val reqOk = terminalView.requestFocusFromTouch()
        val hasWinFocus = terminalView.hasWindowFocus()
        val isFocused = terminalView.isFocused
        val isFocusable = terminalView.isFocusable
        val visibility = terminalView.visibility
        val width = terminalView.width
        val height = terminalView.height
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.restartInput(terminalView)
        val imeShown = imm?.showSoftInput(terminalView, InputMethodManager.SHOW_IMPLICIT) ?: false
        val sid = currentSessionId ?: ""
        Log.i(TAG, "onSingleTapUp sess=$sid reqFocus=$reqOk hasWin=$hasWinFocus focused=$isFocused focusable=$isFocusable vis=$visibility size=${width}x${height} imeShow=$imeShown prevFocusWas=${rootFocused?.javaClass?.simpleName}#${if (rootFocused != null) System.identityHashCode(rootFocused) else 0} viewHash=${System.identityHashCode(terminalView)}")
        showKeyboardWhenServed("onSingleTapUp")
        onFocusRequested(mapOf("sessionId" to sid))
    }

    // Bug: Samsung / Gboard soft keyboards fire KEYCODE_BACK when the
    // user taps the "hide keyboard" button. When this mapping was true,
    // BACK turned into ESC and reached the PTY — gemini exited with
    // "escape was pressed", vim popped out of insert mode, any REPL
    // doing ESC-bracket-seq parsing saw a bare ESC and cancelled.
    // Users have a dedicated Esc button on CommandKeyBar for intentional
    // ESC, so disabling this mapping is net-positive UX: hide-keyboard
    // just hides the keyboard like everywhere else in Android.
    override fun shouldBackButtonBeMappedToEscape(): Boolean = false
    // Leave char-based input OFF so TerminalView picks the
    // TYPE_CLASS_TEXT | NO_SUGGESTIONS branch. This keeps the IME's
    // composing path alive — Japanese / CJK users can see the in-progress
    // conversion inline on the PTY row before hitting Enter to confirm,
    // matching what desktop terminals like iTerm2 and the recent Claude
    // Code inline-input update do. ASCII symbols still commit immediately
    // because the IME does not compose them.
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
    // PC-terminal mode: never force-uppercase input through readShiftKey.
    // The previous implementation returned inputHandler.shiftDown, which
    // could latch on and cause every character to be uppercased inside
    // TerminalView.sendTextToTerminal (line ~495, `codePoint =
    // Character.toUpperCase(codePoint)`). Hardware Shift still works —
    // KeyEvent.isShiftPressed() is read directly at line ~923 of
    // TerminalView and carries the real per-event meta state. IMEs are
    // responsible for sending already-uppercased characters via commitText
    // when the user hits the shifted variant.
    override fun readShiftKey(): Boolean = false
    override fun readFnKey(): Boolean = inputHandler.fnDown

    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession): Boolean =
        inputHandler.onCodePoint(codePoint, ctrlDown || inputHandler.ctrlDown, session)

    // Expo EventDispatchers — emit to JS
    private val onResize by EventDispatcher()
    private val onScrollStateChanged by EventDispatcher()
    private val onBlockLongPress by EventDispatcher()
    // bug #116 follow-up: RN's onTouchStart on the parent <View> never fires
    // for taps inside the terminal body because TerminalView calls
    // requestDisallowInterceptTouchEvent(true). So `handleFocusPane` in
    // PaneSlot only ran for header/tab taps, leaving body taps with stale
    // per-pane focus. This event lets JS learn a pane was tapped and run
    // the same 4-store handoff regardless of which region was touched.
    private val onFocusRequested by EventDispatcher()

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

        // Direct PTY resize via JNI ioctl(TIOCSWINSZ)
        currentShellySession?.resize(rows, cols)
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
