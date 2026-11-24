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
        assertTrue(cmd.endsWith("exec node '/data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js' 'loop'\n"))

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
        assertTrue(ManagedServices.cmdlineMatches(launch, listOf("linker64", "/lib/node", "/data/user/0/x/files/home/.shelly/agents/.env.article-delivery.js", "loop").joinToString(nul) + nul))
        assertTrue(ManagedServices.cmdlineMatches(launch, listOf("node", "/data/data/x/files/home/.shelly/agents/.env.article-delivery.js", "loop").joinToString(nul)))
        assertTrue(ManagedServices.cmdlineMatches(launch, listOf("node", ".env.article-delivery.js", "loop").joinToString(nul)))
        assertFalse(ManagedServices.cmdlineMatches(launch, listOf("node", "/h/.shelly/agents/.env.article-delivery.js", "tick").joinToString(nul)))
        assertFalse(ManagedServices.cmdlineMatches(launch, listOf("node", "/h/.shelly/agents/.env.article-delivery.js").joinToString(nul)))
        assertFalse(ManagedServices.cmdlineMatches(launch, listOf("node", "/h/other.js", "loop").joinToString(nul)))
        assertFalse(ManagedServices.cmdlineMatches(launch, listOf("bash", "-c", "node /h/.shelly/agents/.env.article-delivery.js loop").joinToString(nul)))
        assertFalse(ManagedServices.cmdlineMatches(launch, ""))
        assertFalse(ManagedServices.cmdlineMatches(launch, null))
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
}
