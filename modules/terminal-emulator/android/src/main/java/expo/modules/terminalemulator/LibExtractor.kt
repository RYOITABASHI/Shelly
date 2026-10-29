package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import java.io.File
import java.util.zip.ZipFile

object LibExtractor {
    private const val TAG = "LibExtractor"
    private const val EXTRACT_MARKER = ".extract_version"

    // ALWAYS_REFRESH exists so a CI-only rebuild (same versionCode) still
    // lands fresh binaries after an APK update -- and an APK update always
    // restarts the app process. Doing it once per process is therefore
    // equivalent, while extractAll() itself is called on EVERY PTY create,
    // execCommand() and host spawn: before this guard each call rewrote
    // codex_tui (~200 MB), node, codex-code-mode-host, git... (on-device:
    // the codex_tui inode changed 4x in 10 s while `shelly` helper commands
    // were running). Missing or empty files are still re-extracted on any call.
    @Volatile private var alwaysRefreshDoneInProcess = false

    private val LIBS = mapOf(
        // bash + deps
        "lib/arm64-v8a/libbash.so" to "libbash.so",
        "lib/arm64-v8a/libandroid-support.so" to "libandroid-support.so",
        "lib/arm64-v8a/libiconv.so" to "libiconv.so",
        "lib/arm64-v8a/libreadline8.so" to "libreadline.so.8",
        "lib/arm64-v8a/libncursesw6.so" to "libncursesw.so.6",
        // node + deps
        "lib/arm64-v8a/libnode.so" to "node",
        "lib/arm64-v8a/libz1.so" to "libz.so.1",
        "lib/arm64-v8a/libcares.so" to "libcares.so",
        "lib/arm64-v8a/libsqlite3_termux.so" to "libsqlite3.so",
        "lib/arm64-v8a/libcrypto3.so" to "libcrypto.so.3",
        "lib/arm64-v8a/libssl3.so" to "libssl.so.3",
        "lib/arm64-v8a/libicui18n78.so" to "libicui18n.so.78",
        "lib/arm64-v8a/libicuuc78.so" to "libicuuc.so.78",
        "lib/arm64-v8a/libicudata78.so" to "libicudata.so.78",
        "lib/arm64-v8a/libcxx_shared.so" to "libc++_shared.so",
        // git + deps
        "lib/arm64-v8a/libgit.so" to "git",
        "lib/arm64-v8a/libpcre2_8.so" to "libpcre2-8.so",
        // bug #128 (2026-04-27): git's HTTPS / HTTP transport helpers.
        // Without these, `git clone https://...` returns "fatal: remote
        // helper 'https' aborted session". HomeInitializer.kt sets
        // GIT_EXEC_PATH=$libDir so git locates these by their basenames
        // (LibExtractor strips the lib prefix and .so suffix on disk).
        "lib/arm64-v8a/libgit_remote_https.so" to "git-remote-https",
        "lib/arm64-v8a/libgit_remote_http.so" to "git-remote-http",
        // bug #128: ssh-keygen for SSH-key-based git workflows. The base
        // ssh client was already bundled, but key generation was not.
        "lib/arm64-v8a/libssh_keygen.so" to "ssh-keygen",
        // bug #128 git-credential helpers: persist HTTPS credentials
        // (PAT) so user doesn't have to embed token in URL on every
        // clone/push. _store keeps plaintext in ~/.git-credentials,
        // _cache keeps in-memory only.
        "lib/arm64-v8a/libgit_credential_store.so" to "git-credential-store",
        "lib/arm64-v8a/libgit_credential_cache.so" to "git-credential-cache",
        // bug #130 (2026-04-27): Tier-1 dev essentials. Codex frequently
        // asked for these during Shelly-on-Shelly dev
        // attempts ("gh: command not found", "gpg: not found", etc.).
        // CI extracts them from Termux's stable apt mirror; missing
        // from build = WARN (not fatal) so per-entry shape drift in
        // Termux upstream doesn't block the whole APK.
        "lib/arm64-v8a/libgh.so" to "gh",
        "lib/arm64-v8a/libgpg.so" to "gpg",
        "lib/arm64-v8a/libgpg_agent.so" to "gpg-agent",
        "lib/arm64-v8a/libnano.so" to "nano",
        "lib/arm64-v8a/libunzip.so" to "unzip",
        // bug #132 (2026-04-27): libbz2 runtime dep for gpg + unzip.
        // DT_NEEDED references "libbz2.so.1.0" exactly, gradle's
        // apkPackager only accepts lib*.so without version suffix in
        // jniLibs, so CI ships it as libbz2_1.so and we rename here.
        "lib/arm64-v8a/libbz2_1.so" to "libbz2.so.1.0",
        // bug #135 (2026-04-27, agent-reviewed): gpg's runtime dep
        // cascade. Termux ships these UNVERSIONED (single file
        // `usr/lib/libNAME.so` with no symlinks) and gpg's DT_NEEDED
        // references match. Apk lib/ uses underscored basenames
        // (gradle apkPackager allows lib*.so only) → LibExtractor
        // renames to the hyphen form for libgpg-error.
        "lib/arm64-v8a/libgcrypt.so" to "libgcrypt.so",
        "lib/arm64-v8a/libgpg_error.so" to "libgpg-error.so",
        "lib/arm64-v8a/libassuan.so" to "libassuan.so",
        "lib/arm64-v8a/libksba.so" to "libksba.so",
        "lib/arm64-v8a/libnpth.so" to "libnpth.so",
        // coreutils
        "lib/arm64-v8a/libcoreutils.so" to "coreutils",
        // python
        "lib/arm64-v8a/libpython3.so" to "python3",
        "lib/arm64-v8a/libpython313.so" to "libpython3.13.so",
        // curl + deps
        "lib/arm64-v8a/libcurl_bin.so" to "curl",
        "lib/arm64-v8a/libcurl.so" to "libcurl.so",
        "lib/arm64-v8a/libnghttp3.so" to "libnghttp3.so",
        "lib/arm64-v8a/libngtcp2_crypto_ossl.so" to "libngtcp2_crypto_ossl.so",
        "lib/arm64-v8a/libngtcp2.so" to "libngtcp2.so",
        "lib/arm64-v8a/libnghttp2.so" to "libnghttp2.so",
        "lib/arm64-v8a/libssh2.so" to "libssh2.so",
        // ssh + deps
        "lib/arm64-v8a/libssh_bin.so" to "ssh",
        "lib/arm64-v8a/libldns.so" to "libldns.so",
        "lib/arm64-v8a/libgssapi_krb5.so" to "libgssapi_krb5.so.2",
        "lib/arm64-v8a/libkrb5.so" to "libkrb5.so.3",
        "lib/arm64-v8a/libk5crypto.so" to "libk5crypto.so.3",
        "lib/arm64-v8a/libcom_err.so" to "libcom_err.so.3",
        "lib/arm64-v8a/libkrb5support.so" to "libkrb5support.so.0",
        "lib/arm64-v8a/libandroid-glob.so" to "libandroid-glob.so",
        "lib/arm64-v8a/libresolv_wrapper.so" to "libresolv_wrapper.so",
        // coreutils extra deps
        "lib/arm64-v8a/libandroid-selinux.so" to "libandroid-selinux.so",
        "lib/arm64-v8a/libgmp.so" to "libgmp.so",
        // ripgrep
        "lib/arm64-v8a/librg.so" to "rg",
        // jq + deps
        "lib/arm64-v8a/libjq_bin.so" to "jq",
        "lib/arm64-v8a/libjq.so" to "libjq.so",
        "lib/arm64-v8a/libonig.so" to "libonig.so",
        // sqlite3
        "lib/arm64-v8a/libsqlite3_bin.so" to "sqlite3",
        // tmux + deps
        "lib/arm64-v8a/libtmux.so" to "tmux",
        "lib/arm64-v8a/libevent_core.so" to "libevent_core-2.1.so",
        // vim + deps
        "lib/arm64-v8a/libvim.so" to "vim",
        "lib/arm64-v8a/libsodium.so" to "libsodium.so",
        // make
        "lib/arm64-v8a/libmake.so" to "make",
        // less
        "lib/arm64-v8a/libless.so" to "less",
        // bug #139 (2026-04-27): libproot/libtalloc removed from this LIBS
        // map — the proot routing path was replaced by direct linker64
        // invocation of codex-termux native binaries, see HomeInitializer.kt
        // comment. 2026-08-06: the raw jniLibs/arm64-v8a/libproot.so and
        // libtalloc.so asset files themselves (harmless-but-dead APK weight
        // even though never extracted, since anything under jniLibs/<abi>/ is
        // packaged into the APK unconditionally by AGP regardless of whether
        // this map references it) were also deleted — recoverable from git
        // history if a future ET_EXEC binary ever needs proot routing again.
        // Unified Codex native binary (ET_DYN, built from codex-termux for
        // Android/bionic). `codex exec ...` is routed by passing the `exec`
        // subcommand to this same binary; newer codex-termux packages no longer
        // ship a separate codex-exec binary.
        "lib/arm64-v8a/libcodex_tui.so" to "codex_tui",
        "lib/arm64-v8a/libcodex_cxx_shared.so" to "libc++_shared.so",
        // Issue #149: Codex looks up its Code Mode host as a sibling of its
        // own executable (dirname(current_exe)/codex-code-mode-host). This is
        // codex-termux's bionic PIE build, so the exec wrapper's linker64
        // routing handles it like codex_tui. Optional: older payloads lack it.
        "lib/arm64-v8a/libcodex_code_mode_host.so" to "codex-code-mode-host",
        // exec wrapper: LD_PRELOAD library that redirects execve() through linker64
        // (required for targetSdk >= 29 where SELinux blocks direct exec from app_data_file)
        "lib/arm64-v8a/libexec_wrapper.so" to "libexec_wrapper.so",
        // Shell launcher used as $SHELL for hosted Node/Codex helpers.
        // HomeInitializer symlinks $HOME/bin/bash to libbash.so; this
        // launcher remains available for explicit native shell routing.
        "lib/arm64-v8a/libshelly_shell.so" to "shelly_shell",
        // bug #102 / #115 phase 1: native xdg-open replacement that fires
        // the shelly://browser deep link via `am start`. Direct execve
        // target (no #! shim) so it sidesteps Android binfmt_script's
        // `file{read}` audit on app_data_file scripts (which Samsung Knox
        // sepolicy denies — that's why every shebang shim attempt
        // v78/v79/v80 returned "bad interpreter: Success"). HomeInitializer
        // symlinks $HOME/bin/xdg-open → $libDir/shelly_xdg_open.
        "lib/arm64-v8a/libshelly_xdg_open.so" to "shelly_xdg_open",
        // BASHRC_VERSION 255: native `shelly` command (jni/shelly-cmd.c).
        // HomeInitializer symlinks $HOME/bin/shelly -> $libDir/shelly_cmd,
        // replacing the generated #!/system/bin/sh script Knox refused to
        // exec outside the interactive shelly() bash function.
        "lib/arm64-v8a/libshelly_cmd.so" to "shelly_cmd"
    )

    // Files that must be re-extracted on every launch even when the version
    // marker matches. The bug #731 incident showed that an APK update can
    // ship native launcher changes without bumping versionCode (e.g. CI-only
    // refactors); the previous gate would have kept stale binaries on disk.
    private val ALWAYS_REFRESH = setOf(
        // v76 (2026-05-06): bionic libexec_wrapper.so was missing from
        // ALWAYS_REFRESH. CI-only fixes that don't bump versionCode never
        // reached devices for the wrapper — same hazard the musl entry
        // dodges. Codex's raw-syscall rewrite + future bionic-side wrapper
        // fixes both rely on this being force-extracted.
        "libexec_wrapper.so",
        // Codex and its Node-side update helper are user-visible in Settings.
        // Always refresh these APK-bundled binaries so a stale filesDir copy
        // cannot make the update surface report an older "Codex current"
        // after a successful Shelly APK update.
        "node",
        "codex_tui",
        "libc++_shared.so",
        // Version-locked to codex_tui; a stale host would speak an older
        // Code Mode protocol than the refreshed Codex binary.
        "codex-code-mode-host",
        "shelly_shell",
        // bug #102 / #115 phase 1: ALWAYS_REFRESH so URL-encoding /
        // scheme-validation tweaks ship without a versionCode bump.
        "shelly_xdg_open",
        // BASHRC_VERSION 255: same reasoning for the native `shelly` shim.
        "shelly_cmd",
        // git + its transport/credential helpers: force-refresh so the HTTPS
        // helper exec fix (git() now preloads libexec_wrapper.so) is validated
        // against fresh binaries — a stale helper from a prior broken state must
        // not muddy "cannot exec 'remote-https'" diagnosis.
        "git",
        "git-remote-https",
        "git-remote-http",
        "git-credential-store",
        "git-credential-cache"
    )

    fun getLibDir(context: Context): File =
        File(context.filesDir, "termux-libs").also { it.mkdirs() }

    fun getBashPath(context: Context): String =
        File(getLibDir(context), "libbash.so").absolutePath

    private fun newTempFile(libDir: File, fileName: String): File =
        File(libDir, "$fileName.${android.os.Process.myPid()}.${Thread.currentThread().id}.${System.nanoTime()}.new")

    private fun targetIsUsable(file: File): Boolean =
        file.exists() && file.length() > 0

    private fun replaceExtractedFile(tmpFile: File, outFile: File, fileName: String) {
        tmpFile.setExecutable(true, false)
        if (tmpFile.renameTo(outFile)) {
            outFile.setExecutable(true, false)
            return
        }

        if (!tmpFile.exists() && targetIsUsable(outFile)) {
            Log.w(TAG, "rename reported failure for $fileName but target exists; continuing")
            outFile.setExecutable(true, false)
            return
        }

        if (outFile.exists() && !outFile.delete()) {
            Log.w(TAG, "could not delete existing $fileName before replace")
        }
        if (tmpFile.renameTo(outFile)) {
            outFile.setExecutable(true, false)
            return
        }

        if (!tmpFile.exists()) {
            if (targetIsUsable(outFile)) {
                Log.w(TAG, "rename reported failure for $fileName after delete but target exists; continuing")
                outFile.setExecutable(true, false)
                return
            }
            throw java.io.FileNotFoundException("${tmpFile.absolutePath} disappeared while replacing $fileName")
        }

        Log.w(TAG, "atomic rename failed for $fileName; copying in place")
        tmpFile.inputStream().use { input ->
            outFile.outputStream().use { output -> input.copyTo(output) }
        }
        tmpFile.delete()
        outFile.setExecutable(true, false)
    }

    fun extractAll(context: Context): File {
        val libDir = getLibDir(context)
        val markerFile = File(libDir, EXTRACT_MARKER)
        val currentVersion = appVersionMarker(context)
        val forceRefresh = !markerFile.exists() || markerFile.readText().trim() != currentVersion
        if (forceRefresh) {
            Log.i(TAG, "extract refresh required: marker=${markerFile.takeIf { it.exists() }?.readText()?.trim()} current=$currentVersion")
        }

        // Extract native binaries from APK
        val apkPath = context.applicationInfo.sourceDir
        val zipFile = ZipFile(apkPath)
        try {
            for ((apkEntry, fileName) in LIBS) {
                val outFile = File(libDir, fileName)
                val refreshThisFile = forceRefresh || (fileName in ALWAYS_REFRESH && !alwaysRefreshDoneInProcess)
                if (!refreshThisFile && outFile.exists() && outFile.length() > 0) continue
                val entry = zipFile.getEntry(apkEntry) ?: continue
                // Atomic replace: write to a temp file, then rename over the target.
                // A running process that has the live .so mmap'd (codex_tui under
                // LD_PRELOAD=libexec_wrapper.so) must never observe a deleted or
                // partially-written file during a version-change re-extract — that
                // race truncated the mapping's backing and crashed codex with
                // SIGBUS/BUS_ADRERR at open+0. rename(2) is atomic and leaves any
                // existing mapping pinned to the complete old inode until unmapped.
                val tmpFile = newTempFile(libDir, fileName)
                zipFile.getInputStream(entry).use { input ->
                    tmpFile.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
                replaceExtractedFile(tmpFile, outFile, fileName)
            }
            alwaysRefreshDoneInProcess = true
        } finally {
            zipFile.close()
        }

        // Extract npm from assets (tar → node_modules/npm/)
        // Note: aapt strips .gz compression, so assets contain .tar not .tar.gz
        val npmDir = File(libDir, "node_modules/npm")
        if (forceRefresh && npmDir.exists()) npmDir.deleteRecursively()
        if (!npmDir.exists()) {
            try {
                // Try .tar first (aapt-decompressed), fall back to .tar.gz (original)
                val assetName = tryAssetName(context, "npm.tar", "npm.tar.gz")
                val isTarGz = assetName.endsWith(".gz")
                val tempTar = File(context.cacheDir, assetName)
                context.assets.open(assetName).use { input ->
                    tempTar.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
                val nodeModulesDir = File(libDir, "node_modules")
                nodeModulesDir.mkdirs()
                val tarFlags = if (isTarGz) "xzf" else "xf"
                val pb = ProcessBuilder("/system/bin/tar", tarFlags, tempTar.absolutePath, "-C", nodeModulesDir.absolutePath)
                pb.redirectErrorStream(true)
                val proc = pb.start()
                val tarOutput = proc.inputStream.bufferedReader().readText()
                val exitCode = proc.waitFor()
                tempTar.delete()
                if (exitCode != 0) {
                    Log.e(TAG, "npm tar failed (exit $exitCode): $tarOutput")
                } else {
                    Log.i(TAG, "npm extracted to ${npmDir.absolutePath}")
                }
            } catch (e: Exception) {
                Log.e(TAG, "npm extraction failed: ${e.message}")
            }
        }

        // Extract python stdlib from assets
        extractTarGzAsset(context, "python3.tar.gz", libDir, "python3.13", forceRefresh)

        // Extract pip from assets → python3.13/site-packages/pip/
        val sitePackages = File(libDir, "python3.13/site-packages")
        extractTarGzAsset(context, "pip.tar.gz", sitePackages, "pip", forceRefresh)

        // Extract bundled Codex JS dispatcher.
        Log.i(TAG, "Attempting Codex CLI tools extraction...")
        extractTarGzAsset(context, "cli-tools.tar.gz", libDir, "node_modules/@openai/codex", forceRefresh)
        Log.i(TAG, "CLI tools extraction done, checking launchers...")

        // bug #151 (2026-07-16): terminfo database for less/nano/vim/tmux.
        // These are prebuilt Termux ARM64 binaries dynamically linked
        // against libncursesw.so.6 above; without a terminfo db reachable
        // via $TERMINFO, less/nano hard-fail ("terminals database is
        // inaccessible" / "cannot initialize terminal type") and vim
        // degrades. Entries sourced directly from Termux's own ncurses
        // .deb (same upstream version, 6.5.20250830, as libncursesw6.so
        // above) to avoid tic-format/hash-layout incompatibility across
        // different ncurses builds. HomeInitializer.kt exports
        // TERMINFO="$libDir/terminfo" to point at this tree.
        extractTarGzAsset(context, "terminfo.tar.gz", libDir, "terminfo", forceRefresh)

        // Note: CLI launchers are defined as bash functions
        // in .bashrc (generated by shelly-pty.c). Shell script launchers don't work
        // on Android 10+ with targetSdk >= 29 because SELinux blocks shebang execution
        // from app_data_file directories. The LD_PRELOAD exec wrapper (libexec_wrapper.so)
        // handles all child process execution transparently.

        markerFile.writeText(currentVersion)
        return libDir
    }

    private fun appVersionMarker(context: Context): String {
        val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
        val apkPath = context.applicationInfo.sourceDir
        return try {
            ZipFile(apkPath).use { zip ->
                buildString {
                    append("vc=").append(packageInfo.longVersionCode)
                    append("|cli=").append(zipEntryFingerprint(zip, "assets/cli-tools.tar", "assets/cli-tools.tar.gz"))
                    append("|terminfo=").append(zipEntryFingerprint(zip, "assets/terminfo.tar", "assets/terminfo.tar.gz"))
                    for (entryName in LIBS.keys.sorted()) {
                        append("|").append(entryName).append("=")
                        append(zipEntryFingerprint(zip, entryName))
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "failed to compute APK extraction marker from assets/libs: ${e.message}")
            packageInfo.longVersionCode.toString()
        }
    }

    private fun zipEntryFingerprint(zip: ZipFile, vararg candidates: String): String {
        for (name in candidates) {
            val entry = zip.getEntry(name) ?: continue
            return "${entry.name}:${entry.crc}:${entry.size}:${entry.compressedSize}"
        }
        return "missing:${candidates.joinToString(",")}"
    }

    /** Try .tar first (aapt strips .gz), fall back to .tar.gz */
    private fun tryAssetName(context: Context, vararg candidates: String): String {
        for (name in candidates) {
            try {
                context.assets.open(name).close()
                return name
            } catch (_: Exception) {}
        }
        throw java.io.FileNotFoundException("None of ${candidates.toList()} found in assets")
    }

    /** Result of an on-demand optional-tool-pack extraction (extractPack below). */
    data class PackExtractionResult(val extractedPaths: List<String>, val libDir: String)

    /**
     * On-demand extraction for optional tool packs downloaded at runtime via
     * `shelly install <pack>` (Fable5 roadmap item #6, see
     * lib/optional-packs.ts / lib/optional-pack-installer.ts). The bash
     * wrappers in HomeInitializer.kt resolve $libDir/packs/<packId>/<tool>
     * at call time.
     *
     * Never part of extractAll(); only runs when a user explicitly runs
     * `shelly install <pack>`.
     *
     * Integrity and safety (2026-10-29):
     *  1. The downloaded archive (in app-specific external storage) is copied
     *     into app-private storage, and THAT copy is hashed here and checked
     *     against the sha256 + size pinned into this build. Everything after
     *     reads only the private copy, so the file cannot change between
     *     verification and extraction.
     *  2. The copy is listed (gzip + tar headers parsed in-process) before
     *     /system/bin/tar sees it. Only regular files and directories with
     *     relative paths and no `..` segment are accepted (GNU long-name
     *     records allowed); symlinks, hardlinks, devices, FIFOs and pax
     *     headers are rejected.
     *  3. Extraction goes to a staging dir and is swapped in by rename; every
     *     declared tool must be present. A failed install keeps the previous
     *     pack. Deletion walks the tree without following symlinks.
     *  4. If an earlier run died between "move old pack aside" and "activate
     *     new pack", the `.old-<packId>-*` dir is restored instead of deleted.
     */
    fun extractPack(
        context: Context,
        packId: String,
        archivePath: String,
        tools: List<String>,
        expectedSha256: String,
        expectedSizeBytes: Long,
    ): PackExtractionResult {
        require(Regex("^[a-z0-9][a-z0-9-]{0,63}$").matches(packId)) { "Invalid pack id: $packId" }
        require(Regex("^[0-9a-f]{64}$").matches(expectedSha256)) { "Invalid pinned sha256 for pack '$packId'" }
        require(expectedSizeBytes > 0) { "Invalid pinned size for pack '$packId'" }
        for (toolName in tools) {
            require(Regex("^[A-Za-z0-9._-]+$").matches(toolName) && toolName != "." && toolName != "..") {
                "unsafe tool name '$toolName'"
            }
        }
        val archive = File(archivePath)
        require(archive.isFile) { "Pack archive not found: $archivePath" }

        val libDir = getLibDir(context)
        val packsRoot = File(libDir, "packs")
        val packDir = File(packsRoot, packId)
        packsRoot.mkdirs()

        recoverInterruptedPackSwap(packsRoot, packDir, packId)

        val stamp = System.currentTimeMillis()
        val privateCopy = File(packsRoot, ".download-$packId-$stamp.tar.gz")
        val staging = File(packsRoot, ".staging-$packId-$stamp")
        val previous = File(packsRoot, ".old-$packId-$stamp")
        try {
            copyAndVerify(archive, privateCopy, expectedSha256, expectedSizeBytes, packId)
            validatePackTarEntries(privateCopy, packId)

            if (!staging.mkdirs()) throw java.io.IOException("could not create ${staging.absolutePath}")
            val pb = ProcessBuilder("/system/bin/tar", "xzf", privateCopy.absolutePath, "-C", staging.absolutePath)
            pb.redirectErrorStream(true)
            val proc = pb.start()
            val tarOutput = proc.inputStream.bufferedReader().readText()
            val exitCode = proc.waitFor()
            if (exitCode != 0) {
                throw java.io.IOException("pack extraction failed (exit $exitCode): ${tarOutput.take(400)}")
            }
            val missing = mutableListOf<String>()
            for (toolName in tools) {
                val toolFile = File(staging, toolName)
                if (!java.nio.file.Files.isRegularFile(toolFile.toPath(), java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                    missing.add(toolName)
                } else {
                    toolFile.setExecutable(true, false)
                }
            }
            if (missing.isNotEmpty()) {
                throw java.io.IOException("pack '$packId' archive is missing: ${missing.joinToString(", ")}")
            }
            if (packDir.exists() && !packDir.renameTo(previous)) {
                throw java.io.IOException("could not move the existing pack '$packId' aside")
            }
            if (!staging.renameTo(packDir)) {
                if (previous.exists()) previous.renameTo(packDir)
                throw java.io.IOException("could not activate pack '$packId'")
            }
        } catch (e: Exception) {
            deleteTreeNoFollow(staging)
            throw e
        } finally {
            deleteTreeNoFollow(privateCopy)
        }
        deleteTreeNoFollow(previous)

        val extracted = tools.map { File(packDir, it).absolutePath }
        Log.i(TAG, "extractPack: pack=$packId extracted=${extracted.size}/${tools.size} to ${packDir.absolutePath}")
        return PackExtractionResult(extracted, packDir.absolutePath)
    }

    /**
     * Housekeeping before an install: if packDir is missing but a
     * `.old-<packId>-*` exists (a previous run died mid-swap), restore the
     * newest one as packDir. Remaining staging/old/download leftovers for
     * this pack are then removed (without following symlinks).
     */
    private fun recoverInterruptedPackSwap(packsRoot: File, packDir: File, packId: String) {
        val leftovers = packsRoot.listFiles()?.toList().orEmpty()
        val olds = leftovers.filter { it.name.startsWith(".old-$packId-") }.sortedByDescending { it.name }
        if (!packDir.exists() && olds.isNotEmpty()) {
            if (olds.first().renameTo(packDir)) {
                Log.w(TAG, "extractPack: restored interrupted pack '$packId' from ${olds.first().name}")
            }
        }
        for (f in leftovers) {
            val n = f.name
            if (n.startsWith(".staging-$packId-") || n.startsWith(".download-$packId-") ||
                (n.startsWith(".old-$packId-") && packDir.exists())
            ) {
                deleteTreeNoFollow(f)
            }
        }
    }

    private fun copyAndVerify(src: File, dst: File, expectedSha256: String, expectedSize: Long, packId: String) {
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        var total = 0L
        java.io.FileInputStream(src).use { input ->
            java.io.FileOutputStream(dst).use { output ->
                val buf = ByteArray(64 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    total += n
                    if (total > expectedSize) {
                        throw java.io.IOException("pack '$packId' archive is larger than its pinned size ($expectedSize bytes)")
                    }
                    digest.update(buf, 0, n)
                    output.write(buf, 0, n)
                }
                output.fd.sync()
            }
        }
        if (total != expectedSize) {
            throw java.io.IOException("pack '$packId' archive size mismatch: expected $expectedSize, got $total")
        }
        val actual = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
        if (actual != expectedSha256) {
            throw java.io.IOException("pack '$packId' archive sha256 mismatch; nothing was installed")
        }
    }

    /**
     * Lists the (already verified) tar.gz in-process and rejects anything
     * that is not a plain file or directory with a safe relative path.
     * Supports ustar and the GNU format CI writes (`L` long-name records).
     */
    internal fun validatePackTarEntries(archive: File, packId: String) {
        java.util.zip.GZIPInputStream(java.io.BufferedInputStream(java.io.FileInputStream(archive))).use { gz ->
            val header = ByteArray(512)
            var pendingLongName: String? = null
            var entries = 0
            while (true) {
                if (!readFully(gz, header)) throw java.io.IOException("pack '$packId' archive is truncated")
                if (header.all { it == 0.toByte() }) break // end-of-archive marker
                val type = header[156].toInt().toChar()
                val size = parseTarOctal(header, 124, 12)
                if (size < 0) throw java.io.IOException("pack '$packId' archive has a bad size field")
                val padded = (size + 511) / 512 * 512
                if (type == 'L') {
                    if (size > 4096) throw java.io.IOException("pack '$packId' archive has an oversized long name")
                    val data = ByteArray(padded.toInt())
                    if (!readFully(gz, data)) throw java.io.IOException("pack '$packId' archive is truncated")
                    pendingLongName = String(data, 0, size.toInt(), Charsets.UTF_8).trimEnd('\u0000')
                    continue
                }
                val name = pendingLongName ?: run {
                    val base = cString(header, 0, 100)
                    val magic = cString(header, 257, 6)
                    val prefix = if (magic.startsWith("ustar") && magic.length == 5) cString(header, 345, 155) else ""
                    if (prefix.isNotEmpty()) "$prefix/$base" else base
                }
                pendingLongName = null
                when (type) {
                    '0', '\u0000', '5' -> Unit
                    else -> throw java.io.IOException(
                        "pack '$packId' archive contains a disallowed entry type '$type' ($name)"
                    )
                }
                if (name.isEmpty() || name.startsWith("/") || name.contains('\u0000') ||
                    name.split('/').any { it == ".." }
                ) {
                    throw java.io.IOException("pack '$packId' archive contains an unsafe path: $name")
                }
                if (padded > 0 && gz.skipNBytesCompat(padded) != padded) {
                    throw java.io.IOException("pack '$packId' archive is truncated")
                }
                entries++
            }
            if (entries == 0) throw java.io.IOException("pack '$packId' archive is empty")
        }
    }

    private fun readFully(input: java.io.InputStream, buf: ByteArray): Boolean {
        var off = 0
        while (off < buf.size) {
            val n = input.read(buf, off, buf.size - off)
            if (n < 0) return false
            off += n
        }
        return true
    }

    private fun java.io.InputStream.skipNBytesCompat(n: Long): Long {
        var left = n
        val buf = ByteArray(8192)
        while (left > 0) {
            val r = read(buf, 0, minOf(buf.size.toLong(), left).toInt())
            if (r < 0) break
            left -= r
        }
        return n - left
    }

    private fun cString(b: ByteArray, off: Int, len: Int): String {
        var end = off
        while (end < off + len && b[end] != 0.toByte()) end++
        return String(b, off, end - off, Charsets.UTF_8)
    }

    private fun parseTarOctal(b: ByteArray, off: Int, len: Int): Long {
        if ((b[off].toInt() and 0x80) != 0) return -1 // base-256 sizes are never produced by our CI
        val s = cString(b, off, len).trim { it == ' ' || it == '\u0000' }
        if (s.isEmpty()) return 0
        return s.toLongOrNull(8) ?: -1
    }

    /** Deletes a file or tree without ever following a symlink (a link is removed, not its target). */
    internal fun deleteTreeNoFollow(root: File) {
        val path = root.toPath()
        if (!java.nio.file.Files.exists(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return
        try {
            java.nio.file.Files.walkFileTree(path, object : java.nio.file.SimpleFileVisitor<java.nio.file.Path>() {
                override fun visitFile(
                    file: java.nio.file.Path,
                    attrs: java.nio.file.attribute.BasicFileAttributes,
                ): java.nio.file.FileVisitResult {
                    java.nio.file.Files.deleteIfExists(file)
                    return java.nio.file.FileVisitResult.CONTINUE
                }

                override fun postVisitDirectory(
                    dir: java.nio.file.Path,
                    exc: java.io.IOException?,
                ): java.nio.file.FileVisitResult {
                    java.nio.file.Files.deleteIfExists(dir)
                    return java.nio.file.FileVisitResult.CONTINUE
                }
            })
        } catch (e: java.io.IOException) {
            Log.w(TAG, "deleteTreeNoFollow: could not fully remove ${root.absolutePath}: ${e.message}")
        }
    }

    private fun extractTarGzAsset(
        context: Context,
        assetName: String,
        destDir: File,
        checkDir: String,
        forceRefresh: Boolean
    ) {
        val checkPath = File(destDir, checkDir)
        if (forceRefresh && checkPath.exists()) {
            checkPath.deleteRecursively()
        }
        if (checkPath.exists()) {
            Log.i(TAG, "$assetName: already extracted (${checkPath.absolutePath} exists)")
            return
        }
        Log.i(TAG, "$assetName: extracting (${checkPath.absolutePath} not found)")
        try {
            // aapt may strip .gz, so try both .tar and .tar.gz
            val baseName = assetName.removeSuffix(".gz")
            val actualName = tryAssetName(context, baseName, assetName)
            val tempTar = File(context.cacheDir, actualName)
            context.assets.open(actualName).use { input ->
                tempTar.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            destDir.mkdirs()
            // bug #151 follow-up (2026-07-16, on-device): the asset NAME's .gz
            // suffix is not a reliable signal for whether the bytes are
            // actually gzip-compressed. aapt's asset-compression handling can
            // expose a small asset under its .gz-stripped name (as observed
            // on-device for terminfo.tar.gz, "tar: bad header" — the bytes
            // were still gzip-compressed but isTarGz==false skipped -z)
            // even though other, larger assets (cli-tools.tar.gz,
            // python3.tar.gz) have kept their .gz name and worked fine for
            // months. Sniff the real gzip magic bytes (0x1f 0x8b) from the
            // downloaded file instead of trusting the resolved asset name.
            val isTarGz = tempTar.inputStream().use { it.read() == 0x1f && it.read() == 0x8b }
            val tarFlags = if (isTarGz) "xzf" else "xf"
            val pb = ProcessBuilder("/system/bin/tar", tarFlags, tempTar.absolutePath, "-C", destDir.absolutePath)
            pb.redirectErrorStream(true)
            val proc = pb.start()
            val tarOutput = proc.inputStream.bufferedReader().readText()
            val exitCode = proc.waitFor()
            tempTar.delete()
            if (exitCode != 0) {
                Log.e(TAG, "$actualName tar failed (exit $exitCode): $tarOutput")
            } else {
                Log.i(TAG, "$actualName extracted to ${File(destDir, checkDir).absolutePath}")
            }
        } catch (e: Exception) {
            Log.e(TAG, "$assetName extraction failed: ${e.message}")
        }
    }
}
