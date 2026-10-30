package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class OAuthHyperlinkBridgeTest {
    private val url =
        "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
            "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
            "&scope=user%3Ainference&code_challenge=abc-_DEF&code_challenge_method=S256&state=xyz#frag"

    @Before
    fun reset() = OAuthHyperlinkBridge.resetForTest()

    @Test
    fun acceptsOnlyAnthropicAuthorizeUrls() {
        assertTrue(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl(url))
        assertTrue(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("https://claude.ai/oauth/authorize?a=1&b=2"))
        assertTrue(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("https://platform.claude.com/oauth/authorize?x=1"))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("http://claude.ai/oauth/authorize?a=1"))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("https://claude.ai/settings"))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("https://claude.ai@evil.example/oauth/authorize"))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("https://evil.example/oauth/authorize?next=https://claude.ai/oauth/authorize"))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("https://claude.ai:8443/oauth/authorize"))
        assertFalse(OAuthHyperlinkBridge.isAnthropicOAuthAuthorizeUrl("http://127.0.0.1:18080"))
    }

    @Test
    fun queueLineKeepsTheWholeUrl() {
        val line = OAuthHyperlinkBridge.queueLine(url)
        assertEquals(
            "{\"type\":\"open-url\",\"url\":\"$url\",\"authMode\":\"external-browser\",\"provider\":\"anthropic\"}",
            line,
        )
        assertEquals("{\"type\":\"open-url\",\"url\":\"a\\\"b\\\\c\\u000a\",\"authMode\":\"external-browser\",\"provider\":\"anthropic\"}",
            OAuthHyperlinkBridge.queueLine("a\"b\\c\n"))
    }

    @Test
    fun dedupesRepeatedRenders() {
        assertTrue(OAuthHyperlinkBridge.markFirstSeen(url))
        assertFalse(OAuthHyperlinkBridge.markFirstSeen(url))
        assertTrue(OAuthHyperlinkBridge.markFirstSeen("$url-2"))
    }
}
