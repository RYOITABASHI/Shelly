// components/layout/AgentBar.tsx
//
// Global top bar: single "+" (opens the unified LayoutAddSheet) • search •
// settings. The old split "layout preset / add pane" buttons collapsed into
// one sheet with ADD / LAYOUT tabs (mobile-optimised Superset model).
// CLI tabs moved into each TerminalPane header as a per-pane tab bar
// (Superset-style), so this bar no longer carries CLI tabs at all.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Pressable, StyleSheet, Text, ScrollView } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useCommandPaletteStore } from '@/hooks/use-command-palette';
import { SettingsDropdown } from './SettingsDropdown';
import { BuildsModal, buildStatusColor, fetchUpdateAvailabilityStatus, type BuildStatus } from './BuildsModal';
import { LayoutAddSheet } from '@/components/multi-pane/LayoutAddSheet';
import { RecentLogsModal } from './RecentLogsModal';
import { useFocusStore } from '@/store/focus-store';
import { usePaneStore } from '@/store/pane-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { PRESET_CAPACITY, useMultiPaneStore, type PaneTab, type SlotIndex } from '@/hooks/use-multi-pane';
import { PANE_REGISTRY, resolvePaneTitle } from '@/components/multi-pane/pane-registry';
import { colors as C, fonts as F, sizes as S, radii as R } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { usePanelBackground } from '@/hooks/use-panel-background';
import { useTranslation } from '@/lib/i18n';

const SHELLY_WORDMARK = 'Shelly';
const COMPACT_PANE_LABELS: Record<PaneTab, string> = {
  terminal: 'TERM',
  ai: 'AI',
  'agent-chat': 'CHAT',
  browser: 'WEB',
  markdown: 'MD',
  preview: 'PREV',
  ask: 'ASK',
};

function OpenPaneTabs() {
  const { t } = useTranslation();
  const layout = useDeviceLayout();
  const slots = useMultiPaneStore((s) => s.slots);
  const focusedSlot = useMultiPaneStore((s) => s.focusedSlot);
  const maximizedSlot = useMultiPaneStore((s) => s.maximizedSlot);
  const openSlots = useMemo(() => (
    slots
      .map((slot, index) => (slot ? { slot, index: index as SlotIndex } : null))
      .filter((item): item is { slot: NonNullable<(typeof slots)[number]>; index: SlotIndex } => item !== null)
  ), [slots]);
  const tabTypeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { slot } of openSlots) {
      counts.set(slot.tab, (counts.get(slot.tab) ?? 0) + 1);
    }
    return counts;
  }, [openSlots]);

  const hasMaximizedSlot = maximizedSlot !== null && slots[maximizedSlot] !== null;
  const activeSlot = hasMaximizedSlot ? maximizedSlot : focusedSlot;
  // The Add sheet counts all occupied slots, even when the current render path
  // collapses to a single visible pane. Keep every occupied slot reachable from
  // the top bar so "layout full" always has an obvious pane to switch/close.
  const visible = openSlots.length > 1;
  const compact = openSlots.length >= 3;
  const iconOnly = compact && (layout.isCompact || layout.width < 520);

  const switchPane = useCallback((slotIndex: SlotIndex) => {
    const state = useMultiPaneStore.getState();
    const slot = state.slots[slotIndex];
    if (!slot) return;
    const hiddenByPreset = slotIndex >= PRESET_CAPACITY[state.preset];
    state.maximizeSlot(state.maximizedSlot !== null || hiddenByPreset ? slotIndex : null);
    state.focusSlot(slotIndex);
    if (!layout.isWide && state.preset !== 'p1') {
      useMultiPaneStore.getState().setPreset('p1');
    }
    usePaneStore.getState().setFocusedPane(slot.id);
    if (slot.tab === 'terminal' && slot.sessionId) {
      useTerminalStore.getState().setActiveSession(slot.sessionId);
    }
    useFocusStore.getState().requestTerminalRefocus();
  }, [layout.isWide]);

  if (!visible) return <View style={styles.topSpacer} />;

  const renderTabs = () => {
    const seen = new Map<string, number>();
    return openSlots.map(({ slot, index }) => {
      const active = index === activeSlot;
      const label = resolvePaneTitle(slot.tab, t);
      const ordinal = (seen.get(slot.tab) ?? 0) + 1;
      seen.set(slot.tab, ordinal);
      const duplicate = (tabTypeCounts.get(slot.tab) ?? 0) > 1;
      const baseDisplayLabel = compact
        ? COMPACT_PANE_LABELS[slot.tab]
        : label.toUpperCase();
      const displayLabel = duplicate
        ? `${baseDisplayLabel} ${ordinal}`
        : baseDisplayLabel;
      return (
        <Pressable
          key={slot.id}
          style={[
            styles.paneTab,
            compact && styles.paneTabCompact,
            iconOnly && styles.paneTabIconOnly,
            {
              borderColor: active ? withAlpha(C.accent, 0.8) : withAlpha(C.border, 0.75),
              backgroundColor: active ? withAlpha(C.accent, 0.14) : withAlpha(C.bgSurface, 0.55),
            },
          ]}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={t('agentbar.switch_pane_a11y', { name: duplicate ? `${label} ${ordinal}` : label })}
          onPress={() => switchPane(index)}
        >
          {!compact ? (
            <View style={[styles.paneTabDot, { backgroundColor: active ? C.accent : C.text2 }]} />
          ) : null}
          <MaterialIcons
            name={PANE_REGISTRY[slot.tab].icon as any}
            size={compact ? 12 : 13}
            color={active ? C.accent : C.text2}
          />
          {!iconOnly ? (
            <Text
              style={[
                styles.paneTabText,
                compact && styles.paneTabTextCompact,
                { color: active ? C.accent : C.text2 },
              ]}
              numberOfLines={1}
            >
              {displayLabel}
            </Text>
          ) : duplicate ? (
            <Text
              style={[styles.paneTabOrdinal, { color: active ? C.accent : C.text2 }]}
              numberOfLines={1}
            >
              {ordinal}
            </Text>
          ) : null}
        </Pressable>
      );
    });
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.paneTabsScroller}
      contentContainerStyle={styles.paneTabsContent}
      keyboardShouldPersistTaps="handled"
    >
      {renderTabs()}
    </ScrollView>
  );
}

export function AgentBar() {
  const { t } = useTranslation();
  const [sheetVisible, setSheetVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [buildsOpen, setBuildsOpen] = useState(false);
  const [buildStatus, setBuildStatus] = useState<BuildStatus>('unknown');
  const barBg = usePanelBackground(C.bgSidebar);
  // bug #112: on Android edge-to-edge a dismissed Modal leaves the activity
  // with mCurrentFocus=null, so the keyboard stays visible but commitText
  // events go nowhere until the user taps the terminal. Route close through
  // a helper that bumps the focus store so TerminalPane calls
  // TerminalView.focus() immediately on dismiss.
  //
  // Each callback is its own useCallback (not a curried closeWithRefocus(setter)
  // factory) so the reference stays stable across AgentBar re-renders — a
  // fresh closure per render was silently defeating React.memo on
  // SettingsDropdown's child sections (found by review 2026-07-11).
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    useFocusStore.getState().requestTerminalRefocus();
  }, []);
  const closeBuilds = useCallback(() => {
    setBuildsOpen(false);
    useFocusStore.getState().requestTerminalRefocus();
  }, []);
  const closeLogs = useCallback(() => {
    setLogsOpen(false);
    useFocusStore.getState().requestTerminalRefocus();
  }, []);
  const closeSheet = useCallback(() => {
    setSheetVisible(false);
    useFocusStore.getState().requestTerminalRefocus();
  }, []);
  const openBuildsFromSettings = useCallback(() => {
    setSettingsOpen(false);
    setBuildsOpen(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await fetchUpdateAvailabilityStatus();
        if (!cancelled) setBuildStatus(status);
      } catch {
        if (!cancelled) setBuildStatus('unknown');
      }
    };
    void refresh();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={[styles.bar, { backgroundColor: barBg, borderBottomColor: C.border }]}>
      <View style={styles.logoMark} pointerEvents="none">
        <Text style={[styles.wordmark, { color: C.accent }]} numberOfLines={1}>
          {SHELLY_WORDMARK}
        </Text>
      </View>

      {/* Unified "+" — opens LayoutAddSheet with ADD / LAYOUT tabs inside.
          Replaces the previous split into two adjacent buttons (dashboard
          + plus) which users kept confusing with each other. */}
      <Pressable
        style={[
          styles.addBtn,
          {
            borderColor: withAlpha(C.accent, 0.35),
            backgroundColor: withAlpha(C.accent, 0.08),
          },
        ]}
        hitSlop={8}
        onPress={() => setSheetVisible(true)}
        accessibilityLabel={t('agentbar.add_or_layout_a11y')}
      >
        <Text style={[styles.addBtnText, { color: C.accent }]}>+</Text>
      </Pressable>

      <OpenPaneTabs />

      {/* Right-side: search + settings.
          The git-dirty badge was removed 2026-04-21 — it was counting
          `git status --porcelain` in `$HOME` which is not a sane repo
          context (BASHRC_VERSION writes, CLI install logs, npm caches and
          agent state files all registered as "dirty"), so users saw
          alarming 3-digit numbers that did not correspond to any work in
          progress. The underlying git-status-store was deleted alongside
          this UI. If a per-repo dirty count returns later it should read
          from a repo-scoped source (e.g. the active repo row in the
          REPOSITORIES sidebar, not the global active session). */}
      <View style={styles.rightBtns}>
        <Pressable
          style={styles.iconBtn}
          onPress={() => setBuildsOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('updates.show_a11y')}
        >
          <View>
            <MaterialIcons name="cloud-download" size={16} color={C.text2} />
            <View style={[styles.ciDot, { backgroundColor: buildStatusColor(buildStatus) }]} />
          </View>
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={() => useCommandPaletteStore.getState().toggle()}
          hitSlop={8}
        >
          <MaterialIcons name="search" size={16} color={C.text2} />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={() => setLogsOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('agentbar.show_recent_logs_a11y')}
        >
          <MaterialIcons name="history" size={16} color={C.text2} />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={() => setSettingsOpen((v) => !v)}
          hitSlop={8}
        >
          <MaterialIcons name="settings" size={15} color={C.text2} />
        </Pressable>
      </View>

      <SettingsDropdown
        visible={settingsOpen}
        onClose={closeSettings}
        onOpenBuilds={openBuildsFromSettings}
      />
      <BuildsModal
        visible={buildsOpen}
        onClose={closeBuilds}
        onStatusChange={(status) => setBuildStatus(status)}
      />
      <RecentLogsModal visible={logsOpen} onClose={closeLogs} />
      <LayoutAddSheet visible={sheetVisible} onClose={closeSheet} />
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
    marginRight: 4,
    minWidth: 52,
    paddingHorizontal: 6,
    justifyContent: 'center',
  },
  wordmark: {
    color: C.accent,
    fontFamily: F.family,
    fontSize: 13,
    lineHeight: 16,
    fontWeight: '700',
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
  topSpacer: {
    flex: 1,
  },
  paneTabsScroller: {
    flex: 1,
    marginLeft: 6,
    marginRight: 6,
  },
  paneTabsContent: {
    alignItems: 'center',
    gap: 5,
    paddingRight: 4,
  },
  paneTab: {
    height: 24,
    maxWidth: 92,
    minWidth: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    borderRadius: R.agentTab,
    borderWidth: 1,
  },
  paneTabCompact: {
    minWidth: 44,
    maxWidth: 70,
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 4,
  },
  paneTabIconOnly: {
    maxWidth: 28,
    paddingHorizontal: 0,
  },
  paneTabDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  paneTabText: {
    flexShrink: 1,
    fontFamily: F.family,
    fontSize: 8,
    lineHeight: 10,
    fontWeight: '700',
    letterSpacing: 0,
    includeFontPadding: false,
  },
  paneTabTextCompact: {
    fontSize: 7,
    lineHeight: 9,
  },
  paneTabOrdinal: {
    fontFamily: F.family,
    fontSize: 7,
    lineHeight: 9,
    fontWeight: '700',
    letterSpacing: 0,
    includeFontPadding: false,
  },
  iconBtn: {
    padding: 4,
    borderRadius: R.agentTab,
  },
  ciDot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 7,
    height: 7,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.bgSidebar,
  },
});
