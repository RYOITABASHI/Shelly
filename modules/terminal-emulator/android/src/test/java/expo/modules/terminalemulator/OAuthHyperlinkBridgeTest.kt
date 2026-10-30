package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File

class OAuthHyperlinkBridgeTest {
    private val cid = OAuthHyperlinkBridge.CLAUDE_CODE_CLIENT_ID
    private val url =
        "https://claude.com/cai/oauth/authorize?code=true&client_id=$cid" +
            "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
            "&scope=user%3Ainference&code_challenge=abc-_DEF&code_challenge_method=S256&state=xyz#frag"

    @Before
    fun reset() = OAuthHyperlinkBridge.resetForTest()

    @Test
    fun acceptsOnlyClaudeCodeAuthorizeUrls() {
        assertTrue(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl(url))
        assertTrue(
            OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl(
                "https://claude.ai/oauth/authorize?client_id=$cid&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback",
            ),
        )
        // wrong client / redirect / duplicated params
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl(url.replace(cid, "00000000-0000-4000-8000-000000000000")))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl(url.replace("platform.claude.com%2Foauth", "evil.example%2Foauth")))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("$url&client_id=$cid"))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("https://claude.ai/oauth/authorize?a=1&b=2"))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl(url.replace("https://", "http://")))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("https://claude.ai/settings"))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("https://claude.ai@evil.example/oauth/authorize"))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("http://127.0.0.1:18080"))
    }

    @Test
    fun queueLineKeepsTheWholeUrlAndAsksForConfirmation() {
        assertEquals(
            "{\"type\":\"open-url\",\"url\":\"$url\",\"authMode\":\"external-browser\",\"provider\":\"anthropic\",\"confirm\":true}",
            OAuthHyperlinkBridge.queueLine(url),
        )
    }

    @Test
    fun dedupeExpiresSoAStillShownUrlCanPromptAgain() {
        assertTrue(OAuthHyperlinkBridge.markFirstSeen(url, 0))
        assertFalse(OAuthHyperlinkBridge.markFirstSeen(url, 59_999))
        assertTrue(OAuthHyperlinkBridge.markFirstSeen(url, 60_000))
    }

    @Test
    fun armFileMustBeFreshAndNameALivePid() {
        val f = File.createTempFile("arm", ".arm")
        try {
            f.writeText("4242 n0nce\n")
            val now = f.lastModified()
            assertTrue(OAuthHyperlinkBridge.isArmed(f, now) { it == 4242 })
            assertFalse(OAuthHyperlinkBridge.isArmed(f, now) { false })
            assertFalse(OAuthHyperlinkBridge.isArmed(f, now + OAuthHyperlinkBridge.ARM_MAX_AGE_MS + 1) { true })
            f.writeText("garbage")
            assertFalse(OAuthHyperlinkBridge.isArmed(f, now) { true })
            f.delete()
            assertFalse(OAuthHyperlinkBridge.isArmed(f, now) { true })
        } finally {
            f.delete()
        }
    }
}
