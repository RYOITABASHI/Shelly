// components/multi-pane/MultiPaneContainer.tsx
//
// v0.1.1 — preset-based layout container.
//
// Reads the flat `slots[4]` + `preset` + `ratios` from useMultiPaneStore and
// lays each non-null slot out with absolute positioning via the pure
// `getLayout()` function. Divider components are placed over the split
// boundaries with a 16px hit strip.

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  type LayoutChangeEvent,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import {
  useMultiPaneStore,
  getLayout,
  PRESET_CAPACITY,
  type PaneTab,
  type Ratios,
  type SlotIndex,
} from '@/hooks/use-multi-pane';
import { PaneSlot } from './PaneSlot';
import { Divider } from './Divider';
import { colors as C, fonts as F } from '@/theme.config';

/** Fallback used only if persist somehow restores an empty slots array.
 *  removePane refuses to delete the last slot, so this is defensive. */
function EmptyState() {
  const addPane = useMultiPaneStore((s) => s.addPane);
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
  const preset       = useMultiPaneStore((s) => s.preset);
  const slots        = useMultiPaneStore((s) => s.slots);
  const ratios       = useMultiPaneStore((s) => s.ratios);
  const maximized    = useMultiPaneStore((s) => s.maximizedSlot);
  const setLeafTab   = useMultiPaneStore((s) => s.setLeafTab);
  const removePane   = useMultiPaneStore((s) => s.removePane);
  const splitPane    = useMultiPaneStore((s) => s.splitPane);
  const setRatio     = useMultiPaneStore((s) => s.setRatio);
  const resetRatio   = useMultiPaneStore((s) => s.resetRatio);

  const [size, setSize] = useState({ W: 0, H: 0 });

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) =>
      prev.W === width && prev.H === height ? prev : { W: width, H: height },
    );
  }, []);

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

  const { slotRects, dividers } = getLayout(preset, ratios, size.W, size.H);

  return (
    <View style={styles.root} onLayout={onContainerLayout}>
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
