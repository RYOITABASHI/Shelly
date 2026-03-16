import React, { useCallback, useEffect , useState } from 'react';
import { View, Text, Pressable, StyleSheet, Alert } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withSequence,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useTerminalStore } from '@/store/terminal-store';
import { ConnectionMode, BridgeStatus } from '@/store/types';
import { FullscreenTerminal } from './FullscreenTerminal';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { SPRING_CONFIGS } from '@/hooks/use-motion';
import { playSound } from '@/lib/sounds';

// ─── Mode config ──────────────────────────────────────────────────────────────

type ModeConfig = {
  icon: keyof typeof MaterialIcons.glyphMap;
  colorKey: 'command' | 'inactive';
  label: string;
  description: string;
};

const MODE_CONFIG: Record<ConnectionMode, ModeConfig> = {
  termux:       { icon: 'terminal',  colorKey: 'command',  label: 'Termux',   description: 'Termux WebSocket' },
  disconnected: { icon: 'cloud-off', colorKey: 'inactive', label: 'Off',      description: '\u672A\u63A5\u7D9A' },
};

const MODE_CYCLE: ConnectionMode[] = ['termux', 'disconnected'];

// ─── BlinkingCursor ─────────────────────────────────────────────────────────

function BlinkingCursor({ color }: { color: string }) {
  const opacity = useSharedValue(0.6);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 500 }),
        withTiming(0.3, { duration: 500 }),
      ),
      -1,
      false,
    );
  }, []);

  const animStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.Text style={[styles.cursor, { color }, animStyle]}>_</Animated.Text>
  );
}

// ─── BridgeDot ──────────────────────────────────────────────────────────────

function BridgeDot({ status, colors }: { status: BridgeStatus; colors: ReturnType<typeof useTheme>['colors'] }) {
  const scale = useSharedValue(1);

  const dotColor =
    status === 'connected'   ? colors.success :
    status === 'connecting'  ? colors.warning :
    status === 'error'       ? colors.error :
    colors.inactive;

  useEffect(() => {
    if (status === 'connecting') {
      scale.value = withRepeat(
        withSequence(
          withTiming(1.3, { duration: 400 }),
          withTiming(1, { duration: 400 }),
        ),
        -1,
        false,
      );
    } else {
      scale.value = withSpring(1, SPRING_CONFIGS.quick);
    }
  }, [status]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  return (
    <Animated.View style={[dotStyles.dot, { backgroundColor: dotColor }, animStyle]} />
  );
}

const dotStyles = StyleSheet.create({
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginLeft: 2,
  },
});

// ─── Component ────────────────────────────────────────────────────────────────

export function TerminalHeader() {
  const { colors } = useTheme();
  const {
    sessions,
    activeSessionId,
    addSession,
    removeSession,
    setActiveSession,
    connectionMode,
    bridgeStatus,
    setConnectionMode,
    settings,
  } = useTerminalStore();
  const router = useRouter();
  const layout = useDeviceLayout();
  const { isMultiPane, toggleMultiPane } = useMultiPaneStore();
  const [fullscreenVisible, setFullscreenVisible] = useState(false);

  const modeConfig = MODE_CONFIG[connectionMode];
  const modeColor = colors[modeConfig.colorKey];

  // Tab switch animation
  const tabScale = useSharedValue(1);
  const tabAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: tabScale.value }],
  }));

  // Badge scale animation
  const badgeScale = useSharedValue(1);
  const badgeAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: badgeScale.value }],
  }));

  const handleModePress = useCallback(() => {
    const currentIdx = MODE_CYCLE.indexOf(connectionMode);
    const nextMode = MODE_CYCLE[(currentIdx + 1) % MODE_CYCLE.length];

    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    playSound('mode_switch');

    // Badge bounce
    badgeScale.value = withSequence(
      withSpring(1.15, SPRING_CONFIGS.quick),
      withSpring(1, SPRING_CONFIGS.snappy),
    );

    if (nextMode === 'termux') {
      const { wsUrl } = useTerminalStore.getState().termuxSettings;
      if (!wsUrl || wsUrl === 'ws://127.0.0.1:8765') {
        Alert.alert(
          'Termux\u30E2\u30FC\u30C9\u306B\u5207\u66FF',
          `WebSocket URL: ${wsUrl}\n\nTermux\u3067\u30D6\u30EA\u30C3\u30B8\u30B5\u30FC\u30D0\u3092\u8D77\u52D5\u3057\u3066\u304B\u3089\u63A5\u7D9A\u3057\u3066\u304F\u3060\u3055\u3044\u3002\n\u8A2D\u5B9A\u3067\u5909\u66F4\u3067\u304D\u307E\u3059\u3002`,
          [
            { text: '\u30AD\u30E3\u30F3\u30BB\u30EB', style: 'cancel' },
            { text: '\u63A5\u7D9A\u3059\u308B', onPress: () => setConnectionMode(nextMode) },
          ]
        );
        return;
      }
    }
    setConnectionMode(nextMode);
  }, [connectionMode, settings.hapticFeedback, setConnectionMode, badgeScale]);

  const handleModeLongPress = useCallback(() => {
    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    router.push('/(tabs)/settings');
  }, [router, settings.hapticFeedback]);

  const handleTabPress = useCallback((sessionId: string) => {
    setActiveSession(sessionId);
    playSound('tab_switch');
    tabScale.value = withSequence(
      withSpring(1.1, SPRING_CONFIGS.quick),
      withSpring(1, SPRING_CONFIGS.snappy),
    );
  }, [setActiveSession, tabScale]);

  return (
    <View style={[styles.container, { backgroundColor: colors.surfaceHigh, borderBottomColor: colors.borderLight }]}>
      {/* App name */}
      <View style={styles.appNameContainer}>
        <Text style={[styles.appName, { color: colors.accent }]}>shelly</Text>
        <BlinkingCursor color={colors.accent} />
      </View>

      {/* Tab switcher */}
      <Animated.View style={[styles.tabsContainer, tabAnimStyle]}>
        {sessions.map((session, index) => (
          <Pressable
            key={session.id}
            onPress={() => handleTabPress(session.id)}
            onLongPress={() => sessions.length > 1 && removeSession(session.id)}
            delayLongPress={500}
            style={[
              styles.tab,
              { backgroundColor: colors.surface, borderColor: colors.borderLight },
              session.id === activeSessionId && {
                backgroundColor: withAlpha(colors.accent, 0.09),
                borderColor: colors.accent,
              },
            ]}
          >
            <Text style={[
              styles.tabText,
              { color: colors.inactive },
              session.id === activeSessionId && { color: colors.accent },
            ]}>
              {index + 1}
            </Text>
          </Pressable>
        ))}
        {sessions.length < 3 && (
          <Pressable
            onPress={addSession}
            style={[styles.addTabButton, { backgroundColor: colors.surface, borderColor: colors.borderLight }]}
          >
            <MaterialIcons name="add" size={14} color={colors.inactive} />
          </Pressable>
        )}
      </Animated.View>

      {/* Multi-pane toggle (wide screens only) */}
      {layout.isWide && (
        <Pressable
          onPress={() => {
            if (settings.hapticFeedback) {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }
            toggleMultiPane();
          }}
          style={styles.fullscreenButton}
        >
          <MaterialIcons
            name={isMultiPane ? 'fullscreen' : 'view-column'}
            size={16}
            color={isMultiPane ? colors.accent : colors.inactive}
          />
        </Pressable>
      )}

      {/* Fullscreen terminal button */}
      <Pressable
        onPress={() => {
          if (settings.hapticFeedback) {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          }
          setFullscreenVisible(true);
        }}
        style={styles.fullscreenButton}
      >
        <MaterialIcons name="open-in-full" size={14} color={colors.inactive} />
      </Pressable>

      {/* Connection mode badge */}
      <Animated.View style={badgeAnimStyle}>
        <Pressable
          onPress={handleModePress}
          onLongPress={handleModeLongPress}
          delayLongPress={600}
          style={[
            styles.statusContainer,
            { backgroundColor: colors.surface, borderColor: colors.borderLight },
            connectionMode === 'termux' && {
              borderColor: withAlpha(colors.command, 0.27),
              backgroundColor: withAlpha(colors.command, 0.03),
            },
            connectionMode === 'disconnected' && {
              borderColor: colors.borderLight,
              opacity: 0.6,
            },
          ]}
        >
          <MaterialIcons name={modeConfig.icon} size={13} color={modeColor} />
          <Text style={[styles.statusText, { color: modeColor }]}>
            {modeConfig.label}
          </Text>
          {connectionMode === 'termux' && (
            <BridgeDot status={bridgeStatus} colors={colors} />
          )}
        </Pressable>
      </Animated.View>

      <FullscreenTerminal
        visible={fullscreenVisible}
        wsUrl={useTerminalStore.getState().termuxSettings.wsUrl || 'ws://127.0.0.1:8765'}
        onClose={() => setFullscreenVisible(false)}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    height: 40,
    borderBottomWidth: 1,
  },
  appNameContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flex: 1,
  },
  appName: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
    letterSpacing: 0.5,
  },
  cursor: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  tabsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  tab: {
    width: 26,
    height: 26,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  tabText: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  addTabButton: {
    width: 26,
    height: 26,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 8,
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 5,
    borderWidth: 1,
  },
  statusText: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  fullscreenButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    marginRight: 2,
  },
});
