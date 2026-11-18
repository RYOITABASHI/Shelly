package expo.modules.terminalemulator

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import org.json.JSONArray
import org.json.JSONObject

/**
 * The pure half of the headless raw-tool consumer (McpRawToolConsumer.kt):
 * the route decision, argument parsing, the command string RN would run, the
 * write_file path resolution (lib/mcp-ingress-gate.ts resolveWriteTarget,
 * against an [Fs] port), the snapshot MAC (scripts/shelly-mcp-server.js
 * snapshotMac), the policy seal check (the agent driver's policySealAccepts),
 * the gate helper's input / output, and the result shapes RN returns. No
 * Android dependency, so the JVM tests (McpRawToolDecisionTest) cover it; the
 * shared fixture __tests__/fixtures/mcp-raw-tool-cases.json pins the strings
 * that must equal the TS side.
 *
 * The gate DECISION itself is not here: native runs RN's TS (lib/mcp-raw-gate.ts
 * via the bundled helper). What IS copied from TS, and must be kept in sync
 * (each copy says "KEEP IN SYNC" with its source; the fixture test covers
 * them): SHELLY_LAZY_FN, ingressEnvPrefix / safeIngressValue, shellQuote,
 * execScript (lib/mcp-ingress-origin.ts, lib/mcp-server-bridge.ts
 * runMcpCommand), normalizePath / resolveWriteTarget (lib/agent-boundary-
 * policy.ts, lib/mcp-ingress-gate.ts), snapshotMac / repoPathsFromSnapshot
 * (scripts/shelly-mcp-server.js), policySealAccepts (scripts/shelly-agent-
 * driver.js), agentRequestIds (lib/agent-add-queue.ts file names, AGENT_REQUEST_FILE_RE).
 */
object McpRawToolDecision {
    /** The tools the server routes to `raw-requests/` (RAW_REQUEST_TOOLS). */
    val RAW_TOOLS: Set<String> = setOf("run_command", "write_file")

    /** write_file content arrives inside the request; the server caps a POST body at 1 MB. */
    const val MAX_REQUEST_BYTES = 4 * 1024 * 1024
    const val DEFAULT_TIMEOUT_MS = 30_000L
    /** Never longer than this, whatever the client asks (the client waits 100 s in all). */
    const val MAX_TIMEOUT_MS = 90_000L
    /** Room left before the client's deadline for writing the result. */
    const val DEADLINE_MARGIN_MS = 3_000L
    const val MIN_RUN_MS = 1_000L

    // ── Messages (lib/mcp-server-bridge.ts wording where RN has one) ──────

    const val EXEC_DISABLED_ERROR = "exec/write tools are disabled (Settings → Agents → MCP: Allow exec/write)"
    const val REVOKED_ERROR = "cancelled: the MCP token was regenerated"
    const val COMMAND_REQUIRED = "command is required"
    const val EXPIRED_ERROR = "the request expired before it could run"
    const val SKIP_TURNED_OFF_ERROR = "MCP: Run without approval was turned off before this call ran; call it again (it will need the approval tap)"
    const val AUDIT_FAILED_ERROR = "not run: its audit line could not be written"
    const val BUSY_ERROR = "Shelly is already running the maximum number of MCP calls; try again shortly"
    const val HANDOFF_FAILED_ERROR = "Shelly could not pass the request to the app for approval (internal file move failed); nothing was run"
    const val GATE_PREFIX = "refused by Shelly's agent gate — "

    // ── Route ────────────────────────────────────────────────────────────

    enum class Route { EXECUTE, HAND_OFF }

    /**
     * Native runs the call only when the owner's Keystore-verified switch is
     * on, the exec setting is on, and STOP-ALL is not active. Anything else
     * goes to RN, which answers it exactly as before (approval tap).
     */
    fun route(skipApprovalOn: Boolean, execOn: Boolean, halted: Boolean): Route =
        if (skipApprovalOn && execOn && !halted) Route.EXECUTE else Route.HAND_OFF

    // ── Arguments ────────────────────────────────────────────────────────

    data class RunCommandArgs(val command: String, val cwd: String?, val requestedTimeoutMs: Long?)
    data class WriteFileArgs(val path: String, val content: String)

    /** RN: `command` must be a non-blank string; `cwd` used when a non-empty string; `timeoutMs` when a number. */
    fun parseRunCommand(args: JSONObject): RunCommandArgs? {
        val command = args.opt("command") as? String ?: return null
        if (command.isBlank()) return null
        val cwd = (args.opt("cwd") as? String)?.takeIf { it.isNotEmpty() }
        val t = args.opt("timeoutMs")
        val timeout = if (t is Number && !(t is Double && t.isNaN())) t.toLong() else null
        return RunCommandArgs(command, cwd, timeout)
    }

    /** RN: non-string path / content read as ''. */
    fun parseWriteFile(args: JSONObject): WriteFileArgs =
        WriteFileArgs(args.opt("path") as? String ?: "", args.opt("content") as? String ?: "")

    /**
     * The timeout to run with: the client's value (default 30 s), at most
     * [MAX_TIMEOUT_MS], and ending [DEADLINE_MARGIN_MS] before the client stops
     * waiting (receivedAt + 100 s). Null when less than [MIN_RUN_MS] is left.
     */
    fun effectiveTimeoutMs(requested: Long?, receivedAtMs: Long, nowMs: Long): Long? {
        val asked = requested?.takeIf { it > 0 } ?: DEFAULT_TIMEOUT_MS
        val left = receivedAtMs + McpTypedOpDecision.MAX_REQUEST_AGE_MS - nowMs - DEADLINE_MARGIN_MS
        val t = minOf(asked, MAX_TIMEOUT_MS, left)
        return if (t < MIN_RUN_MS) null else t
    }

    // ── The command string (lib/mcp-ingress-origin.ts / lib/mcp-ingress-gate.ts) ─

    private val INGRESS_VALUE_RE = Regex("^[A-Za-z0-9_-]{1,64}$")

    /** KEEP IN SYNC: lib/mcp-ingress-origin.ts MCP_SHELLY_LAZY_FN. */
    const val SHELLY_LAZY_FN = "shelly() { unset -f shelly; . \"\$HOME/.bashrc\" >/dev/null 2>&1; shelly \"\$@\"; }; "

    fun safeIngressValue(value: String?): String = if (value != null && INGRESS_VALUE_RE.matches(value)) value else "unknown"

    /** KEEP IN SYNC: lib/mcp-ingress-origin.ts mcpIngressEnvPrefix (+ INGRESS_VALUE_RE). */
    fun ingressEnvPrefix(principal: String, callId: String): String =
        "export SHELLY_INGRESS=mcp SHELLY_INGRESS_CLIENT=${safeIngressValue(principal)} SHELLY_INGRESS_CALL=${safeIngressValue(callId)}; "

    /** KEEP IN SYNC: lib/mcp-ingress-gate.ts shellQuote. */
    fun shellQuote(value: String): String = "'" + value.replace("'", "'\\''") + "'"

    /** KEEP IN SYNC: exactly what RN's callTool + runMcpCommand hand to execCommand. */
    fun execScript(command: String, cwd: String?, principal: String, callId: String): String {
        val full = if (cwd != null) "cd ${shellQuote(cwd)} && $command" else command
        return ingressEnvPrefix(principal, callId) + SHELLY_LAZY_FN + full
    }

    // ── write_file target (lib/mcp-ingress-gate.ts resolveWriteTarget) ───

    enum class Kind { FILE, DIR, LINK, OTHER }
    data class Stat(val kind: Kind, val nlink: Long)

    /** File system port: [lstat] does not follow the last component; [isDirFollow] and [realPath] do. */
    interface Fs {
        fun lstat(path: String): Stat?
        fun isDirFollow(path: String): Boolean
        fun realPath(path: String): String?
    }

    sealed class Target {
        data class Ok(val realPath: String, val existed: Boolean) : Target()
        data class Err(val error: String) : Target()
    }

    private val CONTROL_RE = Regex("[\\x00-\\x1f\\x7f]")

    /** KEEP IN SYNC: lib/agent-boundary-policy.ts normalizePath. */
    fun normalizePath(p: String): String {
        val isAbs = p.startsWith("/")
        val out = ArrayList<String>()
        for (seg in p.split("/")) {
            if (seg.isEmpty() || seg == ".") continue
            if (seg == "..") {
                if (out.isNotEmpty() && out.last() != "..") out.removeAt(out.size - 1) else if (!isAbs) out.add("..")
            } else {
                out.add(seg)
            }
        }
        return (if (isAbs) "/" else "") + out.joinToString("/")
    }

    fun within(root: String, target: String): Boolean {
        if (root.isEmpty()) return false
        val r = if (root == "/") "" else root.trimEnd('/')
        return target == r || target.startsWith("$r/")
    }

    private fun cleanRealPath(p: String?): Boolean =
        p != null && p.startsWith("/") && !CONTROL_RE.containsMatchIn(p) && p.split("/").none { it == "." || it == ".." }

    private fun parentOf(p: String): String {
        val i = p.lastIndexOf('/')
        return if (i <= 0) "/" else p.substring(0, i)
    }

    /**
     * KEEP IN SYNC: lib/mcp-ingress-gate.ts resolveWriteTarget (rules and messages).
     * Where a write_file call would really land, with RN's rules and error
     * messages: absolute, no `..`, no control characters, lexically under an
     * allowed root; the leaf is not a symlink, is a regular file with one link
     * when it exists; the nearest existing ancestor is a directory (a dangling
     * link refuses), and its real path plus the missing components is under
     * the REAL path of an allowed root.
     */
    fun resolveWriteTarget(rawPath: String, allowedRoots: List<String>, fs: Fs): Target {
        val bare = if (rawPath.startsWith("file://")) rawPath.substring("file://".length) else rawPath
        if (bare.isEmpty() || !bare.startsWith("/") || CONTROL_RE.containsMatchIn(bare)) {
            return Target.Err("path must be an absolute path without control characters")
        }
        if (bare.split("/").contains("..")) return Target.Err("path must not contain \"..\"")
        val target = normalizePath(bare)
        if (target == "/" || target.endsWith("/")) return Target.Err("path must name a file")
        val roots = allowedRoots.filter { it.startsWith("/") && !CONTROL_RE.containsMatchIn(it) }.map { normalizePath(it) }
        if (roots.none { within(it, target) }) {
            return Target.Err("path must be under the home dir or a Shelly-configured repo (see list_repos)")
        }
        val leaf = fs.lstat(target)
        if (leaf != null) {
            if (leaf.kind == Kind.LINK) return Target.Err("refused: the target file is a symlink")
            if (leaf.kind != Kind.FILE) return Target.Err("refused: the target exists and is not a regular file")
            if (leaf.nlink != 1L) return Target.Err("refused: the target file has more than one hard link")
        }
        var d = parentOf(target)
        while (fs.lstat(d) == null && d != "/") d = parentOf(d)
        if (!fs.isDirFollow(d)) return Target.Err("refused: a parent of the target is not a directory (or is a dangling symlink)")
        val real = fs.realPath(d)
        val realRoots = roots.mapNotNull { fs.realPath(it) }
        if ((listOfNotNull(real) + realRoots).any { CONTROL_RE.containsMatchIn(it) }) {
            return Target.Err("refused: a resolved directory name contains control characters")
        }
        if (!cleanRealPath(real) || !within(d, target)) return Target.Err("could not resolve the path")
        val rest = target.substring(if (d == "/") 1 else d.length + 1)
        val realPath = normalizePath("$real/$rest")
        if (realRoots.filter { cleanRealPath(it) }.none { within(it, realPath) }) {
            return Target.Err("refused: the real path (after following symlinks) is outside the home dir and the configured repos")
        }
        return Target.Ok(realPath, existed = leaf != null)
    }

    // ── Snapshot (scripts/shelly-mcp-server.js snapshotMac / readVerifiedSnapshot) ─

    /** KEEP IN SYNC: scripts/shelly-mcp-server.js snapshotMac / readVerifiedSnapshot. */
    fun snapshotMac(token: String, body: String): String {
        val key = MessageDigest.getInstance("SHA-256").digest("shelly-mcp-snapshot:$token".toByteArray(Charsets.UTF_8))
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(body.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    }

    /** The Sidebar repo paths from a verified snapshot; null when it does not verify (then: home only). */
    fun repoPathsFromSnapshot(text: String?, token: String): List<String>? = try {
        if (text == null) {
            null
        } else {
            val outer = JSONObject(text)
            val body = outer.opt("body") as? String
            val presented = outer.opt("mac") as? String
            if (body == null || presented == null) {
                null
            } else if (!MessageDigest.isEqual(snapshotMac(token, body).toByteArray(Charsets.US_ASCII), presented.toByteArray(Charsets.US_ASCII))) {
                null
            } else {
                val data = JSONObject(body)
                val agents = data.opt("agents")
                val repos = data.opt("repoPaths")
                if (data.opt("v") != 1 || agents !is JSONArray || repos !is JSONArray) {
                    null
                } else {
                    val out = ArrayList<String>()
                    for (i in 0 until repos.length()) out.add(repos.get(i) as? String ?: return null)
                    out
                }
            }
        }
    } catch (e: Exception) {
        null
    }

    // ── POLICY-001 seal (scripts/shelly-agent-driver.js policySealAccepts) ─

    private val SEAL_HASH_RE = Regex("^[0-9a-f]{64}$")

    /**
     * KEEP IN SYNC: scripts/shelly-agent-driver.js policySealAccepts.
     * Whether policy.json's bytes ([bytes] null = no file) match the native
     * seal. An unreadable seal ([sealValid] false) never accepts; an empty seal
     * accepts only "no file / blank file" and only while no seal was ever
     * written.
     */
    fun policySealAccepts(seal: String, everSealed: Boolean, sealValid: Boolean, bytes: ByteArray?): Boolean {
        if (!sealValid) return false
        val raw = seal.trim()
        val parts = if (raw.isEmpty()) emptyList() else raw.split(",")
        if (parts.any { !SEAL_HASH_RE.matches(it) }) return false
        if (parts.isEmpty()) return !everSealed && (bytes == null || String(bytes, Charsets.UTF_8).isBlank())
        if (bytes == null) return false
        val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        return parts.contains(hash)
    }

    // ── Gate helper (scripts/mcp-raw-gate-entry.ts) ──────────────────────

    const val GATE_INPUT_GLOBAL = "__SHELLY_MCP_RAW_GATE_INPUT"

    private fun policyJson(policyText: String?, sealOk: Boolean): JSONObject =
        JSONObject().put("text", policyText ?: JSONObject.NULL).put("sealOk", sealOk)

    fun gateInputRunCommand(home: String, command: String, cwd: String?, policyText: String?, sealOk: Boolean): JSONObject =
        JSONObject().put("v", 1).put("tool", "run_command").put("home", home).put("command", command)
            .put("cwd", cwd ?: JSONObject.NULL).put("policy", policyJson(policyText, sealOk))

    /** [realPath] first; the path as sent only when it differs (RN judges both). */
    fun gateInputWriteFile(home: String, realPath: String, sentPath: String, policyText: String?, sealOk: Boolean): JSONObject {
        val paths = JSONArray().put(realPath)
        if (sentPath != realPath) paths.put(sentPath)
        return JSONObject().put("v", 1).put("tool", "write_file").put("home", home).put("paths", paths)
            .put("policy", policyJson(policyText, sealOk))
    }

    /** The script fed to `node -`: one line assigning the input, then the bundle. */
    fun gateScript(input: JSONObject, bundle: String): String = "globalThis.$GATE_INPUT_GLOBAL = $input;\n$bundle"

    data class GateVerdict(val refused: Boolean, val summary: String)

    const val RULES_UNAVAILABLE_SUMMARY =
        "your agent safety rules (~/.shelly/agents/policy.json) could not be verified, and without the approval tap nothing may run past them"

    /**
     * Fail closed: anything but exit 0 and `{v:1, refused:false, summary,
     * rulesUnavailable:false}` refuses. RN escalates an unverifiable
     * POLICY-001 file to the approval tap; there is no tap here, so it refuses.
     */
    fun parseGateOutput(stdout: String?, exitCode: Int?): GateVerdict {
        val unavailable = GateVerdict(true, "gate unavailable: the gate could not be evaluated")
        if (stdout == null || exitCode != 0) return unavailable
        return try {
            val o = JSONObject(stdout.trim())
            val refused = o.opt("refused")
            val summary = o.opt("summary") as? String
            val rulesUnavailable = o.opt("rulesUnavailable")
            when {
                o.opt("v") != 1 || refused !is Boolean || summary == null || rulesUnavailable !is Boolean -> unavailable
                refused -> GateVerdict(true, summary)
                rulesUnavailable -> GateVerdict(true, RULES_UNAVAILABLE_SUMMARY)
                else -> GateVerdict(false, summary)
            }
        } catch (e: Exception) {
            unavailable
        }
    }

    // ── Results (the shapes RN writes) ───────────────────────────────────

    fun errorResult(message: String): String = JSONObject().put("ok", false).put("error", message).toString()

    fun commandResult(stdout: String, stderr: String, exitCode: Int): String =
        JSONObject().put("ok", true).put(
            "data",
            JSONObject().put("stdout", stdout).put("stderr", stderr).put("exitCode", exitCode),
        ).toString()

    /** `bytes` is the content's length in UTF-16 units, as RN's `content.length`. */
    fun writeResult(path: String, contentLength: Int): String =
        JSONObject().put("ok", true).put("data", JSONObject().put("path", path).put("bytes", contentLength)).toString()

    // ── `shelly agent add` requests that appear while a command runs ─────

    private val AGENT_REQUEST_FILE_RE = Regex("^\\.shelly-agent-(req|pending|ctl|claim)-((?:ctl-)?[0-9]{10,16}-[0-9a-f]{8})$")

    /**
     * The agent requests in a $HOME listing, keyed as RN's classifier keys them
     * (lib/agent-add-queue.ts): `<id>` for add requests, `ctl-<id>` for
     * `shelly agent confirm|reject`. Wider than RN's own agentRequestIdsInHome
     * (req / pending only): ctl requests and in-progress claims count too, so a
     * native-run command can mark more, never less.
     * KEEP IN SYNC: lib/agent-add-queue.ts (file prefixes, REQ_ID_RE) and lib/mcp-native-ingress.ts (id shape).
     */
    fun agentRequestIds(names: Array<String>?): Set<String>? {
        if (names == null) return null
        val out = HashSet<String>()
        for (n in names) {
            val m = AGENT_REQUEST_FILE_RE.matchEntire(n) ?: continue
            val id = m.groupValues[2]
            out.add(if (m.groupValues[1] == "ctl") "ctl-$id" else id)
        }
        return out
    }
}
