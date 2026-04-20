// components/multi-pane/MultiPaneContainer.tsx
//
// v0.1.1 — preset-based layout container.
//
// Reads the flat `slots[4]` + `preset` + `ratios` from useMultiPaneStore and
// lays each non-null slot out with absolute positioning via the pure
// `getLayout()` function. Divider components are placed over the split
// boundaries with a 16px hit strip.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  Keyboard,
  Platform,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import {
  useMultiPaneStore,
  getLayout,
  PRESET_CAPACITY,
  type PaneTab,
  type PresetId,
  type Ratios,
  type SlotIndex,
} from '@/hooks/use-multi-pane';
import { logInfo } from '@/lib/debug-logger';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useAddPane } from '@/hooks/use-add-pane';
import { PaneSlot } from './PaneSlot';
import { Divider } from './Divider';
import { colors as C, fonts as F } from '@/theme.config';

/** Fallback used only if persist somehow restores an empty slots array.
 *  removePane refuses to delete the last slot, so this is defensive. */
function EmptyState() {
  const addPane = useAddPane();
  const options: { tab: PaneTab; label: string; icon: string }[] = [
    { tab: 'terminal', label: 'Terminal', icon: 'terminal' },
    { tab: 'ai',       label: 'AI Chat',  icon: 'auto-awesome' },
    { tab: 'browser',  label: 'Browser',  icon: 'language' },
  ];
  return (
    <View style={emptyStyles.root}>
      <Text style={emptyStyles.title}>NO PANES OPEN</Text>
      <Text style={emptyStyles.subtitle}>Add a pane to get started</Text>
      <View style={emptyStyles.row}>
        {options.map((opt) => (
          <Pressable
            key={opt.tab}
            style={emptyStyles.btn}
            onPress={() => addPane(opt.tab)}
          >
            <MaterialIcons name={opt.icon as any} size={18} color={C.accent} />
            <Text style={emptyStyles.btnLabel}>{opt.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.bgDeep,
    gap: 12,
  },
  title: {
    color: C.accent,
    fontFamily: F.family,
    fontSize: 10,
    letterSpacing: 1,
    textShadowColor: 'rgba(0,212,170,0.9)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
  subtitle: {
    color: C.text2,
    fontFamily: F.family,
    fontSize: 7,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.45)',
    backgroundColor: 'rgba(0,212,170,0.08)',
  },
  btnLabel: {
    color: C.accent,
    fontFamily: F.family,
    fontSize: 8,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});

export function MultiPaneContainer() {
  // Bug #64 — wait for persist rehydration before rendering any pane chrome.
  // Without this, a force-stop/relaunch cycle can briefly flash the
  // EmptyState (or stale slots) before restored state arrives, which in
  // turn tears down pane headers (back / layout buttons).
  const hasHydrated  = useMultiPaneStore((s) => s._hasHydrated);
  const preset       = useMultiPaneStore((s) => s.preset);
  const slots        = useMultiPaneStore((s) => s.slots);
  const ratios       = useMultiPaneStore((s) => s.ratios);
  const maximized    = useMultiPaneStore((s) => s.maximizedSlot);
  const setLeafTab   = useMultiPaneStore((s) => s.setLeafTab);
  const removePane   = useMultiPaneStore((s) => s.removePane);
  const splitPane    = useMultiPaneStore((s) => s.splitPane);
  const setRatio     = useMultiPaneStore((s) => s.setRatio);
  const resetRatio   = useMultiPaneStore((s) => s.resetRatio);
  const setPreset    = useMultiPaneStore((s) => s.setPreset);

  const { isWide } = useDeviceLayout();

  // Auto-reorient horizontally-biased presets when the Z Fold 6 (or any
  // foldable) closes into the narrow cover screen. 2-cols side-by-side
  // reads as two very thin slits once the width collapses past ~380dp,
  // so swap to a top/bottom stack that keeps each pane legible.
  // Mapping: p2h → p2v, p3l / p3r → p3t. Leave p1 / p2v / p3t / p4 alone
  // (already vertical-friendly) and don't auto-swap *back* to horizontal
  // when reopening — the user may have deliberately picked vertical on
  // the inner screen too.
  const prevWideRef = useRef(isWide);
  useEffect(() => {
    const wasWide = prevWideRef.current;
    prevWideRef.current = isWide;
    if (wasWide && !isWide) {
      const reorient: Partial<Record<PresetId, PresetId>> = {
        p2h: 'p2v',
        p3l: 'p3t',
        p3r: 'p3t',
      };
      const next = reorient[preset];
      if (next && next !== preset) setPreset(next);
    }
  }, [isWide, preset, setPreset]);

  const [size, setSize] = useState({ W: 0, H: 0 });

  // Single source of truth for keyboard avoidance across the whole pane
  // grid. Each individual pane used to add its own paddingBottom =
  // keyboardHeight, which double/triple-counted in split layouts and
  // collapsed terminal content to zero height (bug: post-v0.1.0). Now we
  // reserve the space once at the container level so every child pane
  // renders at its natural size.
  const insets = useSafeAreaInsets();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    // bug #104 diagnostic: edge-to-edge + adjustResize is not resizing the window
    // on Android 15+. Log raw endCoordinates so we can verify whether
    // keyboardDidShow fires at all and what height is reported.
    logInfo('Keyboard', 'listener attached', { insetsBottom: insets.bottom });
    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      const raw = e.endCoordinates.height;
      const adjusted = Math.max(0, raw - insets.bottom);
      logInfo('Keyboard', 'didShow', {
        raw,
        insetsBottom: insets.bottom,
        adjusted,
        endCoordinates: e.endCoordinates,
      });
      setKeyboardHeight(adjusted);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      logInfo('Keyboard', 'didHide');
      setKeyboardHeight(0);
    });
    return () => { show.remove(); hide.remove(); };
  }, [insets.bottom]);

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) =>
      prev.W === width && prev.H === height ? prev : { W: width, H: height },
    );
  }, []);

  if (!hasHydrated) {
    return <View style={styles.root} onLayout={onContainerLayout} />;
  }

  const usedCount = slots.filter((s) => s !== null).length;
  if (usedCount === 0) {
    return (
      <View style={styles.root}>
        <EmptyState />
      </View>
    );
  }

  // Maximized path — render the maximized slot full-screen.
  if (maximized !== null && slots[maximized]) {
    const slot = slots[maximized]!;
    return (
      <View style={styles.root} onLayout={onContainerLayout}>
        <View
          style={[styles.slotAbs, { left: 0, top: 0, width: size.W, height: size.H }]}
        >
          <PaneSlot
            leafId={slot.id}
            tab={slot.tab}
            onChangeTab={(tab) => setLeafTab(slot.id, tab)}
            onRemove={() => removePane(slot.id)}
            onSplitH={(tab) => splitPane(slot.id, 'horizontal', tab)}
            onSplitV={(tab) => splitPane(slot.id, 'vertical', tab)}
            canSplit={usedCount < PRESET_CAPACITY.p4}
          />
        </View>
      </View>
    );
  }

  // Shrink the usable height by the keyboard size when the IME is up, so
  // the entire grid (terminals + AI + dividers) slides above the keyboard
  // as one unit. Without this, per-pane padding tried to compensate and
  // ended up collapsing content in split layouts.
  const gridHeight = size.H > 0 ? Math.max(0, size.H - keyboardHeight) : 0;
  const { slotRects, dividers } = getLayout(preset, ratios, size.W, gridHeight);

  return (
    <View style={[styles.root, { paddingBottom: keyboardHeight }]} onLayout={onContainerLayout}>
      {slots.map((slot, i) => {
        if (!slot) return null;
        const rect = slotRects[i as SlotIndex];
        // Skip render until we have a real size — first frame would place
        // every slot at (0,0,0,0) which the children don't like.
        if (rect.w <= 0 || rect.h <= 0) return null;
        return (
          <View
            key={slot.id}
            style={[
              styles.slotAbs,
              { left: rect.x, top: rect.y, width: rect.w, height: rect.h },
            ]}
          >
            <PaneSlot
              leafId={slot.id}
              tab={slot.tab}
              onChangeTab={(tab) => setLeafTab(slot.id, tab)}
              onRemove={() => removePane(slot.id)}
              onSplitH={(tab) => splitPane(slot.id, 'horizontal', tab)}
              onSplitV={(tab) => splitPane(slot.id, 'vertical', tab)}
              canSplit={usedCount < PRESET_CAPACITY.p4}
            />
          </View>
        );
      })}

      {size.W > 0 && size.H > 0 && dividers.map((d, idx) => {
        const isVertical = d.kind === 'vertical';
        const containerSize = isVertical ? size.W : size.H;
        const currentRatio = ratios[d.ratioKey as keyof Ratios];
        return (
          <Divider
            key={`${preset}-${d.kind}-${d.ratioKey}-${idx}`}
            kind={d.kind}
            x={d.x}
            y={d.y}
            h={isVertical ? d.h : undefined}
            w={!isVertical ? d.w : undefined}
            ratioKey={d.ratioKey}
            currentRatio={currentRatio}
            containerSize={containerSize}
            onRatioChange={setRatio}
            onReset={resetRatio}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: C.bgDeep,
    position: 'relative',
    overflow: 'hidden',
  },
  slotAbs: {
    position: 'absolute',
  },
});
