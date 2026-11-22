package expo.modules.terminalemulator

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

/**
 * A Keystore-verified ON switch (the CodexRemoteAutostart pattern, generalized):
 * a nonce in SharedPreferences together with an HMAC from a non-exportable
 * Android Keystore key, re-keyed on every ON, key deleted on OFF (an old "on"
 * prefs file never verifies again). Any Keystore / prefs error reads as OFF.
 * File / prefs edits from a shell or an agent worker (same uid) therefore can
 * not turn it on; a plain AsyncStorage (RKStorage) setting could be.
 *
 * Who may turn it ON: only TerminalEmulatorModule's setter, which RN calls only
 * from the Settings toggle. That setter is reachable from any RN JS. We do not
 * add a native confirmation for it: RN JS is already the trusted base (it holds
 * the Keystore signing APIs that answer every approval), so code that can run
 * arbitrary RN JS could approve each request itself anyway, and the owner's
 * rule is "no extra approval prompts". What this stops is the cheaper attack:
 * a same-uid process editing files.
 */
class KeystoreSwitch(
    private val tag: String,
    private val prefsName: String,
    private val keyAlias: String,
    private val domain: String,
) {
    private companion object {
        const val KEY_NONCE = "nonce"
        const val KEY_MAC = "mac"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(keyAlias, null) as? SecretKey

    private fun newKey(): SecretKey {
        runCatching { keyStore().deleteEntry(keyAlias) }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE)
        generator.init(KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_SIGN).build())
        return generator.generateKey()
    }

    private fun mac(key: SecretKey, nonce: String): String {
        val m = Mac.getInstance("HmacSHA256")
        m.init(key)
        return m.doFinal("$domain$nonce".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    /** Only from the in-app Settings toggle. Returns the verified state afterwards. */
    @Synchronized
    fun setOn(context: Context): Boolean = try {
        val key = newKey()
        val bytes = ByteArray(16).also { SecureRandom().nextBytes(it) }
        val nonce = bytes.joinToString("") { "%02x".format(it) }
        val ok = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE).edit()
            .putString(KEY_NONCE, nonce)
            .putString(KEY_MAC, mac(key, nonce))
            .commit()
        if (!ok) {
            setOffLocked(context)
            Log.w(tag, "ON not saved; left OFF")
            false
        } else {
            Log.i(tag, "ON (set in app)")
            isOnLocked(context)
        }
    } catch (e: Exception) {
        setOffLocked(context)
        Log.w(tag, "ON failed (${e.javaClass.simpleName}); left OFF")
        false
    }

    /** Safe from anywhere (OFF is the restrictive direction). Reports the durable prefs commit. */
    @Synchronized
    fun setOff(context: Context, reason: String): Boolean {
        val committed = setOffLocked(context)
        if (committed) Log.i(tag, "OFF ($reason)") else Log.w(tag, "OFF commit failed ($reason)")
        return committed
    }

    private fun setOffLocked(context: Context): Boolean {
        val committed = runCatching {
            context.getSharedPreferences(prefsName, Context.MODE_PRIVATE).edit().remove(KEY_NONCE).remove(KEY_MAC).commit()
        }.getOrDefault(false)
        runCatching { keyStore().deleteEntry(keyAlias) }
            .onFailure { Log.w(tag, "could not delete the key (${it.javaClass.simpleName})") }
        return committed
    }

    /** Verified state. Never throws. */
    @Synchronized
    fun isOn(context: Context): Boolean = isOnLocked(context)

    private fun isOnLocked(context: Context): Boolean = try {
        val prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        val nonce = prefs.getString(KEY_NONCE, null)
        val stored = prefs.getString(KEY_MAC, null)
        val key = if (nonce != null && stored != null) existingKey() else null
        if (key == null || nonce == null || stored == null) {
            false
        } else {
            MessageDigest.isEqual(mac(key, nonce).toByteArray(Charsets.UTF_8), stored.toByteArray(Charsets.UTF_8))
        }
    } catch (e: Exception) {
        Log.w(tag, "state unreadable (${e.javaClass.simpleName}) - treating as OFF")
        false
    }
}

/**
 * The authoritative "MCP: Run without approval" switch (settings.mcpSkipApproval
 * only mirrors it). While it is on, the native McpRawToolConsumer runs MCP
 * run_command / write_file calls itself — after the same gate RN uses, but
 * without the approval tap and without RN.
 *
 *  - ON: TerminalEmulatorModule.setMcpSkipApproval(true), called by RN only
 *    from the Settings toggles (lib/mcp-skip-approval.ts; ConfigTUI, the
 *    "MCP: Run without approval" row and the "Skip all approvals" master row).
 *    Exported to any RN JS on purpose: see [KeystoreSwitch] for why RN JS is
 *    treated as trusted and no extra native confirmation is added.
 *  - OFF from anywhere: the toggle, MCP token regeneration, and STOP-ALL
 *    ([StopAllSwitches]: the native STOP-ALL operation, service / app start
 *    with `.halted` present, and McpRawToolConsumer when it sees `.halted`).
 */
object McpSkipApprovalStore {
    private val switch = KeystoreSwitch("McpSkipApprovalStore", "shelly_mcp_skip_approval", "shelly_mcp_skip_approval_v1", "shelly-mcp-skip-approval-v1:on:")
    fun setOn(context: Context): Boolean = switch.setOn(context)
    fun setOff(context: Context, reason: String) = switch.setOff(context, reason)
    fun isOn(context: Context): Boolean = switch.isOn(context)
}

/**
 * The authoritative "Skip all approvals" master switch
 * (settings.approveAllWithoutAsking only mirrors it; lib/approve-all-without-asking.ts
 * reads THIS at every decision). Same rules as [McpSkipApprovalStore]: ON only
 * from the Settings toggle, OFF on STOP-ALL and MCP token regeneration.
 */
object ApproveAllStore {
    private val switch = KeystoreSwitch("ApproveAllStore", "shelly_approve_all", "shelly_approve_all_v1", "shelly-approve-all-v1:on:")
    fun setOn(context: Context): Boolean = switch.setOn(context)
    fun setOff(context: Context, reason: String) = switch.setOff(context, reason)
    fun isOn(context: Context): Boolean = switch.isOn(context)
}

/** STOP-ALL turns both switches off (whether or not MCP is running). */
object StopAllSwitches {
    fun haltedSentinel(context: Context): File = File(HomeInitializer.getHomeDir(context), ".shelly/agents/.halted")

    /**
     * Both OFF now, unconditionally, under ApprovalSwitchCore's lock (bumps the
     * generation, so no master-switch decision started before this can be
     * answered after it). Returns whether both read OFF afterwards.
     */
    fun turnOff(context: Context, reason: String): Boolean = ApprovalSwitchCore.stopAll(
        listOf({ McpSkipApprovalStore.setOff(context, reason) }, { ApproveAllStore.setOff(context, reason) }),
        listOf({ McpSkipApprovalStore.isOn(context) }, { ApproveAllStore.isOn(context) }),
    )

    /** STOP-ALL is active: `.halted` present, or it cannot be checked. */
    fun halted(context: Context): Boolean = try {
        android.system.Os.lstat(haltedSentinel(context).path)
        true
    } catch (e: android.system.ErrnoException) {
        e.errno != android.system.OsConstants.ENOENT
    } catch (e: Exception) {
        true
    }

    /** Service / app start: `.halted` present (or uncheckable) forces both off. */
    fun enforceAtStart(context: Context, reason: String) {
        if (halted(context)) turnOff(context, "STOP-ALL at $reason")
    }
}

/**
 * Every enable / disable of the two switches goes through here (and so through
 * ApprovalSwitchCore's lock), never straight to the stores.
 */
object ApprovalSwitches {
    fun enableMcpSkip(context: Context): Boolean = ApprovalSwitchCore.enable(
        { StopAllSwitches.halted(context) }, { McpSkipApprovalStore.setOn(context) }, { McpSkipApprovalStore.setOff(context, "STOP-ALL active") },
    )

    /** Returns whether it still reads ON. Throws when the OFF commit was not confirmed. */
    fun disableMcpSkip(context: Context, reason: String): Boolean =
        ApprovalSwitchCore.disable(
            { check(McpSkipApprovalStore.setOff(context, reason)) { "could not persist MCP approval switch OFF" } },
            { McpSkipApprovalStore.isOn(context) },
        )

    fun enableApproveAll(context: Context): Boolean = ApprovalSwitchCore.enable(
        { StopAllSwitches.halted(context) }, { ApproveAllStore.setOn(context) }, { ApproveAllStore.setOff(context, "STOP-ALL active") },
    )

    /** Returns whether it still reads ON. Throws when the OFF commit was not confirmed. */
    fun disableApproveAll(context: Context, reason: String): Boolean =
        ApprovalSwitchCore.disable(
            { check(ApproveAllStore.setOff(context, reason)) { "could not persist master approval switch OFF" } },
            { ApproveAllStore.isOn(context) },
        )

    /** The master-switch decision token (see ApprovalSwitchCore), or null when it may not answer. */
    fun approveAllToken(context: Context): Long? =
        ApprovalSwitchCore.token({ ApproveAllStore.isOn(context) }, { StopAllSwitches.halted(context) })

    fun <T> withApproveAllToken(context: Context, token: Long, block: () -> T): T? =
        ApprovalSwitchCore.withToken(token, { ApproveAllStore.isOn(context) }, { StopAllSwitches.halted(context) }, block)

    /** A headless MCP action, only while "MCP: Run without approval" is on and STOP-ALL is not active. */
    fun <T> whileMcpSkipOn(context: Context, block: () -> T): T? =
        ApprovalSwitchCore.whileOn({ McpSkipApprovalStore.isOn(context) }, { StopAllSwitches.halted(context) }, block)
}
