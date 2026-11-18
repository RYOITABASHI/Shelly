package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** ApprovalSwitchCore: one lock for enable / disable / STOP-ALL, plus the decision generation. */
class ApprovalSwitchCoreTest {
    private var on = false
    private var halted = false
    private var setOffCalls = 0

    private fun enable() = ApprovalSwitchCore.enable({ halted }, { on = true; true }, { on = false })
    private fun stopAll() = ApprovalSwitchCore.stopAll(listOf({ setOffCalls += 1; on = false }), listOf({ on }))

    @Before
    fun reset() {
        ApprovalSwitchCore.resetForTests()
        on = false
        halted = false
        setOffCalls = 0
    }

    @Test
    fun enableIsRefusedOnceStopAllWroteTheSentinel() {
        halted = true
        assertFalse(enable())
        assertFalse(on)
    }

    @Test
    fun stopAllTurnsOffUnconditionally() {
        // Even when the switch reads OFF (the old isOn()-then-setOff race), setOff runs.
        assertTrue(stopAll())
        assertEquals(1, setOffCalls)
        assertTrue(enable())
        assertTrue(stopAll())
        assertFalse(on)
    }

    @Test
    fun anEnableThatRacesStopAllNeverSurvivesIt() {
        // Race 1: the enable passes its check before `.halted` exists. STOP-ALL
        // writes the sentinel, then takes the lock: whichever order the lock
        // gives, the switch is OFF afterwards.
        val inside = CountDownLatch(1)
        val release = CountDownLatch(1)
        val t = Thread {
            ApprovalSwitchCore.enable({ halted }, { inside.countDown(); release.await(2, TimeUnit.SECONDS); on = true; true }, { on = false })
        }
        t.start()
        assertTrue(inside.await(2, TimeUnit.SECONDS))
        halted = true // STOP-ALL wrote the sentinel while the enable held the lock
        val s = Thread { stopAll() }
        s.start()
        release.countDown()
        t.join(2_000)
        s.join(2_000)
        assertFalse(on)
        assertFalse(enable())
    }

    @Test
    fun aDecisionTokenDiesWithAnyWrite() {
        enable()
        val token = ApprovalSwitchCore.token({ on }, { halted })
        assertNotNull(token)
        assertEquals(true, ApprovalSwitchCore.withToken(token!!, { on }, { halted }) { true })
        // Race 2: decided while ON, then STOP-ALL (or any OFF / ON) before the answer.
        stopAll()
        enable() // even turned back on: the old decision is still dead
        assertNull(ApprovalSwitchCore.withToken(token, { on }, { halted }) { true })
        val fresh = ApprovalSwitchCore.token({ on }, { halted })!!
        ApprovalSwitchCore.disable({ on = false }, { on })
        assertNull(ApprovalSwitchCore.withToken(fresh, { true }, { false }) { true })
    }

    @Test
    fun noTokenWhileOffOrHalted() {
        assertNull(ApprovalSwitchCore.token({ on }, { halted }))
        enable()
        halted = true
        assertNull(ApprovalSwitchCore.token({ on }, { halted }))
        val t = ApprovalSwitchCore.generationNow()
        assertNull(ApprovalSwitchCore.withToken(t, { true }, { halted }) { true })
    }

    @Test
    fun whileOnRunsOnlyWhileOnAndNotHalted() {
        assertNull(ApprovalSwitchCore.whileOn({ on }, { halted }) { 1 })
        enable()
        assertEquals(1, ApprovalSwitchCore.whileOn({ on }, { halted }) { 1 })
        halted = true
        assertNull(ApprovalSwitchCore.whileOn({ on }, { halted }) { 1 })
    }
}
