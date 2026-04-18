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
import Animated, { runOnJS, useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
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
  // `active` drives the visual feedback — line brightens, grip glows,
  // grip scales up ~10% — while the user is dragging. Goes back to a
  // calm idle state on release.
  const active = useSharedValue(0);
  // Throttle JS-thread updates to avoid flooding Zustand with 60+ set()
  // calls per second. The last value is always flushed in onFinalize so
  // the drop position is never lost.
  const lastJsUpdate = useSharedValue(0);
  const latestRatio = useSharedValue(currentRatio);

  const handleUpdate = (newRatio: number): void => {
    onRatioChange(ratioKey, newRatio);
  };

  const handleReset = (): void => {
    onReset(ratioKey);
  };

  const isVertical = kind === 'vertical';

  const THROTTLE_MS = 32; // ~30fps for JS-thread updates (UI stays 60fps)

  const pan = Gesture.Pan()
    .onStart(() => {
      'worklet';
      startRatio.value = currentRatio;
      lastJsUpdate.value = 0;
      active.value = withTiming(1, { duration: 120 });
    })
    .onUpdate((e) => {
      'worklet';
      const cSize = cSizeSV.value;
      if (cSize <= 0) return;
      const delta = isVertical ? e.translationX : e.translationY;
      const newRatio = startRatio.value + delta / cSize;
      latestRatio.value = newRatio;
      const now = Date.now();
      if (now - lastJsUpdate.value >= THROTTLE_MS) {
        lastJsUpdate.value = now;
        runOnJS(handleUpdate)(newRatio);
      }
    })
    .onFinalize(() => {
      'worklet';
      // Always flush the final ratio so the drop position is exact
      runOnJS(handleUpdate)(latestRatio.value);
      active.value = withTiming(0, { duration: 180 });
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

  const lineAnimStyle = useAnimatedStyle(() => ({
    // Line lights up from a faint 0.18 opacity teal wash to a full
    // neon teal during drag. Thickness also grows 1 → 2px for a
    // subtle "I caught you" feel.
    opacity: 0.18 + 0.7 * active.value,
    transform: [{ scaleX: isVertical ? 1 + active.value : 1 }, { scaleY: isVertical ? 1 : 1 + active.value }],
  }));

  const gripAnimStyle = useAnimatedStyle(() => ({
    // Grip scales 1 → 1.1 and the glow intensifies while dragging.
    transform: [{ scale: 1 + 0.1 * active.value }],
    shadowOpacity: 0.3 + 0.5 * active.value,
    shadowRadius: 4 + 8 * active.value,
  }));

  const barAnimStyle = useAnimatedStyle(() => ({
    // Inner bar fades the dots out and in a single capsule highlight.
    opacity: 0.6 + 0.4 * active.value,
  }));

  return (
    <GestureDetector gesture={composed}>
      <View style={[styles.hit, hitStyle]} pointerEvents="box-only">
        <Animated.View style={[isVertical ? styles.lineV : styles.lineH, lineAnimStyle]} />
        <Animated.View style={[isVertical ? styles.gripV : styles.gripH, gripAnimStyle]}>
          <Animated.View style={[isVertical ? styles.barV : styles.barH, barAnimStyle]} />
        </Animated.View>
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
  // Idle lines are 1px and dim; the animated opacity + scale on the
  // container pops them to 2px + full teal neon when the user grabs.
  lineV: {
    position: 'absolute',
    width: 1,
    height: '100%',
    backgroundColor: C.accent,
  },
  lineH: {
    position: 'absolute',
    height: 1,
    width: '100%',
    backgroundColor: C.accent,
  },
  // Grip: pill-shaped, translucent dark with a neon teal border and a
  // teal shadow so it reads as a floating capsule. Native shadow works
  // on iOS; Android falls back to elevation for a comparable lift.
  gripV: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 6,
    height: 36,
    borderRadius: 3,
    backgroundColor: 'rgba(0,212,170,0.10)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,212,170,0.7)',
    shadowColor: C.accent,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  gripH: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 36,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(0,212,170,0.10)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,212,170,0.7)',
    shadowColor: C.accent,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  // Inner bar: a bright capsule highlight running the length of the
  // grip so there's a second visual cue (line + bar) during drag.
  barV: {
    width: 2,
    height: 22,
    borderRadius: 1,
    backgroundColor: C.accent,
  },
  barH: {
    width: 22,
    height: 2,
    borderRadius: 1,
    backgroundColor: C.accent,
  },
});
