package expo.modules.terminalemulator

import expo.modules.terminalemulator.ClosePawDraftPreapproval.Entry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.TimeZone

/**
 * The pure half of ClosePawDraftPreapproval (cap counting, destination keys).
 * Like CodexRemotePolicyTest, not wired into CI's Gradle run yet; the same
 * checks were run locally with kotlinc against android.jar.
 */
class ClosePawDraftPreapprovalTest {
    private val today = 20000L

    @Test
    fun allotRespectsTheCapAndUnknownDestinations() {
        val entries = listOf(Entry("note", 2, 0, today, 1), Entry("substack:a", 5, 0, today - 1, 5))
        val (next, mask) = ClosePawDraftPreapproval.allot(entries, listOf("note", "note", "substack:a", "substack:b", null), today)
        assertEquals(listOf(true, false, true, false, false), mask.toList())
        assertEquals(2, next.first { it.dest == "note" }.used)
        val a = next.first { it.dest == "substack:a" }
        assertEquals(1, a.used)
        assertEquals(today, a.day)
    }

    @Test
    fun aClockMovedBackAllowsNone() {
        assertEquals(0, ClosePawDraftPreapproval.remaining(Entry("note", 5, 0, today + 1, 0), today))
        assertEquals(5, ClosePawDraftPreapproval.remaining(Entry("note", 5, 0, today - 1, 5), today))
    }

    @Test
    fun destinationKeys() {
        assertEquals("note", ClosePawDraftPreapproval.destinationKey("note", null))
        assertEquals("substack:garden", ClosePawDraftPreapproval.destinationKey("substack", "garden"))
        assertNull(ClosePawDraftPreapproval.destinationKey("substack", null))
        assertNull(ClosePawDraftPreapproval.destinationKey("substack", "Bad!"))
        assertNull(ClosePawDraftPreapproval.destinationKey("x", null))
    }

    @Test
    fun theDayFollowsTheTimeZone() {
        val t = 1_700_000_000_000L
        assertTrue(
            ClosePawDraftPreapproval.localDay(t, TimeZone.getTimeZone("Asia/Tokyo")) ==
                ClosePawDraftPreapproval.localDay(t, TimeZone.getTimeZone("UTC")) + 1,
        )
    }
}
