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
import { SettingsDropdown } from './SettingsDropdown';
import { LayoutAddSheet } from '@/components/multi-pane/LayoutAddSheet';
import { useFocusStore } from '@/store/focus-store';
import { useSettingsStore } from '@/store/settings-store';
import { colors as C, fonts as F, sizes as S, radii as R } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { usePanelBackground } from '@/hooks/use-panel-background';

// Calvin S figlet-style 3-line ASCII logo for SHELLY.
// Uses box-drawing chars — requires JetBrainsMono_400Regular (loaded in _layout.tsx).
const SHELLY_LOGO =
  '╔═╗╦ ╦╔═╗╦  ╦  ╦ ╦\n' +
  '╚═╗╠═╣║╣ ║  ║  ╚╦╝\n' +
  '╚═╝╩ ╩╚═╝╩═╝╩═╝ ╩ ';

export function AgentBar() {
  const [sheetVisible, setSheetVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const uiFont = useSettingsStore((s) => s.settings.uiFont ?? 'shelly');
  const barBg = usePanelBackground(C.bgSidebar);
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
    <View style={[styles.bar, { backgroundColor: barBg }]}>
      <View style={styles.logoMark} pointerEvents="none">
        <Text style={styles.asciiLogo}>{SHELLY_LOGO}</Text>
      </View>

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

      {/* Right-side: search + settings.
          The git-dirty badge was removed 2026-04-21 — it was counting
          `git status --porcelain` in `$HOME` which is not a sane repo
          context (BASHRC_VERSION writes, CLI install logs, npm caches and
          .claude state files all registered as "dirty"), so users saw
          alarming 3-digit numbers that did not correspond to any work in
          progress. The underlying git-status-store was deleted alongside
          this UI. If a per-repo dirty count returns later it should read
          from a repo-scoped source (e.g. the active repo row in the
          REPOSITORIES sidebar, not the global active session). */}
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
  logoMark: {
    height: 28,
    marginLeft: 6,
    marginRight: 2,
    paddingHorizontal: 4,
    justifyContent: 'center',
  },
  asciiLogo: {
    color: C.accent,
    fontFamily: 'JetBrainsMono_400Regular',
    fontSize: 5.5,
    lineHeight: 7,
    includeFontPadding: false,
    letterSpacing: 0,
  },
  addBtn: {
    width: 32,
    height: 28,
    marginLeft: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: R.agentTab,
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.35),
    backgroundColor: withAlpha(C.accent, 0.08),
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
});
