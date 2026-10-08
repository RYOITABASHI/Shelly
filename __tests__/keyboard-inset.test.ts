import { computeKeyboardOverlap } from '@/lib/keyboard-inset';

// Numbers below are the real build-2482 values from the unfolded Z Fold6
// (1856x2160 px @ density 464 => 640x744.8 dp, nav inset 15.17 dp):
//   keyboardDidShow endCoordinates = { screenY: 356.2, height: 373.4 }
//   pane container bottom ~= 744.8 - 15.17 (nav) - 18 (ContextBar) - 3 (gutter)
const FOLD_INNER = {
  keyboardTop: 356.2069,
  keyboardHeight: 373.4483,
  bottomInset: 15.1724,
  containerBottom: 744.8276 - 15.1724 - 18 - 3,
};

describe('computeKeyboardOverlap', () => {
  it('returns 0 when the keyboard is hidden', () => {
    expect(computeKeyboardOverlap({ containerBottom: 700, keyboardTop: 356, keyboardHeight: 0 })).toBe(0);
    expect(computeKeyboardOverlap({ containerBottom: 700, keyboardTop: null, keyboardHeight: null })).toBe(0);
    expect(computeKeyboardOverlap({ containerBottom: 700, keyboardTop: undefined, keyboardHeight: undefined })).toBe(0);
  });

  it('reserves exactly the covered part of the container (Fold6 inner, edge-to-edge, no window resize)', () => {
    const overlap = computeKeyboardOverlap(FOLD_INNER);
    // The grid bottom must land exactly on the IME top: no gap, no overlap.
    expect(FOLD_INNER.containerBottom - overlap).toBeCloseTo(FOLD_INNER.keyboardTop, 5);
    // Regression guard: the old screen-height heuristic reserved ~448 dp vs a ~352 dp overlap
    // here (Dimensions 'screen' reported the 2376px cover panel), leaving a
    // ~95.5 dp (~277 px) empty band above the keyboard, matching the on-device screenshot.
    expect(overlap).toBeLessThan(FOLD_INNER.keyboardHeight);
  });

  it('returns 0 when the OS already resized the window above the keyboard (adjustResize honoured)', () => {
    expect(
      computeKeyboardOverlap({ containerBottom: 340, keyboardTop: 356.2, keyboardHeight: 373.4, bottomInset: 15.2 }),
    ).toBe(0);
  });

  it('handles the compact cover screen (container ends right at the nav inset)', () => {
    // Cover: 333.8 x 819.3 dp, keyboard top at 452.07, height 352.07.
    const overlap = computeKeyboardOverlap({
      containerBottom: 819.3 - 15.17 - 24,
      keyboardTop: 452.07,
      keyboardHeight: 352.07,
      bottomInset: 15.17,
    });
    expect(819.3 - 15.17 - 24 - overlap).toBeCloseTo(452.07, 5);
  });

  it('caps a bogus keyboard top to the keyboard footprint', () => {
    expect(
      computeKeyboardOverlap({ containerBottom: 700, keyboardTop: 1, keyboardHeight: 300, bottomInset: 15 }),
    ).toBe(315);
  });

  it('falls back to the reported keyboard height before the container is measured', () => {
    expect(computeKeyboardOverlap({ containerBottom: null, keyboardTop: 356.2, keyboardHeight: 373.4 })).toBe(373.4);
  });
});
