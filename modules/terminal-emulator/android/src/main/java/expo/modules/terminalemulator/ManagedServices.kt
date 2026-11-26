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

    /**
     * `node <home>/<script> <args…>`, run from the script's directory, unless
     * [workDir] overrides it (home-relative; council-facade's clone root is not
     * the directory the entry script itself lives in, so the default dirname
     * rule does not apply to it). [extraEnv]: additional variables the
     * generated script exports before the exec (empty for article-delivery;
     * council-facade's resolved env, built by ExternalSpec.parse).
     */
    data class Launch(
        val script: String,
        val args: List<String>,
        val env: LaunchEnv,
        val workDir: String? = null,
        val extraEnv: List<EnvVar> = emptyList(),
        /**
         * Run node with `LD_PRELOAD=<lib>/libexec_wrapper.so`, so processes it
         * spawns itself (no shell) can be app-data ELFs: without it, node's own
         * execve of one fails with EACCES (W^X; measured on device 2026-11-26 for
         * council-facade spawning `codex_exec`). False for article-delivery
         * (unchanged); ExternalSpec sets it for council-facade.
         */
        val execWrapper: Boolean = false,
    )

    /**
     * An extra environment variable the host script exports before the exec.
     * [Literal.value] is written into the generated script as a quoted literal
     * (fine for non-secret configuration: principals, ports, flags — never
     * anything the caller supplies, only values ExternalSpec.parse derived from
     * a validated on-device file). [FromFile.path] is read by the shell itself
     * at run time (`$(cat -- path)`), so the secret's value never becomes a
     * literal in a string this app builds, logs, or holds past the read.
     */
    sealed class EnvVar {
        data class Literal(val name: String, val value: String) : EnvVar()
        data class FromFile(val name: String, val path: String) : EnvVar()
    }

    /**
     * Liveness written by the service itself: a JSON file `{"pid":…, "at":…}`
     * under the home. Older than [staleMs] = the service is not making progress.
     */
    data class Heartbeat(val file: String, val staleMs: Long)

    /**
     * Liveness answered by the service itself over HTTP instead of a file
     * (council-facade's /health): [port] on loopback, [timeoutMs] bounds the
     * poll, [staleMs] is the same grace/staleness window [Heartbeat.staleMs]
     * plays for decide() (a synthesized Beat stands in for the file read).
     */
    data class HealthCheck(val port: Int, val timeoutMs: Long, val staleMs: Long)

    /**
     * [launch] null = registered by shape only (answers `not_configured`).
     * [health] is set only for a resolved council-facade Spec (never on the
     * static REGISTRY entry): ManagedServiceSupervisor builds that copy from
     * the on-device file, REGISTRY itself never changes.
     * [stopOnly]: a Spec recovered from state.json while the launch-spec file
     * is unusable (ManagedServiceSupervisor.recoveredFacadeSpec). It carries
     * only enough identity to verify and stop the running process; a start
     * under it is refused (its env would be incomplete).
     */
    data class Spec(
        val id: String,
        val launch: Launch?,
        val heartbeat: Heartbeat?,
        val health: HealthCheck? = null,
        val stopOnly: Boolean = false,
    )

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
     * The home spelling a launch's command is built with. council-facade (a
     * launch with [Launch.workDir]) is an ES module whose entry runs only when
     * `import.meta.url === pathToFileURL(resolve(process.argv[1])).href`; node
     * resolves the main module's real path (`/data/user/0` is a symlink to
     * `/data/data` on Android), so argv[1] must already be the canonical path
     * or the server exits 0 without listening (measured on device, 2026-11-25).
     * article-delivery keeps the absolute spelling it has always used.
     * Process verification accepts both (ManagedServiceSupervisor.homeSpellings).
     */
    fun commandHome(launch: Launch, absolute: String, canonical: String?): String =
        if (launch.workDir != null && canonical != null && canonical.startsWith("/")) canonical else absolute

    /** The system linker every app-data binary is started through (W^X: never exec'd directly). */
    const val LINKER64 = "/system/bin/linker64"

    /**
     * The `bash -c` body. Output goes to [logPath] (appended), stdin is
     * /dev/null, and `exec` keeps the spawned pid as the service's pid.
     *
     * node is started as `/system/bin/linker64 <libPath>/node …`, the same form
     * as AgentRuntime's executor launch, never as `exec node`: the bundled node
     * lives in the app's data dir (termux-libs), and exec'ing it directly fails
     * with EACCES on the device (W^X; measured 2026-11-25, exit 126,
     * "termux-libs/node: Permission denied"). linker64 is a system binary, so
     * the kernel exec succeeds, and it maps node with mmap, not execve.
     */
    fun hostCommand(launch: Launch, homePath: String, libPath: String, logPath: String): String {
        val script = "$homePath/${launch.script}"
        val dir = launch.workDir?.let { "$homePath/$it" } ?: script.substringBeforeLast('/')
        val node = "$libPath/node"
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
        sb.append("[ -f ").append(shQuote(node)).append(" ] || exit 127\n")
        // Extra env (council-facade): a literal is exported as a quoted value;
        // a FromFile var is read by the shell itself, so its value is never a
        // literal in this (or any) string the app builds. Output already goes
        // to the log and the sourced .bashrc may have turned tracing on: so
        // before a secret is read, xtrace / verbose and a DEBUG trap are
        // switched off, and the value is read with `read` into the variable
        // (no command substitution whose expansion a trace would print);
        // `export` then names it only.
        if (launch.extraEnv.any { it is EnvVar.FromFile }) {
            sb.append("builtin set +o xtrace +o verbose; builtin trap - DEBUG\n")
        }
        for (v in launch.extraEnv) {
            when (v) {
                is EnvVar.Literal -> sb.append("export ").append(v.name).append('=').append(shQuote(v.value)).append('\n')
                is EnvVar.FromFile -> {
                    sb.append("[ -f ").append(shQuote(v.path)).append(" ] || exit 127\n")
                    sb.append(v.name).append("=\n")
                    sb.append("IFS= builtin read -r ").append(v.name).append(" < ").append(shQuote(v.path))
                        .append(" || [ -n \"\$").append(v.name).append("\" ] || exit 127\n")
                    sb.append("builtin export ").append(v.name).append('\n')
                }
            }
        }
        sb.append("printf '%s service start\\n' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\"\n")
        // After every external command above (date), before the STOP-ALL check
        // that stays the last statement: `export` is a builtin.
        if (launch.execWrapper) {
            // The lib dir first on PATH: a command node spawns by bare name
            // (council-facade's codex_exec) resolves to the APK-extracted file,
            // refreshed by LibExtractor right before this start, never to
            // whatever $HOME/bin (first on the .bashrc PATH) holds.
            sb.append("export PATH=").append(shQuote(libPath)).append(":\"\$PATH\"\n")
            sb.append("export LD_PRELOAD=").append(shQuote("$libPath/libexec_wrapper.so")).append('\n')
        }
        // STOP-ALL, checked again as the very last statement before exec: `[`
        // is a builtin, so no external command runs between the check and exec.
        sb.append("[ -e ").append(shQuote("$homePath/$HALT_SENTINEL")).append(" ] && exit 125\n")
        sb.append("exec ").append(LINKER64).append(' ').append(shQuote(node)).append(' ').append(shQuote(script))
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

    // ── HTTP health (council-facade /health) ───────────────────────────────

    /** Bytes read from one /health exchange at most (status line + headers + body). */
    const val HEALTH_MAX_RESPONSE = 8192
    /** The body itself at most. */
    const val HEALTH_MAX_BODY = 4096
    private val HEALTH_STATUS_RE = Regex("^HTTP/1\\.[01] 200( .*)?$")
    private val CONTENT_LENGTH_RE = Regex("^[0-9]{1,5}$")

    /**
     * True only for an HTTP/1.x 200 response without Transfer-Encoding (the
     * request is HTTP/1.0, so a chunked body is never expected) whose body
     * (its Content-Length when given, else the rest) is at most
     * [HEALTH_MAX_BODY] bytes of a JSON object with `ok` the JSON boolean
     * `true` (the string "true" does not count). [raw] is the whole response
     * as read; more than [HEALTH_MAX_RESPONSE] bytes is refused.
     */
    fun healthResponseOk(raw: ByteArray): Boolean {
        if (raw.size > HEALTH_MAX_RESPONSE) return false
        var sep = -1
        for (i in 0..raw.size - 4) {
            if (raw[i] == 13.toByte() && raw[i + 1] == 10.toByte() && raw[i + 2] == 13.toByte() && raw[i + 3] == 10.toByte()) {
                sep = i
                break
            }
        }
        if (sep < 0) return false
        val head = String(raw, 0, sep, Charsets.ISO_8859_1).split("\r\n")
        if (!HEALTH_STATUS_RE.matches(head[0])) return false
        var contentLength: Int? = null
        for (h in head.drop(1)) {
            val c = h.indexOf(':')
            if (c <= 0) return false
            val name = h.substring(0, c).trim().lowercase()
            val value = h.substring(c + 1).trim()
            if (name == "transfer-encoding") return false
            if (name == "content-length") {
                if (contentLength != null || !CONTENT_LENGTH_RE.matches(value)) return false
                contentLength = value.toInt()
            }
        }
        val bodyStart = sep + 4
        val available = raw.size - bodyStart
        val len = contentLength ?: available
        if (len > HEALTH_MAX_BODY || len > available) return false
        return try {
            JSONObject(String(raw, bodyStart, len, Charsets.UTF_8)).opt("ok") == true
        } catch (e: Exception) {
            false
        }
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
        /**
         * council-facade only: the home-relative script it was launched with
         * (ExternalSpec's `<root>/dist/http/server.js`), so a running facade
         * stays verifiable and stoppable from this record alone when the
         * launch-spec file is later deleted or broken. Null for article-delivery.
         */
        val script: String? = null,
    )

    /** The only script value a Record may carry (ExternalSpec's fixed entry under a single-segment root). */
    val RECORD_SCRIPT_RE = Regex("^[A-Za-z0-9_-]{1,64}/dist/http/server\\.js$")

    fun encodeRecord(r: Record): String {
        val o = JSONObject().put("v", 1).put("pid", r.pid).put("startTime", r.startTime).put("startedAt", r.startedAt)
        r.stoppedAt?.let { o.put("stoppedAt", it) }
        r.exitedAt?.let { o.put("exitedAt", it) }
        r.exitCode?.let { o.put("exitCode", it) }
        r.script?.takeIf { RECORD_SCRIPT_RE.matches(it) }?.let { o.put("script", it) }
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
                // An unexpected value is dropped, never the record: the record
                // still answers dead/stopped; only the recovery path loses it.
                script = (o.opt("script") as? String)?.takeIf { RECORD_SCRIPT_RE.matches(it) },
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

    // ── Exit sweep ─────────────────────────────────────────────────────────

    const val EXIT_SWEEP_MAX_ROUNDS = 5

    /**
     * Runs [round] (snapshot the live services and stop them all; returns how
     * many it found) until a round finds none, at most [maxRounds] times. A
     * start that was in progress when the sweep began is caught by a later
     * round. True when the last round found nothing.
     */
    fun sweepUntilEmpty(maxRounds: Int, round: () -> Int): Boolean {
        repeat(maxRounds) { if (round() == 0) return true }
        return false
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
            // staleMs is the file heartbeat's for article-delivery, the HTTP
            // health check's for a resolved council-facade Spec (its "beat" is
            // synthesized from the poll result, not read from a file) — decide()
            // itself does not care which.
            val staleMs = spec.heartbeat?.staleMs ?: spec.health?.staleMs
            val fresh = staleMs == null || (beat != null && now - beat.at in -60_000L..staleMs &&
                (beat.pid == 0 || beat.pid == live.pid))
            val graceOk = staleMs != null && live.startedAt != null && now - live.startedAt in -60_000L..staleMs
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

/**
 * Parses council-facade's on-device launch spec
 * (`<home>/.shelly/services/council-facade/launch-spec.json`, ManagedServices.
 * ExternalSpec.FILE) into a ManagedServices.Launch + HealthCheck, or refuses
 * with a short, closed [Result.reason] — never a Launch/HealthCheck built
 * from a half-valid file. Pure (no Android imports, no I/O): the caller reads
 * the file (symlink/size-checked, as the rest of ManagedServices) and passes
 * its text here.
 *
 * Closed by construction: every top-level and env key is from a fixed set;
 * `root` / `script` / `COUNCIL_HOME` are single safe path segments (no `.`,
 * no `/`, no `..`); COUNCIL_CODEX_COMMAND / COUNCIL_CODEX_ARGS are fixed
 * constants this object sets, never read from the file (so the file cannot
 * steer what codex command the facade shells out to); the one secret key
 * (COUNCIL_HTTP_TOKEN) accepts only the literal marker `{"fromFile":true}` —
 * a literal string value for it is refused, never read into a Kotlin string.
 */
object ExternalSpec {
    const val FILE = "launch-spec.json"
    const val MAX_BYTES = 8192L

    /** One safe relative path segment: `root`, `script`'s directories, `COUNCIL_HOME`. */
    private val SEGMENT_RE = Regex("^[A-Za-z0-9_-]{1,64}$")
    /** The facade's one entry point under `root`; any other script is refused. */
    const val SCRIPT = "dist/http/server.js"
    private val PORT_RE = Regex("^[1-9][0-9]{0,4}$")
    /** Printable ASCII only, bounded: COUNCIL_PRINCIPAL / COUNCIL_HUMAN_PRINCIPALS. */
    private val SAFE_VALUE_RE = Regex("^[\\x20-\\x7e]{1,200}$")

    private const val DEFAULT_PORT = 8790
    private const val DEFAULT_PRINCIPAL = "host:operator"
    private const val TOKEN_FILE_NAME = ".http-token"
    /** A GET to /health is expected to answer at once; bounds a stuck or absent server. */
    const val HEALTH_TIMEOUT_MS = 1_500L
    /** One minute to bind the port and answer /health after the process starts. */
    const val HEALTH_STALE_MS = 60_000L

    /** Owner-settable keys. COUNCIL_CODEX_COMMAND / COUNCIL_CODEX_ARGS are not here: fixed, never from the file. */
    private val ENV_KEYS: Set<String> = setOf(
        "COUNCIL_HTTP_TOKEN", "COUNCIL_PRINCIPAL", "COUNCIL_HUMAN_PRINCIPALS",
        "COUNCIL_HOME", "COUNCIL_HTTP_PORT", "COUNCIL_PAIRING_ARM",
    )
    /** No default: the file must set these explicitly. */
    private val REQUIRED_ENV_KEYS: Set<String> = setOf("COUNCIL_HTTP_TOKEN", "COUNCIL_HOME", "COUNCIL_PAIRING_ARM")
    private val TOP_KEYS: Set<String> = setOf("v", "root", "script", "env")

    data class Result(val launch: ManagedServices.Launch?, val health: ManagedServices.HealthCheck?, val reason: String)

    private fun refuse(reason: String) = Result(null, null, reason)

    /** True only for the exact marker `{"fromFile":true}` (no other keys, no other value). */
    private fun isFromFileMarker(v: Any?): Boolean {
        if (v !is JSONObject) return false
        val keys = HashSet<String>()
        val it = v.keys()
        while (it.hasNext()) keys.add(it.next())
        return keys == setOf("fromFile") && (v.opt("fromFile") as? Boolean) == true
    }

    /**
     * [homePath]: absolute, used to resolve `root` (the clone's cwd) and
     * `COUNCIL_HOME` (and, under it, the fixed token file name) to absolute
     * paths; `script` stays home-relative (ManagedServices.Launch.script).
     */
    fun parse(text: String?, homePath: String): Result {
        if (text == null) return refuse("missing")
        if (text.length > MAX_BYTES) return refuse("too_large")
        val o = try { JSONObject(text) } catch (e: Exception) { return refuse("bad_json") }
        val keys = HashSet<String>()
        run { val it = o.keys(); while (it.hasNext()) keys.add(it.next()) }
        if (!TOP_KEYS.containsAll(keys)) return refuse("unknown_key")
        if (o.opt("v") != 1) return refuse("bad_version")
        val root = o.opt("root") as? String ?: return refuse("bad_root")
        if (!SEGMENT_RE.matches(root)) return refuse("bad_root")
        val script = o.opt("script") as? String ?: return refuse("bad_script")
        if (script != SCRIPT) return refuse("bad_script")
        val envObj = o.opt("env") as? JSONObject ?: return refuse("bad_env")
        val envKeys = HashSet<String>()
        run { val it = envObj.keys(); while (it.hasNext()) envKeys.add(it.next()) }
        if (!ENV_KEYS.containsAll(envKeys)) return refuse("unknown_env_key")
        if (!REQUIRED_ENV_KEYS.all { it in envKeys }) return refuse("missing_env_key")

        if (!isFromFileMarker(envObj.opt("COUNCIL_HTTP_TOKEN"))) return refuse("secret_not_reference")

        val councilHome = envObj.opt("COUNCIL_HOME") as? String ?: return refuse("bad_env_value")
        if (!SEGMENT_RE.matches(councilHome)) return refuse("bad_env_value")

        val pairingArm = envObj.opt("COUNCIL_PAIRING_ARM") as? String ?: return refuse("bad_env_value")
        if (pairingArm != "1") return refuse("bad_env_value")

        var port = DEFAULT_PORT
        if ("COUNCIL_HTTP_PORT" in envKeys) {
            val raw = envObj.opt("COUNCIL_HTTP_PORT") as? String ?: return refuse("bad_env_value")
            if (!PORT_RE.matches(raw)) return refuse("bad_env_value")
            port = raw.toIntOrNull()?.takeIf { it in 1..65535 } ?: return refuse("bad_env_value")
        }
        fun principalOrDefault(key: String): String {
            if (key !in envKeys) return DEFAULT_PRINCIPAL
            val v = envObj.opt(key) as? String ?: return ""
            return if (SAFE_VALUE_RE.matches(v)) v else ""
        }
        val principal = principalOrDefault("COUNCIL_PRINCIPAL")
        if (principal.isEmpty()) return refuse("bad_env_value")
        val humanPrincipals = principalOrDefault("COUNCIL_HUMAN_PRINCIPALS")
        if (humanPrincipals.isEmpty()) return refuse("bad_env_value")

        val councilHomeAbs = "$homePath/$councilHome"
        val extraEnv = listOf(
            ManagedServices.EnvVar.Literal("COUNCIL_HOME", councilHomeAbs),
            ManagedServices.EnvVar.Literal("COUNCIL_PRINCIPAL", principal),
            ManagedServices.EnvVar.Literal("COUNCIL_HUMAN_PRINCIPALS", humanPrincipals),
            ManagedServices.EnvVar.Literal("COUNCIL_HTTP_PORT", port.toString()),
            ManagedServices.EnvVar.Literal("COUNCIL_PAIRING_ARM", "1"),
            // Fixed, never from the file: the file cannot steer what codex command runs.
            ManagedServices.EnvVar.Literal("COUNCIL_CODEX_COMMAND", "codex_exec"),
            ManagedServices.EnvVar.Literal("COUNCIL_CODEX_ARGS", "--skip-git-repo-check -"),
            // The secret: read by the shell at run time, never a literal here.
            ManagedServices.EnvVar.FromFile("COUNCIL_HTTP_TOKEN", "$councilHomeAbs/$TOKEN_FILE_NAME"),
        )
        val launch = ManagedServices.Launch(
            script = "$root/$script",
            args = emptyList(),
            env = ManagedServices.DEFAULT_ENV,
            workDir = root,
            extraEnv = extraEnv,
            // node spawns COUNCIL_CODEX_COMMAND (codex_exec, an app-data ELF) itself.
            execWrapper = true,
        )
        val health = ManagedServices.HealthCheck(port = port, timeoutMs = HEALTH_TIMEOUT_MS, staleMs = HEALTH_STALE_MS)
        return Result(launch, health, "ok")
    }
}
