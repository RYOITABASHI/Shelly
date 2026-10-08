/**
 * Soft-keyboard inset math for the pane grid (MultiPaneContainer).
 *
 * Shelly targets SDK 36, so the activity is forced edge-to-edge and
 * `adjustResize` does NOT shrink the React root: the IME simply overlays the
 * bottom of the window. The pane grid therefore has to reserve exactly the
 * part of itself that the keyboard covers — no more (empty band between the
 * panes and the keyboard) and no less (key bar / composer hidden under the
 * IME).
 *
 * Coordinate spaces are the trap here (both bit us on the Z Fold6):
 *  - `Dimensions.get('screen')` can report the *other* panel after a fold
 *    transition (cover 2376px instead of inner 2160px) -> ~95dp gap.
 *  - `Keyboard` `endCoordinates.screenY` is in screen coordinates, while
 *    `measureInWindow` is relative to the *visible display frame top* (i.e.
 *    below the status bar, RootViewUtil.getViewportOffset) -> mixing them
 *    under-reserved by the status-bar height (94px / 32.4dp) and the key bar
 *    slid under the IME.
 *
 * So everything here is expressed as distances from the bottom of the React
 * root, which is the app window under edge-to-edge:
 *  - the IME footprint from the window bottom is the WindowInsets ime bottom,
 *    which RN reports as `height = ime.bottom - systemBars.bottom`; adding the
 *    bottom safe-area inset (systemBars.bottom) gives ime.bottom back;
 *  - the container's distance from the root bottom comes from `measure`
 *    (pageY is root-relative, no viewport offset) and the SafeAreaProvider
 *    frame height (the root size).
 * If the OS ever does resize the root for the IME (adjustResize honoured),
 * the IME inset is still measured from the *window* bottom, so the caller
 * passes how much the root shrank versus its keyboard-free height
 * (`rootShrink`); the footprint below the root is reduced by that amount and
 * the overlap becomes 0 once the root bottom sits at the IME top.
 */

/** Extra dp reserved above the IME so content can never end under it. */
export const KEYBOARD_SAFETY_MARGIN = 2;

export interface KeyboardOverlapInput {
  /** Keyboard height (dp) as reported by RN: ime.bottom - systemBars.bottom. */
  keyboardHeight: number | null | undefined;
  /**
   * Real IME window inset from the window bottom (dp) — WindowInsets ime
   * bottom from the native ImeInsetsWatcher, which already includes the
   * navigation-bar area. When given (non-null) it takes precedence over
   * keyboardHeight + bottomInset, because RN's Keyboard height is only
   * sampled when IME visibility flips and goes stale when the IME grows its
   * inset afterwards (an IME toolbar row added after showing: 317.6dp reported vs 388.6dp real).
   */
  imeFootprint?: number | null;
  /** Bottom system-bar / safe-area inset (dp). */
  bottomInset?: number;
  /** Container bottom edge relative to the React root (dp): measure() pageY + height. */
  containerBottom: number | null;
  /** React root height (dp), e.g. SafeAreaProvider frame y + height. */
  rootHeight: number | null;
  /**
   * How much the root is shorter than its keyboard-free height (dp) because
   * the OS resized the window for the IME. 0 / omitted under edge-to-edge.
   */
  rootShrink?: number;
  /** Safety margin (dp), defaults to KEYBOARD_SAFETY_MARGIN. */
  margin?: number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * How many dp at the bottom of the pane container the soft keyboard covers
 * (plus a small safety margin).
 *
 * - Keyboard hidden / zero height (incl. hardware keyboards): 0.
 * - Container + root measured: footprint - (rootHeight - containerBottom) + margin,
 *   clamped to [0, footprint].
 * - Not measured yet: the reported keyboard height (RN already excludes the
 *   navigation bar from it) plus the margin.
 */
export function computeKeyboardOverlap(input: KeyboardOverlapInput): number {
  const bottomInset = finite(input.bottomInset) ? Math.max(0, input.bottomInset) : 0;
  const useNative = finite(input.imeFootprint);
  const height = useNative
    ? Math.max(0, (input.imeFootprint as number) - bottomInset)
    : finite(input.keyboardHeight) ? Math.max(0, input.keyboardHeight) : 0;
  const rawFootprint = useNative
    ? Math.max(0, input.imeFootprint as number)
    : height + bottomInset;
  if (rawFootprint <= 0 || (!useNative && height <= 0)) return 0;
  const margin = finite(input.margin) ? Math.max(0, input.margin) : KEYBOARD_SAFETY_MARGIN;
  const shrink = finite(input.rootShrink) ? Math.max(0, input.rootShrink) : 0;
  // IME top's distance from the window bottom, re-based onto the root bottom.
  const footprint = Math.max(0, rawFootprint - shrink);
  if (footprint <= 0) return 0;

  const { containerBottom, rootHeight } = input;
  if (finite(containerBottom) && finite(rootHeight) && containerBottom > 0 && rootHeight > 0) {
    const distanceBelowContainer = Math.max(0, rootHeight - containerBottom);
    const overlap = footprint - distanceBelowContainer;
    if (overlap <= 0) return 0;
    return Math.min(footprint, overlap + margin);
  }
  return Math.min(footprint, Math.max(0, height - shrink) + margin);
}
