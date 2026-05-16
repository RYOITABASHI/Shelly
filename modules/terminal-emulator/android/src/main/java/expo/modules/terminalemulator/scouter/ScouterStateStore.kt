package expo.modules.terminalemulator.scouter

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

class ScouterStateStore(context: Context) {
    private val prefs = context.getSharedPreferences("scouter_state", Context.MODE_PRIVATE)
    private val lock = Any()

    fun isEnabled(): Boolean = prefs.getBoolean(KEY_ENABLED, false)

    fun setEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    fun getSessionToken(): String {
        val existing = prefs.getString(KEY_TOKEN, null)
        if (!existing.isNullOrBlank()) return existing
        val generated = java.util.UUID.randomUUID().toString().replace("-", "")
        prefs.edit().putString(KEY_TOKEN, generated).apply()
        return generated
    }

    fun setRuntimePort(port: Int) {
        prefs.edit().putInt(KEY_PORT, port).apply()
    }

    fun getRuntimePort(): Int = prefs.getInt(KEY_PORT, -1)

    fun upsert(event: ScouterEvent): SessionSnapshot {
        synchronized(lock) {
            val all = readAllMutable()
            val previous = all[event.sessionId]
            val snapshot = event.toSnapshot(previous)
            all[event.sessionId] = snapshot
            writeAll(all)
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
            prefs.edit().putString(KEY_SNAPSHOTS, "[]").apply()
        }
    }

    fun debugJson(): JSONObject = JSONObject().apply {
        put("enabled", isEnabled())
        put("port", getRuntimePort())
        put("sessions", JSONArray().also { arr ->
            all().forEach { arr.put(it.toJson()) }
        })
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
        prefs.edit().putString(KEY_SNAPSHOTS, arr.toString()).apply()
    }

    companion object {
        private const val KEY_ENABLED = "enabled"
        private const val KEY_TOKEN = "session_token"
        private const val KEY_PORT = "runtime_port"
        private const val KEY_SNAPSHOTS = "snapshots"
    }
}
