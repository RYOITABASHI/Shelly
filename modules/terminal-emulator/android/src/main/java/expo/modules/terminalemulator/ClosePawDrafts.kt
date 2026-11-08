package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.system.Os
import android.system.OsConstants
import android.util.Log
import androidx.core.content.FileProvider
import expo.modules.terminalemulator.scouter.redactForScouter
import java.io.File
import java.io.FileOutputStream
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
 * uid can write them. The approval text shows destination, image hosts, content
 * hash and title, so the owner's tap decides what goes where.
 *
 * The tap does not make an image safe. An `img` is fetched with the owner's cookies
 * as soon as the editor parses the HTML, and a name in a notification says nothing
 * about what that host does. So image hosts, like the Substack subdomain, must be
 * in the owner's destinations file, read here with every path component checked;
 * a queue item can only select an entry. That file has no stronger protection than
 * the gate and this check: a process that writes it directly can list a host, and
 * only the host shown in the approval reveals that.
 *
 * Without the tap (owner decision 2026-11-08): a destination the owner turned on
 * by typing in the chat ([ClosePawDraftPreapproval], Keystore-MAC'd, native only)
 * skips step 1 for up to its daily cap. [unlockStep] splits the queue: those drafts
 * go as an "auto" batch, the rest are asked for as usual when it ends. The
 * destinations file check, the re-hash before sending and the save-draft broadcast
 * are the same, so nothing here can publish. The owner gets a notice afterwards
 * with what was saved and links to the drafts ([autoNotice]). A queue item can
 * only name a destination; it cannot turn one on or raise the cap.
 *
 * At most once: the item is renamed to `.sending` before the broadcast, and a
 * `.sending` file is never sent again, so a crash loses a draft instead of doubling
 * it. Not started (refusal, including 17 locked and 18 Chrome in use, or no
 * receiver): the item stays and goes at the next unlock, without an activity
 * fallback. `request-too-slow` also means nothing started, and that retry takes a
 * new reqId. No answer, or code 0 (the initial code, which is also what the system
 * reports when it gives up on a slow receiver): the state is unknown, so the nonce
 * stays for a late callback and the draft is never re-sent.
 *
 * The file is served from a snapshot of the exact hashed bytes, in a fresh directory
 * with a random name, and ClosePaw gets the approved SHA-256 to check. The name
 * only stops guessing, since this uid can list the directory; the hash is what makes
 * a swapped snapshot fail.
 *
 * The input is hostile, and this runs from the foreground service's onCreate, so
 * nothing may escape: a Throwable here ends in a deleted item, not a crash loop.
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
    private const val MAX_JSON_DEPTH = 16
    private val IMAGE_HOST_RE = Regex("^[a-z0-9.-]{1,253}$")
    private val REQUEST_KEYS = setOf("version", "title", "html", "images", "image_hosts")
    private val TITLE_CONTROL_RE = Regex("[\\u0000-\\u001F\\u007F-\\u009F]")

    const val MAX_BATCH = 5
    private const val MAX_SHOWN_TITLE_CHARS = 80
    private const val MAX_SHOWN_HOSTS_CHARS = 120
    private const val ITEM_MAX_AGE_MS = 24L * 60L * 60L * 1000L
    private const val STALE_TMP_MS = 60L * 60L * 1000L
    /** Past this a run with no final state is over, even if its state file was removed. */
    private const val RUN_STALE_MS = ClosePawRunResults.MAX_RUN_MS + 60_000L
    private const val MAX_REMOVE_DEPTH = 64
    private val SNAPSHOT_DIR_RE = Regex("^draft-[0-9a-f]{32}$")
    /** One approval covers retries at later unlocks for this long. */
    private const val APPROVAL_MAX_AGE_MS = 6L * 60L * 60L * 1000L
    private const val NOTICE_ID = 0x37C1A030
    private const val AUTO_NOTICE_ID = 0x37C1A031
    private const val REQUEST_CODE_OPEN_DRAFTS = 0x37C1A032
    private const val MAX_NOTICE_LINES = 10
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

    private class Item(val draft: ApprovedDraft, val title: String, val imageHosts: List<String>)

    /** The request bytes live only as long as this, never across a batch. */
    private class Loaded(val item: Item, val request: ByteArray)

    private class RequestShape(val title: String, val imageHosts: List<String>)

    private class Destinations(val subdomains: List<String>, val imageHosts: List<String>)

    /** WAIT: the destinations file is missing or broken, which may be passing. */
    private enum class Fit { OK, WAIT, REFUSED }

    /**
     * [auto]: sent without the tap under [ClosePawDraftPreapproval]. [labels] and
     * [outcomes] are for its notice afterwards: "[where] title", cleaned.
     */
    private class Batch(
        val drafts: ArrayDeque<ApprovedDraft>,
        val approvedAt: Long,
        val auto: Boolean = false,
        val labels: HashMap<String, String> = HashMap(),
    ) {
        var saved = 0
        var check = 0
        var failed = 0
        val outcomes = ArrayList<String>()
        val destinations = LinkedHashSet<String>()
    }

    enum class SendResult { STARTED, MAYBE_STARTED, NOT_STARTED, TOO_SLOW, REFUSED }

    /**
     * Pure mapping of ClosePaw's ordered result. `answered` false: none in time. Code 0
     * is ambiguous once the broadcast went out, because [ClosePawHandoff.isSaveDraftReceiverInstalled]
     * ruled out a missing receiver first: it means the system gave up on a slow one.
     */
    fun classify(answered: Boolean, code: Int, reason: String? = null): SendResult = when {
        !answered || code == ClosePawHandoff.RC_NO_RESPONSE -> SendResult.MAYBE_STARTED
        code == ClosePawHandoff.RC_STARTED_VIRTUAL_DISPLAY || code == ClosePawHandoff.RC_STARTED_MAIN_DISPLAY -> SendResult.STARTED
        code == ClosePawHandoff.Refusal.UNTRUSTED.resultCode ->
            if (reason == ClosePawHandoff.SAVE_DRAFT_REASON_TOO_SLOW) SendResult.TOO_SLOW else SendResult.REFUSED
        ClosePawHandoff.Refusal.fromCode(code) != null -> SendResult.NOT_STARTED
        else -> SendResult.REFUSED
    }

    private val worker: ExecutorService = Executors.newSingleThreadExecutor { r ->
        Thread(r, "ShellyClosePawDrafts").apply { isDaemon = true }
    }
    private val random = SecureRandom()

    @Volatile private var batch: Batch? = null
    /** The draft ClosePaw is working on; its result continues the batch. */
    @Volatile private var runningReqId: String? = null
    private var runningSince = 0L
    /** reqId -> the random snapshot directory being served. */
    private val snapshots = HashMap<String, File>()

    private fun post(block: () -> Unit) {
        worker.execute {
            try {
                block()
            } catch (e: Throwable) {
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
                    removeEntry(itemFile(app, d.reqId))
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
            if (runningReqId == reqId) finishRun(app, reqId, status, summary)
        }
    }

    private fun finishRun(app: Context, reqId: String, status: String, summary: String?) {
        runningReqId = null
        cleanUp(app, reqId)
        batch?.let { tally(it, reqId, status, summary) }
        sendNext(app)
    }

    /**
     * Everything is re-read from disk: the broadcast that got us here says nothing but
     * "maybe unlocked". Clean-up comes first, so that it also happens with no ClosePaw.
     */
    private fun unlockStep(app: Context) {
        sweepExpired(app)
        if (isHalted(app) || !ClosePawDecisionReceiver.isUnlocked(app)) return
        val running = runningReqId
        if (running != null) {
            if (System.currentTimeMillis() - runningSince > RUN_STALE_MS) {
                ClosePawRunResults.forget(running)
                ClosePawRunResults.writeState(app, running, ClosePawRunResults.STATUS_TIMEOUT, "No final state from ClosePaw; check your drafts")
                finishRun(app, running, ClosePawRunResults.STATUS_TIMEOUT, null)
            }
            return
        }
        val open = batch
        if (open != null) {
            if (System.currentTimeMillis() - open.approvedAt <= APPROVAL_MAX_AGE_MS) {
                sendNext(app)
                return
            }
            finishBatch(app, open, resume = false)
        }
        if (ClosePawShellApprovals.hasPendingDrafts()) return
        if (!ClosePawHandoff.isTrustedVariantInstalled(app)) return
        sweepLeftovers(app)
        val items = readQueue(app)
        if (items.isEmpty()) return
        val auto = preapproved(app, items)
        if (auto.isNotEmpty()) startAutoBatch(app, auto) else requestApproval(app, items)
    }

    fun destinationKey(draft: ApprovedDraft): String? = ClosePawDraftPreapproval.destinationKey(draft.platform, draft.subdomain)

    /**
     * The drafts whose destination the owner turned on, within today's cap. The
     * count is stored before anything goes, so a crash can only use the cap up.
     */
    private fun preapproved(app: Context, items: List<Item>): List<Item> {
        // A draft with image hosts always asks: the editor fetches those with the
        // owner's cookies, and the hosts come from a file any process of this uid
        // can edit, so only the approval line shows them to the owner.
        val keys = items.map { if (it.imageHosts.isEmpty()) destinationKey(it.draft) else null }
        if (keys.none { ClosePawDraftPreapproval.isOn(app, it) }) return emptyList()
        val mask = ClosePawDraftPreapproval.reserve(app, keys)
        return items.filterIndexed { i, _ -> mask[i] }
    }

    /** No tap: the same send path as an approved batch. */
    private fun startAutoBatch(app: Context, items: List<Item>) {
        val labels = HashMap<String, String>()
        for (item in items) labels[item.draft.reqId] = noticeLabel(item)
        Log.i(TAG, "sending ${items.size} pre-approved draft(s) without a tap")
        for (item in items) {
            ClosePawRunResults.writeState(app, item.draft.reqId, ClosePawRunResults.STATUS_QUEUED, "Pre-approved destination; sending without a tap")
        }
        batch = Batch(ArrayDeque(items.map { it.draft }), System.currentTimeMillis(), auto = true, labels = labels)
        sendNext(app)
    }

    /** Every batch asks the owner. Its answer arrives in [onBatchDecided]. */
    private fun requestApproval(app: Context, items: List<Item>) {
        val batchId = "${System.currentTimeMillis()}-${hex(ByteArray(4).also { random.nextBytes(it) })}"
        val lines = items.map(::approvalLine)
        ClosePawShellApprovals.create(app, batchId, batchGoal(lines), drafts = items.map { it.draft }, lines = lines)
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
            if (open.auto && !ClosePawDraftPreapproval.isOn(app, destinationKey(draft))) {
                // Turned off since: the item stays queued and is asked for as usual.
                open.drafts.removeFirst()
                open.labels.remove(draft.reqId)
                continue
            }
            val settled = try {
                send(app, open, draft)
            } catch (e: Throwable) {
                abandon(app, open, draft, e)
            }
            if (!settled) return
        }
    }

    /** An item that blew up is deleted, so it cannot do so again at the next unlock. */
    private fun abandon(app: Context, open: Batch, draft: ApprovedDraft, e: Throwable): Boolean {
        Log.w(TAG, "draft ${draft.reqId} failed type=${e.javaClass.simpleName}")
        if (runningReqId == draft.reqId) return false
        ClosePawRunResults.forget(draft.reqId)
        cleanUp(app, draft.reqId)
        removeEntry(itemFile(app, draft.reqId))
        if (open.drafts.firstOrNull() == draft) {
            refuse(app, open, draft, "This draft could not be sent; check your drafts")
        }
        return true
    }

    /** True: this draft is settled, go on with the next one. */
    private fun send(app: Context, open: Batch, draft: ApprovedDraft): Boolean {
        val file = itemFile(app, draft.reqId)
        val loaded = try {
            readItem(file, draft.reqId, System.currentTimeMillis())
        } catch (e: Throwable) {
            null
        }
        val destinations = loadDestinations(app)
        val fit = loaded?.let { fit(it.item.draft, it.item.imageHosts, destinations) } ?: Fit.REFUSED
        if (fit == Fit.WAIT) {
            hold(app, draft, "$DESTINATIONS_FILE is missing or unreadable - fix it; Shelly tries again at the next unlock")
            return false
        }
        val current = loaded?.let { withDestination(it.item.draft, destinations?.subdomains.orEmpty()) }
        if (loaded == null || fit != Fit.OK || current != draft) {
            refuse(app, open, draft, "The draft or its destination changed after it was approved; nothing was sent")
            removeEntry(file)
            return true
        }
        if (!ClosePawHandoff.isSaveDraftReceiverInstalled(app)) {
            hold(app, draft, "This ClosePaw build cannot save drafts - update ClosePaw; Shelly tries again at the next unlock")
            return false
        }
        val sending = File(file.path + SENDING_SUFFIX)
        if (!file.renameTo(sending)) return false

        val uri = serve(app, draft.reqId, loaded.request)
        val notStarted = { message: String ->
            ClosePawRunResults.forget(draft.reqId)
            revokeAndDelete(app, draft.reqId)
            sending.renameTo(file)
            hold(app, draft, message)
        }
        try {
            app.grantUriPermission(ClosePawHandoff.PACKAGE, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        } catch (e: Exception) {
            Log.w(TAG, "draft grant failed type=${e.javaClass.simpleName}")
            notStarted("Shelly could not share the draft with ClosePaw; it tries again at the next unlock")
            return false
        }
        val nonce = ClosePawRunResults.register(draft.reqId)
        ClosePawRunResults.writeState(app, draft.reqId, ClosePawRunResults.STATUS_APPROVED, "Approved; handing off to ClosePaw")
        val intent = ClosePawHandoff.buildSaveDraftBroadcast(app, uri, draft.platform, draft.subdomain, draft.reqId, nonce, draft.sha256)
        val answer = try {
            ClosePawHandoff.sendSaveDraftBroadcast(app, intent)
        } catch (e: Exception) {
            // It may or may not have gone out, which is the same as no answer.
            Log.w(TAG, "draft broadcast failed type=${e.javaClass.simpleName}")
            null
        }
        Log.i(TAG, "draft ${draft.reqId} answered rc=${answer?.code} requestBytes=${loaded.request.size}")
        return when (classify(answer != null, answer?.code ?: ClosePawHandoff.RC_NO_RESPONSE, answer?.resultData)) {
            SendResult.STARTED -> {
                // ClosePaw read the file before it answered.
                cleanUp(app, draft.reqId)
                open.drafts.removeFirst()
                if (answer?.resultCallback == true) {
                    markRunning(draft.reqId)
                    ClosePawRunResults.writeAfterLaunch(app, draft.reqId, ClosePawRunResults.STATUS_RUNNING, ClosePawHandoff.MSG_BACKGROUND)
                    false
                } else {
                    ClosePawRunResults.forget(draft.reqId)
                    ClosePawRunResults.writeAfterLaunch(app, draft.reqId, ClosePawRunResults.STATUS_UNTRACKED, ClosePawHandoff.MSG_BACKGROUND)
                    open.check++
                    record(open, draft, "?")
                    true
                }
            }
            SendResult.MAYBE_STARTED -> {
                // The grant and snapshot stay: ClosePaw may still be reading. The
                // late callback, or the overdue check, ends this in onRunFinished.
                open.drafts.removeFirst()
                markRunning(draft.reqId)
                ClosePawRunResults.writeAfterLaunch(app, draft.reqId, ClosePawRunResults.STATUS_RUNNING, "No answer from ClosePaw yet; the run may have started")
                false
            }
            SendResult.REFUSED -> {
                ClosePawRunResults.forget(draft.reqId)
                cleanUp(app, draft.reqId)
                refuse(app, open, draft, "ClosePaw refused this draft: ${reasonOf(answer?.resultData)}")
                true
            }
            SendResult.TOO_SLOW -> {
                ClosePawRunResults.forget(draft.reqId)
                revokeAndDelete(app, draft.reqId)
                retryUnderNewId(app, open, draft, sending, loaded.request)
                false
            }
            SendResult.NOT_STARTED -> {
                notStarted(ClosePawHandoff.Refusal.fromCode(answer?.code ?: ClosePawHandoff.RC_NO_RESPONSE)?.message.orEmpty())
                false
            }
        }
    }

    /**
     * ClosePaw wants a new reqId for this retry. The bytes and their approved hash do not
     * change, and the creation time stays in the id, so the item expires when it would have.
     */
    private fun retryUnderNewId(app: Context, open: Batch, draft: ApprovedDraft, sending: File, request: ByteArray) {
        val reqId = "${draft.reqId.substringBefore('-')}-${hex(ByteArray(4).also { random.nextBytes(it) })}"
        val meta = JSONObject().put("version", 1).put("reqId", reqId).put("platform", draft.platform)
        if (draft.selector != null) meta.put("substack", draft.selector)
        val target = itemFile(app, reqId)
        val tmp = File(target.path + ".tmp")
        val fd = Os.open(tmp.path, OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_WRONLY, 384) // 0600
        FileOutputStream(fd).use {
            it.write((meta.toString() + "\n").toByteArray(Charsets.UTF_8))
            it.write(request)
        }
        Os.rename(tmp.path, target.path)
        removeEntry(sending)
        ClosePawRunResults.writeState(app, draft.reqId, ClosePawRunResults.STATUS_FAILED, "ClosePaw ran out of time and nothing started; retrying as request $reqId")
        val next = draft.copy(reqId = reqId)
        open.labels.remove(draft.reqId)?.let { open.labels[reqId] = it }
        open.drafts[0] = next
        hold(app, next, "ClosePaw ran out of time reading the draft and nothing started; Shelly tries again at the next unlock")
    }

    private fun markRunning(reqId: String) {
        runningReqId = reqId
        runningSince = System.currentTimeMillis()
    }

    /** Stays first in the batch; [unlockStep] resumes it. */
    private fun hold(app: Context, draft: ApprovedDraft, message: String) {
        ClosePawRunResults.writeState(app, draft.reqId, ClosePawRunResults.STATUS_QUEUED, message)
        notice(app, app.getString(R.string.closepaw_drafts_held, message))
    }

    private fun refuse(app: Context, open: Batch, draft: ApprovedDraft, message: String) {
        open.drafts.removeFirst()
        open.failed++
        record(open, draft, "x")
        ClosePawRunResults.writeState(app, draft.reqId, ClosePawRunResults.STATUS_FAILED, message)
    }

    private fun tally(open: Batch, reqId: String, status: String, summary: String?) {
        val mark = when (status) {
            ClosePawRunResults.STATUS_COMPLETED -> if (imagesMissing(summary)) "?" else "ok"
            ClosePawRunResults.STATUS_UNCERTAIN, ClosePawRunResults.STATUS_TIMEOUT, ClosePawRunResults.STATUS_LOST -> "?"
            else -> "x"
        }
        when (mark) {
            "ok" -> open.saved++
            "?" -> open.check++
            else -> open.failed++
        }
        recordLabel(open, reqId, mark)
    }

    /** Auto batches only: one cleaned line per draft for the notice afterwards. */
    private fun record(open: Batch, draft: ApprovedDraft, mark: String) {
        if (!open.auto) return
        destinationKey(draft)?.let { open.destinations.add(it) }
        recordLabel(open, draft.reqId, mark)
    }

    private fun recordLabel(open: Batch, reqId: String, mark: String) {
        if (!open.auto) return
        val label = open.labels.remove(reqId) ?: return
        open.outcomes.add("$mark $label")
        if (label.startsWith("[note]")) {
            open.destinations.add("note")
        } else {
            LABEL_SUBSTACK_RE.find(label)?.let { open.destinations.add("substack:" + it.groupValues[1]) }
        }
    }

    private val LABEL_SUBSTACK_RE = Regex("^\\[substack ([a-z0-9-]{1,63})]")

    /**
     * [resume]: after an auto batch, drafts that were not pre-approved (or over the
     * cap) are asked for right away instead of at the next unlock.
     */
    private fun finishBatch(app: Context, open: Batch, resume: Boolean = true) {
        batch = null
        if (open.auto) {
            autoNotice(app, open)
            if (resume) post { unlockStep(app) }
        } else if (open.saved + open.check + open.failed > 0) {
            notice(app, app.getString(R.string.closepaw_drafts_done, open.saved, open.check, open.failed))
        }
        queueChanged(app)
    }

    /** Fixed URLs only; the subdomain is one the destinations file allowed. */
    fun draftsUrl(dest: String): String? = when {
        dest == "note" -> "https://note.com/notes"
        dest.startsWith("substack:") && ClosePawDraftPreapproval.isValidDest(dest) ->
            "https://${dest.removePrefix("substack:")}.substack.com/publish/posts/drafts"
        else -> null
    }

    private fun noticeLabel(item: Item): String {
        val d = item.draft
        val where = if (d.platform == "substack") "substack ${d.subdomain}" else d.platform
        return "[$where] ${displayText(item.title, MAX_SHOWN_TITLE_CHARS)}"
    }

    /**
     * What was saved without a tap, with links to the drafts. Titles are the queue's
     * text, cleaned like the approval lines. A link only opens the drafts list.
     */
    private fun autoNotice(app: Context, open: Batch) {
        if (open.saved + open.check + open.failed == 0) return
        try {
            val nm = app.getSystemService(NotificationManager::class.java) ?: return
            if (!nm.areNotificationsEnabled()) return
            val urls = open.destinations.mapNotNull { draftsUrl(it) }
            val summary = app.getString(R.string.closepaw_drafts_auto_done, open.saved, open.check, open.failed)
            val body = buildString {
                append(summary)
                for (line in open.outcomes.take(MAX_NOTICE_LINES)) append('\n').append(line.redactForScouter())
                for (url in urls) append('\n').append(url)
                append('\n').append(app.getString(R.string.closepaw_drafts_auto_off_hint))
            }
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                nm.createNotificationChannel(
                    NotificationChannel(
                        ClosePawHandoff.CHANNEL_ID,
                        app.getString(R.string.closepaw_channel_name),
                        NotificationManager.IMPORTANCE_HIGH,
                    ).apply { description = app.getString(R.string.closepaw_channel_description) }
                )
                Notification.Builder(app, ClosePawHandoff.CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(app)
            }
            builder
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setContentTitle(app.getString(R.string.closepaw_drafts_auto_title))
                .setContentText(summary)
                .setStyle(Notification.BigTextStyle().bigText(body))
                .setSmallIcon(android.R.drawable.ic_menu_send)
                .setOnlyAlertOnce(true)
                .setAutoCancel(true)
            for ((i, url) in urls.take(2).withIndex()) {
                val pi = PendingIntent.getActivity(
                    app,
                    REQUEST_CODE_OPEN_DRAFTS + i,
                    Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                if (i == 0) builder.setContentIntent(pi)
                val label = app.getString(
                    if (url.contains(".substack.com/")) R.string.closepaw_drafts_open_substack else R.string.closepaw_drafts_open_note,
                )
                @Suppress("DEPRECATION")
                builder.addAction(Notification.Action.Builder(null as android.graphics.drawable.Icon?, label, pi).build())
            }
            nm.notify(AUTO_NOTICE_ID, builder.build())
        } catch (e: Exception) {
            Log.w(TAG, "auto draft notice failed type=${e.javaClass.simpleName}")
        }
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
    } catch (e: Throwable) {
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

    /** By name only, so it stays cheap and runs with or without ClosePaw. */
    private fun sweepExpired(app: Context) {
        val home = HomeInitializer.getHomeDir(app)
        val now = System.currentTimeMillis()
        var removed = false
        for (name in home.list() ?: emptyArray()) {
            val file = File(home, name)
            if (QUEUE_FILE_RE.matches(name)) {
                val reqId = name.removePrefix(QUEUE_PREFIX)
                if (!isFresh(reqId, now)) {
                    removeEntry(file)
                    ClosePawRunResults.writeState(app, reqId, ClosePawRunResults.STATUS_EXPIRED, "The queued draft expired; nothing was sent")
                    removed = true
                }
            } else if (name.startsWith(QUEUE_PREFIX) && name.endsWith(".tmp") && now - file.lastModified() > STALE_TMP_MS) {
                removeEntry(file)
            }
        }
        if (removed) queueChanged(app)
    }

    private fun isFresh(reqId: String, now: Long): Boolean {
        val createdAt = reqId.substringBefore('-').toLongOrNull() ?: return false
        return now - createdAt in -ITEM_MAX_AGE_MS..ITEM_MAX_AGE_MS
    }

    /**
     * Oldest first. Anything unusable is deleted here, before the owner is asked,
     * whatever went wrong while reading it. A Substack item waits instead while the
     * destinations file is missing or broken, until it expires.
     */
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
                readItem(file, reqId, now)?.item
            } catch (e: Throwable) {
                Log.w(TAG, "unreadable draft $reqId type=${e.javaClass.simpleName}")
                null
            }
            val fit = item?.let { fit(it.draft, it.imageHosts, destinations) } ?: Fit.REFUSED
            when {
                fit == Fit.OK && item != null ->
                    out.add(Item(withDestination(item.draft, destinations?.subdomains.orEmpty()), item.title, item.imageHosts))
                fit == Fit.REFUSED -> {
                    removeEntry(file)
                    val message = if (item == null) {
                        "The queued draft was invalid; nothing was sent"
                    } else {
                        "This Substack subdomain or image host is not allowed by $DESTINATIONS_FILE; nothing was sent"
                    }
                    ClosePawRunResults.writeState(app, reqId, ClosePawRunResults.STATUS_FAILED, message)
                }
            }
        }
        return out
    }

    private fun fit(draft: ApprovedDraft, imageHosts: List<String>, destinations: Destinations?): Fit = when {
        draft.platform != "substack" -> if (imageHosts.isEmpty()) Fit.OK else Fit.REFUSED
        destinations == null -> Fit.WAIT
        resolveSubdomain(draft.selector, destinations.subdomains) == null -> Fit.REFUSED
        !destinations.imageHosts.containsAll(imageHosts) -> Fit.REFUSED
        else -> Fit.OK
    }

    /**
     * False when the nesting is too deep for org.json, whose parser recurses. Android's
     * tokenizer also takes comments and single quotes, which this scan does not model,
     * so this is the cheap first check and the Throwable handlers are the guarantee.
     */
    fun jsonDepthWithin(bytes: ByteArray, from: Int, to: Int, limit: Int): Boolean {
        var depth = 0
        var inString = false
        var escaped = false
        for (i in from until to) {
            val c = bytes[i].toInt()
            if (inString) {
                when {
                    escaped -> escaped = false
                    c == '\\'.code -> escaped = true
                    c == '"'.code -> inString = false
                }
            } else if (c == '"'.code) {
                inString = true
            } else if (c == '{'.code || c == '['.code) {
                depth++
                if (depth > limit) return false
            } else if (c == '}'.code || c == ']'.code) {
                depth--
            }
        }
        return true
    }

    /** Null when the item is not one this code would send. */
    private fun readItem(file: File, reqId: String, now: Long): Loaded? {
        if (!isFresh(reqId, now)) return null
        if (!OsConstants.S_ISREG(Os.lstat(file.path).st_mode)) return null
        if (file.length() > MAX_REQUEST_BYTES + MAX_META_BYTES) return null
        val bytes = file.readBytes()
        val lineEnd = bytes.indexOf('\n'.code.toByte())
        if (lineEnd !in 1..MAX_META_BYTES) return null
        if (!jsonDepthWithin(bytes, 0, bytes.size, MAX_JSON_DEPTH)) return null
        val meta = JSONObject(String(bytes, 0, lineEnd, Charsets.UTF_8))
        if (meta.optInt("version") != 1 || meta.optString("reqId") != reqId) return null
        val platform = meta.optString("platform")
        if (platform != "note" && platform != "substack") return null
        val selector = if (meta.has("substack")) meta.getString("substack") else null
        if (selector != null && (platform != "substack" || !SUBDOMAIN_RE.matches(selector))) return null
        val request = bytes.copyOfRange(lineEnd + 1, bytes.size)
        if (request.size > MAX_REQUEST_BYTES) return null
        val shape = requestShape(String(request, Charsets.UTF_8)) ?: return null
        return Loaded(Item(ApprovedDraft(reqId, platform, selector, sha256(request)), shape.title, shape.imageHosts), request)
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

    /** For [ClosePawDraftPreapproval.enableFromChat]: null when the destinations file is missing or broken. */
    fun allowedSubdomains(context: Context): List<String>? = loadDestinations(context.applicationContext)?.subdomains

    /** The list decides; a selector only names an entry. Null: not allowed. */
    fun resolveSubdomain(selector: String?, allowed: List<String>): String? =
        if (selector != null) selector.takeIf { it in allowed } else allowed.singleOrNull()

    /**
     * Null when the file is missing, broken or not where it should be. The gate matches
     * command text, so a symlinked parent gets past it: every component below home must
     * be the real thing, and the canonical path must land inside `.shelly/agents`.
     */
    private fun loadDestinations(app: Context): Destinations? = try {
        val home = HomeInitializer.getHomeDir(app).canonicalFile
        val agents = File(home, ".shelly/agents")
        val file = File(home, DESTINATIONS_FILE)
        val realComponents = OsConstants.S_ISDIR(Os.lstat(File(home, ".shelly").path).st_mode) &&
            OsConstants.S_ISDIR(Os.lstat(agents.path).st_mode) &&
            OsConstants.S_ISREG(Os.lstat(file.path).st_mode)
        if (!realComponents || file.canonicalFile != file || file.length() > 16L * 1024L) {
            null
        } else {
            val bytes = file.readBytes()
            if (!jsonDepthWithin(bytes, 0, bytes.size, MAX_JSON_DEPTH)) {
                null
            } else {
                val root = JSONObject(String(bytes, Charsets.UTF_8))
                val names = stringList(root.optJSONArray("substack_subdomains"))
                val hosts = stringList(root.optJSONArray("image_hosts"))
                val valid = root.optInt("version") == 1 && names.all { SUBDOMAIN_RE.matches(it) } &&
                    hosts.size <= MAX_IMAGE_HOSTS && hosts.all { IMAGE_HOST_RE.matches(it) }
                if (valid) Destinations(names, hosts) else null
            }
        }
    } catch (e: Throwable) {
        null
    }

    private fun stringList(list: JSONArray?): List<String> =
        list?.let { items -> (0 until items.length()).map { items.getString(it) } }.orEmpty()

    /**
     * Hostile text on one line: every kind of space (U+3000 and NBSP included), line
     * separator and control becomes one space; format characters (bidi, zero-width,
     * U+061C) and lone surrogates go. Cut by code point, so no pair is split.
     */
    fun displayText(raw: String, maxCodePoints: Int): String {
        val out = StringBuilder()
        var count = 0
        var space = false
        var i = 0
        while (i < raw.length && count < maxCodePoints) {
            val cp = raw.codePointAt(i)
            i += Character.charCount(cp)
            when (Character.getType(cp)) {
                Character.SPACE_SEPARATOR.toInt(), Character.LINE_SEPARATOR.toInt(),
                Character.PARAGRAPH_SEPARATOR.toInt(), Character.CONTROL.toInt() -> space = out.isNotEmpty()
                Character.FORMAT.toInt(), Character.SURROGATE.toInt() -> Unit
                else -> {
                    if (space) {
                        out.append(' ')
                        count++
                        space = false
                    }
                    out.appendCodePoint(cp)
                    count++
                }
            }
        }
        return out.toString()
    }

    /**
     * One approval line. The parts the owner decides on come first, because the
     * notification cuts a long line at its end and the title is the attacker's text.
     */
    private fun approvalLine(item: Item): String {
        val d = item.draft
        val where = if (d.platform == "substack") "substack ${d.subdomain}" else d.platform
        val hosts = if (item.imageHosts.isEmpty()) {
            ""
        } else {
            " images: " + displayText(item.imageHosts.joinToString(", "), MAX_SHOWN_HOSTS_CHARS)
        }
        return "[$where] ${d.sha256.take(8)}$hosts | ${displayText(item.title, MAX_SHOWN_TITLE_CHARS)}"
    }

    /** For the chat and the hash; the notification shows [approvalLine] line by line. */
    private fun batchGoal(lines: List<String>): String =
        lines.joinToString(separator = "; ", prefix = "Save ${lines.size} draft(s), publish nothing: ")

    private fun newSnapshotDir(app: Context): File {
        val share = File(app.cacheDir, "share")
        share.mkdirs()
        if (!OsConstants.S_ISDIR(Os.lstat(share.path).st_mode)) throw java.io.IOException("share is not a directory")
        val dir = File(share, "draft-" + hex(ByteArray(16).also { random.nextBytes(it) }))
        Os.mkdir(dir.path, 448) // 0700; fails if the name exists, link or not.
        return dir
    }

    /**
     * FileProvider path `device_share`. A snapshot of the bytes that were hashed, in a
     * directory made here. O_EXCL refuses anything already at the path, a link included.
     */
    private fun serve(app: Context, reqId: String, request: ByteArray): Uri {
        val dir = newSnapshotDir(app)
        snapshots[reqId] = dir
        val file = File(dir, "request.json")
        val fd = Os.open(file.path, OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_WRONLY, 384) // 0600
        FileOutputStream(fd).use { it.write(request) }
        return FileProvider.getUriForFile(app, "${app.packageName}.shelly.fileprovider", file)
    }

    private fun revokeAndDelete(app: Context, reqId: String) {
        snapshots.remove(reqId)?.let { revokeAndDeleteDir(app, it) }
    }

    private fun revokeAndDeleteDir(app: Context, dir: File) {
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
        removeEntry(dir)
    }

    /** Never follows a link. File.deleteRecursively would walk into a planted one. */
    private fun removeEntry(file: File, depth: Int = 0) {
        val mode = try {
            Os.lstat(file.path).st_mode
        } catch (e: Exception) {
            return
        }
        if (OsConstants.S_ISDIR(mode) && depth < MAX_REMOVE_DEPTH) {
            file.list()?.forEach { removeEntry(File(file, it), depth + 1) }
        }
        file.delete()
    }

    private fun cleanUp(app: Context, reqId: String) {
        revokeAndDelete(app, reqId)
        removeEntry(File(itemFile(app, reqId).path + SENDING_SUFFIX))
    }

    /** After a crash: a `.sending` file is never sent again; its grant is revoked. */
    private fun sweepLeftovers(app: Context) {
        val home = HomeInitializer.getHomeDir(app)
        for (name in home.list() ?: emptyArray()) {
            if (SENDING_FILE_RE.matches(name)) cleanUp(app, name.removePrefix(QUEUE_PREFIX).removeSuffix(SENDING_SUFFIX))
        }
        val shareDir = File(app.cacheDir, "share")
        for (name in shareDir.list() ?: emptyArray()) {
            if (SNAPSHOT_DIR_RE.matches(name)) revokeAndDeleteDir(app, File(shareDir, name))
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
