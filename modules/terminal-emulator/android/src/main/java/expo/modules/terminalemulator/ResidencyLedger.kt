package expo.modules.terminalemulator

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.Os
import android.system.OsConstants
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

/**
 * Append-only, tamper-evident residency record of the supervised services
 * (ManagedServices.REGISTRY), kept by the device itself so the 24 h residency
 * judgement does not depend on a PC sampling over adb / Tailscale (which goes
 * blind while the phone sleeps or the network drops).
 *
 * File: `<home>/.shelly/services/<id>/residency.jsonl` (the directory the
 * supervisor already owns; never created here), rotated to
 * `residency.jsonl.1` at 512 KiB (two generations). Line format, chain and
 * verification: ResidencyLedgerCore. Each line carries an HMAC-SHA256 under a
 * non-exportable Android Keystore key (created on first use, never rotated),
 * and the last seq + line hash per service is kept in SharedPreferences as a
 * tail anchor, so a truncated or replaced file shows up as a chain break.
 *
 * When: every supervisor event (ManagedServiceSupervisor.audit / recordExit),
 * a `boot` line on BOOT_COMPLETED, and a `tick` every 10 minutes from a
 * chained exact alarm delivered to TerminalSessionService
 * (ACTION_RESIDENCY_TICK), armed while a service is wanted running.
 *
 * Never throws into a caller: every write runs on one background thread
 * (lines stay in order), failures are logged with Log.w and dropped.
 */
object ResidencyLedger {
    private const val TAG = "ResidencyLedger"
    private const val PREFS = "shelly_residency_ledger"
    private const val KEY_ALIAS = "shelly_residency_ledger_v1"
    private const val ANDROID_KEYSTORE = "AndroidKeyStore"
    private const val DOMAIN = "shelly-residency-v1:"
    private const val TICK_AT_KEY = "tick_at"
    private const val REQUEST_CODE = 0x37C1A051
    private const val WAKE_LOCK_MS = 60_000L
    private const val TICK_WAIT_MS = 45_000L

    private val executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ShellyResidency").apply { isDaemon = true }
    }

    // ── Recording ──────────────────────────────────────────────────────────

    /**
     * Queues one line for [svc]: [sample] runs on the ledger thread (it may
     * read /proc and, for a tick, poll /health; never under a supervisor lock).
     */
    fun record(context: Context, svc: String, sample: () -> ResidencyLedgerCore.Sample?) {
        val app = context.applicationContext
        try {
            executor.execute {
                try {
                    sample()?.let { append(app, it) }
                } catch (e: Throwable) {
                    Log.w(TAG, "residency line for $svc not written type=${e.javaClass.simpleName}")
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "residency line for $svc not queued type=${e.javaClass.simpleName}")
        }
    }

    /** The common fields of a sample taken now. */
    fun base(context: Context, svc: String, reason: String, code: String?): ResidencyLedgerCore.Sample =
        ResidencyLedgerCore.Sample(
            at = System.currentTimeMillis(),
            elapsedRealtime = SystemClock.elapsedRealtime(),
            bootId = bootId(),
            svc = svc,
            pid = null, startTicks = null, startedAt = null, alive = false, heartbeatAt = null, health = null,
            versionCode = versionCode(context),
            reason = reason,
            code = ResidencyLedgerCore.cleanCode(code),
        )

    @Volatile private var cachedBootId: String? = null

    private fun bootId(): String? {
        cachedBootId?.let { return it }
        val id = ResidencyLedgerCore.bootIdOrNull(runCatching { File("/proc/sys/kernel/random/boot_id").readText() }.getOrNull())
        cachedBootId = id
        return id
    }

    @Volatile private var cachedVersionCode: Long? = null

    private fun versionCode(context: Context): Long {
        cachedVersionCode?.let { return it }
        val v = runCatching {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else {
                @Suppress("DEPRECATION")
                info.versionCode.toLong()
            }
        }.getOrDefault(0L)
        cachedVersionCode = v
        return v
    }

    /** `<home>/.shelly/services/<id>` when it already exists and no part of it is a link; never created here. */
    private fun serviceDir(context: Context, svc: String): File? {
        if (ManagedServices.spec(svc) == null) return null
        val home = HomeInitializer.getHomeDir(context).canonicalFile
        val dir = File(home, ManagedServices.serviceDir(svc))
        if (!dir.isDirectory) return null
        return if (dir.canonicalFile.path == dir.absoluteFile.path) dir else null
    }

    /** Ledger thread only. */
    private fun append(context: Context, sample: ResidencyLedgerCore.Sample) {
        val svc = sample.svc
        val dir = serviceDir(context, svc) ?: return
        val cur = File(dir, ResidencyLedgerCore.FILE)
        val old = File(dir, ResidencyLedgerCore.FILE_PREV)
        if (ManagedServices.isSymlinkLeaf(cur) || ManagedServices.isSymlinkLeaf(old)) {
            Log.w(TAG, "$svc: residency file is a symlink; not written")
            return
        }
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val anchor = readAnchor(prefs, svc)
        val tail = tailLine(cur) ?: if (fileSize(cur) <= 0L) tailLine(old) else null
        val link = ResidencyLedgerCore.resolveLink(anchor, tail)
        if (link.anchorMismatch) onAnchorMismatch(context, svc)
        val canonical = ResidencyLedgerCore.canonical(sample, link.seq, link.prev) ?: run {
            Log.w(TAG, "$svc: residency sample out of shape; not written")
            return
        }
        val line = ResidencyLedgerCore.signed(canonical, mac(canonical) ?: return)
        val bytes = (line + "\n").toByteArray(Charsets.UTF_8)
        if (bytes.size > ResidencyLedgerCore.MAX_LINE_BYTES) return
        if (ResidencyLedgerCore.shouldRotate(fileSize(cur), bytes.size)) {
            try {
                Files.move(cur.toPath(), old.toPath(), StandardCopyOption.REPLACE_EXISTING, LinkOption.NOFOLLOW_LINKS)
            } catch (e: Exception) {
                Log.w(TAG, "$svc: residency rotation failed type=${e.javaClass.simpleName}")
                return
            }
        }
        val flags = OsConstants.O_WRONLY or OsConstants.O_APPEND or OsConstants.O_CREAT or
            OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC or OsConstants.O_NONBLOCK
        val fd = Os.open(cur.path, flags, 384 /* 0600 */)
        try {
            if (!OsConstants.S_ISREG(Os.fstat(fd).st_mode)) {
                Log.w(TAG, "$svc: residency file is not a regular file; not written")
                return
            }
            FileOutputStream(fd).use { it.write(bytes) }
        } finally {
            runCatching { Os.close(fd) }
        }
        prefs.edit()
            .putLong("seq_$svc", link.seq)
            .putString("hash_$svc", ResidencyLedgerCore.sha256Hex(line))
            .commit()
    }

    private fun readAnchor(prefs: android.content.SharedPreferences, svc: String): ResidencyLedgerCore.Anchor? {
        val seq = prefs.getLong("seq_$svc", 0L)
        val hash = prefs.getString("hash_$svc", null)
        return if (seq > 0 && hash != null) ResidencyLedgerCore.Anchor(seq, hash) else null
    }

    private val mismatchAudited = HashSet<String>()

    /** Once per service per process: one audit line and a warning. */
    private fun onAnchorMismatch(context: Context, svc: String) {
        Log.w(TAG, "$svc: residency file tail does not match the anchor (truncated or replaced)")
        val first = synchronized(this) { mismatchAudited.add(svc) }
        if (first && !IngressAuditWriter.appendResidencyGuardLine(context, "residency", "anchor_mismatch", svc, null)) {
            Log.w(TAG, "$svc: anchor mismatch audit line not written")
        }
    }

    private fun fileSize(f: File): Long = runCatching {
        val st = Os.lstat(f.path)
        if (OsConstants.S_ISREG(st.st_mode)) st.st_size else -1L
    }.getOrDefault(-1L)

    /** The last complete line of [f] (a regular file, not a link), or null. */
    private fun tailLine(f: File): String? {
        val size = fileSize(f)
        if (size <= 0L) return null
        return tailLineOf(f, size)
    }

    private fun tailLineOf(f: File, size: Long): String? = runCatching {
        val n = minOf(size, ResidencyLedgerCore.TAIL_READ_BYTES.toLong()).toInt()
        val buf = ByteArray(n)
        RandomAccessFile(f, "r").use { raf ->
            raf.seek(size - n)
            raf.readFully(buf)
        }
        ResidencyLedgerCore.lastLine(buf, chunkStartsFile = n.toLong() == size)
    }.getOrNull()

    // ── Keystore HMAC ──────────────────────────────────────────────────────

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    /** The ledger key, created on first use (non-exportable; never rotated, so old lines keep verifying). */
    @Synchronized
    private fun key(): SecretKey? = try {
        (keyStore().getKey(KEY_ALIAS, null) as? SecretKey) ?: run {
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, ANDROID_KEYSTORE)
            generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY).build())
            generator.generateKey()
        }
    } catch (e: Exception) {
        Log.w(TAG, "residency key unavailable type=${e.javaClass.simpleName}")
        null
    }

    private fun mac(canonical: String): String? {
        val k = key() ?: return null
        return try {
            val m = Mac.getInstance("HmacSHA256")
            m.init(k)
            m.doFinal("$DOMAIN$canonical".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        } catch (e: Exception) {
            Log.w(TAG, "residency mac failed type=${e.javaClass.simpleName}")
            null
        }
    }

    /**
     * Verifies both generations of [svc]'s ledger with the Keystore MAC and
     * the anchor (on-device only: the key never leaves the Keystore, so
     * read_residency over MCP can check the chain but not the MACs). Null
     * when there is nothing to read. Ledger thread.
     */
    private fun verifyOnDevice(context: Context, svc: String): ResidencyLedgerCore.Verification? {
        val dir = serviceDir(context, svc) ?: return null
        val lines = ArrayList<String>()
        for (name in listOf(ResidencyLedgerCore.FILE_PREV, ResidencyLedgerCore.FILE)) {
            val f = File(dir, name)
            val size = fileSize(f)
            if (size <= 0L || size > ResidencyLedgerCore.MAX_BYTES + ResidencyLedgerCore.MAX_LINE_BYTES) continue
            lines.addAll(ResidencyLedgerCore.splitLines(Files.readAllBytes(f.toPath())))
        }
        if (lines.isEmpty()) return null
        val anchor = readAnchor(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE), svc)
        return ResidencyLedgerCore.verify(lines, anchor) { canonical, macHex ->
            val mine = mac(canonical)
            mine != null && MessageDigest.isEqual(mine.toByteArray(Charsets.UTF_8), macHex.toByteArray(Charsets.UTF_8))
        }
    }

    // ── Boot / tick ────────────────────────────────────────────────────────

    /** The services with a state.json (started here at least once). */
    private fun knownServices(context: Context): List<String> {
        val home = HomeInitializer.getHomeDir(context)
        return ManagedServices.REGISTRY.keys.filter {
            File(home, "${ManagedServices.serviceDir(it)}/${ManagedServices.RECORD_FILE}").isFile
        }
    }

    /** A service should be running (started, never stopped on purpose): ticks are armed for it. */
    private fun anyWanted(context: Context): Boolean {
        val home = HomeInitializer.getHomeDir(context)
        return ManagedServices.REGISTRY.keys.any { id ->
            val text = runCatching {
                val f = File(home, "${ManagedServices.serviceDir(id)}/${ManagedServices.RECORD_FILE}")
                val st = Os.lstat(f.path)
                if (!OsConstants.S_ISREG(st.st_mode) || st.st_size > 4096) null else f.readText()
            }.getOrNull()
            val rec = ManagedServices.parseRecord(text)
            rec != null && (rec.stoppedAt == null || rec.haltStop)
        }
    }

    /**
     * BOOT_COMPLETED: a `boot` line for each known service, an on-device
     * verification pass (logged; audited when it fails), and the tick alarm
     * re-armed (a reboot cleared it). [done] runs on the ledger thread when
     * finished (the receiver's goAsync).
     */
    fun onBoot(context: Context, done: () -> Unit) {
        val app = context.applicationContext
        try {
            for (svc in knownServices(app)) {
                record(app, svc) { ManagedServiceSupervisor.residencySample(app, svc, "boot", null, withHealth = false) }
            }
            executor.execute {
                try {
                    ensureArmed(app, force = true)
                } catch (e: Throwable) {
                    Log.w(TAG, "residency boot arm failed type=${e.javaClass.simpleName}")
                } finally {
                    // The broadcast is released here; the verification below is
                    // best-effort (one Keystore MAC per line can take a while).
                    runCatching(done)
                }
            }
            executor.execute {
                try {
                    for (svc in knownServices(app)) {
                        val v = verifyOnDevice(app, svc) ?: continue
                        Log.i(TAG, "$svc: residency verify lines=${v.lines} chainOk=${v.chainOk} brokenAt=${v.brokenAtSeq} macOk=${v.macOk} macBad=${v.macBad} anchorOk=${v.anchorOk}")
                        if (!v.chainOk || v.macBad > 0 || v.anchorOk == false) {
                            IngressAuditWriter.appendResidencyGuardLine(app, "residency", "verify_failed", svc, null)
                        }
                    }
                } catch (e: Throwable) {
                    Log.w(TAG, "residency boot verification failed type=${e.javaClass.simpleName}")
                }
            }
        } catch (e: Throwable) {
            Log.w(TAG, "residency boot pass not queued type=${e.javaClass.simpleName}")
            runCatching(done)
        }
    }

    /**
     * ACTION_RESIDENCY_TICK: under a partial WakeLock, one `tick` line per
     * known service (with /health for a health-checked one), then the next
     * tick armed while a service is wanted. [done] runs on a background thread
     * when finished (or after [TICK_WAIT_MS] at the latest).
     */
    fun onTick(context: Context, done: () -> Unit) {
        val app = context.applicationContext
        Thread({
            val wl = runCatching {
                (app.getSystemService(Context.POWER_SERVICE) as PowerManager)
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "shelly:residency").apply {
                        setReferenceCounted(false)
                        acquire(WAKE_LOCK_MS)
                    }
            }.getOrNull()
            try {
                for (svc in knownServices(app)) {
                    record(app, svc) { ManagedServiceSupervisor.residencySample(app, svc, "tick", null, withHealth = true) }
                }
                // Wait for the queued lines (the executor is FIFO), bounded.
                val barrier = executor.submit { }
                runCatching { barrier.get(TICK_WAIT_MS, TimeUnit.MILLISECONDS) }
                if (anyWanted(app)) armAt(app, System.currentTimeMillis() + ResidencyLedgerCore.TICK_MS)
            } catch (e: Throwable) {
                Log.w(TAG, "residency tick failed type=${e.javaClass.simpleName}")
            } finally {
                runCatching { if (wl?.isHeld == true) wl.release() }
                runCatching(done)
            }
        }, "ShellyResidencyTick").apply { isDaemon = true; start() }
    }

    // ── Alarm (AgentAlarmScheduler's exact-while-idle pattern) ─────────────

    private fun tickIntent(context: Context): Intent =
        Intent(context, TerminalSessionService::class.java).apply { action = TerminalSessionService.ACTION_RESIDENCY_TICK }

    private fun pendingIntent(context: Context, flags: Int): PendingIntent? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            PendingIntent.getForegroundService(context, REQUEST_CODE, tickIntent(context), flags)
        } else {
            PendingIntent.getService(context, REQUEST_CODE, tickIntent(context), flags)
        }

    /**
     * Arms the next tick one period out while a service is wanted, unless one
     * is already armed for an earlier future time ([force]: re-arm anyway,
     * after a reboot every alarm is gone). Never throws.
     */
    fun ensureArmed(context: Context, force: Boolean = false) {
        try {
            val app = context.applicationContext
            if (!anyWanted(app)) return
            val now = System.currentTimeMillis()
            val target = now + ResidencyLedgerCore.TICK_MS
            if (!force) {
                val armedAt = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getLong(TICK_AT_KEY, 0L)
                val alive = pendingIntent(app, PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE) != null
                if (alive && armedAt > now && armedAt <= target) return
            }
            armAt(app, target)
        } catch (e: Throwable) {
            Log.w(TAG, "residency tick not armed type=${e.javaClass.simpleName}")
        }
    }

    /** [ensureArmed] on the ledger thread (from a supervisor event, which holds its locks). */
    fun ensureArmedLater(context: Context) {
        val app = context.applicationContext
        runCatching { executor.execute { ensureArmed(app) } }
            .onFailure { Log.w(TAG, "residency arm not queued type=${it.javaClass.simpleName}") }
    }

    /**
     * setExactAndAllowWhileIdle when exact alarms are permitted, else
     * setAndAllowWhileIdle (logged: `RESIDENCY_ALARM_INEXACT`), the same
     * fallback AgentAlarmScheduler.setExactWhileIdle uses.
     */
    private fun armAt(context: Context, atMs: Long) {
        val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = pendingIntent(context, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) ?: return
        var exact = false
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M &&
                (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms())
            ) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi)
                exact = true
            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi)
            } else {
                am.set(AlarmManager.RTC_WAKEUP, atMs, pi)
            }
        } catch (e: SecurityException) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, pi)
            else am.set(AlarmManager.RTC_WAKEUP, atMs, pi)
        }
        if (!exact) Log.w(TAG, "RESIDENCY_ALARM_INEXACT at=$atMs (no exact-alarm access)")
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(TICK_AT_KEY, atMs).apply()
    }
}
