package expo.modules.terminalemulator.scouter

import android.content.Context
import android.util.Log
import expo.modules.terminalemulator.HomeInitializer
import org.json.JSONObject

class ScouterLifecycleService private constructor(private val context: Context) {
    private val appContext = context.applicationContext
    private val store = ScouterStateStore(appContext)
    private val notificationDispatcher = NotificationDispatcher(appContext)
    private var server: HookHttpServer? = null
    private var watcher: JsonlWatcher? = null
    private val longRunningChecks = mutableMapOf<String, Long>()

    @Synchronized
    fun start() {
        store.setEnabled(true)
        val token = store.getSessionToken()
        if (server == null) {
            server = HookHttpServer(token) { handleEvent(it) }.also {
                store.setRuntimePort(it.start())
            }
        }
        if (watcher == null) {
            watcher = JsonlWatcher(HomeInitializer.getHomeDir(appContext)) { handleEvent(it) }.also { it.start() }
        }
        handleEvent(ShellyStateBridge.snapshot())
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
        ScouterWidgetProvider.updateAll(appContext)
    }

    @Synchronized
    fun ensureStartedIfEnabled() {
        if (store.isEnabled()) start()
    }

    fun isEnabled(): Boolean = store.isEnabled()

    fun debugJson(): JSONObject {
        val base = store.debugJson()
        base.put("systemLoad", ScouterSystemSampler(appContext).sample().toJson())
        base.put("serverRunning", server != null)
        base.put("jsonlWatcherRunning", watcher != null)
        base.put("hookTokenPreview", store.getSessionToken().take(6) + "…")
        base.put("codexHookUrl", hookUrl("codex"))
        base.put("localHookUrl", hookUrl("local"))
        base.put("localLlmEndpoints", "http://127.0.0.1:8080, http://127.0.0.1:11434")
        return base
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

    private fun handleEvent(event: ScouterEvent) {
        val snapshot = store.upsert(event)
        Log.i(TAG, "event source=${event.source} type=${event.eventType} status=${event.derivedStatus} session=${event.sessionId}")
        ScouterWidgetProvider.updateAll(appContext)
        notificationDispatcher.maybeNotify(event, snapshot)
        scheduleLongRunningCheck(snapshot)
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
            }
        }, "ScouterLongRunningCheck").apply {
            isDaemon = true
            start()
        }
    }

    companion object {
        private const val TAG = "Scouter"
        private const val LONG_RUNNING_THRESHOLD_MS = 120_000L
        @Volatile private var instance: ScouterLifecycleService? = null

        fun get(context: Context): ScouterLifecycleService {
            return instance ?: synchronized(this) {
                instance ?: ScouterLifecycleService(context).also { instance = it }
            }
        }
    }
}
