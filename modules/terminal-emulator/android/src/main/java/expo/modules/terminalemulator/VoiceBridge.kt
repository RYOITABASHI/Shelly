package expo.modules.terminalemulator

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * VoiceBridge — full-duplex realtime voice via the Gemini Live API.
 *
 * Spawns scripts/shelly-gemini-live-client.js (mirrored to
 * $HOME/.shelly-gemini-live-client.js by HomeInitializer, same pattern as
 * the capability broker / plan executor) as a live-piped child process —
 * `ProcessBuilder` + `/system/bin/linker64`, the exact pattern already
 * proven working in TerminalEmulatorModule.kt's forceRecoverFromFrozenState
 * diagnostic (see its "Linker64 Trick" step) — rather than the JNI
 * `ShellyJNI.execSubprocess` path used everywhere else in this app, which
 * only returns a completed process's full stdout/stderr and has no concept
 * of a long-lived process with continuously piped I/O. A voice session
 * needs exactly that: mic PCM streamed in and speaker PCM streamed out for
 * the whole conversation, not a single request/response.
 *
 * Three threads run for the life of a session:
 *   - mic capture:  AudioRecord (16kHz/mono/PCM16) -> process stdin
 *   - playback:     process stdout -> AudioTrack (24kHz/mono/PCM16)
 *   - control:      process stderr (JSON lines) -> onEvent callback
 *
 * On an "interrupted" event (the server detected the user talking over the
 * model — see the script's own header), the playback thread flushes
 * AudioTrack immediately so any already-queued model audio stops sounding
 * right away instead of draining out over the next second or two.
 */
object VoiceBridge {
    private const val TAG = "VoiceBridge"
    private const val SAMPLE_RATE_IN = 16000
    private const val SAMPLE_RATE_OUT = 24000

    private var process: Process? = null
    private var micThread: Thread? = null
    private var playbackThread: Thread? = null
    private var controlThread: Thread? = null
    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private var focusListener: AudioManager.OnAudioFocusChangeListener? = null
    private val running = AtomicBoolean(false)
    private val interrupted = AtomicBoolean(false)

    fun isRunning(): Boolean = running.get()

    @Synchronized
    fun start(
        context: Context,
        apiKey: String,
        onEvent: (String, Map<String, Any?>) -> Unit,
    ) {
        if (running.get()) {
            Log.w(TAG, "start() called while already running — ignoring")
            return
        }
        if (apiKey.isBlank()) {
            onEvent("onVoiceError", mapOf("message" to "no Gemini API key configured"))
            return
        }

        val homeDir = HomeInitializer.getHomeDir(context)
        val libDir = LibExtractor.getLibDir(context)
        val scriptPath = File(homeDir, ".shelly-gemini-live-client.js").absolutePath
        val nodePath = File(libDir, "node").absolutePath
        if (!File(scriptPath).exists() || !File(nodePath).exists()) {
            onEvent("onVoiceError", mapOf("message" to "voice runtime not extracted yet — restart the app"))
            return
        }

        val pb = ProcessBuilder("/system/bin/linker64", nodePath, scriptPath)
        pb.environment()["LD_LIBRARY_PATH"] = libDir.absolutePath
        pb.environment()["HOME"] = homeDir.absolutePath
        pb.environment()["GEMINI_API_KEY"] = apiKey
        pb.directory(homeDir)
        val proc = try {
            pb.start()
        } catch (e: Exception) {
            Log.e(TAG, "failed to spawn voice client: ${e.message}")
            onEvent("onVoiceError", mapOf("message" to "failed to start voice runtime: ${e.message}"))
            return
        }
        process = proc
        running.set(true)
        interrupted.set(false)

        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        // A real (non-null) listener, even a no-op one: AudioManager's
        // internal focus-change dispatch calls into this on focus loss/gain
        // for as long as the request is held, so a null listener risks an
        // NPE inside the platform's own Binder callback the moment another
        // app (a call, another media session) touches audio focus. Kept as
        // the SAME instance in focusListener so stop() can abandon it with
        // it (Android requires the identical listener object to abandon).
        val listener = AudioManager.OnAudioFocusChangeListener { }
        focusListener = listener
        audioManager.requestAudioFocus(
            listener,
            AudioManager.STREAM_VOICE_CALL,
            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE,
        )

        startMicCapture(proc)
        startPlayback(proc, onEvent)
        startControlReader(proc, onEvent, audioManager)
    }

    private fun startMicCapture(proc: Process) {
        val minBuf = AudioRecord.getMinBufferSize(
            SAMPLE_RATE_IN,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        if (minBuf <= 0) {
            Log.e(TAG, "AudioRecord.getMinBufferSize failed ($minBuf) — mic capture disabled for this session")
            return
        }
        val bufSize = minBuf * 2
        val record = try {
            AudioRecord(
                // VOICE_COMMUNICATION gets the platform's own echo
                // cancellation / noise suppression on devices that support
                // it — meaningful here since the speaker is playing the
                // model's voice back while this is capturing.
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                SAMPLE_RATE_IN,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufSize,
            )
        } catch (e: SecurityException) {
            Log.e(TAG, "RECORD_AUDIO permission missing: ${e.message}")
            return
        }
        if (record.state != AudioRecord.STATE_INITIALIZED) {
            Log.e(TAG, "AudioRecord failed to initialize")
            record.release()
            return
        }
        audioRecord = record

        val thread = Thread {
            val buf = ByteArray(bufSize)
            try {
                record.startRecording()
                val out = proc.outputStream
                while (running.get()) {
                    val n = record.read(buf, 0, buf.size)
                    if (n > 0) {
                        try {
                            out.write(buf, 0, n)
                        } catch (e: Exception) {
                            // Process stdin closed (session ending) — stop quietly.
                            break
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "mic capture loop error: ${e.message}")
            } finally {
                try { record.stop() } catch (_: Exception) {}
                record.release()
            }
        }
        thread.name = "VoiceBridge-mic"
        thread.start()
        micThread = thread
    }

    private fun startPlayback(proc: Process, onEvent: (String, Map<String, Any?>) -> Unit) {
        val minBuf = AudioTrack.getMinBufferSize(
            SAMPLE_RATE_OUT,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val track = AudioTrack(
            AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build(),
            AudioFormat.Builder()
                .setSampleRate(SAMPLE_RATE_OUT)
                .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                .build(),
            maxOf(minBuf, 1) * 2,
            AudioTrack.MODE_STREAM,
            AudioManager.AUDIO_SESSION_ID_GENERATE,
        )
        audioTrack = track
        track.play()

        val thread = Thread {
            val buf = ByteArray(4096)
            try {
                val input = proc.inputStream
                while (running.get()) {
                    val n = try {
                        input.read(buf)
                    } catch (e: Exception) {
                        -1
                    }
                    if (n < 0) break
                    if (n > 0) {
                        if (interrupted.compareAndSet(true, false)) {
                            // Drop whatever's still queued from BEFORE the
                            // interruption; audio arriving after this point
                            // is the model's next (post-interruption) turn.
                            track.pause()
                            track.flush()
                            track.play()
                        }
                        track.write(buf, 0, n)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "playback loop error: ${e.message}")
            } finally {
                try { track.stop() } catch (_: Exception) {}
                track.release()
            }
        }
        thread.name = "VoiceBridge-playback"
        thread.start()
        playbackThread = thread
    }

    private fun startControlReader(
        proc: Process,
        onEvent: (String, Map<String, Any?>) -> Unit,
        audioManager: AudioManager,
    ) {
        val thread = Thread {
            try {
                proc.errorStream.bufferedReader().useLines { lines ->
                    for (line in lines) {
                        if (line.isBlank()) continue
                        try {
                            val json = JSONObject(line)
                            when (json.optString("type")) {
                                "ready" -> onEvent("onVoiceReady", emptyMap())
                                "turn_complete" -> onEvent("onVoiceTurnComplete", emptyMap())
                                "interrupted" -> {
                                    interrupted.set(true)
                                    onEvent("onVoiceInterrupted", emptyMap())
                                }
                                "input_transcript" -> onEvent(
                                    "onVoiceInputTranscript",
                                    mapOf("text" to json.optString("text")),
                                )
                                "output_transcript" -> onEvent(
                                    "onVoiceOutputTranscript",
                                    mapOf("text" to json.optString("text")),
                                )
                                "error" -> onEvent(
                                    "onVoiceError",
                                    mapOf("message" to json.optString("message")),
                                )
                            }
                        } catch (e: Exception) {
                            Log.w(TAG, "unparseable control line: $line")
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "control reader error: ${e.message}")
            } finally {
                val exitCode = try { proc.waitFor() } catch (_: Exception) { -1 }
                running.set(false)
                try { audioManager.mode = AudioManager.MODE_NORMAL } catch (_: Exception) {}
                try {
                    focusListener?.let { audioManager.abandonAudioFocus(it) }
                } catch (_: Exception) {}
                onEvent("onVoiceExit", mapOf("exitCode" to exitCode))
            }
        }
        thread.name = "VoiceBridge-control"
        thread.start()
        controlThread = thread
    }

    @Synchronized
    fun stop() {
        if (!running.get()) return
        running.set(false)
        try {
            process?.outputStream?.close() // EOF -> script closes the WS cleanly
        } catch (_: Exception) {}
        val proc = process
        Thread {
            try {
                proc?.waitFor()
            } catch (_: Exception) {}
            proc?.let { if (it.isAlive) it.destroy() }
        }.start()
        process = null
        audioRecord = null
        audioTrack = null
        micThread = null
        playbackThread = null
        controlThread = null
    }
}
