// components/multi-pane/AddPaneSheet.tsx
//
// Bottom sheet for adding a new pane (or opening the file tree sidebar).
// Triggered by the "+" button in AgentBar.

import React from 'react';
import { View, Text, Pressable, StyleSheet, Modal } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useMultiPaneStore, type PaneTab } from '@/hooks/use-multi-pane';
import { usePaneStore } from '@/store/pane-store';
import { useSidebarStore } from '@/store/sidebar-store';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

type Props = {
  visible: boolean;
  onClose: () => void;
};

type SheetOption =
  | { kind: 'pane'; id: PaneTab; label: string; icon: string }
  | { kind: 'sidebar'; id: 'fileTree'; label: string; icon: string };

const OPTIONS: SheetOption[] = [
  { kind: 'pane', id: 'terminal', label: 'Terminal',    icon: 'terminal' },
  { kind: 'pane', id: 'ai',       label: 'AI Chat',     icon: 'auto-awesome' },
  { kind: 'pane', id: 'browser',  label: 'Browser',     icon: 'language' },
  { kind: 'pane', id: 'preview',  label: 'Preview',     icon: 'preview' },
  { kind: 'pane', id: 'markdown', label: 'Markdown',    icon: 'description' },
  { kind: 'sidebar', id: 'fileTree', label: 'File Tree', icon: 'folder-open' },
];

export function AddPaneSheet({ visible, onClose }: Props) {
  const handleSelect = (opt: SheetOption) => {
    if (opt.kind === 'sidebar') {
      // Open the sidebar expanded; the File Tree section is open by default.
      const store = useSidebarStore.getState();
      store.setMode('expanded');
      if (!store.openSections.files) {
        store.toggleSection('files');
      }
      onClose();
      return;
    }

    // Add a new pane: split the focused leaf (or the root leaf)
    const { root, splitPane } = useMultiPaneStore.getState();
    if (!root) {
      onClose();
      return;
    }

    const focusedId = usePaneStore.getState().focusedPaneId;
    const targetLeafId = focusedId ?? findFirstLeafId(root);
    if (!targetLeafId) {
      onClose();
      return;
    }

    splitPane(targetLeafId, 'horizontal', opt.id);
    onClose();
  };

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
          <Text style={styles.title}>ADD PANE</Text>
          {OPTIONS.map((opt) => (
            <Pressable
              key={`${opt.kind}-${opt.id}`}
              style={styles.option}
              onPress={() => handleSelect(opt)}
            >
              <View style={styles.optionIcon}>
                <MaterialIcons name={opt.icon as any} size={18} color={C.accent} />
              </View>
              <Text style={styles.optionLabel}>{opt.label}</Text>
              <MaterialIcons name="chevron-right" size={16} color={C.text3} />
            </Pressable>
          ))}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function findFirstLeafId(node: any): string | null {
  if (node.type === 'leaf') return node.id;
  return findFirstLeafId(node.children[0]) ?? findFirstLeafId(node.children[1]);
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
  title: {
    color: C.text2,
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 1,
    paddingHorizontal: 6,
    paddingVertical: 6,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderTopWidth: S.borderWidth,
    borderTopColor: C.border,
  },
  optionIcon: {
    width: 28,
    alignItems: 'center',
  },
  optionLabel: {
    flex: 1,
    color: C.text1,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});
