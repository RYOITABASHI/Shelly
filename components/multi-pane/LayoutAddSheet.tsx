// components/multi-pane/LayoutAddSheet.tsx
//
// Mobile-optimised unified pane configuration sheet. Inherits the Superset
// dashboard philosophy (separate concepts for "grid layout" and "cell
// content") but collapses the two AgentBar buttons into one "+" that opens
// this sheet. A tab switcher inside flips between ADD (pick a pane type
// to drop into the first empty slot) and LAYOUT (pick a geometric preset).
//
// Replaces the old AddPaneSheet + LayoutPresetSheet pair in AgentBar.

import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { ShellyModal } from '@/components/layout/ShellyModal';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { LayoutPicker } from './LayoutPicker';
import { PRESET_CAPACITY, useMultiPaneStore, type PaneTab, type SlotIndex } from '@/hooks/use-multi-pane';
import { useAddPane } from '@/hooks/use-add-pane';
import { useFocusStore } from '@/store/focus-store';
import { usePaneStore } from '@/store/pane-store';
import { useSidebarStore } from '@/store/sidebar-store';
import { useTerminalStore } from '@/store/terminal-store';
import { PANE_REGISTRY, resolvePaneTitle } from './pane-registry';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';

type Props = {
  visible: boolean;
  onClose: () => void;
};

type Tab = 'add' | 'layout';

type AddOption =
  | { kind: 'pane'; id: PaneTab }
  | { kind: 'sidebar'; id: 'fileTree'; icon: string };

const ADD_OPTIONS: AddOption[] = [
  { kind: 'pane', id: 'terminal' },
  { kind: 'pane', id: 'ai' },
  { kind: 'pane', id: 'agent-chat' },
  { kind: 'pane', id: 'browser' },
  { kind: 'pane', id: 'preview' },
  { kind: 'pane', id: 'markdown' },
  { kind: 'pane', id: 'ask' },
  { kind: 'sidebar', id: 'fileTree', icon: 'folder-open' },
];

export function LayoutAddSheet({ visible, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('add');
  const { t } = useTranslation();
  const addPane = useAddPane();
  const slots = useMultiPaneStore((s) => s.slots);
  const focusedSlot = useMultiPaneStore((s) => s.focusedSlot);
  const maximizedSlot = useMultiPaneStore((s) => s.maximizedSlot);
  const activeSlot = maximizedSlot !== null && slots[maximizedSlot] ? maximizedSlot : focusedSlot;
  const openSlots = useMemo(() => (
    slots
      .map((slot, index) => (slot ? { slot, index: index as SlotIndex } : null))
      .filter((item): item is { slot: NonNullable<(typeof slots)[number]>; index: SlotIndex } => item !== null)
  ), [slots]);
  const tabTypeCounts = useMemo(() => {
    const counts = new Map<PaneTab, number>();
    for (const { slot } of openSlots) {
      counts.set(slot.tab, (counts.get(slot.tab) ?? 0) + 1);
    }
    return counts;
  }, [openSlots]);

  const switchToSlot = useCallback((slotIndex: SlotIndex) => {
    const state = useMultiPaneStore.getState();
    const slot = state.slots[slotIndex];
    if (!slot) return;
    const hiddenByPreset = slotIndex >= PRESET_CAPACITY[state.preset];
    state.maximizeSlot(state.maximizedSlot !== null || hiddenByPreset ? slotIndex : null);
    state.focusSlot(slotIndex);
    usePaneStore.getState().setFocusedPane(slot.id);
    if (slot.tab === 'terminal' && slot.sessionId) {
      useTerminalStore.getState().setActiveSession(slot.sessionId);
    }
    useFocusStore.getState().requestTerminalRefocus();
    onClose();
  }, [onClose]);

  const removeSlot = useCallback((slotId: string) => {
    useMultiPaneStore.getState().removePane(slotId);
  }, []);

  const handleAdd = (opt: AddOption) => {
    if (opt.kind === 'sidebar') {
      const store = useSidebarStore.getState();
      store.setMode('expanded');
      if (!store.openSections.files) store.toggleSection('files');
      onClose();
      return;
    }
    // bug #108: useAddPane shows the cap-reached Alert for us; only close
    // the sheet on success so the user can pick a different pane type
    // immediately after dismissing the alert.
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
              <>
                {openSlots.length > 0 ? (
                  <View style={styles.inUseBlock}>
                    <Text style={styles.sectionLabel}>IN USE {openSlots.length}/4</Text>
                    {(() => {
                      const seen = new Map<PaneTab, number>();
                      return openSlots.map(({ slot, index }) => {
                        const label = resolvePaneTitle(slot.tab, t);
                        const ordinal = (seen.get(slot.tab) ?? 0) + 1;
                        seen.set(slot.tab, ordinal);
                        const duplicate = (tabTypeCounts.get(slot.tab) ?? 0) > 1;
                        const displayLabel = duplicate ? `${label} ${ordinal}` : label;
                        const active = index === activeSlot;
                        return (
                          <Pressable
                            key={slot.id}
                            style={[styles.currentPane, active && styles.currentPaneActive]}
                            onPress={() => switchToSlot(index)}
                          >
                            <View style={styles.optionIcon}>
                              <MaterialIcons
                                name={PANE_REGISTRY[slot.tab].icon as any}
                                size={18}
                                color={active ? C.accent : C.text2}
                              />
                            </View>
                            <View style={styles.currentPaneText}>
                              <Text style={[styles.currentPaneLabel, active && styles.currentPaneLabelActive]}>
                                {displayLabel}
                              </Text>
                              <Text style={styles.currentPaneHint}>
                                SLOT {index + 1} · TAP TO SHOW
                              </Text>
                            </View>
                            {openSlots.length > 1 ? (
                              <Pressable
                                style={styles.closePaneBtn}
                                hitSlop={6}
                                onPress={(event) => {
                                  event.stopPropagation();
                                  removeSlot(slot.id);
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={`Close ${displayLabel}`}
                              >
                                <MaterialIcons name="close" size={16} color={C.text2} />
                              </Pressable>
                            ) : null}
                          </Pressable>
                        );
                      });
                    })()}
                  </View>
                ) : null}

                <Text style={styles.sectionLabel}>ADD PANE</Text>
                {ADD_OPTIONS.map((opt) => {
                  const icon = opt.kind === 'pane' ? PANE_REGISTRY[opt.id].icon : opt.icon;
                  const label = opt.kind === 'pane' ? resolvePaneTitle(opt.id, t) : t('sidebar.file_tree');
                  return (
                    <Pressable
                      key={`${opt.kind}-${opt.id}`}
                      style={styles.option}
                      onPress={() => handleAdd(opt)}
                    >
                      <View style={styles.optionIcon}>
                        <MaterialIcons name={icon as any} size={18} color={C.accent} />
                      </View>
                      <Text style={styles.optionLabel}>{label}</Text>
                      <MaterialIcons name="chevron-right" size={16} color={C.text3} />
                    </Pressable>
                  );
                })}
              </>
            ) : (
              <LayoutPicker onPicked={onClose} />
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </ShellyModal>
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
  inUseBlock: {
    marginBottom: 10,
  },
  sectionLabel: {
    marginTop: 4,
    marginBottom: 6,
    paddingHorizontal: 2,
    fontSize: 10,
    lineHeight: 12,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.text3,
    letterSpacing: 0.6,
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
    backgroundColor: withAlpha(C.accent, 0.10),
  },
  currentPane: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: withAlpha(C.bgSurface, 0.72),
    marginBottom: 6,
  },
  currentPaneActive: {
    borderColor: withAlpha(C.accent, 0.75),
    backgroundColor: withAlpha(C.accent, 0.10),
  },
  currentPaneText: {
    flex: 1,
    minWidth: 0,
  },
  currentPaneLabelActive: {
    color: C.accent,
  },
  currentPaneLabel: {
    fontSize: 12,
    lineHeight: 14,
    fontFamily: F.family,
    fontWeight: '600',
    color: C.text1,
    letterSpacing: 0.3,
    includeFontPadding: false,
  },
  currentPaneHint: {
    marginTop: 2,
    fontSize: 8,
    lineHeight: 10,
    fontFamily: F.family,
    color: C.text3,
    letterSpacing: 0.3,
    includeFontPadding: false,
  },
  closePaneBtn: {
    width: 28,
    height: 28,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: withAlpha(C.border, 0.75),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: withAlpha(C.bgDeep, 0.35),
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
