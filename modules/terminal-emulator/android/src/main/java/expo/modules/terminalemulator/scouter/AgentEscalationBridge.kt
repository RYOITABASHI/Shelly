package expo.modules.terminalemulator.scouter

import android.content.Context
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.terminalemulator.HomeInitializer
import org.json.JSONObject
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.time.Instant
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

data class AgentEscalationRequest(
    val runId: String,
    val agentId: String,
    val reqId: String,
    val command: String,
    val commandSha256: String?,
    val workspaceRoot: String?,
    val cwd: String?,
    val reason: String?,
    val signals: List<String>,
    val level: String?,
    val ts: String?,
    val state: String?,
    val queuedAt: String?,
    val requestSha256: String?
) {
    val key: String get() = listOf(
        runId,
        reqId,
        ts.orEmpty(),
        state.orEmpty(),
        queuedAt.orEmpty(),
        requestSha256.orEmpty()
    ).joinToString("|")
}

object AgentEscalationBridge {
    private val unsafeFilePart = Regex("[^A-Za-z0-9_.=-]")
    private val pendingActionNonces = ConcurrentHashMap<String, String>()
    private val secureRandom = SecureRandom()

    fun requestDir(context: Context): File =
        File(HomeInitializer.getHomeDir(context), ".shelly/agents/escalations").also { it.mkdirs() }

    fun replyDir(context: Context): File =
        File(context.noBackupFilesDir, "shelly-agent-escalation-replies").also { it.mkdirs() }

    fun verifierPublicKeyFile(context: Context): File =
        File(context.noBackupFilesDir, "shelly-agent-escalation-public.der")

    fun preapprovalGrantFile(context: Context): File =
        File(context.noBackupFilesDir, "shelly-agent-preapproval-grants.jsonl")

    fun requestDirUri(context: Context): String = Uri.fromFile(requestDir(context)).toString()

    fun replyDirPath(context: Context): String = replyDir(context).absolutePath

    fun verifierPublicKeyPath(context: Context): String = ensureVerifierPublicKey(context).absolutePath

    fun preapprovalGrantFilePath(context: Context): String = preapprovalGrantFile(context).absolutePath

    fun requestFile(context: Context, runId: String, reqId: String): File =
        File(requestDir(context), "req-${safeFilePart(runId)}-${safeFilePart(reqId)}.json")

    fun replyFile(context: Context, runId: String, reqId: String): File =
        File(replyDir(context), "req-${safeFilePart(runId)}-${safeFilePart(reqId)}.reply.json")

    fun notificationId(runId: String, reqId: String): Int =
        NOTIFICATION_ID_BASE + (("$runId:$reqId".hashCode() and 0x7fffffff) % NOTIFICATION_ID_SPAN)

    fun registerActionNonce(runId: String, reqId: String): String {
        val nonce = ByteArray(24)
        secureRandom.nextBytes(nonce)
        val encoded = Base64.encodeToString(nonce, Base64.NO_WRAP)
        pendingActionNonces[actionNonceKey(runId, reqId)] = encoded
        return encoded
    }

    fun hasActionNonce(runId: String, reqId: String): Boolean =
        pendingActionNonces.containsKey(actionNonceKey(runId, reqId))

    fun anchorFromMap(raw: Map<String, Any?>): Pair<String, String>? {
        val runId = raw["runId"]?.toString()?.trim()?.takeIf { it.isNotBlank() } ?: return null
        val reqId = raw["reqId"]?.toString()?.trim()?.takeIf { it.isNotBlank() } ?: return null
        return runId to reqId
    }

    fun fromRequestFile(context: Context, runId: String, reqId: String): AgentEscalationRequest? {
        val request = requireCanonicalChild(requestFile(context, runId, reqId), requestDir(context))
        if (!request.isFile) return null
        val requestBytes = request.readBytes()
        val json = JSONObject(requestBytes.toString(Charsets.UTF_8))
        val requestSha256 = sha256Hex(requestBytes)
        return fromJson(json, requestSha256)?.takeIf {
            it.runId == runId && it.reqId == reqId
        }
    }

    fun fromMap(raw: Map<String, Any?>): AgentEscalationRequest? {
        val json = JSONObject()
        for ((key, value) in raw) {
            when (value) {
                null -> Unit
                is Iterable<*> -> json.put(key, org.json.JSONArray(value.toList()))
                else -> json.put(key, value)
            }
        }
        return fromJson(json, null)
    }

    private fun fromJson(raw: JSONObject, requestSha256: String?): AgentEscalationRequest? {
        val runId = raw.optString("runId").trim().takeIf { it.isNotBlank() } ?: return null
        val reqId = raw.optString("reqId").trim().takeIf { it.isNotBlank() } ?: return null
        val command = raw.optString("command").trim().takeIf { it.isNotBlank() } ?: return null
        val agentId = raw.optString("agentId").trim().takeIf { it.isNotBlank() } ?: "agent"
        val signals = jsonStringArray(raw.optJSONArray("signals"))
        return AgentEscalationRequest(
            runId = runId,
            agentId = agentId,
            reqId = reqId,
            command = command,
            commandSha256 = raw.optString("commandSha256").trim().takeIf { it.matches(HEX_SHA256_RE) },
            workspaceRoot = raw.optString("workspaceRoot").trim().takeIf { it.isNotBlank() },
            cwd = raw.optString("cwd").trim().takeIf { it.isNotBlank() },
            reason = raw.optString("reason").trim().takeIf { it.isNotBlank() },
            signals = signals,
            level = raw.optString("level").trim().takeIf { it.isNotBlank() },
            ts = raw.optString("ts").trim().takeIf { it.isNotBlank() },
            state = raw.optString("state").trim().takeIf { it.isNotBlank() },
            queuedAt = raw.optString("queuedAt").trim().takeIf { it.isNotBlank() },
            requestSha256 = requestSha256
        )
    }

    fun writeHumanReply(
        context: Context,
        runId: String,
        reqId: String,
        decision: String,
        actionNonce: String?,
        expectedRequestSha256: String?
    ): File {
        require(decision == "accept" || decision == "decline") { "invalid escalation decision" }
        val nonceKey = actionNonceKey(runId, reqId)
        val expectedNonce = pendingActionNonces[nonceKey]
        val request = requireCanonicalChild(requestFile(context, runId, reqId), requestDir(context))
        require(request.isFile) { "escalation request is no longer pending" }
        val requestBytes = request.readBytes()
        val requestJson = JSONObject(requestBytes.toString(Charsets.UTF_8))
        require(requestJson.optString("runId") == runId && requestJson.optString("reqId") == reqId) {
            "escalation request anchor mismatch"
        }
        val requestSha256 = sha256Hex(requestBytes)
        require(expectedRequestSha256?.matches(HEX_SHA256_RE) == true && requestSha256 == expectedRequestSha256) {
            "escalation approval action no longer matches the displayed request"
        }
        require(!expectedNonce.isNullOrBlank() && expectedNonce == actionNonce) {
            "escalation approval action is stale or unauthenticated"
        }
        require(pendingActionNonces.remove(nonceKey, expectedNonce)) {
            "escalation approval action is stale or unauthenticated"
        }
        val requestTs = requestJson.optString("ts")
        val signatureMessage = signatureMessage(runId, reqId, decision, requestTs, requestSha256)
        val signature = sign(signatureMessage)

        val reply = requireCanonicalChild(replyFile(context, runId, reqId), replyDir(context))
        reply.parentFile?.mkdirs()
        val tmp = File(reply.parentFile, ".${reply.name}.${android.os.Process.myPid()}.${System.nanoTime()}.tmp")
        val payload = JSONObject()
            .put("runId", runId)
            .put("reqId", reqId)
            .put("decision", decision)
            .put("by", "human")
            .put("requestSha256", requestSha256)
            .put("requestTs", requestTs)
            .put("sigAlg", SIGNATURE_ALGORITHM)
            .put("signature", signature)
            .put("ts", Instant.now().toString())
        tmp.writeText(payload.toString() + "\n")
        if (!tmp.renameTo(reply)) {
            tmp.delete()
            error("failed to publish escalation reply")
        }
        return reply
    }

    fun writePreapprovalGrantForQueuedRequest(
        context: Context,
        runId: String,
        reqId: String,
        expectedRequestSha256: String?,
        ttlMs: Long = DEFAULT_QUEUED_GRANT_TTL_MS
    ): File? {
        val request = requireCanonicalChild(requestFile(context, runId, reqId), requestDir(context))
        if (!request.isFile) return null
        val requestBytes = request.readBytes()
        val requestJson = JSONObject(requestBytes.toString(Charsets.UTF_8))
        val requestSha256 = sha256Hex(requestBytes)
        require(expectedRequestSha256?.matches(HEX_SHA256_RE) == true && requestSha256 == expectedRequestSha256) {
            "queued escalation request no longer matches the displayed request"
        }
        if (requestJson.optString("state") != "queued") return null
        require(requestJson.optString("runId") == runId && requestJson.optString("reqId") == reqId) {
            "queued escalation request anchor mismatch"
        }
        val command = requestJson.optString("command").takeIf { it.isNotBlank() } ?: return null
        val commandSha256 = requestJson.optString("commandSha256")
            .takeIf { it.matches(HEX_SHA256_RE) }
            ?: sha256Hex(command.toByteArray(Charsets.UTF_8))
        val agentId = requestJson.optString("agentId").takeIf { it.isNotBlank() } ?: "agent"
        val workspaceRoot = requestJson.optString("workspaceRoot").takeIf { it.isNotBlank() }
            ?: requestJson.optString("cwd").takeIf { it.isNotBlank() }
            ?: return null
        val signals = mutableListOf<String>()
        val rawSignals = requestJson.optJSONArray("signals")
        if (rawSignals != null) {
            for (i in 0 until rawSignals.length()) {
                rawSignals.optString(i).trim().takeIf { it.isNotBlank() }?.let { signals.add(it) }
            }
        }
        val createdAt = Instant.now()
        val expiresAt = createdAt.plusMillis(ttlMs.coerceAtLeast(1L))
        val requestTs = requestJson.optString("ts")
        val grant = JSONObject()
            .put("type", "grant")
            .put("id", UUID.randomUUID().toString())
            .put("agentId", agentId)
            .put("workspaceRoot", workspaceRoot)
            .put("commandSha256", commandSha256)
            .put("signals", org.json.JSONArray(signals))
            .put("expiresAt", expiresAt.toString())
            .put("createdAt", createdAt.toString())
            .put("requestSha256", requestSha256)
            .put("requestTs", requestTs)
            .put("usesRemaining", 1)
            .put("by", "human")
            .put("sigAlg", SIGNATURE_ALGORITHM)
        grant.put("signature", sign(preapprovalGrantSignatureMessage(grant)))

        val out = preapprovalGrantFile(context)
        out.parentFile?.mkdirs()
        out.appendText(grant.toString() + "\n")
        return out
    }

    fun clearRequest(context: Context, runId: String, reqId: String) {
        runCatching {
            requireCanonicalChild(requestFile(context, runId, reqId), requestDir(context)).delete()
        }
    }

    fun ensureVerifierPublicKey(context: Context): File {
        val publicKey = signingPublicKey()
        val out = verifierPublicKeyFile(context)
        out.parentFile?.mkdirs()
        val encoded = publicKey.encoded
        if (!out.isFile || !out.readBytes().contentEquals(encoded)) {
            val tmp = File(out.parentFile, ".${out.name}.${android.os.Process.myPid()}.${System.nanoTime()}.tmp")
            tmp.writeBytes(encoded)
            if (!tmp.renameTo(out)) {
                tmp.delete()
                error("failed to publish escalation verifier public key")
            }
        }
        return out
    }

    private fun safeFilePart(value: String): String =
        unsafeFilePart.replace(value, "_").take(160)

    private fun actionNonceKey(runId: String, reqId: String): String = "$runId:$reqId"

    private fun requireCanonicalChild(file: File, root: File): File {
        val canonicalRoot = root.canonicalFile
        val canonicalFile = file.canonicalFile
        require(canonicalFile.path == canonicalRoot.path || canonicalFile.path.startsWith(canonicalRoot.path + File.separator)) {
            "path escapes escalation bridge directory"
        }
        return canonicalFile
    }

    private fun signingPublicKey(): java.security.PublicKey {
        val keyStore = loadKeyStore()
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE)
            generator.initialize(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                )
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                    .setUserAuthenticationRequired(false)
                    .build()
            )
            generator.generateKeyPair()
        }
        return loadKeyStore().getCertificate(KEY_ALIAS).publicKey
    }

    private fun sign(message: String): String {
        ensureKeyExists()
        val keyStore = loadKeyStore()
        val entry = keyStore.getEntry(KEY_ALIAS, null) as KeyStore.PrivateKeyEntry
        val signer = Signature.getInstance(SIGNATURE_ALGORITHM)
        signer.initSign(entry.privateKey)
        signer.update(message.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
    }

    private fun ensureKeyExists() {
        signingPublicKey()
    }

    private fun loadKeyStore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun signatureMessage(
        runId: String,
        reqId: String,
        decision: String,
        requestTs: String,
        requestSha256: String
    ): String = listOf(runId, reqId, decision, requestTs, requestSha256).joinToString("\n")

    private fun preapprovalGrantSignatureMessage(grant: JSONObject): String = listOf(
        "shelly-agent-preapproval-grant-v1",
        grant.optString("id"),
        grant.optString("agentId"),
        grant.optString("workspaceRoot"),
        grant.optString("commandSha256"),
        jsonStringArray(grant.optJSONArray("signals")).sorted().joinToString(","),
        grant.optString("expiresAt"),
        grant.optString("createdAt"),
        grant.optString("requestSha256"),
        grant.optString("requestTs"),
        grant.optString("usesRemaining").ifBlank { "1" }
    ).joinToString("\n")

    private fun jsonStringArray(array: org.json.JSONArray?): List<String> {
        if (array == null) return emptyList()
        val out = mutableListOf<String>()
        for (i in 0 until array.length()) {
            array.optString(i).trim().takeIf { it.isNotBlank() }?.let { out.add(it) }
        }
        return out
    }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

    private const val NOTIFICATION_ID_BASE = 9400
    private const val NOTIFICATION_ID_SPAN = 500
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "shelly_agent_escalation_reply_v1"
    private const val SIGNATURE_ALGORITHM = "SHA256withRSA"
    private const val DEFAULT_QUEUED_GRANT_TTL_MS = 24L * 60L * 60L * 1000L
    private val HEX_SHA256_RE = Regex("^[0-9a-f]{64}$")
}
