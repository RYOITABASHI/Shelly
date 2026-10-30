package expo.modules.terminalemulator

import com.termux.terminal.TerminalEmulator
import java.io.File
import java.io.FileOutputStream
import java.net.URI
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
 * payload carries the COMPLETE URL regardless of how the visible text is
 * wrapped, so the terminal emulator (TerminalEmulator.sHyperlinkObserver) hands
 * it here and we queue exactly one external-browser open per distinct URL.
 *
 * Only Anthropic OAuth authorize URLs are acted on — any other OSC 8 link is
 * ignored (no auto-open of arbitrary links printed to the terminal). Ink
 * re-renders the same frame many times (and again whenever Shelly regains
 * focus / the pane resizes), so the per-URL dedupe here is what keeps that
 * from re-opening Custom Tabs; every login attempt carries a fresh `state`
 * parameter, so a new attempt still opens once. The RN drain
 * (lib/deep-link-open-guard.ts) adds a time-window dedupe + burst guard as a
 * second layer.
 */
object OAuthHyperlinkBridge {
    private const val QUEUE_NAME = ".shelly-deep-link-queue"
    private const val MAX_REMEMBERED = 64

    @Volatile
    private var homeDir: File? = null
    private val seen = LinkedHashSet<String>()
    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "shelly-oauth-hyperlink").apply { isDaemon = true }
    }

    fun install(home: File) {
        homeDir = home
        TerminalEmulator.sHyperlinkObserver = TerminalEmulator.HyperlinkObserver { uri -> onHyperlink(uri) }
    }

    fun onHyperlink(uri: String) {
        if (!isAnthropicOAuthAuthorizeUrl(uri)) return
        if (!markFirstSeen(uri)) return
        val home = homeDir ?: return
        io.execute {
            try {
                FileOutputStream(File(home, QUEUE_NAME), true).use { out ->
                    // One write() per line: O_APPEND keeps it atomic w.r.t. the
                    // other emitters (shelly-xdg-open.c, shelly-codex-auth.js).
                    out.write((queueLine(uri) + "\n").toByteArray(Charsets.UTF_8))
                }
                android.util.Log.i("ShellyOAuthLink", "queued Anthropic sign-in URL (${uri.length} chars)")
            } catch (e: Exception) {
                android.util.Log.w("ShellyOAuthLink", "queue append failed: ${e.message}")
            }
        }
    }

    /** true the first time [uri] is seen (bounded LRU of recent URLs). */
    internal fun markFirstSeen(uri: String): Boolean {
        synchronized(seen) {
            if (!seen.add(uri)) return false
            while (seen.size > MAX_REMEMBERED) seen.remove(seen.first())
            return true
        }
    }

    internal fun resetForTest() {
        synchronized(seen) { seen.clear() }
    }

    /**
     * Must mirror lib/deep-link-queue-policy.ts `isAnthropicOAuthAuthorizeUrl`.
     * https only, default port, no userinfo, exact host + exact path.
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
        return when (host) {
            "claude.ai", "platform.claude.com", "console.anthropic.com" -> path == "/oauth/authorize"
            "claude.com" -> path == "/cai/oauth/authorize"
            else -> false
        }
    }

    /** JSON queue line understood by lib/deep-link-queue-policy.ts. */
    fun queueLine(url: String): String {
        val sb = StringBuilder(url.length + 96)
        sb.append("{\"type\":\"open-url\",\"url\":\"")
        for (c in url) {
            when {
                c == '"' || c == '\\' -> sb.append('\\').append(c)
                c.code < 0x20 -> sb.append(String.format("\\u%04x", c.code))
                else -> sb.append(c)
            }
        }
        sb.append("\",\"authMode\":\"external-browser\",\"provider\":\"anthropic\"}")
        return sb.toString()
    }
}
