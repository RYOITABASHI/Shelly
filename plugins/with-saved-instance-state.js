/**
 * Expo config plugin: harden MainActivity.kt for Shelly's long-lived native
 * shell UI.
 *
 * - Keep MainActivity from restoring Android fragment state. react-native-
 *   screens intentionally crashes if Screen fragments are restored by the
 *   platform; Shelly state restoration must come from our explicit stores /
 *   native PTY registries instead.
 * - Force a top-level relayout after foldable / multi-window configuration
 *   changes. On Samsung Fold cover transitions the Activity can keep the
 *   React root surface measured at the previous display size, leaving a gray
 *   strip outside the app until a later resize. Requesting layout on decor,
 *   content, and the direct React root child heals that stale measurement.
 *
 * This protects background resume, fold/unfold, and process recreation paths.
 */
const { withMainActivity } = require("expo/config-plugins");

function withSavedInstanceState(config) {
  return withMainActivity(config, (config) => {
    config.modResults.contents = patchMainActivity(config.modResults.contents);
    return config;
  });
}

function patchMainActivity(source) {
  let contents = source;

  contents = contents.replace(/super\.onCreate\(savedInstanceState\)/, "super.onCreate(null)");
  contents = addImport(contents, "import android.content.res.Configuration");
  contents = addImport(contents, "import android.os.Build");
  contents = addImport(contents, "import android.util.Log");
  contents = addImport(contents, "import android.view.ViewGroup");
  contents = ensureDisplayClassField(contents);

  const relayoutMarker = "forceTopLevelRelayout";
  if (contents.includes(relayoutMarker)) {
    return ensureDisplayClassInit(patchExistingRelayout(contents));
  }

  const onCreateEndPattern = /(\s*super\.onCreate\(null\)\s*\n\s*})/;

  if (!onCreateEndPattern.test(contents)) {
    throw new Error("with-saved-instance-state could not find MainActivity.onCreate template");
  }
  contents = contents.replace(onCreateEndPattern, `$1${relayoutBlock()}`);
  contents = ensureDisplayClassInit(contents);
  return contents;
}

function patchExistingRelayout(contents) {
  let patched = contents;
  patched = patched.replace(
    /Log\.d\(TAG,\s*"Forced top-level relayout after \$reason"\)/,
    'Log.d("MainActivity", "Forced top-level relayout after $reason")',
  );
  patched = patched.replace(
    /\n\n  companion object \{\n    private const val TAG = "MainActivity"\n  \}\n(?=\})/,
    "\n",
  );
  const blockWithDisplayClass =
    /\n\s*override fun onConfigurationChanged\(newConfig: Configuration\) \{[\s\S]*?\n\s*private fun displayClass\(config: Configuration\): String \{[\s\S]*?\n\s*}\n(?=\n\s*\/\*\*)/;
  const blockWithoutDisplayClass =
    /\n\s*override fun onConfigurationChanged\(newConfig: Configuration\) \{[\s\S]*?\n\s*private fun forceTopLevelRelayout\(reason: String\) \{[\s\S]*?\n\s*}\n(?=\n\s*\/\*\*)/;
  if (blockWithDisplayClass.test(patched)) {
    patched = patched.replace(blockWithDisplayClass, `${relayoutBlock()}\n`);
  } else if (blockWithoutDisplayClass.test(patched)) {
    patched = patched.replace(blockWithoutDisplayClass, `${relayoutBlock()}\n`);
  } else if (!patched.includes("override fun onResume()")) {
    patched = patched.replace(/\n(?=\s*\/\*\*)/, `${relayoutBlock()}\n`);
  }
  return patched;
}

function ensureDisplayClassField(contents) {
  if (contents.includes("private var lastDisplayClass")) {
    return contents;
  }
  return contents.replace(
    /class MainActivity : ReactActivity\(\) \{/,
    `class MainActivity : ReactActivity() {
  private var lastDisplayClass: String? = null`,
  );
}

function ensureDisplayClassInit(contents) {
  if (contents.includes("lastDisplayClass = displayClass(resources.configuration)")) {
    return contents;
  }
  return contents.replace(
    /super\.onCreate\(null\)/,
    "super.onCreate(null)\n    lastDisplayClass = displayClass(resources.configuration)",
  );
}

function relayoutBlock() {
  return `

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    val nextDisplayClass = displayClass(newConfig)
    if (lastDisplayClass != null && lastDisplayClass != nextDisplayClass) {
      Log.d(
        "MainActivity",
        "Display class changed " + lastDisplayClass + " -> " + nextDisplayClass + "; forcing relayout",
      )
    }
    lastDisplayClass = nextDisplayClass
    forceTopLevelRelayout("configurationChanged")
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) {
      forceTopLevelRelayout("windowFocus")
    }
  }

  override fun onResume() {
    super.onResume()
    forceTopLevelRelayout("resume")
  }

  private fun forceTopLevelRelayout(reason: String) {
    val decor = window.decorView
    val relayout = Runnable {
      val content = findViewById<ViewGroup>(android.R.id.content)
      val bounds = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        windowManager.currentWindowMetrics.bounds
      } else {
        null
      }
      decor.forceLayout()
      decor.requestLayout()
      decor.requestApplyInsets()
      decor.invalidate()
      content?.let {
        it.forceLayout()
        it.requestLayout()
        it.requestApplyInsets()
        it.invalidate()
      }
      
      Log.d(
        "MainActivity",
        "Forced top-level relayout after " + reason +
          " bounds=" + (bounds ?: "n/a") +
          " decor=" + decor.width + "x" + decor.height +
          " content=" + (content?.width ?: 0) + "x" + (content?.height ?: 0),
      )
    }

    decor.post(relayout)
    decor.postDelayed(relayout, 80L)
    decor.postDelayed(relayout, 160L)
    decor.postDelayed(relayout, 320L)
    decor.postDelayed(relayout, 640L)
    decor.postDelayed(relayout, 1000L)
  }

  private fun displayClass(config: Configuration): String {
    val widthDp = config.screenWidthDp
    val smallestDp = config.smallestScreenWidthDp
    return when {
      widthDp >= 600 || smallestDp >= 600 -> "wide"
      widthDp > 0 && widthDp < 380 -> "compact"
      else -> "standard"
    }
  }`;
}

function addImport(contents, importLine) {
  if (contents.includes(importLine)) {
    return contents;
  }
  const packageLineEnd = contents.indexOf("\n", contents.indexOf("package "));
  if (packageLineEnd < 0) {
    throw new Error(`with-saved-instance-state could not insert ${importLine}`);
  }
  return contents.slice(0, packageLineEnd + 1) + `${importLine}\n` + contents.slice(packageLineEnd + 1);
}

module.exports = withSavedInstanceState;
module.exports.patchMainActivity = patchMainActivity;
