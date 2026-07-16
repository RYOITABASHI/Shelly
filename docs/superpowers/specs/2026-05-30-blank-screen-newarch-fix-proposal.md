# Fix Proposal — Blank screen on launch (New-Arch mismatch)

Status: proposal for Codex implementation session. Read-only authored on baseline tree `C:\Users\ryoxr\Shelly` (older checkout than Codex's). Native `android/` differs between trees — see §6.

## 1. TL;DR

- **Root cause:** `a0068985 "Release Shelly 5.3.1"` accidentally flipped `android/gradle.properties` `newArchEnabled=true→false` + `hermesEnabled=true→false`, while `app.config.ts:30` stays `newArchEnabled: true` and the JS bundle (reanimated 4.x, new-arch-only) is new-arch. Mismatch → gesture-handler TurboModule not found → `app/_layout.tsx` import throws → expo-router renders blank.
- **Chosen strategy: A (CNG / prebuild-authoritative).** The flag lives in a *generated* file; the durable fix is to make `app.config.ts` the single source of truth and stop committing a stale `gradle.properties`. Set `newArchEnabled=true` + `hermesEnabled=true` (true only — reanimated 4.1.6 forbids old-arch).
- **GO/NO-GO gate:** clean checkout → CI prebuild emits `newArchEnabled=true`; release APK ships `lib/arm64-v8a/libappmodules.so`; on-device logcat shows no `RNGestureHandlerModule could not be found`.

## 2. Recommended strategy & justification

**Strategy A — CNG / prebuild-authoritative.** Grounded in what the plugins actually do:

CI already runs `npx expo prebuild --platform android` (build-android.yml:805) on every build. All 5 config plugins are prebuild-mod plugins, none of which touch the gradle layer:

- `with-multi-window.js`, `with-terminal-service.js` → `withAndroidManifest` only.
- `with-android-security.js`, `with-apk-installer.js` → `withAndroidManifest` + `withDangerousMod` writing `res/xml/*.xml`.
- `with-saved-instance-state.js` → `withMainActivity` (patches `super.onCreate(null)`).

So **none** of them inject `settings.gradle`, `app/build.gradle`, `gradle.properties`, or `MainApplication.kt` package registration. That means:

- `newArchEnabled` / `hermesEnabled` come straight from `app.config.ts` (`newArchEnabled: true`) into the prebuild-generated `gradle.properties`. **No plugin needed** — prebuild already does this. The only thing defeating it is a **stale committed `gradle.properties`** that prebuild-without-`--clean` leaves in place.
- The custom `TerminalEmulatorModule` / `TerminalViewModule` are **Expo Modules** (`class TerminalEmulatorModule : expo.modules.kotlin.modules.Module`, registered via `modules/terminal-emulator/expo-module.config.json` → `autolinkLibrariesWithApp()` in the generated `app/build.gradle:63`). They are **not** hand-registered in `settings.gradle`/`MainApplication.kt`, and are arch-agnostic. So the gesture-handler / RNGH TurboModule registration Codex saw is **RN autolinking output of prebuild**, not a hand edit — it regenerates correctly once the flag is true.

The baseline tree proves the failure mode: it has a **partial committed `android/`** (`git ls-files android` = `app/build.gradle`, `app/src/main/AndroidManifest.xml`, `gradle.properties` — NOT `settings.gradle`, NOT `MainApplication.kt`), force-added despite `.gitignore:16 /android/`. The committed `android/gradle.properties:38-42` reads `newArchEnabled=false` + `hermesEnabled=false`, and `:31` `reactNativeArchitectures=armeabi-v7a,arm64-v8a` contradicts `app.config buildArchs:["arm64-v8a"]`. These committed files are exactly what let `a0068985` drift: prebuild (no `--clean`) keeps an existing `gradle.properties` rather than regenerating it from `app.config`. The committed `app/build.gradle` is otherwise pristine Expo template (autolinking, no hand edits).

**Fix essence:** delete the stale tracked `android/` files so prebuild regenerates them from `app.config.ts`. CNG becomes authoritative and drift-proof; `android/` stays gitignored.

**Fallback — Strategy B (committed-native).** If Codex's tree has hand edits in `settings.gradle`/`app/build.gradle`/`MainApplication.kt` that are NOT plugin-expressible (e.g. the prefab repair at build.gradle:143, or a manual `project(":...")` at build.gradle:300 — neither exists on baseline), and authoring plugins for them is out of scope, then commit native instead: `git add -f` the critical `android/` files with `newArchEnabled=true`, remove `/android/` from `.gitignore`, and **drop the prebuild step** from CI (otherwise prebuild fights committed files). Slower-drifting risk, loses CNG. Only choose this if §6 verification shows non-plugin-coverable hand edits.

## 3. Ordered fix steps (Strategy A)

1. **Confirm authority.** `app.config.ts:30` already `newArchEnabled: true`. Leave as-is. No `hermesEnabled` key needed in app.config — Expo defaults Hermes on for new arch; the generated `gradle.properties` will emit `hermesEnabled=true`.
2. **Remove stale committed native so prebuild regenerates it:**
   ```bash
   git rm --cached android/gradle.properties android/app/build.gradle android/app/src/main/AndroidManifest.xml
   # plus any other tracked android/* on Codex's tree — see step 3
   git rm -r --cached android  # safe catch-all: untrack everything under android/
   ```
   `/android/` is already in `.gitignore:16`, so after untracking it stays ignored and regenerated.
3. **List what is actually tracked on Codex's tree first** (it differs from baseline): `git ls-files android`. Untrack every entry. If `settings.gradle` / `MainApplication.kt` are tracked there, untrack those too (they are prebuild-generated + autolinked).
4. **Make prebuild deterministic — add `--clean`:** in `.github/workflows/build-android.yml:805` change
   ```yaml
   run: npx expo prebuild --platform android --clean
   ```
   `--clean` forces a from-scratch regen so a cached/stale `gradle.properties` can never override `app.config`. (Verify no needed hand edit is wiped — §6.)
5. **Do NOT** hand-edit any `gradle.properties` to set the flag — that re-introduces the committed-file drift this fix removes. The flag is owned by `app.config.ts`.
6. Keep all jniLibs/asset payload steps unchanged — they write into `modules/terminal-emulator/...`, outside `android/`, untouched by prebuild.

## 4. Reproducibility gate (must pass on a CLEAN checkout)

```bash
git clean -xfd android            # ensure no local android/ leftovers
npx expo prebuild --platform android --clean
grep -E '^newArchEnabled=' android/gradle.properties   # MUST print newArchEnabled=true
grep -E '^hermesEnabled='  android/gradle.properties   # MUST print hermesEnabled=true
```
Then a release build and APK content check:
```bash
(cd android && ./gradlew assembleRelease -x lintVitalAnalyzeRelease)
APK=$(ls android/app/build/outputs/apk/release/*.apk | head -1)
unzip -l "$APK" | grep -E 'lib/arm64-v8a/libappmodules\.so'   # new-arch module registry present
unzip -l "$APK" | grep -E 'lib/arm64-v8a/libhermes\.so'        # Hermes engine present
```
`libappmodules.so` present = TurboModule/Fabric codegen ran under new arch and the custom Expo Modules + RNGH/reanimated are registered. Absent = NO-GO.

## 5. Codex findings #4 and #5

- **#4 (release rebuild required):** The current release APK was built from an inconsistent MainActivity/MainApplication class state and cannot validate the latest native. **Mandatory:** a clean release rebuild (`rm -rf android/app/build`, `--no-build-cache` already in workflow:900) AFTER the prebuild change, then on-device logcat verification (§7). `--version`/`-p` alone is insufficient per the runtime-route memory rule; a bare on-device launch is required.
- **#5 (prefab repair fragility):** If Codex's tree has a prefab-repair block (`app/build.gradle:143`-ish) as a proot/RN-patch workaround, **keep it for now, flag as tech-debt, do not expand scope.** It is not present on baseline (baseline `app/build.gradle` is stock). Under Strategy A it must be re-expressed as a `withAppBuildGradle` config-plugin edit so prebuild re-applies it (otherwise `--clean` wipes it) — record this as a follow-up DEFERRED item, not part of this fix. If it cannot be deferred safely, that is the trigger to fall back to Strategy B.

## 6. "Codex must verify on its tree" checklist

Baseline differs from Codex's tree; confirm each before implementing:

- [ ] `git ls-files android` on Codex's tree — exact set of tracked native files (baseline tracks only `gradle.properties`, `app/build.gradle`, `AndroidManifest.xml`; Codex reported `settings.gradle` + `MainApplication.kt` involvement).
- [ ] `.gitignore` android state on Codex's tree (baseline: `/android/` ignored at line 16).
- [ ] Does Codex's `app/build.gradle` actually have a hand-added `project(":react-native-...")` at ~:300 and a prefab repair at ~:143? Baseline has **neither** (pristine `autolinkLibrariesWithApp()`). If present, decide plugin-coverable (Strategy A, author `withAppBuildGradle`) vs. commit (Strategy B).
- [ ] Does `MainApplication.kt:40` contain manual package registration beyond Expo defaults? If it's just the Expo template + autolinking, prebuild regenerates it (Strategy A). If hand-edited, it needs a `withMainApplication` plugin or Strategy B.
- [ ] Run `expo prebuild --clean` once and `git diff`/inspect — confirm **no needed hand edit is silently wiped** (the network_security_config.xml, FileProvider xml, service decl, and `super.onCreate(savedInstanceState)` are all plugin-restored; verify nothing else was hand-applied).
- [ ] `scripts/hermesc-copy-bundle.sh` does NOT exist on baseline — confirm whether it's a real Codex-tree script that must be `git add -f`'d, or a stale reference.

## 7. On-device verification

After clean release rebuild + install:
- logcat shows **no** `getEnforcing('RNGestureHandlerModule') could not be found` (was x4).
- **no** `Cannot read property 'ErrorBoundary' of undefined` at expo-router ContextNavigator.
- UI renders (ShellLayout: AgentBar + Sidebar + PaneContainer + ContextBar), not blank.
- PTY opens (terminal pane accepts input; `ShellyPTY` log shows fork/ptsname OK).
- A reanimated animation runs (e.g. open ConfigTUI bottom sheet / pane focus border) without crash — proves new-arch reanimated 4.x is live.

## 8. Do-NOT list

- Do **not** touch `app/_layout.tsx` or its imports (gesture-handler / reanimated). The imports are correct; only the native flag was wrong.
- Do **not** add or modify any `.so` files.
- Do **not** set `newArchEnabled=false` or `hermesEnabled=false` anywhere. Reanimated 4.1.6 is new-arch-only; old arch reintroduces a different break.
- Do **not** hand-edit `gradle.properties` to set the flag (re-introduces drift). Let `app.config.ts` + prebuild own it.
- Do **not** expand scope to refactor the prefab repair (#5) — keep, flag as tech-debt.
