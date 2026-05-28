package expo.modules.terminalemulator.scouter

import android.util.Log
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicBoolean

class JsonlWatcher(
    private val homeDir: File,
    private val onEvent: (ScouterEvent) -> Unit
) {
    private val running = AtomicBoolean(false)
    private val offsets = mutableMapOf<String, Long>()
    private val parsers = mutableMapOf<String, JsonlSessionParser>()
    private val localLlmSampler = LocalLlmSampler(homeDir)
    private var startedAt = 0L
    private var lastLocalSampleAt = 0L
    private var lastLocalSampleSignature: String? = null
    private var thread: Thread? = null

    fun start() {
        if (running.getAndSet(true)) return
        startedAt = System.currentTimeMillis()
        thread = Thread({ loop() }, "ScouterJsonlWatcher").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        running.set(false)
        thread = null
    }

    private fun loop() {
        while (running.get()) {
            try {
                scanSource(ScouterSource.CODEX, File(homeDir, ".codex/sessions"))
                maybeSampleLocalLlm()
            } catch (e: Throwable) {
                Log.w(TAG, "JSONL scan failed", e)
            }
            Thread.sleep(3_000L)
        }
    }

    private fun maybeSampleLocalLlm() {
        val now = System.currentTimeMillis()
        if (now - lastLocalSampleAt < LOCAL_LLM_SAMPLE_MS) return
        lastLocalSampleAt = now
        val event = localLlmSampler.sample()
        val signature = listOf(
            event.derivedStatus,
            event.modelName,
            event.localBackend,
            event.localEndpoint,
            event.tokensPerSecond,
            event.queueSize,
            event.lastMessage
        ).joinToString("|")
        if (signature == lastLocalSampleSignature) return
        lastLocalSampleSignature = signature
        onEvent(event)
    }

    private fun scanSource(source: ScouterSource, root: File) {
        if (!root.exists()) return
        root.walkTopDown()
            .filter { it.isFile && it.extension.equals("jsonl", ignoreCase = true) }
            .forEach { readNewLines(source, it) }
    }

    private fun readNewLines(source: ScouterSource, file: File) {
        val key = file.absolutePath
        val knownOffset = offsets[key]
        val length = file.length()
        if (knownOffset == null) {
            parsers.getOrPut(key) { JsonlSessionParser(source, file) }
            offsets[key] = if (file.lastModified() >= startedAt - NEW_FILE_GRACE_MS) 0L else length
            if (offsets[key] == length) return
        }
        val previous = offsets[key] ?: 0L
        if (length < previous) {
            offsets[key] = 0L
            parsers.remove(key)
        }
        if (length <= (offsets[key] ?: 0L)) return
        val startOffset = offsets[key] ?: 0L
        val readLimit = (startOffset + MAX_READ_BYTES).coerceAtMost(length)
        val completeEndOffset = lastCompleteLineOffset(file, startOffset, readLimit)
        if (completeEndOffset <= startOffset) return
        val parser = parsers.getOrPut(key) { JsonlSessionParser(source, file) }
        RandomAccessFile(file, "r").use { raf ->
            val byteCount = (completeEndOffset - startOffset).toInt()
            val bytes = ByteArray(byteCount)
            raf.seek(startOffset)
            raf.readFully(bytes)
            String(bytes, Charsets.UTF_8).lineSequence().forEach { rawLine ->
                val line = rawLine.removeSuffix("\r")
                if (line.isNotBlank()) {
                    parser.parse(line)?.let(onEvent)
                }
            }
        }
        offsets[key] = completeEndOffset
    }

    private fun lastCompleteLineOffset(file: File, startOffset: Long, length: Long): Long {
        if (length <= startOffset) return startOffset
        RandomAccessFile(file, "r").use { raf ->
            raf.seek(length - 1)
            return if (raf.read() == '\n'.code) {
                length
            } else {
                var pos = length - 1
                while (pos >= startOffset) {
                    raf.seek(pos)
                    if (raf.read() == '\n'.code) return pos + 1
                    pos--
                }
                startOffset
            }
        }
    }

    companion object {
        private const val TAG = "ScouterJsonlWatcher"
        private const val NEW_FILE_GRACE_MS = 5_000L
        private const val MAX_READ_BYTES = 1024L * 1024L
        private const val LOCAL_LLM_SAMPLE_MS = 15_000L
    }
}
