package expo.modules.terminalemulator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

/**
 * The authoritative "MCP: Run without approval" switch (settings.mcpSkipApproval
 * only mirrors it). While it is on, the native McpRawToolConsumer runs MCP
 * run_command / write_file calls itself — after the same gate RN uses, but
 * without the on-device approval tap and without RN — so it must not be
 * forgeable by anything that merely runs as the app uid (a shell, an agent CLI
 * worker, a compromised script). Same pattern as CodexRemoteAutostart: a nonce
 * in SharedPreferences together with an HMAC from a non-exportable Android
 * Keystore key, re-keyed on every ON, key deleted on OFF (an old "on" prefs
 * file never verifies again). Any Keystore / prefs error reads as OFF.
 *
 * Who may call what:
 *  - [setOn]: ONLY TerminalEmulatorModule.setMcpSkipApproval(true), which RN
 *    calls only from the Settings toggle (lib/mcp-skip-approval.ts
 *    setMcpSkipApprovalFromToggle; components/config/ConfigTUI.tsx).
 *  - [setOff]: anywhere (OFF is the restrictive direction): the toggle, a
 *    settings sync, MCP token regeneration (lib/mcp-server-bridge.ts
 *    revokePendingMCPRequests), and STOP-ALL (McpRawToolConsumer turns it off
 *    when it sees the `.halted` sentinel).
 *
 * Boundary, as for CodexRemoteAutostart: code running as this uid that can
 * drive AndroidKeyStore itself could call [setOn]. File / prefs edits from a
 * shell cannot turn it on.
 */
object McpSkipApprovalStore {
    private const val TAG = "McpSkipApprovalStore"
    private const val PREFS = "shelly_mcp_skip_approval"
    private const val KEY_NONCE = "nonce"
    private const val KEY_MAC = "mac"
    private const val KEY_ALIAS = "shelly_mcp_skip_approval_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val DOMAIN = "shelly-mcp-skip-approval-v1:on:"

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    private fun newKey(): SecretKey {
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE)
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN).build())
        return generator.generateKey()
    }

    private fun mac(key: SecretKey, nonce: String): String {
        val m = Mac.getInstance("HmacSHA256")
        m.init(key)
        return m.doFinal("$DOMAIN$nonce".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    /** Only from the in-app Settings toggle. Returns the verified state afterwards. */
    @Synchronized
    fun setOn(context: Context): Boolean {
        return try {
            val key = newKey()
            val bytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
            val nonce = bytes.joinToString("") { "%02x".format(it) }
            val ok = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_NONCE, nonce)
                .putString(KEY_MAC, mac(key, nonce))
                .commit()
            if (!ok) {
                setOffLocked(context)
                Log.w(TAG, "MCP run without approval: ON not saved; left OFF")
                false
            } else {
                Log.i(TAG, "MCP run without approval: ON (set in app)")
                isOnLocked(context)
            }
        } catch (e: Exception) {
            setOffLocked(context)
            Log.w(TAG, "MCP run without approval: ON failed (${e.javaClass.simpleName}); left OFF")
            false
        }
    }

    /** Safe from anywhere (OFF is the restrictive direction). */
    @Synchronized
    fun setOff(context: Context, reason: String) {
        setOffLocked(context)
        Log.i(TAG, "MCP run without approval: OFF ($reason)")
    }

    private fun setOffLocked(context: Context) {
        runCatching {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .remove(KEY_NONCE).remove(KEY_MAC).commit()
        }
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
            .onFailure { Log.w(TAG, "could not delete the skip-approval key (${it.javaClass.simpleName})") }
    }

    /** Verified state. Never throws. */
    @Synchronized
    fun isOn(context: Context): Boolean = isOnLocked(context)

    private fun isOnLocked(context: Context): Boolean = try {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val nonce = prefs.getString(KEY_NONCE, null)
        val stored = prefs.getString(KEY_MAC, null)
        val key = if (nonce != null && stored != null) existingKey() else null
        if (key == null || nonce == null || stored == null) {
            false
        } else {
            MessageDigest.isEqual(mac(key, nonce).toByteArray(Charsets.UTF_8), stored.toByteArray(Charsets.UTF_8))
        }
    } catch (e: Exception) {
        Log.w(TAG, "skip-approval state unreadable (${e.javaClass.simpleName}) - treating as OFF")
        false
    }
}
