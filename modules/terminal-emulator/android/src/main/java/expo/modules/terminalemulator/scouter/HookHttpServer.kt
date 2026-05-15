package expo.modules.terminalemulator.scouter

import android.util.Log
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

class HookHttpServer(
    private val token: String,
    private val onEvent: (ScouterEvent) -> Unit
) {
    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private var thread: Thread? = null
    var port: Int = -1
        private set

    fun start(): Int {
        if (running.get()) return port
        val socket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
        serverSocket = socket
        port = socket.localPort
        running.set(true)
        thread = Thread({ acceptLoop(socket) }, "ScouterHookHttpServer").apply {
            isDaemon = true
            start()
        }
        Log.i(TAG, "Hook server started on 127.0.0.1:$port")
        return port
    }

    fun stop() {
        running.set(false)
        try { serverSocket?.close() } catch (_: Throwable) {}
        serverSocket = null
        thread = null
        port = -1
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (running.get()) {
            val client = try {
                socket.accept()
            } catch (_: Throwable) {
                if (!running.get()) return
                continue
            }
            Thread({ handle(client) }, "ScouterHookRequest").apply {
                isDaemon = true
                start()
            }
        }
    }

    private fun handle(socket: Socket) {
        socket.use { client ->
            val reader = BufferedReader(InputStreamReader(client.getInputStream(), Charsets.UTF_8))
            val requestLine = reader.readLine().orEmpty()
            val parts = requestLine.split(" ")
            val method = parts.getOrNull(0).orEmpty()
            val path = parts.getOrNull(1).orEmpty()
            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = reader.readLine() ?: break
                if (line.isEmpty()) break
                val idx = line.indexOf(':')
                if (idx > 0) {
                    headers[line.substring(0, idx).trim().lowercase(Locale.US)] = line.substring(idx + 1).trim()
                }
            }
            val length = headers["content-length"]?.toIntOrNull() ?: 0
            val chars = CharArray(length)
            var read = 0
            while (read < length) {
                val n = reader.read(chars, read, length - read)
                if (n <= 0) break
                read += n
            }
            val body = String(chars, 0, read)

            if (method != "POST" || !path.startsWith("/hook/")) {
                respond(client, 404, "not found")
                return
            }
            if (headers["x-scouter-token"] != token) {
                respond(client, 401, "unauthorized")
                return
            }
            val eventName = path.removePrefix("/hook/").trim('/')
            val source = when {
                eventName.startsWith("codex/") -> ScouterSource.CODEX
                eventName.startsWith("cc/") || eventName.startsWith("claude/") -> ScouterSource.CLAUDE_CODE
                else -> null
            }
            val normalizedName = eventName.substringAfterLast('/')
            val event = EventNormalizer.fromHook(source, normalizedName, body)
            onEvent(event)
            respond(client, 200, """{"ok":true}""", "application/json")
        }
    }

    private fun respond(socket: Socket, status: Int, body: String, contentType: String = "text/plain") {
        val reason = when (status) {
            200 -> "OK"
            401 -> "Unauthorized"
            404 -> "Not Found"
            else -> "Error"
        }
        val bytes = body.toByteArray(Charsets.UTF_8)
        socket.getOutputStream().use { out ->
            out.write("HTTP/1.1 $status $reason\r\n".toByteArray())
            out.write("Content-Type: $contentType; charset=utf-8\r\n".toByteArray())
            out.write("Content-Length: ${bytes.size}\r\n".toByteArray())
            out.write("Connection: close\r\n\r\n".toByteArray())
            out.write(bytes)
        }
    }

    companion object {
        private const val TAG = "ScouterHookHttpServer"
    }
}

