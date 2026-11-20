package expo.modules.terminalemulator

import expo.modules.terminalemulator.ConnectivityGuardianCore.Effect
import expo.modules.terminalemulator.ConnectivityGuardianCore.Event
import expo.modules.terminalemulator.ConnectivityGuardianCore.LossClock
import expo.modules.terminalemulator.ConnectivityGuardianCore.Mode
import expo.modules.terminalemulator.ConnectivityGuardianCore.Pending
import expo.modules.terminalemulator.ConnectivityGuardianCore.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ConnectivityGuardianCore (android-free). Like TriggerDebouncerTest, not
 * wired into CI's Gradle run yet; the same scenarios run in jest against the
 * TS port (__tests__/connectivity-guardian-core.test.ts), and
 * __tests__/connectivity-guardian-native.test.ts keeps the two in lockstep.
 */
class ConnectivityGuardianCoreTest {
    private class FakePorts(
        var adb: Int? = 0,
        var shizuku: Boolean = false,
        var vpn: Boolean? = false,
        var preapproved: Boolean = true,
        var vpnFollows: Boolean = true,
        /** ClosePaw acts (and its run settles) this long after the hand-off. */
        var closePawDelayMs: Long = 0L,
        var stopAllAfterDispatch: Boolean = false,
    ) : ConnectivityGuardianCore.Ports {
        var now = 1_000_000L
        val calls = mutableListOf<String>()
        val notes = mutableListOf<String>()
        val outcomes = mutableListOf<String>()
        var stop = false
        /** When the in-flight (connect-only) ClosePaw run acts. */
        private var inFlight: Long? = null
        private fun land() {
            val f = inFlight ?: return
            if (now >= f) { if (vpnFollows) vpn = true; inFlight = null }
        }
        override fun nowMs() = now
        override fun sleep(ms: Long) { now += ms; land() }
        override fun enabled() = true
        override fun stopAll() = stop
        override fun superseded() = false
        override fun hasWriteSecureSettings() = true
        override fun readAdbWifi() = adb
        override fun writeAdbWifi(value: Int): Boolean {
            calls += "adb:$value"; adb = value; if (value == 1) shizuku = true; return true
        }
        override fun shizukuAlive() = shizuku
        override fun wifiUp(): Boolean? = true
        var vpnProbes = 0
        override fun vpnUp(): Boolean? { vpnProbes++; land(); return vpn }
        override fun closePawPreapproved() = preapproved
        override fun requestTailscale(): String? {
            calls += "tailscale:connect"
            inFlight = now + closePawDelayMs
            land()
            if (stopAllAfterDispatch) stop = true
            return "1763000000000-0123abcd"
        }
        override fun closePawSettled(reqId: String): Boolean { land(); return inFlight == null }
        override fun audit(seq: String, step: String, action: String, before: String, after: String, outcome: String) {
            assertTrue(ConnectivityGuardianCore.buildAuditLine("2026-11-17T00:00:00.000Z", seq, step, action, before, after, outcome) != null)
            outcomes += "$step:$action:$outcome"
        }
        override fun notifyAssist(reason: String) { notes += reason }
    }

    @Test
    fun onOrderAndOffOrder() {
        val p = FakePorts()
        assertEquals("done", ConnectivityGuardianCore.runOnSequence(p, ConnectivityGuardianCore.RunnerMemory(), "on-1"))
        assertEquals(listOf("adb:1", "tailscale:connect"), p.calls)
        p.calls.clear()
        // OFF (since 2026-11-17): wireless debugging only; Tailscale stays up.
        assertEquals("done", ConnectivityGuardianCore.runOffSequence(p, "off-1"))
        assertEquals(listOf("adb:0"), p.calls)
        assertEquals(true, p.vpn)
    }

    @Test
    fun offIssuesNoTailscaleRequest() {
        val p = FakePorts(adb = 1, shizuku = true, vpn = true, preapproved = true)
        assertEquals("done", ConnectivityGuardianCore.runOffSequence(p, "off-1"))
        assertEquals(listOf("adb:0"), p.calls)
        assertEquals(0, p.vpnProbes)
        assertTrue(p.outcomes.none { it.startsWith("tailscale:") })
        assertEquals(listOf("wifi_debug:disable:ok", "sequence:end:done"), p.outcomes)
    }

    @Test
    fun offDoesNotDependOnPreapproval() {
        val p = FakePorts(adb = 1, shizuku = true, vpn = true, preapproved = false)
        assertEquals("done", ConnectivityGuardianCore.runOffSequence(p, "off-1"))
        assertEquals(listOf("adb:0"), p.calls)
        assertEquals(emptyList<String>(), p.notes)
    }

    @Test
    fun preapprovalOffNeverDispatches() {
        val p = FakePorts(adb = 1, shizuku = true, preapproved = false)
        assertEquals("assist", ConnectivityGuardianCore.runOnSequence(p, ConnectivityGuardianCore.RunnerMemory(), "on-1"))
        assertEquals(emptyList<String>(), p.calls)
        assertEquals(listOf("tailscale_preapproval_off"), p.notes)
    }

    @Test
    fun closePawSaysOkButVpnStaysDownIsFailed() {
        val p = FakePorts(adb = 1, shizuku = true, vpnFollows = false)
        assertEquals("failed", ConnectivityGuardianCore.runOnSequence(p, ConnectivityGuardianCore.RunnerMemory(), "on-1"))
    }

    private val t0 = 1_800_000_000_000L
    /** elapsedRealtime at wall t0, and the boot identity. */
    private val e0 = 5_000_000L
    private val b0 = 3L
    /** "Now" with the wall clock and elapsedRealtime moving together. */
    private fun clk(wall: Long, bootId: Long? = b0) = LossClock(wall, wall - t0 + e0, bootId)

    @Test
    fun debounceAndStaleToken() {
        val lost = ConnectivityGuardianCore.reduce(State(Mode.IDLE_ONLINE, 0, Pending.NONE), Event.WifiLost(clk(t0)))
        assertEquals(listOf<Effect>(Effect.ArmDebounce(1, 45_000)), lost.effects)
        val back = ConnectivityGuardianCore.reduce(lost.state, Event.WifiAvailable)
        assertEquals(Mode.IDLE_ONLINE, back.state.mode)
        val stale = ConnectivityGuardianCore.reduce(back.state, Event.DebounceExpired(1, false))
        assertEquals(emptyList<Effect>(), stale.effects)
    }

    @Test
    fun stopAllAfterDispatchStillWaitsForTheRunToSettle() {
        val p = FakePorts(adb = 1, shizuku = true, vpn = false, closePawDelayMs = 60_000L, stopAllAfterDispatch = true)
        val start = p.now
        assertEquals("stopped", ConnectivityGuardianCore.runOnSequence(p, ConnectivityGuardianCore.RunnerMemory(), "on-1"))
        assertTrue(p.now - start >= 60_000L)
        assertEquals(true, p.vpn)
        assertEquals(
            listOf("wifi_debug:check:already", "shizuku:check:already", "tailscale:connect:stopped", "tailscale:wait:settled", "sequence:end:stopped"),
            p.outcomes,
        )
    }

    @Test
    fun aRunThatNeverSettlesIsBounded() {
        val p = FakePorts(adb = 1, shizuku = true, vpn = false, closePawDelayMs = Long.MAX_VALUE / 2, stopAllAfterDispatch = true)
        val start = p.now
        assertEquals("stopped", ConnectivityGuardianCore.runOnSequence(p, ConnectivityGuardianCore.RunnerMemory(), "on-1"))
        assertTrue(p.now - start >= ConnectivityGuardianCore.CLOSEPAW_SETTLE_MS)
        assertTrue(p.now - start < ConnectivityGuardianCore.CLOSEPAW_SETTLE_MS + 10_000L)
        assertEquals("tailscale:wait:settle_timeout", p.outcomes[p.outcomes.size - 2])
    }

    @Test
    fun processDeathDuringOnOwesCleanupOrRerun() {
        val running = State(Mode.ON_RUNNING, 3, Pending.NONE)
        assertEquals("in_flight", ConnectivityGuardianCore.persistableMode(running))
        val restored = ConnectivityGuardianCore.restoreState(true, "in_flight", 3)
        assertEquals(State(Mode.IDLE_ONLINE, 3, Pending.ON), restored)
        // Wi-Fi gone: the loss is armed (OFF cleanup), ON again on regain.
        val lost = ConnectivityGuardianCore.reduce(restored, Event.Reconcile(false, clk(t0)))
        assertEquals(State(Mode.LOSS_PENDING, 4, Pending.ON, t0, true, e0, b0), lost.state)
        assertEquals(listOf<Effect>(Effect.ArmDebounce(4, 45_000)), lost.effects)
        // Wi-Fi present: ON reruns.
        assertEquals(listOf<Effect>(Effect.RunOn), ConnectivityGuardianCore.reduce(restored, Event.Reconcile(true, clk(t0))).effects)
        // Boot without Wi-Fi schedules the cleanup.
        val boot = ConnectivityGuardianCore.reduce(restored, Event.Boot(true, false, clk(t0)))
        assertEquals(Mode.LOSS_PENDING, boot.state.mode)
        assertTrue(boot.effects.contains(Effect.ArmDebounce(4, 45_000)))
    }

    @Test
    fun recoveryOfAConsumedDebounceUsesTheRemainingBudget() {
        // Pending OFF (the alarm fired during ON), then the process died: the deadline passed -> OFF at once.
        val s = ConnectivityGuardianCore.restoreState(true, ConnectivityGuardianCore.persistableMode(State(Mode.ON_RUNNING, 7, Pending.OFF, t0)), 7, t0)
        assertEquals(State(Mode.LOSS_PENDING, 7, Pending.ON, t0), s)
        val rec = ConnectivityGuardianCore.reduce(s, Event.Reconcile(false, clk(t0 + 60_000)))
        assertEquals(Mode.OFF_RUNNING, rec.state.mode)
        assertEquals(listOf<Effect>(Effect.RunOff), rec.effects)
        // Alarm gone 40 s in: the SAME token, armed for the 5 s left.
        val plain = ConnectivityGuardianCore.reduce(
            ConnectivityGuardianCore.restoreState(true, "loss_pending", 1, t0), Event.Reconcile(false, clk(t0 + 40_000)),
        )
        assertEquals(listOf<Effect>(Effect.ArmDebounce(1, 5_000)), plain.effects)
        assertEquals(State(Mode.LOSS_PENDING, 1, Pending.NONE, t0, true, e0, b0), plain.state)
    }

    @Test
    fun reconcileNeverResetsALiveLossDebounce() {
        // Coordinator gate round 2 reproduction: loss arms token 1, reconcile 40 s in must not re-arm.
        val lost = ConnectivityGuardianCore.reduce(State(Mode.IDLE_ONLINE, 0, Pending.NONE), Event.WifiLost(clk(t0)))
        assertEquals(listOf<Effect>(Effect.ArmDebounce(1, 45_000)), lost.effects)
        var s = lost.state
        for (at in listOf(10_000L, 20_000L, 40_000L)) {
            val rec = ConnectivityGuardianCore.reduce(s, Event.Reconcile(false, clk(t0 + at)))
            assertEquals(lost.state, rec.state)
            assertEquals(emptyList<Effect>(), rec.effects)
            s = rec.state
        }
        val fired = ConnectivityGuardianCore.reduce(s, Event.DebounceExpired(1, false))
        assertEquals(listOf<Effect>(Effect.RunOff), fired.effects)
        // Across process deaths: remaining budget only, same token, never past the deadline.
        for (at in listOf(10_000L, 20_000L, 30_000L)) {
            val r = ConnectivityGuardianCore.reduce(
                ConnectivityGuardianCore.restoreState(true, "loss_pending", 1, t0), Event.Reconcile(false, clk(t0 + at)),
            )
            assertEquals(listOf<Effect>(Effect.ArmDebounce(1, 45_000 - at)), r.effects)
        }
        // Deadline passed: OFF at once; clock set backwards: at most one full debounce.
        assertEquals(
            listOf<Effect>(Effect.RunOff),
            ConnectivityGuardianCore.reduce(ConnectivityGuardianCore.restoreState(true, "loss_pending", 1, t0), Event.Reconcile(false, clk(t0 + 45_000))).effects,
        )
        assertEquals(45_000L, ConnectivityGuardianCore.lossRemainingMs(t0, t0 - 3_600_000))
        // Reboot during the debounce keeps the token and deadline too.
        val boot = ConnectivityGuardianCore.reduce(ConnectivityGuardianCore.restoreState(true, "loss_pending", 4, t0), Event.Boot(true, false, clk(t0 + 20_000)))
        assertEquals(listOf(Effect.RegisterCallbacks, Effect.ArmDebounce(4, 25_000)), boot.effects)
    }

    @Test
    fun anUndurableCheckpointHoldsOnBack() {
        val t = ConnectivityGuardianCore.reduce(State(Mode.IDLE_OFFLINE, 0, Pending.NONE), Event.WifiAvailable)
        assertEquals(listOf<Effect>(Effect.RunOn), t.effects)
        val held = ConnectivityGuardianCore.withoutUndurableOn(t)
        assertEquals(emptyList<Effect>(), held.effects)
        assertEquals(State(Mode.IDLE_ONLINE, 0, Pending.ON), held.state)
        val off = ConnectivityGuardianCore.reduce(State(Mode.LOSS_PENDING, 1, Pending.NONE), Event.DebounceExpired(1, false))
        assertEquals(off, ConnectivityGuardianCore.withoutUndurableOn(off))
    }

    @Test
    fun residentExactlyWhileAnOffObligationMayExist() {
        assertTrue(ConnectivityGuardianCore.wantsResident(State(Mode.IDLE_ONLINE, 0, Pending.NONE)))
        assertTrue(ConnectivityGuardianCore.wantsResident(State(Mode.LOSS_PENDING, 0, Pending.NONE)))
        assertEquals(false, ConnectivityGuardianCore.wantsResident(State(Mode.IDLE_OFFLINE, 0, Pending.NONE)))
        assertEquals(false, ConnectivityGuardianCore.wantsResident(State(Mode.DISABLED, 0, Pending.NONE)))
    }

    @Test
    fun lineMatchesTheQueueFormat() {
        val line = ConnectivityGuardianCore.closePawLine("1763000000000-0123abcd", 1763000000000, "a:b c/ワ")
        assertEquals("closepaw:1763000000000-0123abcd:1763000000000:a%3Ab%20c%2F%E3%83%AF", line)
        assertNull(ConnectivityGuardianCore.closePawLine("bad", 1, "x"))
    }

    /** Coordinator gate round 3: the remaining budget is monotonic on the
     *  same boot; a wall clock set back one hour cannot restart it across
     *  process deaths. */
    @Test
    fun wallClockRollbackAcrossRestartsKeepsTheMonotonicDeadline() {
        val hour = 3_600_000L
        fun rolledBack(real: Long) = LossClock(t0 - hour + real, e0 + real, b0)
        fun persisted(s: State) = ConnectivityGuardianCore.restoreState(
            true, ConnectivityGuardianCore.persistableMode(s), s.lossToken, s.lossAtMs, s.lossElapsedMs, s.lossBootId,
        )
        val lost = ConnectivityGuardianCore.reduce(State(Mode.IDLE_ONLINE, 0, Pending.NONE), Event.WifiLost(clk(t0)))
        assertEquals(State(Mode.LOSS_PENDING, 1, Pending.NONE, t0, true, e0, b0), lost.state)
        // In-process rollback: the live alarm is left alone.
        assertEquals(emptyList<Effect>(), ConnectivityGuardianCore.reduce(lost.state, Event.Reconcile(false, rolledBack(30_000))).effects)
        // Reviewer's restarts at +40 / +80 / +120: 5 s armed at +40, then OFF at once.
        val r40 = ConnectivityGuardianCore.reduce(persisted(lost.state), Event.Reconcile(false, rolledBack(40_000)))
        assertEquals(listOf<Effect>(Effect.ArmDebounce(1, 5_000)), r40.effects)
        for (real in listOf(80_000L, 120_000L)) {
            val r = ConnectivityGuardianCore.reduce(persisted(r40.state), Event.Reconcile(false, rolledBack(real)))
            assertEquals(listOf<Effect>(Effect.RunOff), r.effects)
            assertEquals(1L, r.state.lossToken)
        }
        // Repeated restarts: each delay shrinks, total stays 45 s.
        var s = lost.state
        for (real in listOf(10_000L, 20_000L, 30_000L, 44_000L)) {
            val r = ConnectivityGuardianCore.reduce(persisted(s), Event.Reconcile(false, rolledBack(real)))
            assertEquals(listOf<Effect>(Effect.ArmDebounce(1, 45_000 - real)), r.effects)
            s = r.state
        }
    }

    @Test
    fun crossBootOrUnknownBootRecoveryExpiresAtOnce() {
        val s = ConnectivityGuardianCore.restoreState(true, "loss_pending", 1, t0, e0, b0)
        val afterReboot = LossClock(t0 + 20_000, 15_000, b0 + 1)
        assertEquals(listOf(Effect.RegisterCallbacks, Effect.RunOff), ConnectivityGuardianCore.reduce(s, Event.Boot(true, false, afterReboot)).effects)
        assertEquals(listOf<Effect>(Effect.RunOff), ConnectivityGuardianCore.reduce(s, Event.Reconcile(false, afterReboot)).effects)
        assertEquals(listOf<Effect>(Effect.RunOff), ConnectivityGuardianCore.reduce(s, Event.Reconcile(false, clk(t0 + 1_000, null))).effects)
        assertEquals(0L, ConnectivityGuardianCore.lossMonotonicRemainingMs(e0, null, clk(t0)))
        assertEquals(0L, ConnectivityGuardianCore.lossMonotonicRemainingMs(e0, b0, LossClock(t0, e0 - 1, b0)))
        assertEquals(35_000L, ConnectivityGuardianCore.lossMonotonicRemainingMs(e0, b0, LossClock(t0 - 3_600_000, e0 + 10_000, b0)))
    }

    @Test
    fun legacyLossFallsBackOnceAndStampsTheMonotonicAnchor() {
        val legacy = ConnectivityGuardianCore.restoreState(true, "loss_pending", 1, t0)
        val first = ConnectivityGuardianCore.reduce(legacy, Event.Reconcile(false, clk(t0 + 10_000)))
        assertEquals(listOf<Effect>(Effect.ArmDebounce(1, 35_000)), first.effects)
        assertEquals(State(Mode.LOSS_PENDING, 1, Pending.NONE, t0, true, e0, b0), first.state)
        val again = ConnectivityGuardianCore.restoreState(true, "loss_pending", 1, first.state.lossAtMs, first.state.lossElapsedMs, first.state.lossBootId)
        val second = ConnectivityGuardianCore.reduce(again, Event.Reconcile(false, LossClock(t0 - 3_600_000, e0 + 20_000, b0)))
        assertEquals(listOf<Effect>(Effect.ArmDebounce(1, 25_000)), second.effects)
    }
}
