package expo.modules.terminalemulator.scouter

import android.util.Log
import org.json.JSONObject
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
    private var localLlmSampler: LocalLlmSampler? = null
    private var startedAt = 0L
    private var lastLocalSampleAt = 0L
    private var lastLocalSampleSignature: String? = null
    private val scanLock = Any()
    @Volatile private var lastScanError: String? = null
    @Volatile private var lastScanAt = 0L
    @Volatile private var lastBackfillFile: String? = null
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

    fun debugJson(): JSONObject = JSONObject().apply {
        put("running", running.get())
        put("codexSessionsRoot", File(homeDir, ".codex/sessions").absolutePath.redactForScouter())
        put("trackedFileCount", offsets.size)
        put("lastScanAt", lastScanAt)
        put("lastScanError", lastScanError)
        put("lastBackfillFile", lastBackfillFile)
    }

    fun scanNow() {
        scanSafely()
    }

    private fun loop() {
        while (running.get()) {
            scanSafely()
            Thread.sleep(3_000L)
        }
    }

    private fun scanSafely() {
        try {
            synchronized(scanLock) {
                scanSource(ScouterSource.CODEX, File(homeDir, ".codex/sessions"))
                maybeSampleLocalLlm()
                lastScanError = null
            }
        } catch (e: Throwable) {
            lastScanError = e.javaClass.simpleName + ": " + (e.message ?: "")
            Log.w(TAG, "JSONL scan failed", e)
        }
    }

    private fun maybeSampleLocalLlm() {
        val now = System.currentTimeMillis()
        if (now - lastLocalSampleAt < LOCAL_LLM_SAMPLE_MS) return
        lastLocalSampleAt = now
        val event = runCatching {
            val sampler = localLlmSampler ?: LocalLlmSampler(homeDir).also { localLlmSampler = it }
            sampler.sample()
        }.getOrElse { error ->
            Log.w(TAG, "Local LLM sample failed", error)
            return
        }
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
        val files = root.walkTopDown()
            .filter { it.isFile && it.extension.equals("jsonl", ignoreCase = true) }
            .sortedByDescending { it.lastModified() }
            .toList()
        val backfillFiles = if (source == ScouterSource.CODEX) {
            files.take(CODEX_BACKFILL_FILE_COUNT).mapTo(mutableSetOf()) { it.absolutePath }
        } else {
            emptySet()
        }
        files.forEach { readNewLines(source, it, allowInitialBackfill = it.absolutePath in backfillFiles) }
        lastScanAt = System.currentTimeMillis()
    }

    private fun readNewLines(source: ScouterSource, file: File, allowInitialBackfill: Boolean) {
        val key = file.absolutePath
        val knownOffset = offsets[key]
        val length = file.length()
        if (knownOffset == null) {
            val parser = parsers.getOrPut(key) { JsonlSessionParser(source, file) }
            val startOffset = initialOffset(file, length, allowInitialBackfill)
            if (source == ScouterSource.CODEX && startOffset > 0L && startOffset < length) {
                primeCodexMetadata(parser, file)
            }
            offsets[key] = startOffset
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

    private fun primeCodexMetadata(parser: JsonlSessionParser, file: File) {
        val length = file.length()
        val completeEndOffset = lastCompleteLineOffset(file, 0L, CODEX_HEADER_PRIME_BYTES.coerceAtMost(length))
        if (completeEndOffset <= 0L) return
        RandomAccessFile(file, "r").use { raf ->
            val bytes = ByteArray(completeEndOffset.toInt())
            raf.seek(0L)
            raf.readFully(bytes)
            String(bytes, Charsets.UTF_8).lineSequence()
                .take(CODEX_HEADER_PRIME_MAX_LINES)
                .forEach { line ->
                    if (line.isNotBlank()) parser.primeCodexMetadata(line.removeSuffix("\r"))
                }
        }
    }

    private fun initialOffset(file: File, length: Long, allowInitialBackfill: Boolean): Long {
        if (file.lastModified() >= startedAt - NEW_FILE_GRACE_MS) return 0L
        if (!allowInitialBackfill || length <= 0L) return length
        val offset = backfillOffset(file, length)
        lastBackfillFile = file.absolutePath.redactForScouter()
        return offset
    }

    private fun backfillOffset(file: File, length: Long): Long {
        if (length <= CODEX_BACKFILL_BYTES) return 0L
        val start = (length - CODEX_BACKFILL_BYTES).coerceAtLeast(0L)
        RandomAccessFile(file, "r").use { raf ->
            raf.seek(start)
            while (raf.filePointer < length) {
                if (raf.read() == '\n'.code) return raf.filePointer
            }
        }
        return length
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
        private const val CODEX_BACKFILL_BYTES = 256L * 1024L
        private const val CODEX_BACKFILL_FILE_COUNT = 3
        private const val CODEX_HEADER_PRIME_BYTES = 1024L * 1024L
        private const val CODEX_HEADER_PRIME_MAX_LINES = 80
        private const val LOCAL_LLM_SAMPLE_MS = 15_000L
    }
}
