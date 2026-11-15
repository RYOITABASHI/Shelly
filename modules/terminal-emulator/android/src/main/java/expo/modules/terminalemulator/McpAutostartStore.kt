package expo.modules.terminalemulator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * Native-readable copy of the MCP server settings, for the boot / app-update
 * auto-start path (McpServerAutostartReceiver -> McpServerService), which runs
 * before RN and so cannot read the zustand settings or expo-secure-store.
 *
 * One source of truth: the RN settings (mcpServerEnabled / mcpExecEnabled /
 * mcpReadTerminalEnabled / mcpDiagnosticsEnabled) and the SecureStore token stay the owner's UI. RN
 * writes this mirror together with every change (hooks/use-mcp-server-bridge.ts
 * on each settings change and app start, and the lib/mcp-token.ts create /
 * regenerate paths). Native code only ever reads it, except that turning
 * the server OFF clears it ([clear]).
 *
 * Storage: SharedPreferences holding ONE AES-256-GCM blob (IV + ciphertext)
 * of {v, enabled, exec, readTerminal, diagnostics, token}, encrypted with a non-exportable
 * Android Keystore key. The token is therefore never in plaintext prefs, and
 * the flags cannot be edited or forged without the Keystore key (GCM
 * authenticates the whole blob; a domain string is bound as AAD). Like
 * CodexRemoteAutostart / ClosePawDraftPreapproval / AgentIngressTaint the key
 * is re-created on every write, so restoring an older copy of the prefs (e.g.
 * one with exec ON or the pre-regeneration token) never decrypts again.
 *
 * Fail closed: any Keystore / prefs / decode error, a missing key, a missing
 * blob, or a malformed token reads as OFF ([read] returns null), so auto-start
 * never brings the server up broader than the owner set it. Nothing here
 * logs the token or the blob.
 *
 * Boundary (same as CodexRemoteAutostart): code running as this uid that can
 * drive AndroidKeyStore itself could decrypt or write the blob. That code could
 * equally read expo-secure-store (also Keystore-backed), so this adds no new
 * exposure for the token.
 */
object McpAutostartStore {
    private const val TAG = "McpAutostartStore"
    private const val PREFS = "shelly_mcp_autostart"
    private const val KEY_BLOB = "blob"
    private const val KEY_ALIAS = "shelly_mcp_autostart_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    private const val VERSION = 1
    private val AAD = "shelly-mcp-autostart-v1".toByteArray(Charsets.UTF_8)
    // Same alphabet/length bounds the RN token generator produces
    // (base64url of 32 bytes = 43 chars); a little slack, no controls/spaces.
    private val TOKEN_RE = Regex("^[A-Za-z0-9_-]{16,256}$")

    /** What the native auto-start path may use. Never toString()'d into logs. */
    class Config(val exec: Boolean, val readTerminal: Boolean, val diagnostics: Boolean, val token: String) {
        override fun toString(): String =
            "McpAutostartStore.Config(exec=$exec, readTerminal=$readTerminal, diagnostics=$diagnostics)"
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun newKey(): SecretKey {
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // Keystore picks the IV (randomized encryption stays on).
                .build()
        )
        return generator.generateKey()
    }

    private fun existingKey(): SecretKey? = keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    fun isValidToken(token: String?): Boolean = token != null && TOKEN_RE.matches(token)

    /**
     * Server ON with these settings. Called only from RN
     * (TerminalEmulatorModule.setMCPAutostartMirror). Returns false (and leaves
     * the mirror cleared, i.e. OFF) when anything fails.
     */
    @Synchronized
    fun writeOn(context: Context, exec: Boolean, readTerminal: Boolean, diagnostics: Boolean, token: String): Boolean {
        if (!isValidToken(token)) {
            Log.w(TAG, "refusing to mirror a malformed token; mirror cleared")
            clearLocked(context)
            return false
        }
        return try {
            val plain = JSONObject()
                .put("v", VERSION)
                .put("enabled", true)
                .put("exec", exec)
                .put("readTerminal", readTerminal)
                .put("diagnostics", diagnostics)
                .put("token", token)
                .toString()
                .toByteArray(Charsets.UTF_8)
            val key = newKey()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            cipher.updateAAD(AAD)
            val ct = cipher.doFinal(plain)
            val iv = cipher.iv
            plain.fill(0)
            val blob = Base64.encodeToString(byteArrayOf(iv.size.toByte()) + iv + ct, Base64.NO_WRAP)
            val ok = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(KEY_BLOB, blob)
                .commit()
            if (!ok) {
                clearLocked(context)
                Log.w(TAG, "mirror commit failed; mirror cleared (auto-start OFF)")
                false
            } else {
                Log.i(TAG, "mirror written: enabled exec=$exec readTerminal=$readTerminal diagnostics=$diagnostics")
                true
            }
        } catch (e: Exception) {
            clearLocked(context)
            Log.w(TAG, "mirror write failed (${e.javaClass.simpleName}); mirror cleared (auto-start OFF)")
            false
        }
    }

    /**
     * Server OFF. Safe from anywhere (OFF is the restrictive direction).
     * Returns whether the mirror is now verifiably unreadable: RN replaces a
     * token or saves narrower settings only after a confirmed clear.
     */
    @Synchronized
    fun clear(context: Context, reason: String): Boolean {
        val ok = clearLocked(context)
        if (ok) Log.i(TAG, "mirror cleared ($reason)") else Log.w(TAG, "mirror clear NOT confirmed ($reason)")
        return ok
    }

    /**
     * Either half is enough for [read] to return OFF: no blob, or no key to
     * decrypt it with. Prefs first; the key is deleted regardless. Returns
     * true only when one of them is DURABLY gone: commit() returned true (the
     * removal reached disk), or the Keystore no longer has the alias. An
     * in-memory getString() == null after a failed commit proves nothing
     * (SharedPreferences updates memory before the disk write).
     */
    private fun clearLocked(context: Context): Boolean {
        val prefsGone = runCatching {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_BLOB).commit()
        }.getOrDefault(false)
        val keyGone = runCatching {
            val ks = keyStore()
            ks.deleteEntry(KEY_ALIAS)
            !ks.containsAlias(KEY_ALIAS)
        }.getOrDefault(false)
        return prefsGone || keyGone
    }

    /** Verified ON config, or null for OFF / anything unreadable. Never throws. */
    @Synchronized
    fun read(context: Context): Config? = try {
        val blob = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_BLOB, null)
        val key = if (blob != null) existingKey() else null
        if (blob == null || key == null) {
            null
        } else {
            val raw = Base64.decode(blob, Base64.NO_WRAP)
            val ivLen = raw[0].toInt() and 0xff
            if (ivLen < 12 || ivLen > 16 || raw.size <= 1 + ivLen) {
                null
            } else {
                val iv = raw.copyOfRange(1, 1 + ivLen)
                val ct = raw.copyOfRange(1 + ivLen, raw.size)
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
                cipher.updateAAD(AAD)
                val plain = cipher.doFinal(ct)
                val json = JSONObject(String(plain, Charsets.UTF_8))
                plain.fill(0)
                parse(json)
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "mirror unreadable (${e.javaClass.simpleName}) - treating as OFF")
        null
    }

    /** Strict: exact version, enabled === true, booleans only, valid token. */
    private fun parse(json: JSONObject): Config? {
        if (json.optInt("v", -1) != VERSION) return null
        val enabled = json.opt("enabled")
        val exec = json.opt("exec")
        val readTerminal = json.opt("readTerminal")
        val diagnostics = json.opt("diagnostics")
        val token = json.opt("token")
        if (enabled != true) return null
        if (exec !is Boolean || readTerminal !is Boolean || diagnostics !is Boolean || token !is String) return null
        if (!isValidToken(token)) return null
        return Config(exec, readTerminal, diagnostics, token)
    }

    fun isOn(context: Context): Boolean = read(context) != null
}
