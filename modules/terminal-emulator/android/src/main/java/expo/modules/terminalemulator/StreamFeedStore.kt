package expo.modules.terminalemulator

import android.content.Context
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.SecureRandom

/**
 * Where the stream feed lives (fact sheet §6.2 P3/P4; format StreamFeedCore.encode).
 *
 * `noBackupFilesDir/stream-feed/feed-v1`: app-private, outside `$HOME` (no
 * shell, agent or MCP file tool path reaches it) and excluded from backup.
 * Directory 0700, file 0600.
 *
 * Writers: McpTypedOpConsumer (an always-allow rule matched) and
 * TerminalEmulatorModule.streamFeedPut (the RN MCP bridge after an approval
 * tap or a rule match). Reader: the launcher ingress Provider only
 * (get_stream_feed). Nothing else may call [read]; the stored text is never
 * logged, audited or passed to a run, a prompt or an agent
 * (__tests__/stream-feed-isolation.test.ts).
 *
 * [put]: STOP-ALL re-check, then the audit line `storing` (sha256 / bytes /
 * items, no content) BEFORE the write — not written means nothing is stored —
 * then a temp file created O_EXCL in the same directory, written, fsync'd,
 * read back and decoded (size and digest re-verified), and rename(2)d over the
 * feed. Any failure removes the temp file and keeps the previous feed
 * (last-good: never blank).
 */
object StreamFeedStore {
    private const val TAG = "StreamFeedStore"
    private const val DIR = "stream-feed"
    private const val FILE = "feed-v1"
    private const val MAX_FILE_BYTES = StreamFeedCore.MAX_BYTES + 512
    private val random = SecureRandom()

    sealed class PutResult {
        data class Stored(val sha256: String, val bytes: Int, val receivedAt: Long, val items: Int?) : PutResult()
        data class Refused(val refusal: McpTypedOpDecision.Refusal) : PutResult()
    }

    private fun dir(context: Context): File = File(context.applicationContext.noBackupFilesDir, DIR)

    /**
     * Stores [feed] (already validated by StreamFeedCore) for [principal]
     * (32-hex MCP principal, audit only). The caller has authorized it (rule
     * or tap). Never throws.
     */
    @Synchronized
    fun put(context: Context, feed: StreamFeedCore.Feed, principal: String?, deadlineMs: Long = Long.MAX_VALUE): PutResult {
        val app = context.applicationContext
        try {
            gate(app, deadlineMs)?.let { r ->
                audit(app, principal, r.code, null)
                return PutResult.Refused(r)
            }
            if (!audit(app, principal, "storing", feed)) return PutResult.Refused(StreamFeedCore.AUDIT_FAILED)
            val receivedAt = System.currentTimeMillis()
            var late: McpTypedOpDecision.Refusal? = null
            // STOP-ALL and the deadline once more, right before the rename.
            val replaced = replace(app, StreamFeedCore.encode(feed, receivedAt)) {
                late = gate(app, deadlineMs)
                late == null
            }
            late?.let { r ->
                audit(app, principal, r.code, feed)
                return PutResult.Refused(r)
            }
            if (!replaced) {
                audit(app, principal, StreamFeedCore.STORE_FAILED.code, feed)
                return PutResult.Refused(StreamFeedCore.STORE_FAILED)
            }
            return PutResult.Stored(feed.sha256, feed.size, receivedAt, feed.items)
        } catch (e: Exception) {
            Log.w(TAG, "feed not stored type=${e.javaClass.simpleName}")
            return PutResult.Refused(StreamFeedCore.STORE_FAILED)
        }
    }

    /** The launcher read (Provider only). Never throws. */
    @Synchronized
    fun read(context: Context): StreamFeedCore.State = try {
        val f = File(dir(context), FILE)
        val st = try { Os.lstat(f.path) } catch (e: android.system.ErrnoException) {
            if (e.errno == OsConstants.ENOENT) null else throw e
        }
        when {
            st == null -> StreamFeedCore.State.Empty
            !OsConstants.S_ISREG(st.st_mode) || st.st_size > MAX_FILE_BYTES -> StreamFeedCore.State.Unreadable
            else -> {
                val stored = readAll(f)?.let { StreamFeedCore.decode(it) }
                if (stored == null) StreamFeedCore.State.Unreadable else StreamFeedCore.State.Present(stored)
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "feed not readable type=${e.javaClass.simpleName}")
        StreamFeedCore.State.Unreadable
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    /** Null when the feed may still be stored: STOP-ALL off (determinably) and the request not past [deadlineMs]. */
    private fun gate(app: Context, deadlineMs: Long): McpTypedOpDecision.Refusal? = when {
        haltedStrict(app) -> StreamFeedCore.HALTED
        System.currentTimeMillis() >= deadlineMs -> StreamFeedCore.EXPIRED
        else -> null
    }

    /** STOP-ALL: only a definite ENOENT for `.halted` is "off"; any other error counts as on (fail closed). */
    internal fun haltedStrict(app: Context): Boolean = try {
        Os.lstat(File(McpTypedOpConsumer.agentsDir(app), ".halted").path)
        true
    } catch (e: android.system.ErrnoException) {
        e.errno != OsConstants.ENOENT
    } catch (e: Exception) {
        true
    }

    private fun audit(app: Context, principal: String?, code: String, feed: StreamFeedCore.Feed?): Boolean {
        val ok = IngressAuditWriter.appendStreamFeedLine(app, principal, code, feed?.sha256, feed?.size, feed?.items)
        if (!ok) Log.w(TAG, "audit line not written ($code)")
        return ok
    }

    private fun replace(app: Context, content: ByteArray, beforeRename: () -> Boolean): Boolean {
        val d = dir(app)
        val target = File(d, FILE)
        var tmp: File? = null
        try {
            d.mkdirs()
            val st = Os.lstat(d.path)
            if (!OsConstants.S_ISDIR(st.st_mode)) return false
            Os.chmod(d.path, 448 /* 0700 */)
            val suffix = ByteArray(8).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
            val t = File(d, ".$FILE.$suffix.tmp")
            tmp = t
            val fd: FileDescriptor = Os.open(
                t.path,
                OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC,
                384, /* 0600 */
            )
            try {
                // A stream over a FileDescriptor does not own it on Android: Os.close below.
                FileOutputStream(fd).use { out ->
                    out.write(content)
                    out.flush()
                    Os.fsync(fd)
                }
            } finally {
                runCatching { Os.close(fd) }
            }
            val back = readAll(t)
            if (back == null || !back.contentEquals(content) || StreamFeedCore.decode(back) == null) return false
            if (!beforeRename()) return false
            // rename(2): atomic; until it succeeds readers see the previous feed.
            Os.rename(t.path, target.path)
            tmp = null
            return true
        } catch (e: Exception) {
            Log.w(TAG, "feed replace failed (previous feed kept) type=${e.javaClass.simpleName}")
            return false
        } finally {
            tmp?.let { runCatching { Os.remove(it.path) } }
        }
    }

    private fun readAll(f: File): ByteArray? {
        val fd = Os.open(f.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC, 0)
        try {
            FileInputStream(fd).use { input ->
                val buf = ByteArray(MAX_FILE_BYTES + 1)
                var n = 0
                while (n < buf.size) {
                    val r = input.read(buf, n, buf.size - n)
                    if (r < 0) break
                    n += r
                }
                return if (n > MAX_FILE_BYTES) null else buf.copyOf(n)
            }
        } finally {
            runCatching { Os.close(fd) }
        }
    }
}
