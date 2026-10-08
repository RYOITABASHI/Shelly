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
  resolveSinglePaneSlot,
  type PaneTab,
  type Ratios,
  type SlotIndex,
} from '@/hooks/use-multi-pane';
import { logInfo } from '@/lib/debug-logger';
import { computeKeyboardOverlap } from '@/lib/keyboard-inset';
import { useAddPane } from '@/hooks/use-add-pane';
import { PaneSlot } from './PaneSlot';
import { Divider } from './Divider';
import { PANE_REGISTRY, resolvePaneTitle } from './pane-registry';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { usePaneContentBackground, usePanelBackground } from '@/hooks/use-panel-background';
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

function EmptyPresetSlot() {
  const bg = usePanelBackground(C.bgDeep);
  return (
    <View
      pointerEvents="none"
      style={[
        styles.emptyPresetSlot,
        {
          backgroundColor: bg,
          borderColor: withAlpha(C.border, 0.75),
        },
      ]}
    />
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
  const containerBg = usePaneContentBackground(C.bgDeep);
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

  // Single source of truth for keyboard avoidance across the whole pane
  // grid. Each individual pane used to add its own paddingBottom =
  // keyboardHeight, which double/triple-counted in split layouts and
  // collapsed terminal content to zero height (bug: post-v0.1.0). Now we
  // reserve the space once at the container level so every child pane
  // renders at its natural size.
  //
  // The reserved inset is the *overlap* between this container and the IME
  // (container bottom in window coords minus keyboard top), not a raw
  // keyboard height. targetSdk 36 forces edge-to-edge, so adjustResize does
  // not shrink the root and the IME overlays the window; the old code
  // estimated the height as `Dimensions.get('screen').height - screenY`,
  // and on the unfolded Fold6 'screen' still reported the cover panel's
  // 2376px (819dp) instead of the inner 2160px (745dp), so it reserved
  // ~448dp for a ~346dp overlap and left an empty band above the keyboard.
  // See lib/keyboard-inset.ts.
  const insets = useSafeAreaInsets();
  const rootRef = useRef<View>(null);
  const [containerBottom, setContainerBottom] = useState<number | null>(null);
  const [keyboard, setKeyboard] = useState<{ top: number; height: number } | null>(null);

  const measureContainer = useCallback(() => {
    const node = rootRef.current;
    if (!node || typeof node.measureInWindow !== 'function') return;
    node.measureInWindow((_x, y, _w, h) => {
      if (!Number.isFinite(y) || !Number.isFinite(h) || h <= 0) return;
      const bottom = y + h;
      setContainerBottom((prev) => (prev !== null && Math.abs(prev - bottom) <= 0.5 ? prev : bottom));
    });
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const apply = (coords: { screenY?: number; height?: number } | undefined | null, reason: string) => {
      const height = coords?.height ?? 0;
      const top = coords?.screenY ?? 0;
      setKeyboard((prev) => {
        const next = height > 0 ? { top, height } : null;
        if (prev === next) return prev;
        if (prev && next && Math.abs(prev.top - next.top) <= 0.5 && Math.abs(prev.height - next.height) <= 0.5) {
          return prev;
        }
        logInfo('Keyboard', 'metrics', { reason, top, height, insetsBottom: insets.bottom });
        return next;
      });
    };

    const show = Keyboard.addListener('keyboardDidShow', (e) => {
      apply(e.endCoordinates, 'didShow');
      // Re-measure in case the OS did resize the window for the IME.
      requestAnimationFrame(measureContainer);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      apply(null, 'didHide');
    });
    // Some Android 15 / OEM keyboard combinations show the IME while
    // React Native never emits keyboardDidShow for the current served view.
    // Poll the platform metrics lightly while the pane grid is mounted so
    // the terminal key bar stays above the keyboard instead of disappearing
    // behind it. Keyboard.metrics() is undefined while the IME is hidden.
    const sync = (reason: string) => apply((Keyboard as any).metrics?.(), reason);
    const interval = setInterval(() => sync('interval'), 250);
    requestAnimationFrame(() => sync('mount-frame'));
    return () => {
      show.remove();
      hide.remove();
      clearInterval(interval);
    };
  }, [insets.bottom, measureContainer]);

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((prev) => {
      if (prev.W === width && prev.H === height) return prev;
      return { W: width, H: height };
    });
    measureContainer();
  }, [measureContainer]);

  if (!hasHydrated) {
    return <View ref={rootRef} style={[styles.root, { backgroundColor: containerBg }]} onLayout={onContainerLayout} />;
  }

  const usedCount = slots.filter((s) => s !== null).length;
  if (usedCount === 0) {
    return (
      <View style={[styles.root, { backgroundColor: containerBg }]}>
        <EmptyState />
      </View>
    );
  }

  const effectiveKeyboardHeight = computeKeyboardOverlap({
    containerBottom,
    keyboardTop: keyboard?.top,
    keyboardHeight: keyboard?.height,
    bottomInset: insets.bottom,
  });
  const gridHeight = size.H > 0 ? Math.max(0, size.H - effectiveKeyboardHeight) : 0;

  // Maximized path — render the maximized slot full-screen.
  if (maximized !== null && slots[maximized]) {
    const slot = slots[maximized]!;
    return (
      <View
        ref={rootRef}
        style={[styles.root, { paddingBottom: effectiveKeyboardHeight, backgroundColor: containerBg }]}
        onLayout={onContainerLayout}
      >
        <View
          style={[styles.slotAbs, { left: 0, top: 0, width: size.W, height: gridHeight }]}
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

  const renderPreset = size.W > 0 && size.W < 380 ? 'p1' : preset;
  const { slotRects, dividers } = getLayout(renderPreset, ratios, size.W, gridHeight);
  const singlePaneSlot = renderPreset === 'p1' ? resolveSinglePaneSlot(slots, focusedSlot) : null;
  return (
    <View
      ref={rootRef}
      style={[styles.root, { paddingBottom: effectiveKeyboardHeight, backgroundColor: containerBg }]}
      onLayout={onContainerLayout}
    >
      {slots.map((slot, i) => {
        if (singlePaneSlot !== null && i !== singlePaneSlot) return null;
        const rect = singlePaneSlot !== null
          ? { x: 0, y: 0, w: size.W, h: gridHeight }
          : slotRects[i as SlotIndex];
        // Skip render until we have a real size — first frame would place
        // every slot at (0,0,0,0) which the children don't like.
        if (rect.w <= 0 || rect.h <= 0) return null;
        if (!slot) {
          if (i >= PRESET_CAPACITY[renderPreset]) return null;
          return (
            <View
              key={`empty-${renderPreset}-${i}`}
              style={[
                styles.slotAbs,
                { left: rect.x, top: rect.y, width: rect.w, height: rect.h },
              ]}
            >
              <EmptyPresetSlot />
            </View>
          );
        }
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
            key={`${renderPreset}-${d.kind}-${d.ratioKey}-${idx}`}
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
  emptyPresetSlot: {
    flex: 1,
    borderWidth: S.borderWidth,
  },
});
