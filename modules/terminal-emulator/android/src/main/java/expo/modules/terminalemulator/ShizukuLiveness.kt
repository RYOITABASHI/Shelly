package expo.modules.terminalemulator

import rikka.shizuku.Shizuku

/**
 * "Does the Shizuku server answer?" for the connectivity guardian.
 *
 * ONLY Shizuku.pingBinder() (client API dev.rikka.shizuku:api, binder
 * delivered through rikka.shizuku.ShizukuProvider in the module manifest).
 * Never requests Shizuku permission, never binds a user service, never runs
 * anything through Shizuku, and never starts Shizuku: the guardian waits for
 * Shizuku's own auto-start (owner decision C1). Any error reads as down.
 */
object ShizukuLiveness {
    fun isAlive(): Boolean = try {
        Shizuku.pingBinder()
    } catch (t: Throwable) {
        false
    }
}
