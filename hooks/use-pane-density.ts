/**
 * hooks/use-pane-density.ts — shared pane density / reflow math.
 *
 * Wave F (Case 2) of the layout overhaul. Each pane component previously
 * hand-rolled its own `paneWidth < X` breakpoints, which meant the
 * TerminalPane, MarkdownPane and AIPane all drifted out of sync and
 * needed fixing three times whenever the grid layout shipped a new
 * density. This hook centralises the rules so every pane reflows in
 * lockstep.
 *
 * Density tiers (width-driven):
 *   width  < 260dp  → 'compact'   (2×2 on a phone in landscape)
 *   width  < 360dp  → 'normal'    (1+2 or 3-pane column)
 *   width  < 480dp  → 'normal'    (dense half-screen on Fold inner)
 *   width >= 480dp  → 'wide'      (single pane / unfolded)
 *
 * Char metrics default to JetBrains Mono at ~14sp which is what the
 * Terminal uses. Callers that know the real glyph size (the native
 * terminal view measures this) can pass their own metrics to get a
 * more accurate cols/rows estimate.
 */

export type PaneDensity = 'compact' | 'normal' | 'wide';

export interface CharMetrics {
  width: number;
  height: number;
}

export interface PaneLayout {
  density: PaneDensity;
  fontSize: number;
  padding: number;
  maxBubbleWidth: number;
  proseMaxWidth: number;
  cols: number;
  rows: number;
}

export interface PaneLayoutOptions {
  /** Base font size before density scaling (defaults to 14). */
  baseFontSize?: number;
  /** Char metrics for terminal cols/rows estimation. */
  charMetrics?: CharMetrics;
}

const DEFAULT_CHAR: CharMetrics = { width: 8.4, height: 16 };

export function getPaneDensity(paneWidth: number): PaneDensity {
  if (paneWidth <= 0) return 'wide';
  if (paneWidth < 260) return 'compact';
  if (paneWidth < 480) return 'normal';
  return 'wide';
}

/**
 * Compute a PaneLayout from a pane's measured width / height.
 *
 * This is a pure function so it is cheap to call in render; no memo
 * wrapping is needed on the call site unless profiling says otherwise.
 */
export function usePaneLayout(
  paneWidth: number,
  paneHeight: number,
  options: PaneLayoutOptions = {},
): PaneLayout {
  const base = options.baseFontSize ?? 14;
  const char = options.charMetrics ?? DEFAULT_CHAR;
  const density = getPaneDensity(paneWidth);

  // Font shrink ladder. Mirrors the existing Wave E ladder in
  // TerminalPane / MarkdownPane / AIPane so behaviour is unchanged for
  // existing call sites that port to this hook.
  let fontSize = base;
  let padding = 12;
  if (paneWidth > 0) {
    if (paneWidth < 260) {
      fontSize = Math.max(9, base - 3);
      padding = 4;
    } else if (paneWidth < 360) {
      fontSize = Math.max(10, base - 2);
      padding = 6;
    } else if (paneWidth < 480) {
      fontSize = Math.max(10, base - 1);
      padding = 10;
    }
  }

  const innerWidth = Math.max(paneWidth - padding * 2, 160);
  const proseMaxWidth = innerWidth;
  const maxBubbleWidth = Math.max(Math.floor(paneWidth * 0.85), 180);

  const cols = paneWidth > 0 && char.width > 0
    ? Math.max(20, Math.floor(innerWidth / char.width))
    : 80;
  const rows = paneHeight > 0 && char.height > 0
    ? Math.max(8, Math.floor(paneHeight / char.height))
    : 24;

  return {
    density,
    fontSize,
    padding,
    maxBubbleWidth,
    proseMaxWidth,
    cols,
    rows,
  };
}
