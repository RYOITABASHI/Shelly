/**
 * components/monitor/monitor-grid.ts — fit the MONITOR wall's camera grid
 * inside the pane with no scrolling (portrait or landscape, any pane size).
 *
 * Pure: given the wall's measured width / height and the camera count, try
 * every column count, give each cell the room it gets, shrink the HUD under
 * the camera before the picture (drop the timer / last-output row first,
 * then the provider row), and pick the layout whose camera picture is
 * largest. When even the smallest layout cannot fit, `fits` is false and the
 * pane falls back to a scrolling wall so nothing becomes unreachable.
 *
 * The HUD heights below match the fit styles in MonitorCamera.tsx (explicit
 * line heights), so the computed cell is exactly what renders.
 */

/** Gap between cells (dp). */
export const GRID_GAP = 8;
/** Card padding + border, per side. */
export const CARD_PAD = 6;
export const CARD_BORDER = 1;
/** Vertical gap between the picture and the HUD rows, and between rows. */
export const HUD_GAP = 3;
/** Row heights (line heights) of the fitted HUD. */
export const HUD_TITLE_H = 18;
export const HUD_META_H = 14;
export const HUD_BAR_H = 5;
export const HUD_TICK_H = 14;
/** Smallest usable cell width and camera picture height. */
export const MIN_CELL_W = 120;
export const MIN_SCREEN_H = 44;
/** Picture aspect range (w / h). The overlays are authored on a 3:2 canvas
 *  and stay inside the frame anywhere between these. */
export const SCREEN_ASPECT_TALL = 1.2;
export const SCREEN_ASPECT_WIDE = 2;
/** Below this cell width the HUD uses the compact text sizes. */
export const COMPACT_TEXT_W = 220;

/**
 * HUD detail under the camera, richest first:
 *  - full:  title · provider/% /tokens/cost · bar · timer + last output
 *  - brief: title · provider/% /tokens/cost · bar
 *  - title: title · bar
 */
export type MonitorHudLevel = 'full' | 'brief' | 'title';
const HUD_LEVELS: readonly MonitorHudLevel[] = ['full', 'brief', 'title'];

export function hudHeight(level: MonitorHudLevel): number {
  switch (level) {
    case 'full':
      return HUD_TITLE_H + HUD_META_H + HUD_BAR_H + HUD_TICK_H + HUD_GAP * 3;
    case 'brief':
      return HUD_TITLE_H + HUD_META_H + HUD_BAR_H + HUD_GAP * 2;
    case 'title':
      return HUD_TITLE_H + HUD_BAR_H + HUD_GAP;
  }
}

export interface MonitorGrid {
  /** False: no layout fits; the wall scrolls with cells at their natural size. */
  fits: boolean;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  /** Camera picture box inside the cell. */
  screenW: number;
  screenH: number;
  hud: MonitorHudLevel;
  compactText: boolean;
  /** Cells left empty in the last row (room for a NO SIGNAL tile). */
  freeCells: number;
}

/** Largest picture with an aspect in [TALL, WIDE] inside (w, h). */
function pictureBox(w: number, h: number): { w: number; h: number } {
  if (w <= 0 || h <= 0) return { w: 0, h: 0 };
  if (w / h > SCREEN_ASPECT_WIDE) return { w: h * SCREEN_ASPECT_WIDE, h };
  if (w / h < SCREEN_ASPECT_TALL) return { w, h: w / SCREEN_ASPECT_TALL };
  return { w, h };
}

const floor = (n: number) => Math.max(0, Math.floor(n));

export function computeMonitorGrid(width: number, height: number, count: number, gap = GRID_GAP): MonitorGrid {
  const n = Math.max(1, Math.floor(count));
  const inset = 2 * (CARD_PAD + CARD_BORDER);
  let best: (MonitorGrid & { score: number }) | null = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    // A column count that leaves a whole row empty is never better.
    if (cols > 1 && Math.ceil(n / (cols - 1)) === rows) continue;
    const cellW = floor((width - gap * (cols - 1)) / cols);
    const cellH = floor((height - gap * (rows - 1)) / rows);
    if (cellW < MIN_CELL_W) break;
    const innerW = cellW - inset;
    const innerH = cellH - inset;
    let pick: { level: MonitorHudLevel; w: number; h: number } | null = null;
    for (const level of HUD_LEVELS) {
      const room = innerH - hudHeight(level) - HUD_GAP;
      const last = level === 'title';
      // Keep the picture at least half the cell before trading HUD rows away.
      if (room < MIN_SCREEN_H || (!last && room < innerH * 0.5)) continue;
      const box = pictureBox(innerW, room);
      if (box.h < MIN_SCREEN_H) continue;
      pick = { level, ...box };
      break;
    }
    if (!pick) continue;
    // Bigger picture wins; within ~3% prefer the richer HUD, then fewer
    // empty cells.
    const levelBonus = pick.level === 'full' ? 1.03 : pick.level === 'brief' ? 1.015 : 1;
    const score = pick.w * pick.h * levelBonus - (cols * rows - n) * 0.001;
    if (!best || score > best.score) {
      best = {
        score,
        fits: true,
        cols,
        rows,
        cellW,
        cellH,
        screenW: floor(pick.w),
        screenH: floor(pick.h),
        hud: pick.level,
        compactText: cellW < COMPACT_TEXT_W,
        freeCells: cols * rows - n,
      };
    }
  }
  if (best) {
    const { score: _score, ...grid } = best;
    return grid;
  }
  // Nothing fits: as many minimum-width columns as the width allows; the
  // wall scrolls and each camera keeps its natural height.
  const cols = Math.max(1, Math.min(n, Math.floor((width + gap) / (MIN_CELL_W + gap))));
  const rows = Math.ceil(n / cols);
  const cellW = floor((width - gap * (cols - 1)) / cols);
  return {
    fits: false,
    cols,
    rows,
    cellW,
    cellH: 0,
    screenW: 0,
    screenH: 0,
    hud: 'full',
    compactText: true,
    freeCells: cols * rows - n,
  };
}
