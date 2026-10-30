package expo.modules.terminalemulator.monitor

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.FileObserver
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * Push-only update engine for the MONITOR widgets (battery first):
 *  - nothing runs while no run is active: no polling, no observer, at most
 *    one inexact non-wakeup re-check alarm while a run is shown live;
 *  - a run start/end that native already sees calls the hooks:
 *    AgentRuntime.runAgent -> [runStarted]/[runEnded] (counted: the attended
 *    chain calls it once per step), the attended serial JS chain ->
 *    [chainStarted]/[chainEnded] (TerminalEmulatorModule.notifyMonitorWidget).
 *    The run counts as over only when the last holder is gone
 *    ([MonitorRunHolders]);
 *  - while a run is held (or shown live) a FileObserver (inotify — no CPU
 *    while nothing is written) watches that agent's log dir for
 *    progress.jsonl writes, and a throttled refresh re-reads the file at most
 *    once per [THROTTLE_MS];
 *  - a refresh pushes RemoteViews ONLY when the view model changed, so
 *    tail-only progress writes cost a file read and nothing else. Liveness
 *    (REC blink, noise frame, clock) is ViewFlipper / Chronometer inside the
 *    launcher, not updates from here;
 *  - every run shown live gets one inexact, non-wakeup ELAPSED_REALTIME
 *    alarm at its silence deadline (re-armed on fire while still live), so a
 *    dead run (process killed mid-run, crash, JS reload) cannot keep the
 *    widget "recording" forever; [onAppModuleStart] also refreshes once when
 *    the app comes back.
 * Nothing at all happens when no MONITOR widget is placed.
 */
object MonitorWidgetUpdater {
    private const val TAG = "MonitorWidget"
    private const val THROTTLE_MS = 1_000L
    private const val END_SETTLE_MS = 1_500L
    private const val PREFS = "shelly_monitor_widget"
    private const val KEY_LOCALE = "locale"
    private const val RECHECK_REQUEST_CODE = 9390
    const val ACTION_RECHECK = "expo.modules.terminalemulator.monitor.RECHECK"

    private val executor = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "MonitorWidgetUpdate").apply { isDaemon = true }
    }

    /** agentId -> observer. `explicit` = held (closed when the last holder ends);
     *  otherwise opened because a refresh found the agent's run live. */
    private class Watch(val observer: FileObserver, val explicit: Boolean)

    private val watches = ConcurrentHashMap<String, Watch>()
    private val holders = MonitorRunHolders()
    /** Last pushed render key per provider class (process memory only). */
    private val lastPushed = ConcurrentHashMap<String, Any>()

    @Volatile private var throttled: ScheduledFuture<*>? = null
    /** A re-check alarm is set (process memory; a stale "false" only re-sets it). */
    @Volatile private var recheckArmed = false

    fun providers(): List<Class<out MonitorWidgetProvider>> =
        listOf(MonitorWidgetProvider::class.java, MonitorWidgetSlimProvider::class.java)

    fun hasWidgets(context: Context): Boolean {
        val manager = AppWidgetManager.getInstance(context) ?: return false
        return providers().any { manager.getAppWidgetIds(ComponentName(context, it)).isNotEmpty() }
    }

    // ── hooks ────────────────────────────────────────────────────────────

    /** AgentRuntime.runAgent began for [agentId] (one call per step on the attended chain). */
    fun runStarted(context: Context, agentId: String) = started(context, agentId, chain = false)

    /** AgentRuntime.runAgent returned for [agentId]. */
    fun runEnded(context: Context, agentId: String) = ended(context, agentId, chain = false)

    /** The attended serial JS chain of [agentId] started (it writes progress.jsonl itself). */
    fun chainStarted(context: Context, agentId: String) = started(context, agentId, chain = true)

    /** The attended serial JS chain of [agentId] finished. */
    fun chainEnded(context: Context, agentId: String) = ended(context, agentId, chain = true)

    private fun started(context: Context, agentId: String, chain: Boolean) {
        if (!MonitorWidgetRepository.isSafeAgentId(agentId)) return
        val app = context.applicationContext
        // Holder bookkeeping is synchronous so a start can never be ordered
        // after its own end; the I/O goes to the executor.
        if (chain) holders.startChain(agentId) else holders.startNative(agentId)
        executor.execute {
            runCatching {
                if (!hasWidgets(app)) return@runCatching
                watch(app, agentId, explicit = true)
                refreshNow(app, force = false)
            }.onFailure { Log.w(TAG, "run start hook failed", it) }
        }
    }

    private fun ended(context: Context, agentId: String, chain: Boolean) {
        if (!MonitorWidgetRepository.isSafeAgentId(agentId)) return
        val app = context.applicationContext
        val now = System.currentTimeMillis()
        val released = if (chain) holders.endChain(agentId, now) else holders.endNative(agentId, now)
        executor.execute {
            runCatching {
                if (released) unwatch(agentId)
                if (!hasWidgets(app)) return@runCatching
                refreshNow(app, force = false)
            }.onFailure { Log.w(TAG, "run end hook failed", it) }
        }
        // Trailing writes (run_end flushed after the process exit was seen).
        if (released) {
            executor.schedule(Runnable { runCatching { refreshNow(app, force = false) } }, END_SETTLE_MS, TimeUnit.MILLISECONDS)
        }
    }

    /**
     * TerminalEmulatorModule OnCreate (app start or JS reload): chain marks
     * from a previous JS runtime are orphaned, so drop them (and their
     * watches), then refresh once — a widget left "recording" by a process
     * that died mid-run is corrected as soon as the app is opened again.
     */
    fun onAppModuleStart(context: Context) {
        val app = context.applicationContext
        val released = holders.clearChains(System.currentTimeMillis())
        executor.execute {
            runCatching {
                released.forEach { unwatch(it) }
                if (!hasWidgets(app)) return@runCatching
                refreshNow(app, force = false)
            }.onFailure { Log.w(TAG, "module start refresh failed", it) }
        }
    }

    /** Launcher asked (placement, resize, reboot) or the re-check alarm fired. */
    fun requestUpdate(context: Context, force: Boolean, fromAlarm: Boolean = false, onDone: (() -> Unit)? = null) {
        val app = context.applicationContext
        if (fromAlarm) recheckArmed = false
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
            setRecheck(context, null)
            return
        }
        val snapshot = MonitorWidgetRepository.load(context, holders, System.currentTimeMillis())
        val model = snapshot.model
        reconcileWatches(context, model)
        setRecheck(context, snapshot.recheckDelayMs)

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

    /** Arm (delay != null) or cancel the inexact, non-wakeup re-check alarm. */
    private fun setRecheck(context: Context, delayMs: Long?) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        if (delayMs == null) {
            if (!recheckArmed) return
            runCatching { alarms.cancel(recheckIntent(context)) }
            recheckArmed = false
            return
        }
        // Re-arming replaces the pending one (same PendingIntent); doing it
        // once per armed period keeps this off the per-event path.
        if (recheckArmed) return
        runCatching {
            alarms.set(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + delayMs, recheckIntent(context))
            recheckArmed = true
        }.onFailure { Log.w(TAG, "re-check alarm failed", it) }
    }

    private fun recheckIntent(context: Context): PendingIntent {
        val intent = Intent(context, MonitorWidgetProvider::class.java).setAction(ACTION_RECHECK)
        return PendingIntent.getBroadcast(
            context,
            RECHECK_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    /** Keep an observer on held runs and on the shown live run; drop stale auto ones. */
    private fun reconcileWatches(context: Context, model: MonitorWidgetModel.Model?) {
        val liveAgent = model?.takeIf { it.live }?.agentId
        for ((agentId, w) in watches) {
            val held = holders.isHeld(agentId)
            if (w.explicit && !held) {
                unwatch(agentId)
            } else if (!w.explicit && agentId != liveAgent) {
                unwatch(agentId)
            }
        }
        if (liveAgent != null && !watches.containsKey(liveAgent)) watch(context, liveAgent, explicit = false)
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
