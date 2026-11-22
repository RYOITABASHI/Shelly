package expo.modules.terminalemulator

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.os.Environment
import android.system.Os
import android.system.OsConstants
import android.util.Log
import android.view.View
import java.io.File
import java.io.FileInputStream
import java.io.OutputStream
import java.security.MessageDigest
import org.json.JSONObject

internal object StageInstall {
    private const val PREFS = "stage-install-results"

    // Receiver and activity lifecycle callbacks use the main thread. Android
    // can block launches from the background, so hold the intent until resume.
    private val confirmations = linkedMapOf<Int, Intent>()

    fun requestConfirmation(sessionId: Int, confirmation: Intent) {
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
    private var generation = 0.0

    fun currentGeneration(): Double = synchronized(commitLock) { generation }

    fun invalidate() {
        synchronized(commitLock) { generation += 1 }
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
            val cleared = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(id.toString()).commit()
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
                        throw StageError("revoked", "cancelled: the MCP token was regenerated")
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
        val status = record.getString("status")
        val result = mutableMapOf<String, Any>("status" to status, "at" to record.getLong("at"))
        if (status == "failure") {
            result["statusCode"] = record.getInt("statusCode")
            result["message"] = record.getString("message")
        }
        return result
    }

    fun record(context: Context, sessionId: Int, status: String, statusCode: Int, message: String) {
        val value = JSONObject().put("sessionId", sessionId).put("status", status)
            .put("statusCode", statusCode).put("message", message).put("at", System.currentTimeMillis())
        val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(sessionId.toString(), value.toString()).commit()
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
            StageInstall.requestConfirmation(sessionId, confirmation)
            return
        }
        StageInstall.clearConfirmation(sessionId)
        val status = if (code == PackageInstaller.STATUS_SUCCESS) "success" else "failure"
        StageInstall.record(context, sessionId, status, code, intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE).orEmpty())
    }
}
