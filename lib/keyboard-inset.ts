/**
 * Soft-keyboard inset math for the pane grid (MultiPaneContainer).
 *
 * Shelly targets SDK 36, so the activity is forced edge-to-edge and
 * `adjustResize` does NOT shrink the React root: the IME simply overlays the
 * bottom of the window. The pane grid therefore has to reserve exactly the
 * part of itself that the keyboard covers — no more (empty band between the
 * panes and the keyboard) and no less (key bar hidden under the IME).
 *
 * The only numbers that are reliable on every display (including the Z Fold6,
 * where `Dimensions.get('screen')` can report the *other* panel's height after
 * a fold transition) are:
 *   - the keyboard's top edge, `endCoordinates.screenY` (RN derives it from
 *     getWindowVisibleDisplayFrame().bottom), and
 *   - the container's own bottom edge in window coordinates, from
 *     `measureInWindow`.
 * The overlap between those two is the inset. If the OS ever does resize the
 * window for the IME, the container bottom already sits above the keyboard
 * top and the overlap is naturally 0 — no "did it resize?" heuristic needed.
 */

export interface KeyboardOverlapInput {
  /** Container bottom edge in window coordinates (dp), or null if not measured yet. */
  containerBottom: number | null;
  /** Keyboard top edge (dp), i.e. Keyboard endCoordinates.screenY. */
  keyboardTop: number | null | undefined;
  /** Keyboard height (dp) as reported by RN (IME inset minus system-bar inset). */
  keyboardHeight: number | null | undefined;
  /** Bottom system-bar / safe-area inset (dp). */
  bottomInset?: number;
}

/**
 * How many dp of the pane container the soft keyboard covers.
 *
 * - Keyboard hidden / zero height (incl. hardware keyboards): 0.
 * - Container measured + keyboard top known: max(0, containerBottom - keyboardTop),
 *   capped at the keyboard's full footprint (height + bottom inset) so a bogus
 *   coordinate can never reserve more than the keyboard itself occupies.
 * - Container not measured yet: fall back to the reported keyboard height
 *   (RN already excludes the navigation bar from it).
 */
export function computeKeyboardOverlap(input: KeyboardOverlapInput): number {
  const height = Number.isFinite(input.keyboardHeight) ? Math.max(0, input.keyboardHeight as number) : 0;
  if (height <= 0) return 0;
  const bottomInset = Number.isFinite(input.bottomInset) ? Math.max(0, input.bottomInset as number) : 0;
  const cap = height + bottomInset;

  const { containerBottom, keyboardTop } = input;
  if (
    typeof containerBottom === 'number' && Number.isFinite(containerBottom) && containerBottom > 0 &&
    typeof keyboardTop === 'number' && Number.isFinite(keyboardTop) && keyboardTop > 0
  ) {
    const overlap = containerBottom - keyboardTop;
    return Math.min(cap, Math.max(0, overlap));
  }
  return height;
}
