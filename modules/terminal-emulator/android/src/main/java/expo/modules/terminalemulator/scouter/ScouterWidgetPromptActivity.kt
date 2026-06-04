package expo.modules.terminalemulator.scouter

import android.app.Activity
import android.app.Dialog
import android.os.Bundle
import android.text.InputType
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
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
        dialog.show()
        dialog.window?.apply {
            setBackgroundDrawableResource(android.R.color.transparent)
            setDimAmount(0.72f)
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            setLayout(
                (resources.displayMetrics.widthPixels * 0.82f).toInt(),
                WindowManager.LayoutParams.WRAP_CONTENT
            )
            setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE)
        }

        input.requestFocus()
        val imm = getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(input, InputMethodManager.SHOW_IMPLICIT)
    }

    override fun onDestroy() {
        promptDialog?.dismiss()
        promptDialog = null
        super.onDestroy()
    }

    private fun createPromptContent(dialog: Dialog): LinearLayout {
        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val panelBackground = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(8).toFloat()
            setColor(COLOR_PANEL)
            setStroke(dp(1), COLOR_BORDER)
        }

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
            sendPrompt(prompt)
            dialog.dismiss()
            finish()
        }

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            addView(cancel)
            addView(send)
        }

        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = panelBackground
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

    private fun sendPrompt(prompt: String) {
        val store = ScouterStateStore(this)
        val target = findBoundReadyCodexTerminal(store)
        if (target !is WidgetCodexTarget.Ready) {
            val messageId = target.messageResId()
            store.recordWidgetPromptFailed(getString(messageId))
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, messageId, Toast.LENGTH_SHORT).show()
            return
        }

        runCatching {
            if (prompt.contains('\n')) {
                target.session.paste(prompt)
                target.session.write("\r")
            } else {
                target.session.write("$prompt\r")
            }
        }.onSuccess {
            store.recordWidgetPromptQueued(prompt)
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_prompt_sent, Toast.LENGTH_SHORT).show()
        }.onFailure { error ->
            store.recordWidgetPromptFailed(error.message ?: error.javaClass.simpleName)
            ScouterWidgetProvider.updateAll(this, force = true)
            Toast.makeText(this, R.string.scouter_widget_prompt_no_codex, Toast.LENGTH_SHORT).show()
        }
    }

    private fun findBoundReadyCodexTerminal(store: ScouterStateStore): WidgetCodexTarget {
        val binding = store.widgetCodexBinding() ?: return WidgetCodexTarget.Missing
        if (isBoundCodexBusy(store, binding)) return WidgetCodexTarget.Busy
        val ptySessionId = binding.ptySessionId ?: return WidgetCodexTarget.Missing
        val session = TerminalSessionService.sessionRegistry[ptySessionId] ?: return WidgetCodexTarget.Missing
        if (!session.isAlive()) return WidgetCodexTarget.Stale
        return if (isReadyCodexScreen(session.getScreenText())) {
            WidgetCodexTarget.Ready(session)
        } else {
            WidgetCodexTarget.Stale
        }
    }

    private fun isBoundCodexBusy(store: ScouterStateStore, binding: ScouterWidgetCodexBinding): Boolean {
        val codexSessionId = normalizeCodexSessionId(binding.codexSessionId) ?: return false
        val snapshot = store.all().firstOrNull { snapshot ->
            snapshot.source == ScouterSource.CODEX &&
                normalizeCodexSessionId(snapshot.sessionId) == codexSessionId
        } ?: return false
        return snapshot.currentStatus in BUSY_STATUSES
    }

    private fun normalizeCodexSessionId(sessionId: String?): String? {
        val trimmed = sessionId?.trim().orEmpty()
        if (trimmed.isBlank()) return null
        return UUID_SUFFIX_RE.find(trimmed)?.groupValues?.getOrNull(1) ?: trimmed
    }

    private fun isReadyCodexScreen(screenText: String): Boolean {
        if (screenText.isBlank()) return false
        val tail = screenText
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .takeLast(8)
        if (tail.isEmpty()) return false
        val hasCodexHeader = screenText.contains("OpenAI Codex") || tail.any { it.contains("codex", ignoreCase = true) }
        val hasCodexPromptStatus = tail.any { line ->
            CODEX_STATUS_RE.containsMatchIn(line) ||
                (line.contains(" default ") && line.contains("·") && line.contains("/"))
        }
        return hasCodexHeader && hasCodexPromptStatus
    }

    companion object {
        private val CODEX_STATUS_RE = Regex("""^gpt-[A-Za-z0-9_.-]+\s+default\s+·""")
        private val UUID_SUFFIX_RE = Regex("""([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$""")
        private val COLOR_PANEL = Color.rgb(3, 16, 22)
        private val COLOR_BORDER = Color.rgb(0, 157, 209)
        private val COLOR_ACCENT = Color.rgb(48, 213, 255)
        private val COLOR_TEXT = Color.rgb(230, 247, 255)
        private val COLOR_MUTED = Color.rgb(126, 169, 190)
        private val BUSY_STATUSES = setOf(
            ScouterStatus.THINKING,
            ScouterStatus.TOOL_RUNNING,
            ScouterStatus.WAITING_PERMISSION,
            ScouterStatus.ERROR
        )
    }
}

private sealed class WidgetCodexTarget {
    data class Ready(val session: ShellyTerminalSession) : WidgetCodexTarget()
    object Missing : WidgetCodexTarget()
    object Stale : WidgetCodexTarget()
    object Busy : WidgetCodexTarget()
}

private fun WidgetCodexTarget.messageResId(): Int = when (this) {
    is WidgetCodexTarget.Ready -> R.string.scouter_widget_prompt_sent
    WidgetCodexTarget.Missing -> R.string.scouter_widget_prompt_no_codex
    WidgetCodexTarget.Stale -> R.string.scouter_widget_prompt_stale_codex
    WidgetCodexTarget.Busy -> R.string.scouter_widget_prompt_busy
}
