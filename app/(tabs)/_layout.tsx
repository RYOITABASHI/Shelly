import { useState, useEffect, useCallback } from "react";
import { Tabs, useRouter } from "expo-router";
import { Platform, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useDeviceLayout } from "@/hooks/use-device-layout";
import { useMultiPaneStore } from "@/hooks/use-multi-pane";
import { useCommandPaletteStore } from "@/hooks/use-command-palette";
import { useQuickTerminalStore } from "@/hooks/use-quick-terminal";
import { matchKeybinding, type KeyAction } from "@/lib/keybindings";
import { MultiPaneContainer } from "@/components/multi-pane/MultiPaneContainer";
import { MultiPaneToggle } from "@/components/multi-pane/MultiPaneToggle";
import { CommandPalette } from "@/components/CommandPalette";
import { QuickTerminal } from "@/components/QuickTerminal";
import { SetupWizard, isSetupWizardComplete } from "@/components/SetupWizard";
import { useTerminalStore } from "@/store/terminal-store";
import { useI18n } from "@/lib/i18n";
import { useTheme, useThemeStore } from "@/lib/theme-engine";
import { useA11yStore } from "@/lib/accessibility";
import { usePluginStore } from "@/lib/plugin-api";
import { useToolDiscovery } from "@/hooks/use-tool-discovery";

// Module-level flag: survives component remounts (prevents wizard running twice)
let _setupChecked = false;

export default function TabLayout() {
  // CLI + LLM自動検出ポーリング
  useToolDiscovery();
  const layout = useDeviceLayout();
  const router = useRouter();
  const { isMultiPane, disableMultiPane, setMaxPanes, toggleMultiPane } = useMultiPaneStore();
  const theme = useTheme();
  const c = theme.colors;
  const [showSetupWizard, setShowSetupWizard] = useState(false);

  // Initialize global stores on mount
  useEffect(() => {
    useI18n.getState().loadLocale();
    useThemeStore.getState().loadTheme();
    useA11yStore.getState().loadConfig();
    usePluginStore.getState().loadPlugins();
    if (!_setupChecked) {
      _setupChecked = true;
      isSetupWizardComplete().then((done) => {
        if (!done) setShowSetupWizard(true);
      });
    }
  }, []);

  // ── Global keybinding handler (physical keyboard) ────────────────────────
  const handleKeyAction = useCallback((action: KeyAction) => {
    switch (action) {
      case 'command_palette':
        useCommandPaletteStore.getState().toggle();
        break;
      case 'quick_terminal':
        useQuickTerminalStore.getState().toggle();
        break;
      case 'multi_pane_toggle':
        if (layout.isWide) toggleMultiPane();
        break;
      case 'new_session':
        useTerminalStore.getState().addSession();
        break;
      case 'clear_terminal':
        useTerminalStore.getState().clearSession();
        break;
      case 'search':
        router.push('/(tabs)/projects' as any);
        break;
      case 'next_tab':
      case 'prev_tab':
        // Tab navigation handled by expo-router natively
        break;
    }
  }, [layout.isWide, toggleMultiPane, router]);

  useEffect(() => {
    if (Platform.OS !== 'web' && Platform.OS !== 'android') return;
    // Android with physical keyboard sends key events via onKeyUp
    // Web always has keyboard events
    if (Platform.OS === 'web') {
      const handleKeyDown = (e: KeyboardEvent) => {
        const action = matchKeybinding(e.key, e.ctrlKey, e.shiftKey, e.altKey);
        if (action) {
          e.preventDefault();
          handleKeyAction(action);
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [handleKeyAction]);

  // Auto-disable multi-pane on non-wide screens
  useEffect(() => {
    if (!layout.isWide) {
      disableMultiPane();
    }
  }, [layout.isWide]);

  // Adjust maxPanes on rotation: landscape=4, portrait=2
  useEffect(() => {
    if (layout.isWide) {
      setMaxPanes(layout.isLandscape ? 4 : 2);
    }
  }, [layout.isWide, layout.isLandscape]);

  const showMultiPane = isMultiPane && layout.isWide;

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <Tabs
        screenOptions={{
          headerShown: false,
          tabBarActiveTintColor: c.accent,
          tabBarInactiveTintColor: c.inactive,
          tabBarStyle: showMultiPane
            ? { display: "none" }
            : {
                backgroundColor: c.background,
                borderTopColor: c.border,
                borderTopWidth: 1,
                paddingBottom: Platform.OS === "android" ? 4 : 0,
                height: Platform.OS === "android" ? 56 : 50,
              },
          tabBarLabelStyle: {
            fontSize: 10,
            fontFamily: "monospace",
          },
        }}
      >
        {/* ── Core 4 tabs (Projects / Chat / Terminal / Settings) ── */}
        <Tabs.Screen
          name="projects"
          options={{
            title: "Projects",
            tabBarIcon: ({ color }) => (
              <MaterialIcons name="folder" size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="index"
          options={{
            title: "Chat",
            tabBarIcon: ({ color }) => (
              <MaterialIcons name="chat" size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="terminal"
          options={{
            title: "Terminal",
            tabBarIcon: ({ color }) => (
              <MaterialIcons name="terminal" size={22} color={color} />
            ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: "Settings",
            tabBarIcon: ({ color }) => (
              <MaterialIcons name="settings" size={22} color={color} />
            ),
          }}
        />
        {/* ── Hidden tabs (legacy, accessible via navigation only) ── */}
        <Tabs.Screen
          name="creator"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="snippets"
          options={{ href: null }}
        />
<Tabs.Screen
          name="obsidian"
          options={{ href: null }}
        />
        <Tabs.Screen
          name="search"
          options={{ href: null }}
        />
      </Tabs>

      {/* Multi-pane toggle FAB (only on wide screens) */}
      {layout.isWide && <MultiPaneToggle />}

      {/* Multi-pane overlay (covers entire screen when active) */}
      {showMultiPane && <MultiPaneContainer />}

      {/* Command Palette (Ctrl+Shift+P) */}
      <CommandPalette />

      {/* Quick Terminal (drop-down overlay) */}
      <QuickTerminal />

      {/* Setup Wizard (first launch — includes welcome screen) */}
      <SetupWizard
        visible={showSetupWizard}
        onComplete={() => setShowSetupWizard(false)}
      />
    </View>
  );
}
