package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Native side of the ONE chain-lock protocol (`locks/<id>.chain.lock`): runs
 * the APK asset shelly-chain-lock.sh — byte-identical to
 * lib/agent-chain-lock-protocol.ts CHAIN_LOCK_SHELL, which the JS acquire /
 * check / release / disarm use — through /system/bin/sh, so JS and native
 * remove a stale lock by literally the same steps (the script header states
 * the invariants: every check bound to one instance, removal only under that
 * instance's marker, inode-verified rename, fresh-mtime locks never stale).
 *
 * Fail-safe: any error (asset, spawn, unexpected output) is LOCKED — the
 * lock is left where it is and the caller treats it as held.
 */
object ChainLockProtocol {
    private const val TAG = "ShellyChainLock"
    const val ASSET = "shelly-chain-lock.sh"

    enum class ReapOutcome { REAPED, ABSENT, LOCKED }

    fun reap(context: Context, lockDir: File, nowMs: Long = System.currentTimeMillis()): ReapOutcome = try {
        val lib = context.assets.open(ASSET).bufferedReader().use { it.readText() }
        val script = lib + "\nshelly_chain_lock_reap \"\$1\" \"\$2\" \"\$3\"\n"
        val pb = ProcessBuilder(
            "/system/bin/sh", "-c", script, "shelly-chain-lock",
            lockDir.absolutePath,
            (nowMs / 1000).toString(),
            (AgentScheduleReconcileCore.CHAIN_LOCK_STALE_MS / 1000).toString(),
        )
        pb.environment()["PATH"] = "/system/bin:/system/xbin"
        pb.redirectErrorStream(true)
        val proc = pb.start()
        runCatching { proc.outputStream.close() }
        val out = proc.inputStream.bufferedReader().use { it.readText() }
        val exit = proc.waitFor()
        when (out.trim().lines().lastOrNull()?.trim()) {
            "REAPED" -> ReapOutcome.REAPED
            "ABSENT" -> ReapOutcome.ABSENT
            else -> {
                if (exit != 0) Log.w(TAG, "Chain-lock reap exited $exit for ${lockDir.name}")
                ReapOutcome.LOCKED
            }
        }
    } catch (e: Exception) {
        Log.w(TAG, "Chain-lock reap failed for ${lockDir.name}; lock left as is", e)
        ReapOutcome.LOCKED
    }
}
