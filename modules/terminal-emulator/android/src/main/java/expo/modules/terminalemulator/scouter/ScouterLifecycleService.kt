package expo.modules.terminalemulator.scouter

import android.content.Context
import android.os.SystemClock
import android.util.Log
import expo.modules.terminalemulator.HomeInitializer
import expo.modules.terminalemulator.TerminalSessionService
import java.io.File
import org.json.JSONObject

class ScouterLifecycleService private constructor(private val context: Context) {
    private val appContext = context.applicationContext
    private val store = ScouterStateStore(appContext)
    private val notificationDispatcher by lazy { NotificationDispatcher(appContext) }
    private var server: HookHttpServer? = null
    private var watcher: JsonlWatcher? = null
    private val longRunningChecks = mutableMapOf<String, Long>()
    private val widgetRefreshLock = Any()
    @Volatile private var lastWidgetRefreshAtMs = 0L
    @Volatile private var trailingWidgetRefreshScheduled = false
    @Volatile private var eventSink: ((ScouterEvent, SessionSnapshot) -> Unit)? = null
    // Live PTS poll: detects blocking Codex states (interactive numbered menu /
    // passive usage-limit banner) that emit NO JSONL event, so the existing
    // widget render + notification paths can surface them. Purely additive and
    // fully guarded — a poll failure never touches existing flows.
    @Volatile private var pollThread: Thread? = null
    @Volatile private var pollRunning = false
    @Volatile private var lastLiveStateKey: String? = null

    fun setEventSink(sink: ((ScouterEvent, SessionSnapshot) -> Unit)?) {
        eventSink = sink
    }

    @Synchronized
    fun start() {
        store.setEnabled(true)
        val token = store.getSessionToken()
        if (server == null) {
            val newServer = HookHttpServer(token) { handleEvent(it) }
            runCatching {
                val port = newServer.start()
                store.setRuntimePort(port)
                server = newServer
            }.onFailure { error ->
                runCatching { newServer.stop() }
                    .onFailure { Log.w(TAG, "Failed to clean up Hook server after start failure", it) }
                runCatching { store.setRuntimePort(-1) }
                    .onFailure { Log.w(TAG, "Failed to reset Scouter runtime port after start failure", it) }
                throw error
            }
        }
        if (watcher == null) {
            val newWatcher = JsonlWatcher(
                homeDir = HomeInitializer.getHomeDir(appContext),
                codexBackfillSessionIds = {
                    setOfNotNull(store.widgetCodexBinding()?.codexSessionId)
                },
                onEvent = { handleEvent(it) }
            )
            runCatching {
                newWatcher.start()
                watcher = newWatcher
            }.onFailure { error ->
                runCatching { newWatcher.stop() }
                    .onFailure { Log.w(TAG, "Failed to clean up JSONL watcher after start failure", it) }
                throw error
            }
        }
        handleEvent(ShellyStateBridge.snapshot(), forceWidgetRefresh = true)
        // Additive: start the live PTS poll once. Independent of the watcher/
        // server above; never alters their behavior.
        if (pollThread == null) {
            pollRunning = true
            pollThread = Thread({ livePollLoop() }, "ScouterLivePtsPoll").apply {
                isDaemon = true
                start()
            }
        }
    }

    @Synchronized
    fun stop() {
        store.setEnabled(false)
        server?.stop()
        watcher?.stop()
        server = null
        watcher = null
        store.setRuntimePort(-1)
        store.clearSnapshots()
        longRunningChecks.clear()
        // Additive: tear down the live PTS poll.
        pollRunning = false
        pollThread?.interrupt()
        pollThread = null
        lastLiveStateKey = null
        requestWidgetRefresh(force = true, reason = "stop")
    }

    @Synchronized
    fun ensureStartedIfEnabled() {
        if (!store.isEnabled()) return
        runCatching { start() }
            .onFailure { Log.w(TAG, "Scouter autostart failed; keeping Shelly startup alive", it) }
    }

    fun isEnabled(): Boolean = store.isEnabled()

    fun debugJson(): JSONObject {
        val base = store.debugJson()
        val systemLoad = runCatching { ScouterSystemSampler(appContext).sample().toJson() }
            .getOrElse { error ->
                Log.w(TAG, "System load debug sample failed", error)
                JSONObject().apply {
                    put("sampledAt", System.currentTimeMillis())
                    put("error", error.javaClass.simpleName)
                }
            }
        base.put("systemLoad", systemLoad)
        base.put("serverRunning", server != null)
        base.put("jsonlWatcherRunning", watcher != null)
        base.put("jsonlWatcher", watcher?.debugJson() ?: JSONObject().apply {
            put("running", false)
            put("codexSessionsRoot", File(HomeInitializer.getHomeDir(appContext), ".codex/sessions").absolutePath.redactForScouter())
        })
        base.put("hookTokenPreview", store.getSessionToken().take(6) + "…")
        base.put("codexHookUrl", hookUrl("codex"))
        base.put("localHookUrl", hookUrl("local"))
        base.put("localLlmEndpoints", "http://127.0.0.1:8080, http://127.0.0.1:11434")
        return base
    }

    @Synchronized
    fun refreshJson(): JSONObject {
        if (store.isEnabled()) {
            if (server == null || watcher == null) start()
            watcher?.scanNow()
        }
        return debugJson()
    }

    fun hookTemplate(source: String): JSONObject {
        val prefix = when (source.lowercase()) {
            "codex" -> "codex"
            "local", "llm", "local_llm" -> "local"
            else -> "codex"
        }
        return JSONObject().apply {
            put("tokenHeader", "X-Scouter-Token")
            put("token", store.getSessionToken())
            put("baseUrl", "http://127.0.0.1:${store.getRuntimePort()}/hook/$prefix")
        }
    }

    private fun hookUrl(source: String): String {
        val port = store.getRuntimePort()
        return if (port > 0) "http://127.0.0.1:$port/hook/$source" else ""
    }

    private fun handleEvent(event: ScouterEvent, forceWidgetRefresh: Boolean = false) {
        val snapshot = runCatching { store.upsert(event) }
            .getOrElse {
                Log.w(TAG, "Dropping Scouter event after store failure source=${event.source} type=${event.eventType}", it)
                return
            }
        Log.i(TAG, "event source=${event.source} type=${event.eventType} status=${event.derivedStatus} session=${event.sessionId}")
        runCatching { eventSink?.invoke(event, snapshot) }
            .onFailure { Log.w(TAG, "JS Scouter event dispatch failed", it) }
        requestWidgetRefresh(force = forceWidgetRefresh, reason = "event")
        runCatching {
            // Resolve the bound-Codex conversation only when this event belongs to
            // the widget-bound session; otherwise the approval/choice notifications
            // (anchored on that conversation) must not fire. Reply/rate notifications
            // are driven off the snapshot itself and remain null-safe.
            val binding = store.widgetCodexBinding()
            val isBoundEvent = binding != null &&
                normalizeCodexSessionId(event.sessionId) != null &&
                normalizeCodexSessionId(event.sessionId) == normalizeCodexSessionId(binding.codexSessionId)
            val conversation = if (isBoundEvent) {
                runCatching { store.widgetConversation(binding?.codexSessionId) }.getOrNull()
            } else null
            notificationDispatcher.maybeNotify(
                event = event,
                snapshot = snapshot,
                conversation = conversation,
                boundPtySessionId = if (isBoundEvent) binding?.ptySessionId else null
            )
        }
            .onFailure { Log.w(TAG, "Notification dispatch failed after Scouter event", it) }
        runCatching { scheduleLongRunningCheck(snapshot) }
            .onFailure { Log.w(TAG, "Long-running check scheduling failed", it) }
    }

    // Mirrors ScouterWidgetProvider/PromptActivity: strip a trailing UUID suffix
    // so codex rollout session ids compare equal to the bound id regardless of
    // any path/prefix decoration.
    private fun normalizeCodexSessionId(sessionId: String?): String? {
        val trimmed = sessionId?.trim().orEmpty()
        if (trimmed.isBlank()) return null
        return CODEX_SESSION_UUID_SUFFIX_RE.find(trimmed)?.groupValues?.getOrNull(1) ?: trimmed
    }

    private fun requestWidgetRefresh(force: Boolean, reason: String) {
        val now = SystemClock.uptimeMillis()
        if (force) {
            synchronized(widgetRefreshLock) {
                trailingWidgetRefreshScheduled = false
                lastWidgetRefreshAtMs = now
            }
            triggerWidgetRefresh(force = true, reason = reason)
            return
        }

        val delayMs = synchronized(widgetRefreshLock) {
            val elapsed = now - lastWidgetRefreshAtMs
            if (elapsed >= WIDGET_REFRESH_MIN_INTERVAL_MS) {
                lastWidgetRefreshAtMs = now
                trailingWidgetRefreshScheduled = false
                0L
            } else {
                if (trailingWidgetRefreshScheduled) return
                trailingWidgetRefreshScheduled = true
                WIDGET_REFRESH_MIN_INTERVAL_MS - elapsed
            }
        }

        if (delayMs == 0L) {
            triggerWidgetRefresh(force = false, reason = reason)
            return
        }

        Thread({
            try {
                Thread.sleep(delayMs)
                synchronized(widgetRefreshLock) {
                    trailingWidgetRefreshScheduled = false
                    lastWidgetRefreshAtMs = SystemClock.uptimeMillis()
                }
                triggerWidgetRefresh(force = true, reason = "$reason.trailing")
            } catch (_: InterruptedException) {
                synchronized(widgetRefreshLock) { trailingWidgetRefreshScheduled = false }
            }
        }, "ScouterWidgetRefreshDelay").apply {
            isDaemon = true
            start()
        }
    }

    private fun triggerWidgetRefresh(force: Boolean, reason: String) {
        runCatching { ScouterWidgetProvider.updateAll(appContext, force = force) }
            .onFailure { Log.w(TAG, "Widget refresh failed after Scouter $reason", it) }
    }

    @Synchronized
    private fun scheduleLongRunningCheck(snapshot: SessionSnapshot) {
        if (snapshot.currentStatus != ScouterStatus.TOOL_RUNNING) return
        longRunningChecks[snapshot.sessionId] = snapshot.lastEventAt
        Thread({
            try {
                Thread.sleep(LONG_RUNNING_THRESHOLD_MS)
                val latest = store.all().firstOrNull { it.sessionId == snapshot.sessionId }
                val expectedStartedAt = synchronized(this) { longRunningChecks[snapshot.sessionId] }
                if (
                    expectedStartedAt == snapshot.lastEventAt &&
                    latest?.currentStatus == ScouterStatus.TOOL_RUNNING &&
                    latest.lastEventAt == snapshot.lastEventAt
                ) {
                    notificationDispatcher.notifyLongRunning(latest)
                }
            } catch (_: InterruptedException) {
                // Best-effort timer; Scouter Phase 1A has no foreground worker.
            } catch (error: Throwable) {
                Log.w(TAG, "Long-running check failed", error)
            }
        }, "ScouterLongRunningCheck").apply {
            isDaemon = true
            start()
        }
    }

    // --- Live PTS poll (additive) --------------------------------------------
    // Background loop that classifies the bound Codex PTS screen and surfaces
    // blocking states that emit no JSONL event. Everything below is wrapped in
    // runCatching so a poll failure can never disturb event/widget/notification
    // flows. It only WRITES widget choice-pending state for the INTERACTIVE case
    // (the gap this closes); APPROVAL and READY/INACTIVE leave existing state
    // untouched.

    private fun livePollLoop() {
        var lastHeartbeatAt = SystemClock.uptimeMillis()
        while (pollRunning) {
            val interval = runCatching { pollOnce() }
                .onFailure { Log.w(TAG, "live pts poll failed", it) }
                .getOrDefault(POLL_IDLE_MS)
            // Heartbeat: the widget has updatePeriodMillis=0 and only re-renders on
            // events, so an idle session freezes CPU/RAM/clock/footer indefinitely.
            // Force a refresh ~every WIDGET_HEARTBEAT_MS to keep them current even
            // when nothing is happening. Best-effort; never disturbs the poll.
            val now = SystemClock.uptimeMillis()
            if (now - lastHeartbeatAt >= WIDGET_HEARTBEAT_MS) {
                lastHeartbeatAt = now
                runCatching { requestWidgetRefresh(force = true, reason = "heartbeat") }
                    .onFailure { Log.w(TAG, "heartbeat widget refresh failed", it) }
            }
            try {
                Thread.sleep(interval)
            } catch (ie: InterruptedException) {
                break
            }
        }
    }

    private fun pollOnce(): Long {
        val binding = store.widgetCodexBinding() ?: return POLL_IDLE_MS
        val pty = binding.ptySessionId?.takeIf { it.isNotBlank() } ?: return POLL_IDLE_MS
        val session = TerminalSessionService.sessionRegistry[pty] ?: return POLL_IDLE_MS
        if (!session.isAlive()) return POLL_IDLE_MS
        val screen = runCatching { session.getScreenText() }.getOrDefault("")
        val result = CodexScreenInspect.classify(screen)

        val key = "${binding.codexSessionId}|${result.state}|${result.summary}|" +
            result.choices.joinToString { it.index.toString() }

        // INACTIVE/READY: nothing is blocking. Reset the dedup signature and
        // leave ALL store state alone (existing flows own non-blocking states),
        // but drop any live usage-limit override now that the banner is gone so
        // the widget stops showing "RATE LIMITED" once the cap clears.
        if (result.state == CodexScreenInspect.State.INACTIVE ||
            result.state == CodexScreenInspect.State.READY
        ) {
            lastLiveStateKey = null
            if (store.clearWidgetUsageLimited()) {
                requestWidgetRefresh(force = true, reason = "live-poll-rate-clear")
            }
            return POLL_ACTIVE_MS
        }

        // Refresh the usage-limit override on EVERY tick the banner is up so a
        // long-lived cap never ages out of the store freshness window. This write
        // is widget-only and cheap; the notification + forced refresh below stay
        // deduped so a persistent banner doesn't spam. For the other blocking
        // states (INTERACTIVE/APPROVAL) the cap is no longer the live screen, so
        // drop any lingering override — otherwise a direct RATE_LIMITED → menu
        // transition (never passing through READY/INACTIVE) would co-render a
        // stale "RATE LIMITED" line alongside the choice/approval UI.
        if (result.state == CodexScreenInspect.State.RATE_LIMITED) {
            store.recordWidgetUsageLimited(result.summary)
        } else if (store.clearWidgetUsageLimited()) {
            requestWidgetRefresh(force = true, reason = "live-poll-rate-clear")
        }

        // Already surfaced this exact blocking state — no notification/refresh spam.
        val isNewState = key != lastLiveStateKey
        if (!isNewState) return POLL_ACTIVE_MS
        lastLiveStateKey = key

        when (result.state) {
            CodexScreenInspect.State.INTERACTIVE -> {
                store.recordWidgetChoicePending(result.summary, result.choices)
                requestWidgetRefresh(force = true, reason = "live-poll-choice")
                val snap = store.all().firstOrNull {
                    it.source == ScouterSource.CODEX &&
                        normalizeCodexSessionId(it.sessionId) ==
                        normalizeCodexSessionId(binding.codexSessionId)
                }
                val convo = runCatching { store.widgetConversation(binding.codexSessionId) }.getOrNull()
                if (snap != null) {
                    notificationDispatcher.notifyChoiceWaitingNow(snap, convo, binding.ptySessionId)
                }
            }
            CodexScreenInspect.State.RATE_LIMITED -> {
                // Passive usage-limit banner (no menu): the override is already
                // recorded above. Push it to the widget and fire a deduped
                // notification off the snapshot.
                requestWidgetRefresh(force = true, reason = "live-poll-rate")
                val snap = store.all().firstOrNull {
                    it.source == ScouterSource.CODEX &&
                        normalizeCodexSessionId(it.sessionId) ==
                        normalizeCodexSessionId(binding.codexSessionId)
                }
                if (snap != null) {
                    notificationDispatcher.notifyUsageLimitedNow(snap, result.summary)
                }
            }
            CodexScreenInspect.State.APPROVAL -> {
                // Existing JSONL WAITING_PERMISSION path + widget live-render already
                // handle approvals — do not duplicate here.
            }
            else -> Unit
        }
        return POLL_ACTIVE_MS
    }

    companion object {
        private const val TAG = "Scouter"
        private const val LONG_RUNNING_THRESHOLD_MS = 120_000L
        private const val POLL_ACTIVE_MS = 6_000L
        private const val POLL_IDLE_MS = 15_000L
        private const val WIDGET_HEARTBEAT_MS = 60_000L
        private val CODEX_SESSION_UUID_SUFFIX_RE =
            Regex("""([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$""")
        @Volatile private var instance: ScouterLifecycleService? = null

        fun get(context: Context): ScouterLifecycleService {
            return instance ?: synchronized(this) {
                instance ?: ScouterLifecycleService(context).also { instance = it }
            }
        }

        private const val WIDGET_REFRESH_MIN_INTERVAL_MS = 1_000L
    }
}
