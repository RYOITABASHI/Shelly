import "@/global.css";
import React from "react";
import { Stack } from "expo-router";
import { ErrorBoundaryProps } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, View, Text, Pressable, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { useTerminalStore } from "@/store/terminal-store";
import { useSoundStore, unloadSounds } from "@/lib/sounds";
import { loadAgentsFromDisk } from "@/lib/agent-manager";
import { useI18n } from '@/lib/i18n';
import { useThemeStore } from '@/lib/theme-engine';
import { useA11yStore } from '@/lib/accessibility';
import { usePluginStore } from '@/lib/plugin-api';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
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
  title: { color: '#F85149', fontSize: 20, fontWeight: '700', fontFamily: 'monospace', marginBottom: 12 },
  message: { color: '#8B949E', fontSize: 14, fontFamily: 'monospace', textAlign: 'center', marginBottom: 24 },
  button: { backgroundColor: '#21262D', borderWidth: 1, borderColor: '#30363D', borderRadius: 8, paddingHorizontal: 24, paddingVertical: 12 },
  buttonText: { color: '#C9D1D9', fontSize: 14, fontFamily: 'monospace', fontWeight: '600' },
});

export const unstable_settings = {
  initialRouteName: "index",
};

export default function RootLayout() {
  const loadSettings = useTerminalStore((s) => s.loadSettings);

  useEffect(() => {
    useI18n.getState().loadLocale();
    useThemeStore.getState().loadTheme();
    useA11yStore.getState().loadConfig();
    usePluginStore.getState().loadPlugins();

    loadSettings();

    // Load background agents from disk
    loadAgentsFromDisk(async (_cmd) => {
      try {
        // Bridge may not be ready at startup — return empty string
        // Agents will be re-loaded when a session connects
        return '';
      } catch {
        return '';
      }
    }).catch(console.warn);



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
