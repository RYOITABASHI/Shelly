package expo.modules.terminalemulator

import org.json.JSONArray
import org.json.JSONObject

/**
 * Which `shelly agent add` requests came in through an MCP run_command that
 * native ran headless (McpRawToolConsumer) — the native counterpart of the
 * window half of lib/mcp-ingress-origin.ts (the marker half needs nothing:
 * the SHELLY_INGRESS* prefix is in the command native runs).
 *
 * RN's own windows live in RN memory, which the native path cannot reach and
 * which may not be running. So native records, in THIS process's memory
 * only, (a) one window {callId, principal, start, end} per command, and (b)
 * the request ids that appeared in $HOME while it ran; RN pulls both
 * (TerminalEmulatorModule.getMcpNativeIngress) before it classifies agent
 * requests (lib/mcp-native-ingress.ts), so the agent created from one is
 * marked exactly as for an RN-run command. Memory, not a file: nothing that
 * runs as the app uid can delete a mark (a forged one would only add taint).
 * Lost when the process dies, like RN's own windows.
 *
 * Retention: a window is kept [RETAIN_MS] after it ended (RN may only drain
 * the request when Shelly comes back to the foreground), bounded by count.
 */
object McpNativeIngress {
    const val RETAIN_MS = 6 * 60 * 60 * 1000L
    private const val MAX_WINDOWS = 64
    private const val MAX_REQUESTS = 256

    data class Window(val callId: String, val principal: String, val startMs: Long, var endMs: Long?)
    data class Request(val reqId: String, val callId: String, val principal: String, val seenAtMs: Long)

    private val windows = ArrayList<Window>()
    private val requests = LinkedHashMap<String, Request>()

    @Synchronized
    fun begin(callId: String, principal: String, nowMs: Long = System.currentTimeMillis()) {
        prune(nowMs)
        windows.add(Window(McpRawToolDecision.safeIngressValue(callId), McpRawToolDecision.safeIngressValue(principal), nowMs, null))
    }

    @Synchronized
    fun end(callId: String, nowMs: Long = System.currentTimeMillis()) {
        val id = McpRawToolDecision.safeIngressValue(callId)
        for (w in windows) if (w.callId == id && w.endMs == null) w.endMs = nowMs
        prune(nowMs)
    }

    /** A request file that appeared in $HOME while the command ran. The first origin wins. */
    @Synchronized
    fun noteRequest(reqId: String, callId: String, principal: String, nowMs: Long = System.currentTimeMillis()) {
        if (requests.containsKey(reqId)) return
        requests[reqId] = Request(reqId, McpRawToolDecision.safeIngressValue(callId), McpRawToolDecision.safeIngressValue(principal), nowMs)
        while (requests.size > MAX_REQUESTS) requests.remove(requests.keys.first())
    }

    private fun prune(nowMs: Long) {
        windows.removeAll { w -> w.endMs.let { it != null && nowMs - it > RETAIN_MS } }
        while (windows.size > MAX_WINDOWS) {
            val idx = windows.indexOfFirst { it.endMs != null }
            if (idx < 0) break
            windows.removeAt(idx)
        }
        val it = requests.values.iterator()
        while (it.hasNext()) if (nowMs - it.next().seenAtMs > RETAIN_MS) it.remove()
    }

    /** {windows:[{callId,principal,start,end|null}], requests:[{reqId,callId,principal}]} for RN. */
    @Synchronized
    fun snapshotJson(nowMs: Long = System.currentTimeMillis()): String {
        prune(nowMs)
        val ws = JSONArray()
        for (w in windows) {
            ws.put(JSONObject().put("callId", w.callId).put("principal", w.principal).put("start", w.startMs).put("end", w.endMs ?: JSONObject.NULL))
        }
        val rs = JSONArray()
        for (r in requests.values) rs.put(JSONObject().put("reqId", r.reqId).put("callId", r.callId).put("principal", r.principal))
        return JSONObject().put("windows", ws).put("requests", rs).toString()
    }

    /** Test hook. */
    @Synchronized
    fun clearForTests() {
        windows.clear()
        requests.clear()
    }
}
