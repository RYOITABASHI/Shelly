// hooks/use-multi-pane.ts
//
// v0.1.1 — Preset-based multi-pane store.
//
// The old arbitrary-tree implementation (PaneSplit + PaneLeaf recursion) is
// gone. It was flexible but triggered bugs #29 / #30 / #31 in v0.1.0 because:
//  - splitPane re-minted leaf ids, wiping PTY/WebView/AI native state
//  - N-1 dividers with negative-margin hit areas failed Yoga hit-testing
//  - worklet closures reached Zustand setters across the UI-thread boundary
//
// The new model is a flat `slots[4]` + a preset id. At most 4 panes, at
// most 2 dividers, and leaf ids are never rewritten after they are minted.
// The old external API (`isMultiPane`, `root`, `splitPane`, `setLeafTab`,
// `addPane`, `removePane`, `toggleMaximize`, `maximizedPaneId`, etc.) is
// preserved as a thin compatibility shim over the new state so we do not
// have to touch every caller.

import { create } from 'zustand';
import { persist, createJSONStorage, type PersistOptions } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { logInfo, logLifecycle } from '@/lib/debug-logger';

// ─── Core types ──────────────────────────────────────────────────────────────

export type PaneTab =
  | 'terminal'
  | 'ai'
  | 'browser'
  | 'markdown'
  | 'preview'
  | 'ask';

export type PresetId =
  | 'p1'
  | 'p2h'
  | 'p2v'
  | 'p3l'
  | 'p3r'
  | 'p3t'
  | 'p3b'
  | 'p4';

export type Slot = {
  /** Stable id. Minted on addPane, never rewritten afterwards. */
  id: string;
  tab: PaneTab;
  /** Terminal session id bound to this pane (only for terminal panes). */
  sessionId?: string;
} | null;

export type SlotIndex = 0 | 1 | 2 | 3;

export type Ratios = {
  mainH: number;
  mainV: number;
  rightV: number;
  leftV: number;
  bottomH: number;
  topH: number;   // p3b only: divider between slot 0 (top-left) and slot 1 (top-right)
};

export type MultiPaneCoreState = {
  preset: PresetId;
  slots: [Slot, Slot, Slot, Slot];
  focusedSlot: SlotIndex;
  ratios: Ratios;
  maximizedSlot: SlotIndex | null;
};

// Preset → capacity
export const PRESET_CAPACITY: Record<PresetId, number> = {
  p1: 1,
  p2h: 2,
  p2v: 2,
  p3l: 3,
  p3r: 3,
  p3t: 3,
  p3b: 3,
  p4: 4,
};

// ─── Legacy types (preserved for external consumers) ────────────────────────

export type SplitDirection = 'horizontal' | 'vertical';

/** Legacy leaf node shape. Produced only as a synthetic view for
 *  CommandPalette / ai-edit and similar readers that still poke at the old
 *  `.root` field. */
export type PaneLeaf = {
  type: 'leaf';
  id: string;
  tab: PaneTab;
};

export type PaneSplit = {
  type: 'split';
  id: string;
  direction: SplitDirection;
  ratio: number;
  children: [PaneNode, PaneNode];
};

export type PaneNode = PaneLeaf | PaneSplit;

// ─── Id generation ──────────────────────────────────────────────────────────

let _nextId = 1;
function genId(): string {
  return `pane-${Date.now().toString(36)}-${_nextId++}`;
}

/** Legacy helpers. The new LayoutPicker does not call these, but v0.1.0's
 *  LayoutPresetSheet builders still import them, and we keep them exported
 *  so the tsc graph does not break. */
export function makeLeaf(tab: PaneTab): PaneLeaf {
  return { type: 'leaf', id: genId(), tab };
}
export function makeSplit(
  direction: SplitDirection,
  first: PaneNode,
  second: PaneNode,
  ratio = 0.5,
): PaneSplit {
  return { type: 'split', id: genId(), direction, ratio, children: [first, second] };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DEFAULT_RATIOS: Ratios = {
  mainH: 0.5,
  mainV: 0.5,
  rightV: 0.5,
  leftV: 0.5,
  bottomH: 0.5,
  topH: 0.5,
};

function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return 0.5;
  if (r < 0.15) return 0.15;
  if (r > 0.85) return 0.85;
  return r;
}

function countSlots(slots: readonly Slot[]): number {
  let n = 0;
  for (const s of slots) if (s) n++;
  return n;
}

function countTerminalSlots(slots: readonly Slot[]): number {
  let n = 0;
  for (const s of slots) if (s && s.tab === 'terminal') n++;
  return n;
}

/** Left-pack non-null slots into the low indices, preserving order. */
function compactSlots(
  slots: readonly Slot[],
): [Slot, Slot, Slot, Slot] {
  const out: [Slot, Slot, Slot, Slot] = [null, null, null, null];
  let w = 0;
  for (const s of slots) {
    if (s) {
      out[w as SlotIndex] = s;
      w++;
    }
  }
  return out;
}

function firstFilledIndex(slots: readonly Slot[]): SlotIndex {
  for (let i = 0; i < 4; i++) {
    if (slots[i]) return i as SlotIndex;
  }
  return 0;
}

function firstEmptyIndex(slots: readonly Slot[], capacity: number): SlotIndex | null {
  for (let i = 0; i < capacity; i++) {
    if (!slots[i]) return i as SlotIndex;
  }
  return null;
}

/** Preset promotion chain used by addPane when capacity is exhausted. */
function promotePreset(p: PresetId): PresetId | null {
  switch (p) {
    case 'p1':  return 'p2h';
    case 'p2h': return 'p3l';
    case 'p2v': return 'p3t';
    case 'p3l': return 'p4';
    case 'p3r': return 'p4';
    case 'p3t': return 'p4';
    case 'p3b': return 'p4';
    case 'p4':  return null;
  }
}

/** Pick a sensible preset for the number of panes in use. */
function demotePreset(p: PresetId, used: number): PresetId {
  if (used <= 1) return 'p1';
  if (used === 2) {
    if (p === 'p2v' || p === 'p3t') return 'p2v';
    return 'p2h';
  }
  if (used === 3) {
    if (p === 'p3r') return 'p3r';
    if (p === 'p3t') return 'p3t';
    if (p === 'p3b') return 'p3b';
    return 'p3l';
  }
  return 'p4';
}

// ─── Legacy `.root` synthesis ───────────────────────────────────────────────
//
// CommandPalette and a couple of other call sites still read `.root` to
// grab "some leaf id" for splitPane. We synthesize a minimal tree from
// the flat slots so those readers keep working. This view is read-only —
// mutating it does nothing.

function synthesizeRoot(slots: readonly Slot[]): PaneNode | null {
  const filled: PaneLeaf[] = [];
  for (const s of slots) {
    if (s) filled.push({ type: 'leaf', id: s.id, tab: s.tab });
  }
  if (filled.length === 0) return null;
  if (filled.length === 1) return filled[0];
  // Chain as right-leaning horizontal splits. CommandPalette reads
  //   root.type === 'leaf' ? root.id
  //     : root.children[0].type === 'leaf' ? root.children[0].id
  //     : ''
  // so we guarantee `root.children[0]` is always a leaf.
  let node: PaneNode = filled[filled.length - 1];
  for (let i = filled.length - 2; i >= 0; i--) {
    node = {
      type: 'split',
      id: `synth-split-${i}`,
      direction: 'horizontal',
      ratio: 0.5,
      children: [filled[i], node],
    };
  }
  return node;
}

// ─── Store type ──────────────────────────────────────────────────────────────

type MultiPaneActions = {
  // New preset API
  setPreset: (preset: PresetId) => void;
  focusSlot: (slot: SlotIndex) => void;
  setRatio: (key: keyof Ratios, value: number) => void;
  resetRatio: (key: keyof Ratios) => void;
  maximizeSlot: (slot: SlotIndex | null) => void;
  setSlotTab: (slot: SlotIndex, tab: PaneTab) => void;

  // Legacy compatibility surface (keyed by leaf id where applicable)
  /** Returns null on success, or a failure reason so callers can surface a toast/alert. */
  addPane: (tab: PaneTab) => null | 'terminal_cap' | 'layout_full';
  removePane: (leafId: string) => void;
  setLeafTab: (leafId: string, tab: PaneTab) => void;
  splitPane: (leafId: string, direction: SplitDirection, newTab: PaneTab) => void;
  toggleMaximize: (leafId: string) => void;
  initShell: () => void;
  enableMultiPane: (initial?: PaneTab[]) => void;
  disableMultiPane: () => void;
  toggleMultiPane: () => void;
  setMaxPanes: (max: number) => void;
  setSplitRatio: (splitId: string, ratio: number) => void;
  resetSplitRatio: (splitId: string) => void;
  setPane: (index: number, tab: PaneTab) => void;
};

type MultiPaneLegacyView = {
  /** Always true in v0.1.1 — the shell layout is permanently multi-pane. */
  isMultiPane: boolean;
  /** Fixed at 4 (the preset grid cap). */
  maxPanes: number;
  /** Synthesized legacy tree view. Read-only. */
  root: PaneNode | null;
  /** Legacy alias for the maximized slot's leaf id. */
  maximizedPaneId: string | null;
  /** Legacy flat tab list. */
  panes: PaneTab[];
  /** True once zustand persist has finished rehydration. Consumers that
   *  render chrome tied to `slots` should gate on this to avoid flashing an
   *  empty header after force-stop → relaunch (bug #64). */
  _hasHydrated: boolean;
};

export type MultiPaneStore =
  MultiPaneCoreState & MultiPaneLegacyView & MultiPaneActions;

// ─── Initial state ──────────────────────────────────────────────────────────

function makeInitialCore(): MultiPaneCoreState {
  return {
    preset: 'p1',
    slots: [{ id: genId(), tab: 'terminal' }, null, null, null],
    focusedSlot: 0,
    ratios: { ...DEFAULT_RATIOS },
    maximizedSlot: null,
  };
}

// ─── Persist config ─────────────────────────────────────────────────────────
//
// We keep the v1 key (`multi-pane-state-v1`) as the persist name so migrate()
// can see the old payload (the zustand middleware only invokes migrate when
// the stored version is lower than the config version). Version bumps to 2
// and the migrate below walks the old tree into the new flat slots.

type PersistedV1 = {
  root?: PaneNode | null;
  maxPanes?: number;
};

type PersistedV2 = MultiPaneCoreState;

const persistOptions: PersistOptions<MultiPaneStore, PersistedV2> = {
  name: 'multi-pane-state-v1',
  storage: createJSONStorage(() => AsyncStorage),
  version: 2,
  partialize: (s) => ({
    preset: s.preset,
    slots: s.slots,
    focusedSlot: s.focusedSlot,
    ratios: s.ratios,
    maximizedSlot: s.maximizedSlot,
  }),
  migrate: (persisted: unknown, version: number): PersistedV2 => {
    // v2 already — return as-is after light validation.
    if (version >= 2 && persisted && typeof persisted === 'object') {
      const p = persisted as Partial<PersistedV2>;
      if (Array.isArray(p.slots) && p.slots.length === 4 && p.preset) {
        return {
          preset: p.preset,
          slots: p.slots as [Slot, Slot, Slot, Slot],
          focusedSlot: (p.focusedSlot ?? 0) as SlotIndex,
          ratios: { ...DEFAULT_RATIOS, ...(p.ratios ?? {}) },
          maximizedSlot: (p.maximizedSlot ?? null) as SlotIndex | null,
        };
      }
    }

    // v1 — DFS-walk the tree and pull up to 4 left-most leaves. Leaves
    // beyond the 4th are dropped. Leaf ids are preserved so any native
    // binding (PTY, WebView, agent) keyed by leafId survives the upgrade.
    const v1 = (persisted ?? {}) as PersistedV1;
    const leaves: PaneLeaf[] = [];
    const walk = (n: PaneNode | null | undefined): void => {
      if (!n || leaves.length >= 4) return;
      if (n.type === 'leaf') {
        leaves.push({ type: 'leaf', id: n.id, tab: n.tab });
        return;
      }
      walk(n.children[0]);
      walk(n.children[1]);
    };
    if (v1.root) walk(v1.root);

    const slots: [Slot, Slot, Slot, Slot] = [null, null, null, null];
    if (leaves.length === 0) {
      slots[0] = { id: genId(), tab: 'terminal' };
    } else {
      leaves.slice(0, 4).forEach((l, i) => {
        slots[i as SlotIndex] = { id: l.id, tab: l.tab };
      });
    }
    const used = countSlots(slots);
    const preset: PresetId =
      used <= 1 ? 'p1' :
      used === 2 ? 'p2h' :
      used === 3 ? 'p3l' :
      'p4';
    return {
      preset,
      slots,
      focusedSlot: 0,
      ratios: { ...DEFAULT_RATIOS },
      maximizedSlot: null,
    };
  },
  onRehydrateStorage: () => (state) => {
    // Ensure the id generator does not clash with restored ids.
    if (!state) return;
    try {
      let max = 0;
      for (const s of state.slots) {
        if (!s) continue;
        const m = /pane-.*-(\d+)$/.exec(s.id) ?? /pane-(\d+)/.exec(s.id);
        if (m) {
          const n = parseInt(m[1], 10);
          if (Number.isFinite(n) && n > max) max = n;
        }
      }
      if (max >= _nextId) _nextId = max + 1;
    } catch {
      /* non-fatal */
    }
    // Flip hydration flag so UI chrome that depends on restored `slots`
    // can render without flashing an empty header (bug #64).
    try {
      useMultiPaneStore.setState({ _hasHydrated: true });
    } catch {
      /* non-fatal — store ref may not yet be bound on first tick */
    }
  },
};

// ─── Store implementation ───────────────────────────────────────────────────

export const useMultiPaneStore = create<MultiPaneStore>()(
  persist(
    (set, get) => {
      const findSlotIndexById = (id: string): SlotIndex | null => {
        const { slots } = get();
        for (let i = 0; i < 4; i++) {
          const s = slots[i];
          if (s && s.id === id) return i as SlotIndex;
        }
        return null;
      };

      // Returns null on success, or a failure reason string so the caller can
      // surface it to the user (bug #108 — the sheet just silently closed with
      // no feedback when cap was hit).
      const doAddPane = (tab: PaneTab): null | 'terminal_cap' | 'layout_full' => {
        let { preset } = get();
        const { slots: currentSlots } = get();
        let slots = currentSlots;

        // Terminal cap — 3 terminals max. Android 12+ phantom process killer
        // caps app-owned subprocess count at ~32; each idle terminal occupies
        // ~1 subprocess (bash), bumped to 5-10 once a CLI (claude/codex/
        // gemini) starts its node helper and spawns tools. 3 panes × ~10 peak
        // = 30 processes fits comfortably under 32 on Samsung (the strictest
        // OEM we support). Bumping above 3 needs a Foreground Service
        // (bug #65 Case B) to keep children out of the phantom pool. This
        // cap was 2 before 2026-04-20; revert if users hit "process killed"
        // regressions and we haven't shipped the FG service yet.
        if (tab === 'terminal' && countTerminalSlots(slots) >= 3) {
          logInfo('MultiPane', 'addPane terminal ignored — cap 3');
          return 'terminal_cap';
        }

        let cap = PRESET_CAPACITY[preset];
        let empty = firstEmptyIndex(slots, cap);

        if (empty === null) {
          // Capacity full — promote preset one level.
          const next = promotePreset(preset);
          if (!next) {
            logInfo('MultiPane', 'addPane ignored — already at p4');
            return 'layout_full';
          }
          preset = next;
          cap = PRESET_CAPACITY[preset];
          empty = firstEmptyIndex(slots, cap);
          if (empty === null) return 'layout_full'; // defensive
        }

        const newSlots = slots.slice() as [Slot, Slot, Slot, Slot];
        const slotId = genId();
        if (tab === 'terminal') {
          const { useTerminalStore } = require('@/store/terminal-store');
          const newSessionId = useTerminalStore.getState().addSession();
          newSlots[empty] = { id: slotId, tab, sessionId: newSessionId };
        } else {
          newSlots[empty] = { id: slotId, tab };
        }
        set({ preset, slots: newSlots, focusedSlot: empty });
        return null;
      };

      // Cascade cleanup for a terminal slot that is about to be dropped from
      // the layout: destroy the native PTY session and remove the entry from
      // terminal-store. Without this, `removePane` and `setPreset` trim both
      // leaked PTY child processes and bloated the `sessions[]` list until
      // MAX_SESSIONS (4) hit and further addSession silently refused. Best
      // effort: destroySession is fire-and-forget because the registry lookup
      // may miss if the session already exited, and terminal-store blocks
      // removing the very last entry (so 1 orphan may remain — acceptable).
      const cleanupDroppedSlot = (slot: Slot): void => {
        if (!slot || slot.tab !== 'terminal' || !slot.sessionId) return;
        try {
          const { useTerminalStore } = require('@/store/terminal-store');
          const state = useTerminalStore.getState();
          const session = state.sessions.find((s: any) => s.id === slot.sessionId);
          if (session?.nativeSessionId) {
            try {
              const TerminalEmulator = require('@/modules/terminal-emulator/src/TerminalEmulatorModule').default;
              TerminalEmulator.destroySession(session.nativeSessionId).catch(() => {});
            } catch { /* native module unavailable (web/tests) */ }
          }
          state.removeSession(slot.sessionId);
        } catch (e) {
          logInfo('MultiPane', 'cleanupDroppedSlot failed: ' + String(e));
        }
      };

      const doRemoveBySlot = (slotIdx: SlotIndex): void => {
        const { slots, preset, focusedSlot, maximizedSlot } = get();
        if (!slots[slotIdx]) return;
        if (countSlots(slots) <= 1) {
          logInfo('MultiPane', 'removePane ignored — last slot');
          return;
        }

        // Cascade destroy for the slot being removed (terminal only).
        cleanupDroppedSlot(slots[slotIdx]);

        const removedId = slots[slotIdx]?.id ?? null;
        const focusedId = slots[focusedSlot]?.id ?? null;
        const maximizedId =
          maximizedSlot !== null ? slots[maximizedSlot]?.id ?? null : null;

        const cleared = slots.slice() as [Slot, Slot, Slot, Slot];
        cleared[slotIdx] = null;
        const compacted = compactSlots(cleared);
        const used = countSlots(compacted);
        const newPreset = demotePreset(preset, used);

        // Translate focus/maximized through the compact by id.
        let newFocus: SlotIndex = firstFilledIndex(compacted);
        if (focusedId && focusedId !== removedId) {
          for (let i = 0; i < 4; i++) {
            if (compacted[i]?.id === focusedId) { newFocus = i as SlotIndex; break; }
          }
        }
        let newMaximized: SlotIndex | null = null;
        if (maximizedId && maximizedId !== removedId) {
          for (let i = 0; i < 4; i++) {
            if (compacted[i]?.id === maximizedId) { newMaximized = i as SlotIndex; break; }
          }
        }

        set({
          slots: compacted,
          preset: newPreset,
          focusedSlot: newFocus,
          maximizedSlot: newMaximized,
        });
      };

      return {
        // Core state
        ...makeInitialCore(),

        // Hydration flag — flipped to true in onRehydrateStorage below.
        _hasHydrated: false,

        // ── Legacy view fields (recomputed on every access) ──
        get isMultiPane() { return true; },
        get maxPanes() { return 4; },
        get root() { return synthesizeRoot(get().slots); },
        get maximizedPaneId() {
          const { slots, maximizedSlot } = get();
          if (maximizedSlot === null) return null;
          return slots[maximizedSlot]?.id ?? null;
        },
        get panes() {
          return get().slots
            .filter((s): s is NonNullable<Slot> => s !== null)
            .map((s) => s.tab);
        },

        // ── New preset actions ──
        // Picking a smaller preset used to be refused when `used > capacity`,
        // which meant that once a user reached p4 (2×2) they had no UI path
        // back to single-pane without tapping [×] on every pane individually.
        // Worse, the LayoutPicker tiles for smaller presets were disabled, so
        // the user couldn't even tell that was the reason — the app just
        // looked broken. Downsize now by trimming surplus slots after
        // compaction, AND cascading native session destruction for any
        // terminal slot that gets dropped (otherwise PTY child processes
        // leak and MAX_SESSIONS ceiling hits faster than necessary).
        setPreset: (preset) => {
          const { slots } = get();
          const compacted = compactSlots(slots);
          const cap = PRESET_CAPACITY[preset];
          const used = countSlots(compacted);
          if (used > cap) {
            const trimmed: [Slot, Slot, Slot, Slot] = [null, null, null, null];
            for (let i = 0; i < cap; i++) trimmed[i] = compacted[i];
            const dropped = compacted
              .slice(cap)
              .filter((s): s is NonNullable<Slot> => s !== null);
            const droppedIds = dropped.map((s) => s.id);
            logInfo(
              'MultiPane',
              `setPreset ${preset} — trimmed ${droppedIds.length} surplus pane(s): ${droppedIds.join(',')}`,
            );
            // Cascade-destroy native sessions for trimmed terminal panes.
            // Without this, switching p4 → p1 would orphan up to 3 forkpty
            // children and consume MAX_SESSIONS slots for nothing.
            for (const slot of dropped) cleanupDroppedSlot(slot);
            const { focusedSlot, maximizedSlot } = get();
            const safeFocus: SlotIndex = (focusedSlot < cap ? focusedSlot : 0) as SlotIndex;
            const safeMax = maximizedSlot !== null && maximizedSlot < cap ? maximizedSlot : null;
            set({ preset, slots: trimmed, focusedSlot: safeFocus, maximizedSlot: safeMax });
            return;
          }
          set({ preset, slots: compacted });
        },

        focusSlot: (slot) => {
          const { slots } = get();
          if (!slots[slot]) return;
          set({ focusedSlot: slot });
        },

        setRatio: (key, value) => {
          const { ratios } = get();
          set({ ratios: { ...ratios, [key]: clampRatio(value) } });
        },

        resetRatio: (key) => {
          const { ratios } = get();
          set({ ratios: { ...ratios, [key]: 0.5 } });
        },

        maximizeSlot: (slot) => {
          set({ maximizedSlot: slot });
        },

        setSlotTab: (slot, tab) => {
          const { slots } = get();
          const s = slots[slot];
          if (!s) return;
          const newSlots = slots.slice() as [Slot, Slot, Slot, Slot];
          newSlots[slot] = { ...s, tab };
          set({ slots: newSlots });
        },

        // ── Legacy action surface ──
        addPane: (tab) => doAddPane(tab),

        removePane: (leafId) => {
          const idx = findSlotIndexById(leafId);
          if (idx === null) return;
          doRemoveBySlot(idx);
        },

        setLeafTab: (leafId, tab) => {
          const idx = findSlotIndexById(leafId);
          if (idx === null) return;
          const { slots } = get();
          const s = slots[idx];
          if (!s) return;
          const newSlots = slots.slice() as [Slot, Slot, Slot, Slot];
          newSlots[idx] = { ...s, tab };
          set({ slots: newSlots });
        },

        // splitPane is re-interpreted: "add a new pane of newTab via the
        // normal preset promotion flow". The direction argument is ignored
        // — the preset system chooses the layout shape. leafId, if still
        // alive, becomes the focused slot first so promotion feels local.
        splitPane: (leafId, _direction, newTab) => {
          const idx = findSlotIndexById(leafId);
          if (idx !== null) set({ focusedSlot: idx });
          doAddPane(newTab);
        },

        toggleMaximize: (leafId) => {
          const idx = findSlotIndexById(leafId);
          if (idx === null) return;
          const { maximizedSlot } = get();
          set({ maximizedSlot: maximizedSlot === idx ? null : idx });
        },

        initShell: () => {
          logLifecycle('MultiPane', 'initShell');
          const { slots } = get();
          if (countSlots(slots) === 0) {
            // bug: initShell and enableMultiPane historically left the
            // first terminal slot with `sessionId: undefined`, so when the
            // user later opened a second terminal pane both slots fell
            // back to terminal-store.activeSessionId (the newest session)
            // and rendered IDENTICAL content. Mint a session upfront so
            // each slot has its own PTY from the start.
            const { useTerminalStore } = require('@/store/terminal-store');
            const newSessionId = useTerminalStore.getState().addSession();
            set({
              preset: 'p1',
              slots: [{ id: genId(), tab: 'terminal', sessionId: newSessionId }, null, null, null],
              focusedSlot: 0,
              maximizedSlot: null,
            });
          } else {
            // Reconcile: any pre-existing terminal slots missing a sessionId
            // (from pre-fix persists) get one bound now. Without this step
            // existing users would stay broken after upgrade until they
            // manually close and re-add every pane.
            //
            // Also defends against duplicate sessionIds across slots — if a
            // future persist migration (or a hand-edited store) ends up with
            // two terminal slots pointing at the same session, all but the
            // first get a fresh mint. Without this, reconcile's early-return
            // on truthy sessionId would leave the dup in place and both
            // panes would keep rendering the same PTY.
            const { useTerminalStore } = require('@/store/terminal-store');
            const store = useTerminalStore.getState();
            const seen = new Set<string>();
            let changed = false;
            const next = slots.map((slot) => {
              if (!slot || slot.tab !== 'terminal') return slot;
              if (slot.sessionId && !seen.has(slot.sessionId)) {
                seen.add(slot.sessionId);
                return slot;
              }
              const nid = store.addSession();
              if (!nid) return slot;
              seen.add(nid);
              changed = true;
              return { ...slot, sessionId: nid };
            }) as [Slot, Slot, Slot, Slot];
            if (changed) {
              logInfo('MultiPane', 'initShell: reconciled sessionIds (missing or duplicate)');
              set({ slots: next });
            }
          }
        },

        enableMultiPane: (initial) => {
          const tabs = initial && initial.length > 0 ? initial : ['terminal' as PaneTab];
          const trimmed = tabs.slice(0, 4);
          const newSlots: [Slot, Slot, Slot, Slot] = [null, null, null, null];
          // Mint a session per terminal slot up front — same reasoning as
          // the initShell fix: without this the first and second terminal
          // panes both resolve to the globally-active session and render
          // identical content.
          const { useTerminalStore } = require('@/store/terminal-store');
          const tstore = useTerminalStore.getState();
          trimmed.forEach((t, i) => {
            if (t === 'terminal') {
              const nid = tstore.addSession();
              newSlots[i as SlotIndex] = nid
                ? { id: genId(), tab: t, sessionId: nid }
                // MAX_SESSIONS hit: fall back to an unbound slot rather
                // than dropping the pane. This is the same shape the pre-
                // fix code produced, so it is safe; the user will just
                // see the global active session in this slot until they
                // close another one.
                : { id: genId(), tab: t };
            } else {
              newSlots[i as SlotIndex] = { id: genId(), tab: t };
            }
          });
          let preset: PresetId = 'p1';
          if (trimmed.length === 2) preset = 'p2h';
          else if (trimmed.length === 3) preset = 'p3l';
          else if (trimmed.length >= 4) preset = 'p4';
          set({
            preset,
            slots: newSlots,
            focusedSlot: 0,
            maximizedSlot: null,
            ratios: { ...DEFAULT_RATIOS },
          });
        },

        disableMultiPane: () => {
          // v0.1.1: multi-pane is the only mode. Reset to a single terminal.
          // Mint the session up front for the same reason as initShell —
          // leaving sessionId undefined would make TerminalPane fall back to
          // globalActiveSession, which re-creates bug #117 if the user later
          // adds a second pane.
          const { useTerminalStore } = require('@/store/terminal-store');
          const nid = useTerminalStore.getState().addSession();
          set({
            preset: 'p1',
            slots: [
              nid
                ? { id: genId(), tab: 'terminal', sessionId: nid }
                : { id: genId(), tab: 'terminal' },
              null,
              null,
              null,
            ],
            focusedSlot: 0,
            maximizedSlot: null,
          });
        },

        toggleMultiPane: () => { /* noop — always multi-pane */ },
        setMaxPanes: (_max) => { /* noop — cap fixed at 4 */ },

        // Legacy ratio-by-split-id API. New ratio system is keyed, so we
        // ignore the unknown split id. Divider uses setRatio directly.
        setSplitRatio: (_splitId, _ratio) => { /* legacy no-op */ },
        resetSplitRatio: (_splitId) => { /* legacy no-op */ },

        // Legacy index-based setter used only by a few old CTAs.
        setPane: (index, tab) => {
          if (index < 0 || index > 3) return;
          const { slots } = get();
          const s = slots[index];
          if (!s) return;
          const newSlots = slots.slice() as [Slot, Slot, Slot, Slot];
          newSlots[index as SlotIndex] = { ...s, tab };
          set({ slots: newSlots });
        },
      };
    },
    persistOptions,
  ),
);

// ─── Pure layout computation ────────────────────────────────────────────────

export type SlotRect = { x: number; y: number; w: number; h: number };
export type DividerSpec =
  | { kind: 'vertical';   x: number; y: number; h: number; ratioKey: keyof Ratios }
  | { kind: 'horizontal'; x: number; y: number; w: number; ratioKey: keyof Ratios };

export type ComputedLayout = {
  slotRects: [SlotRect, SlotRect, SlotRect, SlotRect];
  dividers: DividerSpec[];
};

const ZERO_RECT: SlotRect = { x: 0, y: 0, w: 0, h: 0 };

/** Pure function — given a preset, ratios and the container pixel size,
 *  compute each slot's absolute rect plus the divider specs. See the
 *  2026-04-14 four-pane layout spec for the formulas. */
export function getLayout(
  preset: PresetId,
  ratios: Ratios,
  W: number,
  H: number,
): ComputedLayout {
  const rects: [SlotRect, SlotRect, SlotRect, SlotRect] = [
    ZERO_RECT, ZERO_RECT, ZERO_RECT, ZERO_RECT,
  ];
  const dividers: DividerSpec[] = [];
  if (W <= 0 || H <= 0) return { slotRects: rects, dividers };

  const mainH = ratios.mainH;
  const mainV = ratios.mainV;

  switch (preset) {
    case 'p1': {
      rects[0] = { x: 0, y: 0, w: W, h: H };
      break;
    }
    case 'p2h': {
      const mx = mainH * W;
      rects[0] = { x: 0,  y: 0, w: mx,     h: H };
      rects[1] = { x: mx, y: 0, w: W - mx, h: H };
      dividers.push({ kind: 'vertical', x: mx, y: 0, h: H, ratioKey: 'mainH' });
      break;
    }
    case 'p2v': {
      const my = mainV * H;
      rects[0] = { x: 0, y: 0,  w: W, h: my };
      rects[1] = { x: 0, y: my, w: W, h: H - my };
      dividers.push({ kind: 'horizontal', x: 0, y: my, w: W, ratioKey: 'mainV' });
      break;
    }
    case 'p3l': {
      const mx = mainH * W;
      const ry = ratios.rightV * H;
      rects[0] = { x: 0,  y: 0,  w: mx,     h: H };
      rects[1] = { x: mx, y: 0,  w: W - mx, h: ry };
      rects[2] = { x: mx, y: ry, w: W - mx, h: H - ry };
      dividers.push(
        { kind: 'vertical',   x: mx, y: 0,  h: H,      ratioKey: 'mainH' },
        { kind: 'horizontal', x: mx, y: ry, w: W - mx, ratioKey: 'rightV' },
      );
      break;
    }
    case 'p3r': {
      const mx = mainH * W;
      const ly = ratios.leftV * H;
      rects[0] = { x: 0,  y: 0,  w: mx,     h: ly };
      rects[1] = { x: 0,  y: ly, w: mx,     h: H - ly };
      rects[2] = { x: mx, y: 0,  w: W - mx, h: H };
      dividers.push(
        { kind: 'vertical',   x: mx, y: 0,  h: H, ratioKey: 'mainH' },
        { kind: 'horizontal', x: 0,  y: ly, w: mx, ratioKey: 'leftV' },
      );
      break;
    }
    case 'p3t': {
      const my = mainV * H;
      const bx = ratios.bottomH * W;
      rects[0] = { x: 0,  y: 0,  w: W,      h: my };
      rects[1] = { x: 0,  y: my, w: bx,     h: H - my };
      rects[2] = { x: bx, y: my, w: W - bx, h: H - my };
      dividers.push(
        { kind: 'horizontal', x: 0,  y: my, w: W,      ratioKey: 'mainV' },
        { kind: 'vertical',   x: bx, y: my, h: H - my, ratioKey: 'bottomH' },
      );
      break;
    }
    case 'p3b': {
      // Mirror of p3t: two panes on top, one full-width pane on the bottom.
      //   slot 0 = top-left, slot 1 = top-right, slot 2 = bottom (full width)
      const my = mainV * H;
      const tx = ratios.topH * W;
      rects[0] = { x: 0,  y: 0,  w: tx,     h: my };
      rects[1] = { x: tx, y: 0,  w: W - tx, h: my };
      rects[2] = { x: 0,  y: my, w: W,      h: H - my };
      dividers.push(
        { kind: 'vertical',   x: tx, y: 0,  h: my, ratioKey: 'topH' },
        { kind: 'horizontal', x: 0,  y: my, w: W,  ratioKey: 'mainV' },
      );
      break;
    }
    case 'p4': {
      const mx = mainH * W;
      const my = mainV * H;
      rects[0] = { x: 0,  y: 0,  w: mx,     h: my };
      rects[1] = { x: mx, y: 0,  w: W - mx, h: my };
      rects[2] = { x: 0,  y: my, w: mx,     h: H - my };
      rects[3] = { x: mx, y: my, w: W - mx, h: H - my };
      dividers.push(
        { kind: 'vertical',   x: mx, y: 0,  h: H, ratioKey: 'mainH' },
        { kind: 'horizontal', x: 0,  y: my, w: W, ratioKey: 'mainV' },
      );
      break;
    }
  }
  return { slotRects: rects, dividers };
}
