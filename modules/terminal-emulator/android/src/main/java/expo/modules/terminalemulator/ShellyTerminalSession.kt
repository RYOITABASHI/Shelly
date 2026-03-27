package expo.modules.terminalemulator

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient

class ShellyTerminalSession(
    private val sessionId: String,
    private val shell: ShellEnvironment,
    private val emitEvent: (name: String, body: Map<String, Any?>) -> Unit,
    cwd: String,
    rows: Int,
    cols: Int,
    useTmux: Boolean,
    tmuxSessionName: String?
) : TerminalSessionClient {

    companion object {
        private const val TAG = "ShellyTerminalSession"
        private const val BATCH_INTERVAL_MS = 16L
        private const val MAX_OUTPUT_BYTES = 64 * 1024 // 64KB backpressure limit
    }

    private val outputBuffer = StringBuilder()
    private val batchHandler = Handler(Looper.getMainLooper())
    @Volatile private var flushScheduled = false

    // Track last known position for incremental output capture
    private var lastTranscriptLength = 0

    val terminalSession: TerminalSession

    init {
        val shellCmd: String
        val args: Array<String>

        if (useTmux && tmuxSessionName != null) {
            shellCmd = shell.tmuxPath()
            args = arrayOf("attach-session", "-t", tmuxSessionName)
        } else {
            shellCmd = shell.shellPath
            args = arrayOf()
        }

        val envArray = shell.envVars.map { "${it.key}=${it.value}" }.toTypedArray()

        terminalSession = TerminalSession(
            shellCmd,
            cwd,
            args,
            envArray,
            null, // transcriptRows - use default
            this
        )

        // Initialize emulator with the given size (cellWidth/cellHeight as 1 since we don't render)
        terminalSession.updateSize(cols, rows, 1, 1)
    }

    private val flushRunnable = Runnable {
        flushOutputBuffer()
    }

    @Synchronized
    private fun appendToOutputBuffer(text: String) {
        // Backpressure: truncate if buffer exceeds limit
        if (outputBuffer.length + text.length > MAX_OUTPUT_BYTES) {
            val available = MAX_OUTPUT_BYTES - outputBuffer.length
            if (available > 0) {
                outputBuffer.append(text, 0, available)
            }
        } else {
            outputBuffer.append(text)
        }

        if (!flushScheduled) {
            flushScheduled = true
            batchHandler.postDelayed(flushRunnable, BATCH_INTERVAL_MS)
        }
    }

    @Synchronized
    private fun flushOutputBuffer() {
        flushScheduled = false
        if (outputBuffer.isEmpty()) return

        val data = outputBuffer.toString()
        outputBuffer.clear()

        emitEvent("onSessionOutput", mapOf(
            "sessionId" to sessionId,
            "data" to data
        ))
    }

    // --- Public API ---

    fun write(data: String) {
        val bytes = data.toByteArray(Charsets.UTF_8)
        terminalSession.write(bytes, 0, bytes.size)
    }

    fun resize(rows: Int, cols: Int) {
        terminalSession.updateSize(cols, rows, 1, 1)
    }

    fun isAlive(): Boolean {
        return terminalSession.isRunning
    }

    fun destroy() {
        batchHandler.removeCallbacks(flushRunnable)
        flushOutputBuffer()
        terminalSession.finishIfRunning()
    }

    fun getTitle(): String {
        return terminalSession.title ?: ""
    }

    fun getTranscriptText(maxLines: Int): String {
        val emulator = terminalSession.emulator ?: return ""
        val screen = emulator.screen
        val fullText = screen.transcriptText ?: return ""
        if (maxLines <= 0) return fullText

        val lines = fullText.split('\n')
        return if (lines.size > maxLines) {
            lines.takeLast(maxLines).joinToString("\n")
        } else {
            fullText
        }
    }

    // --- TerminalSessionClient implementation ---

    override fun onTextChanged(changedSession: TerminalSession) {
        val emulator = changedSession.emulator ?: return
        val screen = emulator.screen

        // Get the full transcript and extract only what's new since last call
        val fullText = screen.transcriptText ?: return
        val currentLength = fullText.length

        if (currentLength > lastTranscriptLength) {
            val newText = fullText.substring(lastTranscriptLength)
            lastTranscriptLength = currentLength
            appendToOutputBuffer(newText)
        } else if (currentLength < lastTranscriptLength) {
            // Buffer was cleared/reset, send everything
            lastTranscriptLength = currentLength
            if (fullText.isNotEmpty()) {
                appendToOutputBuffer(fullText)
            }
        }
    }

    override fun onTitleChanged(changedSession: TerminalSession) {
        emitEvent("onTitleChanged", mapOf(
            "sessionId" to sessionId,
            "title" to (changedSession.title ?: "")
        ))
    }

    override fun onSessionFinished(finishedSession: TerminalSession) {
        // Flush remaining output
        batchHandler.removeCallbacks(flushRunnable)
        flushOutputBuffer()

        emitEvent("onSessionExit", mapOf(
            "sessionId" to sessionId,
            "exitCode" to finishedSession.exitStatus
        ))
    }

    override fun onCopyTextToClipboard(session: TerminalSession, text: String) {
        // No-op: clipboard handled at higher level
    }

    override fun onPasteTextFromClipboard(session: TerminalSession?) {
        // No-op: clipboard handled at higher level
    }

    override fun onBell(session: TerminalSession) {
        emitEvent("onBell", mapOf(
            "sessionId" to sessionId
        ))
    }

    override fun onColorsChanged(session: TerminalSession) {
        // No-op for now
    }

    override fun onTerminalCursorStateChange(state: Boolean) {
        // No-op
    }

    override fun setTerminalShellPid(session: TerminalSession, pid: Int) {
        Log.d(TAG, "Shell PID for session $sessionId: $pid")
    }

    override fun getTerminalCursorStyle(): Int {
        return 0 // Block cursor
    }

    override fun logError(tag: String, message: String) {
        Log.e(tag, message)
    }

    override fun logWarn(tag: String, message: String) {
        Log.w(tag, message)
    }

    override fun logInfo(tag: String, message: String) {
        Log.i(tag, message)
    }

    override fun logDebug(tag: String, message: String) {
        Log.d(tag, message)
    }

    override fun logVerbose(tag: String, message: String) {
        Log.v(tag, message)
    }

    override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) {
        Log.e(tag, message, e)
    }

    override fun logStackTrace(tag: String, e: Exception) {
        Log.e(tag, "Exception", e)
    }
}
