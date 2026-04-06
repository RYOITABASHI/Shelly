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
  anchor: "(tabs)",
};

export default function RootLayout() {
  const loadSettings = useTerminalStore((s) => s.loadSettings);

  useEffect(() => {
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

    // Phase 0: execve verification test (Plan B)
    (async () => {
      try {
        const { Alert } = require('react-native');
        const TE = (await import('@/modules/terminal-emulator/src/TerminalEmulatorModule')).default;
        const result = await TE.testExecve();
        console.log('[Phase0-ExecveTest]', JSON.stringify(result));
        Alert.alert('Phase0 ExecveTest', JSON.stringify(result, null, 2));
      } catch (e: any) {
        console.log('[Phase0-ExecveTest] FAILED:', e);
        Alert.alert('Phase0 FAILED', String(e?.message || e));
      }
    })();

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
          <Stack.Screen name="(tabs)" />
        </Stack>
        <StatusBar style="light" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
