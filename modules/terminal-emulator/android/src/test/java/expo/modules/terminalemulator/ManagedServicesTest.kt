package expo.modules.terminalemulator

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure half of the service_control supervisor (ManagedServices.kt). */
class ManagedServicesTest {
    private val delivery = ManagedServices.spec("article-delivery")!!
    private val facade = ManagedServices.spec("council-facade")!!
    private val launch = delivery.launch!!
    private val now = 1_764_000_000_000L
    private val stale = delivery.heartbeat!!.staleMs

    @Test
    fun registryIsClosed() {
        assertEquals(listOf("article-delivery", "council-facade"), ManagedServices.REGISTRY.keys.toList())
        assertNull(ManagedServices.spec("Article-Delivery"))
        assertNull(ManagedServices.spec("../agents"))
        assertNull(ManagedServices.spec(""))
        assertNull(ManagedServices.spec(null))
        assertNull(facade.launch)
        assertEquals(".shelly/agents/.env.article-delivery.js", launch.script)
        assertEquals(listOf("loop"), launch.args)
        assertEquals(11 * 60_000L, stale)
    }

    @Test
    fun hostCommandQuotesFixedPathsAndSetsTheLibraryPath() {
        val cmd = ManagedServices.hostCommand(launch, "/data/user/0/x/files/home", "/data/lib", "/data/user/0/x/files/home/.shelly/services/article-delivery/output.log")
        assertTrue(cmd.startsWith("exec >>'/data/user/0/x/files/home/.shelly/services/article-delivery/output.log' 2>&1 </dev/null\n"))
        assertTrue(cmd.contains(". \"\$HOME/.bashrc\""))
        assertTrue(cmd.contains("unset LD_PRELOAD\n"))
        assertTrue(cmd.contains("export LD_LIBRARY_PATH='/data/lib'\n"))
        assertTrue(cmd.contains("cd '/data/user/0/x/files/home/.shelly/agents' || exit 126\n"))
        assertTrue(cmd.contains("[ -f '/data/lib/node' ] || exit 127\n"))
        // STOP-ALL is the very last statement before exec (nothing in between),
        // and the start line (which runs `date`) comes before it.
        val lines = cmd.trimEnd('\n').split('\n')
        assertEquals("[ -e '/data/user/0/x/files/home/.shelly/agents/.halted' ] && exit 125", lines[lines.size - 2])
        assertTrue(lines.indexOfFirst { it.startsWith("printf ") } in 0 until lines.size - 2)
        // node is never exec'd directly (W^X, exit 126 on the device 2026-11-25):
        // it goes through the system linker, as AgentRuntime's executor launch.
        assertEquals("exec /system/bin/linker64 '/data/lib/node' '/data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js' 'loop'", lines.last())
        assertFalse(cmd.contains("exec node"))
        assertFalse(cmd.contains("command -v node"))
        // article-delivery keeps no exec wrapper: node runs with LD_PRELOAD unset.
        assertFalse(cmd.contains("export LD_PRELOAD"))
        // What that exec leaves in /proc/<pid>/cmdline is this service to cmdlineMatches.
        val paths = ManagedServices.scriptPaths(launch, listOf("/data/user/0/x/files/home"))
        val argv = listOf("/system/bin/linker64", "/data/lib/node", "/data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js", "loop")
        assertTrue(ManagedServices.cmdlineMatches(launch, paths, argv.joinToString("\u0000") + "\u0000"))

        val unset = launch.copy(env = ManagedServices.LaunchEnv(sourceBashrc = false, libraryPath = ManagedServices.LibraryPath.UNSET))
        val cmd2 = ManagedServices.hostCommand(unset, "/h", "/l", "/h/log")
        assertTrue(cmd2.contains("unset LD_LIBRARY_PATH\n"))
        assertFalse(cmd2.contains(".bashrc"))
    }

    @Test
    fun shQuoteEscapesSingleQuotes() {
        assertEquals("'a'\\''b'", ManagedServices.shQuote("a'b"))
    }

    @Test
    fun cmdlineMatchesOnlyThisServiceInLoopMode() {
        val nul = "\u0000"
        val paths = ManagedServices.scriptPaths(launch, listOf("/data/user/0/x/files/home", "/data/data/x/files/home", "relative", "/trailing/"))
        assertEquals(setOf(
            "/data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js",
            "/data/data/x/files/home/.shelly/agents/.env.article-delivery.js",
        ), paths)
        fun m(vararg argv: String, trailingNul: Boolean = false) =
            ManagedServices.cmdlineMatches(launch, paths, argv.joinToString(nul) + if (trailingNul) nul else "")
        // As seen on the device (2026-11-24, pid 6293), and the other home alias.
        assertTrue(m("linker64", "/data/user/0/x/termux-libs/node", "/data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js", "loop", trailingNul = true))
        assertTrue(m("node", "/data/data/x/files/home/.shelly/agents/.env.article-delivery.js", "loop"))
        // A file of the same name elsewhere, a relative path, another mode, extra args, another program.
        assertFalse(m("node", "/tmp/.env.article-delivery.js", "loop"))
        assertFalse(m("node", "/data/user/0/x/files/home/tmp/.shelly/agents/.env.article-delivery.js", "loop"))
        assertFalse(m("node", ".env.article-delivery.js", "loop"))
        assertFalse(m("node", "/data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js", "tick"))
        assertFalse(m("node", "/data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js"))
        assertFalse(m("node", "/data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js", "loop", "extra"))
        assertFalse(m("python3", "/data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js", "loop"))
        assertFalse(m("linker64", "/lib/python3", "/data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js", "loop"))
        assertFalse(m("bash", "-c", "node /data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js loop"))
        assertFalse(ManagedServices.cmdlineMatches(launch, paths, ""))
        assertFalse(ManagedServices.cmdlineMatches(launch, paths, null))
        assertFalse(ManagedServices.cmdlineMatches(launch, emptySet(), "node${nul}/x${nul}loop"))
    }

    @Test
    fun recordRoundTripsAndRejectsJunk() {
        val r = ManagedServices.Record(6293, "123456", now, stoppedAt = null, exitedAt = now + 5, exitCode = 137)
        assertEquals(r, ManagedServices.parseRecord(ManagedServices.encodeRecord(r)))
        val s = ManagedServices.Record(6293, "123456", now, stoppedAt = now + 9)
        assertEquals(s, ManagedServices.parseRecord(ManagedServices.encodeRecord(s)))
        assertNull(ManagedServices.parseRecord(null))
        assertNull(ManagedServices.parseRecord("not json"))
        assertNull(ManagedServices.parseRecord("""{"v":2,"pid":6293,"startTime":"1","startedAt":1}"""))
        assertNull(ManagedServices.parseRecord("""{"v":1,"pid":1,"startTime":"1","startedAt":1}"""))
        assertNull(ManagedServices.parseRecord("""{"v":1,"pid":6293,"startTime":"1 2","startedAt":1}"""))
        assertNull(ManagedServices.parseRecord("x".repeat(5000)))
    }

    @Test
    fun beatParsesTheLoopsFile() {
        assertEquals(ManagedServices.Beat(6293, now), ManagedServices.parseBeat("""{"pid":6293,"at":$now}"""))
        assertEquals(ManagedServices.Beat(0, now), ManagedServices.parseBeat("""{"pid":0,"at":$now,"starting":true}"""))
        assertNull(ManagedServices.parseBeat("""{"pid":6293}"""))
        assertNull(ManagedServices.parseBeat("""{"pid":"6293","at":$now}"""))
        assertNull(ManagedServices.parseBeat("""{"pid":6293,"at":1.5}"""))
        assertNull(ManagedServices.parseBeat("""{"pid":-1,"at":$now}"""))
        assertNull(ManagedServices.parseBeat(""))
    }

    @Test
    fun decideCoversEveryState() {
        val live = ManagedServices.Live(6293, now - 60_000, supervised = true)
        val fresh = ManagedServices.Beat(6293, now - 30_000)
        val old = ManagedServices.Beat(6293, now - stale - 1)

        assertEquals(ManagedServices.State.NOT_CONFIGURED, ManagedServices.decide(facade, null, null, null, now).state)

        val running = ManagedServices.decide(delivery, live, null, fresh, now)
        assertEquals(ManagedServices.State.RUNNING, running.state)
        assertEquals(6293, running.pid)
        assertEquals(now - 30_000, running.lastHeartbeatAt)
        assertTrue(running.supervised)

        // Just started, no beat of its own yet: starting, then unhealthy past one stale period.
        assertEquals(ManagedServices.State.STARTING, ManagedServices.decide(delivery, live, null, old, now).state)
        assertEquals(ManagedServices.State.UNHEALTHY,
            ManagedServices.decide(delivery, live.copy(startedAt = now - stale - 1), null, old, now).state)
        // A beat from another pid does not count.
        assertEquals(ManagedServices.State.UNHEALTHY,
            ManagedServices.decide(delivery, live.copy(startedAt = now - stale - 1), null, fresh.copy(pid = 42), now).state)
        // A terminal-started loop (no start time known) with a fresh beat.
        assertEquals(ManagedServices.State.RUNNING,
            ManagedServices.decide(delivery, ManagedServices.Live(6293, null, supervised = false), null, fresh, now).state)
        assertEquals(ManagedServices.State.UNHEALTHY,
            ManagedServices.decide(delivery, ManagedServices.Live(6293, null, supervised = false), null, old, now).state)

        // Not alive: dead only when the record says started and never stopped.
        val crashed = ManagedServices.Record(6293, "1", now - 600_000, exitedAt = now - 1000, exitCode = 137)
        val dead = ManagedServices.decide(delivery, null, crashed, old, now)
        assertEquals(ManagedServices.State.DEAD, dead.state)
        assertNull(dead.pid)
        assertEquals(137, dead.exitCode)
        assertEquals(now - 1000, dead.exitedAt)
        val lost = ManagedServices.Record(6293, "1", now - 600_000) // the app died with it: no exit recorded
        assertEquals(ManagedServices.State.DEAD, ManagedServices.decide(delivery, null, lost, null, now).state)
        val stopped = crashed.copy(stoppedAt = now - 2000)
        assertEquals(ManagedServices.State.STOPPED, ManagedServices.decide(delivery, null, stopped, old, now).state)
        assertEquals(ManagedServices.State.STOPPED, ManagedServices.decide(delivery, null, null, null, now).state)
    }

    @Test
    fun decideTreatsAResolvedHealthCheckLikeAHeartbeat() {
        // A resolved council-facade Spec (REGISTRY's own entry stays launch=null;
        // this is the shape ManagedServiceSupervisor builds from the on-device file).
        val resolved = facade.copy(
            launch = launch.copy(script = "council-spike/dist/http/server.js", workDir = "council-spike"),
            health = ManagedServices.HealthCheck(port = 8790, timeoutMs = 1_500L, staleMs = 60_000L),
        )
        val live = ManagedServices.Live(4242, now - 10_000, supervised = true)
        // status() synthesizes the Beat from the poll result (pid = the live
        // pid, at = now) instead of reading a file; decide() treats it the same.
        val healthyBeat = ManagedServices.Beat(4242, now)
        assertEquals(ManagedServices.State.RUNNING, ManagedServices.decide(resolved, live, null, healthyBeat, now).state)
        // Still within one health staleMs of its own start: starting, not unhealthy.
        assertEquals(ManagedServices.State.STARTING, ManagedServices.decide(resolved, live, null, null, now).state)
        assertEquals(ManagedServices.State.UNHEALTHY,
            ManagedServices.decide(resolved, live.copy(startedAt = now - 61_000), null, null, now).state)
    }

    private fun tempDir(): java.io.File = java.nio.file.Files.createTempDirectory("svc-test").toFile()

    /** Symlink creation needs a privilege on some Windows setups: skip those cases there. */
    private fun linkOrSkip(link: java.io.File, target: java.io.File) {
        try {
            java.nio.file.Files.createSymbolicLink(link.toPath(), target.toPath())
        } catch (e: Exception) {
            org.junit.Assume.assumeNoException("symlinks not available here", e)
        }
    }

    @Test
    fun recordFileIsWrittenAtomically() {
        val dir = tempDir()
        val r = ManagedServices.Record(6293, "123", now)
        assertTrue(ManagedServices.writeRecordFile(dir, r, "1"))
        assertEquals(r, ManagedServices.parseRecord(java.io.File(dir, ManagedServices.RECORD_FILE).readText()))
        val r2 = r.copy(stoppedAt = now + 1)
        assertTrue(ManagedServices.writeRecordFile(dir, r2, "1"))
        assertEquals(r2, ManagedServices.parseRecord(java.io.File(dir, ManagedServices.RECORD_FILE).readText()))
        assertEquals(listOf(ManagedServices.RECORD_FILE), dir.list()!!.toList())
    }

    @Test
    fun recordFileRefusesASymlinkedLeaf() {
        val dir = tempDir()
        val outside = java.io.File(tempDir(), "agents-file").apply { writeText("keep") }
        linkOrSkip(java.io.File(dir, ManagedServices.RECORD_FILE), outside)
        assertFalse(ManagedServices.writeRecordFile(dir, ManagedServices.Record(6293, "1", now), "1"))
        assertEquals("keep", outside.readText())
        assertTrue(ManagedServices.isSymlinkLeaf(java.io.File(dir, ManagedServices.RECORD_FILE)))
    }

    @Test
    fun recordFileRefusesASymlinkedTemp() {
        val dir = tempDir()
        val outside = java.io.File(tempDir(), "agents-file").apply { writeText("keep") }
        linkOrSkip(java.io.File(dir, "${ManagedServices.RECORD_FILE}.tmp-7"), outside)
        assertFalse(ManagedServices.writeRecordFile(dir, ManagedServices.Record(6293, "1", now), "7"))
        assertEquals("keep", outside.readText())
        assertFalse(java.io.File(dir, ManagedServices.RECORD_FILE).exists())
    }

    @Test
    fun outputLogRotatesAndRefusesSymlinks() {
        val dir = tempDir()
        assertTrue(ManagedServices.prepareOutputLog(dir)) // nothing there yet
        val log = java.io.File(dir, ManagedServices.OUTPUT_LOG)
        log.writeBytes(ByteArray((ManagedServices.OUTPUT_LOG_MAX_BYTES + 1).toInt()))
        assertTrue(ManagedServices.prepareOutputLog(dir))
        assertFalse(log.exists())
        assertEquals(ManagedServices.OUTPUT_LOG_MAX_BYTES + 1, java.io.File(dir, "${ManagedServices.OUTPUT_LOG}.1").length())

        val dir2 = tempDir()
        val outside = java.io.File(tempDir(), "agents-file").apply { writeText("keep") }
        linkOrSkip(java.io.File(dir2, ManagedServices.OUTPUT_LOG), outside)
        assertFalse(ManagedServices.prepareOutputLog(dir2))
        assertEquals("keep", outside.readText())

        val dir3 = tempDir()
        linkOrSkip(java.io.File(dir3, "${ManagedServices.OUTPUT_LOG}.1"), outside)
        assertFalse(ManagedServices.prepareOutputLog(dir3))
    }

    @Test
    fun exitSweepRepeatsUntilARoundFindsNothing() {
        // A start that lands while round 1 runs is caught by round 2.
        val found = ArrayDeque(listOf(1, 1, 0))
        var rounds = 0
        assertTrue(ManagedServices.sweepUntilEmpty(5) { rounds++; found.removeFirst() })
        assertEquals(3, rounds)
        // Bounded: never more than maxRounds, and reports that it did not empty.
        rounds = 0
        assertFalse(ManagedServices.sweepUntilEmpty(5) { rounds++; 1 })
        assertEquals(5, rounds)
        rounds = 0
        assertTrue(ManagedServices.sweepUntilEmpty(5) { rounds++; 0 })
        assertEquals(1, rounds)
    }

    @Test
    fun serviceControlAuditLineIsClosed() {
        val p = "0123456789abcdef0123456789abcdef"
        val line = IngressAuditWriter.buildServiceControlLine(now, p, "start", "article-delivery", "started")
        assertNotNull(line)
        val o = JSONObject(line!!)
        assertEquals("mcp_service_control", o.getString("kind"))
        assertEquals("mcp_service_control", o.getString("event"))
        assertEquals(p, o.getString("principal"))
        assertEquals("start", o.getString("action"))
        assertEquals("article-delivery", o.getString("serviceId"))
        assertEquals("started", o.getString("code"))
        assertFalse(o.has("agentId"))
        // STOP-ALL stops carry no principal.
        assertNotNull(IngressAuditWriter.buildServiceControlLine(now, null, "stop", "article-delivery", "stopped"))
        assertNull(IngressAuditWriter.buildServiceControlLine(now, "X", "start", "article-delivery", "started"))
        assertNull(IngressAuditWriter.buildServiceControlLine(now, p, "restart", "article-delivery", "started"))
        assertNull(IngressAuditWriter.buildServiceControlLine(now, p, "start", "other", "started"))
        assertNull(IngressAuditWriter.buildServiceControlLine(now, p, "start", "article-delivery", "Started!"))

        val fromRn = IngressAuditWriter.buildServiceControlLineFromJson(now,
            """{"kind":"mcp_service_control","event":"mcp_service_control","principal":"$p","action":"stop","serviceId":"council-facade","code":"denied"}""")
        assertEquals("denied", JSONObject(fromRn!!).getString("code"))
        // Unchecked arguments: the refusal line names neither, and only that code may omit them.
        assertNotNull(IngressAuditWriter.buildServiceControlLineFromJson(now,
            """{"kind":"mcp_service_control","event":"mcp_service_control","principal":"$p","code":"invalid_params"}"""))
        assertNull(IngressAuditWriter.buildServiceControlLine(now, p, null, null, "started"))
        // Extra fields (a path, a command) are refused.
        assertNull(IngressAuditWriter.buildServiceControlLineFromJson(now,
            """{"kind":"mcp_service_control","event":"mcp_service_control","principal":"$p","action":"start","serviceId":"article-delivery","code":"x","path":"/sdcard"}"""))
    }

    @Test
    fun recordCarriesOnlyTheFacadeScriptShape() {
        val r = ManagedServices.Record(6293, "123", 1_000L, script = "council-spike/dist/http/server.js")
        assertEquals(r, ManagedServices.parseRecord(ManagedServices.encodeRecord(r)))
        // A record without script (article-delivery) round-trips without one.
        val plain = ManagedServices.Record(6293, "123", 1_000L)
        assertFalse(JSONObject(ManagedServices.encodeRecord(plain)).has("script"))
        // Any other script value is dropped, never the record itself.
        for (bad in listOf("../x/dist/http/server.js", "a/b/dist/http/server.js", "x/dist/other.js", "/abs/dist/http/server.js")) {
            val parsed = ManagedServices.parseRecord("""{"v":1,"pid":6293,"startTime":"123","startedAt":1000,"script":"$bad"}""")
            assertNotNull(parsed)
            assertNull(parsed!!.script)
            assertFalse(JSONObject(ManagedServices.encodeRecord(r.copy(script = bad))).has("script"))
        }
    }

    private fun http(head: String, body: String): ByteArray = (head + "\r\n\r\n" + body).toByteArray(Charsets.UTF_8)

    @Test
    fun healthResponseOkAcceptsOnlyA200WithTheBooleanTrue() {
        assertTrue(ManagedServices.healthResponseOk(http("HTTP/1.1 200 OK\r\nContent-Type: application/json", """{"ok":true,"v":1}""")))
        assertTrue(ManagedServices.healthResponseOk(http("HTTP/1.0 200 OK\r\nContent-Length: 11", """{"ok":true}""")))
        // The string "true", false, missing, not an object, not JSON.
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 200 OK", """{"ok":"true"}""")))
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 200 OK", """{"ok":false}""")))
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 200 OK", """{"status":"ok"}""")))
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 200 OK", "true")))
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 200 OK", "<html>")))
        // Any other status, a redirect, a chunked body, no header terminator.
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 503 Service Unavailable", """{"ok":true}""")))
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 302 Found\r\nLocation: http://evil/", """{"ok":true}""")))
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked", "b\r\n{\"ok\":true}\r\n0")))
        assertFalse(ManagedServices.healthResponseOk("HTTP/1.1 200 OK\r\n{\"ok\":true}".toByteArray()))
        // Content-Length beyond what arrived, duplicated, or malformed.
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 200 OK\r\nContent-Length: 50", """{"ok":true}""")))
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 200 OK\r\nContent-Length: 11\r\nContent-Length: 11", """{"ok":true}""")))
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 200 OK\r\nContent-Length: -1", """{"ok":true}""")))
        // Size caps: the body, and the whole response.
        val padded = """{"ok":true,"pad":"${"x".repeat(ManagedServices.HEALTH_MAX_BODY)}"}"""
        assertFalse(ManagedServices.healthResponseOk(http("HTTP/1.1 200 OK", padded)))
        assertFalse(ManagedServices.healthResponseOk(ByteArray(ManagedServices.HEALTH_MAX_RESPONSE + 1)))
    }

    @Test
    fun commandHomeIsCanonicalOnlyForAWorkDirLaunch() {
        val abs = "/data/user/0/x/files/home"
        val canon = "/data/data/x/files/home"
        // article-delivery: unchanged absolute spelling.
        assertEquals(abs, ManagedServices.commandHome(launch, abs, canon))
        // council-facade (workDir set): the canonical path node's ESM entry check compares against.
        val facade = launch.copy(script = "council-spike/dist/http/server.js", workDir = "council-spike")
        assertEquals(canon, ManagedServices.commandHome(facade, abs, canon))
        val cmd = ManagedServices.hostCommand(facade, ManagedServices.commandHome(facade, abs, canon), "/l", "$abs/log")
        assertTrue(cmd.contains("'$canon/council-spike/dist/http/server.js'"))
        // Unknown or relative canonical form: falls back to the absolute one.
        assertEquals(abs, ManagedServices.commandHome(facade, abs, null))
        assertEquals(abs, ManagedServices.commandHome(facade, abs, "relative"))
    }

    @Test
    fun serviceControlSpecAuditLineIsClosed() {
        val digest = "a".repeat(64)
        val line = IngressAuditWriter.buildServiceControlSpecLine(now, "council-facade", true, "ok", digest)
        assertNotNull(line)
        val o = JSONObject(line!!)
        assertEquals("mcp_service_control_spec", o.getString("kind"))
        assertEquals("mcp_service_control_spec", o.getString("event"))
        assertEquals("council-facade", o.getString("serviceId"))
        assertTrue(o.getBoolean("ok"))
        assertEquals("ok", o.getString("reason"))
        assertEquals(digest, o.getString("digest"))
        // A refused reading carries no digest; an "ok" one must have one.
        val refused = IngressAuditWriter.buildServiceControlSpecLine(now, "council-facade", false, "bad_json", null)
        assertNotNull(refused)
        assertFalse(JSONObject(refused!!).has("digest"))
        assertNull(IngressAuditWriter.buildServiceControlSpecLine(now, "council-facade", true, "ok", null))
        assertNull(IngressAuditWriter.buildServiceControlSpecLine(now, "council-facade", true, "ok", "not-hex"))
        assertNull(IngressAuditWriter.buildServiceControlSpecLine(now, "other", true, "ok", digest))
        assertNull(IngressAuditWriter.buildServiceControlSpecLine(now, "council-facade", true, "Not Lowercase!", digest))
    }

    // ── S2: automatic recovery ─────────────────────────────────────────────

    private fun rec(
        restarts: Int = 0, windowAt: Long? = null, gaveUpAt: Long? = null,
        stoppedAt: Long? = null, exitedAt: Long? = null, haltStop: Boolean = false,
    ) = ManagedServices.Record(
        6293, "123", now - 60_000L, stoppedAt = stoppedAt, exitedAt = exitedAt,
        restarts = restarts, restartWindowAt = windowAt, gaveUpAt = gaveUpAt, haltStop = haltStop,
    )

    @Test
    fun bothServicesAreAutostart() {
        assertTrue(ManagedServices.REGISTRY.values.all { it.autostart })
        // A resolved copy keeps it (resolvedSpec uses copy()).
        assertTrue(facade.copy(launch = launch).autostart)
    }

    @Test
    fun recordAccountingRoundTripsAndOldRecordsStillRead() {
        val r = rec(restarts = 3, windowAt = now - 1000, gaveUpAt = now, stoppedAt = now, haltStop = true)
        assertEquals(r, ManagedServices.parseRecord(ManagedServices.encodeRecord(r)))
        // An S1 record (no accounting fields) reads as zero restarts, not as no record.
        val old = ManagedServices.parseRecord("""{"v":1,"pid":6293,"startTime":"123","startedAt":5,"exitedAt":9,"exitCode":143}""")!!
        assertEquals(0, old.restarts)
        assertNull(old.restartWindowAt)
        assertNull(old.gaveUpAt)
        assertFalse(old.haltStop)
        assertEquals(143, old.exitCode)
        // Still v 1 on disk; zero / false fields are not written.
        val enc = JSONObject(ManagedServices.encodeRecord(rec()))
        assertEquals(1, enc.getInt("v"))
        assertFalse(enc.has("restarts"))
        assertFalse(enc.has("haltStop"))
    }

    @Test
    fun recordAccountingOutOfShapeIsDroppedNotTheRecord() {
        val r = ManagedServices.parseRecord(
            """{"v":1,"pid":6293,"startTime":"123","startedAt":5,"restarts":-1,"restartWindowAt":1.5,"gaveUpAt":"x","haltStop":"true"}""",
        )!!
        assertEquals(0, r.restarts)
        assertNull(r.restartWindowAt)
        assertNull(r.gaveUpAt)
        assertFalse(r.haltStop)
        // haltStop without stoppedAt means nothing.
        assertFalse(ManagedServices.parseRecord("""{"v":1,"pid":6293,"startTime":"123","startedAt":5,"haltStop":true}""")!!.haltStop)
        assertEquals(0, ManagedServices.parseRecord("""{"v":1,"pid":6293,"startTime":"123","startedAt":5,"restarts":100000}""")!!.restarts)
    }

    @Test
    fun backoffIs30s2m10mThenStopsAtFive() {
        var r = rec()
        val delays = ArrayList<Long?>()
        repeat(7) {
            val p = ManagedServices.nextRestart(r, 1_000L, now)
            delays += p.delayMs
            r = p.record
        }
        assertEquals(listOf<Long?>(30_000L, 120_000L, 600_000L, 600_000L, 600_000L, null, null), delays)
        assertEquals(5, r.restarts)
        assertEquals(now, r.gaveUpAt)
    }

    @Test
    fun limitIsReportedOnceAndKeepsItsTime() {
        val first = ManagedServices.nextRestart(rec(restarts = 5, windowAt = now - 1000), 1_000L, now)
        assertNull(first.delayMs)
        assertEquals(now, first.record.gaveUpAt)
        val again = ManagedServices.nextRestart(first.record, 1_000L, now + 5_000L)
        assertNull(again.delayMs)
        assertEquals(now, again.record.gaveUpAt)
    }

    @Test
    fun stableRunAndWindowEndResetTheCount() {
        val stable = ManagedServices.nextRestart(rec(restarts = 5, windowAt = now - 1000, gaveUpAt = now - 500), ManagedServices.RESTART_STABLE_MS, now)
        assertEquals(30_000L, stable.delayMs)
        assertEquals(1, stable.record.restarts)
        assertNull(stable.record.gaveUpAt)
        val expired = ManagedServices.nextRestart(rec(restarts = 5, windowAt = now - ManagedServices.RESTART_WINDOW_MS), 1_000L, now)
        assertEquals(30_000L, expired.delayMs)
        assertEquals(now, expired.record.restartWindowAt)
        // A window start in the future (clock moved back) starts a new window.
        val skew = ManagedServices.nextRestart(rec(restarts = 5, windowAt = now + 3_600_000L), 1_000L, now)
        assertEquals(30_000L, skew.delayMs)
    }

    private fun st(state: ManagedServices.State, pid: Int? = null, supervised: Boolean = false) =
        ManagedServices.Status(state, pid, null, null, supervised)

    @Test
    fun reconcileDecisions() {
        val dead = st(ManagedServices.State.DEAD)
        val stopped = st(ManagedServices.State.STOPPED)
        val alive = st(ManagedServices.State.RUNNING, 6293)
        fun act(spec: ManagedServices.Spec, r: ManagedServices.Record?, s: ManagedServices.Status, halted: Boolean) =
            ManagedServices.reconcileAction(spec, r, s, halted)
        // Never started here / stopped on purpose / already supervised / not autostart: nothing.
        assertEquals(ManagedServices.ReconcileAction.NONE, act(delivery, null, dead, false))
        assertEquals(ManagedServices.ReconcileAction.NONE, act(delivery, rec(stoppedAt = now), stopped, false))
        assertEquals(ManagedServices.ReconcileAction.NONE, act(delivery, rec(), st(ManagedServices.State.RUNNING, 6293, supervised = true), false))
        assertEquals(ManagedServices.ReconcileAction.NONE, act(delivery.copy(autostart = false), rec(), dead, false))
        // Gone and wanted: start.
        assertEquals(ManagedServices.ReconcileAction.START, act(delivery, rec(exitedAt = now), dead, false))
        // Stopped by STOP-ALL: back once it is lifted, not before.
        assertEquals(ManagedServices.ReconcileAction.START, act(delivery, rec(stoppedAt = now, haltStop = true), stopped, false))
        assertEquals(ManagedServices.ReconcileAction.HALTED, act(delivery, rec(stoppedAt = now, haltStop = true), stopped, true))
        assertEquals(ManagedServices.ReconcileAction.HALTED, act(delivery, rec(), dead, true))
        // A verified survivor while halted is stopped; otherwise adopted.
        assertEquals(ManagedServices.ReconcileAction.HALTED_STOP, act(delivery, rec(), alive, true))
        assertEquals(ManagedServices.ReconcileAction.ADOPT, act(delivery, rec(), alive, false))
        // Healthy but no verifiable pid: left alone.
        val f = facade.copy(launch = launch)
        assertEquals(ManagedServices.ReconcileAction.UNVERIFIED, act(f, rec(), st(ManagedServices.State.RUNNING), false))
        // No usable launch spec (or only a stop-only identity).
        assertEquals(ManagedServices.ReconcileAction.NOT_CONFIGURED, act(facade, rec(), st(ManagedServices.State.NOT_CONFIGURED), false))
        assertEquals(ManagedServices.ReconcileAction.NOT_CONFIGURED, act(f.copy(stopOnly = true), rec(), dead, false))
    }

    @Test
    fun autoCodesFitTheAuditCodeShape() {
        val re = Regex("^[a-z_]{1,32}$")
        for (p in listOf("restart", "reconcile", "adopt", "halt")) {
            for (c in listOf("started", "launch_failed", "halted", "already_running", "not_configured", "not_installed", "stopped", "stop_failed", "not_running")) {
                val code = ManagedServices.autoCode(p, c)
                assertTrue(code, re.matches(code))
                assertEquals("${p}_$c", code)
                assertNotNull(IngressAuditWriter.buildServiceControlLine(now, null, "start", "council-facade", code))
            }
        }
        for (c in listOf("restart_scheduled", "restart_limit", "restart_record_failed", "reconcile_restart_limit", "reconcile_unverified", "reconcile_halted", "adopt_failed")) {
            assertTrue(c, re.matches(c))
        }
    }
}
