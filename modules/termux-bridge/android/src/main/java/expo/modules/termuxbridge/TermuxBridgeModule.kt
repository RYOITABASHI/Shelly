package expo.modules.termuxbridge

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class TermuxBridgeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("TermuxBridge")

    /**
     * Execute a command in Termux via RUN_COMMAND Intent (Service).
     * Requires com.termux.permission.RUN_COMMAND and Termux:Tasker plugin.
     *
     * This uses startForegroundService/startService to invoke Termux's
     * RunCommandService, which expo-intent-launcher cannot do (Activity only).
     */
    AsyncFunction("runCommand") { command: String, background: Boolean ->
      val context = appContext.reactContext
        ?: throw Exception("React context not available")

      val intent = Intent("com.termux.RUN_COMMAND").apply {
        component = ComponentName(
          "com.termux",
          "com.termux.app.RunCommandService"
        )
        putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/sh")
        putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-c", command))
        putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home")
        putExtra("com.termux.RUN_COMMAND_BACKGROUND", background)
      }

      try {
        context.startService(intent)
        mapOf("success" to true)
      } catch (e: SecurityException) {
        // Permission not granted
        mapOf("success" to false, "error" to "PERMISSION_DENIED")
      } catch (e: IllegalStateException) {
        // App in background, try foreground service
        try {
          context.startForegroundService(intent)
          mapOf("success" to true)
        } catch (e2: Exception) {
          mapOf("success" to false, "error" to e2.message)
        }
      } catch (e: Exception) {
        mapOf("success" to false, "error" to (e.message ?: "Unknown error"))
      }
    }

    /**
     * Check if a package is installed on the device.
     */
    AsyncFunction("isPackageInstalled") { packageName: String ->
      val context = appContext.reactContext
        ?: throw Exception("React context not available")
      try {
        context.packageManager.getPackageInfo(packageName, 0)
        true
      } catch (e: Exception) {
        false
      }
    }
  }
}
