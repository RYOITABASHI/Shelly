// components/multi-pane/LayoutPresetBar.tsx
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useMultiPaneStore, makeLeaf, makeSplit } from '@/hooks/use-multi-pane';
import type { PaneNode } from '@/hooks/use-multi-pane';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R } from '@/theme.config';

export type LayoutPreset = {
  id: string;
  label: string;
  build: () => PaneNode;
};

const PRESETS: LayoutPreset[] = [
  {
    id: '1+2',
    label: '1+2 SPLIT',
    build: () =>
      makeSplit('vertical',
        makeSplit('horizontal', makeLeaf('terminal'), makeLeaf('ai')),
        makeSplit('horizontal', makeLeaf('browser'), makeLeaf('terminal')),
        0.55,
      ),
  },
  {
    id: '2col',
    label: '2 COL',
    build: () => makeSplit('horizontal', makeLeaf('terminal'), makeLeaf('ai')),
  },
  {
    id: '2row',
    label: '2 ROW',
    build: () => makeSplit('vertical', makeLeaf('terminal'), makeLeaf('ai')),
  },
  {
    id: 'single',
    label: 'SINGLE',
    build: () => makeLeaf('terminal'),
  },
  {
    id: '2x2',
    label: '2X2 GRID',
    build: () =>
      makeSplit('vertical',
        makeSplit('horizontal', makeLeaf('terminal'), makeLeaf('ai')),
        makeSplit('horizontal', makeLeaf('browser'), makeLeaf('terminal')),
      ),
  },
  {
    id: '4term',
    label: '4 TERMINAL',
    build: () =>
      makeSplit('vertical',
        makeSplit('horizontal', makeLeaf('terminal'), makeLeaf('terminal')),
        makeSplit('horizontal', makeLeaf('terminal'), makeLeaf('terminal')),
      ),
  },
];

/** Count leaf nodes */
function countLeaves(node: PaneNode): number {
  if (node.type === 'leaf') return 1;
  return countLeaves(node.children[0]) + countLeaves(node.children[1]);
}

/** Collect all leaf tabs */
function collectTabs(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.tab];
  return [...collectTabs(node.children[0]), ...collectTabs(node.children[1])];
}

/** Derive current preset id from the tree shape */
function detectPreset(root: PaneNode | null): string | null {
  if (!root) return 'single';
  if (root.type === 'leaf') return 'single';

  const leaves = countLeaves(root);
  const tabs = collectTabs(root);

  if (leaves === 2 && root.type === 'split') {
    if (root.direction === 'horizontal') return '2col';
    if (root.direction === 'vertical') return '2row';
  }

  if (leaves === 4) {
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

export function LayoutPresetBar() {
  const { root } = useMultiPaneStore();
  const [lastSelected, setLastSelected] = React.useState<string | null>(null);
  const detected = detectPreset(root);
  const currentPreset = detected ?? lastSelected;

  const handleSelect = (preset: LayoutPreset) => {
    const newRoot = preset.build();
    useMultiPaneStore.setState({ root: newRoot, isMultiPane: true });
    setLastSelected(preset.id);
  };

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {PRESETS.map((p) => {
          const isActive = currentPreset === p.id;
          return (
            <Pressable
              key={p.id}
              style={[
                styles.presetBtn,
                isActive && styles.presetBtnActive,
              ]}
              onPress={() => handleSelect(p)}
            >
              <Text
                style={[
                  styles.presetLabel,
                  isActive && styles.presetLabelActive,
                ]}
              >
                {p.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: S.layoutBarHeight,
    backgroundColor: C.bgSidebar,
    borderTopWidth: S.borderWidth,
    borderTopColor: C.border,
    justifyContent: 'center',
  },
  scrollContent: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: P.layoutButton.px,
    gap: P.layoutButton.gap,
    flexGrow: 1,
  },
  presetBtn: {
    paddingHorizontal: P.layoutButton.px,
    paddingVertical: P.layoutButton.py,
    borderRadius: R.layoutButton,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    backgroundColor: C.layoutInactiveBg,
  },
  presetBtnActive: {
    backgroundColor: C.layoutActiveBg,
    borderColor: C.layoutActiveBg,
    shadowColor: C.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 3,
  },
  presetLabel: {
    fontSize: F.layoutButton.size,
    fontFamily: F.family,
    fontWeight: F.layoutButton.weight,
    letterSpacing: 0.8,
    color: C.layoutInactiveText,
  },
  presetLabelActive: {
    color: C.layoutActiveText,
  },
});
