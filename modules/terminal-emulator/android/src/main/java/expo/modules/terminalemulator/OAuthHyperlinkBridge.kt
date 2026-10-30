package expo.modules.terminalemulator

import com.termux.terminal.TerminalEmulator
import java.io.File
import java.io.FileOutputStream
import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.Executors

/**
 * Claude Code glibc S2 (DEFERRED.md "Claude Code 公式 glibc 版（2.1.314）を Shelly で動かす").
 *
 * The glibc `claude` process cannot execve an app_data_file opener ($BROWSER /
 * xdg-open → shelly_xdg_open) because of targetSdk W^X, and Shelly's bionic
 * libexec_wrapper (which reroutes execve through linker64) is not loaded in
 * the glibc world (that wrapper is S3). Claude Code's sign-in screens render the
 * authorize URL with `<Link url assumeSupport>`, i.e. as an OSC 8 hyperlink:
 * `ESC ] 8 ; ; <full URL> ST <visible, wrapped text> ESC ] 8 ; ; ST`. The OSC
 * payload carries the COMPLETE URL regardless of how the visible text wraps,
 * so the terminal emulator (TerminalEmulator.sHyperlinkObserver) hands it here.
 *
 * SECURITY: terminal output is attacker-influenced (cat of a repo file, git log,
 * an agent, Codex …). A genuine Anthropic consent page carrying an attacker's
 * PKCE challenge, once approved, yields a code the user would paste into the
 * attacker's script. So this bridge NEVER opens anything. It only queues a
 * `confirm` sign-in REQUEST, and only when ALL of:
 *   - a shelly-claude-glibc session is armed: `$HOME/tmp/.shelly-claude-login.arm`
 *     exists, is fresh, and names a live pid (written by the bashrc function,
 *     removed by its EXIT trap; RN deletes it when the user taps "Open", so one
 *     sign-in per arming);
 *   - the URL is an Anthropic authorize endpoint with Claude Code's public
 *     client_id and its manual-code or localhost redirect_uri.
 * The RN drain (app/_layout.tsx + lib/deep-link-queue-policy.ts) re-checks all
 * of it and shows a "Claude sign-in requested — Open" prompt; Custom Tabs open
 * only on the user's tap.
 *
 * Ink re-renders the same frame many times (and again on focus regain / resize):
 * `seen` keeps the same URL from being re-queued for SEEN_TTL_MS, after which a
 * still-displayed URL may prompt again (re-open after a cancel).
 */
object OAuthHyperlinkBridge {
    private const val QUEUE_NAME = ".shelly-deep-link-queue"
    const val ARM_RELATIVE_PATH = "tmp/.shelly-claude-login.arm"
    const val CLAUDE_CODE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    const val CLAUDE_CODE_MANUAL_REDIRECT = "https://platform.claude.com/oauth/code/callback"
    private val LOCALHOST_CALLBACK = Regex("^http://localhost:\\d{1,5}/callback$")
    private const val MAX_REMEMBERED = 64
    const val SEEN_TTL_MS = 60_000L
    const val ARM_MAX_AGE_MS = 12L * 60 * 60 * 1000

    @Volatile
    private var homeDir: File? = null
    private val seen = LinkedHashMap<String, Long>()
    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "shelly-oauth-hyperlink").apply { isDaemon = true }
    }

    fun install(home: File) {
        homeDir = home
        TerminalEmulator.sHyperlinkObserver = TerminalEmulator.HyperlinkObserver { uri -> onHyperlink(uri) }
    }

    fun onHyperlink(uri: String) {
        if (!isAnthropicOAuthAuthorizeUrl(uri)) return
        val home = homeDir ?: return
        io.execute {
            try {
                if (!isArmed(File(home, ARM_RELATIVE_PATH), System.currentTimeMillis()) { pid ->
                        File("/proc/$pid").exists()
                    }
                ) {
                    android.util.Log.w("ShellyOAuthLink", "ignored Claude sign-in link: no armed shelly-claude-glibc session")
                    return@execute
                }
                if (!markFirstSeen(uri, System.currentTimeMillis())) return@execute
                FileOutputStream(File(home, QUEUE_NAME), true).use { out ->
                    // One write() per line: O_APPEND keeps it atomic w.r.t. the
                    // other emitters (shelly-xdg-open.c, shelly-codex-auth.js).
                    out.write((queueLine(uri) + "\n").toByteArray(Charsets.UTF_8))
                }
                android.util.Log.i("ShellyOAuthLink", "queued Claude sign-in request (${uri.length} chars)")
            } catch (e: Exception) {
                android.util.Log.w("ShellyOAuthLink", "queue append failed: ${e.message}")
            }
        }
    }

    /** Arm file: "<pid> <nonce>", fresh, pid alive. */
    internal fun isArmed(arm: File, now: Long, pidAlive: (Int) -> Boolean): Boolean {
        if (!arm.isFile) return false
        val age = now - arm.lastModified()
        if (age < -60_000L || age > ARM_MAX_AGE_MS) return false
        val text = try {
            arm.readText().trim()
        } catch (e: Exception) {
            return false
        }
        val parts = text.split(' ')
        if (parts.size != 2 || parts[1].isEmpty()) return false
        val pid = parts[0].toIntOrNull() ?: return false
        if (pid <= 1) return false
        return pidAlive(pid)
    }

    /** true when [uri] was not queued within the last [SEEN_TTL_MS]. */
    internal fun markFirstSeen(uri: String, now: Long): Boolean {
        synchronized(seen) {
            val it = seen.entries.iterator()
            while (it.hasNext()) if (now - it.next().value >= SEEN_TTL_MS) it.remove()
            if (seen.containsKey(uri)) return false
            seen[uri] = now
            while (seen.size > MAX_REMEMBERED) seen.remove(seen.keys.first())
            return true
        }
    }

    internal fun resetForTest() {
        synchronized(seen) { seen.clear() }
    }

    /**
     * Must mirror lib/deep-link-queue-policy.ts `isAnthropicOAuthAuthorizeUrl`:
     * https, default port, no userinfo, exact host + path, exactly one
     * client_id == Claude Code's and exactly one redirect_uri that is Claude
     * Code's manual callback or http://localhost:<port>/callback.
     */
    fun isAnthropicOAuthAuthorizeUrl(raw: String): Boolean {
        if (raw.length > 4096) return false
        val u = try {
            URI(raw)
        } catch (e: Exception) {
            return false
        }
        if (!"https".equals(u.scheme, ignoreCase = true)) return false
        if (u.rawUserInfo != null) return false
        if (u.port != -1 && u.port != 443) return false
        val host = u.host?.lowercase() ?: return false
        val path = u.rawPath ?: return false
        val endpointOk = when (host) {
            "claude.ai", "platform.claude.com", "console.anthropic.com" -> path == "/oauth/authorize"
            "claude.com" -> path == "/cai/oauth/authorize"
            else -> false
        }
        if (!endpointOk) return false
        val params = parseQuery(u.rawQuery ?: return false) ?: return false
        val clientIds = params.filter { it.first == "client_id" }.map { it.second }
        val redirects = params.filter { it.first == "redirect_uri" }.map { it.second }
        if (clientIds != listOf(CLAUDE_CODE_CLIENT_ID)) return false
        if (redirects.size != 1) return false
        val r = redirects[0]
        return r == CLAUDE_CODE_MANUAL_REDIRECT || LOCALHOST_CALLBACK.matches(r)
    }

    private fun parseQuery(raw: String): List<Pair<String, String>>? = try {
        raw.split('&').filter { it.isNotEmpty() }.map { kv ->
            val i = kv.indexOf('=')
            val k = if (i >= 0) kv.substring(0, i) else kv
            val v = if (i >= 0) kv.substring(i + 1) else ""
            URLDecoder.decode(k, "UTF-8") to URLDecoder.decode(v, "UTF-8")
        }
    } catch (e: Exception) {
        null
    }

    /** JSON queue line understood by lib/deep-link-queue-policy.ts. */
    fun queueLine(url: String): String {
        val sb = StringBuilder(url.length + 112)
        sb.append("{\"type\":\"open-url\",\"url\":\"")
        for (c in url) {
            when {
                c == '"' || c == '\\' -> sb.append('\\').append(c)
                c.code < 0x20 -> sb.append(String.format("\\u%04x", c.code))
                else -> sb.append(c)
            }
        }
        sb.append("\",\"authMode\":\"external-browser\",\"provider\":\"anthropic\",\"confirm\":true}")
        return sb.toString()
    }
}
