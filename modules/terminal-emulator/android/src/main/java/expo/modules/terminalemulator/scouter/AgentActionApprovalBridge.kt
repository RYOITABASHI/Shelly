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
    val destinationHostAllowlisted: Boolean,
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
    val dmReplyText: String? = null,
    val appActRecipeId: String? = null,
    val appActParamsResolved: String? = null,
    /** Project owner directive 2026-07-14: true when the executor resolved
     *  the global/per-agent approval-mode default to 'auto' for this request
     *  (see requireActionApprovalTap / ACTION_APPROVAL_MODE). Consumed by RN
     *  (app/_layout.tsx's drainAgentActionApprovalRequests) for
     *  intent/dm-reply — the only two types that still always reach this
     *  bridge regardless of mode (they can only ever fire via RN) — to
     *  resolve the approval itself with no human tap, instead of surfacing
     *  the Review UI. Native does NOT act on this field; app-act's own
     *  narrower [autoFireTrusted] is the only flag native consumes. */
    val autoAccept: Boolean = false,
    /** app-act's OWN narrower Tier-B trust flag (docs/superpowers/DEFERRED.md,
     *  resolved 2026-07-14): true only when the executor's own
     *  trustedNativeLowRiskAction check passed (agent.autonomous===true AND
     *  tool.type==='local', the SAME registration-time consent draft/notify's
     *  existing native fast-path already required). Deliberately NOT the
     *  same signal as [autoAccept] — a wrong external post is not equivalent
     *  in risk to a local draft/CLI call. Consumed ONLY by
     *  AgentRuntime.kt's action-approval notifier for actionType=="app-act",
     *  which then fires AppActExecutor directly and writes an auto reply via
     *  [AgentActionApprovalBridge.writeAutoApprovedReply] — no human tap, no
     *  RN round trip. */
    val autoFireTrusted: Boolean = false
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
        "destinationHostAllowlisted" to request.destinationHostAllowlisted,
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
        "appActRecipeId" to request.appActRecipeId,
        "appActParamsResolved" to request.appActParamsResolved,
        "autoAccept" to request.autoAccept,
        "autoFireTrusted" to request.autoFireTrusted,
    )

    private fun fromJson(raw: JSONObject, requestSha256: String?): AgentActionApprovalRequest? {
        val runId = raw.optString("runId").trim().takeIf { it.isNotBlank() } ?: return null
        val actionType = raw.optString("actionType").trim().takeIf {
            it == "draft" || it == "notify" || it == "webhook" || it == "cli" || it == "intent" || it == "dm-reply" || it == "app-act"
        } ?: return null
        return AgentActionApprovalRequest(
            runId = runId,
            agentId = raw.optString("agentId").trim().takeIf { it.isNotBlank() } ?: "agent",
            agentName = raw.optString("agentName").trim().takeIf { it.isNotBlank() },
            toolLabel = raw.optString("toolLabel").trim().takeIf { it.isNotBlank() },
            actionType = actionType,
            preview = raw.optString("preview"),
            destinationHost = raw.optString("destinationHost").trim().takeIf { it.isNotBlank() },
            destinationHostAllowlisted = raw.optBoolean("destinationHostAllowlisted", false),
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
            dmReplyText = raw.optString("dmReplyText").takeIf { it.isNotBlank() },
            appActRecipeId = raw.optString("appActRecipeId").trim().takeIf { it.isNotBlank() },
            appActParamsResolved = raw.optString("appActParamsResolved").takeIf { it.isNotBlank() },
            autoAccept = raw.optBoolean("autoAccept", false),
            autoFireTrusted = raw.optBoolean("autoFireTrusted", false)
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

    /**
     * app-act Tier-B unattended-allow (docs/superpowers/DEFERRED.md, resolved
     * 2026-07-14). Writes an accept/decline reply for a request that was
     * NEVER disclosed to a human — the request's own `autoFireTrusted` field
     * (set by the executor from the SAME registration-time consent
     * draft/notify's native fast-path already required — see
     * trustedPlanLaunch/ACTION_APP_ACT_AUTO_FIRE_TRUSTED) is the trust
     * decision, made by the app's own executor script/plan, not by this
     * function. This intentionally bypasses the human-nonce dance
     * [writeHumanReply] enforces (registerActionNonce / pendingActionNonces)
     * — there is no PendingIntent/notification tap to bind a nonce to, and
     * requiring one here would make an internal native decision indistinguishable
     * from a spoofed human action. Still verifies the request is the CURRENT
     * one on disk (matching requestSha256, not expired) so a stale/superseded
     * request can never be auto-resolved. Caller (AgentRuntime.kt's
     * action-approval notifier) MUST have already fired the recipe (on
     * accept) before calling this, mirroring the RN accept handler's
     * "fire-then-reply" invariant.
     */
    fun writeAutoApprovedReply(
        context: Context,
        runId: String,
        decision: String,
        expectedRequestSha256: String
    ): File {
        require(decision == "accept" || decision == "decline") { "invalid action decision" }
        val request = requireCanonicalChild(requestFile(context, runId), requestDir(context))
        require(request.isFile) { "action approval request is no longer pending" }
        val bytes = request.readBytes()
        val requestJson = JSONObject(bytes.toString(Charsets.UTF_8))
        require(requestJson.optString("runId") == runId) { "action approval anchor mismatch" }
        require(requestJson.optString("actionType") == "app-act") { "auto-fire reply is only valid for app-act" }
        require(requestJson.optBoolean("autoFireTrusted", false)) { "request was not marked autoFireTrusted" }
        val requestSha256 = sha256Hex(bytes)
        require(requestSha256 == expectedRequestSha256) {
            "action approval no longer matches the trusted request read"
        }
        val expiresAt = requestJson.optLong("expiresAt")
        require(expiresAt <= 0L || System.currentTimeMillis() <= expiresAt) { "action approval expired" }

        val reply = requireCanonicalChild(replyFile(context, runId), replyDir(context))
        reply.parentFile?.mkdirs()
        val tmp = File(reply.parentFile, ".${reply.name}.${android.os.Process.myPid()}.${System.nanoTime()}.tmp")
        val payload = JSONObject()
            .put("runId", runId)
            .put("decision", decision)
            .put("by", "auto")
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
