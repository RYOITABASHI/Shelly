package expo.modules.terminalemulator

import java.io.File
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import org.json.JSONObject

/**
 * The closed registry of long-running on-device processes that the MCP op
 * `service_control` (lib/mcp-service-control.ts) may start, stop and inspect,
 * plus the pure decisions ManagedServiceSupervisor makes about them.
 *
 * Nothing here comes from the caller: an MCP client names an id and an
 * action, and everything a start runs (script, arguments, working directory,
 * environment) is fixed in this file. Keep REGISTRY's ids, ACTIONS and State
 * in step with lib/mcp-service-control.ts (__tests__/mcp-service-control.test.ts
 * reads this source to check).
 *
 * Pure: no Android imports, so it runs in JVM unit tests (ManagedServicesTest).
 */
object ManagedServices {
    /** Shelly-owned state for each service: `<home>/.shelly/services/<id>/`. */
    const val SERVICES_DIR = ".shelly/services"
    const val RECORD_FILE = "state.json"
    const val OUTPUT_LOG = "output.log"
    const val OUTPUT_LOG_MAX_BYTES = 1L shl 20
    /** STOP-ALL sentinel (same path as StopAllSwitches.haltedSentinel). */
    const val HALT_SENTINEL = ".shelly/agents/.halted"

    val ACTIONS: Set<String> = setOf("start", "status", "stop")
    private val ID_RE = Regex("^[a-z0-9-]{1,40}$")

    /**
     * How LD_LIBRARY_PATH is left for the service. The P1 S0 spike traced a
     * process-launch failure (libz) to the launch-time environment, not to the
     * spawn method; its final form is still being measured on the device, so
     * this is the one switch to flip once it is known.
     */
    enum class LibraryPath { LIB_DIR, UNSET }

    /**
     * The launch environment. [sourceBashrc]: run the generated ~/.bashrc first,
     * so PATH / TLS / helpers match an interactive Shelly terminal (where the
     * service ran by hand until now). LD_PRELOAD is always cleared, like the
     * interactive PTY shell (see CodexRemoteHost.HOST_COMMAND).
     */
    data class LaunchEnv(val sourceBashrc: Boolean, val libraryPath: LibraryPath)

    val DEFAULT_ENV = LaunchEnv(sourceBashrc = true, libraryPath = LibraryPath.LIB_DIR)

    /** `node <home>/<script> <args…>`, run from the script's directory. */
    data class Launch(val script: String, val args: List<String>, val env: LaunchEnv)

    /**
     * Liveness written by the service itself: a JSON file `{"pid":…, "at":…}`
     * under the home. Older than [staleMs] = the service is not making progress.
     */
    data class Heartbeat(val file: String, val staleMs: Long)

    /** [launch] null = registered by shape only (answers `not_configured`). */
    data class Spec(val id: String, val launch: Launch?, val heartbeat: Heartbeat?)

    // article-delivery: the article delivery loop (5-minute rounds). Its
    // heartbeat is written each round; the script's own staleness rule is
    // 2 * 5 min + 1 min (LOOP_BEAT_STALE_MS), used here unchanged.
    //
    // council-facade: shape only. Its launch spec stays on the device under
    // ~/.shelly/services/council-facade/ (owner-specific paths stay out of this
    // public repository) and is wired in a later stage.
    val REGISTRY: Map<String, Spec> = linkedMapOf(
        "article-delivery" to Spec(
            id = "article-delivery",
            launch = Launch(".shelly/agents/.env.article-delivery.js", listOf("loop"), DEFAULT_ENV),
            heartbeat = Heartbeat(".shelly/agents/article-delivery-loop.json", 11 * 60_000L),
        ),
        "council-facade" to Spec(id = "council-facade", launch = null, heartbeat = null),
    )

    fun spec(id: String?): Spec? = if (id != null && ID_RE.matches(id)) REGISTRY[id] else null

    fun serviceDir(id: String): String = "$SERVICES_DIR/$id"

    // ── Launch command ─────────────────────────────────────────────────────

    fun shQuote(s: String): String = "'" + s.replace("'", "'\\''") + "'"

    /**
     * The `bash -c` body. Output goes to [logPath] (appended), stdin is
     * /dev/null, and `exec` keeps the spawned pid as the service's pid.
     */
    fun hostCommand(launch: Launch, homePath: String, libPath: String, logPath: String): String {
        val script = "$homePath/${launch.script}"
        val dir = script.substringBeforeLast('/')
        val sb = StringBuilder()
        sb.append("exec >>").append(shQuote(logPath)).append(" 2>&1 </dev/null\n")
        if (launch.env.sourceBashrc) {
            sb.append("{ [ -f \"\$HOME/.bashrc\" ] && . \"\$HOME/.bashrc\"; } >/dev/null 2>&1 </dev/null\n")
        }
        sb.append("unset LD_PRELOAD\n")
        when (launch.env.libraryPath) {
            LibraryPath.LIB_DIR -> sb.append("export LD_LIBRARY_PATH=").append(shQuote(libPath)).append('\n')
            LibraryPath.UNSET -> sb.append("unset LD_LIBRARY_PATH\n")
        }
        sb.append("cd ").append(shQuote(dir)).append(" || exit 126\n")
        sb.append("command -v node >/dev/null 2>&1 || exit 127\n")
        sb.append("printf '%s service start\\n' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\"\n")
        // STOP-ALL, checked again as the very last statement before exec: `[`
        // is a builtin, so no external command runs between the check and exec.
        sb.append("[ -e ").append(shQuote("$homePath/$HALT_SENTINEL")).append(" ] && exit 125\n")
        sb.append("exec node ").append(shQuote(script))
        for (a in launch.args) sb.append(' ').append(shQuote(a))
        sb.append('\n')
        return sb.toString()
    }

    /**
     * The absolute script paths a process of this service may show in its
     * cmdline: `<home>/<script>` for each spelling of the app home ([homes]:
     * the path HomeInitializer returns, its canonical form, and the
     * `/data/data/<pkg>` alias a shell may expand `~` to).
     */
    fun scriptPaths(launch: Launch, homes: Collection<String>): Set<String> =
        homes.filter { it.startsWith("/") && !it.endsWith("/") }.map { "$it/${launch.script}" }.toSet()

    /**
     * True when a `/proc/<pid>/cmdline` (NUL-separated) is exactly this
     * service: the program is node (directly, or as `linker64 <…>/node`), the
     * next argument is one of [scriptPaths] verbatim, and the remaining
     * arguments are the launch arguments. A file of the same name elsewhere
     * (`/tmp/.env.article-delivery.js`), a relative path, or any other argv
     * shape does not match, so a forged state.json / heartbeat cannot point a
     * stop at another process.
     */
    fun cmdlineMatches(launch: Launch, scriptPaths: Set<String>, cmdline: String?): Boolean {
        if (cmdline.isNullOrEmpty() || scriptPaths.isEmpty()) return false
        val argv = cmdline.split('\u0000').let { if (it.lastOrNull() == "") it.dropLast(1) else it }
        fun isNode(a: String) = a == "node" || (a.startsWith("/") && a.endsWith("/node"))
        val at = when {
            argv.isNotEmpty() && isNode(argv[0]) -> 1
            argv.size > 1 && (argv[0] == "linker64" || argv[0] == "/system/bin/linker64") && isNode(argv[1]) -> 2
            else -> return false
        }
        return argv.size == at + 1 + launch.args.size &&
            argv[at] in scriptPaths &&
            argv.subList(at + 1, argv.size) == launch.args
    }

    // ── Record (`state.json`, written only by the supervisor) ──────────────

    /**
     * What the supervisor last did with a service. [stoppedAt] set = stopped on
     * purpose (stop / STOP-ALL); [exitedAt] set without it = the process ended
     * by itself (a crash, or killed from outside): `dead`.
     */
    data class Record(
        val pid: Int,
        val startTime: String,
        val startedAt: Long,
        val stoppedAt: Long? = null,
        val exitedAt: Long? = null,
        val exitCode: Int? = null,
    )

    fun encodeRecord(r: Record): String {
        val o = JSONObject().put("v", 1).put("pid", r.pid).put("startTime", r.startTime).put("startedAt", r.startedAt)
        r.stoppedAt?.let { o.put("stoppedAt", it) }
        r.exitedAt?.let { o.put("exitedAt", it) }
        r.exitCode?.let { o.put("exitCode", it) }
        return o.toString()
    }

    private val START_TIME_RE = Regex("^[0-9]{1,20}$")

    fun parseRecord(text: String?): Record? = try {
        if (text == null || text.length > 4096) null else {
            val o = JSONObject(text)
            val pid = o.getInt("pid")
            val start = o.getString("startTime")
            val startedAt = o.getLong("startedAt")
            if (o.getInt("v") != 1 || pid <= 1 || !START_TIME_RE.matches(start) || startedAt < 0) null
            else Record(
                pid, start, startedAt,
                stoppedAt = if (o.has("stoppedAt")) o.getLong("stoppedAt") else null,
                exitedAt = if (o.has("exitedAt")) o.getLong("exitedAt") else null,
                exitCode = if (o.has("exitCode")) o.getInt("exitCode") else null,
            )
        }
    } catch (e: Exception) {
        null
    }

    // ── Writing under services/<id>/ (leaf symlinks refused) ──────────────
    //
    // The directory itself is checked by the supervisor (canonical path equals
    // the absolute one). Each file the supervisor writes is refused when its
    // leaf is a symlink, so a link planted in services/<id>/ cannot redirect a
    // write (into agents/ or anywhere else). Pure java.nio: JVM-testable.

    /** True when the leaf [f] is itself a symlink (not followed). */
    fun isSymlinkLeaf(f: File): Boolean = Files.isSymbolicLink(f.toPath())

    /**
     * Writes state.json through a per-writer temp file and an atomic rename.
     * False (nothing replaced) when the temp or the target leaf is a symlink,
     * or on any I/O error. The temp file is opened with NOFOLLOW_LINKS too.
     */
    fun writeRecordFile(dir: File, r: Record, tmpSuffix: String): Boolean {
        val target = File(dir, RECORD_FILE)
        val tmp = File(dir, "$RECORD_FILE.tmp-$tmpSuffix")
        if (isSymlinkLeaf(target) || isSymlinkLeaf(tmp)) return false
        return try {
            Files.newOutputStream(
                tmp.toPath(),
                StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING, StandardOpenOption.WRITE,
                LinkOption.NOFOLLOW_LINKS,
            ).use { it.write(encodeRecord(r).toByteArray(Charsets.UTF_8)) }
            if (isSymlinkLeaf(target)) {
                Files.deleteIfExists(tmp.toPath())
                return false
            }
            Files.move(tmp.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE)
            true
        } catch (e: Exception) {
            runCatching { if (!isSymlinkLeaf(tmp)) Files.deleteIfExists(tmp.toPath()) }
            false
        }
    }

    /**
     * Before a start: refuses (false) when output.log or output.log.1 is a
     * symlink (the shell would append through it); otherwise rotates
     * output.log to output.log.1 once it is over [OUTPUT_LOG_MAX_BYTES].
     */
    fun prepareOutputLog(dir: File): Boolean {
        val log = File(dir, OUTPUT_LOG)
        val old = File(dir, "$OUTPUT_LOG.1")
        if (isSymlinkLeaf(log) || isSymlinkLeaf(old)) return false
        return try {
            if (Files.exists(log.toPath(), LinkOption.NOFOLLOW_LINKS) && log.length() > OUTPUT_LOG_MAX_BYTES) {
                Files.move(log.toPath(), old.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
            true
        } catch (e: Exception) {
            false
        }
    }

    // ── Heartbeat ──────────────────────────────────────────────────────────

    /** pid 0 = "starting" marker some services write before their first round. */
    data class Beat(val pid: Int, val at: Long)

    fun parseBeat(text: String?): Beat? = try {
        if (text == null || text.length > 4096) null else {
            val o = JSONObject(text)
            val at = o.get("at")
            val pid = if (o.has("pid")) o.get("pid") else 0
            if (at !is Number || pid !is Number) null
            else {
                val atL = at.toLong()
                val pidI = pid.toInt()
                if (atL <= 0 || pidI < 0 || at.toDouble() != atL.toDouble()) null else Beat(pidI, atL)
            }
        }
    } catch (e: Exception) {
        null
    }

    // ── State ──────────────────────────────────────────────────────────────

    enum class State(val wire: String) {
        RUNNING("running"),
        STARTING("starting"),
        UNHEALTHY("unhealthy"),
        STOPPED("stopped"),
        DEAD("dead"),
        NOT_CONFIGURED("not_configured"),
    }

    /** A live process verified to be this service (pid + /proc starttime, and cmdline when not ours). */
    data class Live(val pid: Int, val startedAt: Long?, val supervised: Boolean)

    data class Status(
        val state: State,
        val pid: Int?,
        val startedAt: Long?,
        val lastHeartbeatAt: Long?,
        val supervised: Boolean,
        val exitCode: Int? = null,
        val exitedAt: Long? = null,
    )

    /**
     * running   alive, and the heartbeat is fresh (or the service has none)
     * starting  alive, no fresh heartbeat yet, still within one stale period of its start
     * unhealthy alive, but no fresh heartbeat past that grace
     * dead      not alive, and the supervisor's record says it was started and never stopped
     * stopped   not alive otherwise (never started here, or stopped on purpose)
     */
    fun decide(spec: Spec, live: Live?, record: Record?, beat: Beat?, now: Long): Status {
        if (spec.launch == null) return Status(State.NOT_CONFIGURED, null, null, null, supervised = false)
        val hbAt = beat?.at
        if (live != null) {
            val hb = spec.heartbeat
            val fresh = hb == null || (beat != null && now - beat.at in -60_000L..hb.staleMs &&
                (beat.pid == 0 || beat.pid == live.pid))
            val graceOk = hb != null && live.startedAt != null && now - live.startedAt in -60_000L..hb.staleMs
            val state = when {
                fresh -> State.RUNNING
                graceOk -> State.STARTING
                else -> State.UNHEALTHY
            }
            return Status(state, live.pid, live.startedAt, hbAt, live.supervised)
        }
        if (record != null && record.stoppedAt == null) {
            return Status(State.DEAD, null, record.startedAt, hbAt, supervised = false,
                exitCode = record.exitCode, exitedAt = record.exitedAt)
        }
        return Status(State.STOPPED, null, null, hbAt, supervised = false)
    }
}
