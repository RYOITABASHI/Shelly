package expo.modules.terminalview.gl

import android.opengl.GLES30
import com.termux.terminal.TerminalBuffer
import com.termux.terminal.TextStyle
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.nio.ShortBuffer
import java.util.BitSet

/**
 * Converts TerminalRow data into GPU vertex buffers.
 * Each cell = 2 quads (background + glyph).
 *
 * Vertex format: x, y, u, v, r, g, b, a (8 floats = 32 bytes)
 * 4 vertices per quad, 2 quads per cell.
 */
class CellBatcher(private var cols: Int, private var rows: Int, private val atlas: GlyphAtlas) {
    companion object {
        private const val FLOATS_PER_VERTEX = 8  // x, y, u, v, r, g, b, a
        private const val VERTICES_PER_QUAD = 4
        private const val QUADS_PER_CELL = 2     // background + glyph
        private const val INDICES_PER_QUAD = 6   // 2 triangles
    }

    private var vboId = 0
    private var iboId = 0
    private val dirtyRows = BitSet(rows)
    private lateinit var vertexData: FloatBuffer
    private var totalCells = cols * rows

    // Collapsed block ranges — rows in these ranges are skipped
    private val collapsedRanges = mutableListOf<IntRange>()

    // Default ANSI 16 colors (updated from theme)
    private val ansiColors = IntArray(256) { defaultAnsiColor(it) }

    fun init() {
        totalCells = cols * rows
        val vertexCount = totalCells * QUADS_PER_CELL * VERTICES_PER_QUAD
        val indexCount = totalCells * QUADS_PER_CELL * INDICES_PER_QUAD

        // Allocate vertex buffer
        vertexData = ByteBuffer.allocateDirect(vertexCount * FLOATS_PER_VERTEX * 4)
            .order(ByteOrder.nativeOrder())
            .asFloatBuffer()

        // Generate index buffer (static — same triangle pattern for all quads)
        val indices = ShortBuffer.allocate(indexCount)
        for (i in 0 until totalCells * QUADS_PER_CELL) {
            val base = (i * 4).toShort()
            indices.put(base)
            indices.put((base + 1).toShort())
            indices.put((base + 2).toShort())
            indices.put((base + 2).toShort())
            indices.put((base + 3).toShort())
            indices.put(base)
        }
        indices.flip()

        // Create VBO
        val bufIds = IntArray(2)
        GLES30.glGenBuffers(2, bufIds, 0)
        vboId = bufIds[0]
        iboId = bufIds[1]

        // Upload index buffer (static)
        GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, iboId)
        GLES30.glBufferData(GLES30.GL_ELEMENT_ARRAY_BUFFER, indexCount * 2, indices, GLES30.GL_STATIC_DRAW)

        // Allocate vertex buffer (dynamic)
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vboId)
        GLES30.glBufferData(GLES30.GL_ARRAY_BUFFER, vertexCount * FLOATS_PER_VERTEX * 4, null, GLES30.GL_DYNAMIC_DRAW)

        markAllDirty()
    }

    fun resize(newCols: Int, newRows: Int) {
        cols = newCols
        rows = newRows
        destroy()
        init()
    }

    fun markDirty(row: Int) {
        if (row in 0 until rows) dirtyRows.set(row)
    }

    fun markAllDirty() {
        dirtyRows.set(0, rows)
    }

    fun updateDirtyRows(buffer: TerminalBuffer, topRow: Int, highlightCache: HighlightCache) {
        val cellW = atlas.cellWidth
        val cellH = atlas.cellHeight

        var row = dirtyRows.nextSetBit(0)
        while (row >= 0 && row < rows) {
            // Skip collapsed rows
            if (isRowCollapsed(topRow + row)) {
                row = dirtyRows.nextSetBit(row + 1)
                continue
            }

            val absRow = topRow + row
            val termRow = try { buffer.getRow(absRow) } catch (_: Exception) { null }
            val highlights = highlightCache.getHighlights(absRow)

            val bufCols = try { buffer.getColumns() } catch (_: Exception) { cols }
            for (col in 0 until cols) {
                val cellIndex = row * cols + col
                val codepoint = if (termRow != null && col < bufCols) {
                    try {
                        val charIdx = termRow.findStartOfColumn(col)
                        val spaceUsed = termRow.getSpaceUsed()
                        if (charIdx in 0 until spaceUsed) {
                            val c = termRow.mText[charIdx]
                            if (Character.isHighSurrogate(c) && charIdx + 1 < spaceUsed)
                                Character.toCodePoint(c, termRow.mText[charIdx + 1])
                            else c.code
                        } else ' '.code
                    } catch (_: Exception) { ' '.code }
                } else ' '.code
                val style = if (termRow != null && col < bufCols) { try { termRow.getStyle(col) } catch (_: Exception) { 0L } } else 0L

                // Decode colors from style (pass directly — matches existing SyntaxHighlighter usage)
                val fg = TextStyle.decodeForeColor(style)
                val bg = TextStyle.decodeBackColor(style)
                val highlightFg = if (highlights != null && col < highlights.size) highlights[col] else -1

                val effectiveFg = if (highlightFg >= 0) highlightFg else fg
                val fgColor = resolveColor(effectiveFg)
                val bgColor = resolveColor(bg)

                val x = col * cellW
                val y = row * cellH

                // Background quad
                writeQuad(cellIndex * 2, x, y, cellW, cellH,
                    0f, 0f, 0f, 0f,  // no texture for bg
                    bgColor)

                // Glyph quad
                if (codepoint > 0x20) {
                    val glyph = atlas.getGlyph(codepoint)
                    writeQuad(cellIndex * 2 + 1,
                        x + glyph.bearingX, y + (atlas.baseline - glyph.bearingY),
                        glyph.width, glyph.height,
                        glyph.u0, glyph.v0, glyph.u1, glyph.v1,
                        fgColor)
                } else {
                    // Empty/space — zero-area glyph quad
                    writeQuad(cellIndex * 2 + 1, x, y, 0f, 0f, 0f, 0f, 0f, 0f, 0)
                }
            }

            // Upload this row's vertex data via glBufferSubData
            val rowStart = row * cols * QUADS_PER_CELL * VERTICES_PER_QUAD * FLOATS_PER_VERTEX
            val rowSize = cols * QUADS_PER_CELL * VERTICES_PER_QUAD * FLOATS_PER_VERTEX
            vertexData.position(rowStart)
            GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vboId)
            GLES30.glBufferSubData(GLES30.GL_ARRAY_BUFFER, rowStart * 4, rowSize * 4, vertexData)

            dirtyRows.clear(row)
            row = dirtyRows.nextSetBit(row + 1)
        }
    }

    fun draw(pass: Int) {
        // pass 0 = backgrounds, pass 1 = glyphs
        GLES30.glBindBuffer(GLES30.GL_ARRAY_BUFFER, vboId)
        GLES30.glBindBuffer(GLES30.GL_ELEMENT_ARRAY_BUFFER, iboId)

        // Setup vertex attribs
        val stride = FLOATS_PER_VERTEX * 4
        GLES30.glEnableVertexAttribArray(0) // position
        GLES30.glVertexAttribPointer(0, 2, GLES30.GL_FLOAT, false, stride, 0)
        GLES30.glEnableVertexAttribArray(1) // texCoord
        GLES30.glVertexAttribPointer(1, 2, GLES30.GL_FLOAT, false, stride, 8)
        GLES30.glEnableVertexAttribArray(2) // color
        GLES30.glVertexAttribPointer(2, 4, GLES30.GL_FLOAT, false, stride, 16)

        val indicesPerRow = cols * INDICES_PER_QUAD
        for (row in 0 until rows) {
            if (isRowCollapsed(row)) continue
            val offset = row * cols * QUADS_PER_CELL * INDICES_PER_QUAD
            val quadOffset = if (pass == 0) 0 else cols * INDICES_PER_QUAD
            GLES30.glDrawElements(
                GLES30.GL_TRIANGLES,
                indicesPerRow,
                GLES30.GL_UNSIGNED_SHORT,
                (offset + quadOffset) * 2
            )
        }
    }

    fun setCollapsedRanges(ranges: List<IntRange>) {
        collapsedRanges.clear()
        collapsedRanges.addAll(ranges)
    }

    fun updateAnsiColors(colors: IntArray) {
        colors.copyInto(ansiColors, 0, 0, minOf(colors.size, 256))
        markAllDirty()
    }

    fun destroy() {
        if (vboId != 0) {
            GLES30.glDeleteBuffers(2, intArrayOf(vboId, iboId), 0)
            vboId = 0
            iboId = 0
        }
    }

    private fun isRowCollapsed(absRow: Int): Boolean {
        return collapsedRanges.any { absRow in it }
    }

    private fun writeQuad(
        quadIndex: Int,
        x: Float, y: Float, w: Float, h: Float,
        u0: Float, v0: Float, u1: Float, v1: Float,
        color: Int
    ) {
        val r = ((color shr 16) and 0xFF) / 255f
        val g = ((color shr 8) and 0xFF) / 255f
        val b = (color and 0xFF) / 255f
        val a = ((color shr 24) and 0xFF) / 255f

        val base = quadIndex * VERTICES_PER_QUAD * FLOATS_PER_VERTEX
        vertexData.position(base)

        // Top-left
        vertexData.put(x); vertexData.put(y)
        vertexData.put(u0); vertexData.put(v0)
        vertexData.put(r); vertexData.put(g); vertexData.put(b); vertexData.put(a)

        // Top-right
        vertexData.put(x + w); vertexData.put(y)
        vertexData.put(u1); vertexData.put(v0)
        vertexData.put(r); vertexData.put(g); vertexData.put(b); vertexData.put(a)

        // Bottom-right
        vertexData.put(x + w); vertexData.put(y + h)
        vertexData.put(u1); vertexData.put(v1)
        vertexData.put(r); vertexData.put(g); vertexData.put(b); vertexData.put(a)

        // Bottom-left
        vertexData.put(x); vertexData.put(y + h)
        vertexData.put(u0); vertexData.put(v1)
        vertexData.put(r); vertexData.put(g); vertexData.put(b); vertexData.put(a)
    }

    private fun resolveColor(colorIndex: Int): Int {
        return if (colorIndex in 0..255) ansiColors[colorIndex]
        else 0xFFFFFFFF.toInt() // default white
    }

    private fun defaultAnsiColor(index: Int): Int {
        // Standard ANSI 16 colors (ARGB)
        val base16 = intArrayOf(
            0xFF000000.toInt(), 0xFFCD0000.toInt(), 0xFF00CD00.toInt(), 0xFFCDCD00.toInt(),
            0xFF0000EE.toInt(), 0xFFCD00CD.toInt(), 0xFF00CDCD.toInt(), 0xFFE5E5E5.toInt(),
            0xFF7F7F7F.toInt(), 0xFFFF0000.toInt(), 0xFF00FF00.toInt(), 0xFFFFFF00.toInt(),
            0xFF5C5CFF.toInt(), 0xFFFF00FF.toInt(), 0xFF00FFFF.toInt(), 0xFFFFFFFF.toInt()
        )
        return when {
            index < 16 -> base16[index]
            index < 232 -> {
                // 6x6x6 color cube
                val i = index - 16
                val r = (i / 36) * 51
                val g = ((i / 6) % 6) * 51
                val b = (i % 6) * 51
                (0xFF shl 24) or (r shl 16) or (g shl 8) or b
            }
            else -> {
                // Grayscale ramp
                val v = 8 + (index - 232) * 10
                (0xFF shl 24) or (v shl 16) or (v shl 8) or v
            }
        }
    }
}
