package expo.modules.terminalemulator.scouter

import android.content.Context
import java.io.File
import org.json.JSONArray
import org.json.JSONObject

class ScouterStateStore(context: Context) {
    private val prefs = context.getSharedPreferences("scouter_state", Context.MODE_PRIVATE)
    private val helperStateFile = File(context.filesDir, "home/.scouter-state.json")
    private val lock = Any()

    fun isEnabled(): Boolean = prefs.getBoolean(KEY_ENABLED, false)

    fun setEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_ENABLED, enabled).commit()
        writeHelperState()
    }

    fun getSessionToken(): String {
        val existing = prefs.getString(KEY_TOKEN, null)
        if (!existing.isNullOrBlank()) return existing
        val generated = java.util.UUID.randomUUID().toString().replace("-", "")
        prefs.edit().putString(KEY_TOKEN, generated).commit()
        writeHelperState()
        return generated
    }

    fun setRuntimePort(port: Int) {
        prefs.edit().putInt(KEY_PORT, port).commit()
        writeHelperState()
    }

    fun getRuntimePort(): Int = prefs.getInt(KEY_PORT, -1)

    fun upsert(event: ScouterEvent): SessionSnapshot {
        synchronized(lock) {
            val all = readAllMutable()
            val previous = all[event.sessionId]
            val snapshot = event.toSnapshot(previous)
            all[event.sessionId] = snapshot
            appendRecentEventLocked(event)
            writeAll(all)
            writeHelperStateLocked(all)
            return snapshot
        }
    }

    fun latest(): SessionSnapshot? {
        synchronized(lock) {
            return readAllMutable().values.maxByOrNull { it.lastEventAt }
        }
    }

    fun all(): List<SessionSnapshot> {
        synchronized(lock) {
            return readAllMutable().values.sortedByDescending { it.lastEventAt }
        }
    }

    fun clearSnapshots() {
        synchronized(lock) {
            prefs.edit()
                .putString(KEY_SNAPSHOTS, "[]")
                .putString(KEY_RECENT_EVENTS, "[]")
                .commit()
            writeHelperStateLocked(emptyMap())
        }
    }

    fun debugJson(): JSONObject {
        val recentEvents = readRecentEventJsons()
        return JSONObject().apply {
            put("enabled", isEnabled())
            put("port", getRuntimePort())
            put("recentEventCount", recentEvents.size)
            put("sessions", JSONArray().also { arr ->
                all().forEach { arr.put(it.toJson()) }
            })
            put("recentEvents", JSONArray().also { arr ->
                recentEvents.forEach { arr.put(it) }
            })
        }
    }

    private fun readAllMutable(): MutableMap<String, SessionSnapshot> {
        val raw = prefs.getString(KEY_SNAPSHOTS, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
        val out = mutableMapOf<String, SessionSnapshot>()
        for (i in 0 until arr.length()) {
            val obj = arr.optJSONObject(i) ?: continue
            val snapshot = runCatching { SessionSnapshot.fromJson(obj) }.getOrNull() ?: continue
            out[snapshot.sessionId] = snapshot
        }
        return out
    }

    private fun writeAll(values: Map<String, SessionSnapshot>) {
        val arr = JSONArray()
        values.values.sortedByDescending { it.lastEventAt }.take(20).forEach {
            arr.put(it.toJson())
        }
        prefs.edit().putString(KEY_SNAPSHOTS, arr.toString()).commit()
    }

    private fun appendRecentEventLocked(event: ScouterEvent) {
        if (!shouldKeepRecentEvent(event)) return
        val events = readRecentEventJsons()
        events.add(event.toJson())
        writeRecentEventsLocked(events)
    }

    private fun readRecentEventJsons(): MutableList<JSONObject> {
        val raw = prefs.getString(KEY_RECENT_EVENTS, "[]") ?: "[]"
        val arr = runCatching { JSONArray(raw) }.getOrElse { JSONArray() }
        val out = mutableListOf<JSONObject>()
        for (i in 0 until arr.length()) {
            arr.optJSONObject(i)?.let(out::add)
        }
        return out
    }

    private fun writeRecentEventsLocked(events: List<JSONObject>) {
        val byEventId = LinkedHashMap<String, JSONObject>()
        events
            .sortedBy { it.optLong("timestamp", 0L) }
            .forEach { event ->
                val id = event.optString("eventId").ifBlank {
                    listOf(
                        event.optString("sessionId"),
                        event.optString("eventType"),
                        event.optLong("timestamp", 0L).toString(),
                        event.optString("lastMessage"),
                        event.optString("toolName")
                    ).joinToString("|")
                }
                byEventId[id] = event
            }
        val arr = JSONArray()
        byEventId.values
            .sortedBy { it.optLong("timestamp", 0L) }
            .takeLast(MAX_RECENT_EVENTS)
            .forEach { arr.put(it) }
        prefs.edit().putString(KEY_RECENT_EVENTS, arr.toString()).commit()
    }

    private fun shouldKeepRecentEvent(event: ScouterEvent): Boolean {
        if (event.source != ScouterSource.CODEX) return false
        if (event.eventType == ScouterEventType.USER_PROMPT && !event.lastMessage.isNullOrBlank()) return true
        if (event.derivedStatus == ScouterStatus.IDLE && !event.lastMessage.isNullOrBlank()) return true
        if (event.derivedStatus == ScouterStatus.COMPLETED && !event.lastMessage.isNullOrBlank()) return true
        if (event.eventType == ScouterEventType.PRE_TOOL_USE && !event.toolName.isNullOrBlank()) return true
        if (event.eventType == ScouterEventType.POST_TOOL_USE && (!event.toolName.isNullOrBlank() || !event.commandSummary.isNullOrBlank())) return true
        if (event.eventType == ScouterEventType.POST_TOOL_USE_FAILURE) return true
        if (event.derivedStatus == ScouterStatus.ERROR) return true
        return false
    }

    private fun writeHelperState() {
        synchronized(lock) {
            writeHelperStateLocked(readAllMutable())
        }
    }

    private fun writeHelperStateLocked(values: Map<String, SessionSnapshot>) {
        val token = prefs.getString(KEY_TOKEN, "") ?: ""
        val json = JSONObject().apply {
            put("enabled", isEnabled())
            put("port", getRuntimePort())
            put("hookTokenPreview", if (token.isNotBlank()) token.take(6) + "…" else "")
            put("hookToken", token)
            val recentEvents = readRecentEventJsons()
            put("recentEventCount", recentEvents.size)
            put("sessions", JSONArray().also { arr ->
                values.values.sortedByDescending { it.lastEventAt }.take(20).forEach { arr.put(it.toJson()) }
            })
            put("recentEvents", JSONArray().also { arr ->
                recentEvents.forEach { arr.put(it) }
            })
        }
        helperStateFile.parentFile?.mkdirs()
        val tmp = File(helperStateFile.parentFile, helperStateFile.name + ".tmp")
        tmp.writeText(json.toString(2))
        if (!tmp.renameTo(helperStateFile)) {
            tmp.copyTo(helperStateFile, overwrite = true)
            tmp.delete()
        }
    }

    companion object {
        private const val KEY_ENABLED = "enabled"
        private const val KEY_TOKEN = "session_token"
        private const val KEY_PORT = "runtime_port"
        private const val KEY_SNAPSHOTS = "snapshots"
        private const val KEY_RECENT_EVENTS = "recent_events"
        private const val MAX_RECENT_EVENTS = 120
    }
}
