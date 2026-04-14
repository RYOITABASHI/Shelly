package expo.modules.terminalview.gl

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.opengl.GLSurfaceView
import android.text.InputType
import android.util.Log
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import com.termux.terminal.TerminalSession
import com.termux.view.TerminalViewClient
import expo.modules.terminalemulator.ShellyTerminalSession
import expo.modules.terminalview.ShellyInputHandler

/**
 * GLSurfaceView-based terminal view with GPU rendering.
 * Replaces TerminalView when GPU rendering is enabled.
 *
 * Handles:
 * - InputConnection (IME, keyboard)
 * - Gesture detection (tap to focus, long-press for block panel)
 * - TerminalViewClient delegation to ShellyInputHandler
 * - Block chrome touch handling (fold/unfold, copy)
 */
class GLTerminalView(context: Context) : GLSurfaceView(context) {
    companion object {
        private const val TAG = "GLTerminalView"
        private const val LONG_PRESS_MS = 500L
    }

    val renderer = GLTerminalRenderer(context)
    private var inputHandler: ShellyInputHandler? = null
    private var shellySession: ShellyTerminalSession? = null
    private lateinit var gestureDetector: GestureDetector

    // Event callbacks (set by ShellyTerminalView)
    var onBlockLongPressEvent: ((command: String, startRow: Int, endRow: Int, exitCode: Int) -> Unit)? = null

    init {
        setEGLContextClientVersion(3)
        // Transparent background — prevent white flash before first draw
        setEGLConfigChooser(8, 8, 8, 8, 0, 0)
        holder.setFormat(android.graphics.PixelFormat.TRANSLUCENT)
        setZOrderOnTop(false)  // Stay below other views but render properly
        setRenderer(renderer)
        renderMode = RENDERMODE_WHEN_DIRTY
        preserveEGLContextOnPause = true

        // Black background to match terminal
        setBackgroundColor(0xFF000000.toInt())

        isFocusable = true
        isFocusableInTouchMode = true

        renderer.requestRenderCallback = { requestRender() }

        gestureDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                requestFocus()
                val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
                imm?.showSoftInput(this@GLTerminalView, 0)
                return true
            }

            override fun onLongPress(e: MotionEvent) {
                handleLongPress(e)
            }

            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distX: Float, distY: Float): Boolean {
                renderer.scrollAnimator.setOffset(renderer.scrollAnimator.scrollOffset - distY)
                renderer.markDirty(GLTerminalRenderer.DirtyFlags.SCROLL)
                return true
            }

            override fun onFling(e1: MotionEvent?, e2: MotionEvent, velX: Float, velY: Float): Boolean {
                renderer.scrollAnimator.fling(-velY * 0.01f)
                renderer.markDirty(GLTerminalRenderer.DirtyFlags.SCROLL)
                return true
            }
        })
    }

    fun attachSession(session: ShellyTerminalSession, handler: ShellyInputHandler) {
        shellySession = session
        inputHandler = handler
        renderer.session = session

        session.onScreenUpdateCallback = {
            post { renderer.onScreenUpdated() }
        }
    }

    fun detachSession() {
        shellySession?.onScreenUpdateCallback = null
        shellySession = null
        renderer.session = null
    }

    // === InputConnection (IME support) ===
    //
    // We want a "raw PTY" input mode — every keystroke should land in the
    // terminal as-is, not sit in an IME composition buffer that only
    // flushes on a finishComposingText() event. Two consequences of the
    // old path (inputType = TYPE_TEXT_VARIATION_VISIBLE_PASSWORD +
    // default BaseInputConnection compose handling):
    //
    //   1. Symbols, URLs, paths — anything the IME *doesn't* send
    //      through its candidate bar — arrived instantly via commitText.
    //      But letters and kana were held by the IME until the user
    //      picked a candidate, so they were invisible on the terminal
    //      until confirmation. Mixed visibility = confusing.
    //   2. Some IMEs (Samsung Keyboard's predictive mode, swipe input,
    //      any keyboard that calls setComposingText instead of
    //      commitText) ended up swallowing the first character on
    //      paste/auto-correct because commitText was never called for
    //      the composing run.
    //
    // Fix: declare the View as a TYPE_NULL text editor. TYPE_NULL is the
    // Android-blessed way for terminal emulators to say "I am a dumb
    // character sink — don't compose, don't autocorrect, don't suggest."
    // IMEs that respect the flag (Gboard, Samsung Keyboard, Nacre)
    // will fall back to direct KeyEvent delivery, which is exactly the
    // behavior this app wants.
    //
    // We still override setComposingText / finishComposingText as a
    // safety net for keyboards that call them anyway — commit the text
    // immediately instead of buffering.
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = InputType.TYPE_NULL
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or
            EditorInfo.IME_FLAG_NO_EXTRACT_UI or
            EditorInfo.IME_ACTION_NONE

        return object : BaseInputConnection(this, true) {
            override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
                writeToSession(text)
                return true
            }

            // If the IME still tries to compose (some keyboards ignore
            // TYPE_NULL), forward the in-progress text as if it were
            // already committed. Each keystroke becomes visible on the
            // terminal immediately — matching the symbol path.
            override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
                writeToSession(text)
                return true
            }

            override fun finishComposingText(): Boolean {
                // Nothing to do — we already flushed each setComposingText
                // call. Returning true tells the IME the composition is
                // accepted.
                return true
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                val session = shellySession?.terminalSession ?: return false
                for (i in 0 until beforeLength) {
                    session.write(byteArrayOf(0x7F), 0, 1) // DEL
                }
                return true
            }

            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    val session = shellySession?.terminalSession
                    inputHandler?.onKeyDown(event.keyCode, event, session) ?: return false
                } else if (event.action == KeyEvent.ACTION_UP) {
                    inputHandler?.onKeyUp(event.keyCode, event) ?: return false
                }
                return true
            }

            private fun writeToSession(text: CharSequence) {
                if (text.isEmpty()) return
                val session = shellySession?.terminalSession ?: return
                val bytes = text.toString().toByteArray(Charsets.UTF_8)
                session.write(bytes, 0, bytes.size)
            }
        }
    }

    override fun onCheckIsTextEditor(): Boolean = true

    // === Touch Handling ===

    override fun onTouchEvent(event: MotionEvent): Boolean {
        // Check block chrome hit areas first
        if (event.action == MotionEvent.ACTION_UP) {
            if (handleBlockChromeTap(event)) return true
        }
        return gestureDetector.onTouchEvent(event) || super.onTouchEvent(event)
    }

    private fun handleBlockChromeTap(event: MotionEvent): Boolean {
        val cellW = renderer.atlas.cellWidth
        val cellH = renderer.atlas.cellHeight
        if (cellW == 0f || cellH == 0f) return false

        val row = (event.y / cellH).toInt()
        val col = (event.x / cellW).toInt()
        val cols = (width / cellW).toInt()

        synchronized(renderer) {
            val block = renderer.blockRanges.find { row == it.commandStartRow } ?: return false

            return when {
                col == 0 -> {
                    // Chevron — toggle fold
                    val idx = renderer.blockRanges.indexOf(block)
                    renderer.updateBlock(idx) { it.copy(isCollapsed = !it.isCollapsed) }
                    true
                }
                col >= cols - 1 -> {
                    // Copy button
                    copyBlockOutput(block)
                    true
                }
                else -> false
            }
        }
    }

    private fun handleLongPress(event: MotionEvent) {
        val cellH = renderer.atlas.cellHeight
        if (cellH == 0f) return
        val row = (event.y / cellH).toInt()

        synchronized(renderer) {
            val block = renderer.blockRanges.find {
                row in it.commandStartRow..(if (it.endRow >= 0) it.endRow else it.commandStartRow)
            } ?: return

            onBlockLongPressEvent?.invoke(block.command, block.commandStartRow, block.endRow, block.exitCode)
        }
    }

    private fun copyBlockOutput(block: GLTerminalRenderer.BlockRange) {
        val session = shellySession?.terminalSession?.emulator ?: return
        val sb = StringBuilder()
        val startRow = block.outputStartRow
        val endRow = if (block.endRow >= 0) block.endRow else startRow
        synchronized(session) {
            for (r in startRow..endRow) {
                val row = try { session.screen.getRow(r) } catch (_: Exception) { continue }
                for (c in 0 until session.mColumns) {
                    val charIdx = row.findStartOfColumn(c)
                    val spaceUsed = row.getSpaceUsed()
                    val cp = if (charIdx < spaceUsed) {
                        val ch = row.mText[charIdx]
                        if (Character.isHighSurrogate(ch) && charIdx + 1 < spaceUsed)
                            Character.toCodePoint(ch, row.mText[charIdx + 1])
                        else ch.code
                    } else 0
                    if (cp > 0x20) sb.appendCodePoint(cp)
                }
                if (r < endRow) sb.append('\n')
            }
        }
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        clipboard?.setPrimaryClip(ClipData.newPlainText("Block Output", sb.toString()))
    }

    fun scrollToRow(row: Int) {
        renderer.scrollAnimator.scrollToRow(row, renderer.atlas.cellHeight)
        renderer.markDirty(GLTerminalRenderer.DirtyFlags.SCROLL)
    }

    fun destroy() {
        detachSession()
        renderer.destroy()
    }
}
