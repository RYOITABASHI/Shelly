package expo.modules.terminalemulator

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.security.SecureRandom
import org.json.JSONObject

/**
 * Tailscale for the connectivity guardian.
 *
 * State is ALWAYS Shelly's own platform probe ([isVpnUp]: a network with
 * TRANSPORT_VPN, the DeviceStatusBridge.writeNetworkSnapshot style), never
 * what ClosePaw reports.
 *
 * Acting goes through ONE seam, [requestTailscale], and it is connect-only:
 * the guardian never disconnects Tailscale (owner decision 2026-11-17, it
 * stays up on mobile data). Today it hands the fixed goal
 * ConnectivityGuardianCore.GOAL_TAILSCALE_CONNECT to
 * ClosePaw through the unchanged `shelly closepaw` decision point
 * (ClosePawHandoff.handleLine, in-process, a well-formed `closepaw:` line).
 * The guardian calls it only after reading ClosePawShellPreapproval.isOn()
 * itself, and [dispatchViaClosePaw] re-checks it (and the trusted variant)
 * under the same monitors handleLine uses, so a switch turned OFF can never
 * be raced into a dispatch or an approval prompt. A Tasker-style CONNECT_VPN intent route can
 * replace [dispatchViaClosePaw] here without touching the runner.
 *
 * [closePawRunSettled] reads ONLY the `status` of the hand-off's run-state
 * file (ClosePawRunResults), to know when the dispatched run is over: the
 * runner must not end a sequence while its request is still in flight. It is
 * completion tracking for sequencing, never success (the summary / message
 * are never read).
 */
object TailscaleControl {
    private const val TAG = "TailscaleControl"
    private val random = SecureRandom()

    /** true / false, or null when it cannot be told. */
    @Suppress("DEPRECATION")
    fun isVpnUp(context: Context): Boolean? = try {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        if (cm == null) {
            null
        } else {
            cm.allNetworks.any { n ->
                cm.getNetworkCapabilities(n)?.hasTransport(NetworkCapabilities.TRANSPORT_VPN) == true
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "vpn probe failed type=${e.javaClass.simpleName}")
        null
    }

    /** The seam (connect-only). The request id when handed off, else null; that alone never passes a step. */
    fun requestTailscale(context: Context): String? = dispatchViaClosePaw(context)

    /** The run for [reqId] reached a terminal state. Unreadable / missing /
     *  still running = false (the runner's settle wait is bounded). */
    fun closePawRunSettled(context: Context, reqId: String): Boolean = try {
        if (!ConnectivityGuardianCore.REQ_ID_RE.matches(reqId)) {
            false
        } else {
            val f = File(HomeInitializer.getHomeDir(context), ClosePawRunResults.RUN_FILE_PREFIX + reqId + ClosePawRunResults.RUN_FILE_SUFFIX)
            if (!f.isFile || f.length() > 64L * 1024L) {
                false
            } else {
                ConnectivityGuardianCore.isClosePawSettled(JSONObject(f.readText()).optString("status", ""))
            }
        }
    } catch (e: Exception) {
        false
    }

    private fun dispatchViaClosePaw(context: Context): String? {
        val now = System.currentTimeMillis()
        val reqId = "$now-" + "%08x".format(random.nextInt())
        val line = ConnectivityGuardianCore.closePawLine(reqId, now, ConnectivityGuardianCore.goalFor())
            ?: return null
        val app = context.applicationContext
        // Re-check and hand off atomically against the switch being turned
        // OFF (ClosePawShellPreapproval's methods are @Synchronized on its
        // object). Lock order ClosePawHandoff -> ClosePawShellPreapproval,
        // the same order handleLine itself takes, so no lock cycle. Only the
        // trusted variant's background path runs without a prompt; without
        // it nothing is dispatched (the runner notifies instead).
        val result = synchronized(ClosePawHandoff) {
            synchronized(ClosePawShellPreapproval) {
                if (!ClosePawHandoff.isTrustedVariantInstalled(app) || !ClosePawShellPreapproval.isOn(app)) {
                    Log.i(TAG, "tailscale hand-off skipped: pre-approval off or no trusted variant")
                    return null
                }
                try {
                    ClosePawHandoff.handleLine(app, line, now)
                } catch (e: Exception) {
                    Log.w(TAG, "closepaw hand-off failed type=${e.javaClass.simpleName}")
                    null
                }
            }
        }
        val code = result?.code ?: "none"
        Log.i(TAG, "tailscale connect hand-off: $code (t=${SystemClock.elapsedRealtime()})")
        return if (result != null && result.ok && code != "approval-required") reqId else null
    }
}
