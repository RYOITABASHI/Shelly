package expo.modules.terminalemulator

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files

/**
 * Payload freshness (A1 / A2 / A4): retired-payload removal, stale temp-file
 * cleanup and the verified MCP-script sync.
 *
 * Like ExtractionMemoTest, this module has no unit-test task wired into CI yet
 * (build-android.yml only runs assembleRelease); PayloadHygiene has zero
 * android.* imports so this runs on the plain JVM via
 * `./gradlew :terminal-emulator:testDebugUnitTest`.
 */
class PayloadHygieneTest {
    @get:Rule
    val tmp = TemporaryFolder()

    private val logs = mutableListOf<String>()
    private val log: (String) -> Unit = { logs.add(it) }

    // ── A2: ~/.shelly-mcp-server.js equals the APK asset ─────────────────

    private val asset = "// shelly-mcp-server.js (current)\nconsole.log('service_control');\n".toByteArray()

    @Test
    fun `a stale script that is already there is replaced by the asset bytes`() {
        val home = tmp.newFolder("home")
        val target = File(home, ".shelly-mcp-server.js")
        target.writeText("// shelly-mcp-server.js (pre-S1)\n")
        target.setLastModified(System.currentTimeMillis() + 60_000) // newer mtime must not matter

        val outcome = PayloadHygiene.syncExact(asset, target, log)

        assertEquals(PayloadHygiene.SyncOutcome.WRITTEN, outcome)
        assertArrayEquals(asset, target.readBytes())
        assertTrue(PayloadHygiene.contentEquals(target, asset))
        assertTrue("no temp file left behind", home.list()!!.all { it == ".shelly-mcp-server.js" })
    }

    @Test
    fun `a stale script with the same size is still replaced`() {
        val home = tmp.newFolder("home")
        val target = File(home, ".shelly-mcp-server.js")
        val sameSize = asset.copyOf().also { it[it.size - 3] = 'X'.code.toByte() }
        target.writeBytes(sameSize)

        assertEquals(PayloadHygiene.SyncOutcome.WRITTEN, PayloadHygiene.syncExact(asset, target, log))
        assertArrayEquals(asset, target.readBytes())
    }

    @Test
    fun `an identical script is left untouched`() {
        val home = tmp.newFolder("home")
        val target = File(home, ".shelly-mcp-server.js")
        target.writeBytes(asset)
        val inodeTime = 1_600_000_000_000L
        target.setLastModified(inodeTime)

        assertEquals(PayloadHygiene.SyncOutcome.UNCHANGED, PayloadHygiene.syncExact(asset, target, log))
        assertEquals(inodeTime, target.lastModified())
    }

    @Test
    fun `a missing script is created`() {
        val home = tmp.newFolder("home")
        val target = File(home, ".shelly-mcp-server.js")
        assertEquals(PayloadHygiene.SyncOutcome.WRITTEN, PayloadHygiene.syncExact(asset, target, log))
        assertArrayEquals(asset, target.readBytes())
    }

    @Test
    fun `a symlink at the name is replaced and its target is never written`() {
        val home = tmp.newFolder("home")
        val elsewhere = File(tmp.newFolder("elsewhere"), "old.js")
        elsewhere.writeText("old")
        val target = File(home, ".shelly-mcp-server.js")
        Files.createSymbolicLink(target.toPath(), elsewhere.toPath())

        assertEquals(PayloadHygiene.SyncOutcome.WRITTEN, PayloadHygiene.syncExact(asset, target, log))
        assertFalse(Files.isSymbolicLink(target.toPath()))
        assertArrayEquals(asset, target.readBytes())
        assertEquals("old", elsewhere.readText())
    }

    @Test
    fun `a directory at the name is left untouched and the sync fails`() {
        val home = tmp.newFolder("home")
        val target = File(home, ".shelly-mcp-server.js")
        val junk = File(target, "junk").apply { parentFile!!.mkdirs(); writeText("x") }

        assertEquals(PayloadHygiene.SyncOutcome.FAILED, PayloadHygiene.syncExact(asset, target, log))
        assertTrue(target.isDirectory)
        assertEquals("x", junk.readText())
        assertTrue(logs.any { it.startsWith("E ") && it.contains("directory") })
        assertTrue("no temp file left behind", home.list()!!.all { it == ".shelly-mcp-server.js" })
    }

    @Test
    fun `both attempts failing keep the old script readable`() {
        val home = tmp.newFolder("home")
        val target = File(home, ".shelly-mcp-server.js")
        val old = "// shelly-mcp-server.js (pre-S1)\n".toByteArray()
        target.writeBytes(old)
        var calls = 0
        // A full disk: the write throws after a partial copy.
        val failingWrite: (File, ByteArray) -> Unit = { f, b ->
            calls++
            f.writeBytes(b.copyOf(b.size / 2))
            throw java.io.IOException("ENOSPC")
        }

        val outcome = PayloadHygiene.syncExact(asset, target, log, failingWrite)

        assertEquals(PayloadHygiene.SyncOutcome.FAILED, outcome)
        assertEquals(2, calls)
        assertTrue(target.isFile)
        assertArrayEquals(old, target.readBytes())
        assertTrue(logs.any { it.startsWith("E ") && it.contains("after 2 attempts") })
        assertTrue("no temp file left behind", home.list()!!.all { it == ".shelly-mcp-server.js" })
    }

    @Test
    fun `a short write that does not throw is caught before the rename`() {
        val home = tmp.newFolder("home")
        val target = File(home, ".shelly-mcp-server.js")
        val old = "// old\n".toByteArray()
        target.writeBytes(old)
        val truncating: (File, ByteArray) -> Unit = { f, b -> f.writeBytes(b.copyOf(b.size - 1)) }

        assertEquals(PayloadHygiene.SyncOutcome.FAILED, PayloadHygiene.syncExact(asset, target, log, truncating))
        assertArrayEquals(old, target.readBytes())
        assertTrue("no temp file left behind", home.list()!!.all { it == ".shelly-mcp-server.js" })
    }

    @Test
    fun `a first attempt failing and a second succeeding replaces the script`() {
        val home = tmp.newFolder("home")
        val target = File(home, ".shelly-mcp-server.js")
        target.writeText("// stale\n")
        var calls = 0
        val flaky: (File, ByteArray) -> Unit = { f, b ->
            calls++
            if (calls == 1) throw java.io.IOException("EIO")
            f.writeBytes(b)
        }

        assertEquals(PayloadHygiene.SyncOutcome.WRITTEN, PayloadHygiene.syncExact(asset, target, log, flaky))
        assertEquals(2, calls)
        assertArrayEquals(asset, target.readBytes())
        assertTrue("no temp file left behind", home.list()!!.all { it == ".shelly-mcp-server.js" })
    }

    // ── A1: retired payloads ─────────────────────────────────────────────

    @Test
    fun `a retired name is removed, other files stay`() {
        // codex_exec is an active name again (the codex_exec launcher), not retired.
        assertFalse("codex_exec" in PayloadHygiene.RETIRED_LIB_FILES)
        val libDir = tmp.newFolder("termux-libs")
        File(libDir, "codex_exec").writeText("0.142.0")
        File(libDir, "codex_tui").writeText("0.167.0")

        val result = PayloadHygiene.removeRetired(libDir, listOf("codex_exec"), setOf("codex_tui"), log)

        assertEquals(1, result.size)
        assertTrue(result[0].removed)
        assertEquals(7L, result[0].sizeBytes)
        assertFalse(File(libDir, "codex_exec").exists())
        assertTrue(File(libDir, "codex_tui").exists())
        assertTrue(logs.any { it.startsWith("I retired payload removed: termux-libs/codex_exec") })
    }

    @Test
    fun `absent retired payloads are a no-op`() {
        val libDir = tmp.newFolder("termux-libs")
        assertTrue(PayloadHygiene.removeRetired(libDir, PayloadHygiene.RETIRED_LIB_FILES, emptySet(), log).isEmpty())
        assertTrue(logs.isEmpty())
    }

    @Test
    fun `a retired name that is also active is never deleted`() {
        val libDir = tmp.newFolder("termux-libs")
        File(libDir, "codex_exec").writeText("x")
        PayloadHygiene.removeRetired(libDir, listOf("codex_exec"), setOf("codex_exec"), log)
        assertTrue(File(libDir, "codex_exec").exists())
        assertTrue(logs.any { it.startsWith("E ") })
    }

    @Test
    fun `a retired symlink is removed without touching its target`() {
        val libDir = tmp.newFolder("termux-libs")
        val real = File(tmp.newFolder("other"), "codex")
        real.writeText("keep")
        Files.createSymbolicLink(File(libDir, "codex_exec").toPath(), real.toPath())

        val result = PayloadHygiene.removeRetired(libDir, listOf("codex_exec"), emptySet(), log)

        assertTrue(result.single().removed)
        assertTrue(result.single().wasSymlink)
        assertFalse(Files.exists(File(libDir, "codex_exec").toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
        assertEquals("keep", real.readText())
    }

    @Test
    fun `a dangling retired symlink is removed too`() {
        val libDir = tmp.newFolder("termux-libs")
        val link = File(libDir, "codex_exec")
        Files.createSymbolicLink(link.toPath(), File(tmp.root, "gone/codex").toPath())
        assertFalse("File.exists() follows the link", link.exists())
        assertTrue(PayloadHygiene.existsNoFollow(link))
        assertTrue(PayloadHygiene.isDanglingSymlink(link))

        val result = PayloadHygiene.removeRetired(libDir, listOf("codex_exec"), emptySet(), log)

        assertTrue(result.single().removed)
        assertTrue(result.single().wasSymlink)
        assertFalse(Files.exists(link.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS))
        assertFalse(PayloadHygiene.existsNoFollow(link))
        assertTrue(logs.any { it.startsWith("I retired payload removed: termux-libs/codex_exec") && it.contains("symlink=true") })
    }

    // ── A4: stale *.new temp files ───────────────────────────────────────

    @Test
    fun `stale temp files of dead writers are removed, live and foreign files stay`() {
        val libDir = tmp.newFolder("termux-libs")
        val now = System.currentTimeMillis()
        val dead = File(libDir, "codex_tui.4242.7.123456789.new").apply { writeText("partial") }
        val liveOther = File(libDir, "node.5151.9.1.new").apply { writeText("in flight") }
        val mineFresh = File(libDir, "git.100.3.99.new").apply { writeText("in flight") }
        val mineOld = File(libDir, "git.100.4.98.new").apply {
            writeText("abandoned")
            setLastModified(now - PayloadHygiene.STALE_TEMP_AFTER_MS - 1_000)
        }
        val foreign = File(libDir, "notes.4242.7.1.new").apply { writeText("not ours") }
        val target = File(libDir, "codex_tui").apply { writeText("real") }

        val removed = PayloadHygiene.removeStaleTempFiles(
            libDir,
            setOf("codex_tui", "node", "git"),
            100,
            now,
            { pid -> pid == 5151 },
            log,
        )

        assertEquals(setOf(dead.name, mineOld.name), removed.toSet())
        assertFalse(dead.exists())
        assertFalse(mineOld.exists())
        assertTrue(liveOther.exists())
        assertTrue(mineFresh.exists())
        assertTrue(foreign.exists())
        assertTrue(target.exists())
    }

    @Test
    fun `temp name pattern matches what LibExtractor newTempFile produces`() {
        val libDir = tmp.newFolder("termux-libs")
        // "$fileName.${myPid()}.${Thread.currentThread().id}.${System.nanoTime()}.new"
        val name = "libc++_shared.so.31337.2.${System.nanoTime()}.new"
        File(libDir, name).writeText("x")
        val removed = PayloadHygiene.removeStaleTempFiles(libDir, setOf("libc++_shared.so"), 1, System.currentTimeMillis(), { false }, log)
        assertEquals(listOf(name), removed)
    }
}
