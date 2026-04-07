// components/layout/ShellLayout.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { View, Platform, StyleSheet, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/theme-engine';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { useSidebarStore } from '@/store/sidebar-store';
import { Sidebar } from './Sidebar';
import { AgentBar } from './AgentBar';
import { ContextBar } from './ContextBar';
import { MultiPaneContainer } from '@/components/multi-pane/MultiPaneContainer';
import { CommandPalette } from '@/components/CommandPalette';
import { WelcomeWizard, isWizardComplete } from '@/components/WelcomeWizard';
import { matchKeybinding, type KeyAction } from '@/lib/keybindings';
import { useTerminalStore } from '@/store/terminal-store';
import { useCommandPaletteStore } from '@/hooks/use-command-palette';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

export function ShellLayout() {
  const theme = useTheme();
  const c = theme.colors;
  const layout = useDeviceLayout();
  const insets = useSafeAreaInsets();
  const { initShell, setMaxPanes } = useMultiPaneStore();
  const { setMode } = useSidebarStore();

  // Initialize pane system on mount
  useEffect(() => {
    initShell();
    useSidebarStore.getState().loadRepos?.();
  }, []);

  // Responsive sidebar mode
  useEffect(() => {
    if (layout.isWide && layout.isLandscape) {
      setMode('expanded');
    } else if (layout.isWide) {
      setMode('icons');
    } else {
      setMode('hidden');
    }
  }, [layout.isWide, layout.isLandscape]);

  // Responsive max panes
  useEffect(() => {
    setMaxPanes(layout.isLandscape && layout.isWide ? 4 : layout.isWide ? 2 : 1);
  }, [layout.isWide, layout.isLandscape]);

  // Welcome wizard state
  const [showWizard, setShowWizard] = useState(false);
  const [wizardChecked, setWizardChecked] = useState(false);
  useEffect(() => {
    isWizardComplete().then((done) => {
      if (!done) setShowWizard(true);
      setWizardChecked(true);
    });
  }, []);

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

  // Swipe gestures for sidebar on phone
  const swipeRight = Gesture.Pan()
    .activeOffsetX(30)
    .onEnd((e) => {
      if (e.translationX > 80 && useSidebarStore.getState().mode === 'hidden') {
        useSidebarStore.getState().setMode('expanded');
      }
    });

  const swipeLeft = Gesture.Pan()
    .activeOffsetX(-30)
    .onEnd((e) => {
      if (e.translationX < -80 && !layout.isWide) {
        useSidebarStore.getState().setMode('hidden');
      }
    });

  const composed = Gesture.Race(swipeRight, swipeLeft);

  return (
    <View style={[styles.root, { backgroundColor: c.background, paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />

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
      {wizardChecked && (
        <WelcomeWizard visible={showWizard} onComplete={() => setShowWizard(false)} />
      )}
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
});
