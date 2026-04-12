import React, { useCallback, useRef } from 'react';
import { View, StyleSheet, LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useMultiPaneStore, type PaneNode, type PaneSplit } from '@/hooks/use-multi-pane';
import { PaneSlot } from './PaneSlot';
import { colors as C } from '@/theme.config';

/** Draggable divider between two panes */
function Divider({
  splitNode,
  isHorizontal,
  containerSize,
}: {
  splitNode: PaneSplit;
  isHorizontal: boolean;
  containerSize: React.MutableRefObject<number>;
}) {
  const { setSplitRatio } = useMultiPaneStore();
  const startRatio = useRef(splitNode.ratio);

  const pan = Gesture.Pan()
    .onBegin(() => {
      startRatio.current = splitNode.ratio;
    })
    .onUpdate((e) => {
      const size = containerSize.current;
      if (size <= 0) return;
      const delta = isHorizontal ? e.translationX : e.translationY;
      const newRatio = startRatio.current + delta / size;
      setSplitRatio(splitNode.id, newRatio);
    })
    .hitSlop({ horizontal: 12, vertical: 12 });

  return (
    <GestureDetector gesture={pan}>
      <View
        style={[
          isHorizontal ? styles.dividerV : styles.dividerH,
          isHorizontal ? styles.dividerVHit : styles.dividerHHit,
        ]}
      />
    </GestureDetector>
  );
}

/** Recursively render the pane tree */
function PaneTreeNode({ node }: { node: PaneNode }) {
  const { setLeafTab, splitPane, removePane, root, maxPanes } = useMultiPaneStore();
  const containerSize = useRef(0);

  if (node.type === 'leaf') {
    const leafCount = root ? countLeavesQuick(root) : 1;
    return (
      <PaneSlot
        leafId={node.id}
        tab={node.tab}
        onChangeTab={(tab) => setLeafTab(node.id, tab)}
        onRemove={() => removePane(node.id)}
        onSplitH={(tab) => splitPane(node.id, 'horizontal', tab)}
        onSplitV={(tab) => splitPane(node.id, 'vertical', tab)}
        canSplit={leafCount < maxPanes}
      />
    );
  }

  const isHorizontal = node.direction === 'horizontal';

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    containerSize.current = isHorizontal ? width : height;
  }, [isHorizontal]);

  return (
    <View
      style={[styles.split, isHorizontal ? styles.splitH : styles.splitV]}
      onLayout={onLayout}
    >
      <View style={{ flex: node.ratio }}>
        <PaneTreeNode node={node.children[0]} />
      </View>
      <Divider
        splitNode={node}
        isHorizontal={isHorizontal}
        containerSize={containerSize}
      />
      <View style={{ flex: 1 - node.ratio }}>
        <PaneTreeNode node={node.children[1]} />
      </View>
    </View>
  );
}

function countLeavesQuick(node: PaneNode): number {
  if (node.type === 'leaf') return 1;
  return countLeavesQuick(node.children[0]) + countLeavesQuick(node.children[1]);
}

export function MultiPaneContainer() {
  const { root } = useMultiPaneStore();

  if (!root) return null;

  return (
    <View style={styles.root}>
      <PaneTreeNode node={root} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bgDeep,
  },
  split: {
    flex: 1,
  },
  splitH: {
    flexDirection: 'row',
  },
  splitV: {
    flexDirection: 'column',
  },
  dividerV: {
    width: 3,
    backgroundColor: C.border,
  },
  dividerH: {
    height: 3,
    backgroundColor: C.border,
  },
  dividerVHit: {
    paddingHorizontal: 6,
    marginHorizontal: -6,
  },
  dividerHHit: {
    paddingVertical: 6,
    marginVertical: -6,
  },
});
