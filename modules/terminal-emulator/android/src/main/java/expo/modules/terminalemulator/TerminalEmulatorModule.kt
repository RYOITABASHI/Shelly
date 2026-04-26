package expo.modules.terminalemulator

import android.content.Context
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TerminalEmulatorModule : Module() {

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

    private fun getAgentRequestCode(context: Context, agentId: String): Int {
        val prefs = context.getSharedPreferences("shelly_agent_ids", Context.MODE_PRIVATE)
        val existing = prefs.getInt(agentId, -1)
        if (existing >= 0) return existing
        val nextId = prefs.getInt("_next_id", 1000)
        prefs.edit().putInt(agentId, nextId).putInt("_next_id", nextId + 1).apply()
        return nextId
    }

    override fun definition() = ModuleDefinition {
        Name("TerminalEmulator")

        Events("onSessionOutput", "onSessionExit", "onTitleChanged", "onBell", "onResize")

        // Module (re-)instantiation: rewire emitEvent on any sessions that
        // outlived the previous Module instance. Without this, live sessions
        // from before an RN reload would keep calling a stale sendEvent that
        // no longer reaches JS, and the UI would appear to freeze.
        OnCreate {
            for (session in sessions.values) {
                session.emitEvent = ::emitEvent
            }
            Log.i("TerminalEmulator", "OnCreate: rewired ${sessions.size} surviving session(s)")
        }

        AsyncFunction("createSession") { config: Map<String, Any?> ->
            val sessionId = config["sessionId"] as? String
                ?: throw IllegalArgumentException("sessionId is required")
            val rows = (config["rows"] as? Number)?.toInt() ?: 24
            val cols = (config["cols"] as? Number)?.toInt() ?: 80

            // Case B reattach: live session already exists in the Service
            // registry. Rewire its emitEvent to this Module instance (harmless
            // no-op if already wired) and tell JS it was resumed so TerminalPane
            // can skip the Case C transcript replay.
            val existing = sessions[sessionId]
            if (existing != null) {
                existing.emitEvent = ::emitEvent
                if (existing.isAlive()) {
                    acquireWakeLock()
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

            val context = appContext.reactContext ?: throw IllegalStateException("No React context")

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
            val intent = Intent(context, TerminalSessionService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            null
        }

        AsyncFunction("stopSessionService") {
            val context = appContext.reactContext ?: return@AsyncFunction null
            context.stopService(Intent(context, TerminalSessionService::class.java))
            null
        }

        AsyncFunction("updateSessionNotification") { info: String ->
            val context = appContext.reactContext ?: return@AsyncFunction null
            val intent = Intent(context, TerminalSessionService::class.java).apply {
                action = TerminalSessionService.ACTION_UPDATE_NOTIFICATION
                putExtra("session_info", info)
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

        AsyncFunction("scheduleAgent") { agentId: String, intervalMs: Long, triggerAtMs: Long ->
            val context = appContext.reactContext ?: return@AsyncFunction null
            val requestCode = getAgentRequestCode(context, agentId)
            val am = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
            val intent = Intent(context, AgentAlarmReceiver::class.java).apply {
                putExtra("agent_id", agentId)
            }
            val pi = android.app.PendingIntent.getBroadcast(
                context, requestCode, intent,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
            )
            am.setRepeating(android.app.AlarmManager.RTC_WAKEUP, triggerAtMs, intervalMs, pi)
            Log.i("TerminalEmulator", "Scheduled agent $agentId (reqCode=$requestCode): interval=${intervalMs}ms")
            null
        }

        AsyncFunction("cancelAgent") { agentId: String ->
            val context = appContext.reactContext ?: return@AsyncFunction null
            val requestCode = getAgentRequestCode(context, agentId)
            val intent = Intent(context, AgentAlarmReceiver::class.java).apply {
                putExtra("agent_id", agentId)
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

            // Prepend PATH export so bundled tools (node, npm, git, etc.) are found
            val wrappedCommand = "export PATH='$libPath:$libPath/node_modules/npm/bin:$libPath/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin' && export LD_LIBRARY_PATH='$libPath' && export HOME='${homeDir.absolutePath}' && $command"

            Log.i("TerminalEmulator", "execCommand: bash=$bashPath lib=$libPath home=${homeDir.absolutePath}")
            Log.i("TerminalEmulator", "execCommand: bash exists=${java.io.File(bashPath).exists()} lib exists=${libDir.exists()} files=${libDir.list()?.size ?: 0}")

            val result = ShellyJNI.execSubprocess(
                "/system/bin/linker64",
                bashPath,
                libPath,
                homeDir.absolutePath,
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
            HomeInitializer.getHomeDir(context).absolutePath
        }
    }
}
