package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import expo.modules.terminalemulator.scouter.AgentEscalationBridge
import expo.modules.terminalemulator.scouter.AgentActionApprovalBridge
import expo.modules.terminalemulator.scouter.NotificationDispatcher
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

data class AgentRunResult(
    val agentId: String,
    val exitCode: Int,
    val stdout: String,
    val stderr: String
) {
    val success: Boolean get() = exitCode == 0
}

/**
 * Executes scheduled agent scripts with Shelly's bundled Plan B runtime.
 *
 * This replaces the old Termux RUN_COMMAND bridge for background agents. The
 * script is sourced from Shelly bash because direct shebang execution from
 * app-private storage is blocked on modern Android target SDKs.
 */
object AgentRuntime {
    private const val TAG = "AgentRuntime"
    private const val DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
    private const val CURRENT_SCRIPT_VERSION = 10
    private const val CURRENT_PLAN_SPEC_VERSION = 1
    private val PLAN_EXECUTOR_ACTIONS = setOf("draft", "notify", "webhook", "cli", "dm-reply", "__suppressed__")

    private data class TrustedPlanLaunch(
        val actionType: String,
        val toolType: String
    )

    fun runAgent(
        context: Context,
        agentId: String,
        tainted: Boolean = false,
        unattended: Boolean = false
    ): AgentRunResult {
        val appContext = context.applicationContext
        HomeInitializer.initialize(appContext)
        val homeDir = HomeInitializer.getHomeDir(appContext)
        val libDir = try {
            LibExtractor.extractAll(appContext)
        } catch (e: Exception) {
            val message = "runtime extraction failed before script: ${e.javaClass.simpleName}: ${e.message}"
            Log.e(TAG, message, e)
            writeReceiverLog(homeDir, agentId, "error", message)
            return AgentRunResult(agentId, 125, "", message)
        }
        val bashPath = LibExtractor.getBashPath(appContext)

        if (shouldRunPlanExecutor(homeDir, agentId)) {
            return runPlanAgent(appContext, homeDir, libDir, bashPath, agentId, unattended)
        }

        val scriptPath = File(homeDir, ".shelly/agents/run-agent-$agentId.sh").absolutePath
        val script = File(scriptPath)

        if (!script.exists()) {
            val message = "missing script: $scriptPath"
            Log.e(TAG, message)
            writeReceiverLog(homeDir, agentId, "error", message)
            return AgentRunResult(agentId, 127, "", message)
        }
        val scriptVersion = readScriptVersion(script)
        if (scriptVersion < CURRENT_SCRIPT_VERSION) {
            val message = "stale script: $scriptPath version=$scriptVersion expected=$CURRENT_SCRIPT_VERSION. Open Shelly or run the agent manually once to regenerate it."
            Log.e(TAG, message)
            writeReceiverLog(homeDir, agentId, "error", message)
            NotificationDispatcher(appContext).notifyAgentResult(
                agentId = agentId,
                status = "error",
                preview = message
            )
            return AgentRunResult(agentId, 126, "", message)
        }

        val libPath = libDir.absolutePath
        val escalationPublicKeySha256 = AgentEscalationBridge.verifierPublicKeySha256(appContext)
        Log.i(
            TAG,
            "Agent $agentId starting via Shelly runtime script=$scriptPath version=$scriptVersion pinInjected=${escalationPublicKeySha256.isNotBlank()}"
        )
        val command = buildString {
            append("export PATH=")
            append(shellQuote("$libPath:$libPath/node_modules/npm/bin:$libPath/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin"))
            append(" && export LD_LIBRARY_PATH=")
            append(shellQuote(libPath))
            append(" && export HOME=")
            append(shellQuote(homeDir.absolutePath))
            append(" && export SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256=")
            append(shellQuote(escalationPublicKeySha256))
            append(" && readonly SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256")
            if (tainted) {
                append(" && export SHELLY_CAP_TAINTED=1")
            }
            if (unattended) {
                // Per-run signal (this specific invocation was fired by a cron/interval
                // alarm, not a manual "Once" run or a Review-approved fire) -- distinct
                // from AGENT_AUTONOMOUS, which is a persisted per-agent authoring setting
                // baked into the generated script. The legacy .sh path previously had no
                // way to structurally reject an action type (e.g. intent) for THIS run
                // being unattended if the agent's persisted autonomous flag happened to
                // be off, unlike the PlanSpec executor's --unattended flag.
                append(" && export SHELLY_RUN_UNATTENDED=1")
            }
            append(" && { [ -f \"\$HOME/.bashrc\" ] && . \"\$HOME/.bashrc\" || true; }")
            append(" && . ")
            append(shellQuote(scriptPath))
        }

        val actionApprovalNotifierStop = AtomicBoolean(false)
        val actionApprovalNotifier = startActionApprovalNotifier(appContext, actionApprovalNotifierStop)
        val result = try {
            ShellyJNI.execSubprocess(
                "/system/bin/linker64",
                bashPath,
                libPath,
                homeDir.absolutePath,
                command,
                DEFAULT_TIMEOUT_MS
            )
        } finally {
            actionApprovalNotifierStop.set(true)
            runCatching { actionApprovalNotifier.join(1000) }
        }

        val exitCode = result.getOrNull(0)?.toIntOrNull() ?: 1
        val stdout = result.getOrNull(1).orEmpty()
        val stderr = result.getOrNull(2).orEmpty()
        val notificationPosted = postAgentResultNotificationIfRequested(appContext, homeDir, agentId)
        if (exitCode == 0) {
            Log.i(TAG, "Agent $agentId completed via Shelly runtime")
        } else {
            Log.e(TAG, "Agent $agentId failed via Shelly runtime: exit=$exitCode stderr=${stderr.take(300)}")
            if (!notificationPosted) {
                NotificationDispatcher(appContext).notifyAgentResult(
                    agentId = agentId,
                    status = "error",
                    preview = "Agent script failed. exit=$exitCode stderr=${stderr.take(300)}"
                )
            }
            writeReceiverLog(
                homeDir,
                agentId,
                "error",
                "exit=$exitCode stderr=${stderr.take(500)} stdout=${stdout.take(500)}"
            )
        }

        return AgentRunResult(agentId, exitCode, stdout, stderr)
    }

    private fun runPlanAgent(
        context: Context,
        homeDir: File,
        libDir: File,
        bashPath: String,
        agentId: String,
        unattended: Boolean
    ): AgentRunResult {
        val libPath = libDir.absolutePath
        val planPath = File(homeDir, ".shelly/agents/plans/plan-agent-$agentId.json").absolutePath
        val executorPath = File(homeDir, ".shelly-plan-executor.js").absolutePath
        val brokerPath = File(homeDir, ".shelly-capability-broker.js").absolutePath
        val plan = File(planPath)
        val executor = File(executorPath)
        val broker = File(brokerPath)

        // Global kill-switch (STOP ALL). haltAllAgents uninstalls schedules and drops
        // this sentinel; refuse here so a still-in-flight alarm or a direct `am` fire
        // never launches the executor. Fail-closed. This native gate stays silent
        // (halt is user-initiated and schedules are already torn down — avoid per-fire
        // notification spam); the executor's own kill-switch skip still records a
        // skipped run log/notification if it is ever invoked directly (am/harness).
        if (File(homeDir, ".shelly/agents/.halted").isFile) {
            val message = "All agents are stopped (global kill-switch is on)."
            Log.i(TAG, "Agent $agentId refused: $message")
            writeReceiverLog(homeDir, agentId, "skipped", message)
            return AgentRunResult(agentId, 130, "", message)
        }

        if (!plan.isFile) {
            val message = "missing PlanSpec: $planPath"
            Log.e(TAG, message)
            writeReceiverLog(homeDir, agentId, "error", message)
            NotificationDispatcher(context).notifyAgentResult(agentId, "error", message)
            return AgentRunResult(agentId, 127, "", message)
        }
        val planVersion = readPlanSpecVersion(plan)
        if (planVersion != CURRENT_PLAN_SPEC_VERSION) {
            val message = "stale PlanSpec: $planPath version=$planVersion expected=$CURRENT_PLAN_SPEC_VERSION. Open Shelly or run the agent manually once to regenerate it."
            Log.e(TAG, message)
            writeReceiverLog(homeDir, agentId, "error", message)
            NotificationDispatcher(context).notifyAgentResult(agentId, "error", message)
            return AgentRunResult(agentId, 126, "", message)
        }
        val planAgentId = readPlanSpecAgentId(plan)
        if (planAgentId != agentId) {
            val message = "PlanSpec agent id mismatch: plan=$planAgentId expected=$agentId"
            Log.e(TAG, message)
            writeReceiverLog(homeDir, agentId, "error", message)
            NotificationDispatcher(context).notifyAgentResult(agentId, "error", message)
            return AgentRunResult(agentId, 127, "", message)
        }
        val planActionType = readPlanSpecActionType(plan)
        if (!PLAN_EXECUTOR_ACTIONS.contains(planActionType)) {
            val message = "unsupported PlanSpec action: $planActionType"
            Log.e(TAG, message)
            writeReceiverLog(homeDir, agentId, "error", message)
            NotificationDispatcher(context).notifyAgentResult(agentId, "error", message)
            return AgentRunResult(agentId, 127, "", message)
        }
        if (!executor.isFile || !broker.isFile) {
            val message = "PlanSpec executor assets missing: executor=${executor.isFile} broker=${broker.isFile}"
            Log.e(TAG, message)
            writeReceiverLog(homeDir, agentId, "error", message)
            NotificationDispatcher(context).notifyAgentResult(agentId, "error", message)
            return AgentRunResult(agentId, 127, "", message)
        }
        val trustedLaunch = trustedPlanLaunch(homeDir, agentId)

        val command = buildString {
            append("export PATH=")
            append(shellQuote("$libPath:$libPath/node_modules/npm/bin:$libPath/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin"))
            append(" && export LD_LIBRARY_PATH=")
            append(shellQuote(libPath))
            append(" && export HOME=")
            append(shellQuote(homeDir.absolutePath))
            append(" && export SHELLY_LIB_DIR=")
            append(shellQuote(libPath))
            append(" && export SHELLY_CAP_BROKER=1 SHELLY_CAP_FS=1 SHELLY_CAP_EXEC=1")
            append(" && export SSL_CERT_FILE=")
            append(shellQuote("${homeDir.absolutePath}/.shelly-ssl/ca-certificates.crt"))
            append(" && export CURL_CA_BUNDLE=")
            append(shellQuote("${homeDir.absolutePath}/.shelly-ssl/ca-certificates.crt"))
            append(" && export NODE_EXTRA_CA_CERTS=")
            append(shellQuote("${homeDir.absolutePath}/.shelly-ssl/ca-certificates.crt"))
            // Drop the exec-wrapper LD_PRELOAD (set globally by shelly-exec.c on this
            // launching shell) before the linker64 node launch. Inherited into bionic
            // node, the wrapper's fs/open interposition corrupts node's file-descriptor
            // ops and SIGABRTs it: reading the .js entry module aborts on
            // "Assertion failed: (0) == uv_fs_close(...)" in node::ReadFileSync
            // (shouldUseESMLoader), and OpenSSL's config read fails with
            // "BIO_new_file:Bad file descriptor" on openssl.cnf — so the executor never
            // runs on-device. Confirmed on hardware: the identical launch aborts (134)
            // with LD_PRELOAD and succeeds (0) without it. The executor and broker are
            // leaf node processes that never exec an app-data binary, so they do not
            // need the wrapper. Mirrors the llama-server launcher and the broker
            // childEnv (which also drops it). Device-only bug — the host harness spawns
            // the executor without this inherited preload, so it cannot reproduce it.
            append(" && unset LD_PRELOAD && /system/bin/linker64 ")
            append(shellQuote("$libPath/node"))
            append(" ")
            append(shellQuote(executorPath))
            append(" --plan-file ")
            append(shellQuote(planPath))
            append(" --agent-id ")
            append(shellQuote(agentId))
            append(" --home ")
            append(shellQuote(homeDir.absolutePath))
            append(" --lib-dir ")
            append(shellQuote(libPath))
            append(" --broker ")
            append(shellQuote(brokerPath))
            if (unattended) {
                append(" --unattended 1")
            }
            if (trustedLaunch != null) {
                append(" --trusted-autonomous-agent-id ")
                append(shellQuote(agentId))
                append(" --trusted-autonomous-action ")
                append(shellQuote(trustedLaunch.actionType))
                append(" --trusted-tool-type ")
                append(shellQuote(trustedLaunch.toolType))
            }
        }

        Log.i(TAG, "Agent $agentId starting via PlanSpec executor plan=$planPath version=$planVersion unattended=$unattended trustedAction=${trustedLaunch?.actionType ?: "-"} trustedTool=${trustedLaunch?.toolType ?: "-"}")
        val actionApprovalNotifierStop = AtomicBoolean(false)
        val actionApprovalNotifier = startActionApprovalNotifier(context, actionApprovalNotifierStop)
        val result = try {
            ShellyJNI.execSubprocess(
                "/system/bin/linker64",
                bashPath,
                libPath,
                homeDir.absolutePath,
                command,
                DEFAULT_TIMEOUT_MS
            )
        } finally {
            actionApprovalNotifierStop.set(true)
            runCatching { actionApprovalNotifier.join(1000) }
        }

        val exitCode = result.getOrNull(0)?.toIntOrNull() ?: 1
        val stdout = result.getOrNull(1).orEmpty()
        val stderr = result.getOrNull(2).orEmpty()
        val notificationPosted = postAgentResultNotificationIfRequested(context, homeDir, agentId)
        if (exitCode == 0) {
            Log.i(TAG, "Agent $agentId completed via PlanSpec executor")
        } else {
            Log.e(TAG, "Agent $agentId failed via PlanSpec executor: exit=$exitCode stderr=${stderr.take(300)}")
            if (!notificationPosted) {
                NotificationDispatcher(context).notifyAgentResult(
                    agentId = agentId,
                    status = "error",
                    preview = "PlanSpec executor failed. exit=$exitCode stderr=${stderr.take(300)}"
                )
            }
            writeReceiverLog(
                homeDir,
                agentId,
                "error",
                "plan-executor exit=$exitCode stderr=${stderr.take(500)} stdout=${stdout.take(500)}"
            )
        }
        return AgentRunResult(agentId, exitCode, stdout, stderr)
    }

    private fun postAgentResultNotificationIfRequested(context: Context, homeDir: File, agentId: String): Boolean {
        val request = File(homeDir, ".shelly/agents/logs/$agentId/native-result-notification.json")
        if (!request.isFile) return false
        try {
            val json = JSONObject(request.readText())
            NotificationDispatcher(context).notifyAgentResult(
                agentId = json.optString("agentId", agentId).ifBlank { agentId },
                status = json.optString("status", "success"),
                preview = json.optString("preview", ""),
                agentName = json.optString("agentName", "").trim().ifBlank { null },
                toolLabel = json.optString("toolLabel", "").trim().ifBlank { null }
            )
            return true
        } catch (e: Exception) {
            Log.w(TAG, "Failed to post agent result notification for $agentId", e)
            return false
        } finally {
            runCatching { request.delete() }
        }
    }

    private fun startActionApprovalNotifier(context: Context, stop: AtomicBoolean): Thread {
        val appContext = context.applicationContext
        return Thread {
            val dispatcher = NotificationDispatcher(appContext)
            val seen = mutableSetOf<String>()
            while (!stop.get()) {
                try {
                    val dir = AgentActionApprovalBridge.requestDir(appContext)
                    val now = System.currentTimeMillis()
                    dir.listFiles { file ->
                        file.isFile && file.name.startsWith("action-") && file.name.endsWith(".json")
                    }?.forEach { file ->
                        val request = AgentActionApprovalBridge.fromRequestFile(appContext, file)
                            ?: return@forEach
                        val expiresAt = request.expiresAt
                        if (expiresAt != null && now > expiresAt) return@forEach
                        if (seen.add(request.key)) {
                            dispatcher.notifyAgentActionApprovalNeeded(request)
                        }
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "agent action approval notifier iteration failed", e)
                }
                try {
                    Thread.sleep(500)
                } catch (_: InterruptedException) {
                    return@Thread
                }
            }
        }.apply {
            name = "ShellyAgentActionApprovalNotifier"
            isDaemon = true
            start()
        }
    }

    private fun readScriptVersion(script: File): Int {
        return try {
            script.useLines { lines ->
                val versionRegex = Regex("""^SHELLY_AGENT_SCRIPT_VERSION=(\d+)\s*$""")
                for (line in lines.take(20)) {
                    val version = versionRegex.find(line.trim())
                        ?.groupValues
                        ?.getOrNull(1)
                        ?.toIntOrNull()
                    if (version != null) return@useLines version
                }
                0
            } ?: 0
        } catch (_: Exception) {
            0
        }
    }

    private fun readPlanSpecVersion(plan: File): Int {
        return try {
            JSONObject(plan.readText()).optInt("schemaVersion", 0)
        } catch (_: Exception) {
            0
        }
    }

    private fun readPlanSpecAgentId(plan: File): String {
        return try {
            JSONObject(plan.readText()).optJSONObject("agent")?.optString("id").orEmpty()
        } catch (_: Exception) {
            ""
        }
    }

    private fun readPlanSpecActionType(plan: File): String {
        return try {
            JSONObject(plan.readText()).optJSONObject("action")?.optString("type").orEmpty()
        } catch (_: Exception) {
            ""
        }
    }

    private fun shouldRunPlanExecutor(homeDir: File, agentId: String): Boolean {
        val flags = readAgentEnvFlags(homeDir)
        if (!isTruthy(flags["SHELLY_PLAN_EXECUTOR"])) return false
        return flags["SHELLY_PLAN_EXECUTOR_AGENT_ID"] == agentId
    }

    private fun trustedPlanLaunch(homeDir: File, agentId: String): TrustedPlanLaunch? {
        val agentFile = File(homeDir, ".shelly/agents/$agentId.json")
        if (!agentFile.isFile) return null
        return try {
            val json = JSONObject(agentFile.readText())
            if (json.optString("id") != agentId) return null
            if (!json.optBoolean("autonomous", false)) return null
            val actionType = json.optJSONObject("action")
                ?.optString("type")
                ?.takeIf { it.isNotBlank() }
                ?: "draft"
            if (actionType != "draft" && actionType != "notify") return null
            val toolType = json.optJSONObject("tool")
                ?.optString("type")
                ?.takeIf { it.isNotBlank() }
                ?: return null
            // Phase 0 canary only trusts deterministic local unattended effects.
            // Cloud/web/auto routes stay manual-gated until PlanSpec integrity is
            // signed or native can recompute the full TS route decision.
            if (toolType != "local") return null
            TrustedPlanLaunch(actionType = actionType, toolType = toolType)
        } catch (e: Exception) {
            Log.w(TAG, "Unable to read trusted PlanSpec launch state for $agentId", e)
            null
        }
    }

    private fun readAgentEnvFlags(homeDir: File): Map<String, String> {
        val envFile = File(homeDir, ".shelly/agents/.env")
        if (!envFile.isFile) return emptyMap()
        val wanted = setOf("SHELLY_PLAN_EXECUTOR", "SHELLY_PLAN_EXECUTOR_AGENT_ID")
        val out = mutableMapOf<String, String>()
        try {
            envFile.forEachLine { raw ->
                val line = raw.trim()
                if (line.isEmpty() || line.startsWith("#")) return@forEachLine
                val eq = line.indexOf('=')
                if (eq <= 0) return@forEachLine
                val key = line.substring(0, eq).trim().removePrefix("export ").trim()
                if (!wanted.contains(key)) return@forEachLine
                out[key] = stripEnvValue(line.substring(eq + 1).trim())
            }
        } catch (_: Exception) {
            return emptyMap()
        }
        return out
    }

    private fun stripEnvValue(value: String): String {
        if (value.length >= 2 && value.first() == '\'' && value.last() == '\'') {
            return value.substring(1, value.length - 1)
        }
        if (value.length >= 2 && value.first() == '"' && value.last() == '"') {
            return value.substring(1, value.length - 1)
        }
        return value
    }

    private fun isTruthy(value: String?): Boolean =
        when (value?.trim()?.lowercase()) {
            "1", "true", "yes", "on" -> true
            else -> false
        }

    private fun writeReceiverLog(homeDir: File, agentId: String, status: String, message: String) {
        try {
            val logDir = File(homeDir, ".shelly/agents/logs/$agentId")
            logDir.mkdirs()
            val ts = System.currentTimeMillis()
            val safeMessage = message
                .replace("\\", "\\\\")
                .replace("\"", "'")
                .replace("\n", " ")
            File(logDir, "$ts-receiver.json").writeText(
                "{\"agentId\":\"$agentId\",\"timestamp\":$ts,\"status\":\"$status\",\"errorMessage\":\"$safeMessage\"}\n"
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to write receiver log for $agentId", e)
        }
    }

    private fun shellQuote(value: String): String =
        "'" + value.replace("'", "'\\''") + "'"
}
