// components/layout/AgentBar.tsx
//
// Global top bar: layout preset button • add-pane button • search • settings.
// The old CLI tab strip (CLAUDE/GEMINI/CODEX/OPENCODE/COPILOT) moved into
// each TerminalPane header as a per-pane tab bar (Superset-style), so this
// bar no longer carries CLI tabs at all.
import React, { useState } from 'react';
import { View, Pressable, StyleSheet, Text } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCommandPaletteStore } from '@/hooks/use-command-palette';
import { SettingsDropdown } from './SettingsDropdown';
import { AddPaneSheet } from '@/components/multi-pane/AddPaneSheet';
import { LayoutPresetSheet } from '@/components/multi-pane/LayoutPresetSheet';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R } from '@/theme.config';

export function AgentBar() {
  const [addPaneSheetVisible, setAddPaneSheetVisible] = useState(false);
  const [layoutSheetVisible, setLayoutSheetVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <View style={styles.bar}>
      {/* Layout preset button (left edge) */}
      <Pressable
        style={styles.layoutBtn}
        onPress={() => setLayoutSheetVisible(true)}
        hitSlop={10}
        accessibilityLabel="Layout"
      >
        <MaterialIcons name="dashboard" size={18} color={C.accent} />
      </Pressable>

      {/* Add pane button */}
      <Pressable
        style={styles.addBtn}
        hitSlop={8}
        onPress={() => setAddPaneSheetVisible(true)}
        accessibilityLabel="Add pane"
      >
        <Text style={styles.addBtnText}>+</Text>
      </Pressable>

      <View style={{ flex: 1 }} />

      {/* Right-side: search + settings */}
      <View style={styles.rightBtns}>
        <Pressable
          style={styles.iconBtn}
          onPress={() => useCommandPaletteStore.getState().toggle()}
          hitSlop={8}
        >
          <MaterialIcons name="search" size={16} color={C.text2} />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={() => setSettingsOpen((v) => !v)}
          hitSlop={8}
        >
          <MaterialIcons name="settings" size={15} color={C.text2} />
        </Pressable>
      </View>

      <SettingsDropdown visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AddPaneSheet visible={addPaneSheetVisible} onClose={() => setAddPaneSheetVisible(false)} />
      <LayoutPresetSheet visible={layoutSheetVisible} onClose={() => setLayoutSheetVisible(false)} />
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  bar: {
    height: S.agentBarHeight,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: S.borderWidth,
    borderBottomColor: C.border,
    backgroundColor: C.bgSidebar,
  },
  addBtn: {
    paddingHorizontal: P.agentTab.px,
    paddingVertical: 4,
    marginLeft: 2,
  },
  addBtnText: {
    color: C.text2,
    fontSize: 14,
    fontFamily: F.family,
    fontWeight: '600',
  },
  rightBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
    gap: 6,
  },
  iconBtn: {
    padding: 4,
    borderRadius: R.agentTab,
  },
  layoutBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginLeft: 6,
    marginRight: 4,
    borderRadius: R.agentTab,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.35)',
    backgroundColor: 'rgba(0,212,170,0.08)',
  },
});
