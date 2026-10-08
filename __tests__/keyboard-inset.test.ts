import { computeKeyboardOverlap, KEYBOARD_SAFETY_MARGIN } from '@/lib/keyboard-inset';

// Real build-2482/2485 values from the unfolded Z Fold6
// (1856x2160 px @ density 464 => 640x744.83 dp root, nav inset 44px = 15.17 dp,
// status bar 94px = 32.41 dp):
//   keyboardDidShow endCoordinates = { screenY: 356.21, height: 373.45 }
//   pane container bottom (root-relative) = 744.83 - 15.17 (nav) - 18 (ContextBar) - 3 (gutter)
const ROOT_H = 2160 / 2.9;
const NAV = 44 / 2.9;
const KB_TOP = 356.2068786621094;
const FOLD_INNER = {
  keyboardHeight: 373.4482727050781,
  bottomInset: NAV,
  rootHeight: ROOT_H,
  containerBottom: ROOT_H - NAV - 18 - 3,
};

describe('computeKeyboardOverlap', () => {
  it('returns 0 when the keyboard is hidden (incl. hardware keyboards)', () => {
    expect(computeKeyboardOverlap({ ...FOLD_INNER, keyboardHeight: 0 })).toBe(0);
    expect(computeKeyboardOverlap({ ...FOLD_INNER, keyboardHeight: null })).toBe(0);
    expect(computeKeyboardOverlap({ ...FOLD_INNER, keyboardHeight: undefined })).toBe(0);
  });

  it('puts the grid bottom just above the IME top on the unfolded Fold6 (edge-to-edge, no resize)', () => {
    const overlap = computeKeyboardOverlap(FOLD_INNER);
    const gridBottom = FOLD_INNER.containerBottom - overlap;
    // The IME top derived from insets matches RN's reported screenY.
    expect(ROOT_H - (FOLD_INNER.keyboardHeight + NAV)).toBeCloseTo(KB_TOP, 3);
    // Never under the keyboard, and only the safety margin of gap.
    expect(gridBottom).toBeLessThanOrEqual(KB_TOP);
    expect(KB_TOP - gridBottom).toBeCloseTo(KEYBOARD_SAFETY_MARGIN, 3);
  });

  it('regression: reserves the status-bar height that the measureInWindow+screenY mix (build 2485) missed', () => {
    // build 2485 mixed measureInWindow (relative to the visible frame top,
    // i.e. minus the 32.41 dp status bar) with the screen-space screenY and
    // reserved ~32 dp too little. With root-relative inputs the overlap is
    // the full covered height.
    const overlap = computeKeyboardOverlap(FOLD_INNER);
    const buggy = (FOLD_INNER.containerBottom - 94 / 2.9) - KB_TOP;
    expect(overlap - buggy).toBeGreaterThan(30);
  });

  it('returns 0 when the window was already resized above the IME (adjustResize honoured)', () => {
    // Root shrank to the keyboard top; container sits above the IME.
    expect(
      computeKeyboardOverlap({
        keyboardHeight: 373.45,
        bottomInset: NAV,
        rootHeight: KB_TOP,
        rootShrink: ROOT_H - KB_TOP,
        containerBottom: KB_TOP - 21,
      }),
    ).toBe(0);
  });

  it('handles a partial OS resize (root shrank but still overlaps the IME)', () => {
    // Root shrank by only 100 dp: IME top is still KB_TOP in the original frame.
    const rootHeight = ROOT_H - 100;
    const containerBottom = rootHeight - NAV - 18 - 3;
    const overlap = computeKeyboardOverlap({
      keyboardHeight: FOLD_INNER.keyboardHeight,
      bottomInset: NAV,
      rootHeight,
      rootShrink: 100,
      containerBottom,
    });
    expect(KB_TOP - (containerBottom - overlap)).toBeCloseTo(KEYBOARD_SAFETY_MARGIN, 3);
  });

  it('handles the compact cover screen', () => {
    // Cover: 333.8 x 819.3 dp, keyboard height 352.07 (top at 452.07).
    const rootHeight = 2376 / 2.9;
    const containerBottom = rootHeight - NAV - 18;
    const overlap = computeKeyboardOverlap({ keyboardHeight: 352.07, bottomInset: NAV, rootHeight, containerBottom });
    const imeTop = rootHeight - 352.07 - NAV;
    expect(imeTop - (containerBottom - overlap)).toBeCloseTo(KEYBOARD_SAFETY_MARGIN, 3);
  });

  it('never reserves more than the keyboard footprint', () => {
    expect(
      computeKeyboardOverlap({ keyboardHeight: 300, bottomInset: 15, rootHeight: 745, containerBottom: 745 }),
    ).toBe(315);
  });

  it('falls back to the reported keyboard height (+margin) before measurement', () => {
    expect(
      computeKeyboardOverlap({ keyboardHeight: 373.4, bottomInset: NAV, rootHeight: null, containerBottom: null }),
    ).toBeCloseTo(373.4 + KEYBOARD_SAFETY_MARGIN, 5);
  });

  describe('native IME inset (ImeInsetsWatcher)', () => {
    // build 2487: RN reported height 317.59 (top 412.07) — stale, sampled
    // before the IME toolbar rows were added — while the real ime inset
    // was 1127px = 388.62dp (InsetsSource ime frame top 1033px = 356.2dp).
    const REAL_IME = 1127 / 2.9;

    it('uses the real ime inset over the stale RN keyboard height', () => {
      const overlap = computeKeyboardOverlap({
        keyboardHeight: 317.586181640625,
        imeFootprint: REAL_IME,
        bottomInset: NAV,
        rootHeight: 744.8275756835938,
        containerBottom: 708.6206665039062,
      });
      // ~708.6 - 356.2 + 2 = ~354.4 dp
      expect(overlap).toBeCloseTo(708.6206665039062 - (744.8275756835938 - REAL_IME) + KEYBOARD_SAFETY_MARGIN, 3);
      expect(744.8275756835938 - REAL_IME).toBeCloseTo(356.21, 1);
      // The stale RN height alone would have under-reserved (the 2487 bug).
      const stale = computeKeyboardOverlap({
        keyboardHeight: 317.586181640625,
        bottomInset: NAV,
        rootHeight: 744.8275756835938,
        containerBottom: 708.6206665039062,
      });
      expect(overlap - stale).toBeGreaterThan(50);
    });

    it('returns 0 when the native watcher says the IME is hidden, even if RN is stale', () => {
      expect(
        computeKeyboardOverlap({ keyboardHeight: 317.6, imeFootprint: 0, bottomInset: NAV, rootHeight: ROOT_H, containerBottom: 708.6 }),
      ).toBe(0);
    });

    it('falls back to RN keyboardHeight when the native value is null', () => {
      expect(
        computeKeyboardOverlap({ keyboardHeight: FOLD_INNER.keyboardHeight, imeFootprint: null, bottomInset: NAV, rootHeight: ROOT_H, containerBottom: FOLD_INNER.containerBottom }),
      ).toBeCloseTo(computeKeyboardOverlap(FOLD_INNER), 6);
    });
  });
});
