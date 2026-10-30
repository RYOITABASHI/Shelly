package expo.modules.terminalemulator

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Tests the per-process memo that lets execCommand() skip
 * LibExtractor.extractAll() after it has succeeded once for the installed APK.
 *
 * Like TriggerDebouncerTest, this module has no unit-test task wired into CI
 * yet (build-android.yml only runs assembleRelease); ExtractionMemo has zero
 * android.* imports so this runs on the plain JVM via
 * `./gradlew :terminal-emulator:testDebugUnitTest` or a standalone kotlinc run.
 */
class ExtractionMemoTest {
    private val apkV1 = ExtractionMemoKey("/data/app/~~a/base.apk", 1_000L, 415_000_000L)
    private val apkV2 = ExtractionMemoKey("/data/app/~~b/base.apk", 2_000L, 416_000_000L)

    private class Harness(var key: ExtractionMemoKey, var sentinels: Boolean = true) {
        val memo = ExtractionMemo()
        val runs = AtomicInteger(0)
        fun call(): Boolean = memo.ensure({ key }, { sentinels }, { runs.incrementAndGet() })
    }

    @Test
    fun `first call extracts, second call skips`() {
        val h = Harness(apkV1)
        assertTrue(h.call())
        assertFalse(h.call())
        assertFalse(h.call())
        assertEquals(1, h.runs.get())
    }

    @Test
    fun `missing sentinel triggers re-extract`() {
        val h = Harness(apkV1)
        h.call()
        h.sentinels = false
        assertTrue(h.call())
        assertEquals(2, h.runs.get())
        h.sentinels = true
        assertFalse(h.call())
        assertEquals(2, h.runs.get())
    }

    @Test
    fun `apk identity change triggers re-extract`() {
        val h = Harness(apkV1)
        h.call()
        h.key = apkV2
        assertTrue(h.call())
        assertFalse(h.call())
        assertEquals(2, h.runs.get())
        // Same path but different mtime is also a different APK.
        h.key = apkV2.copy(apkLastModified = 3_000L)
        assertTrue(h.call())
        assertEquals(3, h.runs.get())
    }

    @Test
    fun `failed extraction is not memoized`() {
        val memo = ExtractionMemo()
        try {
            memo.ensure({ apkV1 }, { true }, { throw java.io.IOException("disk full") })
            fail("expected exception")
        } catch (_: java.io.IOException) {
        }
        assertTrue(memo.needsExtract(apkV1, sentinelsUsable = true))
        var ran = false
        assertTrue(memo.ensure({ apkV1 }, { true }, { ran = true }))
        assertTrue(ran)
    }

    @Test
    fun `extraction recorded by another path (PTY create) is honored`() {
        val memo = ExtractionMemo()
        memo.record(apkV1)
        var ran = false
        assertFalse(memo.ensure({ apkV1 }, { true }, { ran = true }))
        assertFalse(ran)
        memo.invalidate()
        assertTrue(memo.needsExtract(apkV1, sentinelsUsable = true))
    }

    @Test
    fun `concurrent callers extract exactly once`() {
        val pool = Executors.newFixedThreadPool(8)
        val start = CountDownLatch(1)
        val slowMemo = ExtractionMemo()
        val runs = AtomicInteger(0)
        repeat(32) {
            pool.submit {
                start.await()
                slowMemo.ensure({ apkV1 }, { true }, {
                    runs.incrementAndGet()
                    Thread.sleep(50)
                })
            }
        }
        start.countDown()
        pool.shutdown()
        assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
        assertEquals(1, runs.get())
    }
}
