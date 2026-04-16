package expo.modules.terminalview

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.KeyEvent
import com.termux.terminal.TerminalSession

/**
 * Handles key event translation for the terminal view.
 * Maps Android KeyEvents and IME input to terminal escape sequences.
 */
class ShellyInputHandler {

    companion object {
        private const val TAG = "ShellyInputHandler"
    }

    /** Set by ShellyTerminalView to enable Ctrl+Shift+C/V clipboard */
    var clipboardCopy: (() -> Boolean)? = null
    var clipboardPaste: ((TerminalSession) -> Boolean)? = null

    // Modifier key state tracking (for soft keyboard virtual modifiers)
    @Volatile var ctrlDown = false
    @Volatile var altDown = false
    @Volatile var shiftDown = false
    @Volatile var fnDown = false

    /**
     * Handle a key down event. Returns true if the event was consumed.
     */
    fun onKeyDown(keyCode: Int, event: KeyEvent, session: TerminalSession?): Boolean {
        if (session == null) return false

        // Track modifier keys
        when (keyCode) {
            KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.KEYCODE_CTRL_RIGHT -> {
                ctrlDown = true
                return true
            }
            KeyEvent.KEYCODE_ALT_LEFT, KeyEvent.KEYCODE_ALT_RIGHT -> {
                altDown = true
                return true
            }
            KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.KEYCODE_SHIFT_RIGHT -> {
                shiftDown = true
                return true
            }
        }

        val effectiveCtrl = ctrlDown || event.isCtrlPressed
        val effectiveAlt = altDown || event.isAltPressed
        val effectiveShift = shiftDown || event.isShiftPressed

        // Ctrl+Shift+C → clipboard copy (not SIGINT)
        if (effectiveCtrl && effectiveShift && keyCode == KeyEvent.KEYCODE_C) {
            clipboardCopy?.invoke()
            return true
        }
        // Ctrl+Shift+V → clipboard paste
        if (effectiveCtrl && effectiveShift && keyCode == KeyEvent.KEYCODE_V) {
            clipboardPaste?.invoke(session)
            return true
        }

        // Handle special key combinations
        val sequence = getKeySequence(keyCode, effectiveCtrl, effectiveAlt, effectiveShift)
        if (sequence != null) {
            writeToSession(session, sequence)
            return true
        }

        return false
    }

    /**
     * Handle a key up event. Returns true if the event was consumed.
     */
    fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        when (keyCode) {
            KeyEvent.KEYCODE_CTRL_LEFT, KeyEvent.KEYCODE_CTRL_RIGHT -> {
                ctrlDown = false
                return true
            }
            KeyEvent.KEYCODE_ALT_LEFT, KeyEvent.KEYCODE_ALT_RIGHT -> {
                altDown = false
                return true
            }
            KeyEvent.KEYCODE_SHIFT_LEFT, KeyEvent.KEYCODE_SHIFT_RIGHT -> {
                shiftDown = false
                return true
            }
        }
        return false
    }

    /**
     * Handle a code point from IME input. Returns true if consumed.
     */
    fun onCodePoint(codePoint: Int, ctrlHeld: Boolean, session: TerminalSession?): Boolean {
        // Let TerminalView's inputCodePoint handle all character input via
        // the standard Termux path (writeCodePoint → screen update → invalidate).
        // Previously this method handled everything and returned true, which
        // bypassed screen refresh and caused Enter/BS to appear stuck until
        // the view was tapped (forcing an invalidate).
        return false
    }

    /**
     * Convert a key code + modifiers to a terminal escape sequence.
     */
    private fun getKeySequence(keyCode: Int, ctrl: Boolean, alt: Boolean, shift: Boolean): String? {
        // Ctrl+C, Ctrl+D, Ctrl+Z etc.
        if (ctrl) {
            val controlChar = when (keyCode) {
                KeyEvent.KEYCODE_A -> "\u0001"
                KeyEvent.KEYCODE_B -> "\u0002"
                KeyEvent.KEYCODE_C -> "\u0003" // SIGINT
                KeyEvent.KEYCODE_D -> "\u0004" // EOF
                KeyEvent.KEYCODE_E -> "\u0005"
                KeyEvent.KEYCODE_F -> "\u0006"
                KeyEvent.KEYCODE_G -> "\u0007"
                KeyEvent.KEYCODE_H -> "\u0008"
                KeyEvent.KEYCODE_I -> "\u0009" // Tab
                KeyEvent.KEYCODE_J -> "\u000A"
                KeyEvent.KEYCODE_K -> "\u000B"
                KeyEvent.KEYCODE_L -> "\u000C" // Clear screen
                KeyEvent.KEYCODE_M -> "\u000D"
                KeyEvent.KEYCODE_N -> "\u000E"
                KeyEvent.KEYCODE_O -> "\u000F"
                KeyEvent.KEYCODE_P -> "\u0010"
                KeyEvent.KEYCODE_Q -> "\u0011"
                KeyEvent.KEYCODE_R -> "\u0012" // Reverse search
                KeyEvent.KEYCODE_S -> "\u0013"
                KeyEvent.KEYCODE_T -> "\u0014"
                KeyEvent.KEYCODE_U -> "\u0015"
                KeyEvent.KEYCODE_V -> "\u0016"
                KeyEvent.KEYCODE_W -> "\u0017"
                KeyEvent.KEYCODE_X -> "\u0018"
                KeyEvent.KEYCODE_Y -> "\u0019"
                KeyEvent.KEYCODE_Z -> "\u001A" // SIGTSTP
                KeyEvent.KEYCODE_LEFT_BRACKET -> "\u001B" // ESC
                KeyEvent.KEYCODE_BACKSLASH -> "\u001C"
                KeyEvent.KEYCODE_RIGHT_BRACKET -> "\u001D"
                KeyEvent.KEYCODE_6 -> "\u001E" // Ctrl+^
                KeyEvent.KEYCODE_MINUS -> "\u001F"
                KeyEvent.KEYCODE_SPACE -> "\u0000" // Ctrl+Space -> NUL
                else -> null
            }
            if (controlChar != null) return controlChar
        }

        // Arrow keys, function keys, etc.
        val prefix = if (alt) "\u001b" else ""
        val modParam = when {
            ctrl && shift -> ";6"
            ctrl -> ";5"
            alt && shift -> ";4"
            alt -> ";3"
            shift -> ";2"
            else -> ""
        }

        return when (keyCode) {
            // Arrow keys
            KeyEvent.KEYCODE_DPAD_UP -> if (modParam.isNotEmpty()) "${prefix}\u001b[1${modParam}A" else "${prefix}\u001b[A"
            KeyEvent.KEYCODE_DPAD_DOWN -> if (modParam.isNotEmpty()) "${prefix}\u001b[1${modParam}B" else "${prefix}\u001b[B"
            KeyEvent.KEYCODE_DPAD_RIGHT -> if (modParam.isNotEmpty()) "${prefix}\u001b[1${modParam}C" else "${prefix}\u001b[C"
            KeyEvent.KEYCODE_DPAD_LEFT -> if (modParam.isNotEmpty()) "${prefix}\u001b[1${modParam}D" else "${prefix}\u001b[D"

            // Navigation keys
            KeyEvent.KEYCODE_MOVE_HOME -> "${prefix}\u001b[H"
            KeyEvent.KEYCODE_MOVE_END -> "${prefix}\u001b[F"
            KeyEvent.KEYCODE_INSERT -> "${prefix}\u001b[2~"
            KeyEvent.KEYCODE_FORWARD_DEL -> "${prefix}\u001b[3~"
            KeyEvent.KEYCODE_PAGE_UP -> "${prefix}\u001b[5~"
            KeyEvent.KEYCODE_PAGE_DOWN -> "${prefix}\u001b[6~"

            // Tab
            KeyEvent.KEYCODE_TAB -> if (shift) "\u001b[Z" else "\t"

            // Enter
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> "\r"

            // Backspace
            KeyEvent.KEYCODE_DEL -> "\u007F"

            // Escape
            KeyEvent.KEYCODE_ESCAPE -> "\u001b"

            // Function keys
            KeyEvent.KEYCODE_F1 -> "${prefix}\u001bOP"
            KeyEvent.KEYCODE_F2 -> "${prefix}\u001bOQ"
            KeyEvent.KEYCODE_F3 -> "${prefix}\u001bOR"
            KeyEvent.KEYCODE_F4 -> "${prefix}\u001bOS"
            KeyEvent.KEYCODE_F5 -> "${prefix}\u001b[15~"
            KeyEvent.KEYCODE_F6 -> "${prefix}\u001b[17~"
            KeyEvent.KEYCODE_F7 -> "${prefix}\u001b[18~"
            KeyEvent.KEYCODE_F8 -> "${prefix}\u001b[19~"
            KeyEvent.KEYCODE_F9 -> "${prefix}\u001b[20~"
            KeyEvent.KEYCODE_F10 -> "${prefix}\u001b[21~"
            KeyEvent.KEYCODE_F11 -> "${prefix}\u001b[23~"
            KeyEvent.KEYCODE_F12 -> "${prefix}\u001b[24~"

            else -> null
        }
    }

    /**
     * Convert a unicode code point to a control character when Ctrl is held.
     */
    private fun toControlChar(codePoint: Int): String? {
        // a-z -> 1-26
        if (codePoint in 'a'.code..'z'.code) {
            return String(charArrayOf((codePoint - 'a'.code + 1).toChar()))
        }
        if (codePoint in 'A'.code..'Z'.code) {
            return String(charArrayOf((codePoint - 'A'.code + 1).toChar()))
        }
        return when (codePoint) {
            ' '.code -> "\u0000"
            '['.code -> "\u001b"
            '\\'.code -> "\u001c"
            ']'.code -> "\u001d"
            '^'.code -> "\u001e"
            '_'.code -> "\u001f"
            else -> null
        }
    }

    private fun writeToSession(session: TerminalSession, data: String) {
        val bytes = data.toByteArray(Charsets.UTF_8)
        session.write(bytes, 0, bytes.size)
    }

    /**
     * Reset all modifier key state.
     */
    fun resetModifiers() {
        ctrlDown = false
        altDown = false
        shiftDown = false
        fnDown = false
    }
}
