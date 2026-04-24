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
        "lib/arm64-v8a/libproot.so" to "libproot.so",
        "lib/arm64-v8a/libtalloc.so" to "libtalloc.so.2",
        // codex native binary (ET_DYN, built from codex-termux for Android/bionic)
        // exec variant: 1-shot runner for `codex exec/resume/review` subcommands
        "lib/arm64-v8a/libcodex_exec.so" to "codex_exec",
        // tui variant: full interactive REPL (used when `codex` is invoked with
        // no subcommand, or with a bare prompt). Same RUNPATH=$ORIGIN, no extra
        // shared libs needed — all deps are standard bionic (libc/libm/libdl/libz).
        "lib/arm64-v8a/libcodex_tui.so" to "codex_tui",
        // exec wrapper: LD_PRELOAD library that redirects execve() through linker64
        // (required for targetSdk >= 29 where SELinux blocks direct exec from app_data_file)
        "lib/arm64-v8a/libexec_wrapper.so" to "libexec_wrapper.so",
        // shelly-shell-launcher: tiny PIE binary used as $SHELL for tools that
        // spawn their own shell via Node/Bun child_process (Claude Code, Gemini
        // CLI, Codex). Must be extracted to a stable app-data path because
        // nativeLibraryDir is empty on zero-copy-packaged installs, and on
        // APK reinstall its obfuscated path changes, leaving any symlink
        // baked into $HOME/bin/bash dangling. libexec_wrapper.so intercepts
        // the execve() and routes it through /system/bin/linker64 as usual.
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
        "lib/arm64-v8a/libld_musl_shelly.so" to "ld-musl-aarch64.so.1"
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
                if (!forceRefresh && outFile.exists() && outFile.length() > 0) continue
                if (forceRefresh && outFile.exists()) outFile.delete()
                val entry = zipFile.getEntry(apkEntry) ?: continue
                zipFile.getInputStream(entry).use { input ->
                    outFile.outputStream().use { output ->
                        input.copyTo(output)
                    }
                }
                outFile.setExecutable(true, false)
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
        extractTarGzAsset(context, "cli-tools.tar.gz", libDir, "node_modules/@anthropic-ai/claude-code", forceRefresh)
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
        return packageInfo.longVersionCode.toString()
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
