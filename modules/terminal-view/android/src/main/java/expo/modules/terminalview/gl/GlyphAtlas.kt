package expo.modules.terminalview.gl

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.opengl.GLES30
import android.util.Log
import java.nio.ByteBuffer

class GlyphAtlas(private var typeface: Typeface, private var fontSize: Float) {
    companion object {
        private const val TAG = "GlyphAtlas"
        private const val PAGE_SIZE = 1024
        private const val LRU_MAX_SIZE = 2048
    }

    data class GlyphInfo(
        val textureId: Int,
        val u0: Float, val v0: Float,
        val u1: Float, val v1: Float,
        val width: Float, val height: Float,
        val bearingX: Float, val bearingY: Float,
        val advance: Float
    )

    private val glyphs = HashMap<Int, GlyphInfo>(256)
    private val pages = mutableListOf<Int>()  // GL texture IDs
    private var currentX = 0
    private var currentY = 0
    private var rowHeight = 0

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xFFFFFFFF.toInt()
        textAlign = Paint.Align.LEFT
    }

    // Cell metrics (computed from font)
    var cellWidth: Float = 0f; private set
    var cellHeight: Float = 0f; private set
    var baseline: Float = 0f; private set

    fun build() {
        destroy()
        updatePaint()
        computeCellMetrics()
        allocateNewPage()

        // Pre-rasterize ASCII (0x20-0x7E)
        for (cp in 0x20..0x7E) {
            rasterizeGlyph(cp)
        }

        // Box-drawing characters (U+2500-U+257F)
        for (cp in 0x2500..0x257F) {
            rasterizeGlyph(cp)
        }

        Log.i(TAG, "build: ${glyphs.size} glyphs, cellWidth=$cellWidth, cellHeight=$cellHeight")
    }

    fun rebuild() {
        glyphs.clear()
        pages.clear()
        currentX = 0
        currentY = 0
        rowHeight = 0
        build()
    }

    fun getGlyph(codepoint: Int): GlyphInfo {
        return glyphs.getOrPut(codepoint) {
            rasterizeGlyph(codepoint)
        }
    }

    fun updateFont(newTypeface: Typeface, newFontSize: Float) {
        typeface = newTypeface
        fontSize = newFontSize
        rebuild()
    }

    fun destroy() {
        if (pages.isNotEmpty()) {
            val ids = pages.toIntArray()
            GLES30.glDeleteTextures(ids.size, ids, 0)
            pages.clear()
        }
        glyphs.clear()
        currentX = 0
        currentY = 0
        rowHeight = 0
    }

    private fun updatePaint() {
        paint.typeface = typeface
        paint.textSize = fontSize
    }

    private fun computeCellMetrics() {
        val fm = paint.fontMetrics
        cellHeight = fm.bottom - fm.top
        baseline = -fm.top
        cellWidth = paint.measureText("M")
    }

    private fun allocateNewPage(): Int {
        val texIds = IntArray(1)
        GLES30.glGenTextures(1, texIds, 0)
        val texId = texIds[0]

        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texId)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, GLES30.GL_LINEAR)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
        GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)

        // Allocate empty R8 texture (GL_ALPHA removed in ES 3.0)
        GLES30.glTexImage2D(
            GLES30.GL_TEXTURE_2D, 0, GLES30.GL_R8,
            PAGE_SIZE, PAGE_SIZE, 0,
            GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE, null
        )

        pages.add(texId)
        currentX = 0
        currentY = 0
        rowHeight = 0
        return texId
    }

    private fun rasterizeGlyph(codepoint: Int): GlyphInfo {
        val text = String(Character.toChars(codepoint))
        val charWidth = paint.measureText(text)
        val fm = paint.fontMetrics
        val glyphH = (fm.bottom - fm.top).toInt() + 2
        val glyphW = (charWidth + 2).toInt().coerceAtLeast(1)

        // Check if we need to wrap to next row or new page
        if (currentX + glyphW > PAGE_SIZE) {
            currentX = 0
            currentY += rowHeight
        }
        if (currentY + glyphH > PAGE_SIZE) {
            allocateNewPage()
        }
        rowHeight = maxOf(rowHeight, glyphH)

        // Rasterize to bitmap
        val bmp = Bitmap.createBitmap(glyphW, glyphH, Bitmap.Config.ALPHA_8)
        val canvas = Canvas(bmp)
        canvas.drawText(text, 1f, -fm.top + 1f, paint)

        // Upload to current texture page via raw bytes (GLUtils doesn't handle R8 correctly)
        val texId = pages.last()
        GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, texId)
        val pixelBuf = ByteBuffer.allocateDirect(glyphW * glyphH)
        bmp.copyPixelsToBuffer(pixelBuf)
        pixelBuf.flip()
        GLES30.glTexSubImage2D(
            GLES30.GL_TEXTURE_2D, 0, currentX, currentY, glyphW, glyphH,
            GLES30.GL_RED, GLES30.GL_UNSIGNED_BYTE, pixelBuf
        )
        bmp.recycle()

        val info = GlyphInfo(
            textureId = texId,
            u0 = currentX.toFloat() / PAGE_SIZE,
            v0 = currentY.toFloat() / PAGE_SIZE,
            u1 = (currentX + glyphW).toFloat() / PAGE_SIZE,
            v1 = (currentY + glyphH).toFloat() / PAGE_SIZE,
            width = glyphW.toFloat(),
            height = glyphH.toFloat(),
            bearingX = 1f,
            bearingY = -fm.top + 1f,
            advance = charWidth
        )

        glyphs[codepoint] = info
        currentX += glyphW

        // LRU eviction for non-ASCII
        if (glyphs.size > LRU_MAX_SIZE) {
            val toRemove = glyphs.keys.filter { it > 0x7F }.take(glyphs.size - LRU_MAX_SIZE + 256)
            toRemove.forEach { glyphs.remove(it) }
        }

        return info
    }
}
