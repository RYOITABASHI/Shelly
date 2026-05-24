package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import java.io.File
import java.util.zip.ZipFile

object LibExtractor {
    private const val TAG = "LibExtractor"
    private const val EXTRACT_MARKER = ".extract_version"

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
        // bug #130 (2026-04-27): Tier-1 dev essentials. Claude Code /
        // Codex frequently asked for these during Shelly-on-Shelly dev
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
        // proot + deps (kept for future use with other ET_EXEC binaries)
        // bug #139 (2026-04-27): libproot/libtalloc removed — the proot
        // routing path was replaced by direct linker64 invocation of
        // codex-termux native binaries, see HomeInitializer.kt comment.
        // codex native binary (ET_DYN, built from codex-termux for Android/bionic)
        // exec variant: 1-shot runner for `codex exec/resume/review` subcommands
        "lib/arm64-v8a/libcodex_exec.so" to "codex_exec",
        // tui variant: full interactive REPL (used when `codex` is invoked with
        // no subcommand, or with a bare prompt). Newer codex-termux npm-pack
        // releases may also include libc++_shared.so; keep it next to the
        // binaries so RUNPATH=$ORIGIN can resolve it if upstream starts needing it.
        "lib/arm64-v8a/libcodex_tui.so" to "codex_tui",
        "lib/arm64-v8a/libcodex_cxx_shared.so" to "libc++_shared.so",
        // exec wrapper: LD_PRELOAD library that redirects execve() through linker64
        // (required for targetSdk >= 29 where SELinux blocks direct exec from app_data_file)
        "lib/arm64-v8a/libexec_wrapper.so" to "libexec_wrapper.so",
        // musl-built variant for claude-code 2.1.113+ Bun SEA. The bionic
        // wrapper cannot be preloaded into musl, so claude() injects this
        // library only for the musl launch path.
        "lib/arm64-v8a/libexec_wrapper_musl.so" to "libexec_wrapper_musl.so",
        // Shell launcher used as $SHELL for Claude Code's Bash tool.
        // HomeInitializer symlinks $HOME/bin/bash to this file so Node
        // children see a bash-like basename while the launcher still routes
        // through linker64 + Shelly's exec wrapper.
        "lib/arm64-v8a/libshelly_shell.so" to "shelly_shell",
        // bug #117 Path C-bis: claude-code 2.1.113+ Bun SEA binary + matching
        // Shelly-patched musl libc loader. claude is ET_EXEC (~220 MB) and
        // can't be exec'd by bionic's linker64 directly; ld-musl-aarch64.so.1
        // is ET_DYN so it loads fine via `_run $libDir/ld-musl-aarch64.so.1
        // $libDir/claude ...`, and the musl loader then mmaps the ET_EXEC
        // payload. The CI-baked musl libc has its /etc/resolv.conf hardcode
        // redirected to $HOME/.shelly-ssl/resolv.conf (seeded at shell
        // launch — see HomeInitializer.kt's claude() wrapper).
        "lib/arm64-v8a/libshelly_musl_exec.so" to "shelly_musl_exec",
        "lib/arm64-v8a/libclaude.so" to "claude",
        "lib/arm64-v8a/libld_musl_shelly.so" to "ld-musl-aarch64.so.1",
        // CI-built aarch64 strace. It is musl-linked and is launched by
        // HomeInitializer.kt's strace() helper through the bundled
        // ld-musl-aarch64.so.1, giving on-device native crash visibility.
        // APK packaging only accepts lib*.so names, so CI ships the binary
        // as libstrace.so and LibExtractor restores the PATH-visible name.
        "lib/arm64-v8a/libstrace.so" to "strace",
        // PRoot smoke prototype. Diagnostic-only: HomeInitializer exposes
        // shelly-proot-smoke to decide whether this device/kernel can run
        // ptrace/seccomp-based rootfs translation before any Linux runtime
        // is wired into the product.
        "lib/arm64-v8a/libproot.so" to "proot",
        "lib/arm64-v8a/libtalloc_so_2.so" to "libtalloc.so.2",
        "lib/arm64-v8a/libproot_sh.so" to "sh-proot-smoke",
        // bug #102 / #115 phase 1: native xdg-open replacement that fires
        // the shelly://browser deep link via `am start`. Direct execve
        // target (no #! shim) so it sidesteps Android binfmt_script's
        // `file{read}` audit on app_data_file scripts (which Samsung Knox
        // sepolicy denies — that's why every shebang shim attempt
        // v78/v79/v80 returned "bad interpreter: Success"). HomeInitializer
        // symlinks $HOME/bin/xdg-open → $libDir/shelly_xdg_open.
        "lib/arm64-v8a/libshelly_xdg_open.so" to "shelly_xdg_open"
    )

    // Files that must be re-extracted on every launch even when the version
    // marker matches. The bug #731 incident showed that an APK update can
    // ship a new libexec_wrapper_musl.so / shelly_musl_exec without bumping
    // versionCode (e.g. CI-only refactors); the previous gate would have
    // kept the stale bionic-flavoured trampoline on disk and silently
    // continued to fail the musl claude launch path.
    private val ALWAYS_REFRESH = setOf(
        // v76 (2026-05-06): bionic libexec_wrapper.so was missing from
        // ALWAYS_REFRESH. CI-only fixes that don't bump versionCode never
        // reached devices for the wrapper — same hazard the musl entry
        // dodges. Codex's raw-syscall rewrite + future bionic-side wrapper
        // fixes both rely on this being force-extracted.
        "libexec_wrapper.so",
        "libexec_wrapper_musl.so",
        // v146: this is $SHELL for Claude Code Bash. Force refresh so stale
        // diagnostic launcher builds cannot keep printing DBG/CKPT logs or
        // breaking Bash tool executions after an APK upgrade.
        "shelly_shell",
        "shelly_musl_exec",
        // v76: byte-patched bundled libclaude.so (audio-capture / image-
        // processor .node loaders neutered) needs to reach existing
        // devices on app upgrade. Without ALWAYS_REFRESH the stale
        // pre-patch binary on disk would mask the fix until forceRefresh
        // hits via versionCode bump.
        "claude",
        // CI-provisioned native diagnostic tool; refresh like the other
        // generated native payloads so APK rebuilds update existing homes.
        "strace",
        "proot",
        "libtalloc.so.2",
        "sh-proot-smoke",
        // bug #102 / #115 phase 1: ALWAYS_REFRESH so URL-encoding /
        // scheme-validation tweaks ship without a versionCode bump.
        "shelly_xdg_open"
    )

    private val OBSOLETE_LIBS = setOf(
        // strace rebuild: Alpine package dependencies were removed after
        // libdw/elfutils failed under the Android + bundled musl-loader path.
        "libstrace_dw.so",
        "libstrace_elf.so",
        "libstrace_fts.so",
        "libstrace_bz2.so",
        "libstrace_lzma.so",
        "libstrace_z.so",
        "libstrace_zstd.so"
    )

    fun getLibDir(context: Context): File =
        File(context.filesDir, "termux-libs").also { it.mkdirs() }

    fun getBashPath(context: Context): String =
        File(getLibDir(context), "libbash.so").absolutePath

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
                if (!forceRefresh && fileName !in ALWAYS_REFRESH && outFile.exists() && outFile.length() > 0) continue
                if (forceRefresh && outFile.exists()) outFile.delete()
                val entry = zipFile.getEntry(apkEntry) ?: continue
                zipFile.getInputStream(entry).use { input ->
                    outFile.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
                outFile.setExecutable(true, false)
            }
            for (fileName in OBSOLETE_LIBS) {
                val obsolete = File(libDir, fileName)
                if (obsolete.exists() && !obsolete.delete()) {
                    Log.w(TAG, "failed to delete obsolete extracted file: $fileName")
                }
            }
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

        // Extract bundled AI CLIs (Claude Code, Gemini CLI, Codex)
        Log.i(TAG, "Attempting CLI tools extraction...")
        // Experimental Claude Path D (2026-04-29): CI extracts cli.js from
        // Claude Code's Bun SEA into a separate package. This lets the
        // shell wrapper run latest Claude through Shelly's bionic Node when
        // explicitly requested, without touching the default musl SEA route.
        extractTarGzAsset(context, "claude-extracted.tar.gz", libDir, "node_modules/@anthropic-ai/claude-code-extracted/cli.js", forceRefresh)
        // bug #139 (2026-04-27): marker switched to gemini-cli because
        // claude-code was removed from the bundle (the musl SEA at
        // libclaude.so is the primary Claude path; runtime updater
        // refreshes it). gemini-cli is the heaviest remaining bundled
        // package and a reliable "did we extract?" sentinel.
        extractTarGzAsset(context, "cli-tools.tar.gz", libDir, "node_modules/@google/gemini-cli", forceRefresh)
        Log.i(TAG, "CLI tools extraction done, checking launchers...")

        // Note: CLI launchers (claude, gemini, codex) are defined as bash functions
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
                    append("|claudeExtracted=").append(zipEntryFingerprint(zip, "assets/claude-extracted.tar", "assets/claude-extracted.tar.gz"))
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
            val isTarGz = actualName.endsWith(".gz")
            val tempTar = File(context.cacheDir, actualName)
            context.assets.open(actualName).use { input ->
                tempTar.outputStream().use { output ->
                    input.copyTo(output)
                }
            }
            destDir.mkdirs()
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
