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
 * The authoritative "Keep ChatGPT connected" ON switch.
 *
 * While it is on, ChatGPT can run commands on this phone, so it must not be
 * forgeable by anything that merely runs as the app uid (a shell, a Codex
 * tool command, a compromised agent script). Same pattern as AgentPolicySeal:
 * the value lives in SharedPreferences together with an HMAC from a
 * non-exportable Android Keystore key, and only the Settings toggle
 * (TerminalEmulatorModule.setCodexRemoteAutostart, after an in-app
 * confirmation) calls [setOn].
 *
 * Replay: turning it OFF deletes the Keystore key, so a copy of an old
 * "on" prefs file can never verify again; ON always mints a fresh key and
 * nonce. Any Keystore/prefs error reads as OFF (fail closed).
 */
object CodexRemoteAutostart {
    private const val TAG = "CodexRemoteAutostart"
    private const val PREFS = "shelly_codex_remote"
    private const val KEY_NONCE = "autostart_nonce"
    private const val KEY_MAC = "autostart_mac"
    private const val KEY_ALIAS = "shelly_codex_remote_autostart_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val DOMAIN = "shelly-codex-remote-autostart-v1:on:"

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

    /** Only from the in-app Settings toggle. */
    fun setOn(context: Context) {
        val key = newKey()
        val bytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val nonce = bytes.joinToString("") { "%02x".format(it) }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_NONCE, nonce)
            .putString(KEY_MAC, mac(key, nonce))
            .commit()
        Log.i(TAG, "Keep ChatGPT connected: ON (set in app)")
    }

    /** Safe from anywhere (OFF is the restrictive direction). */
    fun setOff(context: Context, reason: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .remove(KEY_NONCE).remove(KEY_MAC).commit()
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
            .onFailure { Log.w(TAG, "could not delete the autostart key", it) }
        Log.i(TAG, "Keep ChatGPT connected: OFF ($reason)")
    }

    /** Verified state. Never throws. */
    fun isOn(context: Context): Boolean = try {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val nonce = prefs.getString(KEY_NONCE, null)
        val stored = prefs.getString(KEY_MAC, null)
        val key = if (nonce != null && stored != null) existingKey() else null
        if (key == null || nonce == null || stored == null) false
        else MessageDigest.isEqual(mac(key, nonce).toByteArray(Charsets.UTF_8), stored.toByteArray(Charsets.UTF_8))
    } catch (e: Exception) {
        Log.w(TAG, "autostart state read failed - treating as OFF", e)
        false
    }
}
