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

        // Black background to match terminal. Flipped to transparent by
        // setTransparentBackground() when the user picks a wallpaper.
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

    /**
     * Phase B (2026-04-21): forward the transparency flag to the GL
     * renderer (so its glClearColor flips) AND the SurfaceView's own
     * background (so the pre-first-frame pixel is see-through). A
     * requestRender() forces the new clear colour to land on the next
     * draw without waiting for an idle tick.
     */
    fun setTransparentBackground(enabled: Boolean) {
        setBackgroundColor(if (enabled) 0x00000000 else 0xFF000000.toInt())
        renderer.transparentBackground = enabled
        requestRender()
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
    // We want the terminal to behave like iTerm2 / gnome-terminal: ASCII
    // symbols commit instantly, but Japanese / CJK conversion shows its
    // in-progress candidates inline on the PTY row and only finalizes on
    // confirm. That is what `TYPE_CLASS_TEXT | NO_SUGGESTIONS` gives us —
    // IMEs that want to compose still can, but autocorrect and predictive
    // substitution are suppressed.
    //
    // Per-composing redraw is tracked on the PTY side: each
    // setComposingText erases the previous compose run, rewrites the new
    // one, and commitText flushes. See the equivalent block in
    // TerminalView.java for the Canvas renderer.
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN

        return object : BaseInputConnection(this, true) {
            // setComposingText does NOT write to the PTY. The IME owns its
            // in-progress buffer via the BaseInputConnection Editable; the
            // candidate bar above the soft keyboard is the user-visible
            // preview. When the user confirms, the IME calls commitText
            // with the final string, which we forward to the PTY once.
            //
            // The previous approach (draw compose directly on the PTY row,
            // erase on each re-compose) broke on Typeless (voice input),
            // which calls finishComposingText *before* the final commitText
            // and buffers the commit until the keyboard collapses. See the
            // long comment in TerminalView.java for the full history.

            override fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
                return super.setComposingText(text, newCursorPosition)
            }

            override fun finishComposingText(): Boolean {
                return super.finishComposingText()
            }

            override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
                val session = shellySession?.terminalSession ?: return false
                val s = text?.toString() ?: ""
                if (s.isNotEmpty()) {
                    val bytes = s.toByteArray(Charsets.UTF_8)
                    session.write(bytes, 0, bytes.size)
                }
                return super.commitText(text, newCursorPosition)
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                // Soft keyboards (Gboard, Samsung Keyboard, Nacre, Typeless,
                // most others) deliver BackSpace via this method rather
                // than via sendKeyEvent(KEYCODE_DEL). Forward each DEL to
                // the PTY. Safe now that primeImeBuffer is gone on the
                // Canvas path — the IME never sends phantom deletes.
                val session = shellySession?.terminalSession ?: return super.deleteSurroundingText(beforeLength, afterLength)
                if (beforeLength > 0) {
                    val del = ByteArray(beforeLength) { 0x7F }
                    session.write(del, 0, del.size)
                }
                return super.deleteSurroundingText(beforeLength, afterLength)
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
