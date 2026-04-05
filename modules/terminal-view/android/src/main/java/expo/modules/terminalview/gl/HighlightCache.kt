package expo.modules.terminalview.gl

import java.util.concurrent.ConcurrentHashMap

/**
 * Thread-safe cache for SyntaxHighlighter results.
 * GL thread reads, worker thread writes.
 * Read of stale data = one frame without highlight (acceptable).
 */
class HighlightCache {
    private val cache = ConcurrentHashMap<Int, IntArray>()

    fun getHighlights(row: Int): IntArray? = cache[row]

    fun put(row: Int, highlights: IntArray) {
        cache[row] = highlights
    }

    fun invalidateRow(row: Int) {
        cache.remove(row)
    }

    fun invalidateAll() {
        cache.clear()
    }
}
