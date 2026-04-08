package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import java.io.File
import java.util.zip.ZipFile

object LibExtractor {
    private const val TAG = "LibExtractor"

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
        "lib/arm64-v8a/libsqlite3_bin.so" to "sqlite3"
    )

    fun getLibDir(context: Context): File =
        File(context.filesDir, "termux-libs").also { it.mkdirs() }

    fun getBashPath(context: Context): String =
        File(getLibDir(context), "libbash.so").absolutePath

    fun extractAll(context: Context): File {
        val libDir = getLibDir(context)

        // Extract native binaries from APK
        val apkPath = context.applicationInfo.sourceDir
        val zipFile = ZipFile(apkPath)
        try {
            for ((apkEntry, fileName) in LIBS) {
                val outFile = File(libDir, fileName)
                if (outFile.exists() && outFile.length() > 0) continue
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
        extractTarGzAsset(context, "python3.tar.gz", libDir, "python3.13")

        // Extract pip from assets → python3.13/site-packages/pip/
        val sitePackages = File(libDir, "python3.13/site-packages")
        extractTarGzAsset(context, "pip.tar.gz", sitePackages, "pip")

        return libDir
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

    private fun extractTarGzAsset(context: Context, assetName: String, destDir: File, checkDir: String) {
        if (File(destDir, checkDir).exists()) return
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
