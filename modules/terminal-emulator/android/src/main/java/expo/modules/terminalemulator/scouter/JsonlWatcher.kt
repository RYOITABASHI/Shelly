package expo.modules.terminalemulator.scouter

import android.util.Log
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

class JsonlWatcher(
    private val homeDir: File,
    private val onEvent: (ScouterEvent) -> Unit
) {
    private val running = AtomicBoolean(false)
    private val offsets = mutableMapOf<String, Long>()
    private var thread: Thread? = null

    fun start() {
        if (running.getAndSet(true)) return
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
                scanSource(ScouterSource.CLAUDE_CODE, File(homeDir, ".claude/projects"))
                scanSource(ScouterSource.CODEX, File(homeDir, ".codex/sessions"))
            } catch (e: Throwable) {
                Log.w(TAG, "JSONL scan failed", e)
            }
            Thread.sleep(3_000L)
        }
    }

    private fun scanSource(source: ScouterSource, root: File) {
        if (!root.exists()) return
        root.walkTopDown()
            .filter { it.isFile && it.extension.equals("jsonl", ignoreCase = true) }
            .forEach { readNewLines(source, it) }
    }

    private fun readNewLines(source: ScouterSource, file: File) {
        val key = file.absolutePath
        val previous = offsets[key] ?: 0L
        val length = file.length()
        if (length < previous) offsets[key] = 0L
        if (length == previous) return
        file.inputStream().buffered().use { input ->
            input.skip(offsets[key] ?: 0L)
            input.bufferedReader().forEachLine { line ->
                if (line.isNotBlank()) {
                    EventNormalizer.fromJsonl(source, file, line)?.let(onEvent)
                }
            }
        }
        offsets[key] = length
    }

    companion object {
        private const val TAG = "ScouterJsonlWatcher"
    }
}

