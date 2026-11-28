package expo.modules.terminalemulator

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure half of the residency ledger (ResidencyLedgerCore): line shape,
 * canonical form, chain verification, tail-anchor truncation detection and
 * rotation. The file I/O and the Keystore MAC need a device. Not run by CI
 * (build-dev-debug.yml / build-android.yml only assemble).
 */
class ResidencyLedgerCoreTest {
    private val boot = "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b"

    private fun sample(
        at: Long = 1_764_300_000_000L, svc: String = "council-facade", reason: String = "tick",
        pid: Int? = 4242, health: ResidencyLedgerCore.Health? = ResidencyLedgerCore.Health(true, listOf("codex", "claude"), 12),
        code: String? = null,
    ) = ResidencyLedgerCore.Sample(
        at = at, elapsedRealtime = 99_000L, bootId = boot, svc = svc, pid = pid,
        startTicks = pid?.let { 123_456L }, startedAt = 1_764_299_000_000L, alive = pid != null,
        heartbeatAt = null, health = health, versionCode = 2801L, reason = reason, code = code,
    )

    /** A fake MAC (the Keystore one is not available on the JVM): sha256 of a domain + the canonical form. */
    private fun fakeMac(canonical: String) = ResidencyLedgerCore.sha256Hex("k:$canonical")

    /** Builds [n] chained lines starting at [firstSeq] after [prev]. */
    private fun chain(n: Int, firstSeq: Long = 1, prev: String = ""): List<String> {
        val out = ArrayList<String>()
        var p = prev
        for (i in 0 until n) {
            val c = ResidencyLedgerCore.canonical(sample(at = 1_764_300_000_000L + i * 600_000L), firstSeq + i, p)!!
            val line = ResidencyLedgerCore.signed(c, fakeMac(c))
            out.add(line)
            p = ResidencyLedgerCore.sha256Hex(line)
        }
        return out
    }

    @Test
    fun canonicalHasTheFixedKeyOrder() {
        val c = ResidencyLedgerCore.canonical(sample(), 7, "a".repeat(64))!!
        val keys = JSONObject(c).keys().asSequence().toSet()
        assertEquals(
            setOf("v", "seq", "at", "elapsedRealtime", "bootId", "svc", "pid", "startTicks", "startedAt", "alive",
                "heartbeatAt", "health", "versionCode", "reason", "code", "prev"),
            keys,
        )
        assertTrue(c.startsWith("{\"v\":1,\"seq\":7,\"at\":1764300000000,\"elapsedRealtime\":99000,\"bootId\":\"$boot\",\"svc\":\"council-facade\""))
        assertTrue(c.contains("\"health\":{\"ok\":true,\"cliSeatKinds\":[\"codex\",\"claude\"],\"ms\":12}"))
        assertTrue(c.endsWith(",\"reason\":\"tick\",\"code\":null,\"prev\":\"${"a".repeat(64)}\"}"))
        // Deterministic: the same sample gives the same bytes.
        assertEquals(c, ResidencyLedgerCore.canonical(sample(), 7, "a".repeat(64)))
    }

    @Test
    fun nullsAreWrittenAsJsonNull() {
        val c = ResidencyLedgerCore.canonical(sample(pid = null, health = null), 1, "")!!
        val o = JSONObject(c)
        assertTrue(o.isNull("pid") && o.isNull("startTicks") && o.isNull("health") && o.isNull("heartbeatAt"))
        assertEquals(false, o.get("alive"))
        assertEquals("", o.getString("prev"))
    }

    @Test
    fun refusesOutOfShapeSamples() {
        assertNull(ResidencyLedgerCore.canonical(sample(reason = "nope"), 1, ""))
        assertNull(ResidencyLedgerCore.canonical(sample(svc = "../x"), 1, ""))
        assertNull(ResidencyLedgerCore.canonical(sample(code = "Has Space"), 1, ""))
        assertNull(ResidencyLedgerCore.canonical(sample(), 0, ""))
        assertNull(ResidencyLedgerCore.canonical(sample(), 2, "nothex"))
        assertNull(ResidencyLedgerCore.canonical(sample(health = ResidencyLedgerCore.Health(true, listOf("A B"), 1)), 1, ""))
        assertNull(ResidencyLedgerCore.canonical(sample().copy(bootId = "x"), 1, ""))
    }

    @Test
    fun signedLineSplitsBackToItsCanonicalForm() {
        val c = ResidencyLedgerCore.canonical(sample(), 3, "")!!
        val mac = fakeMac(c)
        val line = ResidencyLedgerCore.signed(c, mac)
        assertEquals("\"mac\":\"$mac\"", line.substringAfterLast(',').dropLast(1))
        assertEquals(Pair(c, mac), ResidencyLedgerCore.splitSigned(line))
        assertEquals(mac, JSONObject(line).getString("mac"))
        assertNull(ResidencyLedgerCore.splitSigned(c))
    }

    @Test
    fun verifiesAnIntactChain() {
        val lines = chain(5)
        val v = ResidencyLedgerCore.verify(lines, ResidencyLedgerCore.Anchor(5, ResidencyLedgerCore.sha256Hex(lines.last()))) { c, m -> fakeMac(c) == m }
        assertTrue(v.chainOk)
        assertNull(v.brokenAtSeq)
        assertEquals(5, v.macOk)
        assertEquals(0, v.macBad)
        assertEquals(true, v.anchorOk)
        assertFalse(v.truncated)
        assertEquals(1L, v.firstSeq)
        assertEquals(5L, v.lastSeq)
    }

    @Test
    fun aWindowStartingMidChainIsStillOk() {
        val lines = chain(6).drop(2)
        val v = ResidencyLedgerCore.verify(lines, null, null)
        assertTrue(v.chainOk)
        assertFalse(v.macChecked)
        assertNull(v.anchorOk)
    }

    @Test
    fun detectsAnEditedLineAndADroppedLine() {
        val lines = chain(5).toMutableList()
        // An edited field: the MAC no longer matches, and the next line's prev breaks.
        lines[2] = lines[2].replace("\"pid\":4242", "\"pid\":4243")
        val v = ResidencyLedgerCore.verify(lines, null) { c, m -> fakeMac(c) == m }
        assertFalse(v.chainOk)
        assertEquals(4L, v.brokenAtSeq)
        assertEquals(1, v.macBad)

        val dropped = chain(5).filterIndexed { i, _ -> i != 2 }
        val d = ResidencyLedgerCore.verify(dropped, null, null)
        assertFalse(d.chainOk)
        assertEquals(4L, d.brokenAtSeq)
    }

    @Test
    fun anUnparseableLineBreaksTheChain() {
        val lines = chain(3).toMutableList()
        lines.add(1, "garbage")
        val v = ResidencyLedgerCore.verify(lines, null, null)
        assertFalse(v.chainOk)
        assertEquals(1, v.unparsed)
        assertEquals(2L, v.brokenAtSeq)
    }

    @Test
    fun detectsTruncationAgainstTheAnchor() {
        val lines = chain(5)
        val anchor = ResidencyLedgerCore.Anchor(5, ResidencyLedgerCore.sha256Hex(lines.last()))
        val v = ResidencyLedgerCore.verify(lines.take(3), anchor, null)
        assertTrue(v.chainOk)
        assertEquals(false, v.anchorOk)
        assertTrue(v.truncated)

        // The next line after a truncation still chains to the anchor: visible as a break.
        val link = ResidencyLedgerCore.resolveLink(anchor, lines[2])
        assertTrue(link.anchorMismatch)
        assertEquals(6L, link.seq)
        assertEquals(anchor.hash, link.prev)
        val c = ResidencyLedgerCore.canonical(sample(), link.seq, link.prev)!!
        val after = lines.take(3) + ResidencyLedgerCore.signed(c, fakeMac(c))
        val w = ResidencyLedgerCore.verify(after, null, null)
        assertFalse(w.chainOk)
        assertEquals(6L, w.brokenAtSeq)
    }

    @Test
    fun resolveLinkCases() {
        val lines = chain(3)
        val h2 = ResidencyLedgerCore.sha256Hex(lines[1])
        val h3 = ResidencyLedgerCore.sha256Hex(lines[2])
        // First use: nothing anywhere.
        assertEquals(ResidencyLedgerCore.Link(1, "", false), ResidencyLedgerCore.resolveLink(null, null))
        // No anchor (prefs cleared): continue the file.
        assertEquals(ResidencyLedgerCore.Link(4, h3, false), ResidencyLedgerCore.resolveLink(null, lines[2]))
        // Anchor == tail.
        assertEquals(ResidencyLedgerCore.Link(4, h3, false), ResidencyLedgerCore.resolveLink(ResidencyLedgerCore.Anchor(3, h3), lines[2]))
        // The anchor lagged by one (died between append and commit).
        assertEquals(ResidencyLedgerCore.Link(4, h3, false), ResidencyLedgerCore.resolveLink(ResidencyLedgerCore.Anchor(2, h2), lines[2]))
        // The file was replaced / emptied.
        assertEquals(ResidencyLedgerCore.Link(4, h3, true), ResidencyLedgerCore.resolveLink(ResidencyLedgerCore.Anchor(3, h3), null))
        assertEquals(ResidencyLedgerCore.Link(4, h3, true), ResidencyLedgerCore.resolveLink(ResidencyLedgerCore.Anchor(3, h3), "{\"v\":1}"))
    }

    @Test
    fun rotationThresholdAndNames() {
        assertEquals("residency.jsonl", ResidencyLedgerCore.FILE)
        assertEquals("residency.jsonl.1", ResidencyLedgerCore.FILE_PREV)
        assertEquals(512L * 1024, ResidencyLedgerCore.MAX_BYTES)
        assertFalse(ResidencyLedgerCore.shouldRotate(0, 600))
        assertFalse(ResidencyLedgerCore.shouldRotate(ResidencyLedgerCore.MAX_BYTES - 600, 600))
        assertTrue(ResidencyLedgerCore.shouldRotate(ResidencyLedgerCore.MAX_BYTES - 599, 600))
        // A chain across the rotation (old generation then current) still verifies.
        val lines = chain(4)
        val v = ResidencyLedgerCore.verify(lines.take(2) + lines.drop(2), null, null)
        assertTrue(v.chainOk)
    }

    @Test
    fun lastLineOfATailChunk() {
        val text = "a\nbb\nccc\n".toByteArray()
        assertEquals("ccc", ResidencyLedgerCore.lastLine(text, chunkStartsFile = true))
        // A torn last line is ignored.
        assertEquals("bb", ResidencyLedgerCore.lastLine("a\nbb\ncc".toByteArray(), chunkStartsFile = true))
        // A single complete line in a chunk that starts the file.
        assertEquals("only", ResidencyLedgerCore.lastLine("only\n".toByteArray(), chunkStartsFile = true))
        // A chunk from the middle whose only line might be cut at its start.
        assertNull(ResidencyLedgerCore.lastLine("tail-of-something\n".toByteArray(), chunkStartsFile = false))
        assertNull(ResidencyLedgerCore.lastLine(ByteArray(0), chunkStartsFile = true))
        assertNull(ResidencyLedgerCore.lastLine("torn".toByteArray(), chunkStartsFile = true))
    }

    @Test
    fun reasonsForSupervisorAuditCodes() {
        assertEquals("start", ResidencyLedgerCore.reasonForAudit("start", "started"))
        assertEquals("start", ResidencyLedgerCore.reasonForAudit("start", "already_running"))
        assertEquals("restart", ResidencyLedgerCore.reasonForAudit("start", "restart_scheduled"))
        assertEquals("restart", ResidencyLedgerCore.reasonForAudit("start", "restart_started"))
        assertEquals("reconcile", ResidencyLedgerCore.reasonForAudit("start", "reconcile_started"))
        assertEquals("reconcile", ResidencyLedgerCore.reasonForAudit("stop", "adopt_stopped"))
        assertEquals("halt", ResidencyLedgerCore.reasonForAudit("start", "halted"))
        assertEquals("halt", ResidencyLedgerCore.reasonForAudit("start", "reconcile_halted"))
        assertEquals("halt", ResidencyLedgerCore.reasonForAudit("stop", "halt_stopped"))
        assertEquals("stop", ResidencyLedgerCore.reasonForAudit("stop", "stopped"))
    }

    @Test
    fun cliSeatKindsFromAHealthBody() {
        // council-tool's actual /health shape (device, 2026-11-28).
        assertEquals(listOf("claude", "codex"), ResidencyLedgerCore.cliSeatKinds("{\"ok\":true,\"cli_seat_kinds\":{\"codex\":true,\"claude\":true}}"))
        assertEquals(listOf("codex"), ResidencyLedgerCore.cliSeatKinds("{\"ok\":true,\"cli_seat_kinds\":{\"codex\":true,\"claude\":false}}"))
        assertEquals(emptyList<String>(), ResidencyLedgerCore.cliSeatKinds("{\"ok\":true,\"cli_seat_kinds\":{\"codex\":false}}"))
        assertNull(ResidencyLedgerCore.cliSeatKinds("{\"ok\":true}"))
        assertNull(ResidencyLedgerCore.cliSeatKinds("{\"ok\":true,\"cli_seat_kinds\":{\"Has Space\":true}}"))
        assertNull(ResidencyLedgerCore.cliSeatKinds("{\"ok\":true,\"cli_seat_kinds\":{\"codex\":\"yes\"}}"))
        assertNull(ResidencyLedgerCore.cliSeatKinds("{\"ok\":true,\"cli_seat_kinds\":[\"codex\"]}"))
        assertNull(ResidencyLedgerCore.cliSeatKinds("not json"))
        val raw = "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"cli_seat_kinds\":{\"codex\":true,\"claude\":false}}".toByteArray()
        assertEquals(listOf("codex"), ResidencyLedgerCore.cliSeatKinds(ResidencyLedgerCore.httpBody(raw)))
    }

    @Test
    fun bootIdAndStartTicks() {
        assertEquals(boot, ResidencyLedgerCore.bootIdOrNull(boot.uppercase() + "\n"))
        assertNull(ResidencyLedgerCore.bootIdOrNull("not-a-boot-id"))
        assertEquals(123L, ResidencyLedgerCore.startTicksOrNull("123"))
        assertNull(ResidencyLedgerCore.startTicksOrNull("12a"))
        assertNull(ResidencyLedgerCore.startTicksOrNull(null))
    }

    @Test
    fun residencyGuardAuditLine() {
        val line = IngressAuditWriter.buildResidencyGuardLine(1_764_300_000_000L, "overlay", "overlay_detected", null, 17)
        assertNotNull(line)
        val o = JSONObject(line!!)
        assertEquals("residency_guard", o.getString("kind"))
        assertEquals("overlay", o.getString("action"))
        assertEquals("overlay_detected", o.getString("code"))
        assertEquals(17, o.getInt("valueLength"))
        assertFalse(o.has("value"))
        assertNotNull(IngressAuditWriter.buildResidencyGuardLine(1L, "residency", "anchor_mismatch", "council-facade", null))
        assertNull(IngressAuditWriter.buildResidencyGuardLine(1L, "other", "overlay_detected", null, 1))
        assertNull(IngressAuditWriter.buildResidencyGuardLine(1L, "residency", "anchor_mismatch", "unknown-svc", null))
    }
}
