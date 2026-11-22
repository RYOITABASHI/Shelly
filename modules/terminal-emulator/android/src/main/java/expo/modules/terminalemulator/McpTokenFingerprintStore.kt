package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import java.security.MessageDigest
import java.security.SecureRandom

/** Last published MCP credential fingerprint or revocation tombstone. */
internal object McpTokenFingerprintStore {
    private const val PREFS = "shelly_mcp_token_fingerprint"
    private const val KEY = "sha256"
    private val sha256Hex = Regex("[0-9a-f]{64}")

    // Global lock order: StageInstall.commitLock -> McpTokenFingerprintStore.monitor.
    // The credential monitor is shared by both stores. McpAutostartStore has no lock of its own.
    // While holding the credential monitor, never acquire commitLock or the supervisor lock.
    val monitor = Any()

    fun get(context: Context): String? = synchronized(monitor) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)
    }

    fun set(context: Context, fingerprint: String): Boolean =
        sha256Hex.matches(fingerprint) && commit(context, fingerprint)

    fun revoke(context: Context): Boolean {
        val nonce = ByteArray(32)
        SecureRandom().nextBytes(nonce)
        return commit(context, "revoked:${hashBytes(nonce)}")
    }

    fun isTombstone(record: String?): Boolean =
        record != null && record.startsWith("revoked:") && sha256Hex.matches(record.removePrefix("revoked:"))

    fun hash(token: String): String = hashBytes(token.toByteArray(Charsets.UTF_8))

    private fun hashBytes(value: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(value)
            .joinToString("") { "%02x".format(it) }

    fun matches(context: Context, token: String?): Boolean {
        val fingerprint = get(context) ?: return true
        return !isTombstone(fingerprint) && token != null && fingerprint == hash(token)
    }

    private fun commit(context: Context, fingerprint: String): Boolean = synchronized(monitor) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val previous = prefs.getString(KEY, null)
        if (prefs.edit().putString(KEY, fingerprint).commit()) return@synchronized true
        // SharedPreferences updates memory even when its disk write fails.
        if (!prefs.edit().putString(KEY, previous).commit()) {
            Log.w("McpTokenFingerprintStore", "Could not restore the previous fingerprint record")
        }
        false
    }
}
