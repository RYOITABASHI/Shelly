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
});
