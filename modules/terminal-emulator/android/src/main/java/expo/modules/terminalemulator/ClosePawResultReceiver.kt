package expo.modules.terminalemulator

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Receives the Shelly-trusted ClosePaw variant's run result (see [ClosePawRunResults]).
 *
 * Exported (ClosePaw is another app) and reachable by explicit component. It records a result
 * ONLY when ALL of these hold, else it ignores the broadcast silently:
 *  1. the action is [ClosePawRunResults.ACTION_RESULT];
 *  2. the installed ai.closepaw is signed by the pinned variant certificate
 *     ([ClosePawHandoff.VARIANT_CERT_SHA256]);
 *  3. the [ClosePawRunResults.EXTRA_CALLER_TOKEN] PendingIntent was created by ai.closepaw (the
 *     system fills creatorPackage from the creator's uid; a sender cannot forge it);
 *  4. API 34+: the broadcast shares its sender identity and the sender is ai.closepaw (a token
 *     alone could be a ClosePaw PendingIntent leaked e.g. through a notification);
 *  5. the reqId is one Shelly started and registered, and the per-run nonce matches
 *     ([ClosePawRunResults.consumeIfExpected], single use).
 * The summary is data only: it is sanitized and written to the run-state file, never executed.
 */
class ClosePawResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext
        try {
            if (intent.action != ClosePawRunResults.ACTION_RESULT) return
            val variant = ClosePawHandoff.isTrustedVariantInstalled(app)
            val tokenCreator = try {
                val token: PendingIntent? = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(ClosePawRunResults.EXTRA_CALLER_TOKEN, PendingIntent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra<PendingIntent>(ClosePawRunResults.EXTRA_CALLER_TOKEN)
                }
                token?.creatorPackage
            } catch (e: Exception) {
                // Malformed / wrong-typed extras fail closed.
                null
            }
            val sender = if (Build.VERSION.SDK_INT >= 34) {
                try { sentFromPackage } catch (e: Exception) { null }
            } else {
                null
            }
            if (!isSenderTrusted(Build.VERSION.SDK_INT, variant, tokenCreator, sender)) {
                Log.w(TAG, "ignored ClosePaw result: variant=$variant token=$tokenCreator sender=$sender")
                return
            }
            ClosePawRunResults.accept(
                app,
                reqId = safeString(intent, ClosePawRunResults.EXTRA_REQ_ID),
                nonce = safeString(intent, ClosePawRunResults.EXTRA_RESULT_NONCE),
                status = safeString(intent, ClosePawRunResults.EXTRA_STATUS),
                summary = safeString(intent, ClosePawRunResults.EXTRA_SUMMARY),
                finishedAtMs = try { intent.getLongExtra(ClosePawRunResults.EXTRA_FINISHED_AT_MS, 0L) } catch (e: Exception) { 0L },
            )
        } catch (e: Exception) {
            Log.w(TAG, "ClosePaw result handling failed type=${e.javaClass.simpleName}")
        }
    }

    private fun safeString(intent: Intent, name: String): String? = try {
        intent.getStringExtra(name)
    } catch (e: Exception) {
        null
    }

    companion object {
        private const val TAG = "ClosePawResultReceiver"

        /** Pure sender decision (source-tested). */
        fun isSenderTrusted(sdkInt: Int, variantInstalled: Boolean, tokenCreator: String?, sentFromPackage: String?): Boolean {
            if (!variantInstalled) return false
            if (tokenCreator != ClosePawHandoff.PACKAGE) return false
            if (sdkInt >= 34 && sentFromPackage != ClosePawHandoff.PACKAGE) return false
            return true
        }
    }
}
