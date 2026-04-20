// components/multi-pane/LayoutAddSheet.tsx
//
// Mobile-optimised unified pane configuration sheet. Inherits the Superset
// dashboard philosophy (separate concepts for "grid layout" and "cell
// content") but collapses the two AgentBar buttons into one "+" that opens
// this sheet. A tab switcher inside flips between ADD (pick a pane type
// to drop into the first empty slot) and LAYOUT (pick a geometric preset).
//
// Replaces the old AddPaneSheet + LayoutPresetSheet pair in AgentBar.

import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, ScrollView, Alert } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { LayoutPicker } from './LayoutPicker';
import { useMultiPaneStore, type PaneTab } from '@/hooks/use-multi-pane';
import { useSidebarStore } from '@/store/sidebar-store';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

type Props = {
  visible: boolean;
  onClose: () => void;
};

type Tab = 'add' | 'layout';

type AddOption =
  | { kind: 'pane'; id: PaneTab; label: string; icon: string }
  | { kind: 'sidebar'; id: 'fileTree'; label: string; icon: string };

const ADD_OPTIONS: AddOption[] = [
  { kind: 'pane', id: 'terminal', label: 'Terminal', icon: 'terminal' },
  { kind: 'pane', id: 'ai',       label: 'AI Chat',  icon: 'auto-awesome' },
  { kind: 'pane', id: 'browser',  label: 'Browser',  icon: 'language' },
  { kind: 'pane', id: 'preview',  label: 'Preview',  icon: 'preview' },
  { kind: 'pane', id: 'markdown', label: 'Markdown', icon: 'description' },
  { kind: 'pane', id: 'ask',      label: 'Ask Shelly', icon: 'help-outline' },
  { kind: 'sidebar', id: 'fileTree', label: 'File Tree', icon: 'folder-open' },
];

export function LayoutAddSheet({ visible, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('add');

  const handleAdd = (opt: AddOption) => {
    if (opt.kind === 'sidebar') {
      const store = useSidebarStore.getState();
      store.setMode('expanded');
      if (!store.openSections.files) store.toggleSection('files');
      onClose();
      return;
    }
    // bug #108: silently returning from addPane when a cap is hit made
    // the sheet just close with no feedback ("+ ボタン壊れてる?"). Surface
    // the reason via Alert so the user understands why nothing happened.
    const result = useMultiPaneStore.getState().addPane(opt.id);
    if (result === 'terminal_cap') {
      Alert.alert(
        'ターミナルの上限',
        'ターミナルは 3 ペインまでです。Android の phantom process killer がバックグラウンドのセッションを殺す可能性があるため上限を設けています。',
      );
      return;
    }
    if (result === 'layout_full') {
      Alert.alert(
        'レイアウト満杯',
        '既に 4 ペイン使用中です。追加するには、いずれかのペインを閉じてください。',
      );
      return;
    }
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

          {/* Tab switcher */}
          <View style={styles.tabs}>
            <Pressable
              style={[styles.tab, tab === 'add' && styles.tabActive]}
              onPress={() => setTab('add')}
            >
              <MaterialIcons
                name="add"
                size={14}
                color={tab === 'add' ? C.accent : C.text3}
              />
              <Text style={[styles.tabLabel, tab === 'add' && styles.tabLabelActive]}>
                ADD
              </Text>
            </Pressable>
            <Pressable
              style={[styles.tab, tab === 'layout' && styles.tabActive]}
              onPress={() => setTab('layout')}
            >
              <MaterialIcons
                name="dashboard"
                size={14}
                color={tab === 'layout' ? C.accent : C.text3}
              />
              <Text style={[styles.tabLabel, tab === 'layout' && styles.tabLabelActive]}>
                LAYOUT
              </Text>
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            showsVerticalScrollIndicator={false}
          >
            {tab === 'add' ? (
              ADD_OPTIONS.map((opt) => (
                <Pressable
                  key={`${opt.kind}-${opt.id}`}
                  style={styles.option}
                  onPress={() => handleAdd(opt)}
                >
                  <View style={styles.optionIcon}>
                    <MaterialIcons name={opt.icon as any} size={18} color={C.accent} />
                  </View>
                  <Text style={styles.optionLabel}>{opt.label}</Text>
                  <MaterialIcons name="chevron-right" size={16} color={C.text3} />
                </Pressable>
              ))
            ) : (
              <LayoutPicker onPicked={onClose} />
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: C.bgSidebar,
    borderTopWidth: S.borderWidth,
    borderTopColor: C.border,
    borderTopLeftRadius: 12,
    borderTopRightRadius: 12,
    paddingBottom: 24,
    maxHeight: '80%',
  },
  handle: {
    width: 36,
    height: 4,
    backgroundColor: C.border,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 12,
  },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    gap: 8,
    marginBottom: 8,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: 'transparent',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    borderBottomColor: C.accent,
  },
  tabLabel: {
    fontSize: 11,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.text3,
    letterSpacing: 0.5,
  },
  tabLabelActive: {
    color: C.accent,
  },
  body: {
    paddingHorizontal: 12,
  },
  bodyContent: {
    paddingBottom: 8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.bgSurface,
    marginBottom: 6,
  },
  optionIcon: {
    width: 28,
    height: 28,
    borderRadius: 4,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 212, 170, 0.10)',
  },
  optionLabel: {
    flex: 1,
    fontSize: 12,
    fontFamily: F.family,
    fontWeight: '600',
    color: C.text1,
    letterSpacing: 0.3,
  },
});
