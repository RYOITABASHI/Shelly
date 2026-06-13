package expo.modules.terminalemulator.scouter

import android.content.Context
import android.content.ContentUris
import android.content.SharedPreferences
import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import expo.modules.terminalemulator.HomeInitializer
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.util.Locale
import java.util.zip.ZipInputStream

internal object ScouterCodexPet {
    private const val PREFS = "scouter_widget"
    private const val KEY_VISIBLE = "codex_pet_visible"
    private const val KEY_SELECTED_PET_ID = "codex_pet_selected_id"
    private const val KEY_SELECTED_PET_KEY = "codex_pet_selected_key"
    private const val KEY_SIDECAR_IMPORT_KEY = "codex_pet_sidecar_import_key"
    private const val KEY_SIDECAR_IMPORTED_KEYS = "codex_pet_sidecar_imported_keys"
    private const val KEY_SIDECAR_IMPORT_ERROR = "codex_pet_sidecar_import_error"
    private const val DEFAULT_VISIBLE = false
    private const val ASSET_PET_ROOT = "pets"
    private const val SIDECAR_PET_ZIP = "shelly-personal-pets.zip"
    private const val TAG = "ScouterCodexPet"
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
        autoImportSidecarPets(context)
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

    fun autoImportSidecarPets(context: Context): JSONObject? {
        val appContext = context.applicationContext
        val preferences = prefs(appContext)
        val importedKeys = importedSidecarKeys(preferences)
        val sources = sidecarPetZipSources(appContext)
            .filter { it.exists && (it.bytes > 0L || it is SidecarPetZipSource.MediaStoreSource) }
            .filter { it.importKey !in importedKeys }
        if (sources.isEmpty()) return null

        var lastError: Throwable? = null
        for (source in sources) {
            val result = runCatching {
                val installedIds = installPetZipSource(appContext, source)
                val importedAliases = sidecarPetZipSources(appContext)
                    .filter { it.exists && (it.bytes > 0L || it is SidecarPetZipSource.MediaStoreSource) }
                    .mapTo(mutableSetOf()) { it.importKey }
                preferences.edit()
                    .putString(KEY_SIDECAR_IMPORT_KEY, source.importKey)
                    .putStringSet(
                        KEY_SIDECAR_IMPORTED_KEYS,
                        importedKeys + importedAliases + source.importKey
                    )
                    .remove(KEY_SIDECAR_IMPORT_ERROR)
                    .apply()
                JSONObject().apply {
                    put("source", source.label)
                    put("kind", source.kind)
                    put("installedCount", installedIds.size)
                    put("installedIds", JSONArray(installedIds))
                }
            }.onSuccess {
                Log.i(TAG, "Auto-imported sidecar Codex pets: $it")
            }.onFailure { error ->
                lastError = error
                Log.w(TAG, "Sidecar Codex pet auto-import failed from ${source.label}", error)
            }.getOrNull()
            if (result != null) return result
        }
        lastError?.let { error ->
            preferences.edit()
                .putString(KEY_SIDECAR_IMPORT_ERROR, error.message ?: error.javaClass.simpleName)
                .apply()
        }
        return null
    }

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
            put("sidecarImportKey", preferences.getString(KEY_SIDECAR_IMPORT_KEY, null) ?: JSONObject.NULL)
            put("sidecarImportedKeys", JSONArray().also { arr ->
                importedSidecarKeys(preferences).sorted().forEach { arr.put(it) }
            })
            put("sidecarImportError", preferences.getString(KEY_SIDECAR_IMPORT_ERROR, null) ?: JSONObject.NULL)
            put("sidecarCandidates", JSONArray().also { arr ->
                sidecarPetZipSources(appContext).forEach { source ->
                    arr.put(JSONObject().apply {
                        put("kind", source.kind)
                        put("label", source.label)
                        put("exists", source.exists)
                        put("bytes", source.bytes)
                        put("importKey", source.importKey)
                    })
                }
            })
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

    private fun sidecarPetZipFileCandidates(context: Context): List<File> {
        val candidates = mutableListOf<File>()
        context.getExternalFilesDir(null)?.let { external ->
            candidates += File(external, "CodexPets/$SIDECAR_PET_ZIP")
            candidates += File(external, SIDECAR_PET_ZIP)
        }
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        candidates += File(downloads, SIDECAR_PET_ZIP)
        candidates += File("/sdcard/Download/$SIDECAR_PET_ZIP")
        candidates += File("/storage/emulated/0/Download/$SIDECAR_PET_ZIP")
        return candidates.distinctBy { it.absolutePath }
    }

    private fun sidecarPetZipSources(context: Context): List<SidecarPetZipSource> =
        sidecarPetZipFileCandidates(context).map { SidecarPetZipSource.FileSource(it) } +
            sidecarPetZipMediaStoreSources(context)

    private fun sidecarPetZipMediaStoreSources(context: Context): List<SidecarPetZipSource> {
        val collection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Downloads.EXTERNAL_CONTENT_URI
        } else {
            MediaStore.Files.getContentUri("external")
        }
        val projection = arrayOf(
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
        )
        val selection = "${MediaStore.MediaColumns.DISPLAY_NAME}=?"
        return runCatching {
            context.contentResolver.query(
                collection,
                projection,
                selection,
                arrayOf(SIDECAR_PET_ZIP),
                "${MediaStore.MediaColumns.DATE_MODIFIED} DESC"
            )?.use { cursor ->
                val idIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
                val sizeIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
                val modifiedIndex = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_MODIFIED)
                buildList {
                    while (cursor.moveToNext()) {
                        val id = cursor.getLong(idIndex)
                        val size = if (cursor.isNull(sizeIndex)) 0L else cursor.getLong(sizeIndex)
                        val modified = if (cursor.isNull(modifiedIndex)) 0L else cursor.getLong(modifiedIndex)
                        val uri = ContentUris.withAppendedId(collection, id)
                        add(SidecarPetZipSource.MediaStoreSource(uri, size, modified))
                    }
                }
            }.orEmpty()
        }.onFailure {
            Log.w(TAG, "Could not query MediaStore for $SIDECAR_PET_ZIP", it)
        }.getOrDefault(emptyList())
    }

    private fun installPetZipSource(context: Context, source: SidecarPetZipSource): List<String> {
        val importDir = File(context.cacheDir, "scouter-pet-sidecar-${System.nanoTime()}").canonicalFile
        val installedIds = mutableListOf<String>()
        try {
            require(importDir.mkdirs()) { "Could not create pet import directory" }
            source.open(context).buffered().use { input ->
                extractPetZip(input, importDir)
            }
            val candidates = findPetDirectories(importDir).map(::validatePetDirectory)
            require(candidates.isNotEmpty()) { "No valid Codex pet found in sidecar ZIP" }
            val duplicateIds = candidates.groupBy { it.id }.filterValues { it.size > 1 }.keys
            require(duplicateIds.isEmpty()) {
                "Duplicate pet id in sidecar ZIP: ${duplicateIds.joinToString(", ")}"
            }

            val targetRoot = privatePetRoot(context)
            require(targetRoot.isDirectory || targetRoot.mkdirs()) {
                "Could not create private pet directory"
            }
            val canonicalRoot = targetRoot.canonicalFile
            for (candidate in candidates) {
                val staging = File(canonicalRoot, ".${candidate.id}.sidecar-${System.nanoTime()}").canonicalFile
                require(staging.path.startsWith(canonicalRoot.path + File.separator)) {
                    "Import staging path escaped pet directory"
                }
                require(staging.mkdirs()) { "Could not create pet import staging directory" }
                candidate.manifest.copyTo(File(staging, "pet.json"), overwrite = true)
                candidate.spritesheet.copyTo(File(staging, candidate.spritesheetName), overwrite = true)

                val target = File(canonicalRoot, candidate.id).absoluteFile
                val canonicalTarget = target.canonicalFile
                require(canonicalTarget.path == target.path && canonicalTarget.path.startsWith(canonicalRoot.path + File.separator)) {
                    "Pet target escaped pet directory"
                }
                val backup = File(canonicalRoot, ".${candidate.id}.backup-${System.nanoTime()}").canonicalFile
                require(backup.path.startsWith(canonicalRoot.path + File.separator)) {
                    "Pet backup path escaped pet directory"
                }
                var backupCreated = false
                try {
                    if (target.exists()) {
                        require(target.renameTo(backup)) { "Could not move existing pet aside: ${candidate.id}" }
                        backupCreated = true
                    }
                    if (!staging.renameTo(target)) {
                        val copied = staging.copyRecursively(target, overwrite = true)
                        staging.deleteRecursively()
                        require(copied) { "Could not install pet: ${candidate.id}" }
                    }
                    if (backupCreated) backup.deleteRecursively()
                    installedIds += candidate.id
                } catch (error: Throwable) {
                    if (target.exists()) target.deleteRecursively()
                    if (backupCreated && backup.exists()) {
                        if (!backup.renameTo(target)) {
                            val restored = backup.copyRecursively(target, overwrite = true)
                            if (restored) {
                                backup.deleteRecursively()
                            } else {
                                Log.w(TAG, "Could not restore previous pet after failed sidecar import: ${candidate.id}")
                            }
                        }
                    }
                    staging.deleteRecursively()
                    throw error
                }
            }
            return installedIds
        } finally {
            importDir.deleteRecursively()
        }
    }

    private fun extractPetZip(input: InputStream, targetDir: File) {
        val root = targetDir.canonicalFile
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var entryCount = 0
        var totalBytes = 0L
        ZipInputStream(input).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                try {
                    entryCount += 1
                    require(entryCount <= 256) { "Pet ZIP has too many entries" }
                    val relativePath = safeZipRelativePath(entry.name) ?: continue
                    if (entry.isDirectory) continue
                    val outFile = File(root, relativePath).canonicalFile
                    require(outFile.path == root.path || outFile.path.startsWith(root.path + File.separator)) {
                        "Pet ZIP entry escapes import directory"
                    }
                    outFile.parentFile?.mkdirs()
                    outFile.outputStream().use { output ->
                        while (true) {
                            val read = zip.read(buffer)
                            if (read < 0) break
                            totalBytes += read.toLong()
                            require(totalBytes <= 96L * 1024L * 1024L) { "Pet ZIP is too large" }
                            output.write(buffer, 0, read)
                        }
                    }
                } finally {
                    zip.closeEntry()
                }
            }
        }
    }

    private fun safeZipRelativePath(name: String): String? {
        val normalized = name.replace('\\', '/')
        require(!normalized.startsWith("/") && !Regex("^[A-Za-z]:").containsMatchIn(normalized)) {
            "Pet ZIP contains an absolute path"
        }
        val parts = normalized.split('/').filter { it.isNotBlank() }
        if (parts.isEmpty()) return null
        require(parts.none { it == "." || it == ".." }) {
            "Pet ZIP contains a path traversal entry"
        }
        require(parts.all { it.length <= 160 }) {
            "Pet ZIP entry name is too long"
        }
        return parts.joinToString(File.separator)
    }

    private fun findPetDirectories(root: File): List<File> {
        val found = mutableListOf<File>()
        fun walk(dir: File, depth: Int) {
            if (File(dir, "pet.json").isFile) {
                found += dir
                return
            }
            if (depth >= 3) return
            dir.listFiles()
                ?.filter { it.isDirectory }
                ?.forEach { walk(it, depth + 1) }
        }
        walk(root, 0)
        return found.distinctBy { runCatching { it.canonicalPath }.getOrDefault(it.absolutePath) }
    }

    private fun validatePetDirectory(dir: File): PetImportCandidate {
        val manifest = File(dir, "pet.json").canonicalFile
        require(manifest.isFile && manifest.length() in 1..32_768L) {
            "Invalid pet manifest in ${dir.name}"
        }
        val json = JSONObject(manifest.readText(Charsets.UTF_8))
        val id = json.optString("id").trim().takeIf { isSafeId(it) }
            ?: throw IllegalArgumentException("Invalid pet id in ${dir.name}")
        val spritesheetName = json.optString("spritesheetPath", "spritesheet.webp").trim()
            .ifBlank { "spritesheet.webp" }
        require(isSafeAssetName(spritesheetName)) {
            "Invalid spritesheet path for $id"
        }
        val petRoot = dir.canonicalFile
        val spritesheet = File(dir, spritesheetName).canonicalFile
        require(spritesheet.path.startsWith(petRoot.path + File.separator)) {
            "Spritesheet escapes pet directory for $id"
        }
        require(spritesheet.isFile && spritesheet.length() > 0L) {
            "Missing spritesheet for $id"
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(spritesheet.absolutePath, bounds)
        require(bounds.outWidth >= COLUMNS * CELL_WIDTH && bounds.outHeight >= frameCounts.size * CELL_HEIGHT) {
            "Spritesheet for $id is too small: ${bounds.outWidth}x${bounds.outHeight}"
        }
        return PetImportCandidate(id, manifest, spritesheet, spritesheetName)
    }

    private fun privatePetRoot(context: Context): File {
        val filesRoot = context.filesDir.canonicalFile
        val expectedHome = File(filesRoot, "home").absoluteFile
        val home = HomeInitializer.getHomeDir(context).canonicalFile
        require(home.path == expectedHome.path && home.path.startsWith(filesRoot.path + File.separator)) {
            "Shelly private home must stay inside app files"
        }
        val root = File(home, ".codex/pets").absoluteFile
        val canonicalRoot = root.canonicalFile
        require(canonicalRoot.path == root.path && canonicalRoot.path.startsWith(home.path + File.separator)) {
            "Pet import directory must stay inside Shelly private home"
        }
        return root
    }

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

    private fun importedSidecarKeys(preferences: SharedPreferences): Set<String> =
        preferences.getStringSet(KEY_SIDECAR_IMPORTED_KEYS, null).orEmpty() +
            listOfNotNull(preferences.getString(KEY_SIDECAR_IMPORT_KEY, null))

    private data class PetImportCandidate(
        val id: String,
        val manifest: File,
        val spritesheet: File,
        val spritesheetName: String
    )

    private sealed class SidecarPetZipSource {
        abstract val kind: String
        abstract val label: String
        abstract val exists: Boolean
        abstract val bytes: Long
        abstract val importKey: String

        abstract fun open(context: Context): InputStream

        data class FileSource(val file: File) : SidecarPetZipSource() {
            override val kind: String = "file"
            override val label: String = file.absolutePath
            override val exists: Boolean get() = file.isFile
            override val bytes: Long get() = if (file.isFile) file.length() else 0L
            override val importKey: String
                get() = "file:${file.absolutePath}:${file.lastModified()}:${bytes}"

            override fun open(context: Context): InputStream = FileInputStream(file)
        }

        data class MediaStoreSource(
            val uri: android.net.Uri,
            override val bytes: Long,
            val dateModified: Long
        ) : SidecarPetZipSource() {
            override val kind: String = "mediastore"
            override val label: String = uri.toString()
            override val exists: Boolean = true
            override val importKey: String = "mediastore:$uri:$dateModified:$bytes"

            override fun open(context: Context): InputStream =
                context.contentResolver.openInputStream(uri)
                    ?: throw IllegalArgumentException("Could not open sidecar pet ZIP: $uri")
        }
    }

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
