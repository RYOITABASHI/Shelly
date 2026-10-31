/**
 * components/monitor/monitor-map-layout.ts — pure geometry of the MONITOR
 * MAP (wiring) view: column / row positions of the nodes, the RESULT box and
 * the canvas size. Extracted from MonitorMap.tsx so it is unit-testable
 * without React Native.
 *
 * Vertical structure of the canvas:
 *   PAD            top padding
 *   LANE_H         the lane captions ("STEP 1", "3 IN PARALLEL", "RESULT")
 *   rowY(0) …      node rows (NODE_H high, ROW_GAP apart)
 * The RESULT box is centred on the last column's first node, but never
 * above rowY(0): on-device (2026-10-31, build 2717) the box's dashed top
 * border sat inside the caption band and clipped the lower half of the
 * "RESULT" caption, because a 104 dp box centred on a 76 dp node starts
 * 14 dp above the node row.
 */
import type { MonitorTeam, MonitorTeamNode } from '@/lib/monitor-team';

export const COL_W = 156;
export const GAP = 40;
export const NODE_H = 76;
export const ROW_GAP = 12;
export const PAD = 14;
export const LANE_H = 24;
export const GOAL_H = 104;

export const colX = (c: number) => PAD + c * (COL_W + GAP);
export const rowY = (r: number) => PAD + LANE_H + r * (NODE_H + ROW_GAP);

export type Placed = { node: MonitorTeamNode; x: number; y: number; column: number; sub: boolean };

export interface MapGeometry {
  placed: Record<string, Placed>;
  goalX: number;
  goalY: number;
  width: number;
  height: number;
}

export function layoutMonitorMap(team: MonitorTeam): MapGeometry {
  const placed: Record<string, Placed> = {};
  let maxRows = 1;
  team.columns.forEach((col, c) => {
    col.forEach((node, r) => {
      placed[node.id] = { node, x: colX(c), y: rowY(r), column: c, sub: false };
    });
    const subs = team.subAgents.filter((s) => col.some((n) => n.id === s.parentId));
    subs.forEach((s, j) => {
      placed[s.id] = { node: s, x: colX(c), y: rowY(col.length + j), column: c, sub: true };
    });
    maxRows = Math.max(maxRows, col.length + subs.length);
  });
  const last = team.columns[team.columns.length - 1]?.[0];
  const goalX = colX(team.columns.length);
  // Centred on the last node, but never into the caption band above rowY(0).
  const goalY = last ? Math.max(rowY(0), placed[last.id].y + NODE_H / 2 - GOAL_H / 2) : rowY(0);
  const height = Math.max(rowY(maxRows) + PAD, goalY + GOAL_H + PAD);
  const width = goalX + COL_W + PAD;
  return { placed, goalX, goalY, width, height };
}
