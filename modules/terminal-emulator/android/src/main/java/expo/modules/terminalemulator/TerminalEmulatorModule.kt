package expo.modules.terminalemulator

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TerminalEmulatorModule : Module() {

    private val sessions = mutableMapOf<String, ShellyTerminalSession>()

    private fun emitEvent(name: String, body: Map<String, Any?>) {
        sendEvent(name, body)
    }

    override fun definition() = ModuleDefinition {
        Name("TerminalEmulator")

        Events("onSessionOutput", "onSessionExit", "onTitleChanged", "onBell")

        AsyncFunction("createSession") { config: Map<String, Any?> ->
            val sessionId = config["sessionId"] as? String
                ?: throw IllegalArgumentException("sessionId is required")
            val cwd = config["cwd"] as? String ?: "/data/data/com.termux/files/home"
            val rows = (config["rows"] as? Number)?.toInt() ?: 24
            val cols = (config["cols"] as? Number)?.toInt() ?: 80
            val useTmux = config["useTmux"] as? Boolean ?: false
            val tmuxSessionName = config["tmuxSessionName"] as? String

            if (sessions.containsKey(sessionId)) {
                throw IllegalStateException("Session $sessionId already exists")
            }

            val shell = TermuxShellEnvironment()
            if (!shell.isAvailable()) {
                throw IllegalStateException("Shell not available at ${shell.shellPath}")
            }

            val session = ShellyTerminalSession(
                sessionId = sessionId,
                shell = shell,
                emitEvent = ::emitEvent,
                cwd = cwd,
                rows = rows,
                cols = cols,
                useTmux = useTmux,
                tmuxSessionName = tmuxSessionName
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
            // Convert keyCode to the appropriate character/escape sequence
            // For now, send as a single character if it's a printable code point
            if (keyCode in 32..126) {
                session.write(keyCode.toChar().toString())
            }
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

        AsyncFunction("getTranscriptText") { sessionId: String, maxLines: Int ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.getTranscriptText(maxLines)
        }

        AsyncFunction("getSessionTitle") { sessionId: String ->
            val session = sessions[sessionId]
                ?: throw IllegalArgumentException("Session $sessionId not found")
            session.getTitle()
        }
    }
}
