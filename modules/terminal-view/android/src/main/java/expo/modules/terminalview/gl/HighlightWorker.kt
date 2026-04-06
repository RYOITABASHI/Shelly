package expo.modules.terminalview.gl

import com.termux.terminal.TerminalBuffer
import expo.modules.terminalview.SyntaxHighlighter
import java.util.concurrent.Executors

/**
 * Runs SyntaxHighlighter on a background thread.
 * Triggered by onScreenUpdated(), writes results to HighlightCache.
 */
class HighlightWorker(private val cache: HighlightCache) {
    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "shelly-highlight").apply { isDaemon = true }
    }

    fun highlightRows(buffer: TerminalBuffer, startRow: Int, endRow: Int) {
        executor.submit {
            for (row in startRow..endRow) {
                try {
                    val termRow = buffer.getRow(row) ?: continue
                    val highlights = SyntaxHighlighter.highlightRowForGpu(termRow, buffer.getColumns())
                    cache.put(row, highlights)
                } catch (_: Exception) {}
            }
        }
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
