package expo.modules.terminalemulator

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import android.view.View
import java.io.Closeable
import java.io.File
import java.io.FileDescriptor
import java.io.FileInputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import org.json.JSONObject

internal object StageInstall {
    private const val PREFS = "stage-install-results"
    private const val LAST_RESULT = "__last__"
    private const val LAST_RESULT_EPOCH = "__last_epoch__"
    private const val POISON_MARKER = "stage-install-poison"
    private const val POISON_TEMP_PREFIX = ".stage-install-poison-"
    private const val LAST_RESULT_MIRROR = "stage-install-last.json"
    private const val MIRROR_TEMP_PREFIX = ".stage-install-last-"
    private const val MAX_MIRROR_BYTES = 256 * 1024 // Matches SNAPSHOT_MAX_BYTES in the server.
    private const val MAX_MESSAGE_BYTES = 32 * 1024
    private const val MAX_SESSION_RECORDS = 20
    private const val MAX_MARKER_ONLY_SESSIONS = 20
    // Latest-result eligibility survives process restarts and advances only on token revocation.
    private const val REVOCATION_EPOCH = "__rev_epoch__"

    // Receiver and activity lifecycle callbacks use the main thread. Android
    // can block launches from the background, so hold the intent until resume.
    private val confirmations = linkedMapOf<Int, Intent>()

    fun requestConfirmation(context: Context, sessionId: Int, confirmation: Intent) {
        record(context, sessionId, "user_action_required", PackageInstaller.STATUS_PENDING_USER_ACTION, "")
        confirmations[sessionId] = confirmation
        val activity = TerminalEmulatorModule.stageInstallActivity()
        if (activity?.window?.decorView?.windowVisibility == View.VISIBLE) {
            showNextConfirmation(activity)
        }
    }

    fun showNextConfirmation(activity: Activity) {
        if (activity.isFinishing || activity.isDestroyed) return
        val (id, confirmation) = confirmations.entries.firstOrNull() ?: return
        confirmations.remove(id)
        try {
            activity.startActivity(confirmation)
            record(activity, id, "user_action_required", PackageInstaller.STATUS_PENDING_USER_ACTION, "")
        } catch (_: RuntimeException) {
            Log.w("StageInstall", "could not launch installer confirmation for session $id")
        }
    }

    fun clearConfirmation(sessionId: Int) {
        confirmations.remove(sessionId)
    }

    private fun checkedApk(context: Context, path: String): File {
        require(path.startsWith("/") && path.endsWith(".apk", ignoreCase = true) &&
            path.none { it.code < 32 || it.code == 127 } && ".." !in path.split('/')) {
            "path must be an absolute .apk file path without traversal or control characters"
        }
        val apk = File(path).canonicalFile
        require(apk.path.none { it.code < 32 || it.code == 127 }) { "resolved APK path contains control characters" }
        val roots = listOfNotNull(
            context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS),
            File("/storage/emulated/0/Download"),
            HomeInitializer.getHomeDir(context),
        )
        require(roots.any { apk.path.startsWith(it.canonicalPath.trimEnd('/') + "/") }) {
            "APK path is outside the allowed directories"
        }
        require(apk.isFile && apk.name.endsWith(".apk", ignoreCase = true)) { "APK not found or not a regular .apk file" }
        return apk
    }

    private val commitLock = Any()
    private var prefsDurable = true
    private var mirrorPoisonPending = false
    private data class PrefsIdentity(val epoch: Long, val digest: String?)
    private data class FailedFenceWrite(
        val kind: PoisonKind, val sessionId: Int, val epoch: Long, val digest: String,
        val snapshot: PrefsIdentity,
    )
    private var failedFenceWrite: FailedFenceWrite? = null
    // Process-local guard against committing an approval after revocation.
    private var generation = 0.0

    fun currentGeneration(): Double = synchronized(commitLock) { generation }

    fun invalidate(context: Context, clearLastResult: Boolean): Boolean = synchronized(commitLock) {
        generation += 1
        if (!clearLastResult) return@synchronized true

        openPinnedDir(context).use { dir ->
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val targetEpoch = prefs.getLong(REVOCATION_EPOCH, 0L) + 1L
            if (!writeFenceChecked(prefs, dir, PoisonKind.INVALIDATE, 0, targetEpoch)) {
                markFailedFenceWrite(dir)
                return@synchronized false
            }
            checkNotNull(dir)
            val cleared = prefs.edit()
                .putLong(REVOCATION_EPOCH, targetEpoch)
                .remove(LAST_RESULT).remove(LAST_RESULT_EPOCH).commit()
            prefsDurable = cleared
            if (!cleared) {
                latchMirrorDivergence(prefs, dir)
                Log.w("StageInstall", "could not advance revocation epoch and clear latest installer status")
                return@synchronized false
            }
            if (deleteLastResultMirror(dir)) return@synchronized resolveMirrorDivergence(dir)
            latchMirrorDivergence(prefs, dir)
            false
        }
    }

    private fun checkPrefsCommit(context: Context, committed: Boolean) {
        prefsDurable = committed
        if (!committed) {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            openPinnedDir(context).use { dir -> latchMirrorDivergence(prefs, dir) }
        }
    }

    private class StageError(val code: String, message: String) : Exception(message)

    private fun checkDeadline(deadline: Long) {
        if (System.currentTimeMillis() >= deadline) throw StageError("timeout", "timed out staging APK")
    }

    private fun hashApk(context: Context, path: String, apk: File, deadline: Long, output: OutputStream? = null): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val fd = Os.open(apk.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or
            OsConstants.O_NONBLOCK or OsConstants.O_CLOEXEC, 0)
        try {
            FileInputStream(fd).use { input ->
                val opened = Os.fstat(fd)
                val named = Os.stat(apk.path)
                require(OsConstants.S_ISREG(opened.st_mode) && opened.st_dev == named.st_dev &&
                    opened.st_ino == named.st_ino && checkedApk(context, path) == apk) {
                    "APK path changed while opening the file"
                }
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    checkDeadline(deadline)
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                    output?.write(buffer, 0, count)
                }
            }
        } finally {
            Os.close(fd)
        }
        checkDeadline(deadline)
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    fun resolvePath(context: Context, path: String, deadline: Long): Map<String, String> = try {
        checkDeadline(deadline)
        val apk = checkedApk(context, path)
        mapOf("path" to apk.path, "sha256" to hashApk(context, path, apk, deadline))
    } catch (e: StageError) {
        mapOf("error" to e.message.orEmpty(), "code" to e.code)
    } catch (e: IllegalArgumentException) {
        mapOf("error" to (e.message ?: "invalid APK path"))
    } catch (_: Exception) {
        mapOf("error" to "could not resolve APK path")
    }

    fun install(
        context: Context, path: String, approvedSha256: String, expectedSha256: String?,
        deadline: Long, approvedGeneration: Double,
    ): Map<String, Any> {
        val pm = context.packageManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !pm.canRequestPackageInstalls()) {
            return mapOf("error" to "Shelly is not allowed to install unknown apps")
        }
        val installer = pm.packageInstaller
        var sessionId: Int? = null
        var callback: PendingIntent? = null
        var committed = false
        var snapshot: File? = null
        try {
            checkDeadline(deadline)
            val apk = checkedApk(context, path)
            require(apk.path == File(path).absolutePath) { "APK path changed while waiting for approval" }
            require(expectedSha256 == null || Regex("[0-9a-f]{64}").matches(expectedSha256)) { "invalid expected SHA-256" }

            // Snapshot and hash the source before creating an install session.
            val copy = File.createTempFile("stage-install-", ".apk", context.cacheDir)
            snapshot = copy
            val sha256 = copy.outputStream().use { output -> hashApk(context, path, apk, deadline, output) }
            if (sha256 != approvedSha256) {
                throw StageError("digest_changed", "APK changed while waiting for approval")
            }
            require(expectedSha256 == null || sha256 == expectedSha256) { "APK SHA-256 mismatch" }
            checkDeadline(deadline)
            val id = installer.createSession(PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL))
            sessionId = id
            val cleared = synchronized(commitLock) {
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val epoch = prefs.getLong(REVOCATION_EPOCH, 0L)
                val markerKey = "$id:gen"
                val marker = "$epoch:${System.currentTimeMillis()}"
                val editor = prefs.edit().remove(id.toString()).putString(markerKey, marker)
                prune(editor, prefs.all - id.toString() + (markerKey to marker))
                editor.commit().also { checkPrefsCommit(context, it) }
            }
            check(cleared) { "could not initialize APK install status" }
            installer.openSession(id).use { session ->
                val length = copy.length()
                val streamedDigest = MessageDigest.getInstance("SHA-256")
                var bytesWritten = 0L
                session.openWrite("base.apk", 0, length).use { output ->
                    copy.inputStream().use { input ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            checkDeadline(deadline)
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                            streamedDigest.update(buffer, 0, count)
                            bytesWritten += count
                        }
                    }
                    // Check the bytes handed to the installer and the size used to preallocate its file.
                    val streamedSha256 = streamedDigest.digest().joinToString("") { "%02x".format(it) }
                    if (bytesWritten != length || streamedSha256 != approvedSha256) {
                        throw StageError("digest_changed", "APK changed while writing the install session")
                    }
                    session.fsync(output)
                }
                // The installer fills in the result extras on this explicit callback.
                val flags = PendingIntent.FLAG_CANCEL_CURRENT or
                    (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                val statusCallback = PendingIntent.getBroadcast(context, id, Intent(context, StageInstallReceiver::class.java), flags)
                callback = statusCallback
                // Serialize the last revocation check and commit with synchronous invalidation.
                synchronized(commitLock) {
                    if (approvedGeneration != generation) {
                        throw StageError("revoked", "cancelled: pending MCP requests were revoked")
                    }
                    checkDeadline(deadline)
                    session.commit(statusCallback.intentSender)
                    committed = true
                }
            }
            // An open source descriptor pins the inode, but its contents remain mutable.
            // Omit metadata unless it can be parsed from immutable, digest-verified bytes.
            return mapOf("sessionId" to id)
        } catch (e: StageError) {
            return mapOf("error" to e.message.orEmpty(), "code" to e.code)
        } catch (e: IllegalArgumentException) {
            return mapOf("error" to (e.message ?: "invalid APK"))
        } catch (e: IllegalStateException) {
            return mapOf("error" to (e.message ?: "could not stage APK"))
        } catch (_: Exception) {
            return mapOf("error" to "could not stage APK")
        } finally {
            snapshot?.delete()
            if (!committed) {
                sessionId?.let { id -> runCatching { installer.abandonSession(id) } }
                callback?.cancel()
            }
        }
    }

    private fun read(context: Context, sessionId: Int): JSONObject? {
        val value = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(sessionId.toString(), null)
        return value?.let { JSONObject(it) }
    }

    fun result(context: Context, sessionId: Int): Map<String, Any> {
        val record = read(context, sessionId) ?: return mapOf("status" to "pending")
        return resultFields(record)
    }

    fun lastResult(context: Context): Map<String, Any> = synchronized(commitLock) {
        check(prefsDurable && !mirrorPoisonPending && !lastResultFenceMayExist(context)) {
            "latest installer status is not durable"
        }
        val value = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(LAST_RESULT, null)
            ?: return@synchronized mapOf("status" to "none")
        val record = JSONObject(value)
        val result = resultFields(record)
        if (record.has("sessionId")) result["sessionId"] = record.getInt("sessionId")
        result
    }

    private fun resultFields(record: JSONObject): MutableMap<String, Any> {
        val status = record.getString("status")
        val result = mutableMapOf<String, Any>("status" to status, "at" to record.getLong("at"))
        if (status == "failure") {
            result["statusCode"] = record.getInt("statusCode")
            result["message"] = record.getString("message")
        }
        return result
    }

    private class PinnedDir(
        private val path: String, private val dirFd: FileDescriptor, private val pfd: ParcelFileDescriptor,
    ) : Closeable {
        private val link = "/proc/self/fd/${pfd.fd}"

        fun verify() {
            check(Os.readlink(link) == path && OsConstants.S_ISDIR(Os.fstat(dirFd).st_mode))
        }

        fun sync() {
            Os.fsync(dirFd)
            verify()
        }

        fun leaf(name: String): File = File("$link/$name")

        fun entries(): Array<String> = File(link).list() ?: error("could not list queue directory")

        fun unlink(file: File) {
            verify()
            try {
                Os.remove(file.path)
            } catch (error: ErrnoException) {
                if (error.errno != OsConstants.ENOENT) throw error
            }
            // Sync even on ENOENT in case a previous unlink's fsync failed.
            sync()
        }

        fun publish(prefix: String, name: String, bytes: ByteArray) {
            verify()
            val nonce = ByteArray(8)
            SecureRandom().nextBytes(nonce)
            val temp = leaf(prefix + nonce.joinToString("") { "%02x".format(it) } + ".tmp")
            val flags = OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or
                OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC
            val fd = Os.open(temp.path, flags, 384)
            var renamed = false
            try {
                try {
                    var offset = 0
                    while (offset < bytes.size) {
                        val count = Os.write(fd, bytes, offset, bytes.size - offset)
                        check(count > 0)
                        offset += count
                    }
                    Os.fsync(fd)
                } finally {
                    Os.close(fd)
                }
                verify()
                Os.rename(temp.path, leaf(name).path)
                renamed = true
                sync()
            } finally {
                if (!renamed) unlink(temp)
            }
        }

        override fun close() {
            try {
                pfd.close()
            } finally {
                Os.close(dirFd)
            }
        }
    }

    private fun openPinnedDir(context: Context): PinnedDir? = runCatching {
        val dir = McpTypedOpConsumer.queueDir(context)
        dir.mkdirs()
        pinDirectory(dir)
    }.getOrNull()

    private fun pinDirectory(dir: File): PinnedDir {
        val parent = checkNotNull(dir.absoluteFile.parentFile).canonicalFile
        val path = File(parent, dir.name).path
        val flags = OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC
        val dirFd = Os.open(path, flags, 0)
        try {
            check(OsConstants.S_ISDIR(Os.fstat(dirFd).st_mode))
            val pfd = ParcelFileDescriptor.dup(dirFd)
            try {
                return PinnedDir(path, dirFd, pfd).also { it.verify() }
            } catch (error: Exception) {
                pfd.close()
                throw error
            }
        } catch (error: Exception) {
            Os.close(dirFd)
            throw error
        }
    }

    private fun lastResultFenceMayExist(context: Context): Boolean {
        val queueDir = McpTypedOpConsumer.queueDir(context)
        val dir = try {
            pinDirectory(queueDir)
        } catch (error: ErrnoException) {
            return error.errno != OsConstants.ENOENT || pathMayExist(queueDir)
        } catch (_: Exception) {
            return true
        }
        return dir.use {
            val exists = poisonMarkerExists(it)
            it.verify()
            exists
        }
    }

    private fun readRegularFile(file: File, limit: Int): ByteArray {
        val flags = OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_NONBLOCK
        val fd = Os.open(file.path, flags, 0)
        try {
            check(OsConstants.S_ISREG(Os.fstat(fd).st_mode))
            val buffer = ByteArray(limit + 1)
            var length = 0
            while (length < buffer.size) {
                val count = Os.read(fd, buffer, length, buffer.size - length)
                if (count == 0) break
                length += count
            }
            return buffer.copyOf(length)
        } finally {
            Os.close(fd)
        }
    }

    private fun deleteLastResultMirror(dir: PinnedDir): Boolean = runCatching {
        dir.unlink(dir.leaf(LAST_RESULT_MIRROR))
        !mirrorExists(dir)
    }.getOrElse {
        Log.w("StageInstall", "could not confirm deletion of latest installer status mirror", it)
        false
    }

    private fun poisonMarkerExists(dir: PinnedDir): Boolean = pathMayExist(dir.leaf(POISON_MARKER))

    private fun mirrorExists(dir: PinnedDir): Boolean = pathMayExist(dir.leaf(LAST_RESULT_MIRROR))

    private fun pathMayExist(file: File): Boolean = try {
        Os.lstat(file.path)
        true
    } catch (e: ErrnoException) {
        e.errno != OsConstants.ENOENT
    } catch (_: Exception) {
        true
    }

    private enum class PoisonKind {
        TERMINAL,
        INVALIDATE,
    }

    private sealed interface PoisonFence {
        object Absent : PoisonFence
        data class Terminal(
            val sessionId: Int, val epoch: Long, val digest: String, val invalidateTarget: Long?,
        ) : PoisonFence
        data class Invalidate(val targetEpoch: Long) : PoisonFence
        object Malformed : PoisonFence
    }

    private fun poisonChecksum(body: String): String = MessageDigest.getInstance("SHA-256")
        .digest(body.toByteArray(Charsets.US_ASCII)).take(8).joinToString("") { "%02x".format(it) }

    private fun resultDigest(value: String): String = McpTokenFingerprintStore.hash(value).take(16)

    private fun readPoisonFence(dir: PinnedDir): PoisonFence {
        val marker = dir.leaf(POISON_MARKER)
        try {
            Os.lstat(marker.path)
        } catch (error: ErrnoException) {
            if (error.errno == OsConstants.ENOENT) return PoisonFence.Absent
            throw error
        }
        return try {
            val content = readRegularFile(marker, 96).toString(Charsets.US_ASCII)
            val fields = content.split(':')
            if (fields.size !in 6..7 || fields[0] != "v2") return PoisonFence.Malformed
            val sessionId = fields[2].toIntOrNull() ?: return PoisonFence.Malformed
            if (sessionId < 0 || fields[2] != sessionId.toString()) return PoisonFence.Malformed
            val epoch = fields[3].toLongOrNull() ?: return PoisonFence.Malformed
            if (epoch < 0 || fields[3] != epoch.toString()) return PoisonFence.Malformed
            val digest = fields[4]
            val checksum = poisonChecksum(content.substringBeforeLast(':'))
            if (fields.last() != checksum) return PoisonFence.Malformed
            when (fields[1]) {
                "terminal" -> if (digest.length == 16 && digest.all { it in '0'..'9' || it in 'a'..'f' }) {
                    val targetField = if (fields.size == 7) fields[5] else "-"
                    val target = if (targetField == "-") null else {
                        val parsed = targetField.toLongOrNull() ?: return PoisonFence.Malformed
                        if (parsed < 0 || targetField != parsed.toString()) return PoisonFence.Malformed
                        parsed
                    }
                    PoisonFence.Terminal(sessionId, epoch, digest, target)
                } else PoisonFence.Malformed
                "invalidate" -> if (fields.size == 6 && sessionId == 0 && digest == "-") {
                    PoisonFence.Invalidate(epoch)
                } else PoisonFence.Malformed
                else -> PoisonFence.Malformed
            }
        } catch (_: Exception) {
            PoisonFence.Malformed
        }
    }

    private fun prefsIdentity(prefs: SharedPreferences): PrefsIdentity = PrefsIdentity(
        prefs.getLong(REVOCATION_EPOCH, 0L), prefs.getString(LAST_RESULT, null)?.let(::resultDigest),
    )

    private fun writeFenceChecked(
        prefs: SharedPreferences, dir: PinnedDir?, kind: PoisonKind, sessionId: Int, epoch: Long,
        digest: String = "-",
    ): Boolean {
        // A failed write may have reached rename without completing the directory sync.
        val written = dir != null && writePoisonMarker(dir, kind, sessionId, epoch, digest) &&
            (failedFenceWrite == null || runCatching { dir.sync() }.isSuccess)
        failedFenceWrite = if (written) null else FailedFenceWrite(kind, sessionId, epoch, digest, prefsIdentity(prefs))
        return written
    }

    // All callers hold commitLock, including the read/merge and atomic publication.
    private fun writePoisonMarker(
        dir: PinnedDir, kind: PoisonKind, sessionId: Int, epoch: Long, digest: String,
        invalidateTarget: Long? = null,
    ): Boolean = runCatching {
        dir.verify()
        val existing = readPoisonFence(dir)
        val body = when {
            existing == PoisonFence.Malformed -> return@runCatching
            kind == PoisonKind.TERMINAL -> {
                val recordedTarget = (existing as? PoisonFence.Terminal)?.invalidateTarget
                val target = when {
                    recordedTarget == null -> invalidateTarget
                    invalidateTarget == null -> recordedTarget
                    else -> maxOf(recordedTarget, invalidateTarget)
                }
                "v2:terminal:$sessionId:$epoch:$digest:${target ?: "-"}"
            }
            existing is PoisonFence.Invalidate -> return@runCatching
            existing is PoisonFence.Terminal -> {
                val target = maxOf(existing.invalidateTarget ?: 0L, epoch)
                "v2:terminal:${existing.sessionId}:${existing.epoch}:${existing.digest}:$target"
            }
            else -> "v2:invalidate:$sessionId:$epoch:$digest"
        }
        dir.publish(POISON_TEMP_PREFIX, POISON_MARKER, "$body:${poisonChecksum(body)}".toByteArray(Charsets.US_ASCII))
    }.isSuccess

    // Preserve the failed attempt for refresh while suppressing the old mirror.
    private fun markFailedFenceWrite(dir: PinnedDir?) {
        mirrorPoisonPending = true
        Log.w("StageInstall", "could not persist latest installer status fence")
        if (dir != null) poisonLastResultMirror(dir)
    }

    private fun latchMirrorDivergence(prefs: SharedPreferences, dir: PinnedDir?) {
        mirrorPoisonPending = true
        val targetEpoch = prefs.getLong(REVOCATION_EPOCH, 0L) + 1L
        if (!writeFenceChecked(prefs, dir, PoisonKind.INVALIDATE, 0, targetEpoch)) {
            Log.w("StageInstall", "could not persist latest installer status fence")
        }
        if (dir != null) poisonLastResultMirror(dir)
    }

    private fun resolveMirrorDivergence(dir: PinnedDir): Boolean {
        mirrorPoisonPending = !runCatching {
            dir.unlink(dir.leaf(POISON_MARKER))
            !poisonMarkerExists(dir)
        }.getOrDefault(false)
        return !mirrorPoisonPending
    }

    private fun resolvePublishedMirror(context: Context, dir: PinnedDir, signingToken: String): Boolean =
        synchronized(McpTokenFingerprintStore.monitor) {
            val current = McpAutostartStore.readToken(context)
            if (current !is McpAutostartStore.TokenRead.Present || current.token != signingToken) {
                return@synchronized false
            }
            val fingerprint = McpTokenFingerprintStore.get(context)
            if (McpTokenFingerprintStore.isTombstone(fingerprint) ||
                (fingerprint != null && fingerprint != McpTokenFingerprintStore.hash(signingToken))
            ) {
                return@synchronized false
            }
            resolveMirrorDivergence(dir)
        }

    private fun poisonLastResultMirror(dir: PinnedDir): Boolean = runCatching {
        dir.verify()
        val mirror = dir.leaf(LAST_RESULT_MIRROR)
        val poisoned = runCatching {
            val fd = Os.open(
                mirror.path, OsConstants.O_WRONLY or OsConstants.O_NOFOLLOW or OsConstants.O_NONBLOCK, 0,
            )
            try {
                check(OsConstants.S_ISREG(Os.fstat(fd).st_mode))
                // A leading NUL invalidates the JSON envelope even if unlink fails.
                check(Os.write(fd, byteArrayOf(0), 0, 1) == 1)
                Os.fsync(fd)
            } finally {
                Os.close(fd)
            }
        }.isSuccess
        deleteLastResultMirror(dir) || (poisoned && readRegularFile(mirror, 0).contentEquals(byteArrayOf(0)))
    }.getOrDefault(false).also { confirmed ->
        if (!confirmed) Log.w("StageInstall", "could not confirm poisoning of latest installer status mirror")
    }

    private fun writeLastResultMirror(context: Context, dir: PinnedDir, token: String, body: String): Boolean =
        try {
            // Sign the exact stored body, as with snapshot.json.
            val mac = McpRawToolDecision.snapshotMac(token, body)
            val signed = JSONObject().put("body", body).put("mac", mac)
            dir.publish(MIRROR_TEMP_PREFIX, LAST_RESULT_MIRROR, signed.toString().toByteArray(Charsets.UTF_8))
            val bytes = readRegularFile(dir.leaf(LAST_RESULT_MIRROR), MAX_MIRROR_BYTES)
            check(bytes.size <= MAX_MIRROR_BYTES)
            val published = JSONObject(bytes.toString(Charsets.UTF_8))
            check(published.opt("body") == body && published.opt("mac") == mac)
            val current = McpAutostartStore.readToken(context)
            dir.verify()
            current is McpAutostartStore.TokenRead.Present && current.token == token
        } catch (_: Exception) {
            Log.w("StageInstall", "could not write latest installer status mirror")
            false
        }

    fun refreshLastResultMirror(context: Context): Boolean = synchronized(commitLock) {
        openPinnedDir(context).use { dir ->
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val identity = prefsIdentity(prefs)
            val epoch = identity.epoch
            failedFenceWrite?.let { failed ->
                if (failed.snapshot != identity) {
                    failedFenceWrite = null
                } else if (!writeFenceChecked(prefs, dir, failed.kind, failed.sessionId, failed.epoch, failed.digest)) {
                    return@synchronized false
                }
            }
            if (dir == null) return@synchronized false
            val fence = runCatching { readPoisonFence(dir) }.getOrDefault(PoisonFence.Malformed)
            if (fence == PoisonFence.Malformed) return@synchronized false
            if (!prefsDurable && fence != PoisonFence.Absent) return@synchronized false
            val fencedForRefresh = fence == PoisonFence.Absent && mirrorExists(dir)
            // A fence created by this refresh covers this operation only. A fence
            // found on disk must be reconciled against the committed prefs below.
            if (fencedForRefresh && !writeFenceChecked(prefs, dir, PoisonKind.INVALIDATE, 0, epoch + 1L)) {
                return@synchronized false
            }

            val swept = runCatching {
                dir.entries().forEach { name ->
                    if (name.startsWith(MIRROR_TEMP_PREFIX) && name.endsWith(".tmp")) dir.unlink(dir.leaf(name))
                }
            }.isSuccess
            if (!swept) return@synchronized false

            val diverged = mirrorPoisonPending || fence != PoisonFence.Absent || fencedForRefresh
            if (prefsDurable) {
                try {
                    val value = prefs.getString(LAST_RESULT, null)
                    when (fence) {
                        is PoisonFence.Invalidate -> {
                            if (epoch < fence.targetEpoch || value != null) return@synchronized false
                        }
                        is PoisonFence.Terminal -> {
                            val target = fence.invalidateTarget
                            if (target != null) {
                                if (epoch < target) return@synchronized false
                                if (value == null) {
                                    return@synchronized deleteLastResultMirror(dir) && resolveMirrorDivergence(dir)
                                }
                                // The epoch bump atomically cleared __last__. A present value is a later commit.
                            } else {
                                if (value == null || prefs.getLong(LAST_RESULT_EPOCH, -1L) != fence.epoch ||
                                    resultDigest(value) != fence.digest
                                ) return@synchronized false
                                val sessionRecord = prefs.getString(fence.sessionId.toString(), null)
                                if (sessionRecord == null || value != sessionRecord) return@synchronized false
                                val record = runCatching { JSONObject(sessionRecord) }.getOrNull() ?: return@synchronized false
                                val status = record.optString("status")
                                if ((status != "success" && status != "failure") ||
                                    record.optInt("sessionId", -1) != fence.sessionId
                                ) return@synchronized false
                            }
                        }
                        else -> Unit
                    }

                    val sessionId = value?.let { JSONObject(it).optInt("sessionId", -1) }
                    // Older records associated their epoch through the session marker.
                    val storedEpoch = if (prefs.contains(LAST_RESULT_EPOCH)) {
                        prefs.getLong(LAST_RESULT_EPOCH, -1L)
                    } else {
                        sessionId?.let { prefs.getString("$it:gen", null)?.substringBefore(':')?.toLongOrNull() } ?: -1L
                    }
                    val token = McpAutostartStore.read(context)?.token
                    // Absent-fence publication also requires no failed write covering these prefs.
                    val canPublish = fence != PoisonFence.Absent || failedFenceWrite == null
                    if (canPublish && value != null && storedEpoch == epoch && token != null) {
                        if (writeLastResultMirror(context, dir, token, value)) {
                            return@synchronized !diverged || resolvePublishedMirror(context, dir, token)
                        }
                    } else if (fence !is PoisonFence.Terminal && deleteLastResultMirror(dir)) {
                        if (!diverged) return@synchronized true
                        if (value == null || fencedForRefresh) return@synchronized resolveMirrorDivergence(dir)
                    }
                } catch (error: Exception) {
                    Log.w("StageInstall", "could not reconcile latest installer status mirror", error)
                    if (fence != PoisonFence.Absent) return@synchronized false
                }
            }
            latchMirrorDivergence(prefs, dir)
            false
        }
    }

    private fun truncateMessage(message: String): String {
        val bytes = message.take(MAX_MESSAGE_BYTES).toByteArray(Charsets.UTF_8)
        if (bytes.size <= MAX_MESSAGE_BYTES) return String(bytes, Charsets.UTF_8)
        var end = MAX_MESSAGE_BYTES
        while ((bytes[end].toInt() and 0xc0) == 0x80) end--
        return String(bytes, 0, end, Charsets.UTF_8)
    }

    private fun prune(
        editor: SharedPreferences.Editor,
        records: Map<String, Any?>,
        newRecord: String? = null,
    ) {
        val nonterminal = records.entries.asSequence()
            .filter { it.key.toIntOrNull() != null }
            .filter { runCatching { JSONObject(it.value as String).getString("status") }.getOrNull() == "user_action_required" }
            .map { it.key }
            .toSet()
        val reserveTerminal = newRecord != null && newRecord !in nonterminal
        val keptRecords = records.entries.asSequence()
            .filter { it.key != newRecord && it.key.toIntOrNull() != null && it.key !in nonterminal }
            .sortedByDescending { runCatching { JSONObject(it.value as String).getLong("at") }.getOrDefault(0L) }
            .take(if (reserveTerminal) MAX_SESSION_RECORDS - 1 else MAX_SESSION_RECORDS)
            .map { it.key }
            .toMutableSet()
        keptRecords.addAll(nonterminal)
        if (newRecord != null) keptRecords.add(newRecord)
        val keptMarkers = records.entries.asSequence()
            .filter { it.key.endsWith(":gen") }
            .filter {
                val session = it.key.removeSuffix(":gen")
                session !in keptRecords && session !in records
            }
            // Epochs only increase, so stale markers rank below all current markers.
            .sortedWith(compareByDescending<Map.Entry<String, Any?>> {
                (it.value as? String)?.substringBefore(':')?.toLongOrNull() ?: Long.MIN_VALUE
            }.thenByDescending {
                (it.value as? String)?.substringAfter(':', "")?.toLongOrNull() ?: 0L
            }.thenByDescending {
                it.key.removeSuffix(":gen").toIntOrNull() ?: -1
            })
            .take(MAX_MARKER_ONLY_SESSIONS)
            .map { it.key }
            .toSet()
        for (key in records.keys) {
            val session = key.removeSuffix(":gen")
            if (session !in keptRecords && key !in keptMarkers && (key.endsWith(":gen") || key.toIntOrNull() != null)) {
                editor.remove(key)
            }
        }
    }

    fun record(context: Context, sessionId: Int, status: String, statusCode: Int, message: String) {
        val value = JSONObject().put("sessionId", sessionId).put("status", status)
            .put("statusCode", statusCode).put("message", truncateMessage(message)).put("at", System.currentTimeMillis())
            .toString()
        val saved = synchronized(commitLock) {
            openPinnedDir(context).use { dir ->
                val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                val sessionKey = sessionId.toString()
                val epoch = prefs.getLong(REVOCATION_EPOCH, 0L)
                val marker = prefs.getString("$sessionId:gen", null)
                val epochEligible = marker?.substringBefore(':')?.toLongOrNull() == epoch || (marker == null && epoch == 0L)
                val updateLast = epochEligible && (status == "success" || status == "failure")
                if (updateLast && !writeFenceChecked(prefs, dir, PoisonKind.TERMINAL, sessionId, epoch, resultDigest(value))) {
                    markFailedFenceWrite(dir)
                    return@synchronized false
                }
                val editor = prefs.edit().putString(sessionKey, value)
                prune(editor, prefs.all + (sessionKey to value), sessionKey)
                if (updateLast) editor.putString(LAST_RESULT, value).putLong(LAST_RESULT_EPOCH, epoch)
                val committed = editor.commit()
                prefsDurable = committed
                if (!committed) latchMirrorDivergence(prefs, dir)
                if (committed && updateLast) {
                    checkNotNull(dir)
                    val token = McpAutostartStore.read(context)?.token
                    if (token != null && writeLastResultMirror(context, dir, token, value)) {
                        resolvePublishedMirror(context, dir, token)
                    } else {
                        latchMirrorDivergence(prefs, dir)
                    }
                }
                committed
            }
        }
        if (!saved) Log.w("StageInstall", "could not persist installer status for session $sessionId")
    }
}

class StageInstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        if (sessionId < 0 || !intent.hasExtra(PackageInstaller.EXTRA_STATUS)) return
        val code = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        if (code == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            val previous = StageInstall.result(context, sessionId)["status"]
            if (previous == "success" || previous == "failure") return
            @Suppress("DEPRECATION")
            val confirmation = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
            StageInstall.requestConfirmation(context, sessionId, confirmation)
            return
        }
        StageInstall.clearConfirmation(sessionId)
        val status = if (code == PackageInstaller.STATUS_SUCCESS) "success" else "failure"
        StageInstall.record(context, sessionId, status, code, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty())
    }
}
