package expo.modules.termuxbridge

import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val TAG = "TermuxBridgeModule"

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
        putExtra("com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash")
        putExtra("com.termux.RUN_COMMAND_ARGUMENTS", arrayOf("-c", command))
        putExtra("com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home")
        putExtra("com.termux.RUN_COMMAND_BACKGROUND", background)
      }

      Log.i(TAG, "runCommand: sending intent to RunCommandService, cmd=${command.take(80)}")
      try {
        context.startService(intent)
        Log.i(TAG, "runCommand: startService succeeded")
        mapOf("success" to true)
      } catch (e: SecurityException) {
        Log.e(TAG, "runCommand: PERMISSION_DENIED", e)
        mapOf("success" to false, "error" to "PERMISSION_DENIED: ${e.message}")
      } catch (e: IllegalStateException) {
        Log.w(TAG, "runCommand: startService failed (background?), trying startForegroundService", e)
        try {
          context.startForegroundService(intent)
          Log.i(TAG, "runCommand: startForegroundService succeeded")
          mapOf("success" to true)
        } catch (e2: Exception) {
          Log.e(TAG, "runCommand: startForegroundService also failed", e2)
          mapOf("success" to false, "error" to "FGS_FAILED: ${e2.message}")
        }
      } catch (e: Exception) {
        Log.e(TAG, "runCommand: unexpected error", e)
        mapOf("success" to false, "error" to (e.message ?: "Unknown error"))
      }
    }

    AsyncFunction("startForeground") {
      val context = appContext.reactContext
        ?: throw Exception("React context not available")
      ShellyForegroundService.start(context)
      mapOf("success" to true)
    }

    AsyncFunction("stopForeground") {
      val context = appContext.reactContext
        ?: throw Exception("React context not available")
      ShellyForegroundService.stop(context)
      mapOf("success" to true)
    }

    Function("isForegroundRunning") {
      ShellyForegroundService.running()
    }

    /**
     * Launch Termux Activity — reliable fallback when RunCommandService
     * is blocked by Android battery restrictions (standby bucket RARE).
     * Opening Termux triggers .bashrc which auto-starts the bridge.
     */
    /**
     * Launch Termux Activity — reliable fallback when RunCommandService
     * is blocked by Android battery restrictions (standby bucket RARE).
     * Uses CLEAR_TOP to force Termux to create a new session, triggering .bashrc.
     * Then immediately brings Shelly back to front.
     */
    AsyncFunction("launchTermux") {
      val context = appContext.reactContext
        ?: throw Exception("React context not available")

      // Launch Termux — SINGLE_TOP to avoid destroying existing sessions
      val termuxIntent = Intent(Intent.ACTION_MAIN).apply {
        component = ComponentName(
          "com.termux",
          "com.termux.app.TermuxActivity"
        )
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      }

      try {
        context.startActivity(termuxIntent)
        Log.i(TAG, "launchTermux: Termux Activity launched")

        // Step 2: After a short delay, bring Shelly back to front
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
          try {
            val shellyIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
            shellyIntent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (shellyIntent != null) {
              context.startActivity(shellyIntent)
              Log.i(TAG, "launchTermux: Shelly brought back to front")
            }
          } catch (e: Exception) {
            Log.w(TAG, "launchTermux: failed to bring Shelly back", e)
          }
        }, 3000) // 3s delay for Termux to start + .bashrc to run

        mapOf("success" to true)
      } catch (e: Exception) {
        Log.e(TAG, "launchTermux: failed", e)
        mapOf("success" to false, "error" to (e.message ?: "Unknown error"))
      }
    }

    /**
     * Start bridge directly via 'am startservice' shell command.
     * Bypasses context.startService() which can be silently dropped
     * by Android 14 battery restrictions. Shell-level 'am' may have
     * different delivery behavior.
     */
    AsyncFunction("startBridgeDirect") {
      val cmd = arrayOf(
        "/system/bin/am", "startservice",
        "--user", "0",
        "-n", "com.termux/.app.RunCommandService",
        "-a", "com.termux.RUN_COMMAND",
        "--es", "com.termux.RUN_COMMAND_PATH", "/data/data/com.termux/files/usr/bin/bash",
        "--esa", "com.termux.RUN_COMMAND_ARGUMENTS", "-c,cd /data/data/com.termux/files/home/shelly-bridge && nohup /data/data/com.termux/files/usr/bin/node server.js > /dev/null 2>&1 &",
        "--es", "com.termux.RUN_COMMAND_WORKDIR", "/data/data/com.termux/files/home",
        "--ez", "com.termux.RUN_COMMAND_BACKGROUND", "true"
      )

      try {
        val process = Runtime.getRuntime().exec(cmd)
        val exitCode = process.waitFor()
        val error = process.errorStream.bufferedReader().readText().trim()
        Log.i(TAG, "startBridgeDirect: exit=$exitCode err=$error")
        mapOf("success" to (exitCode == 0 && !error.contains("not allowed")), "error" to error)
      } catch (e: Exception) {
        Log.e(TAG, "startBridgeDirect failed", e)
        mapOf("success" to false, "error" to (e.message ?: "Unknown"))
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
