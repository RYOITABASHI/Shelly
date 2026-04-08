package expo.modules.terminalemulator

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TerminalEmulatorModule : Module() {

    companion object {
        /** Global session registry — TerminalViewModule reads from this to attach views */
        val sessionRegistry = mutableMapOf<String, ShellyTerminalSession>()
    }

    private val sessions get() = sessionRegistry

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

        AsyncFunction("createSession") { config: Map<String, Any?> ->
            val sessionId = config["sessionId"] as? String
                ?: throw IllegalArgumentException("sessionId is required")
            val rows = (config["rows"] as? Number)?.toInt() ?: 24
            val cols = (config["cols"] as? Number)?.toInt() ?: 80

            if (sessions.containsKey(sessionId)) {
                return@AsyncFunction sessionId
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
            sessionId
        }

        AsyncFunction("destroySession") { sessionId: String ->
            val session = sessions.remove(sessionId)
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.destroy()
            if (sessions.isEmpty()) releaseWakeLock()
        }

        AsyncFunction("writeToSession") { sessionId: String, data: String ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.write(data)
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

        AsyncFunction("startSessionService") {
            val context = appContext.reactContext ?: return@AsyncFunction null
            val serviceClass = Class.forName(
                context.packageName + ".TerminalSessionService"
            )
            val intent = Intent(context, serviceClass)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            null
        }

        AsyncFunction("stopSessionService") {
            val context = appContext.reactContext ?: return@AsyncFunction null
            val serviceClass = Class.forName(
                context.packageName + ".TerminalSessionService"
            )
            context.stopService(Intent(context, serviceClass))
            null
        }

        AsyncFunction("updateSessionNotification") { info: String ->
            val context = appContext.reactContext ?: return@AsyncFunction null
            val serviceClass = Class.forName(
                context.packageName + ".TerminalSessionService"
            )
            val intent = Intent(context, serviceClass).apply {
                action = "space.manus.shelly.terminal.UPDATE_NOTIFICATION"
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
                    pb.environment()["HOME"] = "/data/data/com.termux/files/home"
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
                        pb2.environment()["HOME"] = "/data/data/com.termux/files/home"
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
            val libDir = LibExtractor.getLibDir(context)
            val homeDir = HomeInitializer.getHomeDir(context)
            val bashPath = LibExtractor.getBashPath(context)
            val libPath = libDir.absolutePath

            // Prepend PATH export so bundled tools (node, npm, git, etc.) are found
            val wrappedCommand = "export PATH='$libPath:$libPath/node_modules/npm/bin:$libPath/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin' && export LD_LIBRARY_PATH='$libPath' && export HOME='${homeDir.absolutePath}' && $command"

            val result = ShellyJNI.execSubprocess(
                "/system/bin/linker64",
                bashPath,
                libPath,
                homeDir.absolutePath,
                wrappedCommand,
                timeout
            )

            mapOf(
                "exitCode" to result[0].toInt(),
                "stdout" to result[1],
                "stderr" to result[2]
            )
        }
    }
}
