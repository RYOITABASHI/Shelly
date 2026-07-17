package expo.modules.terminalemulator.scouter

import android.content.Context
import android.net.Uri
import android.util.Base64
import expo.modules.terminalemulator.HomeInitializer
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap

/**
 * 2026-07-17 (docs/superpowers/DEFERRED.md "Capability broker Phase 0" mid-run
 * host approval follow-up). Native counterpart of
 * scripts/shelly-capability-broker.js's requestHostApproval(): a non-
 * allowlisted-host 'approve' verdict writes a "cap-broker-host" request file,
 * this bridge surfaces it as an Allow/Deny notification, and the human's
 * decision is written to a reply file the broker polls for.
 *
 * DELIBERATELY a SEPARATE class from [AgentActionApprovalBridge], not an
 * extension of it, for two structural reasons:
 *  1. [AgentActionApprovalBridge] keys its request/reply files by runId ALONE
 *     (one action dispatch per script run). A single agent run can call
 *     http_post_json many times (one per backend call), so a cap-broker-host
 *     request needs a COMPOUND key — runId + a fresh nonce per call — or
 *     concurrent approvals within the same run would collide on one filename.
 *  2. Keeping the data model (host/path/method, no command/preview/appAct
 *     fields) and the "type" tag distinct at the CLASS level, not just a
 *     field, makes it structurally impossible for a native reader to conflate
 *     "approve this action" with "approve this NEW host" — exactly the
 *     confusion the task's design doc calls out to avoid.
 *
 * Shares [AgentActionApprovalBridge]'s request/reply DIRECTORIES (not new
 * ones) — the broker passes the SAME $ACTION_APPROVAL_DIR/
 * $ACTION_APPROVAL_REPLY_DIR bash already declares — so there is only one
 * place a native watcher needs to poll; the "cap-" filename prefix (vs
 * "action-") and the JSON "type" field keep the two kinds distinguishable on
 * disk.
 *
 * UNSIGNED by design (unlike [AgentEscalationBridge]'s RSA-signed replies):
 * the threat model is a human explicitly consenting to ONE (host, agent, run,
 * nonce) tuple, not auto-approving a pre-configured action, so requiring an
 * exact runId+host+nonce match (mirrored again here, in addition to the
 * broker's own check, so a forged/directly-dropped reply file still can't be
 * used to spoof a DIFFERENT pending request) is the right strength — matching
 * this task's explicit scoping (reusing AgentEscalationBridge's signing infra
 * was called out as out of scope).
 */
data class AgentCapabilityApprovalRequest(
    val runId: String,
    val nonce: String,
    val agentId: String,
    val agentName: String?,
    val host: String,
    val path: String?,
    val method: String?,
    val ts: String?,
    val expiresAt: Long?,
    val requestSha256: String?
) {
    val key: String get() = listOf(runId, nonce, host, ts.orEmpty(), expiresAt?.toString().orEmpty()).joinToString("|")
}

object AgentCapabilityApprovalBridge {
    private val unsafeFilePart = Regex("[^A-Za-z0-9_.=-]")

    // Single-use, in-memory replay guard for the NOTIFICATION TAP itself
    // (distinct from the request's own nonce, which binds the broker's
    // request/reply — this one binds the PendingIntent, mirroring
    // AgentActionApprovalBridge's pendingActionNonces exactly, in its own map
    // so the two approval kinds can never cross-authenticate each other's
    // taps).
    private val pendingCapabilityNonces = ConcurrentHashMap<String, String>()
    private val secureRandom = SecureRandom()

    // Reuses AgentActionApprovalBridge's directories on purpose — see class
    // doc comment.
    fun requestDir(context: Context): File = AgentActionApprovalBridge.requestDir(context)
    fun replyDir(context: Context): File = AgentActionApprovalBridge.replyDir(context)

    fun requestFile(context: Context, runId: String, nonce: String): File =
        File(requestDir(context), "cap-${safeFilePart(runId)}-${safeFilePart(nonce)}.json")

    fun replyFile(context: Context, runId: String, nonce: String): File =
        File(replyDir(context), "cap-${safeFilePart(runId)}-${safeFilePart(nonce)}.reply.json")

    fun notificationId(runId: String, nonce: String): Int =
        NOTIFICATION_ID_PREFIX or (stableHash("agent-capability:$runId:$nonce") and NOTIFICATION_ID_MASK)

    fun registerCapabilityNonce(runId: String, nonce: String): String {
        val tapNonce = ByteArray(24)
        secureRandom.nextBytes(tapNonce)
        val encoded = Base64.encodeToString(tapNonce, Base64.NO_WRAP)
        pendingCapabilityNonces["$runId:$nonce"] = encoded
        return encoded
    }

    fun hasCapabilityNonce(runId: String, nonce: String): Boolean =
        pendingCapabilityNonces.containsKey("$runId:$nonce")

    /**
     * Scans [requestDir] for files matching the "cap-*.json" prefix (never
     * "action-*.json" — those belong to [AgentActionApprovalBridge] and this
     * function ignores them by construction, mirroring how
     * AgentRuntime.kt's notifier already filters on "action-" for the other
     * kind). Each candidate is validated to actually carry
     * "type":"cap-broker-host" before being parsed, so a malformed or
     * foreign file can never be misinterpreted as a host-approval request.
     */
    fun listPendingRequests(context: Context): List<AgentCapabilityApprovalRequest> {
        val dir = requestDir(context)
        val files = dir.listFiles { f -> f.isFile && f.name.startsWith("cap-") && f.name.endsWith(".json") } ?: return emptyList()
        return files.mapNotNull { fromRequestFile(context, it) }
    }

    fun fromRequestFile(context: Context, requestFile: File): AgentCapabilityApprovalRequest? {
        val request = requireCanonicalChild(requestFile, requestDir(context))
        if (!request.isFile) return null
        return try {
            val bytes = request.readBytes()
            val json = JSONObject(bytes.toString(Charsets.UTF_8))
            if (json.optString("type") != "cap-broker-host") return null
            val requestSha256 = sha256Hex(bytes)
            val parsed = fromJson(json, requestSha256) ?: return null
            val expected = requireCanonicalChild(requestFile(context, parsed.runId, parsed.nonce), requestDir(context))
            parsed.takeIf { expected.path == request.path }
        } catch (e: Exception) {
            null
        }
    }

    private fun fromJson(raw: JSONObject, requestSha256: String?): AgentCapabilityApprovalRequest? {
        val runId = raw.optString("runId").trim().takeIf { it.isNotBlank() } ?: return null
        val nonce = raw.optString("nonce").trim().takeIf { it.isNotBlank() } ?: return null
        val host = raw.optString("host").trim().takeIf { it.isNotBlank() } ?: return null
        return AgentCapabilityApprovalRequest(
            runId = runId,
            nonce = nonce,
            agentId = raw.optString("agentId").trim().takeIf { it.isNotBlank() } ?: "agent",
            agentName = raw.optString("agentName").trim().takeIf { it.isNotBlank() },
            host = host,
            path = raw.optString("path").trim().takeIf { it.isNotBlank() },
            method = raw.optString("method").trim().takeIf { it.isNotBlank() },
            ts = raw.optString("ts").trim().takeIf { it.isNotBlank() },
            expiresAt = raw.optLong("expiresAt").takeIf { it > 0L },
            requestSha256 = requestSha256
        )
    }

    /**
     * Writes the human's Allow/Deny decision. Echoes back runId + host + nonce
     * (the SAME three fields the broker's own requestHostApproval() checks) so
     * a reply can never be replayed for a different host or run — the
     * broker's match is the authoritative gate; this function's OWN checks
     * (requestSha256 + tap nonce) additionally protect the PendingIntent tap
     * itself from replay, mirroring
     * [AgentActionApprovalBridge.writeHumanReply] exactly.
     */
    fun writeHumanReply(
        context: Context,
        runId: String,
        nonce: String,
        decision: String,
        expectedRequestSha256: String,
        tapNonce: String
    ): File {
        require(decision == "accept" || decision == "decline") { "invalid capability decision" }
        val expectedTapNonce = pendingCapabilityNonces["$runId:$nonce"]
        val request = requireCanonicalChild(requestFile(context, runId, nonce), requestDir(context))
        require(request.isFile) { "capability approval request is no longer pending" }
        val bytes = request.readBytes()
        val requestJson = JSONObject(bytes.toString(Charsets.UTF_8))
        require(requestJson.optString("runId") == runId && requestJson.optString("nonce") == nonce) {
            "capability approval anchor mismatch"
        }
        val requestSha256 = sha256Hex(bytes)
        require(expectedRequestSha256.matches(HEX_SHA256_RE) && requestSha256 == expectedRequestSha256) {
            "capability approval no longer matches the displayed request"
        }
        val expiresAt = requestJson.optLong("expiresAt")
        require(expiresAt <= 0L || System.currentTimeMillis() <= expiresAt) { "capability approval expired" }
        require(!expectedTapNonce.isNullOrBlank() && expectedTapNonce == tapNonce) {
            "capability approval action is stale or unauthenticated"
        }
        require(pendingCapabilityNonces.remove("$runId:$nonce", expectedTapNonce)) {
            "capability approval action is stale or unauthenticated"
        }

        val host = requestJson.optString("host")
        val reply = requireCanonicalChild(replyFile(context, runId, nonce), replyDir(context))
        reply.parentFile?.mkdirs()
        val tmp = File(reply.parentFile, ".${reply.name}.${android.os.Process.myPid()}.${System.nanoTime()}.tmp")
        val payload = JSONObject()
            .put("runId", runId)
            .put("nonce", nonce)
            .put("host", host)
            .put("decision", decision)
            .put("by", "human")
            .put("requestSha256", requestSha256)
            .put("ts", Instant.now().toString())
        tmp.writeText(payload.toString() + "\n")
        if (!tmp.renameTo(reply)) {
            tmp.delete()
            error("failed to publish capability approval reply")
        }
        return reply
    }

    fun clearRequest(context: Context, runId: String, nonce: String) {
        runCatching { requireCanonicalChild(requestFile(context, runId, nonce), requestDir(context)).delete() }
    }

    private fun safeFilePart(value: String): String =
        unsafeFilePart.replace(value.take(160), "_").ifBlank { "request" }

    private fun requireCanonicalChild(file: File, parent: File): File {
        val canonicalParent = parent.canonicalFile
        val canonical = file.canonicalFile
        require(canonical.path == canonicalParent.path || canonical.path.startsWith(canonicalParent.path + File.separator)) {
            "path escapes capability approval directory"
        }
        return canonical
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }

    private fun stableHash(value: String): Int {
        val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
        return ((digest[0].toInt() and 0xff) shl 24) or
            ((digest[1].toInt() and 0xff) shl 16) or
            ((digest[2].toInt() and 0xff) shl 8) or
            (digest[3].toInt() and 0xff)
    }

    private val HEX_SHA256_RE = Regex("^[0-9a-f]{64}$", RegexOption.IGNORE_CASE)
    private const val NOTIFICATION_ID_PREFIX = 0x35000000
    private const val NOTIFICATION_ID_MASK = 0x00ffffff
}
