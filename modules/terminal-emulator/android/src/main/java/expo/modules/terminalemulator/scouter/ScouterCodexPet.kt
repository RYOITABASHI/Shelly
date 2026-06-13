package expo.modules.terminalemulator.scouter

import android.content.Context
import android.content.SharedPreferences
import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import expo.modules.terminalemulator.HomeInitializer
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale

internal object ScouterCodexPet {
    private const val PREFS = "scouter_widget"
    private const val KEY_VISIBLE = "codex_pet_visible"
    private const val KEY_SELECTED_PET_ID = "codex_pet_selected_id"
    private const val KEY_SELECTED_PET_KEY = "codex_pet_selected_key"
    private const val DEFAULT_VISIBLE = false
    private const val ASSET_PET_ROOT = "pets"
    private const val COLUMNS = 8
    private const val CELL_WIDTH = 192
    private const val CELL_HEIGHT = 208
    private val frameCounts = intArrayOf(6, 8, 8, 4, 5, 8, 6, 6, 6)

    private var cachedAtlas: Bitmap? = null
    private var cachedAtlasKey: String? = null

    enum class State(val row: Int) {
        IDLE(0),
        WAVING(3),
        FAILED(5),
        WAITING(6),
        RUNNING(7),
        REVIEW(8)
    }

    fun isVisible(context: Context): Boolean =
        prefs(context).getBoolean(KEY_VISIBLE, DEFAULT_VISIBLE)

    fun cycleVisiblePet(context: Context) {
        val pets = discoverPets(context)
            .filter { atlas(context, it) != null }
            .distinctBy { it.id }
        val preferences = prefs(context)
        if (pets.isEmpty()) {
            preferences.edit()
                .putBoolean(KEY_VISIBLE, false)
                .remove(KEY_SELECTED_PET_ID)
                .remove(KEY_SELECTED_PET_KEY)
                .apply()
            return
        }

        if (!preferences.getBoolean(KEY_VISIBLE, DEFAULT_VISIBLE)) {
            val firstPet = pets.first()
            preferences.edit()
                .putString(KEY_SELECTED_PET_ID, firstPet.id)
                .putString(KEY_SELECTED_PET_KEY, firstPet.selectionKey)
                .putBoolean(KEY_VISIBLE, true)
                .apply()
            return
        }

        val selectedKey = preferences.getString(KEY_SELECTED_PET_KEY, null)?.takeIf { it.isNotBlank() }
        val selectedId = preferences.getString(KEY_SELECTED_PET_ID, null)?.takeIf { isSafeId(it) }
        val currentIndex = selectedKey
            ?.let { key -> pets.indexOfFirst { it.selectionKey == key } }
            ?.takeIf { it >= 0 }
            ?: selectedId
                ?.let { id -> pets.indexOfFirst { it.id == id } }
                ?.takeIf { it >= 0 }
            ?: 0
        if (currentIndex >= pets.lastIndex) {
            preferences.edit()
                .putBoolean(KEY_VISIBLE, false)
                .remove(KEY_SELECTED_PET_ID)
                .remove(KEY_SELECTED_PET_KEY)
                .apply()
            return
        }
        val nextPet = pets[(currentIndex + 1) % pets.size]
        preferences.edit()
            .putString(KEY_SELECTED_PET_ID, nextPet.id)
            .putString(KEY_SELECTED_PET_KEY, nextPet.selectionKey)
            .putBoolean(KEY_VISIBLE, true)
            .apply()
    }

    fun hasPet(context: Context): Boolean =
        discoverPets(context).any { atlas(context, it) != null }

    fun debugJson(context: Context): JSONObject {
        val appContext = context.applicationContext
        val preferences = prefs(appContext)
        val roots = petRoots(appContext)
        val localRoot = roots.firstOrNull() ?: File(HomeInitializer.getHomeDir(appContext), ".codex/pets")
        val rootDirectories = roots.associateWith { root ->
            root.listFiles { file -> file.isDirectory }
                ?.sortedBy { it.name.lowercase(Locale.US) }
                .orEmpty()
        }
        val localDirectories = rootDirectories.values.flatten()
        val selectedKey = preferences.getString(KEY_SELECTED_PET_KEY, null)?.takeIf { it.isNotBlank() }
        val selectedId = preferences.getString(KEY_SELECTED_PET_ID, null)?.takeIf { isSafeId(it) }
        val pets = discoverPets(appContext)
        var validCount = 0
        val petArray = JSONArray()
        pets.forEach { pet ->
            val valid = atlas(appContext, pet) != null
            if (valid) validCount += 1
            petArray.put(JSONObject().apply {
                put("id", pet.id)
                put("source", when (pet) {
                    is PetSource.AssetPet -> "asset"
                    is PetSource.FilePet -> "file"
                })
                put("spritesheet", pet.spritesheet)
                put("selectionKey", pet.selectionKey)
                put("selected", pet.selectionKey == selectedKey || (selectedKey == null && pet.id == selectedId))
                put("valid", valid)
                when (pet) {
                    is PetSource.AssetPet -> {
                        put("root", pet.root)
                    }
                    is PetSource.FilePet -> {
                        val spritesheetFile = File(pet.root, pet.spritesheet)
                        put("root", pet.root.absolutePath)
                        put("spritesheetExists", spritesheetFile.isFile)
                        put("spritesheetBytes", spritesheetFile.length())
                    }
                }
            })
        }
        return JSONObject().apply {
            put("visible", preferences.getBoolean(KEY_VISIBLE, DEFAULT_VISIBLE))
            put("selectedId", selectedId ?: JSONObject.NULL)
            put("selectedKey", selectedKey ?: JSONObject.NULL)
            put("localRoot", localRoot.absolutePath)
            put("localRootExists", localRoot.isDirectory)
            put("localDirectoryCount", localDirectories.size)
            put("localDirectories", JSONArray().also { arr ->
                localDirectories.forEach { arr.put(it.name) }
            })
            put("petRoots", JSONArray().also { arr ->
                roots.forEach { root ->
                    arr.put(JSONObject().apply {
                        put("path", root.absolutePath)
                        put("exists", root.isDirectory)
                        put("directoryCount", rootDirectories[root]?.size ?: 0)
                    })
                }
            })
            put("availablePetCount", pets.size)
            put("validPetCount", validCount)
            put("availablePets", petArray)
        }
    }

    fun frameBitmap(context: Context, state: State, timestampMillis: Long): Bitmap? {
        val atlas = atlasForSelectedOrFallback(context) ?: return null
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

    private fun atlasForSelectedOrFallback(context: Context): Bitmap? {
        val pets = discoverPets(context)
        val preferences = prefs(context)
        val selectedKey = preferences.getString(KEY_SELECTED_PET_KEY, null)?.takeIf { it.isNotBlank() }
        val selectedId = preferences.getString(KEY_SELECTED_PET_ID, null)?.takeIf { isSafeId(it) }
        val orderedPets = when {
            selectedKey != null -> pets.sortedBy { if (it.selectionKey == selectedKey) 0 else 1 }
            selectedId != null -> pets.sortedBy { if (it.id == selectedId) 0 else 1 }
            else -> pets
        }
        return orderedPets.firstNotNullOfOrNull { atlas(context, it) }
    }

    private fun discoverPets(context: Context): List<PetSource> =
        localPets(context) + assetPets(context)

    private fun localPets(context: Context): List<PetSource> =
        petRoots(context).flatMap(::petsInRoot).distinctBy { it.selectionKey }

    private fun petRoots(context: Context): List<File> {
        val filesRoot = context.filesDir.canonicalFile
        val expectedHome = File(filesRoot, "home").absoluteFile
        val home = HomeInitializer.getHomeDir(context).canonicalFile
        if (home.path != expectedHome.path || !home.path.startsWith(filesRoot.path + File.separator)) {
            return emptyList()
        }
        val root = File(home, ".codex/pets").absoluteFile
        val canonicalRoot = runCatching { root.canonicalFile }.getOrNull() ?: return emptyList()
        if (canonicalRoot.path != root.path || !canonicalRoot.path.startsWith(home.path + File.separator)) {
            return emptyList()
        }
        return listOf(root)
            .distinctBy { canonicalKey(it) }
    }

    private fun petsInRoot(root: File): List<PetSource> {
        val directories = root.listFiles { file -> file.isDirectory } ?: return emptyList()
        val canonicalRootPath = runCatching { root.canonicalPath }.getOrNull() ?: return emptyList()
        return directories
            .sortedBy { it.name.lowercase(Locale.US) }
            .mapNotNull { directory ->
                runCatching {
                    val petRoot = directory.absoluteFile
                    val canonicalPetRoot = petRoot.canonicalFile
                    if (
                        canonicalPetRoot.path != petRoot.path ||
                        !canonicalPetRoot.path.startsWith(canonicalRootPath + File.separator)
                    ) return@runCatching null
                    val manifestFile = File(directory, "pet.json")
                    if (!manifestFile.isFile || manifestFile.length() > 32_768L) return@runCatching null
                    val manifest = JSONObject(manifestFile.readText(Charsets.UTF_8))
                    val id = manifest.optString("id", directory.name).takeIf { isSafeId(it) }
                        ?: return@runCatching null
                    val spritesheet = manifest.optString("spritesheetPath", "spritesheet.webp")
                    if (!isSafeAssetName(spritesheet)) return@runCatching null
                    val spritesheetFile = File(directory, spritesheet).canonicalFile
                    if (
                        spritesheetFile.path == canonicalPetRoot.path ||
                        !spritesheetFile.path.startsWith(canonicalPetRoot.path + File.separator)
                    ) return@runCatching null
                    if (!spritesheetFile.isFile) return@runCatching null
                    PetSource.FilePet(
                        id = id,
                        root = directory,
                        spritesheet = spritesheet,
                        selectionKey = "file:${directory.absolutePath}",
                        key = "file:${spritesheetFile.absolutePath}:${spritesheetFile.lastModified()}:${spritesheetFile.length()}"
                    )
                }.getOrNull()
            }
    }

    private fun canonicalKey(file: File): String =
        runCatching { file.canonicalPath }.getOrDefault(file.absolutePath)

    private fun assetPets(context: Context): List<PetSource> {
        return runCatching {
            val assets = context.applicationContext.assets
            assets.list(ASSET_PET_ROOT)
                .orEmpty()
                .filter { isSafePathSegment(it) }
                .sortedBy { it.lowercase(Locale.US) }
                .mapNotNull { directory ->
                    runCatching {
                        val root = "$ASSET_PET_ROOT/$directory"
                        val manifest = JSONObject(readUtf8(assets, "$root/pet.json"))
                        val id = manifest.optString("id", directory).takeIf { isSafeId(it) }
                            ?: return@runCatching null
                        val spritesheet = manifest.optString("spritesheetPath", "spritesheet.webp")
                        if (!isSafeAssetName(spritesheet)) return@runCatching null
                        PetSource.AssetPet(
                            id = id,
                            root = root,
                            spritesheet = spritesheet,
                            selectionKey = "asset:$root",
                            key = "asset:$root/$spritesheet"
                        )
                    }.getOrNull()
                }
        }.getOrDefault(emptyList())
    }

    private fun atlas(context: Context, pet: PetSource): Bitmap? {
        cachedAtlas?.takeUnless { it.isRecycled || cachedAtlasKey != pet.key }?.let { return it }
        return runCatching {
            pet.open(context).use { input ->
                val decoded = BitmapFactory.decodeStream(input) ?: return null
                if (
                    decoded.width < COLUMNS * CELL_WIDTH ||
                    decoded.height < frameCounts.size * CELL_HEIGHT
                ) {
                    decoded.recycle()
                    return null
                }
                cachedAtlas = decoded
                cachedAtlasKey = pet.key
                decoded
            }
        }.getOrNull()
    }

    private fun readUtf8(assets: AssetManager, path: String): String =
        assets.open(path).use { input -> input.readBytes().toString(Charsets.UTF_8) }

    private fun isSafeId(id: String?): Boolean {
        if (id.isNullOrEmpty() || id.length > 80) return false
        return id.all { char ->
            char in 'a'..'z' ||
                char in 'A'..'Z' ||
                char in '0'..'9' ||
                char == '_' ||
                char == '-'
        }
    }

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

    private fun isSafePathSegment(name: String?): Boolean {
        if (name.isNullOrEmpty() || name.length > 80) return false
        return name.all { char ->
            char in 'a'..'z' ||
                char in 'A'..'Z' ||
                char in '0'..'9' ||
                char == '_' ||
                char == '-'
        }
    }

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private sealed class PetSource {
        abstract val id: String
        abstract val spritesheet: String
        abstract val selectionKey: String
        abstract val key: String

        abstract fun open(context: Context): java.io.InputStream

        data class AssetPet(
            override val id: String,
            val root: String,
            override val spritesheet: String,
            override val selectionKey: String,
            override val key: String
        ) : PetSource() {
            override fun open(context: Context): java.io.InputStream =
                context.applicationContext.assets.open("$root/$spritesheet")
        }

        data class FilePet(
            override val id: String,
            val root: File,
            override val spritesheet: String,
            override val selectionKey: String,
            override val key: String
        ) : PetSource() {
            override fun open(context: Context): java.io.InputStream =
                File(root, spritesheet).inputStream()
        }
    }
}
