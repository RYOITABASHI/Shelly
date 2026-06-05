package expo.modules.terminalemulator.scouter

import android.app.Activity
import android.app.Dialog
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.view.Gravity
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.view.inputmethod.InputMethodManager
import android.content.Context
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import expo.modules.terminalemulator.R
import expo.modules.terminalemulator.ShellyTerminalSession
import expo.modules.terminalemulator.TerminalSessionService

class ScouterWidgetPromptActivity : Activity() {
    private lateinit var input: EditText
    private var promptDialog: Dialog? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (handleApprovalAction(intent?.action)) {
            return
        }
        input = EditText(this).apply {
            hint = getString(R.string.scouter_widget_prompt_hint)
            setTextColor(COLOR_TEXT)
            setHintTextColor(COLOR_MUTED)
            backgroundTintList = android.content.res.ColorStateList.valueOf(COLOR_ACCENT)
            minLines = 2
            maxLines = 5
            inputType = InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            setSingleLine(false)
            setSelectAllOnFocus(false)
        }

        val dialog = Dialog(this)
        promptDialog = dialog
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.setContentView(createPromptContent(dialog))
        dialog.setOnCancelListener { finish() }
        showStyledDialog(dialog, showKeyboard = true)

        input.requestFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
    }

    override fun onDestroy() {
        promptDialog?.dismiss()
        promptDialog = null
        super.onDestroy()
    }

    private fun showStyledDialog(dialog: Dialog, showKeyboard: Boolean) {
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setDimAmount(0.72f)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setLayout(
                (resources.displayMetrics.widthPixels * 0.82f).toInt(),
                WindowManager.LayoutParams.WRAP_CONTENT
            )
            val softInputMode = if (showKeyboard) {
                WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE
            } else {
                WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN
            }
            setSoftInputMode(softInputMode)
        }
    }

    private fun createPromptContent(dialog: Dialog): LinearLayout {
        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val title = TextView(this).apply {
            text = getString(R.string.scouter_widget_prompt_title)
            setTextColor(COLOR_TEXT)
            textSize = 20f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }

        val cancel = actionText(R.string.scouter_widget_prompt_cancel) {
            dialog.dismiss()
            finish()
        }
        val send = actionText(R.string.scouter_widget_prompt_send) {
            val prompt = input.text?.toString().orEmpty().trim()
            if (prompt.isBlank()) {
                Toast.makeText(this, R.string.scouter_widget_prompt_empty, Toast.LENGTH_SHORT).show()
                return@actionText
            }
            if (sendPrompt(prompt, dialog)) {
                dialog.dismiss()
                returnHomeAndFinish()
            }
        }

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            addView(cancel)
            addView(send)
        }

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = panelBackground(dp(8), dp(1))
            setPadding(dp(22), dp(22), dp(22), dp(16))
            addView(title, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ))
            addView(input, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(18)
            })
            addView(actions, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(18)
            })
        }
    }

    private fun createUnavailableContent(dialog: Dialog, messageId: Int, showResume: Boolean): LinearLayout {
        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val title = TextView(this).apply {
            text = getString(R.string.scouter_widget_prompt_title)
            setTextColor(COLOR_TEXT)
            textSize = 20f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
        val message = TextView(this).apply {
            text = getString(messageId)
            setTextColor(COLOR_MUTED)
            textSize = 15f
            setLineSpacing(dp(2).toFloat(), 1.0f)
        }
        val close = actionText(R.string.scouter_widget_prompt_close) {
            dialog.dismiss()
            finish()
        }
        val resume = actionText(R.string.scouter_widget_prompt_resume) {
            dialog.dismiss()
            launchAgentChatResume()
            finish()
        }
        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            addView(close)
            if (showResume) {
                addView(resume)
            }
        }

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = panelBackground(dp(8), dp(1))
            setPadding(dp(22), dp(22), dp(22), dp(16))
            addView(title, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ))
            addView(message, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(18)
            })
            addView(actions, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                topMargin = dp(18)
            })
        }
    }

    private fun panelBackground(cornerRadiusPx: Int, strokeWidthPx: Int): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = cornerRadiusPx.toFloat()
        setColor(COLOR_PANEL)
        setStroke(strokeWidthPx, COLOR_BORDER)
    }

    private fun actionText(labelRes: Int, onClick: () -> Unit): TextView {
        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()
        return TextView(this).apply {
            text = getString(labelRes).uppercase()
            setTextColor(COLOR_ACCENT)
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            isClickable = true
            isFocusable = true
            setPadding(dp(18), dp(10), dp(18), dp(10))
            setOnClickListener { onClick() }
        }
    }

    private fun replaceWithUnavailableContent(dialog: Dialog, messageId: Int, showResume: Boolean) {
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(input.windowToken, 0)
        input.clearFocus()
        dialog.setContentView(createUnavailableContent(dialog, messageId, showResume))
        dialog.window?.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN)
    }

    private fun launchAgentChatResume(): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(AGENT_CHAT_RESUME_URI))
            .setPackage(packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching {
            startActivity(intent)
            true
        }.onFailure {
            Toast.makeText(this, R.string.scouter_widget_prompt_no_codex, Toast.LENGTH_SHORT).show()
        }.getOrDefault(false)
    }

    private fun returnHomeAndFinish() {
        runCatching {
            val home = Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_HOME)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(home)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            finishAndRemoveTask()
        } else {
            @Suppress("DEPRECATION")
            finish()
        }
    }

    private fun sendPrompt(prompt: String, dialog: Dialog): Boolean {
        val store = ScouterStateStore(this)
        val target = findBoundCodexTerminal(store)
        if (target !is WidgetCodexTarget.Ready) {
            if (target.canResume()) {
                store.recordWidgetPromptPending(prompt)
                ScouterWidgetProvider.updateAll(this, force = true)
                Toast.makeText(this, R.string.scouter_widget_prompt_queued_resume, Toast.LENGTH_SHORT).show()
                if (launchAgentChatResume()) {
                    dialog.dismiss()
                    finish()
                } else {
                    replaceWithUnavailableContent(dialog, target.messageResId(), showResume = true)
                }
                return false
            }
            val messageId = target.messageResId()
            store.recordWidgetPromptFailed(getString(messageId))
            ScouterWidgetProvider.updateAll(this, force = true)
            replaceWithUnavailableContent(dialog, messageId, target.canResume())
            return false
        }

        return runCatching {
            if (prompt.contains('\n')) {
                target.session.paste(prompt)
                target.session.write("\r")
            } else {
                target.session.write("$prompt\r")
            }
        }.fold(onSuccess = {
            store.recordWidgetPromptQueued(prompt)
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_prompt_sent, Toast.LENGTH_SHORT).show()
            true
        }, onFailure = { error ->
            store.recordWidgetPromptFailed(error.message ?: error.javaClass.simpleName)
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_prompt_no_codex, Toast.LENGTH_SHORT).show()
            false
        })
    }

    private fun handleApprovalAction(action: String?): Boolean {
        val decision = when (action) {
            ACTION_APPROVAL_ALLOW -> "allow"
            ACTION_APPROVAL_DENY -> "deny"
            else -> return false
        }
        val store = ScouterStateStore(this)
        val target = findBoundCodexTerminal(store)
        if (target !is WidgetCodexTarget.ApprovalNeeded) {
            store.recordWidgetPromptFailed(getString(R.string.scouter_widget_approval_not_ready))
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_approval_not_ready, Toast.LENGTH_SHORT).show()
            returnHomeAndFinish()
            return true
        }

        runCatching {
            target.session.write(if (decision == "allow") "y\r" else "n\r")
        }.fold(onSuccess = {
            store.recordWidgetApprovalDecision(decision)
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(
                this,
                if (decision == "allow") R.string.scouter_widget_approval_sent else R.string.scouter_widget_approval_denied,
                Toast.LENGTH_SHORT
            ).show()
            returnHomeAndFinish()
        }, onFailure = { error ->
            store.recordWidgetPromptFailed(error.message ?: error.javaClass.simpleName)
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_approval_not_ready, Toast.LENGTH_SHORT).show()
            returnHomeAndFinish()
        })
        return true
    }

    private fun findBoundCodexTerminal(store: ScouterStateStore): WidgetCodexTarget {
        val binding = store.widgetCodexBinding() ?: return WidgetCodexTarget.Missing
        val status = boundCodexStatus(store, binding)
        val ptySessionId = binding.ptySessionId ?: return WidgetCodexTarget.Missing
        val session = TerminalSessionService.sessionRegistry[ptySessionId] ?: return WidgetCodexTarget.Missing
        if (!session.isAlive()) return WidgetCodexTarget.Stale
        val screenText = session.getScreenText()
        if (!isActiveCodexScreen(screenText)) return WidgetCodexTarget.Stale
        if (status == ScouterStatus.WAITING_PERMISSION && isApprovalPromptScreen(screenText)) {
            return WidgetCodexTarget.ApprovalNeeded(session)
        }
        return WidgetCodexTarget.Ready(session)
    }

    private fun boundCodexStatus(store: ScouterStateStore, binding: ScouterWidgetCodexBinding): ScouterStatus? {
        val codexSessionId = normalizeCodexSessionId(binding.codexSessionId) ?: return null
        val snapshot = store.all().firstOrNull { snapshot ->
            snapshot.source == ScouterSource.CODEX &&
                normalizeCodexSessionId(snapshot.sessionId) == codexSessionId
        }
        return snapshot?.currentStatus
    }

    private fun normalizeCodexSessionId(sessionId: String?): String? {
        val trimmed = sessionId?.trim().orEmpty()
        if (trimmed.isBlank()) return null
        return UUID_SUFFIX_RE.find(trimmed)?.groupValues?.getOrNull(1) ?: trimmed
    }

    private fun isActiveCodexScreen(screenText: String): Boolean {
        if (screenText.isBlank()) return false
        val lines = screenText
            .lines()
            .map { it.trimEnd() }
        var lastCodexPrompt = -1
        var lastShellPrompt = -1
        lines.forEachIndexed { index, line ->
            when {
                line.contains("OpenAI Codex", ignoreCase = true) || CODEX_STATUS_RE.containsMatchIn(line) -> lastCodexPrompt = index
                SHELL_PROMPT_RE.matches(line.trim()) -> lastShellPrompt = index
            }
        }
        return lastCodexPrompt >= 0 && lastCodexPrompt > lastShellPrompt
    }

    private fun isApprovalPromptScreen(screenText: String): Boolean {
        val recentLines = screenText
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .takeLast(8)
        if (recentLines.isEmpty()) return false
        val tail = recentLines.joinToString("\n")
        val hasApprovalKeyword = APPROVAL_KEYWORD_RE.containsMatchIn(tail)
        val hasChoice = recentLines.any { APPROVAL_CHOICE_RE.containsMatchIn(it) }
        return hasApprovalKeyword && hasChoice
    }

    companion object {
        const val ACTION_APPROVAL_ALLOW = "expo.modules.terminalemulator.scouter.APPROVAL_ALLOW"
        const val ACTION_APPROVAL_DENY = "expo.modules.terminalemulator.scouter.APPROVAL_DENY"
        private val CODEX_STATUS_RE = Regex("""\b(?:gpt|o\d|codex)[A-Za-z0-9_.-]*\b.*[·•]\s*/""", RegexOption.IGNORE_CASE)
        private val SHELL_PROMPT_RE = Regex("""^(?:[~\w./:@+-]+\s*)?[$#]\s*$""")
        private val APPROVAL_KEYWORD_RE = Regex("""\b(?:approval|approve|permission|allow|deny|yes|no|proceed|continue)\b""", RegexOption.IGNORE_CASE)
        private val APPROVAL_CHOICE_RE = Regex("""\b(?:y/n|yes/no|allow|deny|approve|reject)\b|[\[(]\s*[yY]\s*/\s*[nN]\s*[\])]""", RegexOption.IGNORE_CASE)
        private val UUID_SUFFIX_RE = Regex("""([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$""")
        private const val AGENT_CHAT_RESUME_URI = "shelly:///agent-chat?compose=1&source=widget&drainWidgetPrompt=1&returnHome=1"
        private val COLOR_PANEL = Color.rgb(3, 16, 22)
        private val COLOR_BORDER = Color.rgb(0, 157, 209)
        private val COLOR_ACCENT = Color.rgb(48, 213, 255)
        private val COLOR_TEXT = Color.rgb(230, 247, 255)
        private val COLOR_MUTED = Color.rgb(126, 169, 190)
    }
}

private sealed class WidgetCodexTarget {
    data class Ready(val session: ShellyTerminalSession) : WidgetCodexTarget()
    data class ApprovalNeeded(val session: ShellyTerminalSession) : WidgetCodexTarget()
    object Missing : WidgetCodexTarget()
    object Stale : WidgetCodexTarget()
    object Busy : WidgetCodexTarget()
}

private fun WidgetCodexTarget.messageResId(): Int = when (this) {
    is WidgetCodexTarget.Ready -> R.string.scouter_widget_prompt_sent
    is WidgetCodexTarget.ApprovalNeeded -> R.string.scouter_widget_prompt_approval_needed
    WidgetCodexTarget.Missing -> R.string.scouter_widget_prompt_no_codex
    WidgetCodexTarget.Stale -> R.string.scouter_widget_prompt_stale_codex
    WidgetCodexTarget.Busy -> R.string.scouter_widget_prompt_busy
}

private fun WidgetCodexTarget.canResume(): Boolean = when (this) {
    is WidgetCodexTarget.Ready,
    is WidgetCodexTarget.ApprovalNeeded,
    WidgetCodexTarget.Busy -> false
    WidgetCodexTarget.Missing,
    WidgetCodexTarget.Stale -> true
}
