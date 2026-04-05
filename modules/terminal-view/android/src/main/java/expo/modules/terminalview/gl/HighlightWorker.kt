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
                val highlights = SyntaxHighlighter.highlightRowForGpu(buffer, row)
                cache.put(row, highlights)
            }
        }
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
