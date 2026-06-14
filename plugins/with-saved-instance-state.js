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

  const relayoutMarker = "forceTopLevelRelayout";
  if (contents.includes(relayoutMarker)) {
    return patchExistingRelayout(contents);
  }

  contents = addImport(contents, "import android.content.res.Configuration");
  contents = addImport(contents, "import android.util.Log");
  contents = addImport(contents, "import android.view.ViewGroup");

  const onCreateEndPattern = /(\s*super\.onCreate\(null\)\s*\n\s*})/;
  const relayoutBlock = `

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
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
      decor.requestLayout()
      decor.invalidate()
      content?.requestLayout()
      content?.invalidate()
      if (content != null) {
        for (i in 0 until content.childCount) {
          content.getChildAt(i)?.let { child ->
            child.requestLayout()
            child.invalidate()
          }
        }
      }
      Log.d("MainActivity", "Forced top-level relayout after $reason")
    }

    decor.post(relayout)
    decor.postDelayed(relayout, 120L)
  }`;

  if (!onCreateEndPattern.test(contents)) {
    throw new Error("with-saved-instance-state could not find MainActivity.onCreate template");
  }
  contents = contents.replace(onCreateEndPattern, `$1${relayoutBlock}`);
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
  if (!patched.includes("override fun onResume()")) {
    patched = patched.replace(
      /\n\s*private fun forceTopLevelRelayout\(reason: String\) \{/,
      `

  override fun onResume() {
    super.onResume()
    forceTopLevelRelayout("resume")
  }

  private fun forceTopLevelRelayout(reason: String) {`,
    );
  }
  return patched;
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
