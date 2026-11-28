package expo.modules.terminalemulator

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject

/**
 * The Android half of the lock-screen approval (McpLockScreenApproval): the
 * in-process registry of open prompts (one per request, keyed by a random
 * handle that the activity's intent carries — never the callId), the
 * full-screen notification that opens McpLockScreenApprovalActivity over the
 * keyguard, and the texts the prompt shows (RN's dialog fields: summary,
 * detail, origin, client token id).
 */
internal object McpLockScreenPrompt {
    private const val TAG = "McpLockScreenPrompt"
    const val CHANNEL_ID = "mcp_lock_screen_approval"
    const val EXTRA_HANDLE = "dev.shelly.terminal.extra.MCP_LOCK_APPROVAL_HANDLE"
    /** Notification ids 0x4D43_0000.. (one per prompt). */
    private const val NOTIFICATION_BASE = 0x4D430000

    class Entry internal constructor(
        val handle: String,
        val callId: String,
        val tool: String,
        val principal: String,
        val summary: String,
        val detail: String,
        val machine: McpLockScreenApproval.Machine,
        val notificationId: Int,
    ) {
        @Volatile var closed = false
            internal set
        internal val closeListeners = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()
    }

    private val entries = ConcurrentHashMap<String, Entry>()
    private val random = SecureRandom()
    private val nextId = java.util.concurrent.atomic.AtomicInteger(0)

    fun get(handle: String?): Entry? = handle?.let { entries[it] }

    /**
     * Null when the prompt can be shown now: notifications on and (Android 14+)
     * the full-screen-intent access granted. Else McpInstallOpDecision.FG_*.
     */
    fun blocker(context: Context): String? {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return McpInstallOpDecision.FG_NOTIFICATIONS_OFF
        if (!nm.areNotificationsEnabled()) return McpInstallOpDecision.FG_NOTIFICATIONS_OFF
        if (Build.VERSION.SDK_INT >= 34 && !nm.canUseFullScreenIntent()) return McpInstallOpDecision.FG_NO_FULL_SCREEN_INTENT
        return null
    }

    /** Registers the prompt and posts its full-screen notification. Null when posting failed (nothing left behind). */
    fun open(context: Context, request: McpTypedOpDecision.Request, expiresAtMs: Long): Entry? {
        val app = context.applicationContext
        val handle = ByteArray(16).also { random.nextBytes(it) }.joinToString("") { "%02x".format(it) }
        val entry = Entry(
            handle, request.callId, request.tool, request.principal,
            summary(app, request.tool), detail(app, request.tool, request.args),
            McpLockScreenApproval.Machine(expiresAtMs), NOTIFICATION_BASE + (nextId.getAndIncrement() and 0xFFFF),
        )
        entries[handle] = entry
        return try {
            post(app, entry)
            entry
        } catch (e: Exception) {
            Log.w(TAG, "lock-screen prompt not posted type=${e.javaClass.simpleName}")
            close(app, entry)
            null
        }
    }

    /** Removes the prompt: notification cancelled, an open activity finishes. Idempotent. */
    fun close(context: Context, entry: Entry) {
        if (entries.remove(entry.handle) == null && entry.closed) return
        entry.closed = true
        runCatching { context.getSystemService(NotificationManager::class.java)?.cancel(entry.notificationId) }
        for (l in entry.closeListeners) runCatching { l() }
    }

    fun auditLine(context: Context, entry: Entry, code: String) {
        val ok = IngressAuditWriter.appendMcpLine(context.applicationContext, null, McpInstallOpDecision.auditJson(entry.tool, entry.principal, code))
        if (!ok) Log.w(TAG, "audit line not written (${entry.tool} $code)")
    }

    private fun post(app: Context, entry: Entry) {
        val nm = app.getSystemService(NotificationManager::class.java) ?: throw IllegalStateException("no notification manager")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(NotificationChannel(
                CHANNEL_ID, app.getString(R.string.mcp_lock_channel_name), NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = app.getString(R.string.mcp_lock_channel_description)
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            })
        }
        val intent = Intent(app, McpLockScreenApprovalActivity::class.java)
            .putExtra(EXTRA_HANDLE, entry.handle)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        val pi = PendingIntent.getActivity(app, entry.notificationId, intent, flags)
        val title = app.getString(R.string.mcp_approval_foreground_overlay)
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(app, CHANNEL_ID) else Notification.Builder(app)
        // On the lock screen only the title shows; the request itself is shown by the activity.
        @Suppress("DEPRECATION")
        val publicVersion = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(app, CHANNEL_ID) else Notification.Builder(app))
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(title)
            .build()
        @Suppress("DEPRECATION")
        builder
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle(title)
            .setContentText(entry.summary)
            .setCategory(Notification.CATEGORY_REMINDER)
            .setPriority(Notification.PRIORITY_HIGH)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setOngoing(true)
            .setAutoCancel(false)
            .setContentIntent(pi)
            .setFullScreenIntent(pi, true)
        nm.notify(entry.notificationId, builder.build())
    }

    /** RN's dialog summary (lib/i18n mcp.approval_*), as string resources. */
    private fun summary(app: Context, tool: String): String = app.getString(when (tool) {
        McpInstallOpDecision.OP_STAGE_INSTALL -> R.string.mcp_lock_summary_stage_install
        McpInstallOpDecision.OP_PIPELINE_CONFIG -> R.string.mcp_lock_summary_update_pipeline_config
        else -> R.string.mcp_lock_summary_update_delivery_script
    })

    /**
     * RN's dialog detail, from the arguments native already validated:
     * update_delivery_script `<stagedPath> → .env.article-delivery.js` (as RN);
     * stage_install the requested path (RN shows the canonical path it
     * resolved; it resolves again after the handoff and refuses a path outside
     * its roots); update_pipeline_config RN's template, where the changed
     * pipelines are computed by RN after the approval (needs the TS parser).
     */
    private fun detail(app: Context, tool: String, args: JSONObject): String = when (tool) {
        McpInstallOpDecision.OP_STAGE_INSTALL -> args.optString("path")
        McpInstallOpDecision.OP_PIPELINE_CONFIG -> {
            val agents = (args.opt("rebuild") as? JSONArray)?.let { a ->
                (0 until a.length()).mapNotNull { (a.opt(it) as? JSONObject)?.opt("agentId") as? String }
            }.orEmpty()
            app.getString(
                R.string.mcp_lock_detail_update_pipeline_config,
                args.optString("stagedPath").substringAfterLast('/'),
                args.opt("expectedBytes").toString().removeSuffix(".0"),
                app.getString(R.string.mcp_lock_pipelines_after_approval),
                agents.joinToString(", ").ifEmpty { "—" },
            )
        }
        else -> "${args.optString("stagedPath")} → .env.article-delivery.js"
    }
}
