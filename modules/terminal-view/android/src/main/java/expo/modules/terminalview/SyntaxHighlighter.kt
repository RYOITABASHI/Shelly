package expo.modules.terminalview

import com.termux.terminal.TerminalBuffer
import com.termux.terminal.TerminalRow
import com.termux.terminal.TextStyle
import com.termux.terminal.WcWidth

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

    /**
     * Mappings between column positions and text string indices, built by extractText().
     * textIdxToCol maps each text char index to the column it starts at.
     * Used by setColorRange to convert text-based ranges to column-based style updates.
     */
    private var colToTextIdx: IntArray = IntArray(0)
    private var textIdxToCol: IntArray = IntArray(0)
    private var lastExtractedColumns: Int = 0

    private fun extractText(row: TerminalRow, columns: Int): String {
        val sb = StringBuilder(columns)
        val line = row.mText
        val spaceUsed = row.spaceUsed
        if (colToTextIdx.size < columns + 1) colToTextIdx = IntArray(columns + 1)
        var charIdx = 0
        var col = 0
        while (col < columns) {
            colToTextIdx[col] = sb.length
            if (charIdx >= spaceUsed) {
                sb.append(' ')
                col++
                continue
            }
            val c = line[charIdx]
            val isHigh = Character.isHighSurrogate(c)
            val codePoint = if (isHigh && charIdx + 1 < spaceUsed)
                Character.toCodePoint(c, line[charIdx + 1]) else c.code
            val w = WcWidth.width(codePoint)
            if (isHigh && charIdx + 1 < spaceUsed) {
                sb.append(c)
                sb.append(line[charIdx + 1])
                charIdx += 2
            } else {
                sb.append(c)
                charIdx++
            }
            // Skip combining characters (width <= 0)
            while (charIdx < spaceUsed) {
                val nc = line[charIdx]
                val ncp = if (Character.isHighSurrogate(nc) && charIdx + 1 < spaceUsed)
                    Character.toCodePoint(nc, line[charIdx + 1]) else nc.code
                if (WcWidth.width(ncp) > 0) break
                if (Character.isHighSurrogate(nc)) { sb.append(nc); sb.append(line[charIdx + 1]); charIdx += 2 }
                else { sb.append(nc); charIdx++ }
            }
            if (w == 2 && col + 1 < columns) {
                // Wide char occupies two columns; mark second column
                col++
                colToTextIdx[col] = sb.length // points past the wide char
            }
            col++
        }
        lastExtractedColumns = columns
        // Build reverse mapping: text index → column
        val textLen = sb.length
        if (textIdxToCol.size < textLen + 1) textIdxToCol = IntArray(textLen + 1)
        // Fill from column mapping
        var prevTextIdx = 0
        var prevCol2 = 0
        for (c2 in 0..columns) {
            val ti = if (c2 < columns) colToTextIdx[c2] else textLen
            for (t in prevTextIdx until ti) {
                textIdxToCol[t] = prevCol2
            }
            prevTextIdx = ti
            prevCol2 = c2
        }
        // Fill remaining
        for (t in prevTextIdx..textLen) {
            textIdxToCol[t] = columns
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

        while (i < text.length) {
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
                while (i < text.length && !(text[i] == stringChar && text[i - 1] != '\\')) i++
                if (i < text.length) i++ // closing quote
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
                while (i < text.length && text[i] != ' ') i++
                if (setColorRange(row, start, i, COLOR_OPTION, defaultFg)) modified = true
                continue
            }

            // Path detection (/path or ./path or ~/path)
            if ((c == '/' || (c == '.' && i + 1 < text.length && text[i + 1] == '/') ||
                 (c == '~' && i + 1 < text.length && text[i + 1] == '/')) && !inString) {
                val start = i
                while (i < text.length && text[i] != ' ') i++
                if (setColorRange(row, start, i, COLOR_PATH, defaultFg)) modified = true
                continue
            }

            // Number detection
            if (c.isDigit() && !inString && !isFirstToken) {
                val start = i
                while (i < text.length && (text[i].isDigit() || text[i] == '.')) i++
                if (i > start + 0) {
                    if (setColorRange(row, start, i, COLOR_NUMBER, defaultFg)) modified = true
                }
                continue
            }

            // First token = command name
            if (isFirstToken && c != ' ') {
                val start = i
                while (i < text.length && text[i] != ' ') i++
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
        while (i < text.length) {
            if (text[i] == '/' && (i == 0 || text[i - 1] == ' ' || text[i - 1] == ':')) {
                val start = i
                while (i < text.length && text[i] != ' ' && text[i] != ':' && text[i] != ')') i++
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
     * Set foreground color for a range of text indices (from the extracted string),
     * converting to column positions. Only modifies cells with default foreground color.
     * For wide (CJK) characters, sets style on both columns they occupy.
     */
    private fun setColorRange(row: TerminalRow, startTextIdx: Int, endTextIdx: Int, colorIdx: Int, defaultFg: Int): Boolean {
        var modified = false
        val startCol = if (startTextIdx < textIdxToCol.size) textIdxToCol[startTextIdx] else return false
        val endCol = if (endTextIdx < textIdxToCol.size) textIdxToCol[endTextIdx] else lastExtractedColumns
        for (col in startCol until endCol) {
            if (col >= lastExtractedColumns) break
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

    /**
     * Thread-safe overload for GPU rendering path (HighlightWorker).
     * Returns per-cell foreground color override array.
     * Each element is an ANSI color index (0-255), or -1 for "no override".
     *
     * Uses LOCAL arrays for column mapping to avoid data races with the
     * main-thread Canvas path.
     */
    fun highlightRowForGpu(buffer: TerminalBuffer, row: Int): IntArray {
        val cols = buffer.columns
        val result = IntArray(cols) { -1 }

        val terminalRow = try { buffer.getRow(row) } catch (_: Exception) { null }
            ?: return result

        // Thread-local column mapping (NOT the shared object fields)
        val localColToTextIdx = IntArray(cols)
        val localTextIdxToCol = IntArray(cols * 2)

        // Extract text with column mapping
        val sb = StringBuilder(cols)
        var textIdx = 0
        for (col in 0 until cols) {
            localColToTextIdx[col] = textIdx
            if (textIdx < localTextIdxToCol.size) {
                localTextIdxToCol[textIdx] = col
            }
            val cp = terminalRow.getCodePoint(col)
            if (cp == 0) {
                sb.append(' ')
            } else {
                sb.appendCodePoint(cp)
            }
            textIdx++
        }
        val text = sb.toString()

        // Check if row has any explicit ANSI colors — skip if so
        for (col in 0 until cols) {
            val style = terminalRow.getStyle(col)
            val fg = com.termux.terminal.TextStyle.decodeForeColor(style)
            if (fg != com.termux.terminal.TextStyle.COLOR_INDEX_FOREGROUND) {
                return result
            }
        }

        // Apply the same highlight patterns as the main highlighter
        // Command pattern (after $ / # / %)
        val cmdMatch = Regex("""^[\$#%>]\s+(\S+)""").find(text)
        if (cmdMatch != null) {
            val range = cmdMatch.groups[1]!!.range
            for (i in range) {
                val col = if (i < localColToTextIdx.size) localTextIdxToCol.getOrElse(i) { i } else i
                if (col in result.indices) result[col] = COLOR_COMMAND
            }
        }

        // Options pattern (--flag, -f)
        Regex("""(?:^|\s)(--?\w[\w-]*)""").findAll(text).forEach { match ->
            val range = match.groups[1]!!.range
            for (i in range) {
                val col = if (i < localTextIdxToCol.size) localTextIdxToCol.getOrElse(i) { i } else i
                if (col in result.indices) result[col] = COLOR_OPTION
            }
        }

        // Path pattern
        Regex("""(?:^|\s)([~/.][\w/.@:-]+)""").findAll(text).forEach { match ->
            val range = match.groups[1]!!.range
            for (i in range) {
                val col = if (i < localTextIdxToCol.size) localTextIdxToCol.getOrElse(i) { i } else i
                if (col in result.indices) result[col] = COLOR_PATH
            }
        }

        // Error keywords
        Regex("""(?i)\b(error|fail|fatal|denied|refused|not found|exception)\b""").findAll(text).forEach { match ->
            val range = match.range
            for (i in range) {
                val col = if (i < localTextIdxToCol.size) localTextIdxToCol.getOrElse(i) { i } else i
                if (col in result.indices) result[col] = COLOR_ERROR
            }
        }

        return result
    }
}
