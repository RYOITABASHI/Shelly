import { create } from 'zustand';

// ─── Types ───────────────────────────────────────────────────────────────────

export type PaneTab =
  | 'index'
  | 'terminal'
  | 'projects'
  | 'snippets'
  | 'creator'
  | 'obsidian'
  | 'search'
  | 'settings';

export type SplitDirection = 'horizontal' | 'vertical';

/** A leaf node renders a single tab screen */
export type PaneLeaf = {
  type: 'leaf';
  id: string;
  tab: PaneTab;
};

/** A split node divides space into two children */
export type PaneSplit = {
  type: 'split';
  id: string;
  direction: SplitDirection;
  /** Ratio of first child (0-1). Default 0.5 */
  ratio: number;
  children: [PaneNode, PaneNode];
};

export type PaneNode = PaneLeaf | PaneSplit;

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _nextId = 1;
function genId(): string {
  return `pane-${_nextId++}`;
}

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

/** Count leaf nodes in tree */
function countLeaves(node: PaneNode): number {
  if (node.type === 'leaf') return 1;
  return countLeaves(node.children[0]) + countLeaves(node.children[1]);
}

/** Find a node by id and return it + its parent */
function findNode(
  root: PaneNode,
  id: string,
  parent: PaneSplit | null = null,
  childIndex: 0 | 1 = 0,
): { node: PaneNode; parent: PaneSplit | null; childIndex: 0 | 1 } | null {
  if (root.id === id) return { node: root, parent, childIndex };
  if (root.type === 'split') {
    const left = findNode(root.children[0], id, root, 0);
    if (left) return left;
    return findNode(root.children[1], id, root, 1);
  }
  return null;
}

/** Deep clone a pane tree (for immutable updates) */
function cloneTree(node: PaneNode): PaneNode {
  if (node.type === 'leaf') return { ...node };
  return {
    ...node,
    children: [cloneTree(node.children[0]), cloneTree(node.children[1])],
  };
}

/** Replace a node by id in a cloned tree */
function replaceNode(root: PaneNode, id: string, replacement: PaneNode): PaneNode {
  if (root.id === id) return replacement;
  if (root.type === 'split') {
    return {
      ...root,
      children: [
        replaceNode(root.children[0], id, replacement),
        replaceNode(root.children[1], id, replacement),
      ],
    };
  }
  return root;
}

/** Remove a leaf by id, collapsing the parent split */
function removeLeaf(root: PaneNode, leafId: string): PaneNode | null {
  if (root.type === 'leaf') {
    return root.id === leafId ? null : root;
  }
  // Check if either child is the target leaf
  if (root.children[0].id === leafId) return cloneTree(root.children[1]);
  if (root.children[1].id === leafId) return cloneTree(root.children[0]);
  // Recurse into children
  const newLeft = removeLeaf(root.children[0], leafId);
  if (newLeft !== root.children[0] && newLeft !== null) {
    return { ...root, children: [newLeft, cloneTree(root.children[1])] };
  }
  if (newLeft === null) return cloneTree(root.children[1]); // Left subtree collapsed entirely
  const newRight = removeLeaf(root.children[1], leafId);
  if (newRight !== root.children[1] && newRight !== null) {
    return { ...root, children: [cloneTree(root.children[0]), newRight] };
  }
  if (newRight === null) return cloneTree(root.children[0]); // Right subtree collapsed entirely
  return root;
}

/** Collect all leaf tabs */
function collectTabs(node: PaneNode): PaneTab[] {
  if (node.type === 'leaf') return [node.tab];
  return [...collectTabs(node.children[0]), ...collectTabs(node.children[1])];
}

// ─── Store ───────────────────────────────────────────────────────────────────

type MultiPaneState = {
  isMultiPane: boolean;
  /** Root of the pane tree (null when not in multi-pane mode) */
  root: PaneNode | null;
  /** Max total leaf panes allowed */
  maxPanes: number;
};

type MultiPaneActions = {
  enableMultiPane: (initial?: PaneTab[]) => void;
  disableMultiPane: () => void;
  toggleMultiPane: () => void;
  /** Change the tab of a leaf by its id */
  setLeafTab: (leafId: string, tab: PaneTab) => void;
  /** Split a leaf into two panes */
  splitPane: (leafId: string, direction: SplitDirection, newTab: PaneTab) => void;
  /** Remove a leaf pane (collapses parent split) */
  removePane: (leafId: string) => void;
  /** Update split ratio by split node id */
  setSplitRatio: (splitId: string, ratio: number) => void;
  /** Update maxPanes */
  setMaxPanes: (max: number) => void;

  // ── Backwards compat (used by _layout.tsx, TerminalHeader, etc.) ──
  /** @deprecated Use root tree instead */
  panes: PaneTab[];
  /** @deprecated */
  setPane: (index: number, tab: PaneTab) => void;
  /** @deprecated */
  addPane: (tab: PaneTab) => void;
};

export const useMultiPaneStore = create<MultiPaneState & MultiPaneActions>(
  (set, get) => ({
    isMultiPane: false,
    root: null,
    maxPanes: 4,

    // Backwards compat getter
    get panes() {
      const { root } = get();
      return root ? collectTabs(root) : [];
    },

    enableMultiPane: (initial) => {
      const tabs = initial ?? ['index', 'terminal'];
      // Build a simple horizontal split from the initial tabs
      if (tabs.length <= 1) {
        set({ isMultiPane: true, root: makeLeaf(tabs[0] ?? 'index') });
      } else {
        // Chain horizontal splits: [a, b, c] → split(a, split(b, c))
        let node: PaneNode = makeLeaf(tabs[tabs.length - 1]);
        for (let i = tabs.length - 2; i >= 0; i--) {
          node = makeSplit('horizontal', makeLeaf(tabs[i]), node);
        }
        set({ isMultiPane: true, root: node });
      }
    },

    disableMultiPane: () => {
      set({ isMultiPane: false, root: null });
    },

    toggleMultiPane: () => {
      const { isMultiPane } = get();
      if (isMultiPane) {
        get().disableMultiPane();
      } else {
        get().enableMultiPane();
      }
    },

    setLeafTab: (leafId, tab) => {
      const { root } = get();
      if (!root) return;
      const newRoot = cloneTree(root);
      const found = findNode(newRoot, leafId);
      if (found && found.node.type === 'leaf') {
        found.node.tab = tab;
        set({ root: newRoot });
      }
    },

    splitPane: (leafId, direction, newTab) => {
      const { root, maxPanes } = get();
      if (!root) return;
      if (countLeaves(root) >= maxPanes) return;
      const oldLeaf = makeLeaf(
        (() => {
          const f = findNode(root, leafId);
          return f && f.node.type === 'leaf' ? f.node.tab : 'index';
        })(),
      );
      const newLeaf = makeLeaf(newTab);
      const split = makeSplit(direction, oldLeaf, newLeaf);
      const newRoot = replaceNode(cloneTree(root), leafId, split);
      set({ root: newRoot });
    },

    removePane: (leafId) => {
      const { root } = get();
      if (!root) return;
      const result = removeLeaf(root, leafId);
      if (!result || (result.type === 'leaf' && countLeaves(result) <= 1)) {
        // Last pane remaining or removed — exit multi-pane
        set({ isMultiPane: false, root: null });
      } else {
        set({ root: result });
      }
    },

    setSplitRatio: (splitId, ratio) => {
      const { root } = get();
      if (!root) return;
      const newRoot = cloneTree(root);
      const found = findNode(newRoot, splitId);
      if (found && found.node.type === 'split') {
        found.node.ratio = Math.max(0.15, Math.min(0.85, ratio));
        set({ root: newRoot });
      }
    },

    setMaxPanes: (max) => {
      set({ maxPanes: Math.max(2, Math.min(6, max)) });
    },

    // ── Backwards compat actions ──
    setPane: (index, tab) => {
      const { root } = get();
      if (!root) return;
      const tabs = collectTabs(root);
      if (index < 0 || index >= tabs.length) return;
      // Find the nth leaf and change it
      let count = 0;
      const findNthLeaf = (node: PaneNode): string | null => {
        if (node.type === 'leaf') {
          if (count === index) return node.id;
          count++;
          return null;
        }
        return findNthLeaf(node.children[0]) ?? findNthLeaf(node.children[1]);
      };
      const leafId = findNthLeaf(root);
      if (leafId) get().setLeafTab(leafId, tab);
    },

    addPane: (tab) => {
      const { root, maxPanes } = get();
      if (!root) return;
      if (countLeaves(root) >= maxPanes) return;
      // Find the last leaf and split it horizontally
      const findLastLeaf = (node: PaneNode): string => {
        if (node.type === 'leaf') return node.id;
        return findLastLeaf(node.children[1]);
      };
      get().splitPane(findLastLeaf(root), 'horizontal', tab);
    },
  }),
);
