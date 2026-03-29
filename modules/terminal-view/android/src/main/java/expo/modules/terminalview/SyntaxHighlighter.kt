package expo.modules.terminalview

import com.termux.terminal.TerminalBuffer
import com.termux.terminal.TerminalRow
import com.termux.terminal.TextStyle

/**
 * Warp-style syntax highlighter for terminal output.
 * Analyzes screen buffer rows and applies semantic colors:
 * - Command names after prompt ($/#/%) → green
 * - Options (--flag, -f) → cyan
 * - Paths (/path/to/file, ./relative) → blue underline
 * - Strings ("...", '...') → yellow
 * - Error keywords → red
 * - Numbers → magenta
 *
 * This works by post-processing the TerminalRow style attributes
 * ONLY for cells that don't already have explicit ANSI colors set.
 * Programs that set their own colors (vim, htop, Claude Code) are untouched.
 */
object SyntaxHighlighter {

    // Colors (ANSI 256-color indices)
    private const val COLOR_COMMAND = 2    // Green
    private const val COLOR_OPTION = 6     // Cyan
    private const val COLOR_PATH = 4       // Blue
    private const val COLOR_STRING = 3     // Yellow
    private const val COLOR_ERROR = 1      // Red
    private const val COLOR_NUMBER = 5     // Magenta
    private const val COLOR_PROMPT = 2     // Green (for $ prompt)

    // Prompt characters
    private val PROMPT_CHARS = charArrayOf('$', '#', '%', '>')

    // Error keywords (case-insensitive matching done in code)
    private val ERROR_KEYWORDS = arrayOf(
        "error", "Error", "ERROR",
        "failed", "Failed", "FAILED",
        "fatal", "Fatal", "FATAL",
        "denied", "Denied", "DENIED",
        "not found", "No such file",
        "permission denied",
        "segfault", "panic", "PANIC",
        "exception", "Exception"
    )

    /**
     * Apply syntax highlighting to a single row.
     * Only modifies cells with default foreground color (white/gray).
     * Returns true if any highlighting was applied.
     */
    fun highlightRow(row: TerminalRow, columns: Int, defaultFg: Int): Boolean {
        val text = extractText(row, columns)
        if (text.isBlank()) return false

        var modified = false

        // Find prompt position
        val promptIdx = findPromptIndex(text)

        if (promptIdx >= 0) {
            // This is a command line — highlight components after prompt
            modified = highlightCommandLine(row, text, promptIdx, columns, defaultFg)
        } else {
            // This is output — highlight errors and paths
            modified = highlightOutput(row, text, columns, defaultFg)
        }

        return modified
    }

    private fun extractText(row: TerminalRow, columns: Int): String {
        val sb = StringBuilder(columns)
        val line = row.mText
        var charIdx = 0
        for (col in 0 until columns) {
            if (charIdx >= line.size) {
                sb.append(' ')
                continue
            }
            val c = line[charIdx]
            if (Character.isHighSurrogate(c) && charIdx + 1 < line.size) {
                sb.append(c)
                sb.append(line[charIdx + 1])
                charIdx += 2
            } else {
                sb.append(c)
                charIdx++
            }
        }
        return sb.toString()
    }

    private fun findPromptIndex(text: String): Int {
        // Find "$ " or "# " or "% " or "> " pattern
        for (i in text.indices) {
            if (i + 1 < text.length && text[i + 1] == ' ' && text[i] in PROMPT_CHARS) {
                // Verify it's likely a prompt (not in the middle of output)
                // Prompt typically appears after path or username
                return i
            }
        }
        return -1
    }

    private fun highlightCommandLine(row: TerminalRow, text: String, promptIdx: Int, columns: Int, defaultFg: Int): Boolean {
        var modified = false
        val afterPrompt = promptIdx + 2 // Skip "$ "

        if (afterPrompt >= text.length) return false

        // Parse command line tokens
        var i = afterPrompt
        var isFirstToken = true
        var inString = false
        var stringChar = ' '

        while (i < text.length && i < columns) {
            val c = text[i]

            // Skip spaces
            if (c == ' ' && !inString) {
                isFirstToken = false
                i++
                continue
            }

            // String detection
            if ((c == '"' || c == '\'') && !inString) {
                inString = true
                stringChar = c
                val start = i
                i++
                while (i < text.length && i < columns && !(text[i] == stringChar && text[i - 1] != '\\')) i++
                if (i < columns) i++ // closing quote
                if (setColorRange(row, start, i, COLOR_STRING, defaultFg)) modified = true
                continue
            }

            if (inString && c == stringChar) {
                inString = false
                i++
                continue
            }

            // Option detection (--flag or -f)
            if (c == '-' && !inString) {
                val start = i
                i++
                if (i < text.length && text[i] == '-') i++ // --long-option
                while (i < text.length && i < columns && text[i] != ' ') i++
                if (setColorRange(row, start, i, COLOR_OPTION, defaultFg)) modified = true
                continue
            }

            // Path detection (/path or ./path or ~/path)
            if ((c == '/' || (c == '.' && i + 1 < text.length && text[i + 1] == '/') ||
                 (c == '~' && i + 1 < text.length && text[i + 1] == '/')) && !inString) {
                val start = i
                while (i < text.length && i < columns && text[i] != ' ') i++
                if (setColorRange(row, start, i, COLOR_PATH, defaultFg)) modified = true
                continue
            }

            // Number detection
            if (c.isDigit() && !inString && !isFirstToken) {
                val start = i
                while (i < text.length && i < columns && (text[i].isDigit() || text[i] == '.')) i++
                if (i > start + 0) {
                    if (setColorRange(row, start, i, COLOR_NUMBER, defaultFg)) modified = true
                }
                continue
            }

            // First token = command name
            if (isFirstToken && c != ' ') {
                val start = i
                while (i < text.length && i < columns && text[i] != ' ') i++
                if (setColorRange(row, start, i, COLOR_COMMAND, defaultFg)) modified = true
                isFirstToken = false
                continue
            }

            i++
        }

        return modified
    }

    private fun highlightOutput(row: TerminalRow, text: String, columns: Int, defaultFg: Int): Boolean {
        var modified = false

        // Error keyword highlighting
        for (keyword in ERROR_KEYWORDS) {
            var idx = text.indexOf(keyword)
            while (idx >= 0) {
                if (setColorRange(row, idx, idx + keyword.length, COLOR_ERROR, defaultFg)) {
                    modified = true
                }
                idx = text.indexOf(keyword, idx + keyword.length)
            }
        }

        // Path highlighting in output
        var i = 0
        while (i < text.length && i < columns) {
            if (text[i] == '/' && (i == 0 || text[i - 1] == ' ' || text[i - 1] == ':')) {
                val start = i
                while (i < text.length && i < columns && text[i] != ' ' && text[i] != ':' && text[i] != ')') i++
                if (i - start > 2) { // Minimum path length
                    if (setColorRange(row, start, i, COLOR_PATH, defaultFg)) modified = true
                }
            } else {
                i++
            }
        }

        return modified
    }

    /**
     * Set foreground color for a range of columns, but ONLY if the cell
     * currently has the default foreground color. This preserves existing
     * ANSI colors from programs like vim, htop, Claude Code, etc.
     */
    private fun setColorRange(row: TerminalRow, startCol: Int, endCol: Int, colorIdx: Int, defaultFg: Int): Boolean {
        var modified = false
        for (col in startCol until endCol) {
            if (col >= row.mText.size) break
            val style = row.getStyle(col)
            val currentFg = TextStyle.decodeForeColor(style)
            // Only override if using default foreground
            if (currentFg == defaultFg || currentFg == TextStyle.COLOR_INDEX_FOREGROUND) {
                val bg = TextStyle.decodeBackColor(style)
                val effect = TextStyle.decodeEffect(style)
                row.setStyle(col, TextStyle.encode(colorIdx, bg, effect))
                modified = true
            }
        }
        return modified
    }
}
