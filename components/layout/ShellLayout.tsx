// components/layout/ShellLayout.tsx
import React, { useEffect, useCallback, useRef } from 'react';
import { logInfo, logLifecycle } from '@/lib/debug-logger';
import { View, Platform, StyleSheet, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/theme-engine';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useMultiPaneStore, type PresetId } from '@/hooks/use-multi-pane';
import { useSidebarStore } from '@/store/sidebar-store';
import { useThemeVersionStore } from '@/store/theme-version-store';
import { Sidebar } from './Sidebar';
import { AgentBar } from './AgentBar';
import { ContextBar } from './ContextBar';
import { MultiPaneContainer } from '@/components/multi-pane/MultiPaneContainer';
import { CommandPalette } from '@/components/CommandPalette';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { matchKeybinding, type KeyAction } from '@/lib/keybindings';
import { useTerminalStore } from '@/store/terminal-store';
import { useCommandPaletteStore } from '@/hooks/use-command-palette';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS } from 'react-native-reanimated';
import { CrtOverlay } from '@/components/CrtOverlay';
import { BackgroundLayer } from '@/components/BackgroundLayer';
import { VoiceChat } from '@/components/VoiceChat';
import { useSettingsStore } from '@/store/settings-store';
import { ConfigTUI } from '@/components/config/ConfigTUI';
import { SaveBadge } from '@/components/SaveBadge';
import { useFocusStore } from '@/store/focus-store';

export function ShellLayout() {
  const theme = useTheme();
  const c = theme.colors;
  const layout = useDeviceLayout();
  const insets = useSafeAreaInsets();
  const { initShell, setMaxPanes } = useMultiPaneStore();
  const { setMode } = useSidebarStore();
  const themeVersion = useThemeVersionStore((s) => s.version);

  // Initialize pane system on mount
  useEffect(() => {
    logLifecycle('ShellLayout', 'mounted');
    initShell();
    logInfo('ShellLayout', 'Pane system initialized');
    useSidebarStore.getState().loadRepos?.().then(() => {
      const count = useSidebarStore.getState().repoPaths.length;
      logInfo('ShellLayout', 'Repos loaded: ' + count);
    });
  }, []);

  // Responsive sidebar mode — always expanded (Superset-style)
  useEffect(() => {
    let mode: string;
    if (layout.isWide) {
      mode = 'expanded';
      setMode('expanded');
    } else {
      // Even on narrow screens, show sidebar expanded (user can swipe to hide)
      mode = 'expanded';
      setMode('expanded');
    }
    logInfo('ShellLayout', 'Sidebar mode: ' + mode);
  }, [layout.isWide, layout.isLandscape]);

  // Responsive max panes
  useEffect(() => {
    setMaxPanes(layout.isLandscape && layout.isWide ? 4 : layout.isWide ? 2 : 1);
  }, [layout.isWide, layout.isLandscape]);

  // Z Fold6 auto-switch.
  //
  // bug #99 (2026-04-26): the previous implementation hard-coded 1+2
  // (= 3 panes) on every fold→unfold transition, regardless of what the
  // user had configured before folding. Repro: open Shelly on the main
  // display in single-pane → fold → unfold → 3-pane layout appears.
  //
  // Fix: capture the user's actual preset *before* folding to single,
  // restore that exact preset on unfold, and persist the captured
  // value to AsyncStorage so a process kill while folded does NOT
  // lose the user's intent (code-review HIGH+MEDIUM 2026-04-26).
  // The 'p1' guard from the first iteration was dropped — a user who
  // explicitly chose single-pane on the inner display deserves to get
  // single back after a fold cycle.
  const prevFoldInnerRef = useRef<boolean | null>(null);
  // Persisted via AsyncStorage so that an Android process kill between
  // fold→unfold (e.g., user takes the foldable away for a few hours)
  // still restores the user's intent. Default seed 'p3l' (= '1+2') is
  // used only on first run before any fold cycle has occurred.
  const lastUnfoldedPresetRef = useRef<PresetId>('p3l');
  // Set once the AsyncStorage hydrate completes so the first effect
  // run that follows hydration has the persisted preset available.
  const hydrationCompleteRef = useRef<boolean>(false);
  useEffect(() => {
    let cancelled = false;
    AsyncStorage.getItem('shelly:lastUnfoldedPreset').then((stored) => {
      if (cancelled) return;
      const validIds: PresetId[] = ['p1', 'p2h', 'p2v', 'p3l', 'p3r', 'p3t', 'p3b', 'p4'];
      if (stored && (validIds as string[]).includes(stored)) {
        lastUnfoldedPresetRef.current = stored as PresetId;
        logInfo('ShellLayout', `Hydrated lastUnfoldedPreset=${stored}`);
      }
      hydrationCompleteRef.current = true;
    }).catch((e) => {
      logInfo('ShellLayout', `lastUnfoldedPreset hydrate failed: ${String(e)}`);
      hydrationCompleteRef.current = true;
    });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    const prev = prevFoldInnerRef.current;
    const curr = layout.isFoldInner;
    if (prev === null) {
      // First observation — skip the auto-switch but still capture the
      // current preset if we boot unfolded, so a fold→unfold cycle later
      // in this session restores it correctly.
      prevFoldInnerRef.current = curr;
      if (curr) {
        const captured = useMultiPaneStore.getState().preset;
        lastUnfoldedPresetRef.current = captured;
        AsyncStorage.setItem('shelly:lastUnfoldedPreset', captured).catch(() => {});
        logInfo(
          'ShellLayout',
          `Fold first observation: unfolded, captured preset=${captured}`,
        );
      }
      return;
    }
    if (prev !== curr) {
      if (curr) {
        // Unfold: restore whatever the user had before folding.
        const target = lastUnfoldedPresetRef.current;
        logInfo('ShellLayout', `Fold transition: unfolded → restoring preset=${target}`);
        useMultiPaneStore.getState().setPreset(target);
      } else {
        // Fold: snapshot the current preset before collapsing to single
        // so the next unfold can restore it. Persist immediately so a
        // process kill while folded does not lose the user's intent.
        // Captures 'p1' too — if the user explicitly chose single-pane
        // on the inner display, that is their preference.
        const captured = useMultiPaneStore.getState().preset;
        if (captured) {
          lastUnfoldedPresetRef.current = captured;
          AsyncStorage.setItem('shelly:lastUnfoldedPreset', captured).catch(() => {});
        }
        logInfo(
          'ShellLayout',
          `Fold transition: folded → Single (saved unfolded preset=${lastUnfoldedPresetRef.current})`,
        );
        useMultiPaneStore.getState().setPreset('p1');
      }
      prevFoldInnerRef.current = curr;
    }
  }, [layout.isFoldInner]);

  // Full-screen voice mode — triggered by `shelly voice` or long-press mic.
  // bug #112: trigger a terminal refocus after any overlay closes so the
  // activity's window focus returns to the terminal view instead of going
  // null (keyboard would stay visible but commitText would nowhere-land).
  const showVoice = useSettingsStore((s) => s.showVoiceMode);
  const closeVoice = useCallback(() => {
    useSettingsStore.getState().setShowVoiceMode(false);
    useFocusStore.getState().requestTerminalRefocus();
  }, []);

  // Settings TUI — triggered by gear button or `shelly config`
  const showConfig = useSettingsStore((s) => s.showConfigTUI);
  const closeConfig = useCallback(() => {
    logInfo('ShellLayout', 'ConfigTUI: close');
    useSettingsStore.getState().setShowConfigTUI(false);
    useFocusStore.getState().requestTerminalRefocus();
  }, []);

  useEffect(() => {
    if (showConfig) logInfo('ShellLayout', 'ConfigTUI: open');
  }, [showConfig]);

  // First-launch setup is now handled by terminal.tsx after PTY session is alive
  // (sends CLI install commands directly to the real terminal)

  // Global keybinding handler (physical keyboard)
  const handleKeyAction = useCallback((action: KeyAction) => {
    switch (action) {
      case 'command_palette':
        useCommandPaletteStore.getState().toggle();
        break;
      case 'new_session':
        useTerminalStore.getState().addSession();
        break;
      case 'clear_terminal':
        useTerminalStore.getState().clearSession();
        break;
      case 'multi_pane_toggle': {
        const sidebar = useSidebarStore.getState();
        sidebar.setMode(sidebar.mode === 'expanded' ? 'icons' : 'expanded');
        break;
      }
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const action = matchKeybinding(e.key, e.ctrlKey, e.shiftKey, e.altKey);
      if (action) {
        e.preventDefault();
        handleKeyAction(action);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyAction]);

  // Swipe gestures for sidebar on phone. Gesture.Pan().onEnd runs on the UI
  // (worklet) thread, so Zustand store access must be hopped back to JS via
  // runOnJS — otherwise the worklet crashes with "undefined is not a function".
  const openSidebar = useCallback(() => {
    if (useSidebarStore.getState().mode === 'hidden') {
      useSidebarStore.getState().setMode('expanded');
    }
  }, []);
  const closeSidebar = useCallback(() => {
    if (!layout.isWide) {
      useSidebarStore.getState().setMode('hidden');
    }
  }, [layout.isWide]);

  const swipeRight = Gesture.Pan()
    .activeOffsetX(30)
    .onEnd((e) => {
      'worklet';
      if (e.translationX > 80) {
        runOnJS(openSidebar)();
      }
    });

  const swipeLeft = Gesture.Pan()
    .activeOffsetX(-30)
    .onEnd((e) => {
      'worklet';
      if (e.translationX < -80) {
        runOnJS(closeSidebar)();
      }
    });

  const composed = Gesture.Race(swipeRight, swipeLeft);

  return (
    <View
      key={`theme-${themeVersion}`}
      style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
    >
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

      {/* Background — wallpaper or flat theme color. Must be FIRST so it
          lives behind every subsequent layer. Replaces the root View's
          backgroundColor (removed above) because when a wallpaper is set
          that solid colour would punch a hole through the image. */}
      <BackgroundLayer />

      {/* Agent Bar (top) */}
      <AgentBar />

      {/* Main area: sidebar + panes */}
      <GestureDetector gesture={composed}>
        <View style={styles.main}>
          <Sidebar />
          <MultiPaneContainer />
        </View>
      </GestureDetector>

      {/* Context Bar (bottom) */}
      <ContextBar />

      {/* Overlays */}
      <CommandPalette />

      {/* Settings TUI overlay */}
      <ConfigTUI visible={showConfig} onClose={closeConfig} />

      {/* Full-screen voice overlay */}
      <VoiceChat visible={showVoice} onClose={closeVoice} />

      {/* Savepoint badge — floating top-right indicator, fires when
          auto-savepoint writes a commit (see savepoint bridge in _layout.tsx) */}
      <View pointerEvents="none" style={styles.saveBadgeSlot}>
        <SaveBadge />
      </View>

      {/* CRT effect — must be last so it renders on top of everything */}
      <CrtOverlay />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  main: {
    flex: 1,
    flexDirection: 'row',
  },
  saveBadgeSlot: {
    position: 'absolute',
    top: 8,
    right: 12,
    zIndex: 50,
  },
});
