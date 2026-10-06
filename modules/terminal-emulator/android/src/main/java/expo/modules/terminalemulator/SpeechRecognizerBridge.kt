package expo.modules.terminalemulator

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

/**
 * SpeechRecognizerBridge — keyless, free, on-device speech-to-text.
 *
 * Uses the platform's ON-DEVICE recognition service
 * (SpeechRecognizer.createOnDeviceSpeechRecognizer, API 31+; on Pixel /
 * Galaxy builds with Google's Android System Intelligence this is
 * com.google.android.as/.AiAiSpeechRecognitionService). Audio never leaves
 * the device and no API key is needed — this is the default STT route
 * whenever no Groq key is configured (see lib/stt-provider.ts).
 *
 * minSdk stays 24: every API-31+/33+ call is behind a runtime SDK_INT guard
 * and older devices just report `available: false` (JS then falls back to
 * the existing "Groq key required" error).
 *
 * Push-to-talk semantics: the platform recognizer ends a session on its own
 * after a pause in speech, but the JS hook (use-speech-input / use-voice-chat)
 * is press-to-start / press-to-stop. To bridge the two, a session here
 * auto-restarts listening after each segment (or after a silence timeout)
 * and accumulates the finalized segments, until JS calls stop() — then the
 * full accumulated text is delivered as one `onSttFinal` event. A hard cap
 * (MAX_SESSION_MS / MAX_RESTARTS) ends a forgotten session on its own.
 * EXTRA_SEGMENTED_SESSION (API 33) would do this natively, but its support
 * in third-party on-device services is not guaranteed, so restart is used.
 *
 * All SpeechRecognizer calls happen on the main thread (platform
 * requirement); results are emitted through the Expo module's sendEvent.
 * Every event carries the JS-supplied sessionId so a late event from a torn
 * down session can be ignored on the JS side.
 *
 * logcat tag: ShellySTT
 */
object SpeechRecognizerBridge {
    private const val TAG = "ShellySTT"
    private const val MAX_SESSION_MS = 120_000L
    private const val MAX_RESTARTS = 60
    private const val STOP_FALLBACK_MS = 4_000L
    private const val SUPPORT_CHECK_TIMEOUT_MS = 5_000L
    private const val RESTART_DELAY_MS = 80L

    // Raw SpeechRecognizer error codes (some constants are API 31+, use ints
    // so lint never trips on an older compile target).
    private const val ERR_NETWORK_TIMEOUT = 1
    private const val ERR_NETWORK = 2
    private const val ERR_AUDIO = 3
    private const val ERR_SERVER = 4
    private const val ERR_CLIENT = 5
    private const val ERR_SPEECH_TIMEOUT = 6
    private const val ERR_NO_MATCH = 7
    private const val ERR_BUSY = 8
    private const val ERR_PERMISSION = 9
    private const val ERR_TOO_MANY_REQUESTS = 10
    private const val ERR_SERVER_DISCONNECTED = 11
    private const val ERR_LANGUAGE_NOT_SUPPORTED = 12
    private const val ERR_LANGUAGE_UNAVAILABLE = 13

    private val main = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor { main.post(it) }

    // Session state — touched on the main thread only.
    private var recognizer: SpeechRecognizer? = null
    private var generation = 0
    private var sessionId: String? = null
    private var language: String = "ja-JP"
    private var stopRequested = false
    private val committed = StringBuilder()
    private var currentPartial = ""
    private var restarts = 0
    private var restartPending = false
    private var emit: ((String, Map<String, Any?>) -> Unit)? = null
    private var maxDurationRunnable: Runnable? = null
    private var stopFallbackRunnable: Runnable? = null

    @Volatile
    private var lastLanguageStatus: String = "unknown"

    fun isSupportedSdk(): Boolean = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S

    private fun onDeviceAvailable(context: Context): Boolean {
        if (!isSupportedSdk()) return false
        return try {
            SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        } catch (t: Throwable) {
            Log.w(TAG, "isOnDeviceRecognitionAvailable threw", t)
            false
        }
    }

    private fun hasMicPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED

    private fun buildIntent(context: Context, lang: String): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            // Hints only — many services ignore them; the restart loop is
            // what actually keeps a push-to-talk session alive.
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L)
            putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L)
        }

    private fun languageMatches(list: List<String>?, lang: String): Boolean {
        if (list.isNullOrEmpty()) return false
        val norm = lang.replace('_', '-')
        if (list.any { it.replace('_', '-').equals(norm, ignoreCase = true) }) return true
        val base = norm.substringBefore('-')
        return list.any { it.replace('_', '-').substringBefore('-').equals(base, ignoreCase = true) }
    }

    // ─── Status ──────────────────────────────────────────────────────────────

    /**
     * Reports on-device STT availability:
     *   available      — the on-device service exists (API 31+)
     *   languageStatus — installed | pending | downloadable | unsupported | unknown
     *                    (API 33+ checkRecognitionSupport; 'unknown' below 33
     *                    or when the service doesn't answer in time)
     *   reason         — why available=false (sdk_too_old | service_unavailable)
     *   micPermission  — RECORD_AUDIO granted
     * Never throws; always calls [callback] exactly once.
     */
    fun getStatus(context: Context, lang: String, callback: (Map<String, Any?>) -> Unit) {
        val base = mutableMapOf<String, Any?>(
            "sdkInt" to Build.VERSION.SDK_INT,
            "language" to lang,
            "micPermission" to hasMicPermission(context),
        )
        if (!isSupportedSdk()) {
            callback(base + mapOf("available" to false, "reason" to "sdk_too_old", "languageStatus" to "unknown"))
            return
        }
        if (!onDeviceAvailable(context)) {
            callback(base + mapOf("available" to false, "reason" to "service_unavailable", "languageStatus" to "unknown"))
            return
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            callback(base + mapOf("available" to true, "languageStatus" to "unknown"))
            return
        }
        main.post {
            // Don't spin up a second recognizer while a session owns the mic.
            if (recognizer != null) {
                callback(base + mapOf("available" to true, "languageStatus" to lastLanguageStatus))
                return@post
            }
            checkSupport33(context, lang) { status ->
                lastLanguageStatus = status
                callback(base + mapOf("available" to true, "languageStatus" to status))
            }
        }
    }

    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private fun checkSupport33(context: Context, lang: String, done: (String) -> Unit) {
        val once = AtomicBoolean(false)
        var probe: SpeechRecognizer? = null
        fun finish(status: String) {
            if (!once.compareAndSet(false, true)) return
            main.post {
                try { probe?.destroy() } catch (_: Throwable) {}
                probe = null
            }
            Log.i(TAG, "checkRecognitionSupport($lang) -> $status")
            done(status)
        }
        try {
            probe = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            probe!!.checkRecognitionSupport(
                buildIntent(context, lang),
                mainExecutor,
                object : RecognitionSupportCallback {
                    @Suppress("DEPRECATION")
                    override fun onSupportResult(support: RecognitionSupport) {
                        // API 34 renamed the lists (*OnDeviceLanguages); the
                        // API 33 getters are deprecated but still the only
                        // ones that exist on Android 13.
                        val installed: List<String>
                        val pending: List<String>
                        val supported: List<String>
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                            installed = support.installedOnDeviceLanguages
                            pending = support.pendingOnDeviceLanguages
                            supported = support.supportedOnDeviceLanguages
                        } else {
                            installed = support.installedLanguages
                            pending = support.pendingLanguages
                            supported = support.supportedLanguages
                        }
                        val status = when {
                            languageMatches(installed, lang) -> "installed"
                            languageMatches(pending, lang) -> "pending"
                            languageMatches(supported, lang) -> "downloadable"
                            else -> "unsupported"
                        }
                        finish(status)
                    }

                    override fun onError(error: Int) {
                        Log.w(TAG, "checkRecognitionSupport error=$error")
                        finish("unknown")
                    }
                },
            )
            main.postDelayed({ finish("unknown") }, SUPPORT_CHECK_TIMEOUT_MS)
        } catch (t: Throwable) {
            Log.w(TAG, "checkRecognitionSupport threw", t)
            finish("unknown")
        }
    }

    /**
     * Asks the on-device service to download the language model (API 33+).
     * Returns false when unsupported. The service shows its own progress UI /
     * notification; JS re-polls getStatus afterwards.
     */
    fun triggerModelDownload(context: Context, lang: String): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return false
        if (!onDeviceAvailable(context)) return false
        main.post {
            try {
                val r = SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
                r.triggerModelDownload(buildIntent(context, lang))
                Log.i(TAG, "triggerModelDownload($lang) requested")
                // Give the request time to reach the service before unbinding.
                main.postDelayed({ try { r.destroy() } catch (_: Throwable) {} }, 10_000L)
            } catch (t: Throwable) {
                Log.w(TAG, "triggerModelDownload threw", t)
            }
        }
        return true
    }

    // ─── Session ─────────────────────────────────────────────────────────────

    fun start(
        context: Context,
        id: String,
        lang: String,
        onEvent: (String, Map<String, Any?>) -> Unit,
    ) {
        main.post { startOnMain(context.applicationContext, id, lang, onEvent) }
    }

    private fun startOnMain(
        context: Context,
        id: String,
        lang: String,
        onEvent: (String, Map<String, Any?>) -> Unit,
    ) {
        // Supersede any previous session silently (JS ignores its events).
        teardown("superseded")

        fun fail(code: String, message: String) {
            Log.w(TAG, "start($id) failed: $code $message")
            onEvent("onSttError", mapOf("sessionId" to id, "code" to code, "message" to message))
        }
        if (!isSupportedSdk()) return fail("unsupported", "on-device recognition needs Android 12+")
        if (!hasMicPermission(context)) return fail("permission", "RECORD_AUDIO not granted")
        if (!onDeviceAvailable(context)) return fail("unavailable", "no on-device recognition service")

        val rec = try {
            SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
        } catch (t: Throwable) {
            return fail("unavailable", t.message ?: "createOnDeviceSpeechRecognizer failed")
        }

        generation += 1
        val gen = generation
        recognizer = rec
        sessionId = id
        language = lang
        stopRequested = false
        committed.setLength(0)
        currentPartial = ""
        restarts = 0
        restartPending = false
        emit = onEvent

        val intent = buildIntent(context, lang)
        rec.setRecognitionListener(SessionListener(gen, intent))
        try {
            rec.startListening(intent)
        } catch (t: Throwable) {
            teardown("start threw")
            return fail("client", t.message ?: "startListening failed")
        }
        maxDurationRunnable = Runnable {
            Log.i(TAG, "session $id hit MAX_SESSION_MS — stopping")
            requestStopOnMain(id)
        }.also { main.postDelayed(it, MAX_SESSION_MS) }
        Log.i(TAG, "session $id started lang=$lang")
    }

    fun stop(id: String) {
        main.post { requestStopOnMain(id) }
    }

    private fun requestStopOnMain(id: String) {
        if (sessionId != id || recognizer == null) {
            Log.i(TAG, "stop($id) ignored — active=$sessionId")
            return
        }
        if (stopRequested) return
        stopRequested = true
        if (restartPending) {
            // Between segments — nothing is listening, so nothing would
            // ever answer stopListening(). Deliver the accumulated text now.
            finish()
            return
        }
        try {
            recognizer?.stopListening()
        } catch (t: Throwable) {
            Log.w(TAG, "stopListening threw", t)
            finish()
            return
        }
        // Fail-closed: some services never deliver onResults after
        // stopListening (e.g. stopped between restarts). Deliver what we have.
        stopFallbackRunnable = Runnable {
            Log.i(TAG, "session $id: no result ${STOP_FALLBACK_MS}ms after stop — finishing")
            finish()
        }.also { main.postDelayed(it, STOP_FALLBACK_MS) }
    }

    fun cancel(id: String?) {
        main.post {
            if (id != null && sessionId != id) return@post
            teardown("cancel")
        }
    }

    fun isActive(): Boolean = recognizer != null

    private fun separator(): String {
        val base = language.substringBefore('-').lowercase()
        return if (base == "ja" || base == "zh") "" else " "
    }

    private fun accumulated(includePartial: Boolean): String {
        val sb = StringBuilder(committed)
        if (includePartial && currentPartial.isNotBlank()) {
            if (sb.isNotEmpty()) sb.append(separator())
            sb.append(currentPartial.trim())
        }
        return sb.toString().trim()
    }

    private fun finish() {
        val id = sessionId ?: return
        val text = accumulated(includePartial = true)
        val sink = emit
        teardown("finish")
        Log.i(TAG, "session $id final len=${text.length}")
        sink?.invoke("onSttFinal", mapOf("sessionId" to id, "text" to text))
    }

    private fun failSession(code: String, message: String) {
        val id = sessionId ?: return
        // Keep real recognized text if we have any — losing a long dictation
        // to a late audio/server hiccup is worse than delivering it.
        if (accumulated(includePartial = true).isNotEmpty()) {
            Log.w(TAG, "session $id error $code with text — delivering as final")
            finish()
            return
        }
        val sink = emit
        teardown("error $code")
        Log.w(TAG, "session $id error $code: $message")
        sink?.invoke("onSttError", mapOf("sessionId" to id, "code" to code, "message" to message))
    }

    private fun teardown(why: String) {
        maxDurationRunnable?.let { main.removeCallbacks(it) }
        stopFallbackRunnable?.let { main.removeCallbacks(it) }
        maxDurationRunnable = null
        stopFallbackRunnable = null
        val rec = recognizer ?: return
        recognizer = null
        generation += 1 // invalidate the old listener
        try { rec.cancel() } catch (_: Throwable) {}
        try { rec.destroy() } catch (_: Throwable) {}
        Log.i(TAG, "session $sessionId torn down ($why)")
        sessionId = null
        emit = null
        committed.setLength(0)
        currentPartial = ""
        restartPending = false
    }

    private fun restartOrFinish(intent: Intent) {
        if (stopRequested || restarts >= MAX_RESTARTS) {
            finish()
            return
        }
        restarts += 1
        val gen = generation
        restartPending = true
        // Small gap: restarting synchronously inside onResults/onError trips
        // ERROR_RECOGNIZER_BUSY on some services.
        main.postDelayed({
            if (gen != generation) return@postDelayed
            restartPending = false
            if (stopRequested) {
                finish()
                return@postDelayed
            }
            val rec = recognizer ?: return@postDelayed
            try {
                rec.startListening(intent)
            } catch (t: Throwable) {
                Log.w(TAG, "restart startListening threw", t)
                failSession("client", t.message ?: "restart failed")
            }
        }, RESTART_DELAY_MS)
    }

    private fun mapError(code: Int): String = when (code) {
        ERR_PERMISSION -> "permission"
        ERR_LANGUAGE_NOT_SUPPORTED, ERR_LANGUAGE_UNAVAILABLE -> "language_unavailable"
        ERR_NETWORK, ERR_NETWORK_TIMEOUT, ERR_SERVER, ERR_SERVER_DISCONNECTED -> "service"
        ERR_BUSY, ERR_TOO_MANY_REQUESTS -> "busy"
        ERR_AUDIO -> "audio"
        ERR_NO_MATCH, ERR_SPEECH_TIMEOUT -> "no_match"
        ERR_CLIENT -> "client"
        else -> "error_$code"
    }

    private class SessionListener(private val gen: Int, private val intent: Intent) : RecognitionListener {
        private fun live(): Boolean = gen == generation && recognizer != null

        override fun onReadyForSpeech(params: Bundle?) {
            if (!live()) return
            Log.d(TAG, "onReadyForSpeech (restarts=$restarts)")
        }

        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {}
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() {}
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partialResults: Bundle?) {
            if (!live()) return
            val text = partialResults
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()
                .orEmpty()
            currentPartial = text
            val id = sessionId ?: return
            emit?.invoke("onSttPartial", mapOf("sessionId" to id, "text" to accumulated(includePartial = true)))
        }

        override fun onResults(results: Bundle?) {
            if (!live()) return
            val text = results
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()
                ?.trim()
                .orEmpty()
            if (text.isNotEmpty()) {
                if (committed.isNotEmpty()) committed.append(separator())
                committed.append(text)
            }
            currentPartial = ""
            val id = sessionId ?: return
            if (!stopRequested) {
                emit?.invoke("onSttPartial", mapOf("sessionId" to id, "text" to accumulated(includePartial = false)))
            }
            restartOrFinish(intent)
        }

        override fun onError(error: Int) {
            if (!live()) return
            val code = mapError(error)
            Log.d(TAG, "onError raw=$error ($code) stopRequested=$stopRequested restarts=$restarts")
            when {
                // Silence / nothing recognized in this segment: keep the
                // push-to-talk session alive, or close it out after stop().
                code == "no_match" -> restartOrFinish(intent)
                // ERROR_CLIENT right after stopListening is a normal shutdown
                // artifact on several services.
                stopRequested && code == "client" -> finish()
                else -> failSession(code, "SpeechRecognizer error $error")
            }
        }
    }
}
