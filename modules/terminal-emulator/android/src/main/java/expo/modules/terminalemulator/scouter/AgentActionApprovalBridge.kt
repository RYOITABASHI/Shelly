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

data class AgentActionApprovalRequest(
    val runId: String,
    val agentId: String,
    val agentName: String?,
    val toolLabel: String?,
    val actionType: String,
    val preview: String,
    val destinationHost: String?,
    val command: String?,
    val safetyLevel: String?,
    val safetyReason: String?,
    val payloadPath: String?,
    val resultPath: String?,
    val ts: String?,
    val expiresAt: Long?,
    val requestSha256: String?,
    val intentMode: String? = null,
    val intentTarget: String? = null,
    val intentShareText: String? = null,
    val dmPairingId: String? = null,
    val dmPairingLabel: String? = null,
    val dmReplyText: String? = null
) {
    val key: String get() = listOf(
        runId,
        actionType,
        ts.orEmpty(),
        expiresAt?.toString().orEmpty(),
        requestSha256.orEmpty()
    ).joinToString("|")
}

object AgentActionApprovalBridge {
    private val unsafeFilePart = Regex("[^A-Za-z0-9_.=-]")

    // Single-use, in-memory replay guard (mirrors AgentEscalationBridge's
    // pendingActionNonces exactly). Minted whenever the request is disclosed
    // to the human for a decision -- either via the Allow/Deny notification
    // PendingIntents (NotificationDispatcher.notifyAgentActionApprovalNeeded)
    // or via the in-app review card (TerminalEmulatorModule.readAgentActionApprovalRequest)
    // -- and consumed atomically by the first writeHumanReply call that
    // presents it, so a captured/replayed Intent or reply call can't be
    // reprocessed a second time.
    private val pendingActionNonces = ConcurrentHashMap<String, String>()
    private val secureRandom = SecureRandom()

    fun requestDir(context: Context): File =
        File(HomeInitializer.getHomeDir(context), ".shelly/agents/action-approvals").also { it.mkdirs() }

    fun replyDir(context: Context): File =
        File(HomeInitializer.getHomeDir(context), ".shelly/agents/action-approval-replies").also { it.mkdirs() }

    fun requestDirUri(context: Context): String = Uri.fromFile(requestDir(context)).toString()

    fun requestFile(context: Context, runId: String): File =
        File(requestDir(context), "action-${safeFilePart(runId)}.json")

    fun replyFile(context: Context, runId: String): File =
        File(replyDir(context), "action-${safeFilePart(runId)}.reply.json")

    fun notificationId(runId: String): Int =
        NOTIFICATION_ID_PREFIX or (stableHash("agent-action:$runId") and NOTIFICATION_ID_MASK)

    fun registerActionNonce(runId: String): String {
        val nonce = ByteArray(24)
        secureRandom.nextBytes(nonce)
        val encoded = Base64.encodeToString(nonce, Base64.NO_WRAP)
        pendingActionNonces[runId] = encoded
        return encoded
    }

    fun hasActionNonce(runId: String): Boolean = pendingActionNonces.containsKey(runId)

    fun anchorFromMap(raw: Map<String, Any?>): String? =
        raw["runId"]?.toString()?.trim()?.takeIf { it.isNotBlank() }

    fun fromRequestFile(context: Context, runId: String): AgentActionApprovalRequest? {
        return fromRequestFile(context, requestFile(context, runId))?.takeIf { it.runId == runId }
    }

    fun fromRequestFile(context: Context, requestFile: File): AgentActionApprovalRequest? {
        val request = requireCanonicalChild(requestFile, requestDir(context))
        if (!request.isFile) return null
        val bytes = request.readBytes()
        val json = JSONObject(bytes.toString(Charsets.UTF_8))
        val requestSha256 = sha256Hex(bytes)
        val parsed = fromJson(json, requestSha256) ?: return null
        val expected = requireCanonicalChild(requestFile(context, parsed.runId), requestDir(context))
        return parsed.takeIf { expected.path == request.path }
    }

    fun fromMap(raw: Map<String, Any?>): AgentActionApprovalRequest? {
        val json = JSONObject()
        for ((key, value) in raw) {
            if (value != null) json.put(key, value)
        }
        return fromJson(json, null)
    }

    fun toMap(request: AgentActionApprovalRequest): Map<String, Any?> = mapOf(
        "runId" to request.runId,
        "agentId" to request.agentId,
        "agentName" to request.agentName,
        "toolLabel" to request.toolLabel,
        "actionType" to request.actionType,
        "preview" to request.preview,
        "destinationHost" to request.destinationHost,
        "command" to request.command,
        "safetyLevel" to request.safetyLevel,
        "safetyReason" to request.safetyReason,
        "payloadPath" to request.payloadPath,
        "resultPath" to request.resultPath,
        "ts" to request.ts,
        "expiresAt" to request.expiresAt,
        "requestSha256" to request.requestSha256,
        "intentMode" to request.intentMode,
        "intentTarget" to request.intentTarget,
        "intentShareText" to request.intentShareText,
        "dmPairingId" to request.dmPairingId,
        "dmPairingLabel" to request.dmPairingLabel,
        "dmReplyText" to request.dmReplyText,
    )

    private fun fromJson(raw: JSONObject, requestSha256: String?): AgentActionApprovalRequest? {
        val runId = raw.optString("runId").trim().takeIf { it.isNotBlank() } ?: return null
        val actionType = raw.optString("actionType").trim().takeIf {
            it == "draft" || it == "notify" || it == "webhook" || it == "cli" || it == "intent" || it == "dm-reply"
        } ?: return null
        return AgentActionApprovalRequest(
            runId = runId,
            agentId = raw.optString("agentId").trim().takeIf { it.isNotBlank() } ?: "agent",
            agentName = raw.optString("agentName").trim().takeIf { it.isNotBlank() },
            toolLabel = raw.optString("toolLabel").trim().takeIf { it.isNotBlank() },
            actionType = actionType,
            preview = raw.optString("preview"),
            destinationHost = raw.optString("destinationHost").trim().takeIf { it.isNotBlank() },
            command = raw.optString("command").takeIf { it.isNotBlank() },
            safetyLevel = raw.optString("safetyLevel").trim().takeIf { it.isNotBlank() },
            safetyReason = raw.optString("safetyReason").trim().takeIf { it.isNotBlank() },
            payloadPath = raw.optString("payloadPath").trim().takeIf { it.isNotBlank() },
            resultPath = raw.optString("resultPath").trim().takeIf { it.isNotBlank() },
            ts = raw.optString("ts").trim().takeIf { it.isNotBlank() },
            expiresAt = raw.optLong("expiresAt").takeIf { it > 0L },
            requestSha256 = requestSha256,
            intentMode = raw.optString("intentMode").trim().takeIf { it.isNotBlank() },
            intentTarget = raw.optString("intentTarget").trim().takeIf { it.isNotBlank() },
            intentShareText = raw.optString("intentShareText").takeIf { it.isNotBlank() },
            dmPairingId = raw.optString("dmPairingId").trim().takeIf { it.isNotBlank() },
            dmPairingLabel = raw.optString("dmPairingLabel").trim().takeIf { it.isNotBlank() },
            dmReplyText = raw.optString("dmReplyText").takeIf { it.isNotBlank() }
        )
    }

    fun writeHumanReply(
        context: Context,
        runId: String,
        decision: String,
        expectedRequestSha256: String,
        actionNonce: String
    ): File {
        require(decision == "accept" || decision == "decline") { "invalid action decision" }
        val expectedNonce = pendingActionNonces[runId]
        val request = requireCanonicalChild(requestFile(context, runId), requestDir(context))
        require(request.isFile) { "action approval request is no longer pending" }
        val bytes = request.readBytes()
        val requestJson = JSONObject(bytes.toString(Charsets.UTF_8))
        require(requestJson.optString("runId") == runId) { "action approval anchor mismatch" }
        val requestSha256 = sha256Hex(bytes)
        require(expectedRequestSha256.matches(HEX_SHA256_RE) && requestSha256 == expectedRequestSha256) {
            "action approval no longer matches the displayed request"
        }
        val expiresAt = requestJson.optLong("expiresAt")
        require(expiresAt <= 0L || System.currentTimeMillis() <= expiresAt) { "action approval expired" }
        require(!expectedNonce.isNullOrBlank() && expectedNonce == actionNonce) {
            "action approval action is stale or unauthenticated"
        }
        require(pendingActionNonces.remove(runId, expectedNonce)) {
            "action approval action is stale or unauthenticated"
        }

        val reply = requireCanonicalChild(replyFile(context, runId), replyDir(context))
        reply.parentFile?.mkdirs()
        val tmp = File(reply.parentFile, ".${reply.name}.${android.os.Process.myPid()}.${System.nanoTime()}.tmp")
        val payload = JSONObject()
            .put("runId", runId)
            .put("decision", decision)
            .put("by", "human")
            .put("requestSha256", requestSha256)
            .put("ts", Instant.now().toString())
        tmp.writeText(payload.toString() + "\n")
        if (!tmp.renameTo(reply)) {
            tmp.delete()
            error("failed to publish action approval reply")
        }
        return reply
    }

    fun clearRequest(context: Context, runId: String) {
        runCatching { requireCanonicalChild(requestFile(context, runId), requestDir(context)).delete() }
    }

    private fun safeFilePart(value: String): String =
        unsafeFilePart.replace(value.take(160), "_").ifBlank { "request" }

    private fun requireCanonicalChild(file: File, parent: File): File {
        val canonicalParent = parent.canonicalFile
        val canonical = file.canonicalFile
        require(canonical.path == canonicalParent.path || canonical.path.startsWith(canonicalParent.path + File.separator)) {
            "path escapes action approval directory"
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
    private const val NOTIFICATION_ID_PREFIX = 0x31000000
    private const val NOTIFICATION_ID_MASK = 0x00ffffff
}
