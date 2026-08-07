package expo.modules.terminalview

/**
 * Detects clickable links in terminal output text:
 *   - URLs (http/https)
 *   - File paths (absolute, relative, home-relative)
 *   - Error references (file:line:col format from compilers/linters)
 */
object LinkDetector {

    enum class LinkType {
        URL,
        FILE_PATH,
        ERROR_REF
    }

    data class DetectedLink(
        val text: String,
        val type: LinkType,
        val startIndex: Int,
        val endIndex: Int,
        val filePath: String? = null,
        val line: Int? = null,
        val column: Int? = null
    )

    // URL pattern: http(s)://... until whitespace or common terminal chars.
    // 2026-08-07 on-device QA finding (docs/superpowers/DEFERRED.md): no
    // IGNORE_CASE meant an upper/mixed-case scheme (e.g. `echo
    // "HTTPS://EXAMPLE.COM/PATH"`, common for shell-scripted output) was
    // never detected as a link at all, not merely unclickable.
    private val URL_PATTERN = Regex(
        """https?://[^\s<>"'\])|}\x1b]+""",
        RegexOption.IGNORE_CASE
    )

    // Error reference: file.ext:42 or file.ext:42:10
    // Must have an extension to avoid false positives
    private val ERROR_REF_PATTERN = Regex(
        """(?:^|[\s(])([./~]?[\w./_-]+\.\w+):(\d+)(?::(\d+))?"""
    )

    // File path: starts with /, ./, ../, or ~/
    // Must contain at least one / to distinguish from regular words
    private val FILEPATH_PATTERN = Regex(
        """(?:^|[\s"'(])([/~][\w./_-]*(?:/[\w./_-]+)+)"""
    )

    /**
     * Detect all links in the given text.
     * Returns a list of DetectedLink sorted by start position.
     */
    fun detect(text: String): List<DetectedLink> {
        val links = mutableListOf<DetectedLink>()
        val usedRanges = mutableListOf<IntRange>()

        // 1. URLs first (highest priority)
        for (match in URL_PATTERN.findAll(text)) {
            val link = DetectedLink(
                text = match.value,
                type = LinkType.URL,
                startIndex = match.range.first,
                endIndex = match.range.last + 1
            )
            links.add(link)
            usedRanges.add(match.range)
        }

        // 2. Error references (file:line:col)
        for (match in ERROR_REF_PATTERN.findAll(text)) {
            val range = IntRange(match.groups[1]!!.range.first, match.range.last)
            if (usedRanges.any { it.overlaps(range) }) continue

            val filePath = match.groupValues[1]
            val line = match.groupValues[2].toIntOrNull()
            val column = match.groupValues[3].toIntOrNull()

            links.add(DetectedLink(
                text = text.substring(range),
                type = LinkType.ERROR_REF,
                startIndex = range.first,
                endIndex = range.last + 1,
                filePath = filePath,
                line = line,
                column = column
            ))
            usedRanges.add(range)
        }

        // 3. File paths
        for (match in FILEPATH_PATTERN.findAll(text)) {
            val pathGroup = match.groups[1] ?: continue
            val range = pathGroup.range
            if (usedRanges.any { it.overlaps(range) }) continue

            links.add(DetectedLink(
                text = pathGroup.value,
                type = LinkType.FILE_PATH,
                startIndex = range.first,
                endIndex = range.last + 1,
                filePath = pathGroup.value
            ))
            usedRanges.add(range)
        }

        return links.sortedBy { it.startIndex }
    }

    private fun IntRange.overlaps(other: IntRange): Boolean {
        return this.first <= other.last && other.first <= this.last
    }
}
