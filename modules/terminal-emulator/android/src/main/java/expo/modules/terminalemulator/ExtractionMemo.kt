package expo.modules.terminalemulator

/**
 * Identity of the installed APK as seen by this process. Built from a single
 * stat of `applicationInfo.sourceDir` (no ZipFile open, no binder call), so it
 * is cheap enough to compute on every execCommand(). An APK update always
 * yields a new sourceDir path (and new mtime/size), so a key recorded for the
 * old APK can never match the new one.
 */
data class ExtractionMemoKey(
    val apkPath: String,
    val apkLastModified: Long,
    val apkLength: Long,
)

/**
 * In-process memo for LibExtractor.extractAll().
 *
 * extractAll() opens the ~415 MB APK as a ZipFile twice (once for the version
 * marker fingerprint, once for the lib loop), stats every bundled lib and
 * every asset tree, and logs several lines. It is idempotent, so for hot
 * callers (execCommand: Sidebar polling, MONITOR 1 s poll) it is enough to
 * run it once per APK identity and afterwards only re-validate cheap
 * sentinels (the extraction marker + the bash binary that is about to be
 * exec'd). If a sentinel disappears (lib dir wiped / bash deleted) or the
 * APK identity changes, the next call runs the full extraction again.
 *
 * Deliberately free of android.* imports so it can be unit-tested on the
 * plain JVM (see ExtractionMemoTest).
 */
class ExtractionMemo {
    @Volatile
    private var validKey: ExtractionMemoKey? = null
    private val lock = Any()

    /** Pure decision: does this call need to run the full extraction? */
    fun needsExtract(currentKey: ExtractionMemoKey, sentinelsUsable: Boolean): Boolean =
        !sentinelsUsable || validKey != currentKey

    /** Record that a full extraction for [key] completed successfully. */
    fun record(key: ExtractionMemoKey) {
        validKey = key
    }

    fun invalidate() {
        validKey = null
    }

    /**
     * Run [extract] only if needed. Concurrent callers that all miss the memo
     * are serialized on [lock]; the ones queued behind the first re-check
     * after it finishes and skip. If [extract] throws, nothing is recorded and
     * the exception propagates (the next call retries).
     *
     * @return true if [extract] ran in this call.
     */
    fun ensure(
        currentKey: () -> ExtractionMemoKey,
        sentinelsUsable: () -> Boolean,
        extract: () -> Unit,
    ): Boolean {
        if (!needsExtract(currentKey(), sentinelsUsable())) return false
        synchronized(lock) {
            val key = currentKey()
            if (!needsExtract(key, sentinelsUsable())) return false
            validKey = null
            extract()
            validKey = key
            return true
        }
    }
}
