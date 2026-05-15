package expo.modules.terminalemulator.scouter

import expo.modules.terminalemulator.TerminalSessionService

object ShellyStateBridge {
    fun snapshot(): ScouterEvent {
        val sessions = TerminalSessionService.sessionRegistry
        val active = sessions.values.firstOrNull { it.isAlive() }
        val sessionId = active?.sessionId ?: "shelly:idle"
        val status = when {
            sessions.isEmpty() -> ScouterStatus.IDLE
            active != null -> ScouterStatus.TOOL_RUNNING
            else -> ScouterStatus.COMPLETED
        }
        return ScouterEvent(
            source = ScouterSource.SHELLY,
            sourceVersion = "native",
            sessionId = sessionId,
            projectName = "Shelly",
            cwd = "Shelly",
            eventType = ScouterEventType.SNAPSHOT,
            derivedStatus = status,
            toolName = if (active != null) "PTY" else null,
            commandSummary = if (sessions.isEmpty()) "No active terminal session" else "${sessions.size} terminal session(s)"
        )
    }
}

