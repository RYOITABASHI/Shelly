package expo.modules.terminalemulator

/**
 * The one lock behind the two approval switches ("MCP: Run without approval",
 * "Skip all approvals") and STOP-ALL, plus a generation counter. Pure (the
 * switches and the STOP-ALL sentinel come in as functions), so the JVM test
 * ApprovalSwitchCoreTest covers the races:
 *
 *  - enable / disable / STOP-ALL are serialized; enable re-checks STOP-ALL
 *    INSIDE the lock, so a Settings enable that raced a STOP-ALL can never
 *    leave a switch on after it (STOP-ALL writes `.halted` first, then takes
 *    this lock; an enable after that sees `.halted`);
 *  - STOP-ALL turns both switches off unconditionally (no isOn() first);
 *  - every write bumps [generation]. A master-switch auto-approval gets a
 *    token ([token]) when it starts deciding, and is answered only through
 *    [withToken], which re-checks — under the same lock — that the switch is
 *    still on, STOP-ALL is not active and nothing was written since. So a
 *    decision made before an OFF can never be answered after it.
 *  - [whileOn] runs a headless MCP action only while its switch is on and
 *    STOP-ALL is not active, under the lock.
 *
 * Lock order: callers may hold their own lock (McpRawToolConsumer.commitLock)
 * and then take this one; nothing here calls out while holding it except the
 * given functions (switch reads / writes, a sentinel lstat, the reply write).
 */
object ApprovalSwitchCore {
    private val lock = Any()
    @Volatile private var generation = 0L

    fun generationNow(): Long = synchronized(lock) { generation }

    /** Turn a switch ON (Settings toggle only). False, and the switch left OFF, while STOP-ALL is active. */
    fun enable(halted: () -> Boolean, setOn: () -> Boolean, setOff: () -> Unit): Boolean = synchronized(lock) {
        generation += 1
        if (halted()) {
            setOff()
            false
        } else {
            setOn()
        }
    }

    /** Turn a switch OFF. Returns whether it still reads ON (it should not). */
    fun disable(setOff: () -> Unit, isOn: () -> Boolean): Boolean = synchronized(lock) {
        generation += 1
        setOff()
        isOn()
    }

    /** STOP-ALL: every switch OFF, unconditionally. Returns whether all read OFF afterwards. */
    fun stopAll(setOffs: List<() -> Unit>, isOns: List<() -> Boolean>): Boolean = synchronized(lock) {
        generation += 1
        for (off in setOffs) runCatching { off() }
        isOns.none { runCatching { it() }.getOrDefault(true) }
    }

    /** The token a master-switch decision carries, or null when the switch is off / STOP-ALL is active. */
    fun token(isOn: () -> Boolean, halted: () -> Boolean): Long? = synchronized(lock) {
        if (isOn() && !halted()) generation else null
    }

    /** Runs [block] only if [token] is current, the switch is on and STOP-ALL is not active. Null otherwise. */
    fun <T> withToken(token: Long, isOn: () -> Boolean, halted: () -> Boolean, block: () -> T): T? = synchronized(lock) {
        if (token == generation && isOn() && !halted()) block() else null
    }

    /** Runs [block] only while the switch is on and STOP-ALL is not active. Null otherwise. */
    fun <T> whileOn(isOn: () -> Boolean, halted: () -> Boolean, block: () -> T): T? = synchronized(lock) {
        if (isOn() && !halted()) block() else null
    }

    /** Test hook. */
    fun resetForTests() = synchronized(lock) { generation = 0L }
}
