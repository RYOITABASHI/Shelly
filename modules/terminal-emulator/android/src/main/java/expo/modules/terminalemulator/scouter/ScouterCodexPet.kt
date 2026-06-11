package expo.modules.terminalemulator.scouter

import android.content.Context
import android.content.SharedPreferences
import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import org.json.JSONObject
import java.util.Locale

internal object ScouterCodexPet {
    private const val PREFS = "scouter_widget"
    private const val KEY_VISIBLE = "codex_pet_visible"
    private const val ASSET_ROOT = "pets/shelly-rider"
    private const val COLUMNS = 8
    private const val CELL_WIDTH = 192
    private const val CELL_HEIGHT = 208
    private val frameCounts = intArrayOf(6, 8, 8, 4, 5, 8, 6, 6, 6)

    private var cachedAtlas: Bitmap? = null

    enum class State(val row: Int) {
        IDLE(0),
        WAVING(3),
        FAILED(5),
        WAITING(6),
        RUNNING(7),
        REVIEW(8)
    }

    fun isVisible(context: Context): Boolean =
        prefs(context).getBoolean(KEY_VISIBLE, true)

    fun toggleVisible(context: Context) {
        val preferences = prefs(context)
        preferences.edit().putBoolean(KEY_VISIBLE, !preferences.getBoolean(KEY_VISIBLE, true)).apply()
    }

    fun frameBitmap(context: Context, state: State, timestampMillis: Long): Bitmap? {
        val atlas = atlas(context) ?: return null
        val row = state.row.coerceIn(frameCounts.indices)
        val frameCount = frameCounts[row].coerceAtLeast(1)
        val frame = ((timestampMillis / 60_000L) % frameCount).toInt()
        return runCatching {
            Bitmap.createBitmap(
                atlas,
                frame * CELL_WIDTH,
                row * CELL_HEIGHT,
                CELL_WIDTH,
                CELL_HEIGHT
            )
        }.getOrNull()
    }

    private fun atlas(context: Context): Bitmap? {
        cachedAtlas?.takeUnless { it.isRecycled }?.let { return it }
        return runCatching {
            val assets = context.applicationContext.assets
            val manifest = JSONObject(readUtf8(assets, "$ASSET_ROOT/pet.json"))
            val spritesheet = manifest.optString("spritesheetPath", "spritesheet.webp")
            if (!isSafeAssetName(spritesheet)) return null

            assets.open("$ASSET_ROOT/$spritesheet").use { input ->
                val decoded = BitmapFactory.decodeStream(input) ?: return null
                if (
                    decoded.width < COLUMNS * CELL_WIDTH ||
                    decoded.height < frameCounts.size * CELL_HEIGHT
                ) {
                    decoded.recycle()
                    return null
                }
                cachedAtlas = decoded
                decoded
            }
        }.getOrNull()
    }

    private fun readUtf8(assets: AssetManager, path: String): String =
        assets.open(path).use { input -> input.readBytes().toString(Charsets.UTF_8) }

    private fun isSafeAssetName(name: String?): Boolean {
        if (name.isNullOrEmpty() || name.length > 80) return false
        val lower = name.lowercase(Locale.US)
        if (!lower.endsWith(".webp") && !lower.endsWith(".png")) return false
        return name.all { char ->
            char in 'a'..'z' ||
                char in 'A'..'Z' ||
                char in '0'..'9' ||
                char == '.' ||
                char == '_' ||
                char == '-'
        }
    }

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}
