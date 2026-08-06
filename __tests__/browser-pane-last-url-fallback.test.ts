import { shouldApplyLastOpenedUrlFallback } from '@/lib/browser-pane-last-url-fallback';

const BASE = {
  alreadyApplied: false,
  lastOpenedUrl: 'https://example.com/restored',
  initialUrl: 'about:blank',
  currentUrl: 'about:blank',
};

describe('shouldApplyLastOpenedUrlFallback', () => {
  it('applies when a late-arriving lastOpenedUrl exists, the pane is untouched, and initialUrl is the default', () => {
    expect(shouldApplyLastOpenedUrlFallback(BASE)).toBe(true);
  });

  it('does not re-apply once already applied for this pane instance', () => {
    expect(shouldApplyLastOpenedUrlFallback({ ...BASE, alreadyApplied: true })).toBe(false);
  });

  it('does nothing when nothing has been persisted yet (store still loading, or genuinely never visited)', () => {
    expect(shouldApplyLastOpenedUrlFallback({ ...BASE, lastOpenedUrl: null })).toBe(false);
  });

  it('never overrides an explicit initialUrl the caller requested', () => {
    expect(
      shouldApplyLastOpenedUrlFallback({ ...BASE, initialUrl: 'https://caller-requested.example/' }),
    ).toBe(false);
  });

  it('does not yank the page out from under the user once the pane has actually navigated somewhere', () => {
    expect(
      shouldApplyLastOpenedUrlFallback({ ...BASE, currentUrl: 'https://already-navigated.example/' }),
    ).toBe(false);
  });
});
