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
import org.json.JSONObject

/**
 * "Run ClosePaw without Shelly's approval" (owner decision 2026-11-16).
 *
 * Purpose: Muse (or any other AI interface) drives Shelly, and Shelly hands
 * phone operations to ClosePaw. A per-request approval makes that unusable, so
 * while this is ON every Shelly-side ClosePaw approval is skipped:
 *   - `shelly closepaw "<goal>"` launches at once (ClosePawHandoff.handleLine),
 *   - an agent's ClosePaw hand-off needs no per-run Review (app/_layout.tsx,
 *     closePawPreapprovedFor; the run-provenance and once-per-run checks stay),
 *   - queued drafts go at the first unlock without a tap and without the daily
 *     cap (ClosePawDrafts.preapproved).
 * The owner accepted that ON means anything that can reach `shelly closepaw`
 * (Codex, agents, text that came from the web) can make ClosePaw operate any
 * app as them without a prompt. What still stops a run: STOP-ALL (`.halted`),
 * the trusted-variant check, ClosePaw's own policy, and Shelly's gates on
 * whatever runs inside Shelly.
 *
 * Who can turn it on: only [enable], called only by TerminalEmulatorModule's
 * `setClosePawShellPreapproval(true)`, which RN calls only for words the owner
 * typed in the AI pane composer (lib/closepaw-shell-preapproval.ts). No shell
 * command, file, queue field or env reaches it. OFF ([disable]) is safe from
 * anywhere (chat, Settings).
 *
 * Storage: the ClosePawDraftPreapproval pattern. SharedPreferences MAC'd with a
 * non-exportable Keystore HMAC key that is replaced on every write, so an older
 * copy of the prefs never verifies; anything that does not verify reads as OFF.
 * A process of this uid can delete the prefs, which only turns it off.
 */
object ClosePawShellPreapproval {
    private const val TAG = "ClosePawShellPreapproval"
    private const val PREFS = "shelly_closepaw_shell_preapproval"
    private const val KEY_STATE = "state"
    private const val KEY_MAC = "mac"
    private const val KEY_ALIAS = "shelly_closepaw_shell_preapproval_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val DOMAIN = "shelly-closepaw-shell-preapproval-v1:"
    private const val MAX_STATE_CHARS = 256

    fun encode(enabledAt: Long): String =
        JSONObject().put("version", 1).put("on", true).put("enabledAt", enabledAt).toString()

    /** The enabledAt of a valid ON state, else null. */
    fun decode(text: String): Long? = try {
        if (text.length > MAX_STATE_CHARS) {
            null
        } else {
            val o = JSONObject(text)
            if (o.optInt("version") == 1 && o.optBoolean("on", false) && o.has("enabledAt")) o.getLong("enabledAt") else null
        }
    } catch (e: Exception) {
        null
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(KEY_ALIAS, null) as? SecretKey

    private fun newKey(): SecretKey {
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE)
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN).build())
        return generator.generateKey()
    }

    private fun mac(key: SecretKey, state: String): String {
        val m = Mac.getInstance("HmacSHA256")
        m.init(key)
        return m.doFinal("$DOMAIN$state".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    /** When it was turned on, or null when OFF or unverifiable. Never throws. */
    @Synchronized
    fun enabledAt(context: Context): Long? = try {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val state = prefs.getString(KEY_STATE, null)
        val stored = prefs.getString(KEY_MAC, null)
        val key = if (state != null && stored != null) existingKey() else null
        if (key == null || state == null || stored == null) {
            null
        } else if (!MessageDigest.isEqual(mac(key, state).toByteArray(Charsets.UTF_8), stored.toByteArray(Charsets.UTF_8))) {
            Log.w(TAG, "closepaw pre-approval state does not verify - treating as off")
            null
        } else {
            decode(state)
        }
    } catch (e: Exception) {
        Log.w(TAG, "closepaw pre-approval read failed - treating as off type=${e.javaClass.simpleName}")
        null
    }

    fun isOn(context: Context): Boolean = enabledAt(context) != null

    /** Only from the owner's typed chat words (see the class comment). */
    @Synchronized
    fun enable(context: Context, now: Long = System.currentTimeMillis()) {
        val state = encode(now)
        val key = newKey()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_STATE, state).putString(KEY_MAC, mac(key, state)).commit()
        Log.i(TAG, "closepaw pre-approval on")
    }

    /** Safe from anywhere. */
    @Synchronized
    fun disable(context: Context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_STATE).remove(KEY_MAC).commit()
        runCatching { keyStore().deleteEntry(KEY_ALIAS) }
            .onFailure { Log.w(TAG, "could not delete the pre-approval key type=${it.javaClass.simpleName}") }
        Log.i(TAG, "closepaw pre-approval off")
    }

    /** For RN (Settings, chat replies). */
    fun statusJson(context: Context): String {
        val at = enabledAt(context)
        val o = JSONObject().put("on", at != null)
        if (at != null) o.put("enabledAt", at)
        return o.toString()
    }

    /** The module's `setClosePawShellPreapproval`. Returns `{ok, code, on}`. */
    fun setFromRn(context: Context, on: Boolean): String = try {
        if (on) enable(context) else disable(context)
        JSONObject(statusJson(context)).put("ok", true).put("code", if (on) "on" else "off").toString()
    } catch (e: Exception) {
        Log.w(TAG, "closepaw pre-approval set failed type=${e.javaClass.simpleName}")
        // Could not store ON: make sure nothing half-written verifies.
        runCatching { disable(context) }
        JSONObject().put("ok", false).put("code", "failed").put("on", false).toString()
    }
}
