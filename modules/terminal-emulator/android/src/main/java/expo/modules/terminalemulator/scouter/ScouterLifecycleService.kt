package expo.modules.terminalemulator.scouter

import android.content.Context
import android.os.SystemClock
import android.util.Log
import expo.modules.terminalemulator.HomeInitializer
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
            val newWatcher = JsonlWatcher(HomeInitializer.getHomeDir(appContext)) { handleEvent(it) }
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

    companion object {
        private const val TAG = "Scouter"
        private const val LONG_RUNNING_THRESHOLD_MS = 120_000L
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
