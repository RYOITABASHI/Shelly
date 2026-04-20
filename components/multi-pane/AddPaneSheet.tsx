// components/multi-pane/AddPaneSheet.tsx
//
// Bottom sheet for adding a new pane (or opening the file tree sidebar).
// Triggered by the "+" button in AgentBar.

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { ShellyModal } from '@/components/layout/ShellyModal';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useMultiPaneStore, type PaneTab } from '@/hooks/use-multi-pane';
import { useAddPane } from '@/hooks/use-add-pane';
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
  // ASK — Shelly's self-documenting assistant. Answers "can Shelly do X?"
  // using the bundled feature catalog via Groq (free tier by default).
  { kind: 'pane', id: 'ask',      label: 'Ask Shelly',  icon: 'help-outline' },
  { kind: 'sidebar', id: 'fileTree', label: 'File Tree', icon: 'folder-open' },
];

export function AddPaneSheet({ visible, onClose }: Props) {
  const addPane = useAddPane();
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
    // bug #108: useAddPane shows the cap-reached alert; close on success.
    const result = addPane(opt.id);
    if (result === null) onClose();
  };

  return (
    <ShellyModal
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
    </ShellyModal>
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
