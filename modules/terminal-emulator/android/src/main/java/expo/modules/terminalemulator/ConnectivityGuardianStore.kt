package expo.modules.terminalemulator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * Native-readable copy of the "Wi-Fi連動オートパイロット" toggle
 * (settings.connectivityGuardianEnabled), for the connectivity guardian
 * (ConnectivityGuardian.kt), which runs from boot / network / alarm
 * broadcasts before RN and so cannot read the zustand settings.
 *
 * The McpAutostartStore pattern (PR #158): SharedPreferences holding ONE
 * AES-256-GCM blob (IV + ciphertext) of {v:1, enabled:true}, encrypted with a
 * non-exportable Android Keystore key, a domain string bound as AAD, and the
 * key re-created on every write so restoring an older copy of the prefs never
 * decrypts again. RN (lib/connectivity-guardian-mirror.ts) writes it at app
 * start and with every change of the setting; OFF clears it.
 *
 * Fail closed: any Keystore / prefs / decode error, a missing key, a missing
 * blob, or anything but exactly {v:1, enabled:true} reads as OFF, and the
 * guardian then does nothing.
 */
object ConnectivityGuardianStore {
    private const val TAG = "ConnectivityGuardianStore"
    private const val PREFS = "shelly_connectivity_guardian"
    private const val KEY_BLOB = "blob"
    private const val KEY_ALIAS = "shelly_connectivity_guardian_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128
    private const val VERSION = 1
    private val AAD = "shelly-connectivity-guardian-v1".toByteArray(Charsets.UTF_8)

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun newKey(): SecretKey {
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun existingKey(): SecretKey? = keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    /** Guardian ON. Called only from RN (TerminalEmulatorModule
     *  .setConnectivityGuardianMirror). False (mirror cleared = OFF) on any failure. */
    @Synchronized
    fun writeOn(context: Context): Boolean = try {
        val plain = JSONObject().put("v", VERSION).put("enabled", true).toString().toByteArray(Charsets.UTF_8)
        val key = newKey()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key)
        cipher.updateAAD(AAD)
        val ct = cipher.doFinal(plain)
        val iv = cipher.iv
        val blob = Base64.encodeToString(byteArrayOf(iv.size.toByte()) + iv + ct, Base64.NO_WRAP)
        val ok = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_BLOB, blob).commit()
        if (!ok) {
            clearLocked(context)
            Log.w(TAG, "mirror commit failed; mirror cleared (guardian OFF)")
            false
        } else {
            Log.i(TAG, "mirror written: enabled")
            true
        }
    } catch (e: Exception) {
        clearLocked(context)
        Log.w(TAG, "mirror write failed (${e.javaClass.simpleName}); mirror cleared (guardian OFF)")
        false
    }

    /** Guardian OFF. Safe from anywhere. True when the mirror is durably unreadable. */
    @Synchronized
    fun clear(context: Context, reason: String): Boolean {
        val ok = clearLocked(context)
        if (ok) Log.i(TAG, "mirror cleared ($reason)") else Log.w(TAG, "mirror clear NOT confirmed ($reason)")
        return ok
    }

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

    /** True only for a verified {v:1, enabled:true}. Never throws. */
    @Synchronized
    fun isOn(context: Context): Boolean = try {
        val blob = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_BLOB, null)
        val key = if (blob != null) existingKey() else null
        if (blob == null || key == null) {
            false
        } else {
            val raw = Base64.decode(blob, Base64.NO_WRAP)
            val ivLen = raw[0].toInt() and 0xff
            if (ivLen < 12 || ivLen > 16 || raw.size <= 1 + ivLen) {
                false
            } else {
                val iv = raw.copyOfRange(1, 1 + ivLen)
                val ct = raw.copyOfRange(1 + ivLen, raw.size)
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
                cipher.updateAAD(AAD)
                val json = JSONObject(String(cipher.doFinal(ct), Charsets.UTF_8))
                json.optInt("v", -1) == VERSION && json.opt("enabled") == true
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "mirror unreadable (${e.javaClass.simpleName}) - treating as OFF")
        false
    }
}
