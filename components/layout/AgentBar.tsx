// components/layout/AgentBar.tsx
//
// Global top bar: single "+" (opens the unified LayoutAddSheet) • search •
// settings. The old split "layout preset / add pane" buttons collapsed into
// one sheet with ADD / LAYOUT tabs (mobile-optimised Superset model).
// The old CLI tab strip (CLAUDE/GEMINI/CODEX/OPENCODE/COPILOT) moved into
// each TerminalPane header as a per-pane tab bar (Superset-style), so this
// bar no longer carries CLI tabs at all.
import React, { useState } from 'react';
import { View, Pressable, StyleSheet, Text } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCommandPaletteStore } from '@/hooks/use-command-palette';
import { useGitStatusStore } from '@/store/git-status-store';
import { SettingsDropdown } from './SettingsDropdown';
import { LayoutAddSheet } from '@/components/multi-pane/LayoutAddSheet';
import { useFocusStore } from '@/store/focus-store';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R } from '@/theme.config';

export function AgentBar() {
  const [sheetVisible, setSheetVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const dirtyCount = useGitStatusStore((s) => s.dirtyCount);

  // bug #112: on Android edge-to-edge a dismissed Modal leaves the activity
  // with mCurrentFocus=null, so the keyboard stays visible but commitText
  // events go nowhere until the user taps the terminal. Route close through
  // a helper that bumps the focus store so TerminalPane calls
  // TerminalView.focus() immediately on dismiss.
  const closeWithRefocus = (setter: (v: boolean) => void) => () => {
    setter(false);
    useFocusStore.getState().requestTerminalRefocus();
  };

  return (
    <View style={styles.bar}>
      {/* Unified "+" — opens LayoutAddSheet with ADD / LAYOUT tabs inside.
          Replaces the previous split into two adjacent buttons (dashboard
          + plus) which users kept confusing with each other. */}
      <Pressable
        style={styles.addBtn}
        hitSlop={8}
        onPress={() => setSheetVisible(true)}
        accessibilityLabel="Add pane or change layout"
      >
        <Text style={styles.addBtnText}>+</Text>
      </Pressable>

      <View style={{ flex: 1 }} />

      {/* Right-side: git dirty + search + settings */}
      <View style={styles.rightBtns}>
        {dirtyCount !== null && dirtyCount > 0 && (
          <Pressable
            style={styles.gitBadge}
            onPress={() => useCommandPaletteStore.getState().open()}
            hitSlop={6}
            accessibilityLabel="Uncommitted changes"
          >
            <MaterialIcons name="fiber-manual-record" size={8} color={C.accentAmber} />
            <Text style={styles.gitBadgeText}>{String(dirtyCount)}</Text>
          </Pressable>
        )}
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

      <SettingsDropdown visible={settingsOpen} onClose={closeWithRefocus(setSettingsOpen)} />
      <LayoutAddSheet visible={sheetVisible} onClose={closeWithRefocus(setSheetVisible)} />
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
    width: 32,
    height: 28,
    marginLeft: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: R.agentTab,
    borderWidth: 1,
    borderColor: 'rgba(0,212,170,0.35)',
    backgroundColor: 'rgba(0,212,170,0.08)',
  },
  addBtnText: {
    color: C.accent,
    fontSize: 16,
    fontFamily: F.family,
    fontWeight: '700',
    lineHeight: 16,
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
  gitBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: R.badge,
    backgroundColor: 'rgba(245,158,11,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.35)',
  },
  gitBadgeText: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.accentAmber,
    letterSpacing: 0.3,
  },
});
