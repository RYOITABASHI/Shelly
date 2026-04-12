package expo.modules.terminalview

import android.content.Context
import android.graphics.Typeface

object FontManager {
    private val fontCache = mutableMapOf<String, Typeface>()

    fun getTypeface(context: Context, family: String, style: Int = Typeface.NORMAL): Typeface {
        val key = "$family-$style"
        return fontCache.getOrPut(key) {
            val assetPath = when (family) {
                "jetbrains-mono" -> when (style) {
                    Typeface.BOLD -> "fonts/JetBrainsMono-Bold.ttf"
                    Typeface.ITALIC -> "fonts/JetBrainsMono-Italic.ttf"
                    else -> "fonts/JetBrainsMono-Regular.ttf"
                }
                "fira-code" -> when (style) {
                    Typeface.BOLD -> "fonts/FiraCode-Bold.ttf"
                    else -> "fonts/FiraCode-Regular.ttf"
                }
                "pixel-mplus" -> "fonts/PixelMplus12-Regular.ttf"
                "silkscreen" -> "fonts/Silkscreen-Regular.ttf"
                else -> "fonts/JetBrainsMono-Regular.ttf"
            }
            try {
                Typeface.createFromAsset(context.assets, assetPath)
            } catch (e: Exception) {
                Typeface.MONOSPACE
            }
        }
    }

    fun clearCache() {
        fontCache.clear()
    }
}
