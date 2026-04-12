import "@/global.css";
import React from "react";
import { logInfo, logError, logLifecycle } from '@/lib/debug-logger';
import { Stack } from "expo-router";
import { ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, View, Text, Pressable, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import { Silkscreen_400Regular } from "@expo-google-fonts/silkscreen";
import { useTerminalStore } from "@/store/terminal-store";
import { useSoundStore, unloadSounds } from "@/lib/sounds";
import { loadAgentsFromDisk } from "@/lib/agent-manager";
import { useI18n } from '@/lib/i18n';
import { useThemeStore } from '@/lib/theme-engine';
import { useA11yStore } from '@/lib/accessibility';
import { usePluginStore } from '@/lib/plugin-api';
import { useSettingsStore } from '@/store/settings-store';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  logError('ErrorBoundary', 'Uncaught error', error);
  return (
    <View style={ebStyles.container}>
      <Text style={ebStyles.title}>Something went wrong</Text>
      <Text style={ebStyles.message}>{error.message}</Text>
      <Pressable style={ebStyles.button} onPress={retry}>
        <Text style={ebStyles.buttonText}>Try Again</Text>
      </Pressable>
    </View>
  );
}

const ebStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0D1117', justifyContent: 'center', alignItems: 'center', padding: 24 },
  title: { color: '#F85149', fontSize: 20, fontWeight: '700', fontFamily: 'Silkscreen', marginBottom: 12 },
  message: { color: '#8B949E', fontSize: 14, fontFamily: 'Silkscreen', textAlign: 'center', marginBottom: 24 },
  button: { backgroundColor: '#21262D', borderWidth: 1, borderColor: '#30363D', borderRadius: 8, paddingHorizontal: 24, paddingVertical: 12 },
  buttonText: { color: '#C9D1D9', fontSize: 14, fontFamily: 'Silkscreen', fontWeight: '600' },
});

export const unstable_settings = {
  initialRouteName: "index",
};

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    'PixelMplus12': require('@/assets/fonts/PixelMplus12-Regular.ttf'),
    'GeistPixel-Square': require('@/assets/fonts/GeistPixel-Square.ttf'),
    'PressStart2P': require('@/assets/fonts/PressStart2P_400Regular.ttf'),
    // Silkscreen — closer to the mock's readable pixel aesthetic than
    // PressStart2P (which is a pure 8×8 grid). Provided via
    // @expo-google-fonts/silkscreen's named export (not a direct .ttf
    // path — Metro can't resolve that through the package subpath).
    'Silkscreen': Silkscreen_400Regular,
  });
  const uiFont = useSettingsStore((s) => s.settings.uiFont ?? 'silkscreen');
  const loadSettings = useTerminalStore((s) => s.loadSettings);

  // Override default Text fontFamily globally
  useEffect(() => {
    const fontFamily =
      uiFont === 'silkscreen' ? 'Silkscreen' :
      uiFont === 'pixel' ? 'PressStart2P' :
      'monospace';
    const defaultStyle = (Text as any).render;
    if (defaultStyle) {
      // Wrap Text.render to inject fontFamily
    }
    // Set defaultProps for all Text components
    (Text as any).defaultProps = (Text as any).defaultProps || {};
    (Text as any).defaultProps.style = {
      ...((Text as any).defaultProps?.style || {}),
      fontFamily,
    };
    logInfo('RootLayout', `UI font set to: ${fontFamily}`);
  }, [uiFont, fontsLoaded]);

  useEffect(() => {
    logLifecycle('RootLayout', 'mounted');
    logInfo('RootLayout', 'Initializing stores...');

    useI18n.getState().loadLocale();
    logInfo('RootLayout', 'Loaded: i18n');
    useThemeStore.getState().loadTheme();
    logInfo('RootLayout', 'Loaded: theme');
    useA11yStore.getState().loadConfig();
    logInfo('RootLayout', 'Loaded: a11y');
    usePluginStore.getState().loadPlugins();
    logInfo('RootLayout', 'Loaded: plugins');

    // Resolve dynamic HOME path from native layer
    import('@/lib/home-path').then(({ initHomePath }) => {
      initHomePath().then(() => logInfo('RootLayout', 'Loaded: homePath'));
    });

    loadSettings().then(() => {
      logInfo('RootLayout', 'Loaded: settings');
    }).catch((e: any) => {
      logError('RootLayout', 'loadSettings failed', e);
    });

    // Load background agents from disk
    loadAgentsFromDisk(async (_cmd) => {
      try {
        // Bridge may not be ready at startup — return empty string
        // Agents will be re-loaded when a session connects
        return '';
      } catch {
        return '';
      }
    }).then(() => {
      logInfo('RootLayout', 'Loaded: agents');
    }).catch((e: any) => {
      logError('RootLayout', 'loadAgentsFromDisk failed', e);
      console.warn(e);
    });



    // Wire voice-chain bridge so VoiceChat can execute terminal commands.
    // The bridge was exported but never hooked up, leaving the voice dialogue
    // loop unable to reach the terminal.
    import('@/hooks/use-voice-chat').then(({ setVoiceChainBridge }) => {
      import('@/hooks/use-native-exec').then(({ execCommand }) => {
        setVoiceChainBridge(async (cmd) => {
          const r = await execCommand(cmd, 30_000);
          return { stdout: r.stdout, stderr: r.stderr };
        });
        logInfo('RootLayout', 'Loaded: voice-chain bridge');
      });
    });

    // Initialize reduce-motion detection for sound/animation system
    useSoundStore.getState().initReduceMotion();

    // Unload sounds when app goes to background
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        unloadSounds();
      }
    });
    return () => sub.remove();
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
        </Stack>
        <StatusBar style="light" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
