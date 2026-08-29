import * as fs from 'fs';
import * as path from 'path';

// Fable5 review (2026-08-29, app.act Phase 1 batch): before Phase 1, every
// recipe was one of the two bundled, read-only APK-asset recipes
// (line.send-message / x.post), so AppActExecutor never needed to check
// recipe.pkg against the LINE/X allowlist — it was implicitly always one of
// the two. Phase 1 added a `user.`-prefixed on-disk recipe path
// (AppActRecipeStore.load reads from $HOME/.shelly/app-act-recipes/), so a
// recipe's `pkg` field is no longer guaranteed to be LINE/X. This is a
// source-level assertion (the same class of test as
// agent-runtime-enabled-check.test.ts) because the Kotlin here cannot be
// unit-tested directly from this repo (no local Kotlin/Gradle toolchain —
// only CI's Gradle build compiles it).
const appActExecutor = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AppActExecutor.kt',
  ),
  'utf8',
);

const shellyAccessibilityService = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ShellyAccessibilityService.kt',
  ),
  'utf8',
);

describe('AppActExecutor — LINE/X allowlist re-check on the acting path (Fable5 P1)', () => {
  it('defines a single source of truth for the allowlist check in ShellyAccessibilityService, internal (not private)', () => {
    expect(shellyAccessibilityService).toContain(
      'internal fun isAllowlistedAppActPackage(pkg: String): Boolean = pkg == LINE_PACKAGE || pkg == X_PACKAGE',
    );
  });

  it('executeInner refuses a recipe whose pkg is not in the allowlist, before any step runs', () => {
    const start = appActExecutor.indexOf('private fun executeInner(');
    const guardIdx = appActExecutor.indexOf('isAllowlistedAppActPackage', start);
    const firstStepCallIdx = appActExecutor.indexOf('executeStep(', start);

    expect(start).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(start);
    // The allowlist check must run BEFORE the first step (launch/click/
    // setText/scroll) ever executes — a check placed after would let at
    // least one action through against a non-allowlisted package.
    expect(guardIdx).toBeLessThan(firstStepCallIdx);
  });

  it('the guard rejects (returns a failure result) rather than throwing or falling through', () => {
    const start = appActExecutor.indexOf('private fun executeInner(');
    const guardIdx = appActExecutor.indexOf('isAllowlistedAppActPackage', start);
    const guardBlock = appActExecutor.slice(guardIdx, guardIdx + 300);
    expect(guardBlock).toMatch(/return AppActDebugResult\(false, "Recipe \$recipeId targets a package outside the app\.act allowlist: \$\{recipe\.pkg\}"\)/);
  });

  // Codex review follow-up (2026-08-29): the allowlist check above validates
  // recipe.pkg, but a `launch` step's own target was never required to
  // match it — a user-saved recipe could declare pkg="jp.naver.line.android"
  // (to pass the allowlist guard) while its launch step targets a
  // completely different installed app, bringing it to the foreground as a
  // side effect (later click/setText/scroll steps still can't act on it,
  // since they separately require the CURRENT foreground root's package to
  // equal `pkg`, but launch alone had no such check).
  it('executeStep refuses a launch step whose target does not match the recipe pkg', () => {
    const dispatchStart = appActExecutor.indexOf('): AppActDebugResult = when (step.op) {');
    const launchBranch = appActExecutor.slice(dispatchStart, appActExecutor.indexOf('"click" ->', dispatchStart));
    expect(launchBranch).toContain('"launch" ->');
    expect(launchBranch).toContain('step.target != pkg');
    expect(launchBranch).toMatch(/AppActDebugResult\(false, "launch step target/);
  });
});
