package expo.modules.terminalemulator

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TerminalEmulatorModule : Module() {

    companion object {
        /** Global session registry — TerminalViewModule reads from this to attach views */
        val sessionRegistry = mutableMapOf<String, ShellyTerminalSession>()
    }

    private val sessions get() = sessionRegistry

    private fun emitEvent(name: String, body: Map<String, Any?>) {
        sendEvent(name, body)
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
            sessionId
        }

        AsyncFunction("destroySession") { sessionId: String ->
            val session = sessions.remove(sessionId)
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.destroy()
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
    }
}
