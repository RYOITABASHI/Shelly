/**
 * components/panes/BrowserPane.tsx is a heavy WebView-dependent component
 * not currently covered by a full render test in this repo, so this pins
 * the two source-level wiring points of the 2026-08-06 last-URL-recovery
 * fix (see store/browser-store.ts's recordVisitedUrl/loadLastOpenedUrl and
 * app/_layout.tsx's boot-init call) as a lightweight text assertion —
 * mirrors __tests__/app-layout-store-boot-init.test.ts's approach for the
 * same reason: a fast, dependency-free regression check for "the wiring
 * got silently dropped," without pulling in react-native-webview mocks.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('BrowserPane.tsx last-URL-recovery wiring', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'components', 'panes', 'BrowserPane.tsx'),
    'utf8',
  );

  it('falls back to the persisted lastOpenedUrl when initialUrl is still the default and no openSignal is pending', () => {
    expect(source).toContain('if (s.lastOpenedUrl) {');
    expect(source).toContain('return s.lastOpenedUrl;');
  });

  it('records every real navigation via recordVisitedUrl, so a later cold start has something to fall back to', () => {
    expect(source).toMatch(/handleNavigationStateChange[\s\S]{0,400}recordVisitedUrl\(state\.url\)/);
  });

  it('subscribes to lastOpenedUrl and applies it via shouldApplyLastOpenedUrlFallback (2026-08-06 Codex review finding round 2: the synchronous initialResolvedUrl fallback alone races app/_layout.tsx\'s async loadLastOpenedUrl() and usually loses on a genuine cold start)', () => {
    expect(source).toContain("import { shouldApplyLastOpenedUrlFallback } from '@/lib/browser-pane-last-url-fallback';");
    expect(source).toContain("const lastOpenedUrl = useBrowserStore((s) => s.lastOpenedUrl);");
    expect(source).toContain('shouldApplyLastOpenedUrlFallback({');
  });

  it('seeds appliedLastOpenedUrlRef from whatever already resolved the URL at mount time (2026-08-06 Codex review finding round 3: without this, a pane resolved via openSignal/explicit initialUrl/the synchronous fallback could still later adopt an UNRELATED Browser Pane\'s lastOpenedUrl update if it happened to be sitting at about:blank again)', () => {
    expect(source).toContain('let resolvedAtMount = false;');
    expect(source).toContain('const appliedLastOpenedUrlRef = useRef(resolvedAtMount);');
    // Every branch of the initial-URL resolution IIFE that returns something
    // other than a bare 'about:blank' must mark resolvedAtMount — pin all
    // three sites so a future edit adding a fourth resolution path can't
    // silently reintroduce the gap.
    const openSignalBranch = source.slice(
      source.indexOf('lastConsumedOpenSignalSeq = s.openSignal.seq;'),
      source.indexOf('lastConsumedOpenSignalSeq = s.openSignal.seq;') + 120,
    );
    expect(openSignalBranch).toContain('resolvedAtMount = true;');
    const explicitInitialUrlBranch = source.slice(
      source.indexOf("if (initialUrl !== 'about:blank')"),
      source.indexOf("if (initialUrl !== 'about:blank')") + 120,
    );
    expect(explicitInitialUrlBranch).toContain('resolvedAtMount = true;');
    const syncFallbackBranch = source.slice(
      source.indexOf('if (s.lastOpenedUrl) {'),
      source.indexOf('if (s.lastOpenedUrl) {') + 120,
    );
    expect(syncFallbackBranch).toContain('resolvedAtMount = true;');
  });
});
