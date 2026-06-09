// components/layout/ShellLayout.tsx
import React, { useEffect, useCallback, useRef, useState } from 'react';
import { logInfo, logLifecycle } from '@/lib/debug-logger';
import { View, Platform, StyleSheet, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useMultiPaneStore, PRESET_CAPACITY, type PresetId } from '@/hooks/use-multi-pane';
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
import { BackgroundLayer } from '@/components/BackgroundLayer';
import { VoiceChat } from '@/components/VoiceChat';
import { useSettingsStore } from '@/store/settings-store';
import { ConfigTUI } from '@/components/config/ConfigTUI';
import { SaveBadge } from '@/components/SaveBadge';
import { useFocusStore } from '@/store/focus-store';
import { createTerminalSessionForFocusedPane } from '@/lib/terminal-session-actions';
import { ScouterDetailModal } from '@/components/scouter/ScouterDetailModal';

const LAST_UNFOLDED_PRESET_KEY = 'shelly:lastUnfoldedPreset';
const COVER_PRESET_ACTIVE_KEY = 'shelly:coverPresetActive';
const FALLBACK_UNFOLDED_PRESET: PresetId = 'p3l';

function isPresetId(value: string | null): value is PresetId {
  return !!value && Object.prototype.hasOwnProperty.call(PRESET_CAPACITY, value);
}

export function ShellLayout() {
  const layout = useDeviceLayout();
  const insets = useSafeAreaInsets();
  const { initShell, setMaxPanes } = useMultiPaneStore();
  const currentPreset = useMultiPaneStore((s) => s.preset);
  const multiPaneHydrated = useMultiPaneStore((s) => s._hasHydrated);
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
  }, [initShell]);

  // Sidebar starts closed by default and now stays under user control.
  // Swipes / open actions can still expand it, but we no longer force-open
  // it on startup or on layout changes.
  useEffect(() => {
    logInfo('ShellLayout', 'Sidebar mode: ' + useSidebarStore.getState().mode);
  }, [layout.isWide, layout.isLandscape]);

  // Responsive max panes
  useEffect(() => {
    setMaxPanes(layout.isLandscape && layout.isWide ? 4 : layout.isWide ? 2 : 1);
  }, [layout.isWide, layout.isLandscape, setMaxPanes]);

  // Z Fold6 auto-switch.
  //
  // bug #99: do not hard-code unfolded -> 1+2. While the inner display is
  // active, keep the user's live preset persisted; when folding, collapse to
  // Single; when unfolding, restore that saved preset. Persisting while
  // unfolded also avoids racing the cover-screen reorientation effect.
  const prevFoldInnerRef = useRef<boolean | null>(null);
  const lastUnfoldedPresetRef = useRef<PresetId>(FALLBACK_UNFOLDED_PRESET);
  const coverPresetActiveRef = useRef(false);
  const presetHydratedRef = useRef(false);
  const unfoldDeferredUntilHydrateRef = useRef(false);
  const [presetHydrated, setPresetHydrated] = useState(false);

  const collapseToCoverPreset = useCallback((reason: string) => {
    const state = useMultiPaneStore.getState();
    const current = state.preset;
    const collapsedFromInnerPreset = isPresetId(current) && current !== 'p1';
    const temporaryCoverPreset = collapsedFromInnerPreset || coverPresetActiveRef.current;
    const saved = collapsedFromInnerPreset ? current : lastUnfoldedPresetRef.current;
    lastUnfoldedPresetRef.current = saved;
    coverPresetActiveRef.current = temporaryCoverPreset;
    if (presetHydratedRef.current) {
      AsyncStorage.setItem(LAST_UNFOLDED_PRESET_KEY, saved).catch(() => {});
      AsyncStorage.setItem(COVER_PRESET_ACTIVE_KEY, temporaryCoverPreset ? 'true' : 'false').catch(() => {});
    }
    logInfo(
      'ShellLayout',
      `${reason}: folded → Single (saved unfolded preset=${saved}, persist=${presetHydratedRef.current})`,
    );
    if (state.preset !== 'p1') {
      state.setPreset('p1');
    }
  }, []);

  const restoreUnfoldedPreset = useCallback((reason: string) => {
    const target = lastUnfoldedPresetRef.current;
    coverPresetActiveRef.current = false;
    if (presetHydratedRef.current) {
      AsyncStorage.setItem(COVER_PRESET_ACTIVE_KEY, 'false').catch(() => {});
    }
    logInfo('ShellLayout', `${reason}: unfolded → restored ${target}`);
    useMultiPaneStore.getState().setPreset(target);
  }, []);

  const keepCurrentUnfoldedPreset = useCallback((reason: string) => {
    const current = useMultiPaneStore.getState().preset;
    if (isPresetId(current)) {
      lastUnfoldedPresetRef.current = current;
      if (presetHydratedRef.current) {
        AsyncStorage.setItem(LAST_UNFOLDED_PRESET_KEY, current).catch(() => {});
      }
    }
    coverPresetActiveRef.current = false;
    if (presetHydratedRef.current) {
      AsyncStorage.setItem(COVER_PRESET_ACTIVE_KEY, 'false').catch(() => {});
    }
    logInfo('ShellLayout', `${reason}: unfolded → kept ${current}`);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      AsyncStorage.getItem(LAST_UNFOLDED_PRESET_KEY),
      AsyncStorage.getItem(COVER_PRESET_ACTIVE_KEY),
    ])
      .then(([stored, coverPresetActive]) => {
        if (cancelled) return;
        if (isPresetId(stored)) {
          lastUnfoldedPresetRef.current = stored;
          logInfo('ShellLayout', `Hydrated lastUnfoldedPreset=${stored}`);
        }
        coverPresetActiveRef.current = coverPresetActive === 'true';
        if (coverPresetActiveRef.current) {
          logInfo('ShellLayout', 'Hydrated coverPresetActive=true');
        }
        presetHydratedRef.current = true;
        setPresetHydrated(true);
      })
      .catch((e) => {
        logInfo('ShellLayout', `lastUnfoldedPreset hydrate failed: ${String(e)}`);
        presetHydratedRef.current = true;
        setPresetHydrated(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!layout.isFoldInner || !multiPaneHydrated || !presetHydrated) return;
    // Save only while we were already on the inner display before this render.
    // On cover -> inner transition, currentPreset is still the temporary cover
    // preset (`p1`) until the transition effect below restores the saved
    // unfolded preset. Saving during that transition would overwrite the last
    // real unfolded preset with Single.
    if (prevFoldInnerRef.current !== true) return;
    if (!isPresetId(currentPreset)) return;
    lastUnfoldedPresetRef.current = currentPreset;
    coverPresetActiveRef.current = false;
    AsyncStorage.setItem(LAST_UNFOLDED_PRESET_KEY, currentPreset).catch(() => {});
    AsyncStorage.setItem(COVER_PRESET_ACTIVE_KEY, 'false').catch(() => {});
    logInfo('ShellLayout', `Fold preset saved while unfolded: ${currentPreset}`);
  }, [layout.isFoldInner, currentPreset, multiPaneHydrated, presetHydrated]);

  useEffect(() => {
    const prev = prevFoldInnerRef.current;
    const curr = layout.isFoldInner;
    if (!multiPaneHydrated) return;

    if (presetHydrated && unfoldDeferredUntilHydrateRef.current && curr) {
      unfoldDeferredUntilHydrateRef.current = false;
      if (coverPresetActiveRef.current) {
        restoreUnfoldedPreset('Fold transition after hydrate');
      } else {
        keepCurrentUnfoldedPreset('Fold transition after hydrate');
      }
      prevFoldInnerRef.current = curr;
      return;
    }

    if (!presetHydrated) return;

    if (prev === null) {
      if (!curr) {
        // First observation on the cover display must also collapse. Otherwise
        // a persisted inner-display preset can render as two unusable slits
        // until a later width transition happens.
        collapseToCoverPreset('Fold initial observation');
      } else if (coverPresetActiveRef.current) {
        // If Shelly was killed or updated while folded, the temporary cover
        // preset (`p1`) is the persisted store value. Restore the remembered
        // inner preset on first inner-display observation.
        restoreUnfoldedPreset('Fold initial observation');
      }
      prevFoldInnerRef.current = curr;
      return;
    }
    if (prev !== curr) {
      if (curr) {
        if (coverPresetActiveRef.current) {
          restoreUnfoldedPreset('Fold transition');
        } else {
          keepCurrentUnfoldedPreset('Fold transition');
        }
      } else {
        collapseToCoverPreset('Fold transition');
      }
      prevFoldInnerRef.current = curr;
    }
  }, [
    layout.isFoldInner,
    multiPaneHydrated,
    presetHydrated,
    collapseToCoverPreset,
    keepCurrentUnfoldedPreset,
    restoreUnfoldedPreset,
  ]);

  // Full-screen voice mode — triggered by `shelly voice` or long-press mic.
  // bug #112: trigger a terminal refocus after any overlay closes so the
  // activity's window focus returns to the terminal view instead of going
  // null (keyboard would stay visible but commitText would nowhere-land).
  const showVoice = useSettingsStore((s) => s.showVoiceMode);
  const showScouterDetail = useSettingsStore((s) => s.showScouterDetail);
  const closeVoice = useCallback(() => {
    useSettingsStore.getState().setShowVoiceMode(false);
    useFocusStore.getState().requestTerminalRefocus();
  }, []);
  const closeScouterDetail = useCallback(() => {
    useSettingsStore.getState().setShowScouterDetail(false);
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
        createTerminalSessionForFocusedPane();
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
      useSidebarStore.getState().setMode('icons');
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

      {/* Scouter detail overlay */}
      <ScouterDetailModal visible={showScouterDetail} onClose={closeScouterDetail} />

      {/* Savepoint badge — floating top-right indicator, fires when
          auto-savepoint writes a commit (see savepoint bridge in _layout.tsx) */}
      <View pointerEvents="none" style={styles.saveBadgeSlot}>
        <SaveBadge />
      </View>

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
