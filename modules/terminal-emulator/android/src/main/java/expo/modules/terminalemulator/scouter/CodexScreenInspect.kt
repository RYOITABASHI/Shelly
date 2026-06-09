package expo.modules.terminalemulator.scouter

/**
 * Side-effect-free Codex PTY-screen classifier shared between the widget render
 * path (ScouterWidgetProvider) and any background poll. Operates purely on the
 * captured screen text; performs no Android / IO calls.
 *
 * The detection logic (regexes, thresholds, tail windows) is copied VERBATIM
 * from ScouterWidgetProvider's private members so both call sites classify a
 * Codex terminal screen identically. ChoiceOption and redactForScouter() are
 * existing in-package members (ScouterModels.kt) and are referenced directly.
 */
object CodexScreenInspect {

    enum class State { INACTIVE, READY, APPROVAL, INTERACTIVE, RATE_LIMITED }

    data class Result(
        val state: State,
        val choices: List<ChoiceOption> = emptyList(),
        val summary: String = "",
        val usageLimited: Boolean = false
    )

    // --- Detection ---------------------------------------------------------

    fun isActiveCodexScreen(screenText: String): Boolean {
        if (screenText.isBlank()) return false
        val lines = screenText.lines().map { it.trimEnd() }
        var lastCodexPrompt = -1
        var lastShellPrompt = -1
        lines.forEachIndexed { index, line ->
            when {
                line.contains("OpenAI Codex", ignoreCase = true) ||
                    CODEX_STATUS_RE.containsMatchIn(line) -> lastCodexPrompt = index
                SHELL_PROMPT_RE.matches(line.trim()) -> lastShellPrompt = index
            }
        }
        return lastCodexPrompt >= 0 && lastCodexPrompt > lastShellPrompt
    }

    fun isApprovalPromptScreen(screenText: String): Boolean {
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

    fun isInteractivePromptScreen(screenText: String): Boolean {
        val recentLines = screenText
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .takeLast(12)
        if (recentLines.isEmpty()) return false
        val tail = recentLines.joinToString("\n")
        val hasInteractiveKeyword = INTERACTIVE_PROMPT_KEYWORD_RE.containsMatchIn(tail)
        val numberedChoices = recentLines.count { INTERACTIVE_NUMBERED_CHOICE_RE.containsMatchIn(it) }
        val hasFocusedChoice = recentLines.any { INTERACTIVE_FOCUSED_CHOICE_RE.containsMatchIn(it) }
        return hasInteractiveKeyword && (numberedChoices >= 2 || hasFocusedChoice)
    }

    // Parses numbered choices (e.g. "1. Switch to gpt-5.4-mini") from the
    // tail of the interactive prompt screen into tappable options. Strips an
    // optional focus caret (">") and the "<digit>." / "<digit>)" prefix,
    // keeping the digit as the option index. Caps usable options at 3 and
    // returns empty (→ banner fallback) when 0 or >3 are parsed, or when
    // duplicate indices appear (ambiguous/unsafe to map to a single digit).
    fun parseInteractiveChoices(screenText: String): List<ChoiceOption> {
        val recentLines = screenText
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .takeLast(12)
        val out = mutableListOf<ChoiceOption>()
        val seen = mutableSetOf<Int>()
        for (line in recentLines) {
            val match = INTERACTIVE_CHOICE_CAPTURE_RE.find(line) ?: continue
            val index = match.groupValues.getOrNull(1)?.toIntOrNull() ?: continue
            val label = match.groupValues.getOrNull(2).orEmpty().trim()
            if (label.isBlank()) continue
            if (!seen.add(index)) return emptyList()
            out += ChoiceOption(index, shorten(label.redactForScouter(), 36))
            if (out.size > 3) return emptyList()
        }
        if (out.size < 1 || out.size > 3) return emptyList()
        return out
    }

    fun interactivePromptSummary(screenText: String): String {
        val recentLines = screenText
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .takeLast(12)
        return recentLines.firstOrNull { INTERACTIVE_PROMPT_KEYWORD_RE.containsMatchIn(it) }
            ?: recentLines.firstOrNull { INTERACTIVE_FOCUSED_CHOICE_RE.containsMatchIn(it) }
            ?: "Codex is waiting for terminal selection"
    }

    // Passive usage/credit-limit banner (NOT a numbered menu). True when the
    // tail (last ~14 non-blank lines) matches a usage/credit-limit phrase.
    fun isUsageLimitScreen(screenText: String): Boolean {
        val recentLines = screenText
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .takeLast(14)
        if (recentLines.isEmpty()) return false
        return recentLines.any { USAGE_LIMIT_RE.containsMatchIn(it) }
    }

    fun usageLimitSummary(screenText: String): String {
        val recentLines = screenText
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .takeLast(14)
        return recentLines.firstOrNull { USAGE_LIMIT_RE.containsMatchIn(it) }
            ?.let { shorten(it.redactForScouter(), 48) }
            ?: "Codex usage limit reached"
    }

    // --- Classifier --------------------------------------------------------

    // True when the bottom non-blank line is a shell prompt — codex has exited and
    // any menu/approval text above it is stale scrollback, not a live prompt.
    fun endsInShellPrompt(screenText: String): Boolean {
        val last = screenText.lines().map { it.trim() }.lastOrNull { it.isNotBlank() } ?: return false
        return SHELL_PROMPT_RE.matches(last)
    }

    fun classify(screenText: String): Result {
        // Codex exited (shell prompt at the bottom): never surface a stale menu
        // still visible above it.
        if (endsInShellPrompt(screenText)) return Result(State.INACTIVE)
        val usageLimited = isUsageLimitScreen(screenText)
        // Blocking prompts use codex-specific keyword regexes (APPROVAL_KEYWORD_RE
        // / INTERACTIVE_PROMPT_KEYWORD_RE), so surface them even when the
        // "OpenAI Codex" banner / "gpt … · /" status line has scrolled off the top.
        // A long rate-limit / model-switch menu often leaves no banner in view, and
        // gating on isActiveCodexScreen first would miss exactly the state we must
        // surface (matches the JS detectCodexInteractivePrompt, which is ungated).
        if (isApprovalPromptScreen(screenText)) {
            return Result(
                state = State.APPROVAL,
                summary = approvalSummary(screenText),
                usageLimited = usageLimited
            )
        }
        if (isInteractivePromptScreen(screenText)) {
            return Result(
                state = State.INTERACTIVE,
                choices = parseInteractiveChoices(screenText),
                summary = interactivePromptSummary(screenText),
                usageLimited = usageLimited
            )
        }
        // No blocking prompt visible: require an active codex screen to claim READY,
        // otherwise the bound terminal has dropped to a shell / something else.
        if (!isActiveCodexScreen(screenText)) return Result(State.INACTIVE)
        if (usageLimited) {
            return Result(
                state = State.RATE_LIMITED,
                summary = usageLimitSummary(screenText),
                usageLimited = true
            )
        }
        return Result(State.READY)
    }

    private fun approvalSummary(screenText: String): String {
        val recentLines = screenText
            .lines()
            .map { it.trim() }
            .filter { it.isNotBlank() }
            .takeLast(8)
        return recentLines.firstOrNull { APPROVAL_KEYWORD_RE.containsMatchIn(it) }
            ?.let { shorten(it.redactForScouter(), 48) }
            ?: "Codex needs approval"
    }

    // --- Helpers -----------------------------------------------------------

    private fun shorten(value: String, max: Int): String {
        val cleaned = value.replace(Regex("\\s+"), " ").trim()
        return if (cleaned.length > max) cleaned.take(max - 1) + "…" else cleaned
    }

    // --- Regexes (copied verbatim from ScouterWidgetProvider) --------------

    private val CODEX_STATUS_RE = Regex("""\b(?:gpt|o\d|codex)[A-Za-z0-9_.-]*\b.*[·•]\s*/""", RegexOption.IGNORE_CASE)
    private val SHELL_PROMPT_RE = Regex("""^(?:[~\w./:@+-]+\s*)?[$#]\s*$""")
    private val APPROVAL_KEYWORD_RE = Regex("""\b(?:approval|approve|permission|allow|deny)\b""", RegexOption.IGNORE_CASE)
    private val APPROVAL_CHOICE_RE = Regex("""\b(?:y/n|yes/no|allow|deny|approve|reject)\b|^\s*(?:[^A-Za-z0-9\s]\s*)?(?:\d+[\).]\s*)?(?:yes|no|y|n)\b(?:\s*[,):.-]|\s*$)|[\[(]\s*[yY]\s*/\s*[nN]\s*[\])]""", RegexOption.IGNORE_CASE)
    private val INTERACTIVE_PROMPT_KEYWORD_RE = Regex("""(?:Approaching rate limits|Switch to\b.*\bmodel\b|Keep current model|Would you like to make the following edits|Yes,\s*proceed|don't ask again|Press enter to confirm|esc to go back|rate limit reminders|select an option|choose an option)""", RegexOption.IGNORE_CASE)
    private val INTERACTIVE_NUMBERED_CHOICE_RE = Regex("""^\s*(?:[>]\s*)?\d+[\).]\s+\S""")
    private val INTERACTIVE_FOCUSED_CHOICE_RE = Regex("""^\s*(?:[>]\s*)\d+[\).]\s+\S""")
    // Capturing variant of INTERACTIVE_NUMBERED_CHOICE_RE: group 1 = digit,
    // group 2 = label text after the "<digit>." / "<digit>)" marker.
    private val INTERACTIVE_CHOICE_CAPTURE_RE = Regex("""^\s*(?:[>]\s*)?(\d+)[\).]\s+(\S.*)$""")
    private val USAGE_LIMIT_RE = Regex("""(?i)(?:you'?ve\s+hit\s+your\s+usage\s+limit|usage\s+limit\s+(?:reached|hit)|out\s+of\s+credits|purchase\s+more\s+credits|rate\s*limit(?:ed)?\s+reached)""")
}
