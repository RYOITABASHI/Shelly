package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import expo.modules.terminalemulator.scouter.AgentEscalationBridge
import expo.modules.terminalemulator.scouter.AgentActionApprovalBridge
import expo.modules.terminalemulator.scouter.AgentActionApprovalRequest
import expo.modules.terminalemulator.scouter.AgentCapabilityApprovalBridge
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
    // v13 (bug #155(b), docs/superpowers/DEFERRED.md): lib/agent-executor.ts's
    // generateRunScript now surfaces a clear run-log note when a real
    // multi-step orchestrated agent falls back to this legacy single-shot
    // script (unsupported tool for the PlanSpec chain executor). No routing
    // change here — bumped only so a stale pre-v13 on-disk script (silent
    // collapse, no note) is regenerated rather than kept.
    // v14 (docs/superpowers/DEFERRED.md): agent.workspaceRoot now reaches the
    // Codex driver's --cwd, and a new shelly_git() helper adds the same
    // scoped LD_PRELOAD the interactive PTY's git() already has, so HTTPS git
    // works from the autonomous runtime too. Bumped so a stale pre-v14
    // on-disk script is regenerated rather than kept.
    // v15 (docs/superpowers/DEFERRED.md #3): ab-article-eval's codex leg now
    // routes through the B2 driver instead of a bare `codex exec` (which ran
    // danger-full-access, bypassing command-safety/workspace-boundary
    // classification). Bumped so a stale pre-v15 on-disk script regenerates.
    // v16 (2026-07-17, bug #155(b) follow-up, docs/superpowers/DEFERRED.md):
    // a real (>=2 step) orchestrated agent whose resolved tool is the codex
    // driver, with every attempted step carrying neither a per-step tool pin
    // nor an apiCall step, now runs its FULL chain in-script (a bash loop
    // calling the same B2-driver-gated invocation once per step) instead of
    // silently collapsing to agent.prompt as a single step. No routing change
    // here (this legacy .sh path is still only reached when
    // shouldRunPlanExecutor is false, unchanged) — bumped only because the
    // generated script's runtime BEHAVIOR changed for this case, so a stale
    // pre-v16 on-disk script (old single-step collapse) is regenerated.
    // v17 (2026-07-17, docs/superpowers/DEFERRED.md 自律エージェント制御面レビュー #1):
    // wait_action_approval() no longer trusts an action-approval reply on
    // runId+requestSha256 equality alone (both derivable by the same-uid
    // agent script itself from files it can already read) — it now also
    // verifies an Android Keystore RSA signature over the reply (via a new
    // bundled node helper), with the verifier public key sha256 pinned into
    // the script's environment the SAME way SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256
    // already is below. AgentActionApprovalBridge.writeHumanReply/
    // writeAutoApprovedReply now sign every reply with a dedicated Keystore
    // key (separate alias from the escalation bridge's). Bumped so a stale
    // pre-v17 on-disk script (unsigned-reply trust) is regenerated rather
    // than kept.
    // v18 (2026-07-17, docs/superpowers/DEFERRED.md "Capability broker Phase 0"
    // mid-run host approval follow-up): http_post_json's SHELLY_CAP_BROKER=1
    // branch now passes --approval-dir/--approval-reply-dir/--agent-id/
    // --agent-name/--run-id/--approval-timeout-seconds to the broker so a
    // non-allowlisted-host verdict can be resolved by a human mid-run
    // (AgentCapabilityApprovalBridge.kt + this file's action-approval notifier
    // thread, extended below to also scan cap-broker-host requests) instead of
    // failing closed immediately. Flag-gated OFF by SHELLY_CAP_BROKER=0
    // default, but bumped so a stale pre-v18 on-disk script (old call site
    // with no approval args) is regenerated.
    // v19 (2026-07-17, on-device bug repro: a Groq-routed agent told to
    // "record the current time" wrote a hallucinated 2024 date — no backend's
    // model-facing prompt ever carried the real wall-clock date/time). Every
    // PROMPT_FILE-assembly call site now leads the assembled prompt with a
    // runtime-computed CURRENT_DATETIME_CONTEXT line (device-local
    // date/weekday/time via `date`). Bumped so a stale pre-v19 on-disk script
    // (no date grounding) is regenerated rather than kept.
    // v20 (2026-07-18, docs/superpowers/DEFERRED.md "エージェント二重実行
    // レース" chain-lock follow-up): the generated script's per-agent
    // LOCK_FILE check is now mkdir-atomic (was a non-atomic
    // check-then-act) and gained a new CHAIN_LOCK_DIR/CHAIN_LOCK_NONCE check
    // ahead of it, so an attended multi-step/multi-attempt run (Sidebar RUN
    // NOW / @agent chat) can no longer be raced by this SAME agent's own
    // AlarmManager fire landing mid-chain. Bumped so a stale pre-v20 on-disk
    // script (old lock semantics) is regenerated rather than kept.
    // v21 (2026-07-21, Fable5 UX consultation): generated draft runs expose
    // their saved destinations, and same-script Codex chains publish a live
    // per-step current.json marker that the EXIT cleanup removes.
    // v22 (2026-07-21, Sidebar RUNNING-row plumbing): fixes a v21 bug where
    // LOG_DIR/current.json's "tool" field was double-quoted (see
    // lib/agent-executor.ts's matching AGENT_SCRIPT_VERSION comment) — no
    // wire-format or behavior change beyond that, but bumped so a stale
    // pre-fix on-disk script is regenerated rather than kept.
    // v23 (2026-07-22, social auto-post connectors): new 'social-post' action
    // (dispatch_agent_action case + dispatch_social_post helpers, connector
    // secrets resolved from .env at runtime, non-allowlisted host requires a
    // human approval tap) — see lib/agent-executor.ts's matching
    // AGENT_SCRIPT_VERSION comment. Bumped so a stale pre-social-post on-disk
    // script is regenerated rather than kept.
    // v24 (2026-07-23, multi-destination action fan-out): a >= 2-entry
    // Agent.actions is now dispatched as a bash loop over
    // dispatch_agent_action(), one independent call per action — see
    // lib/agent-executor.ts's matching AGENT_SCRIPT_VERSION comment. No
    // native routing change (this legacy .sh path is still only reached when
    // shouldRunPlanExecutor is false, unchanged); bumped only because the
    // generated script's runtime BEHAVIOR changes for a multi-action agent,
    // so a stale pre-v24 on-disk script (old single-action-only dispatch) is
    // regenerated rather than kept.
    private const val CURRENT_SCRIPT_VERSION = 24
    private const val CURRENT_PLAN_SPEC_VERSION = 1
    private val PLAN_EXECUTOR_ACTIONS = setOf("draft", "notify", "webhook", "cli", "intent", "dm-reply", "app-act", "api-call", "social-post", "__suppressed__")
    // docs/superpowers/DEFERRED.md "PlanSpec executor 経由の無人スケジュール実行に
    // local LLM autostart が無い": matches both lib/agent-executor.ts's
    // LOCAL_MODEL_LIGHT and scripts/shelly-plan-executor.js's modelRequest()
    // 'local' case default (`plan.tool.model || 'Qwen3.5-0.8B-Q4_K_M'`), so the
    // preflight ensures the SAME model the executor will actually request when
    // the PlanSpec carries no explicit tool.model.
    private const val DEFAULT_LOCAL_LLM_MODEL = "Qwen3.5-0.8B-Q4_K_M"

    private data class TrustedPlanLaunch(
        val actionType: String,
        val toolType: String,
        /** app-act only (2026-07-14 Tier-B resolution): the recipe id read
         *  from the SAME freshly re-read persisted agent.json this trust
         *  decision is based on, threaded through --trusted-app-act-recipe-id
         *  so scripts/shelly-plan-executor.js's trustedNativeLowRiskAction can
         *  verify the plan it's about to run still references the SAME
         *  recipe — defense-in-depth against the plan diverging from what was
         *  actually consented to at registration time. */
        val appActRecipeId: String? = null
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

        // Per-agent enabled re-check (innermost chokepoint), gated to UNATTENDED
        // runs only. Every RUN_AGENT dispatch (AlarmManager fire, notification-
        // trigger, manual widget tap, in-app "Run now") funnels through this
        // single runAgent() entry point before branching into the legacy .sh
        // runner or the PlanSpec executor below, so this is the correct backstop
        // for any caller that reaches here without having already re-checked
        // `enabled` upstream. ShellyNotificationListener's findAgentsTriggeredBy()
        // and WidgetAgentRepository.scheduledById() already re-read disk and
        // refuse a disabled agent at their own call sites (defense in depth,
        // left as-is; this re-check is a harmless no-op there since `enabled`
        // is already known true) — but a straggler AgentAlarmReceiver fire (an
        // alarm armed before the user disabled/paused the agent, not yet
        // cancelled/re-armed) reaches TerminalSessionService's ACTION_RUN_AGENT
        // with only the global STOP-ALL check in front of it, which is a
        // different (agent-independent) gate, and lands here with
        // unattended=true (TerminalSessionService's `scheduled` extras). Without
        // a check here, that straggler fire — or any future automated caller
        // that reaches AgentRuntime directly — would still execute a disabled
        // agent. Deliberately does NOT gate the attended path
        // (unattended=false): Sidebar.tsx's agent-detail popup offers "Run now"
        // as an action independent from Pause/Resume (handleRunScheduledAgent /
        // handleTogglePause are separate buttons, see agent_run_now +
        // agent_pause/agent_resume) — TerminalEmulatorModule.runAgent() is
        // called with no manual/interval/cron extras, so TerminalSessionService
        // computes unattended=false for it, and lib/agent-manager.ts's
        // setAgentEnabled() docs this as a pause/resume of the SCHEDULE, not a
        // block on manual triggering. Gating on `enabled` unconditionally here
        // would silently break that intentional manual override. Fails closed
        // on every negative signal (missing file, malformed JSON, id mismatch,
        // enabled=false/absent, or a read error) exactly like the STOP-ALL
        // check's own fail-closed pattern. This is specifically about DISABLE,
        // not delete — delete is already fail-closed via the missing-script /
        // missing-PlanSpec checks below (exit 127).
        if (unattended && !isAgentEnabled(homeDir, agentId)) {
            val message = "agent disabled: $agentId"
            Log.i(TAG, "Agent $agentId refused: $message")
            writeReceiverLog(homeDir, agentId, "skipped", message)
            return AgentRunResult(agentId, 129, "", message)
        }

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
            return runPlanAgent(appContext, homeDir, libDir, bashPath, agentId, tainted, unattended)
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
        // docs/superpowers/DEFERRED.md 自律エージェント制御面レビュー #1 (2026-07-17):
        // same pin-injection pattern as the escalation key above, for
        // wait_action_approval()'s reply-signature verification. Both the sha256
        // pin AND the DER path are injected here (unlike escalation, whose JS
        // driver independently re-derives its own DER path from $HOME) because
        // the legacy .sh path has no existing "$HOME sibling dir" formula to
        // reuse — exporting the real path is simpler and less error-prone than
        // teaching bash Android's noBackupFilesDir layout.
        val actionApprovalPublicKeySha256 = AgentActionApprovalBridge.verifierPublicKeySha256(appContext)
        val actionApprovalPublicKeyPath = AgentActionApprovalBridge.verifierPublicKeyFile(appContext).absolutePath
        Log.i(
            TAG,
            "Agent $agentId starting via Shelly runtime script=$scriptPath version=$scriptVersion pinInjected=${escalationPublicKeySha256.isNotBlank()} actionApprovalPinInjected=${actionApprovalPublicKeySha256.isNotBlank()}"
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
            append(" && export SHELLY_AGENT_ACTION_APPROVAL_PUBLIC_KEY_SHA256=")
            append(shellQuote(actionApprovalPublicKeySha256))
            append(" && readonly SHELLY_AGENT_ACTION_APPROVAL_PUBLIC_KEY_SHA256")
            append(" && export SHELLY_AGENT_ACTION_APPROVAL_PUBLIC_KEY_FILE=")
            append(shellQuote(actionApprovalPublicKeyPath))
            append(" && readonly SHELLY_AGENT_ACTION_APPROVAL_PUBLIC_KEY_FILE")
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
        tainted: Boolean,
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

        // docs/superpowers/DEFERRED.md "エージェント二重実行レース" (2026-07-18
        // follow-up, found via on-device testing of the chain-lock fix itself):
        // the chain-scoped lock lib/agent-manager.ts's acquireChainLock/
        // releaseChainLock own (${locksDir}/${agentId}.chain.lock, mkdir-based —
        // lib/agent-executor.ts::getChainLockDir is the single source of truth
        // this mirrors) is checked by the LEGACY .sh script's own generated bash
        // (the CHAIN_LOCK_DIR/CHAIN_LOCK_NONCE check baked in at
        // AGENT_SCRIPT_VERSION 20). But an orchestrated agent whose tool IS
        // supported by this PlanSpec executor — the common case since North
        // Star P0(c) — never reaches that legacy .sh at all on its native/
        // unattended fire (shouldRunPlanExecutor routes it here instead), so it
        // was never protected against colliding with an ATTENDED chain (Sidebar
        // RUN NOW / @agent chat) still in flight for the SAME agent. Confirmed
        // on-device: agent-mrode1ec's attended RUN NOW (JS, legacy .sh per step)
        // and its own native */5 alarm (routed here) fired within seconds of
        // each other with zero mutual awareness.
        //
        // This native path can never legitimately be the lock's OWNER itself —
        // only the JS/attended side ever calls acquireChainLock — so unlike the
        // legacy .sh's nonce-matching check (which must distinguish "this
        // chain's own next step" from "a foreign holder"), existence alone is
        // sufficient here: any live chain-lock directory means some OTHER run
        // already owns this agent. Best-effort/fail-open on purpose: an
        // unreadable/missing lock dir is treated as "not held" (isDirectory
        // returns false), so this check can never itself block a legitimate run
        // that the lock system isn't currently protecting.
        val chainLockDir = File(homeDir, ".shelly/agents/locks/$agentId.chain.lock")
        if (chainLockDir.isDirectory) {
            val message = "previous run still active"
            Log.i(TAG, "Agent $agentId skipped via PlanSpec executor: $message (chain lock held by an attended run)")
            writeReceiverLog(homeDir, agentId, "skipped", message)
            return AgentRunResult(agentId, 130, "", message)
        }

        // docs/superpowers/DEFERRED.md "PlanSpec executor 経由の無人スケジュール実行に
        // local LLM autostart が無い" (2026-07-18): shelly-plan-executor.js's 'local'
        // tool case fires a plain HTTP request with no autostart (it is deliberately
        // spawn-incapable, see the DEFERRED.md entry), so an unattended-scheduled
        // orchestrated agent resolving to tool.type=="local" fails ECONNREFUSED when
        // llama-server isn't already running. Read tool.type from the SAME on-disk
        // PlanSpec this function already validated above (readPlanSpecVersion/
        // readPlanSpecAgentId/readPlanSpecActionType each do their own
        // JSONObject(plan.readText()) parse — this follows that exact established
        // pattern rather than threading a single parsed object through). If local,
        // run a small bash preflight that sources the extracted
        // ensure_local_llm_server() helper library and calls it once, mirroring
        // lib/agent-executor.ts's own call site
        // (`ensure_local_llm_server "$LOCAL_URL" "$LOCAL_MODEL"`). Best-effort only:
        // on failure or timeout this falls through to the unchanged node launch
        // below, which reproduces today's existing "unavailable" ECONNREFUSED
        // failure path — no new failure mode is introduced.
        if (readPlanSpecToolType(plan) == "local") {
            ensureLocalLlmServerBeforePlanExecutor(homeDir, libPath, bashPath, agentId, readPlanSpecToolModel(plan))
        }

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
            if (tainted) {
                append(" && export SHELLY_CAP_TAINTED=1")
            }
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
                if (trustedLaunch.appActRecipeId != null) {
                    append(" --trusted-app-act-recipe-id ")
                    append(shellQuote(trustedLaunch.appActRecipeId))
                }
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

    /**
     * docs/superpowers/DEFERRED.md "PlanSpec executor 経由の無人スケジュール実行に
     * local LLM autostart が無い" (2026-07-18): best-effort native preflight that
     * sources the bundled `scripts/shelly-local-llm-ensure.sh` helper library
     * (extracted to `$HOME/.shelly-local-llm-ensure.sh` by
     * [HomeInitializer.initialize], unconditionally, on every call — including
     * the one at the top of [runAgent] that ran just before this) and calls its
     * `ensure_local_llm_server` function once, mirroring
     * lib/agent-executor.ts's own call site
     * (`ensure_local_llm_server "$LOCAL_URL" "$LOCAL_MODEL"`, around its
     * `LOCAL_URL="${LOCAL_LLM_URL:-http://127.0.0.1:8080}"` assignment).
     *
     * Launched via the exact same `ShellyJNI.execSubprocess("/system/bin/linker64",
     * bashPath, ...)` primitive [runPlanAgent] uses for the node launch below it,
     * as a SEPARATE bounded call — its own readiness polling (up to 90s by
     * default, `LOCAL_LLM_START_TIMEOUT_SECONDS`) lives entirely inside
     * `ensure_local_llm_server` and is authoritative; [DEFAULT_TIMEOUT_MS] here is
     * only an outer safety bound (reusing the same constant every other
     * execSubprocess call in this file already uses, not a new one) and should
     * never actually be the limiting factor. The llama-server launch inside
     * `ensure_local_llm_server` already does its own `unset LD_PRELOAD` right
     * before its `/system/bin/linker64` invocation (copied verbatim from
     * lib/agent-executor.ts, which itself mirrors the in-app Start button) — this
     * preflight's own outer bash process needs no additional LD_PRELOAD handling
     * beyond that, the same way the legacy `.sh` script's own `shelly_node` calls
     * (used pervasively for the HTTP helper functions this library also carries)
     * never unset it either and have run in production for months.
     *
     * Sourced (`. "$path"`), never executed directly — this is a pure function
     * library with no side effects until `ensure_local_llm_server` is explicitly
     * called, so it needs no exec bit.
     *
     * Any failure or timeout here is swallowed and logged only: the caller
     * proceeds unconditionally to the unchanged node/plan-executor.js launch,
     * which reproduces today's existing ECONNREFUSED → "unavailable" failure
     * path when the server truly could not be started. No new failure mode.
     */
    private fun ensureLocalLlmServerBeforePlanExecutor(
        homeDir: File,
        libPath: String,
        bashPath: String,
        agentId: String,
        planToolModel: String?
    ) {
        val sharedScript = File(homeDir, ".shelly-local-llm-ensure.sh")
        if (!sharedScript.isFile) {
            Log.w(TAG, "Agent $agentId: local-llm-ensure script missing at ${sharedScript.absolutePath}, skipping preflight")
            return
        }
        val modelName = planToolModel?.takeIf { it.isNotBlank() } ?: DEFAULT_LOCAL_LLM_MODEL
        val envFile = File(homeDir, ".shelly/agents/.env")
        val tmpDir = File(homeDir, ".shelly/tmp")
        val locksDir = File(homeDir, ".shelly/agents/locks")

        val command = buildString {
            append("export PATH=")
            append(shellQuote("$libPath:$libPath/node_modules/npm/bin:$libPath/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin"))
            append(" && export LD_LIBRARY_PATH=")
            append(shellQuote(libPath))
            append(" && export HOME=")
            append(shellQuote(homeDir.absolutePath))
            append(" && AGENT_ID=")
            append(shellQuote(agentId))
            append(" && TMP_DIR=")
            append(shellQuote(tmpDir.absolutePath))
            append(" && LOCKS_DIR=")
            append(shellQuote(locksDir.absolutePath))
            append(" && mkdir -p \"\$TMP_DIR\" \"\$LOCKS_DIR\" \"\$HOME/models\"")
            // Same .env this agent's PlanSpec executor launch below reads
            // (scripts/shelly-plan-executor.js's parseConfigEnv(paths.envFile),
            // paths.envFile = $HOME/.shelly/agents/.env) — sourcing it here means
            // a user-configured LOCAL_LLM_URL/LOCAL_LLM_MODEL is honored by the
            // preflight exactly as it will be by the executor's own request,
            // matching the legacy .sh script's own `source "$ENV_FILE"` call site.
            // Braced with `|| true` (not chained bare with `&&`) so a fresh
            // install with no .env yet does not short-circuit the rest of this
            // command.
            append(" && { [ -f ")
            append(shellQuote(envFile.absolutePath))
            append(" ] && . ")
            append(shellQuote(envFile.absolutePath))
            append(" || true; }")
            append(" && . ")
            append(shellQuote(sharedScript.absolutePath))
            append(" && LOCAL_URL=\"\${LOCAL_LLM_URL:-http://127.0.0.1:8080}\"")
            append(" && ensure_local_llm_server \"\$LOCAL_URL\" ")
            append(shellQuote(modelName))
        }

        Log.i(TAG, "Agent $agentId: running local-llm-ensure preflight before PlanSpec executor (model=$modelName)")
        try {
            val result = ShellyJNI.execSubprocess(
                "/system/bin/linker64",
                bashPath,
                libPath,
                homeDir.absolutePath,
                command,
                DEFAULT_TIMEOUT_MS
            )
            val exitCode = result.getOrNull(0)?.toIntOrNull() ?: -1
            if (exitCode == 0) {
                Log.i(TAG, "Agent $agentId: local-llm-ensure preflight succeeded")
            } else {
                val stderr = result.getOrNull(2).orEmpty()
                Log.w(TAG, "Agent $agentId: local-llm-ensure preflight exit=$exitCode stderr=${stderr.take(300)} (continuing to PlanSpec executor; a still-unavailable server surfaces as today's existing ECONNREFUSED failure)")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Agent $agentId: local-llm-ensure preflight threw, continuing to PlanSpec executor", e)
        }
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
            val seenCapability = mutableSetOf<String>()
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
                        if (!seen.add(request.key)) return@forEach
                        // app-act Tier-B unattended-allow (docs/superpowers/DEFERRED.md,
                        // resolved 2026-07-14, widened same day to any tool backend): a
                        // request the executor itself marked autoFireTrusted
                        // (agent.autonomous===true, verified again here against the
                        // recipe fingerprint) is fired
                        // and resolved RIGHT HERE, natively — no human tap, no RN round
                        // trip, so it works whether or not the JS bridge is alive
                        // (unattended scheduled runs). Every other action type/trust
                        // state is unchanged: falls through to the normal
                        // notifyAgentActionApprovalNeeded review/notification flow.
                        if (request.actionType == "app-act" && request.autoFireTrusted) {
                            fireTrustedAppActAndReply(appContext, request)
                            return@forEach
                        }
                        dispatcher.notifyAgentActionApprovalNeeded(request)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "agent action approval notifier iteration failed", e)
                }
                try {
                    // 2026-07-17 (Capability broker Phase 0 mid-run host approval,
                    // docs/superpowers/DEFERRED.md): scans the SAME directory for
                    // "cap-*.json" requests (AgentCapabilityApprovalBridge already
                    // ignores anything not tagged "type":"cap-broker-host", and this
                    // filter never matches "action-*.json", so the two loops above/
                    // below can never double-fire on each other's files). No
                    // native-side "auto-fire trusted" equivalent here — a NEW host
                    // always needs an explicit human tap, unlike the app-act Tier-B
                    // case above.
                    AgentCapabilityApprovalBridge.listPendingRequests(appContext).forEach { request ->
                        val expiresAt = request.expiresAt
                        if (expiresAt != null && System.currentTimeMillis() > expiresAt) return@forEach
                        if (!seenCapability.add(request.key)) return@forEach
                        dispatcher.notifyAgentCapabilityApprovalNeeded(request)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "agent capability approval notifier iteration failed", e)
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

    /**
     * app-act Tier-B unattended-allow (docs/superpowers/DEFERRED.md, resolved
     * 2026-07-14). Fires [request]'s recipe directly via [AppActExecutor] —
     * the SAME native call TerminalEmulatorModule's `fireAgentAppAct`
     * AsyncFunction makes for the attended/human-tap path, just invoked
     * synchronously from this native thread instead of from RN — then
     * publishes the accept/decline reply via
     * [AgentActionApprovalBridge.writeAutoApprovedReply], mirroring RN's own
     * "fire, THEN reply" invariant (resolvePendingAgentActionApproval in
     * app/_layout.tsx) so wait_action_approval/requestActionApproval's
     * existing poll-for-reply contract needs no changes for either executor.
     * Fails CLOSED (writes a decline reply) on any error — accessibility
     * service not connected, recipe execution failure, or a malformed
     * params blob — exactly like RN's catch block does for a failed
     * fireAgentAppAct call, rather than leaving the run to time out.
     */
    private fun fireTrustedAppActAndReply(context: Context, request: AgentActionApprovalRequest) {
        val requestSha256 = request.requestSha256
        if (requestSha256.isNullOrBlank()) {
            Log.w(TAG, "trusted app-act auto-fire: request ${request.runId} has no requestSha256, skipping")
            return
        }
        val recipeId = request.appActRecipeId?.trim().orEmpty()
        var success = false
        try {
            val service = ShellyAccessibilityService.activeInstance
            if (service == null) {
                Log.w(TAG, "trusted app-act auto-fire: accessibility service not connected, declining ${request.runId}")
            } else if (recipeId.isEmpty()) {
                Log.w(TAG, "trusted app-act auto-fire: request ${request.runId} has no recipe id, declining")
            } else {
                val params = parseAppActParamsResolved(request.appActParamsResolved)
                val result = AppActExecutor.execute(service, context.applicationContext, recipeId, params)
                success = result.success
                // Never log param VALUES or the failure message (may echo on-screen
                // text via diagnoseCurrentScreen) — recipeId + success only, matching
                // fireAgentAppAct's own logging convention.
                Log.i(TAG, "trusted app-act auto-fire: recipeId=$recipeId success=$success runId=${request.runId}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "trusted app-act auto-fire threw for ${request.runId}", e)
        }
        try {
            AgentActionApprovalBridge.writeAutoApprovedReply(
                context,
                request.runId,
                if (success) "accept" else "decline",
                requestSha256
            )
        } catch (e: Exception) {
            Log.w(TAG, "trusted app-act auto-fire: failed to publish reply for ${request.runId}", e)
        }
    }

    /** Parses the flat string-map JSON `appActParamsResolved` field (see
     *  write_action_approval_request / requestActionApproval) into the
     *  Map<String, String> [AppActExecutor.execute] expects. Malformed/empty
     *  input yields an empty map (AppActExecutor's own required-param check
     *  then fails the recipe closed, same as a missing param from RN). */
    private fun parseAppActParamsResolved(raw: String?): Map<String, String> {
        if (raw.isNullOrBlank()) return emptyMap()
        return try {
            val json = JSONObject(raw)
            val out = mutableMapOf<String, String>()
            val keys = json.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                out[key] = json.optString(key, "")
            }
            out
        } catch (e: Exception) {
            emptyMap()
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

    /** Same read*(plan: File) pattern as readPlanSpecActionType above, for the
     *  local-LLM autostart preflight (docs/superpowers/DEFERRED.md "PlanSpec
     *  executor 経由の無人スケジュール実行に local LLM autostart が無い"). */
    private fun readPlanSpecToolType(plan: File): String {
        return try {
            JSONObject(plan.readText()).optJSONObject("tool")?.optString("type").orEmpty()
        } catch (_: Exception) {
            ""
        }
    }

    /** Companion to [readPlanSpecToolType]; null when absent/blank so the
     *  caller can fall back to the same default model
     *  scripts/shelly-plan-executor.js's modelRequest() uses
     *  (`'Qwen3.5-0.8B-Q4_K_M'`). */
    private fun readPlanSpecToolModel(plan: File): String? {
        return try {
            JSONObject(plan.readText()).optJSONObject("tool")?.optString("model")?.trim()?.ifBlank { null }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * North Star P0(c) fix (docs/superpowers/DEFERRED.md's "スケジュール実行が
     * 多段オーケストレーションを使わない問題"): a scheduled/unattended fire for
     * an agent with multi-step orchestration configured must route through the
     * chain-aware PlanSpec executor, not silently collapse to the legacy
     * single-shot .sh script's one-call-only agent.prompt. Detecting this from
     * the on-disk PlanSpec's `steps` field (rather than requiring a per-agent
     * manual flag) mirrors scripts/shelly-plan-executor.js's own `hasChain`
     * check exactly, and is additive: buildAgentPlanSpec() only ever writes a
     * `steps` field when the agent actually has orchestration configured, so
     * every non-orchestrated agent's plan file has no `steps` key at all and
     * this always falls through to the unchanged legacy `.sh` branch below —
     * zero behavior change for the (overwhelming majority) of agents without
     * multi-step orchestration. The manual SHELLY_PLAN_EXECUTOR canary stays
     * available for testing a plan-executor run on an agent WITHOUT real
     * orchestration configured.
     */
    private fun shouldRunPlanExecutor(homeDir: File, agentId: String): Boolean {
        val flags = readAgentEnvFlags(homeDir)
        if (isTruthy(flags["SHELLY_PLAN_EXECUTOR"]) && flags["SHELLY_PLAN_EXECUTOR_AGENT_ID"] == agentId) {
            return true
        }
        return planSpecHasOrchestrationSteps(homeDir, agentId)
    }

    private fun planSpecHasOrchestrationSteps(homeDir: File, agentId: String): Boolean {
        val planFile = File(homeDir, ".shelly/agents/plans/plan-agent-$agentId.json")
        if (!planFile.isFile) return false
        return try {
            val json = JSONObject(planFile.readText())
            val list = json.optJSONObject("steps")?.optJSONArray("list")
            if (list == null || list.length() == 0) return false
            // Adversarial review finding (2026-07-16): buildAgentPlanSpec()
            // marks tool.type as "unsupported" for any backend the PlanSpec
            // executor can't run yet (e.g. autonomous "auto" resolving to
            // {type:'cli', cli:'codex'} — the plan executor only supports
            // local/gemini-api/perplexity/cerebras/groq). Routing an
            // unsupported-tool orchestrated agent here would make it refuse
            // to run at all (worse than the pre-fix single-step .sh
            // collapse) instead of falling through to the legacy .sh script,
            // which DOES support every tool type. Only route chain-capable
            // agents whose tool the plan executor can actually run.
            json.optJSONObject("tool")?.optString("type") != "unsupported"
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Re-reads $HOME/.shelly/agents/<id>.json at the innermost run chokepoint
     * and fails closed unless the file exists, its embedded `id` matches the
     * filename, and `enabled` is explicitly true. Mirrors the identical
     * `json.optBoolean("enabled", false)` re-read pattern already used by
     * WidgetAgentRepository.scheduledById() (manual widget taps) and
     * ShellyNotificationListener.findAgentsTriggeredBy() (notification
     * triggers) — this closes the gap for any run path that reaches
     * AgentRuntime without going through one of those two callers, e.g. a
     * straggler AgentAlarmReceiver fire armed before the agent was disabled.
     * Unlike isGloballyHalted() in TerminalSessionService (which fails OPEN to
     * "not halted" on an I/O error to match the JS-side halt-sentinel default),
     * this fails CLOSED to "not enabled" on any error: the whole point of this
     * check is to be a fail-closed backstop against running a disabled agent,
     * so an unreadable/corrupt agent file must refuse the run, not permit it.
     */
    private fun isAgentEnabled(homeDir: File, agentId: String): Boolean {
        val agentFile = File(homeDir, ".shelly/agents/$agentId.json")
        return try {
            if (!agentFile.isFile) return false
            val json = JSONObject(agentFile.readText())
            if (json.optString("id") != agentId) return false
            json.optBoolean("enabled", false)
        } catch (e: Exception) {
            Log.w(TAG, "Failed to read enabled state for $agentId; defaulting to disabled (fail closed)", e)
            false
        }
    }

    private fun trustedPlanLaunch(homeDir: File, agentId: String): TrustedPlanLaunch? {
        val agentFile = File(homeDir, ".shelly/agents/$agentId.json")
        if (!agentFile.isFile) return null
        return try {
            val json = JSONObject(agentFile.readText())
            if (json.optString("id") != agentId) return null
            if (!json.optBoolean("autonomous", false)) return null
            // Multi-action fan-out (2026-07-23, Agent.actions — see its own doc
            // comment in store/types.ts): this whole trust decision is built
            // from the SINGLE legacy `action` field below, so it cannot
            // correctly represent a >= 2-entry `actions` agent (which action's
            // type/appActRecipeId would it even check?). Bail out to the
            // ordinary (non-trusted-fast-path) PlanSpec launch, which still
            // dispatches every entry of `actions` correctly via
            // dispatchActionsTrusted — this only forgoes the narrower "skip the
            // trusted-launch fast path" optimization for a multi-action agent.
            if ((json.optJSONArray("actions")?.length() ?: 0) >= 2) return null
            val actionJson = json.optJSONObject("action")
            val actionType = actionJson
                ?.optString("type")
                ?.takeIf { it.isNotBlank() }
                ?: "draft"
            // app-act (2026-07-14, docs/superpowers/DEFERRED.md's "app-act
            // Tier-B" entry, resolved): the SAME registration-time consent
            // draft/notify's fast-path already required now ALSO covers
            // app-act — no separate opt-in UI needed, the existing Autonomous
            // toggle + on-device tool IS the consent.
            if (actionType != "draft" && actionType != "notify" && actionType != "app-act") return null
            val toolType = json.optJSONObject("tool")
                ?.optString("type")
                ?.takeIf { it.isNotBlank() }
                ?: return null
            // Widened 2026-07-14 (round 2) per project owner directive:
            // chat-confirmed agent.autonomous consent (the Autonomous toggle
            // above) is the trust boundary, not the tool backend --
            // "たとえパープレだろうとCodexだろうと" (even Perplexity or
            // Codex). toolType is still forwarded via --trusted-tool-type so
            // the executor can cross-check it against what the plan file
            // itself carries (defense-in-depth against a tampered/diverged
            // plan) -- see trustedNativeLowRiskAction in
            // scripts/shelly-plan-executor.js. A cloud tool still can't reach
            // this point with a runnable script at all unless
            // autonomousCloudConsent was separately granted at
            // script-generation time (Spec A §4, lib/agent-executor.ts).
            val appActRecipeId = if (actionType == "app-act") {
                actionJson?.optString("appActRecipeId")?.takeIf { it.isNotBlank() } ?: return null
            } else null
            TrustedPlanLaunch(actionType = actionType, toolType = toolType, appActRecipeId = appActRecipeId)
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
