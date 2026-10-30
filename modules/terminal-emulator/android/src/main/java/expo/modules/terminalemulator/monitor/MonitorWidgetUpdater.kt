package expo.modules.terminalemulator.monitor

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.os.FileObserver
import android.util.Log
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Push-only update engine for the MONITOR widgets (battery first):
 *  - nothing runs while no run is active: no alarm, no polling, no observer;
 *  - a run start/end that native already sees (AgentRuntime.runAgent, and the
 *    attended serial JS chain via TerminalEmulatorModule.notifyMonitorWidget)
 *    calls [runStarted] / [runEnded];
 *  - while a run is active a FileObserver (inotify — no CPU while nothing is
 *    written) watches that agent's log dir for progress.jsonl writes, and a
 *    throttled refresh re-reads the file at most once per [THROTTLE_MS];
 *  - a refresh pushes RemoteViews ONLY when the view model changed, so
 *    tail-only progress writes cost a file read and nothing else. Liveness
 *    (REC blink, noise frame, clock) is ViewFlipper / Chronometer inside the
 *    launcher, not updates from here.
 * Nothing at all happens when no MONITOR widget is placed.
 */
object MonitorWidgetUpdater {
    private const val TAG = "MonitorWidget"
    private const val THROTTLE_MS = 1_000L
    private const val END_SETTLE_MS = 1_500L
    private const val PREFS = "shelly_monitor_widget"
    private const val KEY_LOCALE = "locale"

    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "MonitorWidgetUpdate").apply { isDaemon = true }
    }

    /** agentId -> observer. `explicit` = opened by runStarted (closed by runEnded);
     *  otherwise opened because a refresh found the agent's run live. */
    private class Watch(val observer: FileObserver, val explicit: Boolean)

    private val watches = ConcurrentHashMap<String, Watch>()
    /** agentId -> wall time native last saw that agent's run end. */
    private val endedAt = ConcurrentHashMap<String, Long>()
    /** Last pushed render key per provider class (process memory only). */
    private val lastPushed = ConcurrentHashMap<String, Any>()

    @Volatile private var throttled: ScheduledFuture<*>? = null
    @Volatile private var silenceCheck: ScheduledFuture<*>? = null

    fun providers(): List<Class<out MonitorWidgetProvider>> =
        listOf(MonitorWidgetProvider::class.java, MonitorWidgetSlimProvider::class.java)

    fun hasWidgets(context: Context): Boolean {
        val manager = AppWidgetManager.getInstance(context) ?: return false
        return providers().any { manager.getAppWidgetIds(ComponentName(context, it)).isNotEmpty() }
    }

    // ── hooks ────────────────────────────────────────────────────────────

    fun runStarted(context: Context, agentId: String) {
        val app = context.applicationContext
        executor.execute {
            runCatching {
                if (!MonitorWidgetRepository.isSafeAgentId(agentId) || !hasWidgets(app)) return@runCatching
                endedAt.remove(agentId)
                watch(app, agentId, explicit = true)
                refreshNow(app, force = false)
            }.onFailure { Log.w(TAG, "runStarted failed", it) }
        }
    }

    fun runEnded(context: Context, agentId: String) {
        val app = context.applicationContext
        executor.execute {
            runCatching {
                if (!MonitorWidgetRepository.isSafeAgentId(agentId)) return@runCatching
                endedAt[agentId] = System.currentTimeMillis()
                unwatch(agentId)
                if (!hasWidgets(app)) return@runCatching
                refreshNow(app, force = false)
            }.onFailure { Log.w(TAG, "runEnded failed", it) }
        }
        // Trailing writes (run_end flushed after the process exit was seen).
        executor.schedule(Runnable { runCatching { refreshNow(app, force = false) } }, END_SETTLE_MS, TimeUnit.MILLISECONDS)
    }

    /** Launcher asked (placement, resize, reboot): always push. */
    fun requestUpdate(context: Context, force: Boolean, onDone: (() -> Unit)? = null) {
        val app = context.applicationContext
        executor.execute {
            try {
                refreshNow(app, force)
            } catch (e: Throwable) {
                Log.w(TAG, "refresh failed", e)
            } finally {
                onDone?.invoke()
            }
        }
    }

    /** App language mirror (lib/i18n), so widget text and currency follow the app. */
    fun setLocale(context: Context, locale: String?) {
        val app = context.applicationContext
        val normalized = locale?.takeIf { it == "ja" || it == "en" }
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_LOCALE, null) == normalized) return
        prefs.edit().putString(KEY_LOCALE, normalized).apply()
        if (hasWidgets(app)) requestUpdate(app, force = true)
    }

    fun appLocale(context: Context): String? =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LOCALE, null)

    // ── internals (executor thread) ──────────────────────────────────────

    private fun scheduleThrottled(context: Context) {
        if (throttled?.isDone == false) return
        throttled = executor.schedule(Runnable {
            runCatching { refreshNow(context, force = false) }.onFailure { Log.w(TAG, "refresh failed", it) }
        }, THROTTLE_MS, TimeUnit.MILLISECONDS)
    }

    private fun refreshNow(context: Context, force: Boolean) {
        val manager = AppWidgetManager.getInstance(context) ?: return
        val targets = providers().map { it to manager.getAppWidgetIds(ComponentName(context, it)) }
            .filter { it.second.isNotEmpty() }
        if (targets.isEmpty()) {
            dropAllWatches()
            return
        }
        val now = System.currentTimeMillis()
        val snapshot = MonitorWidgetRepository.load(context, now) { agentId -> endedAt[agentId] }
        val model = snapshot.model
        reconcileWatches(context, model)
        scheduleSilenceCheck(context, model, now)

        val locale = appLocale(context)
        for ((cls, ids) in targets) {
            val slim = cls == MonitorWidgetSlimProvider::class.java
            val key = listOf(model, snapshot.agentName, locale, slim)
            if (!force && lastPushed[cls.name] == key) continue
            val views = MonitorWidgetRenderer.render(context, snapshot, slim, locale)
            ids.forEach { id ->
                runCatching { manager.updateAppWidget(id, views) }
                    .onFailure { Log.w(TAG, "updateAppWidget failed id=$id", it) }
            }
            lastPushed[cls.name] = key
        }
    }

    /** Keep an observer on the shown live run's agent; drop stale auto ones. */
    private fun reconcileWatches(context: Context, model: MonitorWidgetModel.Model?) {
        val liveAgent = model?.takeIf { it.live }?.agentId
        for ((agentId, w) in watches) {
            if (!w.explicit && agentId != liveAgent) unwatch(agentId)
        }
        if (liveAgent != null && !watches.containsKey(liveAgent)) watch(context, liveAgent, explicit = false)
    }

    /** A live run nothing native vouches for (no runtime, no JS chain mark)
     *  must stop "recording" once it goes silent; nothing else would wake us. */
    private fun scheduleSilenceCheck(context: Context, model: MonitorWidgetModel.Model?, now: Long) {
        silenceCheck?.cancel(false)
        silenceCheck = null
        if (model == null || !model.live || watches[model.agentId]?.explicit == true) return
        silenceCheck = executor.schedule(Runnable {
            runCatching { refreshNow(context, force = false) }
        }, MonitorWidgetModel.SILENT_RUN_AFTER_MS + 1_000L, TimeUnit.MILLISECONDS)
    }

    private fun watch(context: Context, agentId: String, explicit: Boolean) {
        val existing = watches[agentId]
        if (existing != null) {
            if (explicit && !existing.explicit) {
                watches[agentId] = Watch(existing.observer, explicit = true)
            }
            return
        }
        val dir = File(MonitorWidgetRepository.logsDir(context), agentId)
        val observer = if (dir.isDirectory) {
            progressObserver(context, dir)
        } else {
            // First run of a new agent: its log dir appears once the run
            // writes; watch the parent for it, then swap to the real one.
            parentObserver(context, agentId)
        } ?: return
        watches[agentId] = Watch(observer, explicit)
    }

    private fun unwatch(agentId: String) {
        watches.remove(agentId)?.let { runCatching { it.observer.stopWatching() } }
    }

    private fun dropAllWatches() {
        for (id in watches.keys.toList()) unwatch(id)
        silenceCheck?.cancel(false)
        silenceCheck = null
    }

    @Suppress("DEPRECATION")
    private fun progressObserver(context: Context, dir: File): FileObserver? {
        val mask = FileObserver.MODIFY or FileObserver.CLOSE_WRITE or FileObserver.MOVED_TO or FileObserver.CREATE
        val observer = object : FileObserver(dir.path, mask) {
            override fun onEvent(event: Int, path: String?) {
                if (path == "progress.jsonl" || path == "checkpoint.json") scheduleThrottled(context)
            }
        }
        return runCatching { observer.startWatching(); observer }
            .onFailure { Log.w(TAG, "watch failed for ${dir.name}", it) }
            .getOrNull()
    }

    @Suppress("DEPRECATION")
    private fun parentObserver(context: Context, agentId: String): FileObserver? {
        val logs = MonitorWidgetRepository.logsDir(context)
        if (!logs.isDirectory) return null
        val observer = object : FileObserver(logs.path, FileObserver.CREATE or FileObserver.MOVED_TO) {
            override fun onEvent(event: Int, path: String?) {
                if (path != agentId) return
                executor.execute {
                    val current = watches[agentId] ?: return@execute
                    if (current.observer !== this) return@execute
                    runCatching { stopWatching() }
                    val dir = File(logs, agentId)
                    val next = progressObserver(context, dir)
                    if (next != null) watches[agentId] = Watch(next, current.explicit) else watches.remove(agentId)
                    scheduleThrottled(context)
                }
            }
        }
        return runCatching { observer.startWatching(); observer }.getOrNull()
    }
}
