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
import java.util.concurrent.ConcurrentHashMap

data class AgentEscalationRequest(
    val runId: String,
    val agentId: String,
    val reqId: String,
    val command: String,
    val cwd: String?,
    val reason: String?,
    val signals: List<String>,
    val level: String?,
    val ts: String?
) {
    val key: String get() = "$runId|$reqId|${ts.orEmpty()}"
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

    fun requestDirUri(context: Context): String = Uri.fromFile(requestDir(context)).toString()

    fun replyDirPath(context: Context): String = replyDir(context).absolutePath

    fun verifierPublicKeyPath(context: Context): String = ensureVerifierPublicKey(context).absolutePath

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

    fun fromMap(raw: Map<String, Any?>): AgentEscalationRequest? {
        val runId = raw["runId"]?.toString()?.trim()?.takeIf { it.isNotBlank() } ?: return null
        val reqId = raw["reqId"]?.toString()?.trim()?.takeIf { it.isNotBlank() } ?: return null
        val command = raw["command"]?.toString()?.trim()?.takeIf { it.isNotBlank() } ?: return null
        val agentId = raw["agentId"]?.toString()?.trim()?.takeIf { it.isNotBlank() } ?: "agent"
        val signals = (raw["signals"] as? Iterable<*>)
            ?.mapNotNull { it?.toString()?.trim()?.takeIf { value -> value.isNotBlank() } }
            ?: emptyList()
        return AgentEscalationRequest(
            runId = runId,
            agentId = agentId,
            reqId = reqId,
            command = command,
            cwd = raw["cwd"]?.toString()?.trim()?.takeIf { it.isNotBlank() },
            reason = raw["reason"]?.toString()?.trim()?.takeIf { it.isNotBlank() },
            signals = signals,
            level = raw["level"]?.toString()?.trim()?.takeIf { it.isNotBlank() },
            ts = raw["ts"]?.toString()?.trim()?.takeIf { it.isNotBlank() }
        )
    }

    fun writeHumanReply(context: Context, runId: String, reqId: String, decision: String, actionNonce: String?): File {
        require(decision == "accept" || decision == "decline") { "invalid escalation decision" }
        val nonceKey = actionNonceKey(runId, reqId)
        val expectedNonce = pendingActionNonces.remove(nonceKey)
        require(!expectedNonce.isNullOrBlank() && expectedNonce == actionNonce) {
            "escalation approval action is stale or unauthenticated"
        }
        val request = requireCanonicalChild(requestFile(context, runId, reqId), requestDir(context))
        require(request.isFile) { "escalation request is no longer pending" }
        val requestBytes = request.readBytes()
        val requestJson = JSONObject(requestBytes.toString(Charsets.UTF_8))
        require(requestJson.optString("runId") == runId && requestJson.optString("reqId") == reqId) {
            "escalation request anchor mismatch"
        }
        val requestSha256 = sha256Hex(requestBytes)
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

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

    private const val NOTIFICATION_ID_BASE = 9400
    private const val NOTIFICATION_ID_SPAN = 500
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "shelly_agent_escalation_reply_v1"
    private const val SIGNATURE_ALGORITHM = "SHA256withRSA"
}
