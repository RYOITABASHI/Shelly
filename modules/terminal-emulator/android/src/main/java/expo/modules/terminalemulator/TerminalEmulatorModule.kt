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
            val port = (config["port"] as? Number)?.toInt()
                ?: throw IllegalArgumentException("port is required")
            val rows = (config["rows"] as? Number)?.toInt() ?: 24
            val cols = (config["cols"] as? Number)?.toInt() ?: 80

            if (sessions.containsKey(sessionId)) {
                // Session already exists — return it instead of crashing.
                // This happens when the view is re-created during screen transitions
                // (e.g. split view) but the underlying session is still alive.
                return@AsyncFunction sessionId
            }

            val session = ShellyTerminalSession(
                sessionId = sessionId,
                emitEvent = ::emitEvent,
                port = port,
                rows = rows,
                cols = cols,
                appContext = appContext.reactContext ?: throw IllegalStateException("No React context")
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
    }
}
