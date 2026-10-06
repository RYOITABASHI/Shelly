package expo.modules.terminalemulator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

/**
 * POLICY-001 (lib/agent-user-policy-store.ts) — native half of the
 * policy.json seal, security re-review M1.
 *
 * The seal value (comma-separated sha256 of policy.json) lives in this app's
 * SharedPreferences, which any process running as the app uid can delete or
 * edit from a shell. Two Android-Keystore-backed defences close that:
 *
 *  1. "Ever sealed" marker: the first seal write creates an HMAC key under
 *     [KEY_ALIAS] in the AndroidKeyStore. A shell cannot delete a Keystore
 *     entry, so once it exists, an EMPTY / missing seal can no longer pass for
 *     "first run, no rules" — every consumer treats it as unavailable.
 *  2. HMAC: the stored seal is MAC'd with that non-exportable key. A seal
 *     value forged into the prefs file fails verification and reads as
 *     "no valid seal" (⇒ unavailable while the marker exists).
 *
 * Executors never see the MAC — AgentRuntime exports only the VERIFIED seal
 * (SHELLY_AGENT_POLICY_SEAL, '' when invalid) plus
 * SHELLY_AGENT_POLICY_EVER_SEALED. Keystore errors fail closed (treated as
 * "ever sealed" with no valid seal).
 */
object AgentPolicySeal {
    private const val TAG = "AgentPolicySeal"
    private const val PREFS = "shelly_agent_policy"
    private const val KEY_SEAL = "file_seal"
    private const val KEY_MAC = "file_seal_mac"
    private const val KEY_ALIAS = "shelly_agent_policy_seal_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private val SEAL_RE = Regex("^[0-9a-f]{64}(,[0-9a-f]{64})?$")

    data class State(val everSealed: Boolean, val seal: String, val valid: Boolean)

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    private fun ensureKey(): SecretKey {
        existingKey()?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE)
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN).build())
        return generator.generateKey()
    }

    private fun mac(key: SecretKey, value: String): String {
        val m = Mac.getInstance("HmacSHA256")
        m.init(key)
        return m.doFinal("shelly-policy-seal-v1:$value".toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    /** Record a seal written by RN (malformed ⇒ stored as ""). Creates the marker key. */
    fun write(context: Context, seal: String) {
        val value = if (SEAL_RE.matches(seal)) seal else ""
        val key = ensureKey()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SEAL, value)
            .putString(KEY_MAC, mac(key, value))
            .commit()
    }

    /** The verified seal state. Never throws. */
    fun read(context: Context): State {
        return try {
            val key = existingKey() ?: return State(everSealed = false, seal = "", valid = true)
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val seal = prefs.getString(KEY_SEAL, null)
            val storedMac = prefs.getString(KEY_MAC, null)
            if (seal == null || storedMac == null) return State(everSealed = true, seal = "", valid = false)
            val expected = mac(key, seal)
            val macOk = MessageDigest.isEqual(expected.toByteArray(Charsets.UTF_8), storedMac.toByteArray(Charsets.UTF_8))
            val ok = macOk && (seal.isEmpty() || SEAL_RE.matches(seal))
            State(everSealed = true, seal = if (ok) seal else "", valid = ok)
        } catch (e: Exception) {
            Log.w(TAG, "policy seal read failed — failing closed", e)
            State(everSealed = true, seal = "", valid = false)
        }
    }
}
