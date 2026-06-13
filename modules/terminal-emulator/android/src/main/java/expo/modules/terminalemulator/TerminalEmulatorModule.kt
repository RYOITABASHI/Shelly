package expo.modules.terminalemulator

import android.app.AlarmManager
import android.app.DownloadManager
import android.app.PendingIntent
import android.content.Context
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.terminalemulator.scouter.ScouterLifecycleService
import expo.modules.terminalemulator.scouter.ScouterStateStore
import expo.modules.terminalemulator.scouter.ScouterWidgetProvider
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.zip.ZipInputStream

class TerminalEmulatorModule : Module() {

    private data class ScouterPetImportCandidate(
        val id: String,
        val manifest: File,
        val spritesheet: File,
        val spritesheetName: String,
    )

    companion object {
        /**
         * Session registry — authoritative storage lives on
         * [TerminalSessionService.sessionRegistry] so sessions can outlive
         * Module re-instantiation. This accessor is kept as a backward-compat
         * alias for [expo.modules.terminalview.TerminalViewModule], which reads
         * the registry to attach native views.
         */
        val sessionRegistry get() = TerminalSessionService.sessionRegistry
    }

    private val sessions get() = TerminalSessionService.sessionRegistry

    private var wakeLock: PowerManager.WakeLock? = null
    private val wakeLockLock = Any()

    private fun acquireWakeLock() {
        synchronized(wakeLockLock) {
            if (wakeLock != null) return
            val context = appContext.reactContext ?: return
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "shelly:terminal").also {
                it.acquire()
            }
            Log.i("TerminalEmulator", "WakeLock acquired")
        }
    }

    private fun releaseWakeLock() {
        synchronized(wakeLockLock) {
            wakeLock?.let {
                if (it.isHeld) it.release()
                Log.i("TerminalEmulator", "WakeLock released")
            }
            wakeLock = null
        }
    }

    private fun emitEvent(name: String, body: Map<String, Any?>) {
        sendEvent(name, body)
    }

    private fun requireReactContext(): Context =
        appContext.reactContext ?: throw IllegalStateException("React context unavailable")

    private fun startTerminalSessionService(context: Context, info: String? = null) {
        val intent = Intent(context, TerminalSessionService::class.java).apply {
            if (info != null) {
                action = TerminalSessionService.ACTION_UPDATE_NOTIFICATION
                putExtra("session_info", info)
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }

    private fun validateDownloadPath(downloadSubdir: String, fileName: String): java.io.File {
        val subdirRe = Regex("^[A-Za-z0-9._-]+$")
        val apkNameRe = Regex("^[A-Za-z0-9._-]+\\.apk$", RegexOption.IGNORE_CASE)
        require(subdirRe.matches(downloadSubdir)) { "Invalid download directory: $downloadSubdir" }
        require(apkNameRe.matches(fileName)) { "Invalid APK file name: $fileName" }

        val downloadsRoot = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val target = java.io.File(java.io.File(downloadsRoot, downloadSubdir), fileName).canonicalFile
        val root = downloadsRoot.canonicalFile
        require(target.path == root.path || target.path.startsWith(root.path + java.io.File.separator)) {
            "Download path escapes Downloads directory"
        }
        return target
    }

    private fun isSafePetSegment(value: String): Boolean =
        Regex("^[A-Za-z0-9_-]{1,80}$").matches(value)

    private fun isSafePetFileName(value: String): Boolean =
        Regex("^[A-Za-z0-9._-]{1,120}$").matches(value)

    private fun openScouterPetZipInput(context: Context, uriString: String): InputStream {
        val uri = runCatching { Uri.parse(uriString) }.getOrNull()
        val scheme = uri?.scheme?.lowercase()
        return when {
            scheme == "content" || scheme == "android.resource" ->
                context.contentResolver.openInputStream(uri)
                    ?: throw IllegalArgumentException("Could not open pet ZIP: $uriString")
            scheme == "file" -> FileInputStream(File(uri.path ?: throw IllegalArgumentException("Invalid file URI")))
            scheme.isNullOrBlank() -> FileInputStream(File(uriString))
            else -> context.contentResolver.openInputStream(uri)
                ?: FileInputStream(File(uriString))
        }
    }

    private fun safeZipRelativePath(name: String): String? {
        val normalized = name.replace('\\', '/')
        require(!normalized.startsWith("/") && !Regex("^[A-Za-z]:").containsMatchIn(normalized)) {
            "Pet ZIP contains an absolute path"
        }
        val parts = normalized.split('/').filter { it.isNotBlank() }
        if (parts.isEmpty()) return null
        require(parts.none { it == "." || it == ".." }) {
            "Pet ZIP contains a path traversal entry"
        }
        require(parts.all { it.length <= 160 }) {
            "Pet ZIP entry name is too long"
        }
        return parts.joinToString(File.separator)
    }

    private fun extractScouterPetZip(context: Context, uriString: String, targetDir: File) {
        val root = targetDir.canonicalFile
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var entryCount = 0
        var totalBytes = 0L
        val maxEntryCount = 256
        val maxTotalBytes = 96L * 1024L * 1024L

        openScouterPetZipInput(context, uriString).use { raw ->
            ZipInputStream(raw.buffered()).use { zip ->
                while (true) {
                    val entry = zip.nextEntry ?: break
                    try {
                        entryCount += 1
                        require(entryCount <= maxEntryCount) { "Pet ZIP has too many entries" }
                        val relativePath = safeZipRelativePath(entry.name) ?: continue
                        if (entry.isDirectory) continue
                        val outFile = File(root, relativePath).canonicalFile
                        require(outFile.path == root.path || outFile.path.startsWith(root.path + File.separator)) {
                            "Pet ZIP entry escapes import directory"
                        }
                        outFile.parentFile?.mkdirs()
                        outFile.outputStream().use { output ->
                            while (true) {
                                val read = zip.read(buffer)
                                if (read < 0) break
                                totalBytes += read.toLong()
                                require(totalBytes <= maxTotalBytes) { "Pet ZIP is too large" }
                                output.write(buffer, 0, read)
                            }
                        }
                    } finally {
                        zip.closeEntry()
                    }
                }
            }
        }
    }

    private fun findScouterPetDirectories(root: File): List<File> {
        val found = mutableListOf<File>()

        fun walk(dir: File, depth: Int) {
            if (File(dir, "pet.json").isFile) {
                found.add(dir)
                return
            }
            if (depth >= 3) return
            dir.listFiles()
                ?.filter { it.isDirectory }
                ?.forEach { child -> walk(child, depth + 1) }
        }

        walk(root, 0)
        return found.distinctBy { it.canonicalPath }
    }

    private fun privateScouterPetRoot(context: Context): File {
        val filesRoot = context.filesDir.canonicalFile
        val expectedHome = File(filesRoot, "home").absoluteFile
        val home = HomeInitializer.getHomeDir(context).canonicalFile
        require(home.path == expectedHome.path && home.path.startsWith(filesRoot.path + File.separator)) {
            "Shelly private home must stay inside app files"
        }
        val root = File(home, ".codex/pets").absoluteFile
        val canonicalRoot = root.canonicalFile
        require(canonicalRoot.path == root.path && canonicalRoot.path.startsWith(home.path + File.separator)) {
            "Pet import directory must stay inside Shelly private home"
        }
        return root
    }

    private fun validateScouterPetDirectory(dir: File): ScouterPetImportCandidate {
        val manifest = File(dir, "pet.json").canonicalFile
        require(manifest.isFile && manifest.length() in 1..32768) {
            "Invalid pet manifest in ${dir.name}"
        }

        val json = JSONObject(manifest.readText(Charsets.UTF_8))
        val id = json.optString("id").trim()
        require(isSafePetSegment(id)) {
            "Invalid pet id: $id"
        }

        val spritesheetName = json.optString("spritesheetPath", "spritesheet.webp").trim()
            .ifBlank { "spritesheet.webp" }
        val lowerSpriteName = spritesheetName.lowercase()
        require(isSafePetFileName(spritesheetName) && (lowerSpriteName.endsWith(".webp") || lowerSpriteName.endsWith(".png"))) {
            "Invalid spritesheet path for $id"
        }

        val spritesheet = File(dir, spritesheetName).canonicalFile
        val petRoot = dir.canonicalFile
        require(spritesheet.path == petRoot.path || spritesheet.path.startsWith(petRoot.path + File.separator)) {
            "Spritesheet escapes pet directory for $id"
        }
        require(spritesheet.isFile && spritesheet.length() > 0) {
            "Missing spritesheet for $id"
        }

        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(spritesheet.absolutePath, bounds)
        require(bounds.outWidth >= 1536 && bounds.outHeight >= 1872) {
            "Spritesheet for $id is too small: ${bounds.outWidth}x${bounds.outHeight}"
        }

        return ScouterPetImportCandidate(
            id = id,
            manifest = manifest,
            spritesheet = spritesheet,
            spritesheetName = spritesheetName,
        )
    }

    private fun installScouterCodexPetZipFromUri(context: Context, uriString: String): Map<String, Any> {
        val importDir = File(context.cacheDir, "scouter-pet-import-${System.nanoTime()}").canonicalFile
        val targetRoot = privateScouterPetRoot(context)
        val installedIds = mutableListOf<String>()

        try {
            importDir.mkdirs()
            extractScouterPetZip(context, uriString, importDir)

            val candidates = findScouterPetDirectories(importDir)
                .map(::validateScouterPetDirectory)
            require(candidates.isNotEmpty()) {
                "No valid Codex pet found in ZIP"
            }
            val duplicateIds = candidates.groupBy { it.id }.filterValues { it.size > 1 }.keys
            require(duplicateIds.isEmpty()) {
                "Duplicate pet id in ZIP: ${duplicateIds.joinToString(", ")}"
            }

            require(targetRoot.isDirectory || targetRoot.mkdirs()) {
                "Could not create pet import directory"
            }
            val canonicalRoot = targetRoot.canonicalFile
            val expectedHome = File(context.filesDir.canonicalFile, "home").absoluteFile
            require(
                canonicalRoot.path == targetRoot.absolutePath &&
                    canonicalRoot.path.startsWith(expectedHome.path + File.separator)
            ) {
                "Pet import directory must stay inside Shelly private home"
            }
            for (candidate in candidates) {
                val staging = File(canonicalRoot, ".${candidate.id}.import-${System.nanoTime()}").canonicalFile
                require(staging.path.startsWith(canonicalRoot.path + File.separator)) {
                    "Import staging path escaped pet directory"
                }
                if (staging.exists()) staging.deleteRecursively()
                require(staging.mkdirs()) {
                    "Could not create pet import staging directory"
                }

                candidate.manifest.copyTo(File(staging, "pet.json"), overwrite = true)
                candidate.spritesheet.copyTo(File(staging, candidate.spritesheetName), overwrite = true)

                val target = File(canonicalRoot, candidate.id).absoluteFile
                val canonicalTarget = target.canonicalFile
                require(canonicalTarget.path == target.path && canonicalTarget.path.startsWith(canonicalRoot.path + File.separator)) {
                    "Pet target escaped pet directory"
                }
                val backup = File(canonicalRoot, ".${candidate.id}.backup-${System.nanoTime()}").canonicalFile
                require(backup.path.startsWith(canonicalRoot.path + File.separator)) {
                    "Pet backup path escaped pet directory"
                }
                var backupCreated = false
                try {
                    if (target.exists()) {
                        if (!target.renameTo(backup)) {
                            throw IllegalStateException("Could not move existing pet aside: ${candidate.id}")
                        }
                        backupCreated = true
                    }
                    if (!staging.renameTo(target)) {
                        val copied = staging.copyRecursively(target, overwrite = true)
                        staging.deleteRecursively()
                        if (!copied) {
                            throw IllegalStateException("Could not install pet: ${candidate.id}")
                        }
                    }
                    if (backupCreated) backup.deleteRecursively()
                } catch (error: Throwable) {
                    if (target.exists()) target.deleteRecursively()
                    if (backupCreated && backup.exists()) {
                        if (!backup.renameTo(target)) {
                            val restored = backup.copyRecursively(target, overwrite = true)
                            if (restored) {
                                backup.deleteRecursively()
                            } else {
                                Log.w("TerminalEmulator", "Could not restore previous pet after failed import: ${candidate.id}")
                            }
                        }
                    }
                    staging.deleteRecursively()
                    throw error
                }
                installedIds.add(candidate.id)
            }

            runCatching { ScouterLifecycleService.get(context).refreshJson() }
                .onFailure { Log.w("TerminalEmulator", "Scouter refresh after pet import failed", it) }
            ScouterWidgetProvider.updateAll(context, force = true)

            return mapOf(
                "installedCount" to installedIds.size,
                "installedIds" to installedIds,
                "targetRoot" to canonicalRoot.absolutePath,
            )
        } finally {
            importDir.deleteRecursively()
        }
    }

    private fun downloadStatusName(status: Int): String =
        when (status) {
            DownloadManager.STATUS_PENDING -> "pending"
            DownloadManager.STATUS_RUNNING -> "running"
            DownloadManager.STATUS_PAUSED -> "paused"
            DownloadManager.STATUS_SUCCESSFUL -> "successful"
            DownloadManager.STATUS_FAILED -> "failed"
            else -> "unknown"
        }

    private fun cursorLong(cursor: Cursor, column: String, fallback: Long = 0L): Long {
        val index = cursor.getColumnIndex(column)
        if (index < 0 || cursor.isNull(index)) return fallback
        return cursor.getLong(index)
    }

    private fun cursorString(cursor: Cursor, column: String): String? {
        val index = cursor.getColumnIndex(column)
        if (index < 0 || cursor.isNull(index)) return null
        return cursor.getString(index)
    }

    private fun sha256Hex(file: java.io.File): String {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        file.inputStream().use { input ->
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
    }

    private fun getAgentRequestCode(context: Context, agentId: String): Int {
        val prefs = context.getSharedPreferences("shelly_agent_ids", Context.MODE_PRIVATE)
        val existing = prefs.getInt(agentId, -1)
        if (existing >= 0) return existing
        val nextId = prefs.getInt("_next_id", 1000)
        prefs.edit().putInt(agentId, nextId).putInt("_next_id", nextId + 1).apply()
        return nextId
    }

    private fun scheduleAgentAlarm(
        alarmManager: AlarmManager,
        triggerAtMs: Long,
        pendingIntent: PendingIntent
    ) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms())
            ) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
            } else {
                alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
            }
        } catch (e: SecurityException) {
            Log.w("TerminalEmulator", "Exact alarm denied; falling back to inexact alarm", e)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
            } else {
                alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
            }
        }
    }

    override fun definition() = ModuleDefinition {
        Name("TerminalEmulator")

        Events("onSessionOutput", "onSessionExit", "onTitleChanged", "onBell", "onResize", "onScouterEvent")

        // Module (re-)instantiation: rewire emitEvent on any sessions that
        // outlived the previous Module instance. Without this, live sessions
        // from before an RN reload would keep calling a stale sendEvent that
        // no longer reaches JS, and the UI would appear to freeze.
        OnCreate {
            for (session in sessions.values) {
                session.emitEvent = ::emitEvent
            }
            appContext.reactContext?.let { context ->
                val scouter = ScouterLifecycleService.get(context)
                scouter.setEventSink { event, snapshot ->
                    emitEvent(
                        "onScouterEvent",
                        mapOf(
                            "eventJson" to event.toJson().toString(),
                            "snapshotJson" to snapshot.toJson().toString(),
                            "emittedAt" to System.currentTimeMillis(),
                        ),
                    )
                }
                runCatching { scouter.ensureStartedIfEnabled() }
                    .onFailure { Log.w("TerminalEmulator", "Scouter autostart skipped after startup failure", it) }
            }
            Log.i("TerminalEmulator", "OnCreate: rewired ${sessions.size} surviving session(s)")
        }

        AsyncFunction("createSession") { config: Map<String, Any?> ->
            val sessionId = config["sessionId"] as? String
                ?: throw IllegalArgumentException("sessionId is required")
            val rows = (config["rows"] as? Number)?.toInt() ?: 24
            val cols = (config["cols"] as? Number)?.toInt() ?: 80
            val context = appContext.reactContext ?: throw IllegalStateException("No React context")

            // Case B reattach: live session already exists in the Service
            // registry. Rewire its emitEvent to this Module instance (harmless
            // no-op if already wired) and tell JS it was resumed so TerminalPane
            // can skip the Case C transcript replay.
            val existing = sessions[sessionId]
            if (existing != null) {
                existing.emitEvent = ::emitEvent
                if (existing.isAlive()) {
                    acquireWakeLock()
                    startTerminalSessionService(context)
                    return@AsyncFunction mapOf(
                        "sessionId" to sessionId,
                        "resumed" to true
                    )
                } else {
                    // Stale entry — clean up and fall through to fresh fork.
                    Log.w("TerminalEmulator", "Session $sessionId in registry but dead — recreating")
                    try { existing.destroy() } catch (_: Exception) {}
                    sessions.remove(sessionId)
                }
            }

            // Extract bundled libs from APK & initialize home directory
            val libDir = LibExtractor.extractAll(context)
            val homeDir = HomeInitializer.initialize(context)

            // Create PTY via JNI forkpty + linker64
            val resultArray = IntArray(2)
            ShellyJNI.createSubprocess(
                "/system/bin/linker64",
                LibExtractor.getBashPath(context),
                libDir.absolutePath,
                homeDir.absolutePath,
                rows, cols,
                resultArray
            )
            val masterFd = resultArray[0]
            val childPid = resultArray[1]

            if (masterFd < 0) {
                throw RuntimeException("Failed to create PTY subprocess")
            }

            val session = ShellyTerminalSession(
                sessionId = sessionId,
                emitEvent = ::emitEvent,
                masterFd = masterFd,
                childPid = childPid,
                rows = rows,
                cols = cols,
                appContext = context
            )

            sessions[sessionId] = session
            startTerminalSessionService(context)
            acquireWakeLock()
            mapOf(
                "sessionId" to sessionId,
                "resumed" to false
            )
        }

        AsyncFunction("destroySession") { sessionId: String ->
            val session = sessions.remove(sessionId)
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.destroy()
            if (sessions.isEmpty()) {
                releaseWakeLock()
                // Stop foreground service when no sessions remain
                val context = appContext.reactContext
                if (context != null) {
                    context.stopService(Intent(context, TerminalSessionService::class.java))
                }
            }
        }

        AsyncFunction("writeToSession") { sessionId: String, data: String ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.write(data)
        }

        AsyncFunction("interruptSession") { sessionId: String ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.interrupt()
        }

        // bug #81: Paste path. Routes through TerminalEmulator.paste() so
        // the text is normalized and bracketed-paste wrapped, avoiding the
        // first-byte clip observed when CommandKeyBar was calling write()
        // directly with a multi-line clipboard payload.
        AsyncFunction("pasteToSession") { sessionId: String, text: String ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.paste(text)
        }

        AsyncFunction("pasteClipboardToSession") { sessionId: String ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                ?: throw IllegalStateException("Clipboard service unavailable")
            val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
            Log.d("ShellyPaste", "pasteClipboardToSession session=$sessionId len=${text.length}")
            if (text.isNotEmpty()) {
                session.paste(text)
            }
        }

        AsyncFunction("sendKeyEvent") { sessionId: String, keyCode: Int, modifiers: Int ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            if (keyCode in 32..126) session.write(keyCode.toChar().toString())
        }

        AsyncFunction("resizeSession") { sessionId: String, rows: Int, cols: Int ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.resize(rows, cols)
        }

        AsyncFunction("isSessionAlive") { sessionId: String ->
            val session = sessions[sessionId] ?: return@AsyncFunction false
            session.isAlive()
        }

        AsyncFunction("hasEmulator") { sessionId: String ->
            val session = sessions[sessionId] ?: return@AsyncFunction false
            session.hasEmulator()
        }

        AsyncFunction("getTranscriptText") { sessionId: String, maxLines: Int ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.getTranscriptText(maxLines)
        }

        AsyncFunction("getScreenText") { sessionId: String ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.getScreenText()
        }

        AsyncFunction("writeToEmulator") { sessionId: String, text: String ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.writeToEmulator(text)
        }

        AsyncFunction("getSessionTitle") { sessionId: String ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.getTitle()
        }

        // bug recovery (2026-04-27): user-triggered force recovery from
        // frozen state. The corrupted on-disk staging tree (chmod a-w
        // residue, partial cp clones, stale lockfile) survives Android
        // task-kill, so even closing+reopening Shelly doesn't help —
        // bashrc kicks the bg updater on every launch and immediately
        // re-hangs. This entry point cleans the persistent state so the
        // next launch can start fresh.
        //
        // Returns a map describing what was cleaned, suitable for
        // surfacing in the ConfigTUI "Recover" button's success Alert.
        AsyncFunction("forceRecoverFromFrozenState") {
            val context = appContext.reactContext
                ?: throw IllegalStateException("react context unavailable")
            val home = java.io.File(context.filesDir, "home")
            val cleaned = mutableListOf<String>()
            val errors = mutableListOf<String>()

            // Recursively chmod u+w then delete. The original chmod a-w
            // (now removed in v62+) left some files unwritable; even
            // after that fix, a partial cp -al from an older build
            // could have left hardlinks to the read-only originals.
            fun chmodWritableThenDelete(path: java.io.File) {
                if (!path.exists()) return
                try {
                    if (path.isDirectory) {
                        path.walkBottomUp().forEach { f ->
                            try { f.setWritable(true, false) } catch (_: Throwable) {}
                        }
                    } else {
                        try { path.setWritable(true, false) } catch (_: Throwable) {}
                    }
                    if (path.deleteRecursively()) {
                        cleaned.add(path.absolutePath)
                    } else {
                        errors.add("could not fully delete ${path.absolutePath}")
                    }
                } catch (e: Throwable) {
                    errors.add("${path.absolutePath}: ${e.message}")
                }
            }

            // Targets: corrupted staging trees, stale lockfile, partially
            // applied promote markers. The live tree (~/.shelly-cli) is
            // intentionally NOT touched — that's the user's working
            // install. The next launch's quick-check will refresh it
            // against upstream automatically.
            chmodWritableThenDelete(java.io.File(home, ".shelly-cli.staging"))
            chmodWritableThenDelete(java.io.File(home, ".shelly-cli/.update.lock"))
            chmodWritableThenDelete(java.io.File(home, ".shelly-runtime/.tmp"))
            // Clear .failed-versions so the post-recovery quick-check
            // can immediately retry the latest upstream versions instead
            // of waiting out the 1h cooldown that the failed install
            // run that froze us already poisoned.
            chmodWritableThenDelete(java.io.File(home, ".shelly-cli/.failed-versions"))
            chmodWritableThenDelete(java.io.File(home, ".shelly-runtime/.failed-versions"))

            // Reset update markers so the next launch tries fresh
            // instead of waiting for the cooldown to expire.
            for (marker in listOf(
                ".shelly_last_update",
                ".shelly-cli/.last_quick_check",
                ".shelly-runtime/.last_update",
                ".shelly-runtime/.last_quick_check",
            )) {
                val f = java.io.File(home, marker)
                if (f.exists()) {
                    try {
                        f.delete()
                        cleaned.add(f.absolutePath)
                    } catch (e: Throwable) {
                        errors.add("${f.absolutePath}: ${e.message}")
                    }
                }
            }

            Log.i("TerminalEmulator", "forceRecoverFromFrozenState: cleaned=${cleaned.size} errors=${errors.size}")
            mapOf(
                "ok" to errors.isEmpty(),
                "cleaned" to cleaned,
                "errors" to errors,
            )
        }

        AsyncFunction("startSessionService") {
            val context = appContext.reactContext ?: return@AsyncFunction null
            startTerminalSessionService(context)
            null
        }

        AsyncFunction("stopSessionService") {
            val context = appContext.reactContext ?: return@AsyncFunction null
            context.stopService(Intent(context, TerminalSessionService::class.java))
            null
        }

        AsyncFunction("updateSessionNotification") { info: String ->
            val context = appContext.reactContext ?: return@AsyncFunction null
            startTerminalSessionService(context, info)
            null
        }

        AsyncFunction("runAgent") { agentId: String ->
            val context = appContext.reactContext ?: return@AsyncFunction null
            val intent = Intent(context, TerminalSessionService::class.java).apply {
                action = TerminalSessionService.ACTION_RUN_AGENT
                putExtra(TerminalSessionService.EXTRA_AGENT_ID, agentId)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            null
        }

        AsyncFunction("isIgnoringBatteryOptimizations") {
            val context = appContext.reactContext ?: return@AsyncFunction false
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.isIgnoringBatteryOptimizations(context.packageName)
        }

        AsyncFunction("requestBatteryOptimizationExemption") {
            val context = appContext.reactContext ?: return@AsyncFunction null
            val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            if (!pm.isIgnoringBatteryOptimizations(context.packageName)) {
                val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            }
            null
        }

        // bug #92: MANAGE_EXTERNAL_STORAGE permission check + Settings launcher.
        // Android 11+ (API 30) gates /sdcard read/write behind Scoped Storage;
        // the only way for a terminal app to keep the "adb push a script to
        // /sdcard/Download, source it from the shell" workflow working is to
        // request the all-files-access special permission. Shelly is shipped
        // via GitHub Releases / F-Droid so the Play Store audit does not apply.
        AsyncFunction("hasAllFilesAccess") {
            val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Environment.isExternalStorageManager()
            } else {
                // On Android 10 and below legacy READ/WRITE_EXTERNAL_STORAGE
                // covers /sdcard read, so no special request is needed.
                true
            }
            Log.i(
                "TerminalEmulator",
                "hasAllFilesAccess: sdk=${Build.VERSION.SDK_INT} granted=$granted"
            )
            granted
        }

        AsyncFunction("requestAllFilesAccess") {
            val context = appContext.reactContext ?: return@AsyncFunction null
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
                Log.i("TerminalEmulator", "requestAllFilesAccess skipped: sdk < 30")
                return@AsyncFunction null
            }
            if (Environment.isExternalStorageManager()) {
                Log.i("TerminalEmulator", "requestAllFilesAccess skipped: already granted")
                return@AsyncFunction null
            }
            try {
                Log.i("TerminalEmulator", "requestAllFilesAccess: firing per-package settings intent")
                val intent = Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION).apply {
                    data = Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
            } catch (e: Exception) {
                // Fallback to the generic all-apps screen if the per-package
                // deep link isn't available on this OEM build.
                Log.w("TerminalEmulator", "per-package intent failed, trying generic", e)
                try {
                    val fallback = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(fallback)
                } catch (fallbackErr: Exception) {
                    Log.w("TerminalEmulator", "Cannot open all-files-access settings", fallbackErr)
                }
            }
            null
        }

        AsyncFunction("installApk") { apkPath: String ->
            val context = requireReactContext()
            try {
                val apk = java.io.File(apkPath).canonicalFile
                if (!apk.exists() || !apk.isFile) {
                    throw IllegalArgumentException("APK not found: $apkPath")
                }
                if (!apk.name.endsWith(".apk", ignoreCase = true)) {
                    throw IllegalArgumentException("Not an APK file: $apkPath")
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
                    val settingsIntent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES).apply {
                        data = Uri.parse("package:${context.packageName}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    context.startActivity(settingsIntent)
                    throw IllegalStateException("Allow Shelly to install unknown apps, then tap Install APK again.")
                }
                val uri = FileProvider.getUriForFile(
                    context,
                    "${context.packageName}.shelly.fileprovider",
                    apk,
                )
                val intent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(uri, "application/vnd.android.package-archive")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                context.startActivity(intent)
            } catch (e: Exception) {
                Log.e("TerminalEmulator", "installApk failed for $apkPath", e)
                throw e
            }
            null
        }

        AsyncFunction("enqueueApkDownload") { url: String, downloadSubdir: String, fileName: String ->
            val context = requireReactContext()
            val target = validateDownloadPath(downloadSubdir, fileName)
            target.parentFile?.mkdirs()
            if (target.exists() && !target.delete()) {
                throw IllegalStateException("Could not replace existing APK: ${target.absolutePath}")
            }

            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setTitle(fileName)
                setDescription("Shelly Android update")
                setMimeType("application/vnd.android.package-archive")
                setAllowedOverMetered(true)
                setAllowedOverRoaming(true)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
                setDestinationInExternalPublicDir(
                    Environment.DIRECTORY_DOWNLOADS,
                    "$downloadSubdir/$fileName",
                )
            }
            val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val downloadId = manager.enqueue(request)
            Log.i("TerminalEmulator", "enqueueApkDownload: id=$downloadId target=${target.absolutePath}")
            mapOf(
                "downloadId" to downloadId,
                "path" to target.absolutePath,
            )
        }

        AsyncFunction("getApkDownloadStatus") { downloadId: Long ->
            val context = requireReactContext()
            val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val query = DownloadManager.Query().setFilterById(downloadId)
            manager.query(query).use { cursor ->
                if (!cursor.moveToFirst()) {
                    return@AsyncFunction mapOf(
                        "downloadId" to downloadId,
                        "status" to "missing",
                        "reason" to 0L,
                        "downloadedBytes" to 0L,
                        "totalBytes" to -1L,
                        "localUri" to null,
                    )
                }
                val status = cursorLong(cursor, DownloadManager.COLUMN_STATUS).toInt()
                mapOf(
                    "downloadId" to downloadId,
                    "status" to downloadStatusName(status),
                    "reason" to cursorLong(cursor, DownloadManager.COLUMN_REASON),
                    "downloadedBytes" to cursorLong(cursor, DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR),
                    "totalBytes" to cursorLong(cursor, DownloadManager.COLUMN_TOTAL_SIZE_BYTES, -1L),
                    "localUri" to cursorString(cursor, DownloadManager.COLUMN_LOCAL_URI),
                )
            }
        }

        AsyncFunction("verifyApkFile") { apkPath: String, expectedSha256: String, expectedSizeBytes: Long ->
            val apk = java.io.File(apkPath)
            if (!apk.exists() || !apk.isFile) {
                return@AsyncFunction mapOf(
                    "ok" to false,
                    "actualSha256" to "",
                    "bytes" to 0L,
                    "error" to "APK not found: $apkPath",
                )
            }
            if (!apk.name.endsWith(".apk", ignoreCase = true)) {
                return@AsyncFunction mapOf(
                    "ok" to false,
                    "actualSha256" to "",
                    "bytes" to apk.length(),
                    "error" to "Not an APK file: $apkPath",
                )
            }
            val bytes = apk.length()
            if (expectedSizeBytes > 0 && bytes != expectedSizeBytes) {
                return@AsyncFunction mapOf(
                    "ok" to false,
                    "actualSha256" to "",
                    "bytes" to bytes,
                    "error" to "size mismatch: expected $expectedSizeBytes, got $bytes",
                )
            }
            val actualSha256 = sha256Hex(apk)
            mapOf(
                "ok" to actualSha256.equals(expectedSha256, ignoreCase = true),
                "actualSha256" to actualSha256,
                "bytes" to bytes,
                "error" to if (actualSha256.equals(expectedSha256, ignoreCase = true)) null else "sha256 mismatch",
            )
        }

        AsyncFunction("removeApkDownload") { downloadId: Long ->
            val context = requireReactContext()
            val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            manager.remove(downloadId)
            null
        }

        AsyncFunction("getAppVersionInfo") {
            val context = requireReactContext()
            val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.PackageInfoFlags.of(0),
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            val versionCode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                packageInfo.longVersionCode
            } else {
                @Suppress("DEPRECATION")
                packageInfo.versionCode.toLong()
            }
            mapOf(
                "packageName" to context.packageName,
                "versionName" to (packageInfo.versionName ?: ""),
                "versionCode" to versionCode,
            )
        }

        AsyncFunction("setScouterEnabled") { enabled: Boolean ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            val scouter = ScouterLifecycleService.get(context)
            runCatching {
                if (enabled) scouter.start() else scouter.stop()
            }.onFailure { error ->
                Log.w("TerminalEmulator", "setScouterEnabled($enabled) failed", error)
                if (enabled) {
                    runCatching { scouter.stop() }
                        .onFailure { Log.w("TerminalEmulator", "Failed to clean up Scouter after enable failure", it) }
                }
                throw IllegalStateException("Scouter failed to ${if (enabled) "start" else "stop"}", error)
            }
            null
        }

        AsyncFunction("getScouterDebugInfo") {
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterLifecycleService.get(context).debugJson().toString(2)
        }

        AsyncFunction("refreshScouter") {
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterLifecycleService.get(context).refreshJson().toString(2)
        }

        AsyncFunction("installScouterCodexPetZip") { uriString: String ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            installScouterCodexPetZipFromUri(context, uriString)
        }

        AsyncFunction("getScouterHookTemplate") { source: String ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterLifecycleService.get(context).hookTemplate(source).toString(2)
        }

        AsyncFunction("setScouterCodexBinding") { binding: Map<String, Any?> ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).setWidgetCodexBinding(
                codexSessionId = binding["codexSessionId"] as? String,
                ptySessionId = binding["ptySessionId"] as? String,
                shellySessionId = binding["shellySessionId"] as? String,
                cwd = binding["cwd"] as? String,
            )
            null
        }

        AsyncFunction("consumeScouterWidgetPendingPrompt") {
            codexSessionId: String?,
            ptySessionId: String?,
            shellySessionId: String? ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).consumeWidgetPromptPending(
                codexSessionId,
                ptySessionId,
                shellySessionId
            )?.let { pending ->
                mapOf(
                    "prompt" to pending.prompt,
                    "queuedAt" to pending.queuedAt,
                    "codexSessionId" to pending.codexSessionId,
                    "ptySessionId" to pending.ptySessionId,
                    "shellySessionId" to pending.shellySessionId,
                )
            }
        }

        AsyncFunction("getScouterWidgetPendingPromptTarget") {
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).widgetPendingPromptTarget()?.let { target ->
                mapOf(
                    "queuedAt" to target.queuedAt,
                    "codexSessionId" to target.codexSessionId,
                    "ptySessionId" to target.ptySessionId,
                    "shellySessionId" to target.shellySessionId,
                )
            }
        }

        AsyncFunction("consumeScouterWidgetPendingApproval") {
            codexSessionId: String?,
            ptySessionId: String?,
            shellySessionId: String? ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).consumeWidgetApprovalPending(
                codexSessionId,
                ptySessionId,
                shellySessionId
            )?.let { pending ->
                mapOf(
                    "decision" to pending.decision,
                    "queuedAt" to pending.queuedAt,
                    "approvalAt" to pending.approvalAt,
                    "approvalText" to pending.approvalText,
                    "codexSessionId" to pending.codexSessionId,
                    "ptySessionId" to pending.ptySessionId,
                    "shellySessionId" to pending.shellySessionId,
                )
            }
        }

        AsyncFunction("getScouterWidgetPendingApprovalTarget") {
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).widgetPendingApprovalTarget()?.let { target ->
                mapOf(
                    "queuedAt" to target.queuedAt,
                    "codexSessionId" to target.codexSessionId,
                    "ptySessionId" to target.ptySessionId,
                    "shellySessionId" to target.shellySessionId,
                )
            }
        }

        AsyncFunction("markScouterWidgetPromptQueued") { prompt: String ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).recordWidgetPromptQueued(prompt)
            null
        }

        AsyncFunction("markScouterWidgetApprovalDecision") { decision: String ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).recordWidgetApprovalDecision(decision)
            null
        }

        AsyncFunction("markScouterWidgetApprovalFailed") { message: String ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).recordWidgetApprovalFailed(message)
            null
        }

        AsyncFunction("markScouterWidgetApprovalResolved") {
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).recordWidgetApprovalResolved()
            null
        }

        AsyncFunction("markScouterWidgetPromptFailed") { message: String ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).recordWidgetPromptFailed(message)
            null
        }

        AsyncFunction("markScouterWidgetChoicePending") { message: String ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).recordWidgetChoicePending(message)
            ScouterWidgetProvider.updateAll(context, force = true)
            null
        }

        AsyncFunction("clearScouterWidgetConversationForPrivacy") {
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            ScouterStateStore(context).clearWidgetConversationForPrivacy()
            ScouterWidgetProvider.updateAll(context, force = true)
            null
        }

        AsyncFunction("returnToHome") {
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            val intent = Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            null
        }

        // Phase 0: execve verification test
        AsyncFunction("testExecve") {
            val context = appContext.reactContext ?: return@AsyncFunction mapOf("success" to false, "error" to "no context")
            val result = StringBuilder()
            try {
                // === Diagnostics ===
                result.append("== Environment ==\n")
                result.append("sdk=${android.os.Build.VERSION.SDK_INT}\n")
                result.append("abi=${android.os.Build.SUPPORTED_ABIS.joinToString(",")}\n")
                result.append("packageName=${context.packageName}\n")
                result.append("filesDir=${context.filesDir}\n")
                result.append("dataDir=${context.applicationInfo.dataDir}\n")

                // SELinux context of this process
                try {
                    val seProc = Runtime.getRuntime().exec(arrayOf("cat", "/proc/self/attr/current"))
                    val seContext = seProc.inputStream.bufferedReader().readText().trim()
                    seProc.waitFor()
                    result.append("selinux_context=$seContext\n")
                } catch (_: Exception) {
                    result.append("selinux_context=unknown\n")
                }

                // APK contents check
                val apkPath = context.applicationInfo.sourceDir
                result.append("apkPath=$apkPath\n")
                val zipFile = java.util.zip.ZipFile(apkPath)
                val soEntries = zipFile.entries().asSequence()
                    .filter { it.name.contains("libbash") }
                    .map { "${it.name} (${it.size}b, compressed=${it.compressedSize}b, method=${it.method})" }
                    .toList()
                result.append("apk_libbash_entries=${soEntries.joinToString("; ").ifEmpty { "NONE" }}\n")

                // Step 1: Try nativeLibraryDir first
                val nativeLibDir = context.applicationInfo.nativeLibraryDir
                var bashPath = "$nativeLibDir/libbash.so"
                var file = java.io.File(bashPath)
                result.append("\n== nativeLibDir ==\n")
                result.append("nativeLibDir=$nativeLibDir\n")
                result.append("exists_in_nativeLib=${file.exists()}\n")
                // List what IS in nativeLibDir
                val nativeLibFiles = java.io.File(nativeLibDir).listFiles()?.map { it.name } ?: emptyList()
                result.append("nativeLib_contents=(${nativeLibFiles.size} files) ${nativeLibFiles.take(10).joinToString(", ")}\n")

                // Step 2: If not extracted, extract from APK ourselves
                result.append("\n== Extraction ==\n")
                val libDir = java.io.File(context.filesDir, "termux-libs")
                libDir.mkdirs()

                // Map of APK entry name -> extracted file name
                val libs = mapOf(
                    "lib/arm64-v8a/libbash.so" to "libbash.so",
                    "lib/arm64-v8a/libandroid-support.so" to "libandroid-support.so",
                    "lib/arm64-v8a/libiconv.so" to "libiconv.so",
                    "lib/arm64-v8a/libreadline8.so" to "libreadline.so.8",
                    "lib/arm64-v8a/libncursesw6.so" to "libncursesw.so.6"
                )

                for ((apkEntry, fileName) in libs) {
                    val outFile = java.io.File(libDir, fileName)
                    if (!outFile.exists() || outFile.length() == 0L) {
                        val entry = zipFile.getEntry(apkEntry)
                        if (entry != null) {
                            zipFile.getInputStream(entry).use { input ->
                                outFile.outputStream().use { output ->
                                    input.copyTo(output)
                                }
                            }
                            outFile.setExecutable(true, false)
                            result.append("extracted $fileName (${outFile.length()}b)\n")
                        } else {
                            result.append("NOT FOUND in APK: $apkEntry\n")
                        }
                    } else {
                        result.append("exists $fileName (${outFile.length()}b)\n")
                    }
                }
                zipFile.close()

                val extractedBash = java.io.File(libDir, "libbash.so")
                if (!file.exists()) {
                    bashPath = extractedBash.absolutePath
                    file = extractedBash
                }
                val libDirPath = libDir.absolutePath
                result.append("libDir=$libDirPath\n")
                result.append("libDir_contents=${libDir.listFiles()?.map { it.name }}\n")

                result.append("\n== Exec ==\n")
                result.append("bashPath=$bashPath\n")
                result.append("exists=${file.exists()}\n")
                result.append("canExecute=${file.canExecute()}\n")
                result.append("canRead=${file.canRead()}\n")
                result.append("size=${file.length()}\n")

                // Check file type via `file` command
                try {
                    val fileProc = Runtime.getRuntime().exec(arrayOf("file", bashPath))
                    val fileOut = fileProc.inputStream.bufferedReader().readText().trim()
                    fileProc.waitFor()
                    result.append("file_type=$fileOut\n")
                } catch (_: Exception) {
                    result.append("file_type=unknown\n")
                }

                // Step 3: Try direct execve
                result.append("\n== Direct Exec ==\n")
                var execSuccess = false
                try {
                    val pb = ProcessBuilder(bashPath, "-c", "echo EXECVE_OK; uname -a")
                    pb.environment()["HOME"] = HomeInitializer.getHomeDir(context).absolutePath
                    pb.environment()["TERM"] = "xterm-256color"
                    pb.environment()["PATH"] = "/system/bin:/vendor/bin"
                    pb.directory(context.filesDir)
                    pb.redirectErrorStream(true)
                    val proc = pb.start()
                    val output = proc.inputStream.bufferedReader().readText()
                    val exitCode = proc.waitFor()
                    result.append("direct_output=$output\n")
                    result.append("direct_exitCode=$exitCode\n")
                    execSuccess = exitCode == 0 && output.contains("EXECVE_OK")
                } catch (e: Exception) {
                    result.append("direct_error=${e.javaClass.simpleName}: ${e.message}\n")
                }

                // Step 4: If direct exec failed, try linker64 trick
                if (!execSuccess) {
                    result.append("\n== Linker64 Trick ==\n")
                    try {
                        val linker = "/system/bin/linker64"
                        result.append("linker_exists=${java.io.File(linker).exists()}\n")
                        result.append("LD_LIBRARY_PATH=$libDirPath\n")
                        val pb2 = ProcessBuilder(linker, bashPath, "-c", "echo EXECVE_OK; uname -a")
                        pb2.environment()["HOME"] = HomeInitializer.getHomeDir(context).absolutePath
                        pb2.environment()["TERM"] = "xterm-256color"
                        pb2.environment()["PATH"] = "/system/bin:/vendor/bin"
                        pb2.environment()["LD_LIBRARY_PATH"] = libDirPath
                        pb2.directory(context.filesDir)
                        pb2.redirectErrorStream(true)
                        val proc2 = pb2.start()
                        val output2 = proc2.inputStream.bufferedReader().readText()
                        val exitCode2 = proc2.waitFor()
                        result.append("linker64_output=$output2\n")
                        result.append("linker64_exitCode=$exitCode2\n")
                        execSuccess = exitCode2 == 0 && output2.contains("EXECVE_OK")
                    } catch (e: Exception) {
                        result.append("linker64_error=${e.javaClass.simpleName}: ${e.message}\n")
                    }
                }

                mapOf("success" to execSuccess, "result" to result.toString())
            } catch (e: Exception) {
                result.append("error=${e.javaClass.simpleName}: ${e.message}\n")
                mapOf("success" to false, "result" to result.toString())
            }
        }

        AsyncFunction("scheduleAgent") { agentId: String, intervalMs: Long, triggerAtMs: Long, cron: String? ->
            val context = appContext.reactContext ?: return@AsyncFunction null
            val requestCode = getAgentRequestCode(context, agentId)
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val intent = Intent(context, AgentAlarmReceiver::class.java).apply {
                putExtra(AgentAlarmReceiver.EXTRA_AGENT_ID, agentId)
                putExtra(AgentAlarmReceiver.EXTRA_INTERVAL_MS, intervalMs)
                if (!cron.isNullOrBlank()) putExtra(AgentAlarmReceiver.EXTRA_CRON, cron)
            }
            val pi = PendingIntent.getBroadcast(
                context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            scheduleAgentAlarm(am, triggerAtMs, pi)
            Log.i("TerminalEmulator", "Scheduled agent $agentId (reqCode=$requestCode): interval=${intervalMs}ms")
            null
        }

        AsyncFunction("cancelAgent") { agentId: String ->
            val context = appContext.reactContext ?: return@AsyncFunction null
            val requestCode = getAgentRequestCode(context, agentId)
            val intent = Intent(context, AgentAlarmReceiver::class.java).apply {
                putExtra(AgentAlarmReceiver.EXTRA_AGENT_ID, agentId)
            }
            val pi = android.app.PendingIntent.getBroadcast(
                context, requestCode, intent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
            )
            val am = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
            am.cancel(pi)
            Log.i("TerminalEmulator", "Cancelled agent $agentId")
            null
        }

        // ── Non-interactive command execution (replaces Termux bridge) ───────

        AsyncFunction("execCommand") { command: String, timeoutMs: Int? ->
            val context = appContext.reactContext
                ?: throw IllegalStateException("No React context")
            val timeout = timeoutMs ?: 120_000
            // Ensure bundled tools are extracted (may not have happened yet if no PTY session created)
            val libDir = LibExtractor.extractAll(context)
            val homeDir = HomeInitializer.getHomeDir(context)
            val bashPath = LibExtractor.getBashPath(context)
            val libPath = libDir.absolutePath
            val homePath = homeDir.absolutePath
            val sslDir = "$homePath/.shelly-ssl"
            val caBundle = "$sslDir/ca-certificates.crt"
            val opensslConf = "$sslDir/openssl.cnf"
            try {
                val sslDirFile = java.io.File(sslDir)
                sslDirFile.mkdirs()
                val caBundleFile = java.io.File(caBundle)
                if (!caBundleFile.exists() || caBundleFile.length() == 0L) {
                    context.assets.open("ca-certificates.crt").use { input ->
                        caBundleFile.outputStream().use { output -> input.copyTo(output) }
                    }
                }
                val opensslConfFile = java.io.File(opensslConf)
                if (!opensslConfFile.exists()) opensslConfFile.writeText("")
            } catch (e: Exception) {
                Log.w("TerminalEmulator", "execCommand TLS env seed failed: ${e.message}")
            }

            // Non-interactive Settings commands do not source ~/.bashrc, so mirror
            // the TLS environment that HomeInitializer writes for bundled tools.
            val wrappedCommand =
                "export PATH='$libPath:$libPath/node_modules/npm/bin:$libPath/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin' && " +
                "export LD_LIBRARY_PATH='$libPath' && " +
                "export HOME='$homePath' && " +
                "export SSL_CERT_FILE='$caBundle' && " +
                "export SSL_CERT_DIR='$sslDir' && " +
                "export CURL_CA_BUNDLE='$caBundle' && " +
                "export NODE_EXTRA_CA_CERTS='$caBundle' && " +
                "export GIT_SSL_CAINFO='$caBundle' && " +
                "export REQUESTS_CA_BUNDLE='$caBundle' && " +
                "export OPENSSL_CONF='$opensslConf' && " +
                "$command"

            Log.i("TerminalEmulator", "execCommand: bash=$bashPath lib=$libPath home=$homePath")
            Log.i("TerminalEmulator", "execCommand: bash exists=${java.io.File(bashPath).exists()} lib exists=${libDir.exists()} files=${libDir.list()?.size ?: 0}")

            val result = ShellyJNI.execSubprocess(
                "/system/bin/linker64",
                bashPath,
                libPath,
                homePath,
                wrappedCommand,
                timeout
            )

            val exitCode = result[0].toInt()
            val stderr = result[2]
            if (exitCode != 0) {
                Log.e("TerminalEmulator", "execCommand FAILED: exit=$exitCode stderr=$stderr cmd=${command.take(80)}")
            }

            mapOf(
                "exitCode" to exitCode,
                "stdout" to result[1],
                "stderr" to stderr
            )
        }

        // Bug #36: read /proc/net/tcp{,6} (or any small procfs file) directly
        // via in-process fopen. Bypasses bash/LD_PRELOAD which exits=1 on some
        // devices due to PATH/SELinux/LD_LIBRARY_PATH interactions.
        AsyncFunction("readProcNetFile") { path: String ->
            ShellyJNI.readProcNetFile(path)
        }

        // Bug #70: list a directory directly via opendir/readdir/lstat,
        // bypassing bash/LD_PRELOAD which returns exit=0 stdout=0chars
        // on some devices (same root cause as bug #36). Used by FileTree /
        // Sidebar / FilesTab to populate the FILE TREE reliably.
        AsyncFunction("readDir") { path: String ->
            ShellyJNI.readDir(path)
        }

        // Bug #99: NETLINK_SOCK_DIAG enumeration of the app's own TCP
        // listen sockets. Primary replacement for readProcNetFile on
        // Android 10+ where SELinux denies /proc/net/tcp{,6} reads from
        // untrusted_app. Family arg is 4 or 6.
        AsyncFunction("queryListenSockets") { family: Int ->
            ShellyJNI.queryListenSockets(family)
        }

        // bug #73: expose the real Plan B HOME so JS-side path normalization
        // never has to hardcode /data/data/<pkg>/files/home or /data/user/0/...
        // The native side (HomeInitializer / shelly-exec.c) is the single
        // source of truth; everything else asks at runtime.
        AsyncFunction("getHomeDir") {
            val context = appContext.reactContext
                ?: throw IllegalStateException("React context unavailable")
            HomeInitializer.initialize(context).absolutePath
        }
    }
}
