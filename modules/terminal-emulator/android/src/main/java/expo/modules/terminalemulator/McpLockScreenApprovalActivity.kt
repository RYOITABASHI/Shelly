package expo.modules.terminalemulator

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The lock-screen approval prompt (owner decision 2026-11-29) for
 * update_pipeline_config / update_delivery_script / stage_install, opened by
 * McpLockScreenPrompt's full-screen notification over the keyguard. Shows
 * what RN's dialog shows (summary, detail, origin "外部 (MCP)", client token
 * id) with [拒否] [承認]:
 *  - 拒否: decided at once (no authentication) → RN's `denied`.
 *  - 承認: KeyguardManager.requestDismissKeyguard; ONLY onDismissSucceeded
 *    approves (McpLockScreenApproval.Machine). Cancelled / error = no
 *    decision (audited `lock_screen_auth_failed`), the prompt stays.
 * After an approval Shelly's own activity is started (so RN comes up and runs
 * the request without a second tap). The consumer owns everything else
 * (audit of the outcome, the token, the handoff, the answer).
 *
 * Not exported; its own empty task affinity, excluded from recents.
 */
class McpLockScreenApprovalActivity : Activity() {
    companion object {
        private const val TAG = "McpLockScreenApproval"
    }

    private var entry: McpLockScreenPrompt.Entry? = null
    private val onClosed: () -> Unit = { runOnUiThread { if (!isFinishing) finish() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val e = McpLockScreenPrompt.get(intent?.getStringExtra(McpLockScreenPrompt.EXTRA_HANDLE))
        if (e == null || e.closed) {
            finish()
            return
        }
        entry = e
        e.closeListeners.add(onClosed)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        setContentView(buildContent(e))
    }

    override fun onDestroy() {
        entry?.let { e ->
            e.closeListeners.remove(onClosed)
            // Gone while the keyguard was asked (noHistory, the owner left):
            // no decision, so 承認 can be tapped again from the notification.
            // A late onDismissSucceeded then approves nothing (safe side).
            e.machine.dismissFailed(System.currentTimeMillis())
        }
        super.onDestroy()
    }

    private fun deny(e: McpLockScreenPrompt.Entry) {
        if (e.machine.deny(System.currentTimeMillis())) Log.i(TAG, "${e.tool} denied on the lock screen")
        finish()
    }

    private fun approve(e: McpLockScreenPrompt.Entry) {
        if (!e.machine.approveTapped(System.currentTimeMillis())) return
        val km = getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        if (km == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            // No way to authenticate: never an approval.
            e.machine.dismissFailed(System.currentTimeMillis())
            McpLockScreenPrompt.auditLine(this, e, "lock_screen_auth_failed")
            return
        }
        km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
            override fun onDismissSucceeded() {
                if (e.machine.dismissSucceeded(System.currentTimeMillis())) {
                    Log.i(TAG, "${e.tool} approved on the lock screen")
                    openShelly()
                }
                finish()
            }

            override fun onDismissCancelled() = authFailed(e)

            override fun onDismissError() = authFailed(e)
        })
    }

    private fun authFailed(e: McpLockScreenPrompt.Entry) {
        if (e.machine.dismissFailed(System.currentTimeMillis())) {
            McpLockScreenPrompt.auditLine(this, e, "lock_screen_auth_failed")
        }
    }

    /** Unlocked now: bring Shelly up so RN runs the handed-off request (no second tap). */
    private fun openShelly() {
        try {
            val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            startActivity(launch)
        } catch (ex: Exception) {
            Log.w(TAG, "Shelly not started type=${ex.javaClass.simpleName}")
        }
    }

    private fun dp(v: Float): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    private fun text(s: String, sizeSp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
        text = s
        setTextColor(color)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp)
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        setPadding(0, dp(6f), 0, dp(6f))
    }

    private fun buildContent(e: McpLockScreenPrompt.Entry): ViewGroup {
        val fg = Color.WHITE
        val dim = Color.parseColor("#B0BEC5")
        val warn = Color.parseColor("#FF8A80")
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24f), dp(48f), dp(24f), dp(24f))
        }
        column.addView(text(getString(R.string.mcp_approval_foreground_overlay), 14f, dim))
        column.addView(text(e.summary, 20f, fg, bold = true))
        column.addView(text(e.detail, 15f, fg).apply { setTextIsSelectable(true) })
        column.addView(text(getString(R.string.mcp_lock_origin), 14f, warn))
        column.addView(text(getString(R.string.mcp_lock_principal, e.principal), 14f, dim))
        column.addView(text(getString(R.string.mcp_lock_auth_note), 13f, dim))
        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END
            setPadding(0, dp(16f), 0, 0)
        }
        buttons.addView(Button(this).apply {
            text = getString(R.string.mcp_lock_deny)
            setOnClickListener { deny(e) }
        })
        buttons.addView(Button(this).apply {
            text = getString(R.string.mcp_lock_approve)
            setOnClickListener { approve(e) }
        })
        column.addView(buttons)
        return ScrollView(this).apply {
            setBackgroundColor(Color.parseColor("#000C04"))
            addView(column)
        }
    }
}
