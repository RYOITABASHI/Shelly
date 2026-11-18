package expo.modules.terminalemulator

import android.content.Context
import android.util.Log
import java.io.File

/**
 * The environment a non-interactive command gets: TerminalEmulatorModule's
 * `execCommand` (RN) and McpRawToolConsumer (headless MCP run_command) build
 * it here so the two cannot drift. Non-interactive commands do not source
 * ~/.bashrc, so this mirrors the PATH / TLS variables HomeInitializer writes.
 */
object NativeExecEnvironment {
    private const val TAG = "NativeExecEnvironment"

    /** Seeds ~/.shelly-ssl (CA bundle from the APK assets, an empty openssl.cnf). Best effort. */
    fun seedTls(context: Context, homePath: String) {
        val sslDir = "$homePath/.shelly-ssl"
        try {
            File(sslDir).mkdirs()
            val caBundleFile = File("$sslDir/ca-certificates.crt")
            if (!caBundleFile.exists() || caBundleFile.length() == 0L) {
                context.assets.open("ca-certificates.crt").use { input ->
                    caBundleFile.outputStream().use { output -> input.copyTo(output) }
                }
            }
            val opensslConfFile = File("$sslDir/openssl.cnf")
            if (!opensslConfFile.exists()) opensslConfFile.writeText("")
        } catch (e: Exception) {
            Log.w(TAG, "TLS env seed failed: ${e.javaClass.simpleName}")
        }
    }

    /** [command] with the exports every bundled tool expects in front of it. */
    fun wrap(libPath: String, homePath: String, command: String): String {
        val sslDir = "$homePath/.shelly-ssl"
        val caBundle = "$sslDir/ca-certificates.crt"
        val opensslConf = "$sslDir/openssl.cnf"
        return "export PATH='$libPath:$libPath/node_modules/npm/bin:$libPath/node_modules/.bin:/usr/bin:/usr/sbin:/bin:/sbin' && " +
            "export LD_LIBRARY_PATH='$libPath' && " +
            "export HOME='$homePath' && " +
            "export SSL_CERT_FILE='$caBundle' && " +
            "export SSL_CERT_DIR='$sslDir' && " +
            "export CURL_CA_BUNDLE='$caBundle' && " +
            "export NODE_EXTRA_CA_CERTS='$caBundle' && " +
            "export GIT_SSL_CAINFO='$caBundle' && " +
            "export REQUESTS_CA_BUNDLE='$caBundle' && " +
            "export OPENSSL_CONF='$opensslConf' && " +
            command
    }
}
