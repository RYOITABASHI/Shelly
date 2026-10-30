/**
 * lib/monitor-widget-link.ts — `shelly://monitor` deep links from the MONITOR
 * home-screen widget (modules/terminal-emulator/.../monitor/MonitorWidgetRenderer.kt):
 *
 *   shelly://monitor                         open the MONITOR pane (LIVE)
 *   shelly://monitor?agentId=<id>            … LIVE on that agent's run, camera grid
 *   shelly://monitor?agentId=<id>&step=<n>   … single view on that agent's channel n+1
 *
 * Pure apart from the injected pane/store calls, so app/_layout.tsx wires the
 * real ones and the tests pass fakes. A malformed parameter is ignored (the
 * pane still opens); it can never select something the pane would not.
 */

const SAFE_AGENT_ID = /^[A-Za-z0-9_-]+$/;
const MAX_STEP = 999;

export interface MonitorWidgetLink {
  agentId: string | null;
  step: number | null;
}

type QueryParams = Record<string, string | string[] | undefined> | null | undefined;

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function parseMonitorWidgetLink(queryParams: QueryParams): MonitorWidgetLink {
  const rawAgent = first(queryParams?.agentId);
  const agentId = typeof rawAgent === 'string' && rawAgent.length <= 128 && SAFE_AGENT_ID.test(rawAgent) ? rawAgent : null;
  const rawStep = first(queryParams?.step);
  const stepNum = typeof rawStep === 'string' && /^\d{1,3}$/.test(rawStep) ? Number(rawStep) : NaN;
  // A channel only means something for a known agent.
  const step = agentId !== null && Number.isInteger(stepNum) && stepNum >= 0 && stepNum <= MAX_STEP ? stepNum : null;
  return { agentId, step };
}

/** The MONITOR pane state a link asks for (subset of agent-store MonitorPaneState). */
export interface MonitorLinkPatch {
  sourceMode?: 'live';
  liveAgentId?: string;
  view: 'grid' | 'single';
  selectedId?: string;
  auto: false;
}

/** Live camera ids are `s<stepIndex>` (lib/monitor-live.ts liveDefId). */
export function monitorLinkPatch(link: MonitorWidgetLink): MonitorLinkPatch {
  if (link.agentId === null) return { view: 'grid', auto: false };
  const base = { sourceMode: 'live' as const, liveAgentId: link.agentId, auto: false as const };
  return link.step === null ? { ...base, view: 'grid' } : { ...base, view: 'single', selectedId: `s${link.step}` };
}

export interface MonitorLinkDeps {
  /** Focus (or add / repurpose) the MONITOR pane; false when none could be shown. */
  showMonitorPane: () => boolean;
  setMonitor: (patch: MonitorLinkPatch) => void;
}

/** Opens the MONITOR pane for a widget tap. Returns false when no pane could be shown. */
export function openMonitorFromWidgetLink(queryParams: QueryParams, deps: MonitorLinkDeps): boolean {
  const link = parseMonitorWidgetLink(queryParams);
  // Select first so the pane's first render already shows the right channel.
  deps.setMonitor(monitorLinkPatch(link));
  return deps.showMonitorPane();
}

// ─── Fallback when no pane slot is free (e.g. one terminal on the cover screen) ──
//
// The previous tab is kept ON THE SLOT (`returnTab`, persisted with the
// multi-pane layout), so BACK survives an app restart and goes away by
// itself as soon as the slot's tab is changed any other way.

export interface SlotLike {
  id: string;
  tab: string;
  /** Tab to go back to; set only while a widget tap borrowed the slot for MONITOR. */
  returnTab?: string;
}

export interface SlotOps {
  getSlots: () => readonly (SlotLike | null | undefined)[];
  getFocusedSlot: () => number;
  /** Change the tab; `returnTab` set = remember it for BACK, null/omitted = forget. */
  setSlotTab: (index: number, tab: string, returnTab?: string | null) => void;
  focusSlot: (index: number) => void;
}

/** Slot to turn into MONITOR: the focused one, else the first occupied one. */
export function pickSwapSlot(slots: readonly (SlotLike | null | undefined)[], focused: number): number | null {
  if (slots[focused]) return focused;
  const i = slots.findIndex((s) => !!s);
  return i >= 0 ? i : null;
}

/**
 * Temporarily show MONITOR in an occupied slot (the slot keeps its id and
 * terminal session; only its tab changes) and remember what it was, so the
 * MONITOR pane can offer BACK. Returns false when there is no slot at all.
 */
export function swapSlotToMonitor(ops: SlotOps): boolean {
  const slots = ops.getSlots();
  const index = pickSwapSlot(slots, ops.getFocusedSlot());
  if (index === null) return false;
  const slot = slots[index]!;
  if (slot.tab !== 'monitor') ops.setSlotTab(index, 'monitor', slot.tab);
  ops.focusSlot(index);
  return true;
}

/** Index of the slot a widget tap borrowed for MONITOR, or -1. */
export function borrowedMonitorSlot(slots: readonly (SlotLike | null | undefined)[]): number {
  return slots.findIndex((s) => !!s && s.tab === 'monitor' && !!s.returnTab);
}

/** Whether the MONITOR pane should offer BACK. */
export function canReturnFromMonitor(slots: readonly (SlotLike | null | undefined)[]): boolean {
  return borrowedMonitorSlot(slots) >= 0;
}

/** Put the borrowed slot back to its previous tab. */
export function restoreFromMonitor(ops: SlotOps): boolean {
  const slots = ops.getSlots();
  const index = borrowedMonitorSlot(slots);
  if (index < 0) return false;
  ops.setSlotTab(index, slots[index]!.returnTab!, null);
  ops.focusSlot(index);
  return true;
}
