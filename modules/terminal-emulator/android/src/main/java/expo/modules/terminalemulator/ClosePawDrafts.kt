package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.system.Os
import android.system.OsConstants
import android.util.Log
import androidx.core.content.FileProvider
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import org.json.JSONArray
import org.json.JSONObject

/**
 * Waiting drafts for ClosePaw's fixed draft routine. Nothing here is specific
 * to any article stream.
 *
 * `shelly save-draft` (scripts/shelly-save-draft.js) writes one file per draft,
 * `$HOME/.shelly-draft-req-<reqId>` (tmp + rename): a meta line, then the request
 * ClosePaw reads. At the first unlock after that ([onUnlock], the runtime
 * ACTION_USER_PRESENT receiver in TerminalSessionService):
 *
 *  1. Up to [MAX_BATCH] items are shown in one [ClosePawShellApprovals] request:
 *     destination, title and content hash of each. Approve is the same notification
 *     action as `shelly closepaw` (device unlock, process-memory nonce), or the
 *     dedicated chat reply. The terminal cannot approve.
 *  2. Each approved item is re-read and must have the approved SHA-256, then goes
 *     out one at a time; ClosePaw answers busy to a second one.
 *
 * Authorization: every queued item needs that approval. Nothing is auto-accepted,
 * and a queue item or file carries no authority, because every process of this
 * uid can write them. Same reason for the gate-protected destinations file: the
 * approval text shows the destination, so the owner's tap is the control and the
 * file only narrows what can be asked. The Substack subdomain comes from that
 * file; a queue item can only select an entry of it. So do the image hosts: an
 * `img` is fetched with the owner's cookies as soon as the editor parses it.
 *
 * Unattended sending is not implemented: it needs an authorization a same-uid
 * process cannot mint (DEFERRED.md, "ClosePaw save-draft").
 *
 * At most once: the item is renamed to `.sending` before the broadcast, and a
 * `.sending` file is never sent again, so a crash loses a draft instead of doubling
 * it. Not started (refusal, including 17 locked and 18 Chrome in use, or no
 * receiver): the item stays and goes at the next unlock, without an activity
 * fallback. No answer in time: the run may have started, so it is tracked as
 * running and ends uncertain, never re-sent.
 *
 * The file is served from a snapshot of the exact hashed bytes. A same-uid process
 * could still swap the snapshot in the seconds before ClosePaw reads it; ClosePaw's
 * own allow-list is what holds then.
 *
 * All state below is confined to [worker].
 */
object ClosePawDrafts {
    private const val TAG = "ClosePawDrafts"

    const val QUEUE_PREFIX = ".shelly-draft-req-"
    private const val SENDING_SUFFIX = ".sending"
    private val QUEUE_FILE_RE = Regex("^\\.shelly-draft-req-[0-9]{10,16}-[0-9a-f]{8}$")
    private val SENDING_FILE_RE = Regex("^\\.shelly-draft-req-[0-9]{10,16}-[0-9a-f]{8}\\.sending$")

    const val DESTINATIONS_FILE = ".shelly/agents/draft-destinations.json"
    private val SUBDOMAIN_RE = Regex("^[a-z0-9-]{1,63}$")

    // Lockstep with ClosePaw's SaveDraftRequestParser and shelly-save-draft.js.
    const val MAX_REQUEST_BYTES = 16 * 1024 * 1024
    private const val MAX_META_BYTES = 1024
    private const val MAX_TITLE_CHARS = 300
    private const val MAX_HTML_CHARS = 1024 * 1024
    private const val MAX_IMAGES = 4
    private const val MAX_IMAGE_HOSTS = 8
    private val REQUEST_KEYS = setOf("version", "title", "html", "images", "image_hosts")
    private val TITLE_CONTROL_RE = Regex("[\\u0000-\\u001F\\u007F-\\u009F]")

    const val MAX_BATCH = 5
    private const val MAX_SHOWN_TITLE_CHARS = 80
    private const val ITEM_MAX_AGE_MS = 24L * 60L * 60L * 1000L
    /** One approval covers retries at later unlocks for this long. */
    private const val APPROVAL_MAX_AGE_MS = 6L * 60L * 60L * 1000L
    private const val NOTICE_ID = 0x37C1A030
    private const val NOTICE_TIMEOUT_MS = 30L * 60L * 1000L

    /**
     * What the owner approved. The hash binds it to one file's content and
     * [subdomain] to the destination the approval text showed.
     */
    data class ApprovedDraft(
        val reqId: String,
        val platform: String,
        val selector: String?,
        val sha256: String,
        val subdomain: String? = null,
    )

    private class Item(
        val draft: ApprovedDraft,
        val title: String,
        val imageHosts: List<String>,
        val request: ByteArray,
    )

    private class RequestShape(val title: String, val imageHosts: List<String>)

    private class Destinations(val subdomains: List<String>, val imageHosts: List<String>)

    private class Batch(val drafts: ArrayDeque<ApprovedDraft>, val approvedAt: Long) {
        var saved = 0
        var check = 0
        var failed = 0
    }

    enum class SendResult { STARTED, MAYBE_STARTED, NOT_STARTED, REFUSED }

    /** Pure mapping of ClosePaw's ordered result. `answered` false: none in time. */
    fun classify(answered: Boolean, code: Int): SendResult = when {
        !answered -> SendResult.MAYBE_STARTED
        code == ClosePawHandoff.RC_STARTED_VIRTUAL_DISPLAY || code == ClosePawHandoff.RC_STARTED_MAIN_DISPLAY -> SendResult.STARTED
        code == ClosePawHandoff.Refusal.UNTRUSTED.resultCode -> SendResult.REFUSED
        code == ClosePawHandoff.RC_NO_RESPONSE || ClosePawHandoff.Refusal.fromCode(code) != null -> SendResult.NOT_STARTED
        else -> SendResult.REFUSED
    }

    private val worker: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ShellyClosePawDrafts").apply { isDaemon = true }
    }
    private val random = SecureRandom()

    @Volatile private var batch: Batch? = null
    /** The draft ClosePaw is working on; its result continues the batch. */
    @Volatile private var runningReqId: String? = null

    private fun post(block: () -> Unit) {
        worker.execute {
            try {
                block()
            } catch (e: Exception) {
                Log.w(TAG, "draft step failed type=${e.javaClass.simpleName}")
            }
        }
    }

    /** Main-thread safe: a directory listing only. */
    fun hasWork(context: Context): Boolean =
        runningReqId != null || batch != null ||
            HomeInitializer.getHomeDir(context).list()?.any { QUEUE_FILE_RE.matches(it) } == true

    fun onUnlock(context: Context) {
        val app = context.applicationContext
        post { unlockStep(app) }
    }

    fun onBatchDecided(context: Context, drafts: List<ApprovedDraft>, approved: Boolean) {
        val app = context.applicationContext
        post {
            if (approved) {
                batch = Batch(ArrayDeque(drafts), System.currentTimeMillis())
                sendNext(app)
            } else {
                for (d in drafts) {
                    itemFile(app, d.reqId).delete()
                    ClosePawRunResults.writeState(app, d.reqId, ClosePawRunResults.STATUS_REJECTED, "The owner rejected this draft; nothing was sent to ClosePaw")
                }
                queueChanged(app)
            }
        }
    }

    /** A final state for any ClosePaw run; only the draft in flight matters here. */
    fun onRunFinished(context: Context, reqId: String, status: String, summary: String?) {
        val app = context.applicationContext
        post {
            if (runningReqId == reqId) {
                runningReqId = null
                cleanUp(app, reqId)
                batch?.let { tally(it, status, summary) }
                sendNext(app)
            }
        }
    }

    private fun unlockStep(app: Context) {
        if (isHalted(app) || runningReqId != null) return
        val open = batch
        if (open != null) {
            if (System.currentTimeMillis() - open.approvedAt <= APPROVAL_MAX_AGE_MS) {
                sendNext(app)
                return
            }
            finishBatch(app, open)
        }
        if (ClosePawShellApprovals.hasPendingDrafts()) return
        if (!ClosePawHandoff.isTrustedVariantInstalled(app)) return
        sweepLeftovers(app)
        val items = readQueue(app)
        if (items.isEmpty()) return
        val batchId = "${System.currentTimeMillis()}-${hex(ByteArray(4).also { random.nextBytes(it) })}"
        ClosePawShellApprovals.create(app, batchId, batchGoal(items), drafts = items.map { it.draft })
    }

    private fun sendNext(app: Context) {
        val open = batch ?: return
        while (true) {
            val draft = open.drafts.firstOrNull()
            if (draft == null) {
                finishBatch(app, open)
                return
            }
            // A later unlock resumes from here.
            if (isHalted(app) || !ClosePawDecisionReceiver.isUnlocked(app)) return
            if (!ClosePawHandoff.isTrustedVariantInstalled(app)) return
            if (!send(app, open, draft)) return
        }
    }

    /** True: this draft is settled, go on with the next one. */
    private fun send(app: Context, open: Batch, draft: ApprovedDraft): Boolean {
        val file = itemFile(app, draft.reqId)
        val item = try {
            readItem(file, draft.reqId, System.currentTimeMillis())
        } catch (e: Exception) {
            null
        }
        val destinations = loadDestinations(app)
        val current = item?.let { withDestination(it.draft, destinations.subdomains) }
        if (item == null || current != draft || !destinations.imageHosts.containsAll(item.imageHosts)) {
            refuse(app, open, draft, "The draft or its destination changed after it was approved; nothing was sent")
            file.delete()
            return true
        }
        val sending = File(file.path + SENDING_SUFFIX)
        if (!file.renameTo(sending)) return false

        val uri = serve(app, draft.reqId, item.request)
        val nonce = ClosePawRunResults.register(draft.reqId)
        ClosePawRunResults.writeState(app, draft.reqId, ClosePawRunResults.STATUS_APPROVED, "Approved; handing off to ClosePaw")
        val intent = ClosePawHandoff.buildSaveDraftBroadcast(app, uri, draft.platform, draft.subdomain, draft.reqId, nonce)
        val answer = try {
            app.grantUriPermission(ClosePawHandoff.PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            ClosePawHandoff.sendSaveDraftBroadcast(app, intent)
        } catch (e: Exception) {
            Log.w(TAG, "draft broadcast failed type=${e.javaClass.simpleName}")
            ClosePawHandoff.SaveDraftAnswer(ClosePawHandoff.RC_NO_RESPONSE, null, false)
        }
        Log.i(TAG, "draft ${draft.reqId} answered rc=${answer?.code} requestBytes=${item.request.size}")
        return when (classify(answer != null, answer?.code ?: ClosePawHandoff.RC_NO_RESPONSE)) {
            SendResult.STARTED -> {
                // ClosePaw read the file before it answered.
                cleanUp(app, draft.reqId)
                open.drafts.removeFirst()
                if (answer?.resultCallback == true) {
                    runningReqId = draft.reqId
                    ClosePawRunResults.writeAfterLaunch(app, draft.reqId, ClosePawRunResults.STATUS_RUNNING, ClosePawHandoff.MSG_BACKGROUND)
                    false
                } else {
                    ClosePawRunResults.forget(draft.reqId)
                    ClosePawRunResults.writeAfterLaunch(app, draft.reqId, ClosePawRunResults.STATUS_UNTRACKED, ClosePawHandoff.MSG_BACKGROUND)
                    open.check++
                    true
                }
            }
            SendResult.MAYBE_STARTED -> {
                // The grant and snapshot stay: ClosePaw may still be reading. The
                // late callback, or the overdue check, ends this in onRunFinished.
                open.drafts.removeFirst()
                runningReqId = draft.reqId
                ClosePawRunResults.writeAfterLaunch(app, draft.reqId, ClosePawRunResults.STATUS_RUNNING, "No answer from ClosePaw yet; the run may have started")
                false
            }
            SendResult.REFUSED -> {
                ClosePawRunResults.forget(draft.reqId)
                cleanUp(app, draft.reqId)
                refuse(app, open, draft, "ClosePaw refused this draft: ${reasonOf(answer?.resultData)}")
                true
            }
            SendResult.NOT_STARTED -> {
                ClosePawRunResults.forget(draft.reqId)
                revokeAndDelete(app, draft.reqId)
                sending.renameTo(file)
                val code = answer?.code ?: ClosePawHandoff.RC_NO_RESPONSE
                val message = ClosePawHandoff.Refusal.fromCode(code)?.message ?: "ClosePaw did not answer - update ClosePaw; Shelly tries again at the next unlock"
                ClosePawRunResults.writeState(app, draft.reqId, ClosePawRunResults.STATUS_QUEUED, message)
                notice(app, app.getString(R.string.closepaw_drafts_held, message))
                false
            }
        }
    }

    private fun refuse(app: Context, open: Batch, draft: ApprovedDraft, message: String) {
        open.drafts.removeFirst()
        open.failed++
        ClosePawRunResults.writeState(app, draft.reqId, ClosePawRunResults.STATUS_FAILED, message)
    }

    private fun tally(open: Batch, status: String, summary: String?) {
        when (status) {
            ClosePawRunResults.STATUS_COMPLETED -> if (imagesMissing(summary)) open.check++ else open.saved++
            ClosePawRunResults.STATUS_UNCERTAIN, ClosePawRunResults.STATUS_TIMEOUT, ClosePawRunResults.STATUS_LOST -> open.check++
            else -> open.failed++
        }
    }

    private fun finishBatch(app: Context, open: Batch) {
        batch = null
        if (open.saved + open.check + open.failed > 0) {
            notice(app, app.getString(R.string.closepaw_drafts_done, open.saved, open.check, open.failed))
        }
        queueChanged(app)
    }

    /** Lets the service stop if it was held only by the queue. */
    private fun queueChanged(app: Context) {
        if (!hasWork(app)) TerminalSessionService.instance?.onDraftQueueDrained()
    }

    /**
     * ClosePaw's summary is JSON from another app: data. Only two counts are read
     * from it; the text is stored sanitized for `shelly closepaw status` and reaches
     * no prompt, shell or URL.
     */
    fun imagesMissing(summary: String?): Boolean = try {
        val o = JSONObject(summary ?: "")
        o.optString("kind") == "save_draft" && o.optInt("images_placed", 0) < o.optInt("images_expected", 0)
    } catch (e: Exception) {
        false
    }

    private val REASON_RE = Regex("^[A-Za-z0-9._-]{1,64}$")

    /** ClosePaw's refusal reason: from a fixed set there, still checked here. */
    private fun reasonOf(raw: String?): String = raw?.takeIf { REASON_RE.matches(it) } ?: "unknown"

    private fun itemFile(app: Context, reqId: String) = File(HomeInitializer.getHomeDir(app), QUEUE_PREFIX + reqId)

    private fun isHalted(app: Context): Boolean = try {
        File(HomeInitializer.getHomeDir(app), ".shelly/agents/.halted").exists()
    } catch (e: Exception) {
        true
    }

    /** Oldest first. Bad and expired items are dropped here, before the owner is asked. */
    private fun readQueue(app: Context): List<Item> {
        val home = HomeInitializer.getHomeDir(app)
        val now = System.currentTimeMillis()
        val destinations = loadDestinations(app)
        val out = ArrayList<Item>()
        for (name in home.list()?.sorted() ?: emptyList()) {
            if (out.size >= MAX_BATCH) break
            if (!QUEUE_FILE_RE.matches(name)) continue
            val reqId = name.removePrefix(QUEUE_PREFIX)
            val file = File(home, name)
            val item = try {
                readItem(file, reqId, now)
            } catch (e: Exception) {
                Log.w(TAG, "unreadable draft $reqId type=${e.javaClass.simpleName}")
                null
            }
            val draft = item?.let { withDestination(it.draft, destinations.subdomains) }
            val hostsAllowed = item != null && destinations.imageHosts.containsAll(item.imageHosts)
            if (item != null && draft != null && hostsAllowed && (draft.platform != "substack" || draft.subdomain != null)) {
                out.add(Item(draft, item.title, item.imageHosts, item.request))
            } else {
                file.delete()
                val message = if (item == null) {
                    "The queued draft was invalid or expired; nothing was sent"
                } else {
                    "This Substack subdomain or image host is not in $DESTINATIONS_FILE; nothing was sent"
                }
                ClosePawRunResults.writeState(app, reqId, ClosePawRunResults.STATUS_EXPIRED, message)
            }
        }
        return out
    }

    /** Null when the item is not one this code would send. */
    private fun readItem(file: File, reqId: String, now: Long): Item? {
        val ageMs = now - (reqId.substringBefore('-').toLongOrNull() ?: return null)
        if (ageMs > ITEM_MAX_AGE_MS || ageMs < -ITEM_MAX_AGE_MS) return null
        if (!OsConstants.S_ISREG(Os.lstat(file.path).st_mode)) return null
        if (file.length() > MAX_REQUEST_BYTES + MAX_META_BYTES) return null
        val bytes = file.readBytes()
        val lineEnd = bytes.indexOf('\n'.code.toByte())
        if (lineEnd !in 1..MAX_META_BYTES) return null
        val meta = JSONObject(String(bytes, 0, lineEnd, Charsets.UTF_8))
        if (meta.optInt("version") != 1 || meta.optString("reqId") != reqId) return null
        val platform = meta.optString("platform")
        if (platform != "note" && platform != "substack") return null
        val selector = if (meta.has("substack")) meta.getString("substack") else null
        if (selector != null && (platform != "substack" || !SUBDOMAIN_RE.matches(selector))) return null
        val request = bytes.copyOfRange(lineEnd + 1, bytes.size)
        if (request.size > MAX_REQUEST_BYTES) return null
        val shape = requestShape(String(request, Charsets.UTF_8)) ?: return null
        return Item(ApprovedDraft(reqId, platform, selector, sha256(request)), shape.title, shape.imageHosts, request)
    }

    /** Shape and limits only. ClosePaw's allow-list decides the HTML. */
    private fun requestShape(text: String): RequestShape? {
        val root = JSONObject(text)
        if (root.optInt("version") != 1) return null
        if (!root.keys().asSequence().all { it in REQUEST_KEYS }) return null
        val title = root.optString("title").trim()
        if (title.isEmpty() || title.length > MAX_TITLE_CHARS || TITLE_CONTROL_RE.containsMatchIn(title)) return null
        if (root.optString("html").length !in 1..MAX_HTML_CHARS) return null
        val images = root.opt("images")
        if (images != null && (images !is JSONArray || images.length() > MAX_IMAGES)) return null
        val hosts = root.opt("image_hosts")
        if (hosts != null && (hosts !is JSONArray || hosts.length() > MAX_IMAGE_HOSTS)) return null
        return RequestShape(title, stringList(hosts as JSONArray?))
    }

    private fun withDestination(draft: ApprovedDraft, allowed: List<String>): ApprovedDraft =
        draft.copy(subdomain = if (draft.platform == "substack") resolveSubdomain(draft.selector, allowed) else null)

    /** The list decides; a selector only names an entry. Null: not allowed. */
    fun resolveSubdomain(selector: String?, allowed: List<String>): String? =
        if (selector != null) selector.takeIf { it in allowed } else allowed.singleOrNull()

    private fun loadDestinations(app: Context): Destinations = try {
        val file = File(HomeInitializer.getHomeDir(app), DESTINATIONS_FILE)
        if (!OsConstants.S_ISREG(Os.lstat(file.path).st_mode) || file.length() > 16L * 1024L) {
            NO_DESTINATIONS
        } else {
            val root = JSONObject(file.readText())
            val names = stringList(root.optJSONArray("substack_subdomains"))
            val hosts = stringList(root.optJSONArray("image_hosts"))
            val valid = root.optInt("version") == 1 && names.all { SUBDOMAIN_RE.matches(it) } && hosts.size <= MAX_IMAGE_HOSTS
            if (valid) Destinations(names, hosts) else NO_DESTINATIONS
        }
    } catch (e: Exception) {
        NO_DESTINATIONS
    }

    private val NO_DESTINATIONS = Destinations(emptyList(), emptyList())

    private fun stringList(list: JSONArray?): List<String> =
        list?.let { items -> (0 until items.length()).map { items.getString(it) } }.orEmpty()

    /** What the owner reads and approves. Titles are hostile text: cleaned and cut. */
    private fun batchGoal(items: List<Item>): String =
        items.joinToString(separator = "; ", prefix = "Save ${items.size} draft(s), publish nothing: ") { item ->
            val d = item.draft
            val where = if (d.platform == "substack") "substack ${d.subdomain}" else d.platform
            val title = ClosePawRunResults.sanitizeSummary(item.title).take(MAX_SHOWN_TITLE_CHARS)
            "[$where] $title (${d.sha256.take(8)})"
        }

    private fun snapshotDir(app: Context, reqId: String) = File(File(app.cacheDir, "share"), "draft-$reqId")

    /** FileProvider path `device_share`. A snapshot of the bytes that were hashed. */
    private fun serve(app: Context, reqId: String, request: ByteArray): Uri {
        val dir = snapshotDir(app, reqId)
        dir.mkdirs()
        val file = File(dir, "request.json")
        file.writeBytes(request)
        return FileProvider.getUriForFile(app, "${app.packageName}.shelly.fileprovider", file)
    }

    private fun revokeAndDelete(app: Context, reqId: String) {
        val dir = snapshotDir(app, reqId)
        try {
            val uri = FileProvider.getUriForFile(app, "${app.packageName}.shelly.fileprovider", File(dir, "request.json"))
            if (Build.VERSION.SDK_INT >= 26) {
                app.revokeUriPermission(ClosePawHandoff.PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            } else {
                app.revokeUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
        } catch (e: Exception) {
            Log.w(TAG, "revoke failed type=${e.javaClass.simpleName}")
        }
        dir.deleteRecursively()
    }

    private fun cleanUp(app: Context, reqId: String) {
        revokeAndDelete(app, reqId)
        File(itemFile(app, reqId).path + SENDING_SUFFIX).delete()
    }

    /** After a crash: a `.sending` file is never sent again; its grant is revoked. */
    private fun sweepLeftovers(app: Context) {
        val home = HomeInitializer.getHomeDir(app)
        for (name in home.list() ?: emptyArray()) {
            if (SENDING_FILE_RE.matches(name)) cleanUp(app, name.removePrefix(QUEUE_PREFIX).removeSuffix(SENDING_SUFFIX))
        }
        val shareDir = File(app.cacheDir, "share")
        for (name in shareDir.list() ?: emptyArray()) {
            if (name.startsWith("draft-")) revokeAndDelete(app, name.removePrefix("draft-"))
        }
    }

    private fun sha256(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    /** Fixed text and counts only, never article text. */
    private fun notice(app: Context, text: String) {
        try {
            val nm = app.getSystemService(NotificationManager::class.java) ?: return
            if (!nm.areNotificationsEnabled()) return
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        ClosePawHandoff.CHANNEL_ID,
                        app.getString(R.string.closepaw_channel_name),
                        NotificationManager.IMPORTANCE_HIGH,
                    ).apply { description = app.getString(R.string.closepaw_channel_description) }
                )
                Notification.Builder(app, ClosePawHandoff.CHANNEL_ID).setTimeoutAfter(NOTICE_TIMEOUT_MS)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(app)
            }
            builder
                .setContentTitle(app.getString(R.string.closepaw_drafts_notice_title))
                .setContentText(text)
                .setStyle(Notification.BigTextStyle().bigText(text))
                .setSmallIcon(android.R.drawable.ic_menu_send)
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
            nm.notify(NOTICE_ID, builder.build())
        } catch (e: Exception) {
            Log.w(TAG, "draft notice failed type=${e.javaClass.simpleName}")
        }
    }
}
