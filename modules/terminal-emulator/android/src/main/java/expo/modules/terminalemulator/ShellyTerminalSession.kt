package expo.modules.terminalemulator

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import java.net.Socket

class ShellyTerminalSession(
    private val sessionId: String,
    private val emitEvent: (name: String, body: Map<String, Any?>) -> Unit,
    private val port: Int,
    rows: Int,
    cols: Int
) : TerminalSessionClient {

    companion object {
        private const val TAG = "ShellyTerminalSession"
        private const val BATCH_INTERVAL_MS = 16L
        private const val MAX_OUTPUT_BYTES = 64 * 1024
    }

    private val outputBuffer = StringBuilder()
    private val batchHandler = Handler(Looper.getMainLooper())
    @Volatile private var flushScheduled = false
    private var lastTranscriptLength = 0

    private var socket: Socket? = null
    val terminalSession: TerminalSession

    init {
        // Create TerminalSession with dummy args — we use initializeWithFd, not fork/exec
        terminalSession = TerminalSession(
            "/bin/true", "/", arrayOf(), arrayOf(), null, this
        )

        // Connect TCP socket to socat bridge running in Termux
        val sock = Socket("127.0.0.1", port)
        sock.tcpNoDelay = true
        socket = sock

        // Initialize emulator with socket streams (no reflection, no fd extraction)
        val inputStream = sock.getInputStream()
        val outputStream = sock.getOutputStream()
        terminalSession.initializeWithStreams(inputStream, outputStream, cols, rows, 1, 1)

        Log.i(TAG, "Session $sessionId connected to socat on port $port")
    }

    private val flushRunnable = Runnable { flushOutputBuffer() }

    @Synchronized
    private fun appendToOutputBuffer(text: String) {
        if (outputBuffer.length + text.length > MAX_OUTPUT_BYTES) {
            val available = MAX_OUTPUT_BYTES - outputBuffer.length
            if (available > 0) outputBuffer.append(text, 0, available)
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
        emitEvent("onSessionOutput", mapOf("sessionId" to sessionId, "data" to data))
    }

    fun write(data: String) {
        val bytes = data.toByteArray(Charsets.UTF_8)
        terminalSession.write(bytes, 0, bytes.size)
    }

    fun resize(rows: Int, cols: Int) {
        terminalSession.updateSize(cols, rows, 1, 1)
    }

    fun isAlive(): Boolean {
        val sock = socket ?: return false
        if (sock.isClosed) return false
        // Socket.isConnected stays true even after remote closes.
        // Actually test by attempting a zero-byte write via sendUrgentData.
        return try {
            sock.sendUrgentData(0xFF)
            true
        } catch (e: Exception) {
            false
        }
    }

    fun destroy() {
        batchHandler.removeCallbacks(flushRunnable)
        flushOutputBuffer()
        terminalSession.finishIfRunning()
        try { socket?.close() } catch (_: Exception) {}
        socket = null
    }

    fun getTitle(): String = terminalSession.title ?: ""

    fun getTranscriptText(maxLines: Int): String {
        val emulator = terminalSession.emulator ?: return ""
        val screen = emulator.screen
        val fullText = screen.transcriptText ?: return ""
        if (maxLines <= 0) return fullText
        val lines = fullText.split('\n')
        return if (lines.size > maxLines) lines.takeLast(maxLines).joinToString("\n") else fullText
    }

    // --- TerminalSessionClient implementation ---

    override fun onTextChanged(changedSession: TerminalSession) {
        val emulator = changedSession.emulator ?: return
        val screen = emulator.screen
        val fullText = screen.transcriptText ?: return
        val currentLength = fullText.length
        if (currentLength > lastTranscriptLength) {
            val newText = fullText.substring(lastTranscriptLength)
            lastTranscriptLength = currentLength
            appendToOutputBuffer(newText)
        } else if (currentLength < lastTranscriptLength) {
            lastTranscriptLength = currentLength
            if (fullText.isNotEmpty()) appendToOutputBuffer(fullText)
        }
    }

    override fun onTitleChanged(changedSession: TerminalSession) {
        emitEvent("onTitleChanged", mapOf("sessionId" to sessionId, "title" to (changedSession.title ?: "")))
    }

    override fun onSessionFinished(finishedSession: TerminalSession) {
        batchHandler.removeCallbacks(flushRunnable)
        flushOutputBuffer()
        emitEvent("onSessionExit", mapOf("sessionId" to sessionId, "exitCode" to finishedSession.exitStatus))
    }

    override fun onCopyTextToClipboard(session: TerminalSession, text: String) {}
    override fun onPasteTextFromClipboard(session: TerminalSession?) {}
    override fun onBell(session: TerminalSession) {
        emitEvent("onBell", mapOf("sessionId" to sessionId))
    }
    override fun onColorsChanged(session: TerminalSession) {}
    override fun onTerminalCursorStateChange(state: Boolean) {}
    override fun setTerminalShellPid(session: TerminalSession, pid: Int) {
        Log.d(TAG, "Session $sessionId fd-based (no local PID)")
    }
    override fun getTerminalCursorStyle(): Int = 0
    override fun logError(tag: String, message: String) { Log.e(tag, message) }
    override fun logWarn(tag: String, message: String) { Log.w(tag, message) }
    override fun logInfo(tag: String, message: String) { Log.i(tag, message) }
    override fun logDebug(tag: String, message: String) { Log.d(tag, message) }
    override fun logVerbose(tag: String, message: String) { Log.v(tag, message) }
    override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) { Log.e(tag, message, e) }
    override fun logStackTrace(tag: String, e: Exception) { Log.e(tag, "Exception", e) }
}
