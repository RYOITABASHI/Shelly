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
  Dimensions,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import {
  useMultiPaneStore,
  getLayout,
  PRESET_CAPACITY,
  resolveSinglePaneSlot,
  type PaneTab,
  type Ratios,
  type SlotIndex,
} from '@/hooks/use-multi-pane';
import { logInfo } from '@/lib/debug-logger';
import { useAddPane } from '@/hooks/use-add-pane';
import { PaneSlot } from './PaneSlot';
import { Divider } from './Divider';
import { PANE_REGISTRY, resolvePaneTitle } from './pane-registry';
import { colors as C, fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { usePanelBackground } from '@/hooks/use-panel-background';
import { useTranslation } from '@/lib/i18n';

/** Fallback used only if persist somehow restores an empty slots array.
 *  removePane refuses to delete the last slot, so this is defensive. */
function EmptyState() {
  const { t } = useTranslation();
  const addPane = useAddPane();
  const options: PaneTab[] = ['terminal', 'ai', 'agent-chat', 'browser'];
  return (
    <View style={emptyStyles.root}>
      <Text style={emptyStyles.title}>{t('pane.empty_title')}</Text>
      <Text style={emptyStyles.subtitle}>{t('pane.empty_subtitle')}</Text>
      <View style={emptyStyles.row}>
        {options.map((tab) => (
          <Pressable
            key={tab}
            style={emptyStyles.btn}
            onPress={() => addPane(tab)}
          >
            <MaterialIcons name={PANE_REGISTRY[tab].icon as any} size={18} color={C.accent} />
            <Text style={emptyStyles.btnLabel}>{resolvePaneTitle(tab, t)}</Text>
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
    backgroundColor: 'transparent',
    gap: 12,
  },
  title: {
    color: C.accent,
    fontFamily: F.family,
    fontSize: 10,
    letterSpacing: 1,
    textShadowColor: withAlpha(C.accent, 0.9),
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
    borderColor: withAlpha(C.accent, 0.45),
    backgroundColor: withAlpha(C.accent, 0.08),
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
  const containerBg = usePanelBackground(C.bgDeep);
  // Bug #64 — wait for persist rehydration before rendering any pane chrome.
  // Without this, a force-stop/relaunch cycle can briefly flash the
  // EmptyState (or stale slots) before restored state arrives, which in
  // turn tears down pane headers (back / layout buttons).
  const hasHydrated  = useMultiPaneStore((s) => s._hasHydrated);
  const preset       = useMultiPaneStore((s) => s.preset);
  const slots        = useMultiPaneStore((s) => s.slots);
  const focusedSlot  = useMultiPaneStore((s) => s.focusedSlot);
  const ratios       = useMultiPaneStore((s) => s.ratios);
  const maximized    = useMultiPaneStore((s) => s.maximizedSlot);
  const setLeafTab   = useMultiPaneStore((s) => s.setLeafTab);
  const removePane   = useMultiPaneStore((s) => s.removePane);
  const splitPane    = useMultiPaneStore((s) => s.splitPane);
  const setRatio     = useMultiPaneStore((s) => s.setRatio);
  const resetRatio   = useMultiPaneStore((s) => s.resetRatio);

  const [size, setSize] = useState({ W: 0, H: 0 });
  const [keyboardFreeHeight, setKeyboardFreeHeight] = useState(0);
  const keyboardFreeWidthRef = useRef(0);

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
    const syncKeyboardMetrics = (reason: string) => {
      const metrics = (Keyboard as any).metrics?.();
      const screenHeight = Dimensions.get('screen').height;
      const inferredFromY =
        typeof metrics?.screenY === 'number'
          ? Math.max(0, screenHeight - metrics.screenY)
          : 0;
      const raw = Math.max(metrics?.height ?? 0, inferredFromY);
      const adjusted = Math.max(0, raw - insets.bottom);
      setKeyboardHeight((prev) => {
        if (Math.abs(prev - adjusted) <= 2) return prev;
        logInfo('Keyboard', 'syncMetrics', {
          reason,
          raw,
          inferredFromY,
          insetsBottom: insets.bottom,
          adjusted,
          metrics,
        });
        return adjusted;
      });
    };

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
      requestAnimationFrame(() => syncKeyboardMetrics('didShow-frame'));
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      logInfo('Keyboard', 'didHide');
      setKeyboardHeight(0);
    });
    // Some Android 15 / OEM keyboard combinations show the IME while
    // React Native never emits keyboardDidShow for the current served view.
    // Poll the platform metrics lightly while the pane grid is mounted so
    // the terminal key bar stays above the keyboard instead of disappearing
    // behind it.
    const interval = setInterval(() => syncKeyboardMetrics('interval'), 250);
    requestAnimationFrame(() => syncKeyboardMetrics('mount-frame'));
    return () => {
      show.remove();
      hide.remove();
      clearInterval(interval);
    };
  }, [insets.bottom]);

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setKeyboardFreeHeight((prev) => {
      const widthChanged = keyboardFreeWidthRef.current > 0 &&
        Math.abs(width - keyboardFreeWidthRef.current) > 2;
      if (prev <= 0 || height > prev || (keyboardHeight <= 0 && widthChanged)) {
        keyboardFreeWidthRef.current = width;
        return height;
      }
      // If adjustResize fires before keyboardDidShow/metrics, the first
      // reduced layout can arrive while keyboardHeight is still 0. Keep the
      // previous taller baseline so the later keyboard height is not
      // subtracted a second time.
      if (keyboardHeight <= 0 && height >= prev - 48) {
        keyboardFreeWidthRef.current = width;
        return height;
      }
      return prev;
    });
    setSize((prev) => {
      if (prev.W === width && prev.H === height) return prev;
      return { W: width, H: height };
    });
  }, [keyboardHeight]);

  if (!hasHydrated) {
    return <View style={[styles.root, { backgroundColor: containerBg }]} onLayout={onContainerLayout} />;
  }

  const usedCount = slots.filter((s) => s !== null).length;
  if (usedCount === 0) {
    return (
      <View style={[styles.root, { backgroundColor: containerBg }]}>
        <EmptyState />
      </View>
    );
  }

  // Maximized path — render the maximized slot full-screen.
  if (maximized !== null && slots[maximized]) {
    const slot = slots[maximized]!;
    return (
      <View style={[styles.root, { backgroundColor: containerBg }]} onLayout={onContainerLayout}>
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

  // Shrink the usable height by the keyboard size only when the Android
  // window did not already resize. On One UI with adjustResize, the root
  // layout height is already reduced; subtracting keyboardHeight again
  // leaves the panes crushed into the top half with a large empty gap.
  const alreadyResizedForIme = keyboardHeight > 0 && size.H > 0 &&
    keyboardFreeHeight > 0 &&
    keyboardFreeHeight - size.H > Math.max(80, keyboardHeight * 0.35);
  const effectiveKeyboardHeight = alreadyResizedForIme ? 0 : keyboardHeight;
  const gridHeight = size.H > 0 ? Math.max(0, size.H - effectiveKeyboardHeight) : 0;
  const { slotRects, dividers } = getLayout(preset, ratios, size.W, gridHeight);
  const singlePaneSlot = preset === 'p1' ? resolveSinglePaneSlot(slots, focusedSlot) : null;

  return (
    <View
      style={[styles.root, { paddingBottom: effectiveKeyboardHeight, backgroundColor: containerBg }]}
      onLayout={onContainerLayout}
    >
      {slots.map((slot, i) => {
        if (!slot) return null;
        if (singlePaneSlot !== null && i !== singlePaneSlot) return null;
        const rect = singlePaneSlot !== null
          ? { x: 0, y: 0, w: size.W, h: gridHeight }
          : slotRects[i as SlotIndex];
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
        const containerSize = isVertical ? size.W : gridHeight;
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
