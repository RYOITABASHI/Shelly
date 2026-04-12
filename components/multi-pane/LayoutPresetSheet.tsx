// components/multi-pane/LayoutPresetSheet.tsx
//
// Bottom sheet for switching layout presets. Triggered by the layout
// icon at the left edge of AgentBar. Replaces the old horizontal
// LayoutPresetBar at the bottom of the screen.

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useMultiPaneStore, makeLeaf, makeSplit } from '@/hooks/use-multi-pane';
import type { PaneNode } from '@/hooks/use-multi-pane';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export type LayoutPreset = {
  id: string;
  label: string;
  icon: string;
  build: () => PaneNode;
};

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'single',
    label: 'Single',
    icon: 'crop-square',
    build: () => makeLeaf('terminal'),
  },
  {
    id: '1+2',
    label: '1+2 Split',
    icon: 'view-quilt',
    build: () =>
      makeSplit(
        'vertical',
        makeSplit('horizontal', makeLeaf('terminal'), makeLeaf('ai')),
        makeSplit('horizontal', makeLeaf('browser'), makeLeaf('terminal')),
        0.55,
      ),
  },
  {
    id: '2col',
    label: '2 Col',
    icon: 'view-column',
    build: () => makeSplit('horizontal', makeLeaf('terminal'), makeLeaf('ai')),
  },
  {
    id: '2row',
    label: '2 Row',
    icon: 'view-stream',
    build: () => makeSplit('vertical', makeLeaf('terminal'), makeLeaf('ai')),
  },
  {
    id: '2x2',
    label: '2×2 Grid',
    icon: 'grid-view',
    build: () =>
      makeSplit(
        'vertical',
        makeSplit('horizontal', makeLeaf('terminal'), makeLeaf('ai')),
        makeSplit('horizontal', makeLeaf('browser'), makeLeaf('terminal')),
      ),
  },
  {
    id: '4term',
    label: '4 Terminal',
    icon: 'dashboard',
    build: () =>
      makeSplit(
        'vertical',
        makeSplit('horizontal', makeLeaf('terminal'), makeLeaf('terminal')),
        makeSplit('horizontal', makeLeaf('terminal'), makeLeaf('terminal')),
      ),
  },
];

export function applyLayoutPreset(id: string) {
  const preset = LAYOUT_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  const root = preset.build();
  useMultiPaneStore.setState({ root, isMultiPane: true, maximizedPaneId: null });
}

/** Detect which preset the current tree matches, or null */
function countLeaves(node: PaneNode): number {
  if (node.type === 'leaf') return 1;
  return countLeaves(node.children[0]) + countLeaves(node.children[1]);
}

function collectTabs(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.tab];
  return [...collectTabs(node.children[0]), ...collectTabs(node.children[1])];
}

function detectPreset(root: PaneNode | null): string | null {
  if (!root) return 'single';
  if (root.type === 'leaf') return 'single';
  const leaves = countLeaves(root);
  if (leaves === 2 && root.type === 'split') {
    if (root.direction === 'horizontal') return '2col';
    if (root.direction === 'vertical') return '2row';
  }
  if (leaves === 4) {
    const tabs = collectTabs(root);
    if (tabs.every((t) => t === 'terminal')) return '4term';
    if (root.type === 'split' && root.direction === 'vertical') {
      const top = root.children[0];
      const bot = root.children[1];
      if (top.type === 'split' && bot.type === 'split') {
        if (root.ratio > 0.45 && root.ratio < 0.55) return '2x2';
        return '1+2';
      }
    }
  }
  return null;
}

export function LayoutPresetSheet({ visible, onClose }: Props) {
  if (!visible) return null;

  const root = useMultiPaneStore.getState().root;
  const current = detectPreset(root);

  const handleSelect = (id: string) => {
    applyLayoutPreset(id);
    onClose();
  };

  return (
    <Pressable style={styles.backdrop} onPress={onClose}>
      <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
        <View style={styles.handle} />
        <Text style={styles.title}>LAYOUT</Text>
        <View style={styles.grid}>
          {LAYOUT_PRESETS.map((p) => {
            const isActive = current === p.id;
            return (
              <Pressable
                key={p.id}
                style={[styles.tile, isActive && styles.tileActive]}
                onPress={() => handleSelect(p.id)}
              >
                <MaterialIcons
                  name={p.icon as any}
                  size={22}
                  color={isActive ? C.accent : C.text2}
                />
                <Text style={[styles.tileLabel, isActive && styles.tileLabelActive]}>
                  {p.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
    zIndex: 400,
  },
  sheet: {
    backgroundColor: C.bgSurface,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderTopWidth: S.borderWidth,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 24,
  },
  handle: {
    width: 40,
    height: 3,
    borderRadius: 2,
    backgroundColor: C.border,
    alignSelf: 'center',
    marginBottom: 8,
  },
  title: {
    color: C.text2,
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 1,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingVertical: 6,
  },
  tile: {
    width: '31%',
    aspectRatio: 1.4,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: 'transparent',
  },
  tileActive: {
    borderColor: C.accent,
    backgroundColor: 'rgba(0,212,170,0.10)',
  },
  tileLabel: {
    color: C.text2,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    letterSpacing: 0.5,
  },
  tileLabelActive: {
    color: C.accent,
  },
});
