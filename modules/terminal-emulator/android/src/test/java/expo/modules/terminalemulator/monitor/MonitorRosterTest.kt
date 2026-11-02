package expo.modules.terminalemulator.monitor

import expo.modules.terminalemulator.monitor.MonitorProgress.Branch
import expo.modules.terminalemulator.monitor.MonitorProgress.Run
import expo.modules.terminalemulator.monitor.MonitorWidgetModel.CamState
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MonitorRosterTest {
    private fun file(roles: String, extra: String = "") =
        """{"kind":"shelly-monitor-roster","version":1,"unavailable":false$extra,"roles":[$roles]}"""

    private fun role(name: String, engine: String = "Codex", kind: String = "CLI") =
        """{"name":${JSONObject.quote(name)},"engine":${JSONObject.quote(engine)},"kind":"$kind","handles":["implement"]}"""

    @Test
    fun parsesEntriesAndTotal() {
        val r = MonitorRoster.parse(file(role("Implementer") + "," + role("Reviewer", "Claude Code"), ",\"total\":2"))
        assertTrue(r.present)
        assertFalse(r.unavailable)
        assertEquals(listOf("Implementer", "Reviewer"), r.entries.map { it.name })
        assertEquals(listOf("Codex", "Claude Code"), r.entries.map { it.engine })
        assertEquals(2, r.total)
        assertEquals(0, r.hidden)
    }

    @Test
    fun capsEntriesAndText() {
        val roles = (1..12).joinToString(",") { role("Role number $it with a long name") }
        val r = MonitorRoster.parse(file(roles, ",\"total\":12"))
        assertEquals(MonitorRoster.MAX_ENTRIES, r.entries.size)
        assertTrue(r.entries.all { it.name.codePointCount(0, it.name.length) <= MonitorRoster.MAX_TEXT_CHARS })
        assertEquals(12, r.total)
        assertEquals(4, r.hidden)
    }

    @Test
    fun dropsControlAndFormatCharacters() {
        // Bidi override (U+202E), zero-width space (U+200B), newline, ESC.
        val r = MonitorRoster.parse(file(role("Re\u202Eview\u200Ber\n\u001B[31m")))
        val name = r.entries.single().name
        assertFalse(name.any { it == '\u202E' || it == '\u200B' || it == '\n' || it == '\u001B' })
        assertTrue(name.startsWith("Re view er"))
    }

    @Test
    fun failsClosedOnForeignOrBrokenFiles() {
        assertTrue(MonitorRoster.parse("not json").isEmpty)
        assertTrue(MonitorRoster.parse("""{"kind":"shelly-roles","version":1,"roles":[]}""").isEmpty)
        assertTrue(MonitorRoster.parse("""{"kind":"shelly-monitor-roster","version":2,"roles":[${role("A")}]}""").isEmpty)
        assertTrue(MonitorRoster.parse(null).isEmpty)
        assertFalse(MonitorRoster.parse(null).present)
        // Unknown kinds dropped, empty names skipped, duplicate names once.
        val r = MonitorRoster.parse(file(role("A", kind = "ROOT") + "," + role("   ") + "," + role("a")))
        assertEquals(listOf("A"), r.entries.map { it.name })
        assertNull(r.entries.single().kind)
    }

    @Test
    fun unavailableHasNoNames() {
        val r = MonitorRoster.parse("""{"kind":"shelly-monitor-roster","version":1,"unavailable":true,"total":0,"roles":[${role("A")}]}""")
        assertTrue(r.unavailable)
        assertTrue(r.isEmpty)
    }

    @Test
    fun channelLabelMatchesLiveChannelLabel() {
        assertEquals("REVIEWER", MonitorRoster.channelLabel("Reviewer"))
        assertEquals("IMPLEMENTE", MonitorRoster.channelLabel("Implementer"))
        assertEquals("レビュー役", MonitorRoster.channelLabel("レビュー役"))
        assertEquals("", MonitorRoster.channelLabel("  "))
    }

    @Test
    fun stepRoleNamesFromAgentDefinition() {
        val agent = JSONObject(
            """{"id":"a1","orchestration":{"steps":["plain",{"instruction":"x","role":{"name":"Implementer","instructions":"secret"}},{"instruction":"y"}]}}"""
        )
        assertEquals(listOf(null, "Implementer", null), MonitorRoster.stepRoleNames(agent))
        assertEquals(emptyList<String?>(), MonitorRoster.stepRoleNames(null))
    }

    // ── Model ──

    private val roster = MonitorRoster.parse(
        file(
            listOf(role("Implementer"), role("Reviewer", "Claude Code"), role("Judge", "Local LLM", "LOCAL"),
                role("Writer", "Gemini API", "API"), role("Translator", "Groq", "API")).joinToString(","),
            ",\"total\":5"
        )
    )

    @Test
    fun idleStaffFull() {
        val cams = MonitorWidgetModel.staffCameras(roster, slim = false)
        assertEquals(listOf("IMPLEMENTE", "REVIEWER", "JUDGE", "WRITER"), cams.map { it.channel })
        assertTrue(cams.all { it.staff && it.state == CamState.STANDBY && it.stepIndex == null })
        assertEquals(listOf("Codex", "Claude Code", "Local LLM", "Gemini API"), cams.map { it.providerLabel })
        assertEquals(1, MonitorWidgetModel.staffHidden(roster))
    }

    @Test
    fun idleStaffSlimShowsPlusN() {
        val cams = MonitorWidgetModel.staffCameras(roster, slim = true)
        assertEquals(4, cams.size)
        assertEquals(2, cams[3].overflow)
        assertEquals(listOf("IMPLEMENTE", "REVIEWER", "JUDGE"), cams.take(3).map { it.channel })
    }

    @Test
    fun idleStaffEmptyWhenNoRoles() {
        assertTrue(MonitorWidgetModel.staffCameras(MonitorRoster.parse(file("")), slim = false).isEmpty())
        val two = MonitorRoster.parse(file(role("A") + "," + role("B")))
        assertEquals(2, MonitorWidgetModel.staffCameras(two, slim = true).size)
    }

    @Test
    fun runShowsRoleChannelsAndStaffInFreeSlots() {
        val now = 1_000_000_000L
        val run = Run(
            runId = "r1", agentId = "a1", startedAtMs = now - 60_000, stepCount = 2,
            branches = listOf(
                Branch(0, "RUNNING", startedAtMs = now - 50_000, updatedAtMs = now - 1_000),
                Branch(1, "WAITING_APPROVAL", startedAtMs = now - 40_000, updatedAtMs = now - 1_000)
            )
        )
        val base = MonitorWidgetModel.build(run, now, nativeRunActive = true)
        val m = MonitorWidgetModel.withRoles(base, listOf("Implementer", "Reviewer"), roster)
        assertEquals(listOf("IMPLEMENTE", "REVIEWER", "JUDGE", "WRITER"), m.cameras.map { it.channel })
        assertEquals(listOf(CamState.RUNNING, CamState.APPROVAL, CamState.STANDBY, CamState.STANDBY), m.cameras.map { it.state })
        assertEquals(listOf(false, false, true, true), m.cameras.map { it.staff })
        assertEquals("REVIEWER", m.approvalChannel)
        // No roles on the steps: CH-0n stays, free slots still get staff.
        val plain = MonitorWidgetModel.withRoles(base, emptyList(), roster)
        assertEquals(listOf("CH-01", "CH-02", "IMPLEMENTE", "REVIEWER"), plain.cameras.map { it.channel })
        assertEquals("CH-02", plain.approvalChannel)
    }

    @Test
    fun duplicateRoleStepsGetStepNumbers() {
        assertEquals(mapOf(0 to "IMPLEMEN·1", 1 to "IMPLEMEN·2", 2 to "REVIEWER"),
            MonitorWidgetModel.roleChannels(listOf("Implementer", "Implementer", "Reviewer")))
    }
}
