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
    cols: Int,
    private val appContext: android.content.Context
) : TerminalSessionClient {

    companion object {
        private const val TAG = "ShellyTerminalSession"
        private const val BATCH_INTERVAL_MS = 16L
        private const val MAX_OUTPUT_BYTES = 64 * 1024
        private const val RESIZE_PREFIX = "\u001bPTYR"
        private const val HEARTBEAT_PREFIX = "\u001bPTYH"
        private const val HEARTBEAT_CMD = "\u001bPTYH\n"
        private const val HEARTBEAT_INTERVAL_MS = 15_000L
        private const val HEARTBEAT_TIMEOUT_MS = 45_000L
    }

    private val outputBuffer = StringBuilder()
    private val batchHandler = Handler(Looper.getMainLooper())
    @Volatile private var flushScheduled = false
    private var lastTranscriptLength = 0

    // Reconnection state
    @Volatile private var isReconnecting = false
    @Volatile private var shouldReconnect = true
    private var reconnectThread: Thread? = null
    private val socketLock = Any()

    private var heartbeatThread: Thread? = null
    @Volatile private var lastDataReceived = System.currentTimeMillis()

    private var socket: Socket? = null
    val terminalSession: TerminalSession

    init {
        // Create TerminalSession with dummy args — we use initializeWithStreams, not fork/exec
        terminalSession = TerminalSession(
            "/bin/true", "/", arrayOf(), arrayOf(), null, this
        )

        // Connect to pty-helper via TCP (localhost only).
        // TCP is used because Shelly and Termux run under different Android UIDs,
        // and Unix Domain Sockets enforce file permissions + SELinux which block cross-UID access.
        val sock = Socket("127.0.0.1", port)
        sock.tcpNoDelay = true
        sock.keepAlive = true
        sock.soTimeout = 0  // No read timeout — rely on TCP keepalive from pty-helper
        socket = sock

        // Initialize emulator with socket streams
        val inputStream = sock.getInputStream()
        val outputStream = sock.getOutputStream()
        terminalSession.initializeWithStreams(inputStream, outputStream, cols, rows, 1, 1)
        startHeartbeat()

        Log.i(TAG, "Session $sessionId connected to pty-helper on port $port")
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
        // Notify TerminalView to redraw (batched, not per-character)
        onScreenUpdateCallback?.invoke()
    }

    fun write(data: String) {
        val bytes = data.toByteArray(Charsets.UTF_8)
        terminalSession.write(bytes, 0, bytes.size)
    }

    fun resize(rows: Int, cols: Int) {
        terminalSession.updateSize(cols, rows, 1, 1)
    }

    /**
     * Send resize command to pty-helper via the inline escape protocol.
     * pty-helper intercepts this and calls ioctl(TIOCSWINSZ) on the PTY fd.
     * The command never reaches the shell.
     */
    fun sendResizeCommand(cols: Int, rows: Int) {
        try {
            val cmd = "${RESIZE_PREFIX}${cols};${rows}\n"
            synchronized(socketLock) {
                socket?.getOutputStream()?.write(cmd.toByteArray(Charsets.UTF_8))
                socket?.getOutputStream()?.flush()
            }
            Log.i(TAG, "sendResizeCommand: ${cols}x${rows}")
        } catch (e: Exception) {
            Log.w(TAG, "sendResizeCommand failed: ${e.message}")
        }
    }

    /**
     * Reconnect to pty-helper — replaces only the TCP socket and I/O threads.
     * The TerminalEmulator (scroll buffer) is preserved via replaceStreams().
     */
    private fun reconnectSocket(): Boolean {
        synchronized(socketLock) {
            try {
                // Close old socket
                try { socket?.close() } catch (_: Exception) {}
                socket = null

                val sock = Socket("127.0.0.1", port)
                sock.tcpNoDelay = true
                sock.keepAlive = true
                socket = sock

                val inputStream = sock.getInputStream()
                val outputStream = sock.getOutputStream()

                // Use replaceStreams — preserves TerminalEmulator buffer
                terminalSession.replaceStreams(inputStream, outputStream)

                Log.i(TAG, "Session $sessionId reconnected to pty-helper on port $port")
                lastDataReceived = System.currentTimeMillis()
                startHeartbeat()
                return true
            } catch (e: Exception) {
                Log.w(TAG, "Session $sessionId reconnect failed: ${e.message}")
                try { socket?.close() } catch (_: Exception) {}
                socket = null
                return false
            }
        }
    }

    private fun startReconnectLoop() {
        if (isReconnecting) return
        stopHeartbeat()
        isReconnecting = true

        val thread = object : Thread("ReconnectLoop-$sessionId") {
            override fun run() {
                var attempts = 0
                val maxAttempts = 30
                val intervalMs = 1000L

                while (shouldReconnect && attempts < maxAttempts && isReconnecting) {
                    attempts++
                    try {
                        sleep(intervalMs)
                    } catch (_: InterruptedException) {
                        break
                    }

                    Log.d(TAG, "Session $sessionId: reconnect attempt $attempts/$maxAttempts")

                    if (reconnectSocket()) {
                        isReconnecting = false

                        // Send Ctrl+L to refresh shell prompt on the main thread
                        batchHandler.post {
                            try {
                                write("\u000c") // Ctrl+L
                            } catch (_: Exception) {}
                            onScreenUpdateCallback?.invoke()
                        }
                        return
                    }
                }

                // All attempts exhausted — emit exit
                isReconnecting = false
                Log.w(TAG, "Session $sessionId: reconnect failed after $maxAttempts attempts")
                batchHandler.post {
                    emitEvent("onSessionExit", mapOf("sessionId" to sessionId, "exitCode" to -1))
                }
            }
        }
        thread.isDaemon = true
        thread.start()
        reconnectThread = thread
    }

    fun isAlive(): Boolean {
        // If reconnecting with a preserved emulator, report alive
        if (isReconnecting && hasEmulator()) return true

        val sock = synchronized(socketLock) { socket } ?: return false
        if (sock.isClosed) return false
        return try {
            sock.sendUrgentData(0xFF)
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Check if the TerminalEmulator instance exists (buffer is preserved in memory). */
    fun hasEmulator(): Boolean {
        return terminalSession.emulator != null
    }

    fun destroy() {
        stopHeartbeat()
        shouldReconnect = false
        isReconnecting = false
        reconnectThread?.interrupt()
        reconnectThread = null
        batchHandler.removeCallbacks(flushRunnable)
        flushOutputBuffer()
        terminalSession.finishIfRunning()
        synchronized(socketLock) {
            try { socket?.close() } catch (_: Exception) {}
            socket = null
        }
    }

    private fun startHeartbeat() {
        stopHeartbeat()
        heartbeatThread = Thread("Heartbeat-$sessionId") {
            while (shouldReconnect && !Thread.currentThread().isInterrupted) {
                try {
                    Thread.sleep(HEARTBEAT_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    break
                }
                // Send heartbeat
                synchronized(socketLock) {
                    try {
                        socket?.getOutputStream()?.write(HEARTBEAT_CMD.toByteArray(Charsets.UTF_8))
                        socket?.getOutputStream()?.flush()
                    } catch (e: Exception) {
                        Log.w(TAG, "Heartbeat send failed: ${e.message}")
                        try { socket?.close() } catch (_: Exception) {}
                        break
                    }
                }
                // Check for response timeout
                if (System.currentTimeMillis() - lastDataReceived > HEARTBEAT_TIMEOUT_MS) {
                    Log.w(TAG, "Heartbeat timeout (${HEARTBEAT_TIMEOUT_MS}ms), triggering reconnect")
                    synchronized(socketLock) {
                        try { socket?.close() } catch (_: Exception) {}
                    }
                    break
                }
            }
        }.also {
            it.isDaemon = true
            it.start()
        }
    }

    private fun stopHeartbeat() {
        heartbeatThread?.interrupt()
        heartbeatThread = null
    }

    fun getTitle(): String = terminalSession.title ?: ""

    /**
     * Write text directly to the terminal emulator's screen (not to pty-helper).
     * Used to restore previous screen content on reconnection.
     */
    fun writeToEmulator(text: String) {
        val emulator = terminalSession.emulator ?: return
        val bytes = text.toByteArray(Charsets.UTF_8)
        emulator.append(bytes, bytes.size)
    }

    fun getTranscriptText(maxLines: Int): String {
        val emulator = terminalSession.emulator ?: return ""
        val screen = emulator.screen
        val fullText = screen.transcriptText ?: return ""
        if (maxLines <= 0) return fullText
        val lines = fullText.split('\n')
        return if (lines.size > maxLines) lines.takeLast(maxLines).joinToString("\n") else fullText
    }

    // --- TerminalSessionClient implementation ---

    /** Callback to notify TerminalView to redraw. Set by ShellyTerminalView.attachShellySession(). */
    var onScreenUpdateCallback: (() -> Unit)? = null

    override fun onTextChanged(changedSession: TerminalSession) {
        lastDataReceived = System.currentTimeMillis()
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
        // Immediately trigger native view redraw so output appears without delay.
        // The JS event emission remains batched in flushOutputBuffer() for efficiency.
        onScreenUpdateCallback?.invoke()
    }

    override fun onTitleChanged(changedSession: TerminalSession) {
        emitEvent("onTitleChanged", mapOf("sessionId" to sessionId, "title" to (changedSession.title ?: "")))
    }

    override fun onSessionFinished(finishedSession: TerminalSession) {
        if (shouldReconnect && !isReconnecting) {
            Log.i(TAG, "Session $sessionId: socket lost, starting reconnect loop")
            startReconnectLoop()
            return
        }
        // Only emit exit event if we're not trying to reconnect
        batchHandler.removeCallbacks(flushRunnable)
        flushOutputBuffer()
        emitEvent("onSessionExit", mapOf("sessionId" to sessionId, "exitCode" to finishedSession.exitStatus))
    }

    override fun onCopyTextToClipboard(session: TerminalSession, text: String) {
        val clipboard = android.content.ClipboardManager::class.java.cast(
            appContext.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
        ) ?: return
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("Terminal", text))
    }

    override fun onPasteTextFromClipboard(session: TerminalSession?) {
        val clipboard = android.content.ClipboardManager::class.java.cast(
            appContext.getSystemService(android.content.Context.CLIPBOARD_SERVICE)
        ) ?: return
        val clip = clipboard.primaryClip ?: return
        if (clip.itemCount > 0) {
            val text = clip.getItemAt(0).coerceToText(appContext)
            if (text.isNotEmpty()) {
                terminalSession.emulator?.paste(text.toString())
            }
        }
    }
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
