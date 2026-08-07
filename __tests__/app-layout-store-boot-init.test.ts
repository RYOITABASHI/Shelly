/**
 * app/_layout.tsx's boot-time store-initialization block (the useEffect
 * that fires `useI18n.getState().loadLocale()`, `useThemeStore.getState()
 * .loadTheme()`, etc. right after mount) is the ONLY place a Zustand
 * store's persisted config gets loaded back from AsyncStorage/SecureStore
 * on a cold start — a store left out of this list silently starts every
 * session from its in-memory defaults, no matter what was persisted.
 *
 * 2026-08-06 on-device QA finding (docs/superpowers/DEFERRED.md):
 * useDotfilesStore.loadConfig() had ZERO callers anywhere in the codebase.
 * Reproduced on-device: enabling "Include Agents/Skills/Memory" persisted
 * '1' to AsyncStorage (confirmed via sqlite3), but the toggle showed OFF
 * again after an app restart, and — more severely — the saved GitHub PAT
 * itself never reloaded, so Sync to/from Gist silently failed with
 * "GitHub PAT required" on every cold start despite a PAT being saved.
 *
 * This is a plain source-text assertion (not a full RootLayout render —
 * app/_layout.tsx pulls in a large native-module dependency graph that
 * isn't practical to mount in this Jest project) mirroring this
 * codebase's existing agent-executor-script-version-guard.test.ts pattern:
 * a fast, dependency-free regression check for exactly the kind of
 * "wiring got silently dropped" bug this bug itself was.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('app/_layout.tsx boot-time store initialization', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');

  // The boot-init useEffect always starts with this exact log call and
  // ends at the first dependency-array close following it — isolate that
  // block so this test can't accidentally pass because the call merely
  // exists SOMEWHERE else in the file (e.g. inside an unrelated handler).
  function extractBootInitBlock(): string {
    const startMarker = "logLifecycle('RootLayout', 'mounted');";
    const startIdx = source.indexOf(startMarker);
    expect(startIdx).toBeGreaterThan(-1);
    // The synchronous store-load calls end right where the async
    // loadSettings().then(...) chain begins — everything after that is
    // settings-dependent follow-up work, not another store's boot load.
    const endIdx = source.indexOf('loadSettings().then(', startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    return source.slice(startIdx, endIdx);
  }

  it('imports useDotfilesStore', () => {
    expect(source).toMatch(/import\s*\{\s*useDotfilesStore\s*\}\s*from\s*'@\/lib\/dotfiles-sync'/);
  });

  it('calls useDotfilesStore.getState().loadConfig() inside the boot-init block, alongside every other store\'s load call', () => {
    const block = extractBootInitBlock();
    // Every other store already known to load correctly on boot — pinning
    // these too means a future refactor that moves/removes the whole block
    // fails loudly here rather than only in an on-device regression.
    expect(block).toContain("useI18n.getState().loadLocale();");
    expect(block).toContain("useThemeStore.getState().loadTheme();");
    expect(block).toContain("useA11yStore.getState().loadConfig();");
    expect(block).toContain('useDotfilesStore.getState().loadConfig();');
    // 2026-08-06 on-device QA finding, same root cause class: BrowserPane's
    // last-visited-URL fallback (store/browser-store.ts's lastOpenedUrl)
    // is useless if it never gets loaded back on a cold start either.
    expect(block).toContain('useBrowserStore.getState().loadLastOpenedUrl();');
    // 2026-08-06 follow-up (found while reviewing the fix above, same root
    // cause class): AI Pane conversation history and SSH profiles were both
    // persisted on every update but never read back either, so both
    // silently emptied on every cold start despite intact AsyncStorage data.
    expect(block).toContain('useAIPaneStore.getState().load();');
    expect(block).toContain('useProfileStore.getState().loadProfiles();');
  });

  it('imports useAIPaneStore and useProfileStore', () => {
    expect(source).toMatch(/import\s*\{\s*useAIPaneStore\s*\}\s*from\s*'@\/store\/ai-pane-store'/);
    expect(source).toMatch(/import\s*\{\s*useProfileStore\s*\}\s*from\s*'@\/store\/profile-store'/);
  });
});
