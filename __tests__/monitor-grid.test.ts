/**
 * __tests__/monitor-grid.test.ts — the MONITOR wall's no-scroll grid fit:
 * every camera fits inside the measured wall, landscape walls get more
 * columns than portrait ones, the HUD shrinks before the picture does, and
 * a wall too small for any layout reports `fits: false` (scroll fallback).
 */
import {
  CARD_BORDER,
  CARD_INSET,
  CARD_PAD,
  GRID_GAP,
  HUD_GAP,
  MIN_CELL_W,
  MIN_SCREEN_H,
  SCREEN_ASPECT_TALL,
  SCREEN_ASPECT_WIDE,
  cellHeightFor,
  computeMonitorGrid,
  hudHeight,
  planMetaRow,
  type MonitorGrid,
} from '@/components/monitor/monitor-grid';

const inset = 2 * (CARD_PAD + CARD_BORDER);

/** The grid's cells, picture and HUD all stay inside the wall, and the cell
 *  is exactly its content (inset + picture + gap + HUD): nothing to centre,
 *  nothing to clip. */
function expectInside(g: MonitorGrid, w: number, h: number, n: number) {
  expect(g.fits).toBe(true);
  expect(g.cols * g.rows).toBeGreaterThanOrEqual(n);
  expect(g.cols * g.cellW + GRID_GAP * (g.cols - 1)).toBeLessThanOrEqual(w);
  expect(g.rows * g.cellH + GRID_GAP * (g.rows - 1)).toBeLessThanOrEqual(h);
  expect(g.cellW).toBeGreaterThanOrEqual(MIN_CELL_W);
  expect(g.screenW).toBeLessThanOrEqual(g.cellW - inset);
  expect(g.cellH).toBe(inset + g.screenH + HUD_GAP + hudHeight(g.hud));
  expect(g.cellH).toBe(cellHeightFor(g.screenH, g.hud));
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
    // Portrait: two columns of square pictures beat one column of 2:1 strips.
    ['portrait 800x1700', 800, 1700, 2, 3],
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

  it('narrow cells: no empty band — the picture gets taller, then the HUD richer, then the cell shorter', () => {
    // Z Fold6 cover screen (~334dp wide), 4 cameras in 2x2 cells ~165dp wide:
    // the picture is capped by the width, so the wall's share of height must
    // not be padded around it.
    const g = computeMonitorGrid(334, 484, 4);
    expect([g.cols, g.rows]).toEqual([2, 2]);
    expectInside(g, 334, 484, 4);
    expect(g.hud).toBe('full');
    // Square is the tallest the picture goes; the rest is returned to the wall.
    expect(g.screenW / g.screenH).toBeGreaterThanOrEqual(SCREEN_ASPECT_TALL - 0.02);
    const share = Math.floor((484 - GRID_GAP) / 2);
    expect(g.cellH).toBeLessThanOrEqual(share);
    expect(g.cellH).toBe(CARD_INSET + g.screenH + HUD_GAP + hudHeight('full'));
  });

  it('a width-capped picture upgrades the HUD before returning height to the wall', () => {
    // Tall, narrow cells: the picture is a square at most, so a short
    // "title" HUD would leave a band — the full HUD fits with the same picture.
    const g = computeMonitorGrid(130, 400, 1);
    expect(g.fits).toBe(true);
    expect(g.hud).toBe('full');
    expect(g.screenW / g.screenH).toBeGreaterThanOrEqual(SCREEN_ASPECT_TALL - 0.02);
    expect(g.cellH).toBe(cellHeightFor(g.screenH, 'full'));
  });

  it('keyboard up: a one-row strip is exactly its content, so the last row is whole or dropped', () => {
    // Unfolded pane with the IME open: 4 cameras on one ~95dp row.
    const g = computeMonitorGrid(720, 95, 4);
    expect([g.cols, g.rows]).toEqual([4, 1]);
    expectInside(g, 720, 95, 4);
    expect(g.cellH).toBeLessThanOrEqual(95);
    // The title + bar rows and the picture add up to the cell: nothing is cut.
    expect(g.cellH).toBe(CARD_INSET + g.screenH + HUD_GAP + hudHeight(g.hud));
  });

  it('falls back to a scrolling wall when no layout fits', () => {
    const tiny = computeMonitorGrid(300, 80, 8);
    expect(tiny.fits).toBe(false);
    expect(tiny.cols).toBeGreaterThanOrEqual(1);
    expect(tiny.cellW).toBeGreaterThanOrEqual(MIN_CELL_W);
    expect(computeMonitorGrid(0, 0, 5).fits).toBe(false);
  });
});

describe('planMetaRow', () => {
  // LOCAL chip · "Local LLM" · "42%" · "380 tok · ¥0"
  const kind = 'LOCAL';
  const provider = 'Local LLM';
  const pct = '42%';
  const cost = '380 tok · ¥0';

  it('shows everything when the row is wide enough', () => {
    expect(planMetaRow(300, kind, provider, pct, cost)).toEqual({ provider, showPct: true });
  });

  it('shortens the provider to its first word before dropping anything', () => {
    // Too narrow for "Local LLM" (~216dp), wide enough for "Local" (~190dp).
    expect(planMetaRow(200, kind, provider, pct, cost)).toEqual({ provider: 'Local', showPct: true });
  });

  it('drops the provider, then the %, and keeps the tokens / cost last', () => {
    // ~151dp fits chip + % + cost; ~125dp fits chip + cost only.
    expect(planMetaRow(165, kind, provider, pct, cost)).toEqual({ provider: null, showPct: true });
    expect(planMetaRow(140, kind, provider, pct, cost)).toEqual({ provider: null, showPct: false });
  });

  it('a one-word provider is dropped, never cut to an ellipsis', () => {
    const plan = planMetaRow(200, 'API', 'Perplexity', pct, '$0.0021 · 1.2k tok');
    expect(plan.provider).toBeNull();
    expect(plan.showPct).toBe(true);
  });
});
