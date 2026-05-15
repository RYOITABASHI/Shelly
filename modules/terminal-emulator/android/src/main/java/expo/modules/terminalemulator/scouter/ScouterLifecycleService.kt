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
        ScouterWidgetProvider.updateAll(appContext)
    }

    @Synchronized
    fun ensureStartedIfEnabled() {
        if (store.isEnabled()) start()
    }

    fun isEnabled(): Boolean = store.isEnabled()

    fun debugJson(): JSONObject {
        val base = store.debugJson()
        base.put("serverRunning", server != null)
        base.put("jsonlWatcherRunning", watcher != null)
        base.put("hookToken", store.getSessionToken())
        base.put("claudeHookUrl", hookUrl("cc"))
        base.put("codexHookUrl", hookUrl("codex"))
        return base
    }

    fun hookTemplate(source: String): JSONObject {
        val prefix = if (source == "codex") "codex" else "cc"
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
    }

    companion object {
        private const val TAG = "Scouter"
        @Volatile private var instance: ScouterLifecycleService? = null

        fun get(context: Context): ScouterLifecycleService {
            return instance ?: synchronized(this) {
                instance ?: ScouterLifecycleService(context).also { instance = it }
            }
        }
    }
}

