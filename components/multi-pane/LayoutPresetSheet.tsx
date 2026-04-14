// components/multi-pane/LayoutPresetSheet.tsx
//
// v0.1.1 — thin wrapper around <LayoutPicker/>. Kept as a separate component
// so AgentBar / Settings callers don't have to change their imports. The
// actual preset selection UI now lives in LayoutPicker, and the preset
// system is the flat `slots[4]` model in `hooks/use-multi-pane.ts`.
//
// The old v0.1.0 tree-building helpers (`LAYOUT_PRESETS`, `applyLayoutPreset`)
// have been removed — they produced arbitrary `PaneNode` trees which cannot
// be assigned into the new store and would silently fail.

import React from 'react';
import { View, Pressable, StyleSheet, Modal } from 'react-native';
import { LayoutPicker } from './LayoutPicker';
import { useMultiPaneStore, type PresetId } from '@/hooks/use-multi-pane';
import { colors as C, sizes as S } from '@/theme.config';

/** Compat shim: old callers (ShellLayout fold-transition effect) pass
 *  string ids like `'1+2'` or `'single'`. Map them onto the new preset
 *  system and delegate to the store. Unknown ids are ignored. */
export function applyLayoutPreset(id: string): void {
  const map: Record<string, PresetId> = {
    single: 'p1',
    p1: 'p1',
    '2col': 'p2h',
    p2h: 'p2h',
    '2row': 'p2v',
    p2v: 'p2v',
    '1+2': 'p3l',
    p3l: 'p3l',
    p3r: 'p3r',
    p3t: 'p3t',
    '2x2': 'p4',
    '4term': 'p4',
    p4: 'p4',
  };
  const target = map[id];
  if (!target) return;
  useMultiPaneStore.getState().setPreset(target);
}

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function LayoutPresetSheet({ visible, onClose }: Props) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />
          <LayoutPicker onPicked={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
    zIndex: 400,
  },
  sheet: {
    backgroundColor: C.bgSurface,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    borderTopWidth: S.borderWidth,
    borderColor: C.border,
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 24,
  },
  handle: {
    width: 40,
    height: 3,
    borderRadius: 2,
    backgroundColor: C.border,
    alignSelf: 'center',
    marginBottom: 8,
  },
});
