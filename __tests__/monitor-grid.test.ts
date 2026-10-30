/**
 * __tests__/monitor-grid.test.ts — the MONITOR wall's no-scroll grid fit:
 * every camera fits inside the measured wall, landscape walls get more
 * columns than portrait ones, the HUD shrinks before the picture does, and
 * a wall too small for any layout reports `fits: false` (scroll fallback).
 */
import {
  CARD_BORDER,
  CARD_PAD,
  GRID_GAP,
  HUD_GAP,
  MIN_CELL_W,
  MIN_SCREEN_H,
  SCREEN_ASPECT_TALL,
  SCREEN_ASPECT_WIDE,
  computeMonitorGrid,
  hudHeight,
  type MonitorGrid,
} from '@/components/monitor/monitor-grid';

const inset = 2 * (CARD_PAD + CARD_BORDER);

/** The grid's cells, picture and HUD all stay inside the wall. */
function expectInside(g: MonitorGrid, w: number, h: number, n: number) {
  expect(g.fits).toBe(true);
  expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
  expect(g.cols * g.cellW + GRID_GAP * (g.cols - 1)).toBeLessThanOrEqual(w);
  expect(g.rows * g.cellH + GRID_GAP * (g.rows - 1)).toBeLessThanOrEqual(h);
  expect(g.cellW).toBeGreaterThanOrEqual(MIN_CELL_W);
  expect(g.screenW).toBeLessThanOrEqual(g.cellW - inset);
  expect(g.screenH + HUD_GAP + hudHeight(g.hud)).toBeLessThanOrEqual(g.cellH - inset);
  expect(g.screenH).toBeGreaterThanOrEqual(MIN_SCREEN_H);
  const aspect = g.screenW / g.screenH;
  expect(aspect).toBeGreaterThanOrEqual(SCREEN_ASPECT_TALL - 0.02);
  expect(aspect).toBeLessThanOrEqual(SCREEN_ASPECT_WIDE + 0.02);
  expect(g.freeCells).toBe(g.cols * g.rows - n);
}

describe('computeMonitorGrid', () => {
  const cases: [string, number, number, number, number][] = [
    // name, width, height, expected cols, expected rows (5 cameras)
    ['full pane 1720x1700', 1720, 1700, 2, 3],
    ['half-height pane 1720x800', 1720, 800, 3, 2],
    ['portrait 800x1700', 800, 1700, 1, 5],
    ['cover 380x700', 380, 700, 2, 3],
    ['Fold6 full pane in dp 760x640', 760, 640, 3, 2],
    ['Fold6 half pane in dp 760x300', 760, 300, 5, 1],
  ];
  it.each(cases)('%s fits all 5 cameras as %ix? (cols/rows)', (_name, w, h, cols, rows) => {
    const g = computeMonitorGrid(w, h, 5);
    expectInside(g, w, h, 5);
    expect([g.cols, g.rows]).toEqual([cols, rows]);
  });

  it('fits every count 1..8 on common pane sizes', () => {
    for (const [w, h] of [
      [1720, 1700],
      [1720, 800],
      [800, 1700],
      [380, 700],
      [760, 640],
      [340, 520],
    ]) {
      for (let n = 1; n <= 8; n++) expectInside(computeMonitorGrid(w, h, n), w, h, n);
    }
  });

  it('gives a landscape wall more columns than a portrait wall', () => {
    const land = computeMonitorGrid(1600, 700, 6);
    const port = computeMonitorGrid(700, 1600, 6);
    expect(land.cols).toBeGreaterThan(port.cols);
    expect(port.rows).toBeGreaterThan(land.rows);
  });

  it('picks the layout with the largest picture', () => {
    const g = computeMonitorGrid(1720, 800, 5);
    for (let cols = 1; cols <= 5; cols++) {
      const rows = Math.ceil(5 / cols);
      const cellW = (1720 - GRID_GAP * (cols - 1)) / cols;
      const cellH = (800 - GRID_GAP * (rows - 1)) / rows;
      // An upper bound for any other layout's picture area (full HUD).
      const room = cellH - inset - HUD_GAP - hudHeight('full');
      const w = Math.min(cellW - inset, room * SCREEN_ASPECT_WIDE);
      const h = Math.min(room, w / SCREEN_ASPECT_TALL);
      if (room > 0) expect(g.screenW * g.screenH * 1.04).toBeGreaterThanOrEqual(w * h * 0.97);
    }
  });

  it('drops HUD rows (timer / last output first) before shrinking the picture away', () => {
    // A short wide strip: cells too short for the full HUD.
    const g = computeMonitorGrid(900, 120, 3);
    expect(g.fits).toBe(true);
    expect(g.hud).not.toBe('full');
    expectInside(g, 900, 120, 3);
    // A roomy wall keeps the full HUD.
    expect(computeMonitorGrid(1200, 1000, 3).hud).toBe('full');
  });

  it('uses compact text on narrow cells', () => {
    expect(computeMonitorGrid(380, 700, 5).compactText).toBe(true);
    expect(computeMonitorGrid(1720, 1700, 5).compactText).toBe(false);
  });

  it('reports a free cell only when the chosen grid has one', () => {
    expect(computeMonitorGrid(1720, 800, 6).freeCells).toBe(0);
    expect(computeMonitorGrid(1720, 800, 5).freeCells).toBe(1);
  });

  it('falls back to a scrolling wall when no layout fits', () => {
    const tiny = computeMonitorGrid(300, 80, 8);
    expect(tiny.fits).toBe(false);
    expect(tiny.cols).toBeGreaterThanOrEqual(1);
    expect(tiny.cellW).toBeGreaterThanOrEqual(MIN_CELL_W);
    expect(computeMonitorGrid(0, 0, 5).fits).toBe(false);
  });
});
