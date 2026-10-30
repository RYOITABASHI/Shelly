// components/multi-pane/PaneSwapPicker.tsx
//
// "Swap with…" picker. Shows the current layout as a mini diagram (one cell
// per laid-out slot, drawn with the same pure getLayout() the grid uses) and
// swaps the source pane with whichever cell is tapped. No confirm step: a
// swap is undone by swapping again.

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import {
  useMultiPaneStore,
  getLayout,
  PRESET_CAPACITY,
  type PresetId,
} from '@/hooks/use-multi-pane';
import { PANE_REGISTRY, resolvePaneTitle } from './pane-registry';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';
import { createThemedStyles } from '@/lib/themed-stylesheet';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';

const DIAGRAM_W = 200;
const DIAGRAM_H = 128;
const CELL_GAP = 3;

type Props = {
  visible: boolean;
  sourceLeafId: string;
  layoutPreset: PresetId | null;
  onClose: () => void;
};

export function PaneSwapPicker({ visible, sourceLeafId, layoutPreset, onClose }: Props) {
  const { t } = useTranslation();
  const slots = useMultiPaneStore((s) => s.slots);
  const ratios = useMultiPaneStore((s) => s.ratios);

  if (!visible || !layoutPreset || layoutPreset === 'p1') return null;

  const { slotRects } = getLayout(layoutPreset, ratios, DIAGRAM_W, DIAGRAM_H);
  const cap = PRESET_CAPACITY[layoutPreset];

  const handleSwap = (targetLeafId: string) => {
    useMultiPaneStore.getState().swapPanes(sourceLeafId, targetLeafId);
    onClose();
  };

  return (
    <Pressable style={styles.backdrop} onPress={onClose} testID="pane-swap-backdrop">
      <Pressable
        style={[styles.menu, { backgroundColor: C.bgSurface, borderColor: C.border }]}
        onPress={(e) => e.stopPropagation()}
      >
        <Text style={[styles.title, { color: C.text2 }]}>{t('pane.swap_title')}</Text>
        <Text style={[styles.hint, { color: C.text2 }]}>{t('pane.swap_hint')}</Text>
        <View style={[styles.diagram, { width: DIAGRAM_W, height: DIAGRAM_H }]}>
          {slotRects.slice(0, cap).map((rect, i) => {
            const slot = slots[i];
            const cellStyle = {
              left: rect.x + CELL_GAP / 2,
              top: rect.y + CELL_GAP / 2,
              width: Math.max(0, rect.w - CELL_GAP),
              height: Math.max(0, rect.h - CELL_GAP),
            };
            if (!slot) {
              return (
                <View
                  key={`empty-${i}`}
                  testID={`pane-swap-cell-${i}`}
                  style={[styles.cell, cellStyle, { borderColor: withAlpha(C.border, 0.6), borderStyle: 'dashed' }]}
                />
              );
            }
            const isSource = slot.id === sourceLeafId;
            const title = resolvePaneTitle(slot.tab, t);
            const icon = PANE_REGISTRY[slot.tab]?.icon ?? 'crop-square';
            return (
              <Pressable
                key={slot.id}
                testID={`pane-swap-cell-${i}`}
                disabled={isSource}
                onPress={isSource ? undefined : () => handleSwap(slot.id)}
                accessibilityRole="button"
                accessibilityState={{ disabled: isSource }}
                accessibilityLabel={isSource ? t('pane.swap_this_pane') : t('pane.swap_cell_a11y', { title })}
                style={({ pressed }) => [
                  styles.cell,
                  cellStyle,
                  {
                    borderColor: isSource ? C.accent : withAlpha(C.accent, 0.4),
                    backgroundColor: isSource
                      ? withAlpha(C.accent, 0.22)
                      : withAlpha(C.accent, pressed ? 0.2 : 0.07),
                  },
                ]}
              >
                <MaterialIcons name={icon as any} size={14} color={isSource ? C.accent : C.text1} />
                <Text style={[styles.cellLabel, { color: isSource ? C.accent : C.text1 }]} numberOfLines={1}>
                  {isSource ? t('pane.swap_this_pane') : title}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Pressable>
    </Pressable>
  );
}

const styles = createThemedStyles(() => ({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  menu: {
    backgroundColor: C.bgSurface,
    borderRadius: 10,
    padding: 10,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    alignItems: 'center',
  },
  title: {
    color: C.text2,
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    textTransform: 'uppercase',
    letterSpacing: 1,
    fontWeight: F.paneHeader.weight,
    alignSelf: 'flex-start',
  },
  hint: {
    color: C.text2,
    fontSize: 10,
    fontFamily: F.family,
    marginTop: 2,
    marginBottom: 8,
    alignSelf: 'flex-start',
  },
  diagram: {
    position: 'relative',
  },
  cell: {
    position: 'absolute',
    borderWidth: 1,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingHorizontal: 2,
    overflow: 'hidden',
  },
  cellLabel: {
    fontSize: 9,
    fontFamily: F.family,
    fontWeight: '700',
  },
}));
