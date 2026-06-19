package expo.modules.terminalemulator.scouter

import android.content.Context
import android.net.Uri
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import expo.modules.terminalemulator.HomeInitializer
import org.json.JSONObject
import java.io.File
import java.security.KeyFactory
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

data class AgentEscalationReplyResult(
    val reply: File,
    val preapprovalGrant: File?
)

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

    fun verifierPublicKeySha256(context: Context): String =
        sha256Hex(ensureVerifierPublicKey(context).readBytes())

    fun preapprovalGrantFilePath(context: Context): String = preapprovalGrantFile(context).absolutePath

    fun requestFile(context: Context, runId: String, reqId: String): File =
        File(requestDir(context), "req-${safeFilePart(runId)}-${safeFilePart(reqId)}.json")

    fun replyFile(context: Context, runId: String, reqId: String): File =
        File(replyDir(context), "req-${safeFilePart(runId)}-${safeFilePart(reqId)}.reply.json")

    fun grantSpendReplyFile(context: Context, grantId: String, reqId: String): File =
        File(replyDir(context), "grant-spend-${safeFilePart(grantId)}-${safeFilePart(reqId)}.reply.json")

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
    ): AgentEscalationReplyResult {
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
        val preapprovalGrant = if (decision == "accept") {
            writePreapprovalGrantFromRequest(
                context = context,
                requestJson = requestJson,
                requestSha256 = requestSha256,
                allowLiveRequest = true,
                requireHardwareOneShot = true
            )
        } else {
            null
        }
        return AgentEscalationReplyResult(reply, preapprovalGrant)
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
        require(requestJson.optString("runId") == runId && requestJson.optString("reqId") == reqId) {
            "queued escalation request anchor mismatch"
        }
        return writePreapprovalGrantFromRequest(
            context = context,
            requestJson = requestJson,
            requestSha256 = requestSha256,
            allowLiveRequest = false,
            requireHardwareOneShot = false,
            ttlMs = ttlMs
        )
    }

    private fun writePreapprovalGrantFromRequest(
        context: Context,
        requestJson: JSONObject,
        requestSha256: String,
        allowLiveRequest: Boolean,
        requireHardwareOneShot: Boolean,
        ttlMs: Long = DEFAULT_QUEUED_GRANT_TTL_MS
    ): File? {
        val state = requestJson.optString("state")
        if (state.isNotBlank() && state != "queued") return null
        if (!allowLiveRequest && state != "queued") return null
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
        val usesRemaining = 1
        val grantId = UUID.randomUUID().toString()
        val replayDangerous = isReplayDangerousSignals(signals)
        val requiresGrantKey = requireHardwareOneShot || replayDangerous
        val grantKey = if (requiresGrantKey) {
            createStrongBoxGrantKey(grantId, usesRemaining)
        } else {
            null
        }
        if (requiresGrantKey && grantKey == null) {
            return null
        }
        val grantKeyMode = if (grantKey != null) "keystore-maxuse" else "expiry-only"
        val grant = JSONObject()
            .put("type", "grant")
            .put("id", grantId)
            .put("agentId", agentId)
            .put("workspaceRoot", workspaceRoot)
            .put("commandSha256", commandSha256)
            .put("signals", org.json.JSONArray(signals))
            .put("expiresAt", expiresAt.toString())
            .put("createdAt", createdAt.toString())
            .put("requestSha256", requestSha256)
            .put("requestTs", requestTs)
            .put("usesRemaining", usesRemaining)
            .put("grantKeyMode", grantKeyMode)
            .put("by", "human")
            .put("sigAlg", SIGNATURE_ALGORITHM)
        if (grantKey != null) {
            grant
                .put("grantKeyAlias", grantKey.first)
                .put("grantKeySpki", Base64.encodeToString(grantKey.second.encoded, Base64.NO_WRAP))
        }
        grant.put("signature", sign(preapprovalGrantSignatureMessage(grant)))

        val out = preapprovalGrantFile(context)
        out.parentFile?.mkdirs()
        out.appendText(grant.toString() + "\n")
        return out
    }

    fun writeGrantSpendReply(context: Context, raw: Map<String, Any?>): File {
        val grantId = raw["grantId"]?.toString()?.trim()?.takeIf { it.isNotBlank() }
            ?: error("missing grantId")
        val reqId = raw["reqId"]?.toString()?.trim()?.takeIf { it.isNotBlank() }
            ?: error("missing reqId")
        val requestSha256 = raw["requestSha256"]?.toString()?.trim()?.takeIf { it.matches(HEX_SHA256_RE) }
            ?: error("invalid requestSha256")
        val reply = requireCanonicalChild(grantSpendReplyFile(context, grantId, reqId), replyDir(context))
        reply.parentFile?.mkdirs()
        val alias = grantKeyAlias(grantId)
        val payload = try {
            if (!loadKeyStore().containsAlias(alias)) {
                grantSpendDenied(grantId, reqId, "unknown")
            } else {
                val ts = Instant.now().toString()
                val message = grantUseReceiptMessage(grantId, reqId, requestSha256, ts)
                JSONObject()
                    .put("type", "grant_use_receipt")
                    .put("grantId", grantId)
                    .put("reqId", reqId)
                    .put("requestSha256", requestSha256)
                    .put("ts", ts)
                    .put("sigAlg", SIGNATURE_ALGORITHM)
                    .put("signature", signWithAlias(alias, message))
            }
        } catch (error: Throwable) {
            grantSpendDenied(grantId, reqId, grantSpendDenyReason(error))
        }
        writeJsonAtomic(reply, payload)
        return reply
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
        return signWithAlias(KEY_ALIAS, message)
    }

    private fun signWithAlias(alias: String, message: String): String {
        ensureKeyExists()
        val keyStore = loadKeyStore()
        val entry = keyStore.getEntry(alias, null) as KeyStore.PrivateKeyEntry
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
        "shelly-agent-preapproval-grant-v2",
        grant.optString("id"),
        grant.optString("agentId"),
        grant.optString("workspaceRoot"),
        grant.optString("commandSha256"),
        jsonStringArray(grant.optJSONArray("signals")).sorted().joinToString(","),
        grant.optString("expiresAt"),
        grant.optString("createdAt"),
        grant.optString("requestSha256"),
        grant.optString("requestTs"),
        grant.optString("usesRemaining").ifBlank { "1" },
        grant.optString("grantKeyMode"),
        grant.optString("grantKeySpki").takeIf { it.isNotBlank() }?.let {
            sha256Hex(it.toByteArray(Charsets.UTF_8))
        } ?: ""
    ).joinToString("\n")

    private fun grantUseReceiptMessage(
        grantId: String,
        reqId: String,
        requestSha256: String,
        ts: String
    ): String = listOf(grantId, reqId, requestSha256, ts).joinToString("\n")

    private fun isReplayDangerousSignals(signals: List<String>): Boolean {
        val set = signals.toSet()
        return set.contains("network-send") || (set.contains("leaves-root") && set.contains("write-or-exec"))
    }

    private fun createStrongBoxGrantKey(grantId: String, usesRemaining: Int): Pair<String, java.security.PublicKey>? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        val alias = grantKeyAlias(grantId)
        return try {
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE)
            generator.initialize(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY
                )
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                    .setUserAuthenticationRequired(false)
                    .setIsStrongBoxBacked(true)
                    .setMaxUsageCount(usesRemaining.coerceAtLeast(1))
                    .build()
            )
            val pair = generator.generateKeyPair()
            val keyStore = loadKeyStore()
            val entry = keyStore.getEntry(alias, null) as KeyStore.PrivateKeyEntry
            val keyInfo = KeyFactory.getInstance(entry.privateKey.algorithm, ANDROID_KEYSTORE)
                .getKeySpec(entry.privateKey, KeyInfo::class.java) as KeyInfo
            if (!keyInfo.isInsideSecureHardware) {
                keyStore.deleteEntry(alias)
                null
            } else {
                alias to pair.public
            }
        } catch (_: StrongBoxUnavailableException) {
            null
        } catch (_: Throwable) {
            runCatching { loadKeyStore().deleteEntry(alias) }
            null
        }
    }

    private fun grantKeyAlias(grantId: String): String =
        "$GRANT_KEY_ALIAS_PREFIX${safeFilePart(grantId)}"

    private fun grantSpendDenied(grantId: String, reqId: String, reason: String): JSONObject =
        JSONObject()
            .put("type", "grant_spend_denied")
            .put("grantId", grantId)
            .put("reqId", reqId)
            .put("reason", reason)
            .put("ts", Instant.now().toString())

    private fun grantSpendDenyReason(error: Throwable): String {
        val text = (error.message ?: error.javaClass.simpleName).lowercase()
        return when {
            "exhaust" in text || "max" in text || "usage" in text -> "exhausted"
            "expire" in text -> "expired"
            else -> "error"
        }
    }

    private fun writeJsonAtomic(file: File, payload: JSONObject) {
        val tmp = File(file.parentFile, ".${file.name}.${android.os.Process.myPid()}.${System.nanoTime()}.tmp")
        tmp.writeText(payload.toString() + "\n")
        if (!tmp.renameTo(file)) {
            tmp.delete()
            error("failed to publish ${file.name}")
        }
    }

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
    private const val GRANT_KEY_ALIAS_PREFIX = "shelly_agent_grant_use_v1_"
    private const val SIGNATURE_ALGORITHM = "SHA256withRSA"
    private const val DEFAULT_QUEUED_GRANT_TTL_MS = 24L * 60L * 60L * 1000L
    private val HEX_SHA256_RE = Regex("^[0-9a-f]{64}$")
}
