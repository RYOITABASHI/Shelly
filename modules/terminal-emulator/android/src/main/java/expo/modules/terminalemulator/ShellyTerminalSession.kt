package expo.modules.terminalemulator

import android.os.Handler
import android.os.Looper
import android.util.Log
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream

class ShellyTerminalSession(
    val sessionId: String,
    /**
     * JS-side event sink. Re-assignable so that if [TerminalEmulatorModule]
     * is re-instantiated (RN reload, dev-client refresh) while this session is
     * still alive in the Service registry, the new Module can rewire its
     * sendEvent bridge without destroying the underlying PTY child.
     */
    @Volatile var emitEvent: (name: String, body: Map<String, Any?>) -> Unit,
    private val masterFd: Int,
    private val childPid: Int,
    rows: Int,
    cols: Int,
    private val appContext: android.content.Context
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

    val terminalSession: TerminalSession

    init {
        // Create FileDescriptor from raw fd
        val fdField = FileDescriptor::class.java.getDeclaredField("descriptor")
        fdField.isAccessible = true
        val fd = FileDescriptor()
        fdField.setInt(fd, masterFd)

        val inputStream = FileInputStream(fd)
        val outputStream = FileOutputStream(fd)

        // Create TerminalSession with dummy args — we use initializeWithStreams
        terminalSession = TerminalSession(
            "/bin/true", "/", arrayOf(), arrayOf(), null, this
        )
        terminalSession.initializeWithStreams(inputStream, outputStream, cols, rows, 1, 1)

        // Wait for child exit on background thread
        Thread({
            val exitCode = ShellyJNI.waitFor(childPid)
            batchHandler.post {
                batchHandler.removeCallbacks(flushRunnable)
                flushOutputBuffer()
                emitEvent("onSessionExit", mapOf("sessionId" to sessionId, "exitCode" to exitCode))
            }
        }, "WaitFor-$sessionId").apply {
            isDaemon = true
            start()
        }

        Log.i(TAG, "Session $sessionId created (masterFd=$masterFd, childPid=$childPid)")
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
        // NOTE: don't call onScreenUpdateCallback here. onTextChanged() invokes
        // it synchronously on every emulator append. Calling it again from the
        // 16 ms-delayed batch flush gave us two redraws per packet — the second
        // one snapshotting whatever the screen looked like 16 ms ago. That was
        // visible as Enter "needing" a second press: the first press's prompt
        // arrived after the cursor advance was already drawn, and then the
        // delayed flush re-drew the older state and clobbered it.
    }

    fun write(data: String) {
        val bytes = data.toByteArray(Charsets.UTF_8)
        terminalSession.write(bytes, 0, bytes.size)
    }

    fun interrupt(): Int {
        return try {
            ShellyJNI.interruptPty(masterFd, childPid)
        } catch (e: Exception) {
            Log.w(TAG, "Native interrupt failed for $sessionId, falling back to PTY Ctrl-C", e)
            write("\u0003")
            0
        }
    }

    fun resize(rows: Int, cols: Int) {
        ShellyJNI.setPtyWindowSize(masterFd, rows, cols)
        terminalSession.updateSize(cols, rows, 1, 1)
    }

    fun isAlive(): Boolean {
        return try {
            // Check if /proc/<pid> exists — works for child processes
            java.io.File("/proc/$childPid").exists()
        } catch (_: Exception) {
            false
        }
    }

    fun hasEmulator(): Boolean = terminalSession.emulator != null

    fun getTitle(): String = terminalSession.title ?: ""

    fun writeToEmulator(text: String) {
        val emulator = terminalSession.emulator ?: return
        val bytes = text.toByteArray(Charsets.UTF_8)
        emulator.append(bytes, bytes.size)
    }

    /**
     * Paste text as if it came from the clipboard. Unlike [write] this runs
     * through [TerminalEmulator.paste] which normalizes `\r\n` / `\n` to `\r`
     * and wraps the payload in bracketed-paste markers when DECSET 2004 is
     * on, so shells and line editors treat the whole chunk as a single
     * paste event instead of interleaving it with their own echo. bug #81 —
     * action bar Paste used to call [write] directly and the first byte of
     * the payload would get clipped because bash's echo raced the raw PTY
     * write.
     */
    fun paste(text: String) {
        val emulator = terminalSession.emulator
        if (emulator != null) {
            emulator.paste(text)
        } else {
            // Emulator not attached yet (session just created) — fall back
            // to the raw writer with minimal CRLF normalization so the
            // paste still lands somewhere useful.
            write(text.replace("\r\n", "\r").replace("\n", "\r"))
        }
    }

    fun getTranscriptText(maxLines: Int): String {
        val emulator = terminalSession.emulator ?: return ""
        val screen = emulator.screen
        val fullText = screen.transcriptText ?: return ""
        if (maxLines <= 0) return fullText
        val lines = fullText.split('\n')
        return if (lines.size > maxLines) lines.takeLast(maxLines).joinToString("\n") else fullText
    }

    fun destroy() {
        batchHandler.removeCallbacks(flushRunnable)
        flushOutputBuffer()
        terminalSession.finishIfRunning()
        try { ShellyJNI.close(masterFd) } catch (_: Exception) {}
        try { android.os.Process.killProcess(childPid) } catch (_: Exception) {}
    }

    // --- TerminalSessionClient implementation ---

    var onScreenUpdateCallback: (() -> Unit)? = null

    /**
     * Delta-text callback. Invoked with every newly-appended chunk of
     * transcript text (post-emulator-processing). Used by ShellyTerminalView
     * to feed BlockDetector so Command Block chrome / JS onBlockCompleted
     * events fire under the Plan B architecture (#60, #59).
     */
    var onOutputDelta: ((String) -> Unit)? = null

    override fun onTextChanged(changedSession: TerminalSession) {
        // Always tell the view to redraw FIRST so the visible state matches
        // what the emulator already processed. The transcript-diff below is
        // only used to feed JS-side onSessionOutput events; it must not gate
        // or delay the redraw, because transcript bytes lag the live screen
        // (the row the cursor is currently editing isn't in transcriptText
        // yet, so prompt redraws often produce no length delta).
        onScreenUpdateCallback?.invoke()

        val emulator = changedSession.emulator ?: return
        val screen = emulator.screen
        val fullText = screen.transcriptText ?: return
        val currentLength = fullText.length
        if (currentLength > lastTranscriptLength) {
            val newText = fullText.substring(lastTranscriptLength)
            lastTranscriptLength = currentLength
            appendToOutputBuffer(newText)
            onOutputDelta?.invoke(newText)
        } else if (currentLength < lastTranscriptLength) {
            lastTranscriptLength = currentLength
            if (fullText.isNotEmpty()) {
                appendToOutputBuffer(fullText)
                onOutputDelta?.invoke(fullText)
            }
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
    override fun setTerminalShellPid(session: TerminalSession, pid: Int) {}
    override fun getTerminalCursorStyle(): Int = 0
    override fun logError(tag: String, message: String) { Log.e(tag, message) }
    override fun logWarn(tag: String, message: String) { Log.w(tag, message) }
    override fun logInfo(tag: String, message: String) { Log.i(tag, message) }
    override fun logDebug(tag: String, message: String) { Log.d(tag, message) }
    override fun logVerbose(tag: String, message: String) { Log.v(tag, message) }
    override fun logStackTraceWithMessage(tag: String, message: String, e: Exception) { Log.e(tag, message, e) }
    override fun logStackTrace(tag: String, e: Exception) { Log.e(tag, "Exception", e) }
}
