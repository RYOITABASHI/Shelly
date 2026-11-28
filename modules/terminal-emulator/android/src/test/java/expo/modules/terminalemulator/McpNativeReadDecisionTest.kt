package expo.modules.terminalemulator

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** McpNativeReadDecision (background ingress, phase B-1): read_terminal_output without RN. */
class McpNativeReadDecisionTest {
    private class Facts(
        var on: Boolean = true,
        var epoch: Boolean = true,
        val sessions: Map<String, String> = mapOf("session-1" to "a\nb\nc"),
        var offAfterRead: Boolean = false,
        var throwOnRead: Boolean = false,
    ) : McpNativeReadDecision.Steps {
        var lastMaxLines: Int? = null
        var reads = 0
        override fun readTerminalOn(): Boolean = on
        override fun epochCurrent(): Boolean = epoch
        override fun transcript(sessionId: String, maxLines: Int): String? {
            reads++
            lastMaxLines = maxLines
            if (throwOnRead) throw IllegalStateException("boom")
            val t = sessions[sessionId] ?: return null
            if (offAfterRead) on = false
            return t
        }
    }

    private fun answer(args: String, f: Facts) = JSONObject(McpNativeReadDecision.answerTerminal(JSONObject(args), f))

    @Test
    fun returnsTheTranscriptAsData() {
        val f = Facts()
        val r = answer("""{"sessionId":"session-1","maxLines":50}""", f)
        assertTrue(r.getBoolean("ok"))
        assertEquals("a\nb\nc", r.getString("data"))
        assertEquals(50, f.lastMaxLines)
    }

    @Test
    fun maxLinesDefaultsTo200AndTruncatesLikeExpo() {
        val f = Facts()
        answer("""{"sessionId":"session-1"}""", f)
        assertEquals(200, f.lastMaxLines)
        answer("""{"sessionId":"session-1","maxLines":"9"}""", f)
        assertEquals(200, f.lastMaxLines)
        answer("""{"sessionId":"session-1","maxLines":12.9}""", f)
        assertEquals(12, f.lastMaxLines)
        answer("""{"sessionId":"session-1","maxLines":-1}""", f)
        assertEquals(-1, f.lastMaxLines)
    }

    @Test
    fun disabledFirstWithRnsMessageAndNothingRead() {
        val f = Facts(on = false, epoch = false)
        val r = answer("""{"sessionId":"session-1"}""", f)
        assertFalse(r.getBoolean("ok"))
        assertEquals(McpNativeReadDecision.READ_TERMINAL_DISABLED, r.getString("error"))
        assertFalse(r.has("code"))
        assertEquals(0, f.reads)
    }

    @Test
    fun staleEpochIsRevoked() {
        val f = Facts(epoch = false)
        val r = answer("""{"sessionId":"session-1"}""", f)
        assertEquals("revoked", r.getString("code"))
        assertEquals(0, f.reads)
    }

    @Test
    fun unknownOrMalformedSession() {
        val f = Facts()
        assertEquals("no such terminal session: other", answer("""{"sessionId":"other"}""", f).getString("error"))
        assertEquals("no such terminal session:", answer("""{}""", f).getString("error"))
        assertEquals("no such terminal session: a b", answer("""{"sessionId":"a b"}""", f).getString("error"))
        assertEquals(1, f.reads)
    }

    @Test
    fun switchTurnedOffDuringTheReadAnswersNothing() {
        val f = Facts(offAfterRead = true)
        val r = answer("""{"sessionId":"session-1"}""", f)
        assertEquals(McpNativeReadDecision.READ_TERMINAL_DISABLED, r.getString("error"))
        assertNull(r.optString("data", null))
    }

    @Test
    fun aFailedReadIsAnError() {
        val r = answer("""{"sessionId":"session-1"}""", Facts(throwOnRead = true))
        assertFalse(r.getBoolean("ok"))
        assertEquals("boom", r.getString("error"))
    }
}
