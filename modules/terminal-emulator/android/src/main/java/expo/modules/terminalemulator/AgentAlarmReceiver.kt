package expo.modules.terminalemulator

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * BroadcastReceiver for scheduled agent execution.
 * Triggered by AlarmManager, starts Termux RunCommandService to run the agent script.
 */
class AgentAlarmReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "AgentAlarmReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val agentId = intent.getStringExtra("agent_id") ?: return
        Log.i(TAG, "Alarm triggered for agent: $agentId")

        try {
            val home = "/data/data/com.termux/files/home"
            val scriptPath = "$home/.shelly/agents/run-agent-$agentId.sh"

            val runIntent = Intent("com.termux.RUN_COMMAND").apply {
                setClassName("com.termux", "com.termux.app.RunCommandService")
                putExtra("com.termux.RUN_COMMAND_PATH", scriptPath)
                putExtra("com.termux.RUN_COMMAND_ARGUMENTS", emptyArray<String>())
                putExtra("com.termux.RUN_COMMAND_BACKGROUND", true)
            }
            context.startService(runIntent)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start agent $agentId", e)
        }
    }
}
