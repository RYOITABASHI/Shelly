package expo.modules.terminalview

import android.os.Handler
import android.os.Looper

/**
 * Detects Warp-style command blocks using OSC 133 (FinalTerm) semantic prompt sequences.
 *
 * OSC 133 sequences:
 *   \033]133;A\007  — Prompt start
 *   \033]133;B\007  — Command start (user pressed Enter)
 *   \033]133;C\007  — Output start
 *   \033]133;D;N\007 — Command finished with exit code N
 *
 * For shells that don't emit OSC 133, falls back to timeout-based grouping:
 * after 2 seconds of idle output, the current block is considered complete.
 */
class BlockDetector(
    private val onBlockCompleted: (block: CommandBlock) -> Unit,
    private val idleTimeoutMs: Long = 2000L
) {
    var onBlockStarted: ((command: String) -> Unit)? = null
    data class CommandBlock(
        val command: String,
        val output: String,
        val exitCode: Int?,
        val startTimeMs: Long,
        val endTimeMs: Long
    )

    private enum class State {
        IDLE,
        PROMPT,
        COMMAND,
        OUTPUT
    }

    private var state = State.IDLE
    private var currentCommand = StringBuilder()
    private var currentOutput = StringBuilder()
    private var blockStartTime = 0L
    private var lastOutputTime = 0L

    private val handler = Handler(Looper.getMainLooper())
    private val idleRunnable = Runnable { onIdleTimeout() }

    // OSC 133 escape sequences (both BEL and ST terminators)
    companion object {
        private const val OSC_133_A_BEL = "\u001b]133;A\u0007"
        private const val OSC_133_B_BEL = "\u001b]133;B\u0007"
        private const val OSC_133_C_BEL = "\u001b]133;C\u0007"
        private const val OSC_133_D_PREFIX_BEL = "\u001b]133;D"
        private const val OSC_133_A_ST = "\u001b]133;A\u001b\\"
        private const val OSC_133_B_ST = "\u001b]133;B\u001b\\"
        private const val OSC_133_C_ST = "\u001b]133;C\u001b\\"
        private const val OSC_133_D_PREFIX_ST = "\u001b]133;D"

        private val OSC_133_D_PATTERN = Regex("""\x1b]133;D;?(\d*)\x07|\x1b]133;D;?(\d*)\x1b\\""")
    }

    /**
     * Process incoming terminal output text.
     * Call this whenever new text is written to the terminal.
     */
    fun processOutput(text: String) {
        // Check for OSC 133 sequences
        if (processOsc133(text)) {
            return
        }

        // Fallback: timeout-based grouping
        when (state) {
            State.IDLE, State.PROMPT -> {
                // No active block; accumulate as potential command
                if (text.isNotBlank()) {
                    if (state == State.IDLE) {
                        state = State.COMMAND
                        blockStartTime = System.currentTimeMillis()
                    }
                    currentCommand.append(text)
                }
            }
            State.COMMAND, State.OUTPUT -> {
                state = State.OUTPUT
                currentOutput.append(text)
                lastOutputTime = System.currentTimeMillis()
                resetIdleTimer()
            }
        }
    }

    /**
     * Process text for OSC 133 sequences.
     * Returns true if any OSC 133 sequence was found and processed.
     */
    private fun processOsc133(text: String): Boolean {
        var found = false

        if (text.contains(OSC_133_A_BEL) || text.contains(OSC_133_A_ST)) {
            // Prompt start — if we have a pending block, complete it
            if (state == State.OUTPUT || state == State.COMMAND) {
                completeBlock(null)
            }
            state = State.PROMPT
            blockStartTime = System.currentTimeMillis()
            found = true
        }

        if (text.contains(OSC_133_B_BEL) || text.contains(OSC_133_B_ST)) {
            // Command start — extract command text from prompt to here
            state = State.COMMAND
            // The command text is between prompt start and command start
            val cleaned = text
                .replace(OSC_133_A_BEL, "")
                .replace(OSC_133_A_ST, "")
                .replace(OSC_133_B_BEL, "")
                .replace(OSC_133_B_ST, "")
                .trim()
            if (cleaned.isNotEmpty()) {
                currentCommand.append(cleaned)
            }
            // Fire onBlockStarted for GL renderer
            onBlockStarted?.invoke(currentCommand.toString().trim())
            found = true
        }

        if (text.contains(OSC_133_C_BEL) || text.contains(OSC_133_C_ST)) {
            // Output start
            state = State.OUTPUT
            found = true
        }

        val dMatch = OSC_133_D_PATTERN.find(text)
        if (dMatch != null) {
            // Command done with exit code
            val exitCodeStr = dMatch.groupValues[1].ifEmpty { dMatch.groupValues[2] }
            val exitCode = exitCodeStr.toIntOrNull()
            completeBlock(exitCode)
            found = true
        }

        return found
    }

    private fun completeBlock(exitCode: Int?) {
        cancelIdleTimer()
        val block = CommandBlock(
            command = currentCommand.toString().trim(),
            output = currentOutput.toString(),
            exitCode = exitCode,
            startTimeMs = blockStartTime,
            endTimeMs = System.currentTimeMillis()
        )
        if (block.command.isNotEmpty() || block.output.isNotEmpty()) {
            onBlockCompleted(block)
        }
        reset()
    }

    private fun onIdleTimeout() {
        if (state == State.OUTPUT || state == State.COMMAND) {
            completeBlock(null)
        }
    }

    private fun resetIdleTimer() {
        handler.removeCallbacks(idleRunnable)
        handler.postDelayed(idleRunnable, idleTimeoutMs)
    }

    private fun cancelIdleTimer() {
        handler.removeCallbacks(idleRunnable)
    }

    private fun reset() {
        state = State.IDLE
        currentCommand.clear()
        currentOutput.clear()
        blockStartTime = 0L
        lastOutputTime = 0L
    }

    /**
     * Force-complete any pending block (e.g., when session ends).
     */
    fun flush() {
        if (state != State.IDLE) {
            completeBlock(null)
        }
    }

    fun destroy() {
        cancelIdleTimer()
        reset()
    }
}
