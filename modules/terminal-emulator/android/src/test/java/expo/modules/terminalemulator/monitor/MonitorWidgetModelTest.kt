package expo.modules.terminalemulator.monitor

import expo.modules.terminalemulator.monitor.MonitorProgress.Branch
import expo.modules.terminalemulator.monitor.MonitorProgress.Provider
import expo.modules.terminalemulator.monitor.MonitorProgress.Run
import expo.modules.terminalemulator.monitor.MonitorProgress.Usage
import expo.modules.terminalemulator.monitor.MonitorWidgetModel.CamState
import expo.modules.terminalemulator.monitor.MonitorWidgetModel.Cost
import expo.modules.terminalemulator.monitor.MonitorWidgetModel.Outcome
import expo.modules.terminalemulator.monitor.MonitorWidgetModel.Tone
import expo.modules.terminalemulator.monitor.MonitorWidgetModel.Variant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MonitorWidgetModelTest {
    private val now = 1_000_000_000L

    private fun run(
        branches: List<Branch>,
        stepCount: Int? = branches.size,
        status: String? = null,
        ended: Boolean = status != null
    ) = Run(
        runId = "r1",
        agentId = "a1",
        startedAtMs = now - 60_000,
        endedAtMs = if (ended) now - 1_000 else null,
        status = status,
        stepCount = stepCount,
        branches = branches
    )

    private fun build(r: Run, mtime: Long = now - 1_000, native: Boolean = false, endedAt: Long? = null) =
        MonitorWidgetModel.build(r, now, mtime, native, iteration = null, nativeEndedAtMs = endedAt)

    private val api = Provider("API", "perplexity")
    private val cli = Provider("CLI", "cli:codex")
    private val local = Provider("LOCAL", "local", "Qwen3.5-2B-Q4_K_M")

    @Test
    fun liveParallelRun() {
        val m = build(run(listOf(
            Branch(0, "DONE", provider = api, usage = Usage(100.0, 50.0, 0.004), startedAtMs = 1),
            Branch(1, "RUNNING", provider = local, usage = Usage(1000.0, 200.0), startedAtMs = 2),
            Branch(2, "STANDBY")
        )))
        assertTrue(m.live)
        assertEquals(Outcome.RUNNING, m.outcome)
        assertEquals(Tone.LIVE, m.tone)
        // (1 settled + 0.5 running) / 3
        assertEquals(50, m.missionPct)
        assertNull(m.runEndMs)
        assertEquals(listOf("CH-01", "CH-02", "CH-03", "CH-04"), m.cameras.map { it.channel })
        assertEquals(listOf(CamState.DONE, CamState.RUNNING, CamState.STANDBY, CamState.NO_SIGNAL), m.cameras.map { it.state })
        assertEquals(listOf(Variant.DIM, Variant.LIVE, Variant.DIM, Variant.DIM), m.cameras.map { it.variant })
        assertEquals(listOf(100, 50, 0, 0), m.cameras.map { it.progress })
        assertEquals(Cost.Money(0.004), m.cameras[0].cost)
        assertEquals(Cost.Free, m.cameras[1].cost)
        assertEquals(Cost.None, m.cameras[2].cost)
        assertEquals("Perplexity", m.cameras[0].providerLabel)
        assertEquals("Qwen3.5-2B", m.cameras[1].providerLabel)
        assertTrue(m.costLine.hasApi && m.costLine.hasLocal && !m.costLine.hasCli)
        assertEquals(0.004, m.costLine.apiUsd!!, 1e-12)
        assertEquals(1200L, m.costLine.localTokens)
    }

    @Test
    fun approvalTurnsAmberAndNamesTheChannel() {
        val m = build(run(listOf(
            Branch(0, "DONE"),
            Branch(1, "WAITING_APPROVAL", provider = cli, approvalAsked = true)
        )))
        assertEquals("CH-02", m.approvalChannel)
        assertEquals(1, m.approvalStep)
        assertEquals(Tone.AMBER, m.tone)
        assertEquals(CamState.APPROVAL, m.cameras[1].state)
        assertEquals(Variant.ALERT, m.cameras[1].variant)
        assertEquals(Cost.Plan, m.cameras[1].cost)
        assertEquals("Codex CLI", m.cameras[1].providerLabel)
    }

    @Test
    fun apiWithoutUsdShowsTokensNotAnEstimate() {
        val m = build(run(listOf(Branch(0, "RUNNING", provider = api, usage = Usage(300.0, 200.0)))))
        assertEquals(Cost.Tokens(500), m.cameras[0].cost)
        assertNull(m.costLine.apiUsd)
        assertEquals(500L, m.costLine.apiTokens)
    }

    @Test
    fun unknownProviderShowsNoChipOrCost() {
        val m = build(run(listOf(Branch(0, "RUNNING"))))
        assertNull(m.cameras[0].kind)
        assertEquals(Cost.None, m.cameras[0].cost)
        assertTrue(m.costLine.isEmpty)
    }

    @Test
    fun successIsFullAndStopsLiveness() {
        val m = build(run(listOf(Branch(0, "DONE"), Branch(1, "DONE")), status = "success"))
        assertFalse(m.live)
        assertEquals(Outcome.SUCCESS, m.outcome)
        assertEquals(100, m.missionPct)
        assertEquals(Tone.DONE, m.tone)
        assertEquals(now - 1_000, m.runEndMs)
    }

    @Test
    fun haltedStartedStepIsStoppedNotSkipped() {
        val m = build(run(listOf(
            Branch(0, "SKIPPED", startedAtMs = 5),
            Branch(1, "SKIPPED")
        ), status = "halted"))
        assertEquals(Outcome.STOPPED, m.outcome)
        assertEquals(CamState.STOPPED, m.cameras[0].state)
        assertEquals(CamState.SKIPPED, m.cameras[1].state)
    }

    @Test
    fun declinedApprovalIsAUserStop() {
        val m = build(run(listOf(
            Branch(0, "SKIPPED", tail = "draft action declined", approvalAsked = true)
        ), status = "skipped"))
        assertEquals(CamState.STOPPED, m.cameras[0].state)
        assertEquals(Outcome.STOPPED, m.outcome)
        val timeout = build(run(listOf(
            Branch(0, "SKIPPED", tail = "draft action approval timed out", approvalAsked = true)
        ), status = "skipped"))
        assertEquals(CamState.SKIPPED, timeout.cameras[0].state)
    }

    @Test
    fun failedRun() {
        val m = build(run(listOf(Branch(0, "FAILED"), Branch(1, "STANDBY")), status = "error"))
        assertEquals(Outcome.FAILED, m.outcome)
        assertEquals(Tone.FAIL, m.tone)
        assertEquals(Variant.FAIL, m.cameras[0].variant)
    }

    @Test
    fun silentRunStopsRecording() {
        val r = run(listOf(Branch(0, "RUNNING")))
        // Quiet for longer than the limit, nothing native vouches for it.
        val quiet = build(r, mtime = now - MonitorWidgetModel.SILENT_RUN_AFTER_MS - 1)
        assertFalse(quiet.live)
        assertEquals(CamState.STOPPED, quiet.cameras[0].state)
        // The runtime is still executing it: stays live however quiet.
        assertTrue(build(r, mtime = now - MonitorWidgetModel.SILENT_RUN_AFTER_MS - 1, native = true).live)
        // Native saw the process end and nothing was written after it.
        assertFalse(build(r, mtime = now - 2_000, endedAt = now - 1_000).live)
        // A write well after that end belongs to a new run.
        assertTrue(build(r, mtime = now - 1_000, endedAt = now - 60_000).live)
    }

    @Test
    fun windowFollowsTheFirstUnsettledStep() {
        val branches = (0 until 7).map { i -> Branch(i, if (i < 4) "DONE" else if (i == 4) "RUNNING" else "STANDBY") }
        val m = build(run(branches))
        assertEquals(listOf("CH-04", "CH-05", "CH-06", "CH-07"), m.cameras.map { it.channel })
        assertEquals(listOf(3, 4, 5, 6), m.cameras.map { it.stepIndex })
        assertEquals(0, MonitorWidgetModel.windowStart(3, 2))
        assertEquals(3, MonitorWidgetModel.windowStart(7, null))
        assertEquals(1, MonitorWidgetModel.windowStart(6, 1))
    }

    @Test
    fun stepsNotYetReportedAreStandby() {
        val m = build(run(listOf(Branch(0, "RUNNING")), stepCount = 3))
        assertEquals(listOf(CamState.RUNNING, CamState.STANDBY, CamState.STANDBY, CamState.NO_SIGNAL), m.cameras.map { it.state })
        assertEquals(17, m.missionPct) // 0.5 / 3
    }

    @Test
    fun equalInputsGiveEqualModels() {
        val r = run(listOf(Branch(0, "RUNNING", tail = "a")))
        val r2 = r.copy(branches = listOf(Branch(0, "RUNNING", tail = "b")))
        // A tail-only change does not change what the widget shows.
        assertEquals(build(r), build(r2))
    }

    @Test
    fun operatorMatchesThePane() {
        // lib/monitor-live.ts liveOperator('a1', i) -> [5, 1, 2, 3, 4]
        assertEquals(listOf(5, 1, 2, 3, 4), (0 until 5).map { MonitorWidgetModel.operator("a1", it) })
        assertEquals(5_863_159L, MonitorWidgetModel.hash("a1"))
    }

    @Test
    fun money() {
        assertEquals("¥0.60", MonitorWidgetModel.formatMoney(0.004, japanese = true))
        assertEquals("¥1,500", MonitorWidgetModel.formatMoney(10.0, japanese = true))
        assertEquals("$0.0040", MonitorWidgetModel.formatMoney(0.004, japanese = false))
        assertEquals("$12.50", MonitorWidgetModel.formatMoney(12.5, japanese = false))
        assertEquals("¥0", MonitorWidgetModel.zeroMoney(true))
        assertEquals("$0", MonitorWidgetModel.zeroMoney(false))
        assertEquals("6.8k tok", MonitorWidgetModel.formatTokens(6840))
        assertEquals("420 tok", MonitorWidgetModel.formatTokens(420))
    }
}
