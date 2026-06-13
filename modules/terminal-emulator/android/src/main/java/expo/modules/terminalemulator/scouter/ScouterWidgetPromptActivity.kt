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
import android.util.Log
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
        if (handlePetCycleAction(intent)) {
            return
        }
        if (handleApprovalAction(intent)) {
            return
        }
        if (handleChoiceAction(intent)) {
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

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (handlePetCycleAction(intent)) {
            return
        }
        if (handleApprovalAction(intent)) {
            return
        }
        if (handleChoiceAction(intent)) {
            return
        }
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

    private fun launchAgentChatResume(drainApprovalDecision: String? = null): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(agentChatResumeUri(drainApprovalDecision)))
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

    @Suppress("DEPRECATION")
    private fun finishQuietly() {
        overridePendingTransition(0, 0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            finishAndRemoveTask()
        } else {
            finish()
        }
        overridePendingTransition(0, 0)
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
            if (target is WidgetCodexTarget.InteractivePrompt) {
                store.recordWidgetChoicePending(getString(messageId))
            } else {
                store.recordWidgetPromptFailed(getString(messageId))
            }
            ScouterWidgetProvider.updateAll(this, force = true)
            replaceWithUnavailableContent(dialog, messageId, target.canResume())
            return false
        }

        return runCatching {
            Log.i(TAG, "Submitting widget prompt to Codex terminal session=${target.session.sessionId} length=${prompt.length}")
            target.session.write("\u0015")
            target.session.paste(prompt)
            target.session.write("\r")
        }.fold(onSuccess = {
            store.recordWidgetPromptQueued(prompt)
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_prompt_sent, Toast.LENGTH_SHORT).show()
            true
        }, onFailure = { error ->
            Log.w(TAG, "Failed to submit widget prompt to Codex terminal", error)
            store.recordWidgetPromptFailed(error.message ?: error.javaClass.simpleName)
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_prompt_no_codex, Toast.LENGTH_SHORT).show()
            false
        })
    }

    private fun handlePetCycleAction(intent: Intent?): Boolean {
        if (intent?.action != ACTION_PET_CYCLE) return false
        ScouterCodexPet.cycleVisiblePet(this)
        runCatching {
            Log.i(TAG, "Widget pet cycle state=${ScouterCodexPet.debugJson(this)}")
        }
        ScouterWidgetProvider.updateAll(this, force = true)
        finishQuietly()
        return true
    }

    private fun handleApprovalAction(intent: Intent?): Boolean {
        val action = intent?.action
        val decision = when (action) {
            ACTION_APPROVAL_ALLOW -> "allow"
            ACTION_APPROVAL_DENY -> "deny"
            else -> return false
        }
        val expectedCodexSessionId = intent?.getStringExtra(EXTRA_CODEX_SESSION_ID)
        val expectedPtySessionId = intent?.getStringExtra(EXTRA_PTY_SESSION_ID)
        val expectedApprovalAt = intent?.getLongExtra(EXTRA_APPROVAL_AT, 0L) ?: 0L
        val expectedApprovalText = intent?.getStringExtra(EXTRA_APPROVAL_TEXT)
        val store = ScouterStateStore(this)
        if (!approvalAnchorMatches(store, expectedCodexSessionId, expectedApprovalAt, expectedApprovalText)) {
            store.recordWidgetApprovalFailed(getString(R.string.scouter_widget_approval_not_ready))
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_approval_not_ready, Toast.LENGTH_SHORT).show()
            returnHomeAndFinish()
            return true
        }
        val target = findBoundCodexTerminal(store, expectedCodexSessionId, expectedPtySessionId)
        if (target !is WidgetCodexTarget.ApprovalNeeded) {
            if (target.canQueueApproval() && store.recordWidgetApprovalPending(decision)) {
                ScouterWidgetProvider.updateAll(this, force = true)
                Toast.makeText(this, R.string.scouter_widget_approval_queued_resume, Toast.LENGTH_SHORT).show()
                if (!launchAgentChatResume(decision)) {
                    store.recordWidgetApprovalFailed(getString(R.string.scouter_widget_approval_not_ready))
                    ScouterWidgetProvider.updateAll(this, force = true)
                    Toast.makeText(this, R.string.scouter_widget_approval_not_ready, Toast.LENGTH_SHORT).show()
                    returnHomeAndFinish()
                } else {
                    finish()
                }
                return true
            }
            store.recordWidgetApprovalFailed(getString(R.string.scouter_widget_approval_not_ready))
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
            store.recordWidgetApprovalFailed(error.message ?: error.javaClass.simpleName)
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_approval_not_ready, Toast.LENGTH_SHORT).show()
            returnHomeAndFinish()
        })
        return true
    }

    private fun handleChoiceAction(intent: Intent?): Boolean {
        if (intent?.action != ACTION_CHOICE_SELECT) return false
        val choiceIndex = intent.getIntExtra(EXTRA_CHOICE_INDEX, Int.MIN_VALUE)
        val expectedLabel = intent.getStringExtra(EXTRA_CHOICE_LABEL)
        val expectedCodexSessionId = intent.getStringExtra(EXTRA_CODEX_SESSION_ID)
        val expectedPtySessionId = intent.getStringExtra(EXTRA_PTY_SESSION_ID)
        val store = ScouterStateStore(this)
        if (choiceIndex == Int.MIN_VALUE || choiceIndex < 0) {
            Toast.makeText(this, R.string.scouter_widget_choice_not_ready, Toast.LENGTH_SHORT).show()
            returnHomeAndFinish()
            return true
        }
        // Path A only: require the bound terminal to be live and STILL showing an
        // interactive numbered prompt that contains the chosen index with the same
        // label the user tapped. This is the stale-tap guard (mirrors the approval
        // ApprovalNeeded + anchor check); if anything changed we no-op.
        val target = findBoundCodexTerminal(store, expectedCodexSessionId, expectedPtySessionId)
        if (target !is WidgetCodexTarget.InteractivePrompt) {
            Toast.makeText(this, R.string.scouter_widget_choice_not_ready, Toast.LENGTH_SHORT).show()
            returnHomeAndFinish()
            return true
        }
        if (!choiceAnchorMatches(target.session, choiceIndex, expectedLabel)) {
            Toast.makeText(this, R.string.scouter_widget_choice_not_ready, Toast.LENGTH_SHORT).show()
            returnHomeAndFinish()
            return true
        }

        runCatching {
            target.session.write("$choiceIndex\r")
        }.fold(onSuccess = {
            store.recordWidgetChoiceSelected(choiceIndex)
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_choice_sent, Toast.LENGTH_SHORT).show()
            returnHomeAndFinish()
        }, onFailure = { error ->
            Log.w(TAG, "Failed to submit widget choice to Codex terminal", error)
            store.recordWidgetChoicePending(getString(R.string.scouter_widget_prompt_interactive))
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_choice_not_ready, Toast.LENGTH_SHORT).show()
            returnHomeAndFinish()
        })
        return true
    }

    // Re-parses the live screen and confirms an option with the same index still
    // exists, and (when a label was captured at render time) that the label still
    // matches. Prevents writing the digit into a different prompt that scrolled in.
    private fun choiceAnchorMatches(
        session: ShellyTerminalSession,
        choiceIndex: Int,
        expectedLabel: String?
    ): Boolean {
        val screenText = runCatching { session.getScreenText() }.getOrDefault("")
        val option = parseInteractiveChoices(screenText).firstOrNull { it.index == choiceIndex }
            ?: return false
        val expected = normalizeChoiceLabel(expectedLabel) ?: return true
        val actual = normalizeChoiceLabel(option.label) ?: return false
        return expected == actual
    }

    private fun parseInteractiveChoices(screenText: String): List<ChoiceOption> {
        val recentLines = screenText
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .takeLast(INTERACTIVE_PROMPT_TAIL_LINES)
        val out = mutableListOf<ChoiceOption>()
        for (line in recentLines) {
            val match = INTERACTIVE_CHOICE_CAPTURE_RE.find(line) ?: continue
            val index = match.groupValues.getOrNull(1)?.toIntOrNull() ?: continue
            val label = match.groupValues.getOrNull(2).orEmpty().trim()
            if (label.isBlank()) continue
            out += ChoiceOption(index, label)
        }
        return out
    }

    // Mirrors ScouterWidgetProvider.shorten() (collapse whitespace, redact, cap
    // at 36 with an ellipsis) before comparing, so the truncated label carried in
    // the intent matches the freshly re-parsed full label from the live screen.
    private fun normalizeChoiceLabel(value: String?): String? {
        val cleaned = value
            ?.redactForScouter()
            ?.replace(Regex("\\s+"), " ")
            ?.trim()
            ?.takeIf { it.isNotBlank() }
            ?: return null
        val capped = if (cleaned.length > 36) cleaned.take(35) + "…" else cleaned
        return capped.lowercase()
    }

    private fun findBoundCodexTerminal(
        store: ScouterStateStore,
        expectedCodexSessionId: String? = null,
        expectedPtySessionId: String? = null
    ): WidgetCodexTarget {
        val binding = store.widgetCodexBinding() ?: return WidgetCodexTarget.Missing
        if (!matchesExpectedBinding(binding, expectedCodexSessionId, expectedPtySessionId)) {
            return WidgetCodexTarget.Stale(null)
        }
        val status = boundCodexStatus(store, binding)
        val ptySessionId = binding.ptySessionId ?: return WidgetCodexTarget.Missing
        val session = TerminalSessionService.sessionRegistry[ptySessionId] ?: return WidgetCodexTarget.Missing
        if (!session.isAlive()) return WidgetCodexTarget.Stale(status)
        val screenText = session.getScreenText()
        if (!isActiveCodexScreen(screenText)) return WidgetCodexTarget.Stale(status)
        if (isApprovalPromptScreen(screenText)) {
            return WidgetCodexTarget.ApprovalNeeded(session)
        }
        if (isInteractivePromptScreen(screenText)) {
            return WidgetCodexTarget.InteractivePrompt(session)
        }
        if (status in BUSY_CODEX_STATUSES) return WidgetCodexTarget.Busy(status)
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

    private fun matchesExpectedBinding(
        binding: ScouterWidgetCodexBinding,
        expectedCodexSessionId: String?,
        expectedPtySessionId: String?
    ): Boolean {
        val expectedPty = expectedPtySessionId?.trim()?.takeIf { it.isNotBlank() }
        if (expectedPty != null && expectedPty != binding.ptySessionId) return false
        val expectedCodex = normalizeCodexSessionId(expectedCodexSessionId) ?: return true
        val boundCodex = normalizeCodexSessionId(binding.codexSessionId) ?: return false
        return expectedCodex == boundCodex
    }

    private fun approvalAnchorMatches(
        store: ScouterStateStore,
        expectedCodexSessionId: String?,
        expectedApprovalAt: Long,
        expectedApprovalText: String?
    ): Boolean {
        if (expectedApprovalAt <= 0L) return false
        val expectedText = normalizeApprovalText(expectedApprovalText) ?: return false
        val conversation = store.widgetConversation(expectedCodexSessionId)
        val statusAfterApproval = (conversation.widgetStatusAt ?: 0L) >= expectedApprovalAt
        val decisionAlreadyRecorded = ScouterStateStore.approvalDecisionFromStatus(conversation.widgetStatus) != null
        val approvalAlreadyFailed = conversation.widgetStatus == ScouterStateStore.approvalFailedStatus()
        if (statusAfterApproval && (decisionAlreadyRecorded || approvalAlreadyFailed)) return false
        return conversation.lastApprovalAt == expectedApprovalAt &&
            normalizeApprovalText(conversation.lastApproval) == expectedText
    }

    private fun normalizeApprovalText(value: String?): String? {
        return value
            ?.trim()
            ?.replace(Regex("\\s+"), " ")
            ?.takeIf { it.isNotBlank() }
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

    private fun isInteractivePromptScreen(screenText: String): Boolean {
        val recentLines = screenText
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .takeLast(INTERACTIVE_PROMPT_TAIL_LINES)
        if (recentLines.isEmpty()) return false
        val tail = recentLines.joinToString("\n")
        val hasInteractiveKeyword = INTERACTIVE_PROMPT_KEYWORD_RE.containsMatchIn(tail)
        val numberedChoices = recentLines.count { INTERACTIVE_NUMBERED_CHOICE_RE.containsMatchIn(it) }
        val hasFocusedChoice = recentLines.any { INTERACTIVE_FOCUSED_CHOICE_RE.containsMatchIn(it) }
        return hasInteractiveKeyword && (numberedChoices >= 2 || hasFocusedChoice)
    }

    companion object {
        const val ACTION_APPROVAL_ALLOW = "expo.modules.terminalemulator.scouter.APPROVAL_ALLOW"
        const val ACTION_APPROVAL_DENY = "expo.modules.terminalemulator.scouter.APPROVAL_DENY"
        const val ACTION_CHOICE_SELECT = "expo.modules.terminalemulator.scouter.CHOICE_SELECT"
        const val ACTION_PET_CYCLE = "expo.modules.terminalemulator.scouter.PET_CYCLE"
        const val EXTRA_CODEX_SESSION_ID = "expo.modules.terminalemulator.scouter.CODEX_SESSION_ID"
        const val EXTRA_PTY_SESSION_ID = "expo.modules.terminalemulator.scouter.PTY_SESSION_ID"
        const val EXTRA_APPROVAL_AT = "expo.modules.terminalemulator.scouter.APPROVAL_AT"
        const val EXTRA_APPROVAL_TEXT = "expo.modules.terminalemulator.scouter.APPROVAL_TEXT"
        const val EXTRA_CHOICE_INDEX = "expo.modules.terminalemulator.scouter.CHOICE_INDEX"
        const val EXTRA_CHOICE_LABEL = "expo.modules.terminalemulator.scouter.CHOICE_LABEL"
        private val CODEX_STATUS_RE = Regex("""\b(?:gpt|o\d|codex)[A-Za-z0-9_.-]*\b.*[·•]\s*/""", RegexOption.IGNORE_CASE)
        private val SHELL_PROMPT_RE = Regex("""^(?:[~\w./:@+-]+\s*)?[$#]\s*$""")
        private val APPROVAL_KEYWORD_RE = Regex("""\b(?:approval|approve|permission|allow|deny)\b""", RegexOption.IGNORE_CASE)
        private val APPROVAL_CHOICE_RE = Regex("""\b(?:y/n|yes/no|allow|deny|approve|reject)\b|^\s*(?:[^A-Za-z0-9\s]\s*)?(?:\d+[\).]\s*)?(?:yes|no|y|n)\b(?:\s*[,):.-]|\s*$)|[\[(]\s*[yY]\s*/\s*[nN]\s*[\])]""", RegexOption.IGNORE_CASE)
        private val INTERACTIVE_PROMPT_KEYWORD_RE = Regex("""(?:Approaching rate limits|Switch to\b.*\bmodel\b|Keep current model|Would you like to make the following edits|Yes,\s*proceed|don't ask again|Press enter to confirm|esc to go back|rate limit reminders|select an option|choose an option)""", RegexOption.IGNORE_CASE)
        private val INTERACTIVE_NUMBERED_CHOICE_RE = Regex("""^\s*(?:[>]\s*)?\d+[\).]\s+\S""")
        private val INTERACTIVE_FOCUSED_CHOICE_RE = Regex("""^\s*(?:[>]\s*)\d+[\).]\s+\S""")
        // Capturing variant: group 1 = digit, group 2 = label text. Mirrors the
        // provider's INTERACTIVE_CHOICE_CAPTURE_RE so anchor validation re-parses
        // the live screen with identical semantics.
        private val INTERACTIVE_CHOICE_CAPTURE_RE = Regex("""^\s*(?:[>]\s*)?(\d+)[\).]\s+(\S.*)$""")
        private const val INTERACTIVE_PROMPT_TAIL_LINES = 24
        private val UUID_SUFFIX_RE = Regex("""([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$""")
        private val BUSY_CODEX_STATUSES = setOf(
            ScouterStatus.THINKING,
            ScouterStatus.TOOL_RUNNING,
            ScouterStatus.WAITING_PERMISSION,
            ScouterStatus.ERROR
        )
        private fun agentChatResumeUri(drainApprovalDecision: String?): String {
            val base = "shelly:///agent-chat?compose=1&source=widget&returnHome=1"
            return if (drainApprovalDecision == null) {
                "$base&drainWidgetPrompt=1"
            } else {
                "$base&drainWidgetApproval=${ScouterStateStore.normalizeApprovalDecision(drainApprovalDecision)}"
            }
        }
        private const val TAG = "ScouterWidgetPrompt"
        private val COLOR_PANEL = Color.rgb(0, 12, 4)
        private val COLOR_BORDER = Color.rgb(0, 255, 65)
        private val COLOR_ACCENT = Color.rgb(0, 255, 65)
        private val COLOR_TEXT = Color.rgb(230, 255, 236)
        private val COLOR_MUTED = Color.rgb(140, 255, 170)
    }
}

private sealed class WidgetCodexTarget {
    data class Ready(val session: ShellyTerminalSession) : WidgetCodexTarget()
    data class ApprovalNeeded(val session: ShellyTerminalSession) : WidgetCodexTarget()
    data class InteractivePrompt(val session: ShellyTerminalSession) : WidgetCodexTarget()
    object Missing : WidgetCodexTarget()
    data class Stale(val status: ScouterStatus?) : WidgetCodexTarget()
    data class Busy(val status: ScouterStatus?) : WidgetCodexTarget()
}

private fun WidgetCodexTarget.messageResId(): Int = when (this) {
    is WidgetCodexTarget.Ready -> R.string.scouter_widget_prompt_sent
    is WidgetCodexTarget.ApprovalNeeded -> R.string.scouter_widget_prompt_approval_needed
    is WidgetCodexTarget.InteractivePrompt -> R.string.scouter_widget_prompt_interactive
    WidgetCodexTarget.Missing -> R.string.scouter_widget_prompt_no_codex
    is WidgetCodexTarget.Stale -> R.string.scouter_widget_prompt_stale_codex
    is WidgetCodexTarget.Busy -> R.string.scouter_widget_prompt_busy
}

private fun WidgetCodexTarget.canResume(): Boolean = when (this) {
    is WidgetCodexTarget.Ready,
    is WidgetCodexTarget.ApprovalNeeded,
    is WidgetCodexTarget.InteractivePrompt,
    is WidgetCodexTarget.Busy -> false
    WidgetCodexTarget.Missing,
    is WidgetCodexTarget.Stale -> true
}

private fun WidgetCodexTarget.canQueueApproval(): Boolean = when (this) {
    is WidgetCodexTarget.Busy -> status == ScouterStatus.WAITING_PERMISSION
    is WidgetCodexTarget.Stale -> status == ScouterStatus.WAITING_PERMISSION
    else -> false
}
