import React, { useCallback, useRef } from 'react';
import { View, StyleSheet, LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useMultiPaneStore, type PaneNode, type PaneSplit, type PaneLeaf } from '@/hooks/use-multi-pane';
import { PaneSlot } from './PaneSlot';
import { colors as C } from '@/theme.config';

/** Draggable divider between two panes (12px invisible hit area) */
function Divider({
  splitNode,
  isHorizontal,
  containerSize,
}: {
  splitNode: PaneSplit;
  isHorizontal: boolean;
  containerSize: React.MutableRefObject<number>;
}) {
  const { setSplitRatio, resetSplitRatio } = useMultiPaneStore();
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
    });

  // Double-tap = reset to 50/50
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      resetSplitRatio(splitNode.id);
    });

  const composed = Gesture.Race(pan, doubleTap);

  return (
    <GestureDetector gesture={composed}>
      <View style={isHorizontal ? styles.dividerV : styles.dividerH}>
        {/* 1px visible line centered in the 12px hit area */}
        <View style={isHorizontal ? styles.dividerVLine : styles.dividerHLine} />
      </View>
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

/** Find a leaf by id in the tree */
function findLeafById(node: PaneNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null;
  return findLeafById(node.children[0], id) ?? findLeafById(node.children[1], id);
}

export function MultiPaneContainer() {
  const { root, maximizedPaneId } = useMultiPaneStore();

  if (!root) return null;

  // Fullscreen mode: render only the maximized leaf
  if (maximizedPaneId) {
    const leaf = findLeafById(root, maximizedPaneId);
    if (leaf) {
      return (
        <View style={styles.root}>
          <PaneTreeNode node={leaf} />
        </View>
      );
    }
  }

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
  // 12px hit area with a 1px visible line centered
  dividerV: {
    width: 12,
    marginHorizontal: -6,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  dividerH: {
    height: 12,
    marginVertical: -6,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  dividerVLine: {
    width: 1,
    height: '100%',
    backgroundColor: C.border,
  },
  dividerHLine: {
    height: 1,
    width: '100%',
    backgroundColor: C.border,
  },
});
