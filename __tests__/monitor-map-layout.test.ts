/**
 * __tests__/monitor-map-layout.test.ts — MAP geometry
 * (components/monitor/monitor-map-layout.ts): the RESULT box never rises
 * into the lane-caption band (on-device 2026-10-31: its dashed top border
 * clipped the lower half of "RESULT"), and the canvas still contains it.
 */
import { GOAL_H, LANE_H, NODE_H, PAD, layoutMonitorMap, rowY } from '../components/monitor/monitor-map-layout';
import type { MonitorTeam } from '../lib/monitor-team';

function team(columns: string[][], subAgents: { id: string; parentId: string }[] = []): MonitorTeam {
  const node = (id: string) => ({ id, name: id, role: id, provider: 'auto' as const, askBeforeWrite: false });
  return {
    title: 't',
    columns: columns.map((col) => col.map(node)),
    subAgents: subAgents.map((s) => ({ ...node(s.id), parentId: s.parentId })),
  } as unknown as MonitorTeam;
}

describe('layoutMonitorMap', () => {
  it('keeps the RESULT box below the caption band (never above the first node row)', () => {
    const geo = layoutMonitorMap(team([['a'], ['b'], ['c']]));
    // Centred on a 76 dp node, a 104 dp box would start 14 dp above rowY(0),
    // i.e. inside the LANE_H band where "RESULT" is drawn.
    expect(NODE_H / 2 - GOAL_H / 2).toBeLessThan(0);
    expect(geo.goalY).toBe(rowY(0));
    expect(geo.goalY).toBeGreaterThanOrEqual(PAD + LANE_H);
    expect(geo.height).toBeGreaterThanOrEqual(geo.goalY + GOAL_H + PAD);
  });

  it('a last column with several rows still centres on its first node when that is lower', () => {
    const geo = layoutMonitorMap(team([['a'], ['b', 'c']]));
    // First node of the last column is at rowY(0): same clamp applies.
    expect(geo.goalY).toBe(rowY(0));
    expect(geo.placed.c.y).toBe(rowY(1));
    expect(geo.placed.c.sub).toBe(false);
  });

  it('sub-agents sit under their parent column and extend the canvas', () => {
    const geo = layoutMonitorMap(team([['a'], ['b']], [{ id: 's', parentId: 'a' }]));
    expect(geo.placed.s).toMatchObject({ column: 0, sub: true, y: rowY(1) });
    expect(geo.height).toBeGreaterThanOrEqual(rowY(2) + PAD);
  });

  it('no columns: RESULT at the first row', () => {
    expect(layoutMonitorMap(team([])).goalY).toBe(rowY(0));
  });
});
