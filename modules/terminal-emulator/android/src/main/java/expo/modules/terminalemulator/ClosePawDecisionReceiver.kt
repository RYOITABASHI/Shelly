package expo.modules.terminalemulator

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Approve / Reject actions of the `shelly closepaw` approval notification
 * (ClosePawShellApprovals.postNotification), applied natively so the tap does
 * NOT bring Shelly to the foreground (the old shelly:///closepaw-decision
 * activity deep link opened Shelly full-screen and broke the user's split
 * screen, e.g. ChatGPT left / Shelly right).
 *
 * NOT exported: only reachable through the immutable PendingIntents Shelly
 * itself puts on that notification (SystemUI sends them as Shelly). The
 * Approve action keeps setAuthenticationRequired(true), so the device must be
 * unlocked before SystemUI fires it. The single-use 128-bit nonce is checked
 * by ClosePawShellApprovals.resolve(via = "notification") exactly as before;
 * nothing here trusts the extras beyond passing them to that check.
 */
class ClosePawDecisionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DECISION) return
        val app = context.applicationContext
        val reqId = intent.getStringExtra(EXTRA_REQ_ID).orEmpty()
        val decision = intent.getStringExtra(EXTRA_DECISION).orEmpty()
        val nonce = intent.getStringExtra(EXTRA_NONCE).orEmpty()
        // Defense in depth on top of setAuthenticationRequired: never approve
        // while the device is locked (e.g. an action fired some other way).
        if (decision == "approve" && !isUnlocked(app)) {
            Log.w(TAG, "notification approve $reqId refused: device locked")
            ClosePawShellApprovals.postLockedNotice(app, reqId)
            return
        }
        // resolve() may block up to ClosePawHandoff.VARIANT_BROADCAST_TIMEOUT_MS
        // waiting for ClosePaw's ordered result, and the background entry is
        // only used off the main thread: hand off to a worker.
        val pending = goAsync()
        WORKER.execute {
            try {
                val outcome = ClosePawShellApprovals.resolve(app, reqId, decision, "notification", nonce)
                // Never log the nonce.
                Log.i(TAG, "notification $decision $reqId -> ${outcome.code}")
                ClosePawShellApprovals.postDecisionNotification(app, reqId, decision, outcome)
            } catch (e: Exception) {
                Log.w(TAG, "closepaw decision failed type=${e.javaClass.simpleName}")
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        private const val TAG = "ClosePawDecision"
        const val ACTION_DECISION = "dev.shelly.terminal.CLOSEPAW_DECISION"
        const val EXTRA_REQ_ID = "reqId"
        const val EXTRA_DECISION = "decision"
        const val EXTRA_NONCE = "nonce"
        /** Keyguard not showing AND the device not locked. Fails closed. */
        fun isUnlocked(context: Context): Boolean = try {
            val km = context.getSystemService(KeyguardManager::class.java)
            km != null && !km.isKeyguardLocked && !km.isDeviceLocked
        } catch (e: Exception) {
            false
        }

        private val WORKER: ExecutorService = Executors.newSingleThreadExecutor { r ->
            Thread(r, "ShellyClosePawDecision").apply { isDaemon = true }
        }

        /** Explicit, package-bound decision intent. The data URI only keeps
         *  the approve / reject PendingIntents distinct (filterEquals ignores
         *  extras); the receiver never reads it. */
        fun intent(context: Context, reqId: String, decision: String, nonce: String): Intent =
            Intent(ACTION_DECISION)
                .setComponent(ComponentName(context, ClosePawDecisionReceiver::class.java))
                .setPackage(context.packageName)
                .setData(Uri.parse("shelly-closepaw-decision:$reqId/$decision"))
                .putExtra(EXTRA_REQ_ID, reqId)
                .putExtra(EXTRA_DECISION, decision)
                .putExtra(EXTRA_NONCE, nonce)
    }
}
