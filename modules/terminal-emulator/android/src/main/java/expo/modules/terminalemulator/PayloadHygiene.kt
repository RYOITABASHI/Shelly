package expo.modules.terminalemulator

import java.io.File

/**
 * Payload freshness helpers for LibExtractor / HomeInitializer.
 *
 * Deliberately free of android.* imports (logging goes through a callback) so
 * it can be unit-tested on the plain JVM (see PayloadHygieneTest), like
 * ExtractionMemo. Uses java.io only: these run on every extractAll() /
 * initialize(), and java.nio.file needs API 26 while minSdk is 24.
 *
 * Three jobs, all about "what is on disk must be what this APK ships":
 *  1. [removeRetired]: delete files an older Shelly extracted into
 *     termux-libs/ that nothing creates or refreshes anymore (A1).
 *  2. [removeStaleTempFiles]: delete `*.new` leftovers of an interrupted
 *     LibExtractor atomic replace (A4).
 *  3. [syncExact]: make a $HOME helper byte-identical to its APK asset and
 *     verify it by reading it back (A2).
 */
object PayloadHygiene {

    /**
     * termux-libs/ files that a previous Shelly extracted and that the current
     * code neither creates nor updates. A file listed here is deleted on every
     * LibExtractor.extractAll() if it exists.
     *
     * Why deleting is right (and leaving them is harmful): LibExtractor only
     * writes the names in its LIBS map, so a retired name is never refreshed by
     * an APK update. Anything that still points at it (an old `~/codex_exec`
     * symlink, a stale script, a hand-typed path) silently runs a binary that
     * is months old instead of failing. A missing file fails loudly and points
     * at the stale reference; a stale file hides it.
     *
     *  - codex_exec: the separate `codex exec` binary of the pre-0.142.2 Codex
     *    layout. HomeInitializer setup v231 moved to the unified binary
     *    (`codex exec ...` runs as `codex_tui exec ...`) and libcodex_exec.so
     *    left the APK (CI deletes it from jniLibs), but the extracted copy was
     *    never removed. On the owner's device it was 0.142.0 from 2026-07-12,
     *    whose model catalog only had codex-auto-review, so every general model
     *    was refused through it (payload-freshness fact sheet F3).
     *
     * A name here must never also be a LibExtractor LIBS value: removeRetired
     * skips such a name and logs an error, and a jest invariant checks the two
     * lists.
     */
    val RETIRED_LIB_FILES: List<String> = listOf(
        "codex_exec",
    )

    /** What [removeRetired] found for one retired name. */
    data class RetiredRemoval(
        val name: String,
        val removed: Boolean,
        val sizeBytes: Long,
        val lastModifiedMs: Long,
        val wasSymlink: Boolean,
    )

    /**
     * True when [f] itself is a symbolic link (java.io has no lstat: compare
     * the canonical path of the name inside its canonical parent with the
     * plain path; only a link at the last component makes them differ).
     */
    fun isSymlink(f: File): Boolean = try {
        val parent = f.absoluteFile.parentFile
        if (parent == null) {
            false
        } else {
            val inCanonicalParent = File(parent.canonicalFile, f.name)
            inCanonicalParent.canonicalFile != inCanonicalParent.absoluteFile
        }
    } catch (e: Exception) {
        false
    }

    /**
     * True when something (a file, a directory or a link, including a
     * dangling link) is at [f] -- an lstat-style check. File.exists() follows
     * links, so a link whose target is gone reads as absent; readdir(3) on the
     * parent does not follow links and still lists its name. java.io only
     * (no java.nio.file / android.system.Os, see the object doc).
     */
    fun existsNoFollow(f: File): Boolean {
        if (f.exists()) return true
        val parent = f.absoluteFile.parentFile ?: return false
        return try {
            parent.list()?.contains(f.name) == true
        } catch (e: Exception) {
            false
        }
    }

    /**
     * True when [f] is a link whose target does not resolve: listed in its
     * directory but File.exists() (which follows links) says no.
     * [isSymlink] cannot be trusted for these (canonicalization of a dangling
     * link is platform-dependent).
     */
    fun isDanglingSymlink(f: File): Boolean = !f.exists() && existsNoFollow(f)

    /**
     * Deletes each name in [names] from [libDir] if anything is at it,
     * checked without following links ([existsNoFollow], so a dangling link
     * is removed too). A symlink is removed itself, never its target; a
     * directory is left alone and reported. Names in [active] are skipped: a name that is extracted
     * again must not be deleted on every call. Never throws.
     *
     * @return one entry per name that existed.
     */
    fun removeRetired(
        libDir: File,
        names: Collection<String>,
        active: Set<String>,
        log: (String) -> Unit,
    ): List<RetiredRemoval> {
        val out = mutableListOf<RetiredRemoval>()
        for (name in names) {
            if (name.isEmpty() || name.contains('/') || name == "." || name == "..") continue
            if (name in active) {
                log("E retired payload '$name' is also an active LibExtractor entry; not deleting it")
                continue
            }
            try {
                val f = File(libDir, name)
                // lstat-style: a dangling link (target gone) is removed too.
                if (!existsNoFollow(f)) continue
                val link = isDanglingSymlink(f) || isSymlink(f)
                if (!link && f.isDirectory) {
                    log("W retired payload termux-libs/$name is a directory; left in place")
                    out.add(RetiredRemoval(name, false, -1L, -1L, false))
                    continue
                }
                val size = if (link) -1L else f.length()
                val mtime = if (link) -1L else f.lastModified()
                // File.delete() is unlink(2): a link goes, its target stays.
                val removed = f.delete() || !existsNoFollow(f)
                if (removed) {
                    log("I retired payload removed: termux-libs/$name (size=$size mtimeMs=$mtime symlink=$link); " +
                        "the current APK no longer ships or refreshes it, so a stale reference now fails instead of running an old binary")
                } else {
                    log("W could not remove retired payload termux-libs/$name")
                }
                out.add(RetiredRemoval(name, removed, size, mtime, link))
            } catch (e: Exception) {
                log("W could not remove retired payload termux-libs/$name: ${e.javaClass.simpleName}: ${e.message}")
                out.add(RetiredRemoval(name, false, -1L, -1L, false))
            }
        }
        return out
    }

    /**
     * Name of a LibExtractor temp file: `<fileName>.<pid>.<threadId>.<nanoTime>.new`
     * (LibExtractor.newTempFile). Group 1 is the target name, group 2 the pid.
     */
    private val TEMP_NAME = Regex("^(.+)\\.(\\d{1,10})\\.(\\d{1,20})\\.(-?\\d{1,20})\\.new$")

    /**
     * A temp file untouched for this long is not being written by anyone: a
     * live writer updates mtime with every chunk, and even codex_tui (~200 MB)
     * is copied in seconds.
     */
    const val STALE_TEMP_AFTER_MS: Long = 10L * 60L * 1000L

    /**
     * Deletes leftovers of an interrupted atomic replace in [libDir]: files
     * named like LibExtractor.newTempFile output whose target name is in
     * [ownedNames] (only our own temp files, never anything else in the
     * directory), and that are stale: written by a process that is gone
     * (pid != [currentPid] and ![isPidAlive]) or not modified for
     * [STALE_TEMP_AFTER_MS]. A temp file of this process or of another live
     * process that is still being written is kept, so a concurrent
     * extractAll() never loses its file mid-copy. Never throws.
     *
     * @return the names that were deleted.
     */
    fun removeStaleTempFiles(
        libDir: File,
        ownedNames: Set<String>,
        currentPid: Int,
        nowMs: Long,
        isPidAlive: (Int) -> Boolean,
        log: (String) -> Unit,
    ): List<String> {
        val removed = mutableListOf<String>()
        val entries = try {
            libDir.list()?.toList().orEmpty()
        } catch (e: Exception) {
            log("W could not list ${libDir.name} for stale temp files: ${e.message}")
            return removed
        }
        for (entry in entries) {
            val m = TEMP_NAME.matchEntire(entry) ?: continue
            val target = m.groupValues[1]
            if (target !in ownedNames) continue
            val pid = m.groupValues[2].toIntOrNull() ?: continue
            try {
                val f = File(libDir, entry)
                val link = isSymlink(f)
                if (!link && f.isDirectory) continue
                // A link (never made by LibExtractor) has no meaningful mtime
                // here; treat it as old.
                val ageMs = if (link) Long.MAX_VALUE else nowMs - f.lastModified()
                val writerGone = pid != currentPid && !isPidAlive(pid)
                if (!writerGone && ageMs < STALE_TEMP_AFTER_MS) continue
                if (f.delete()) {
                    removed.add(entry)
                    log("I removed stale extraction temp file termux-libs/$entry (writerGone=$writerGone ageMs=$ageMs)")
                }
            } catch (e: Exception) {
                log("W could not remove stale temp file termux-libs/$entry: ${e.javaClass.simpleName}: ${e.message}")
            }
        }
        return removed
    }

    enum class SyncOutcome { UNCHANGED, WRITTEN, FAILED }

    /**
     * Makes [target] a regular file whose bytes equal [expected], and checks
     * it by reading the file back. Never throws, and never removes what is at
     * [target] before a verified replacement is ready: a failed sync leaves
     * the old (stale but readable) file exactly as it was.
     *
     *  - Already a regular (non-link) file with exactly these bytes: nothing
     *    is written (UNCHANGED).
     *  - A directory (not a link to one) at the name: left untouched, FAILED.
     *    Nothing here deletes a directory.
     *  - Otherwise (stale content, missing, a symlink): the bytes go to a temp
     *    file in the same directory, fsync'd, and the temp file is read back;
     *    only when it holds exactly [expected] is it renamed over the name.
     *    rename(2) is atomic, so until it completes the old file is still
     *    there (a reader keeps the old inode; a symlink is replaced, its
     *    target is never written). The name is then read back once more.
     *    Two attempts; WRITTEN only when the final read-back matches, FAILED
     *    otherwise (the temp file is always removed).
     *
     * [writeTemp] writes and fsyncs the temp file; tests replace it to
     * simulate a failing write (e.g. a full disk).
     */
    fun syncExact(
        expected: ByteArray,
        target: File,
        log: (String) -> Unit,
        writeTemp: (File, ByteArray) -> Unit = { f, b -> writeAndSync(f, b) },
    ): SyncOutcome {
        if (contentEquals(target, expected)) return SyncOutcome.UNCHANGED
        if (!isSymlink(target) && target.isDirectory) {
            log("E ${target.name} is a directory, not the APK asset; left in place (not deleted)")
            return SyncOutcome.FAILED
        }
        for (attempt in 1..2) {
            try {
                replaceVerified(expected, target, writeTemp)
            } catch (e: Exception) {
                log("W ${target.name}: replace attempt $attempt failed (existing file kept): ${e.javaClass.simpleName}: ${e.message}")
            }
            if (contentEquals(target, expected)) {
                log("I ${target.name} refreshed from the APK asset (${expected.size} bytes, attempt $attempt)")
                return SyncOutcome.WRITTEN
            }
        }
        log("E ${target.name} still differs from the APK asset after 2 attempts (existing file kept)")
        return SyncOutcome.FAILED
    }

    /** True only for a regular, non-link file whose bytes are exactly [expected]. */
    fun contentEquals(target: File, expected: ByteArray): Boolean = try {
        target.isFile && !isSymlink(target) &&
            target.length() == expected.size.toLong() &&
            target.readBytes().contentEquals(expected)
    } catch (e: Exception) {
        false
    }

    private fun writeAndSync(tmp: File, bytes: ByteArray) {
        java.io.FileOutputStream(tmp).use { out ->
            out.write(bytes)
            out.fd.sync()
        }
    }

    /**
     * Temp file -> verify its bytes -> rename over [target]. Throws (leaving
     * [target] untouched) if the temp file cannot be written, does not read
     * back as [bytes], or cannot be renamed.
     */
    private fun replaceVerified(bytes: ByteArray, target: File, writeTemp: (File, ByteArray) -> Unit) {
        val dir = target.absoluteFile.parentFile ?: throw java.io.IOException("no parent for ${target.name}")
        dir.mkdirs()
        val tmp = File.createTempFile(".${target.name}.", ".tmp", dir)
        try {
            writeTemp(tmp, bytes)
            if (!contentEquals(tmp, bytes)) {
                throw java.io.IOException("temp file for ${target.name} does not read back as the asset")
            }
            // rename(2): atomic, replaces a file or a link at the name (never
            // writes through a link). Until it succeeds the old file stays.
            if (!tmp.renameTo(target)) throw java.io.IOException("rename failed for ${target.name}")
        } finally {
            // Gone after a successful rename; otherwise the unverified copy.
            tmp.delete()
        }
    }
}
