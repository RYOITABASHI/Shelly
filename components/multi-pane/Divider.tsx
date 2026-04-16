// components/multi-pane/Divider.tsx
//
// Absolute-positioned draggable divider used by MultiPaneContainer.
//
// Design contract (v0.1.1):
//  - The parent computes a rect in container-local pixels and passes it as
//    props. This component never uses negative margin (bug #30) — it lays
//    itself out via `position: 'absolute'` with a 16px hit strip centred on
//    the actual split line.
//  - Gesture.Pan runs on the UI thread. Under no circumstance may the
//    worklet call Zustand setters directly (bug #31). We wrap every JS-land
//    callback in `runOnJS(...)` before invoking it from the worklet.
//  - At most two Divider instances exist per preset, so worklet boundaries
//    are tightly bounded.

import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import type { Ratios } from '@/hooks/use-multi-pane';
import { colors as C } from '@/theme.config';

export type DividerProps = {
  kind: 'vertical' | 'horizontal';
  /** Container-local origin of the split line (pixel coords, pre-expansion). */
  x: number;
  y: number;
  /** For a vertical divider, the line height. */
  h?: number;
  /** For a horizontal divider, the line width. */
  w?: number;
  /** Which ratio key this divider controls. */
  ratioKey: keyof Ratios;
  /** Current ratio (0..1) — used to reconstruct start offset on pan. */
  currentRatio: number;
  /** Container dimension this ratio is expressed against (px). */
  containerSize: number;
  /** JS-thread callback: apply a new ratio (unclamped — store will clamp). */
  onRatioChange: (key: keyof Ratios, value: number) => void;
  /** JS-thread callback: double-tap reset to 0.5. */
  onReset: (key: keyof Ratios) => void;
};

const HIT = 16;
const HALF = HIT / 2;

export function Divider(props: DividerProps) {
  const {
    kind, x, y, h = 0, w = 0,
    ratioKey, currentRatio, containerSize,
    onRatioChange, onReset,
  } = props;

  const startRatio = useSharedValue(currentRatio);
  const cSizeSV = useSharedValue(containerSize);
  cSizeSV.value = containerSize;

  const handleUpdate = (newRatio: number): void => {
    onRatioChange(ratioKey, newRatio);
  };

  const handleReset = (): void => {
    onReset(ratioKey);
  };

  const isVertical = kind === 'vertical';

  const pan = Gesture.Pan()
    .onStart(() => {
      'worklet';
      startRatio.value = currentRatio;
    })
    .onUpdate((e) => {
      'worklet';
      const cSize = cSizeSV.value;
      if (cSize <= 0) return;
      const delta = isVertical ? e.translationX : e.translationY;
      const newRatio = startRatio.value + delta / cSize;
      runOnJS(handleUpdate)(newRatio);
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      'worklet';
      runOnJS(handleReset)();
    });

  const composed = Gesture.Race(pan, doubleTap);

  // Build the absolute rect for the hit strip. The split line itself has
  // zero thickness, so we centre a 16px strip over it.
  const hitStyle = isVertical
    ? {
        position: 'absolute' as const,
        left: x - HALF,
        top: y,
        width: HIT,
        height: h,
      }
    : {
        position: 'absolute' as const,
        top: y - HALF,
        left: x,
        height: HIT,
        width: w,
      };

  if ((isVertical && h <= 0) || (!isVertical && w <= 0)) return null;

  return (
    <GestureDetector gesture={composed}>
      <View style={[styles.hit, hitStyle]} pointerEvents="box-only">
        <View style={isVertical ? styles.lineV : styles.lineH} />
        <View style={isVertical ? styles.gripV : styles.gripH}>
          <View style={styles.dot} />
          <View style={styles.dot} />
          <View style={styles.dot} />
        </View>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  hit: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  lineV: {
    position: 'absolute',
    width: 2,
    height: '100%',
    backgroundColor: 'rgba(0,212,170,0.45)',
  },
  lineH: {
    position: 'absolute',
    height: 2,
    width: '100%',
    backgroundColor: 'rgba(0,212,170,0.45)',
  },
  gripV: {
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    width: 10,
    height: 28,
    borderRadius: 3,
    backgroundColor: C.bgSurface,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.55)',
    gap: 2,
  },
  gripH: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 10,
    borderRadius: 3,
    backgroundColor: C.bgSurface,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.55)',
    gap: 2,
  },
  dot: {
    width: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: C.accent,
  },
});
