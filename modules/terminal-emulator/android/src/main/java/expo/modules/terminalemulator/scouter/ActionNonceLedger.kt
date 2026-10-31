package expo.modules.terminalemulator.scouter

import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * Single-use approval nonces for one approval bridge (AgentEscalationBridge /
 * AgentActionApprovalBridge), 2026-10-31 review L1.
 *
 * Before: one nonce per request key. Every in-app disclosure (chat / MONITOR
 * typed OK, the run-without-approval auto-check, the review screen) REPLACED
 * the notification's nonce, so after a chat outcome of changed / expired /
 * failed — or an auto-check that read and then refused — the notification's
 * Allow / Deny carried a stale nonce and only said "not ready".
 *
 * Now each disclosure channel holds its own nonce, each bound to the request
 * hash it was minted for:
 *   - the notification keeps exactly one (CHANNEL_NOTIFICATION; a refreshed
 *     notification replaces only its own);
 *   - in-app reads add theirs (CHANNEL_APP, at most [maxAppNoncesPerKey]
 *     kept, oldest dropped first).
 * [consume] succeeds only for a registered nonce whose bound hash equals the
 * request bytes being answered, and then drops EVERY nonce of that key — one
 * answer wins, everywhere, exactly as before.
 */
class ActionNonceLedger(private val maxAppNoncesPerKey: Int = 8) {
    private data class Entry(val nonce: String, val requestSha256: String, val channel: String)

    private val entries = HashMap<String, MutableList<Entry>>()
    private val secureRandom = SecureRandom()

    @Synchronized
    fun register(key: String, requestSha256: String, channel: String): String {
        val bytes = ByteArray(24)
        secureRandom.nextBytes(bytes)
        val encoded = Base64.encodeToString(bytes, Base64.NO_WRAP)
        val list = entries.getOrPut(key) { mutableListOf() }
        if (channel == CHANNEL_NOTIFICATION) {
            list.removeAll { it.channel == CHANNEL_NOTIFICATION }
        } else {
            while (list.count { it.channel != CHANNEL_NOTIFICATION } >= maxAppNoncesPerKey) {
                val oldest = list.indexOfFirst { it.channel != CHANNEL_NOTIFICATION }
                if (oldest < 0) break
                list.removeAt(oldest)
            }
        }
        list.add(Entry(encoded, requestSha256, channel))
        return encoded
    }

    @Synchronized
    fun has(key: String, channel: String): Boolean =
        entries[key]?.any { it.channel == channel } == true

    /** true iff [nonce] was registered for [key] and bound to [requestSha256];
     *  on success every nonce of [key] is dropped (single use, any channel). */
    @Synchronized
    fun consume(key: String, nonce: String?, requestSha256: String): Boolean {
        if (nonce.isNullOrBlank()) return false
        val list = entries[key] ?: return false
        val match = list.any {
            MessageDigest.isEqual(it.nonce.toByteArray(Charsets.UTF_8), nonce.toByteArray(Charsets.UTF_8)) &&
                it.requestSha256 == requestSha256
        }
        if (!match) return false
        entries.remove(key)
        return true
    }

    @Synchronized
    fun clear(key: String) {
        entries.remove(key)
    }

    companion object {
        const val CHANNEL_NOTIFICATION = "notification"
        const val CHANNEL_APP = "app"
    }
}
