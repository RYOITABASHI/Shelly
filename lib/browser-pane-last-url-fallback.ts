/**
 * lib/browser-pane-last-url-fallback.ts — the decision logic behind
 * components/panes/BrowserPane.tsx's "late-arriving lastOpenedUrl"
 * recovery (2026-08-06 on-device QA finding, docs/superpowers/DEFERRED.md).
 *
 * Extracted as a pure function (rather than leaving the condition inline
 * in the component's useEffect) so it is independently unit-testable —
 * BrowserPane.tsx itself has no full render-test coverage in this repo
 * (heavy react-native-webview dependency), and this decision has enough
 * branches (already applied / nothing to apply / an explicit initialUrl
 * wins / the pane was already navigated) that pinning it via a source-text
 * regex assertion alone (as __tests__/browser-pane-last-url-wiring.test.ts
 * does for the two simpler wiring points) would not actually prove the
 * logic is correct, only that some matching text exists somewhere.
 */
export interface LastOpenedUrlFallbackState {
  /** Whether this pane instance has already applied a fallback once —
   *  the fallback must only ever fire a single time per pane. */
  alreadyApplied: boolean;
  /** store/browser-store.ts's persisted lastOpenedUrl at the moment this
   *  is evaluated — null until store/browser-store.ts's
   *  loadLastOpenedUrl() (app/_layout.tsx's boot-init call) resolves. */
  lastOpenedUrl: string | null;
  /** The pane's own initialUrl prop, as passed by its caller. */
  initialUrl: string;
  /** The pane's live currentUrl at the moment this is evaluated. */
  currentUrl: string;
}

/**
 * Whether BrowserPane.tsx should now adopt `lastOpenedUrl` as its
 * currentUrl/inputUrl. All four conditions must hold:
 *  1. Not already applied (once only, ever, per pane instance).
 *  2. A lastOpenedUrl actually exists to apply.
 *  3. The caller did not explicitly request a specific initialUrl — an
 *     explicit request always wins over this recovery fallback.
 *  4. The pane is STILL genuinely untouched ('about:blank') — if the user
 *     (or an openSignal, or a bookmark tap) already navigated it
 *     somewhere in the meantime, applying a late-arriving lastOpenedUrl
 *     now would silently yank the page out from under them.
 */
export function shouldApplyLastOpenedUrlFallback(state: LastOpenedUrlFallbackState): boolean {
  if (state.alreadyApplied) return false;
  if (!state.lastOpenedUrl) return false;
  if (state.initialUrl !== 'about:blank') return false;
  if (state.currentUrl !== 'about:blank') return false;
  return true;
}
