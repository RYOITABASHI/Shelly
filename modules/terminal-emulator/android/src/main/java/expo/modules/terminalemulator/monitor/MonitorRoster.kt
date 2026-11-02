package expo.modules.terminalemulator.monitor

import org.json.JSONArray
import org.json.JSONObject

/**
 * The MONITOR "staff" roster for the widget's idle tiles: the user's agent
 * roles, read from `$HOME/.shelly/agents/monitor-roster.json`, a DISPLAY-ONLY
 * snapshot RN derives from the sealed roles.json and publishes whenever the
 * roles load or change (lib/monitor-roster.ts). Native only reads it — it is
 * never written here, and roles.json itself is never read here.
 *
 * Everything in the file is untrusted display text (anything with the app's
 * uid can rewrite it): the parser keeps only known fields, re-applies the caps
 * ([MAX_ENTRIES] entries, [MAX_TEXT_CHARS] code points per string), drops
 * control / format characters (bidi overrides, zero-width…), and fails closed
 * to an empty roster on anything malformed.
 *
 * Pure: no Android, no I/O. org.json is the only dependency.
 */
object MonitorRoster {
    const val KIND = "shelly-monitor-roster"
    const val VERSION = 1
    const val MAX_ENTRIES = 8
    const val MAX_TEXT_CHARS = 24
    /** The writer's output is far below this; anything bigger is not ours. */
    const val MAX_FILE_BYTES = 16 * 1024L
    /** Role-name channel label length, same as lib/monitor-live.ts ROLE_CHANNEL_MAX_CHARS. */
    const val CHANNEL_MAX_CHARS = 10
    private val KINDS = setOf("CLI", "API", "LOCAL")

    data class Entry(val name: String, val engine: String, val kind: String?)

    data class Roster(
        val entries: List<Entry> = emptyList(),
        /** Roles the user has (≥ entries.size; the widget shows "+N" for the rest). */
        val total: Int = 0,
        /** RN could not verify roles.json: no names, a "can't read" hint. */
        val unavailable: Boolean = false,
        /** A roster file was read at all (false = RN never published one). */
        val present: Boolean = false
    ) {
        val isEmpty: Boolean get() = entries.isEmpty()
        val hidden: Int get() = (total - entries.size).coerceAtLeast(0)
    }

    val NONE = Roster()

    /** Display-safe text: unprintables → space, whitespace collapsed, ≤ [max] code points. */
    fun clean(value: String?, max: Int = MAX_TEXT_CHARS): String {
        if (value == null) return ""
        val sb = StringBuilder()
        var i = 0
        while (i < value.length) {
            val cp = value.codePointAt(i)
            i += Character.charCount(cp)
            val type = Character.getType(cp)
            val unprintable = Character.isISOControl(cp) ||
                type == Character.FORMAT.toInt() ||
                type == Character.LINE_SEPARATOR.toInt() ||
                type == Character.PARAGRAPH_SEPARATOR.toInt() ||
                type == Character.UNASSIGNED.toInt() ||
                type == Character.PRIVATE_USE.toInt() ||
                type == Character.SURROGATE.toInt()
            if (unprintable || Character.isWhitespace(cp) || Character.isSpaceChar(cp)) sb.append(' ') else sb.appendCodePoint(cp)
        }
        val flat = sb.toString().replace(Regex(" +"), " ").trim()
        return takeCodePoints(flat, max).trim()
    }

    private fun takeCodePoints(text: String, max: Int): String {
        if (text.codePointCount(0, text.length) <= max) return text
        return text.substring(0, text.offsetByCodePoints(0, max))
    }

    /** Parses the roster file; [NONE]-like (present, empty) on anything malformed. */
    fun parse(text: String?): Roster {
        if (text == null) return NONE
        val o = try {
            JSONObject(text.trim())
        } catch (_: Exception) {
            return Roster(present = true)
        }
        if (o.optString("kind") != KIND || o.opt("version") != VERSION) return Roster(present = true)
        if (o.opt("unavailable") == true) return Roster(unavailable = true, present = true)
        val list = o.opt("roles") as? JSONArray ?: return Roster(present = true)
        val entries = ArrayList<Entry>()
        val seen = HashSet<String>()
        for (i in 0 until minOf(list.length(), MAX_ENTRIES * 4)) {
            if (entries.size >= MAX_ENTRIES) break
            val e = list.opt(i) as? JSONObject ?: continue
            val name = clean(e.opt("name") as? String)
            if (name.isEmpty() || !seen.add(name.lowercase())) continue
            val engine = clean(e.opt("engine") as? String)
            val kind = (e.opt("kind") as? String)?.takeIf { it in KINDS }
            entries += Entry(name, engine, kind)
        }
        val totalRaw = o.opt("total")
        val total = if (totalRaw is Number && totalRaw.toDouble().isFinite()) totalRaw.toInt().coerceIn(entries.size, 99) else entries.size
        return Roster(entries = entries, total = total, present = true)
    }

    /**
     * Channel label of a role, same rules as lib/monitor-live.ts
     * liveChannelLabel: whitespace collapsed, ≤ [CHANNEL_MAX_CHARS] code
     * points, latin a–z uppercased; empty when the name has nothing left.
     */
    fun channelLabel(name: String?): String {
        val flat = clean(name, MAX_TEXT_CHARS)
        if (flat.isEmpty()) return ""
        val cut = takeCodePoints(flat, CHANNEL_MAX_CHARS).trim()
        val sb = StringBuilder()
        for (ch in cut) sb.append(if (ch in 'a'..'z') ch - 32 else ch)
        return sb.toString()
    }

    /**
     * Role name per step (plan order) from an agent definition
     * (`orchestration.steps[i].role.name`), for role-named channels during a
     * run. Display only, cleaned; null entries for steps without a role.
     */
    fun stepRoleNames(agent: JSONObject?): List<String?> {
        val steps = agent?.optJSONObject("orchestration")?.opt("steps") as? JSONArray ?: return emptyList()
        val out = ArrayList<String?>()
        for (i in 0 until minOf(steps.length(), 64)) {
            val s = steps.opt(i) as? JSONObject
            val name = clean(s?.optJSONObject("role")?.opt("name") as? String)
            out += name.ifEmpty { null }
        }
        return out
    }
}
