import React, { useCallback, useEffect } from 'react';
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
import * as Haptics from 'expo-haptics';
import { useSettingsStore } from '@/store/settings-store';
import { useTerminalStore } from '@/store/terminal-store';
import { usePreviewStore } from '@/store/preview-store';
import { ConnectionMode } from '@/store/types';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { UsageIndicator } from '@/components/UsageIndicator';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { SPRING_CONFIGS } from '@/hooks/use-motion';
import { playSound } from '@/lib/sounds';
import { HEADER_HEIGHT, HEADER_PADDING_H, BORDER_WIDTH } from '@/lib/layout-constants';

// ─── Mode config ──────────────────────────────────────────────────────────────

type ModeConfig = {
  icon: keyof typeof MaterialIcons.glyphMap;
  colorKey: 'command' | 'inactive';
  label: string;
  description: string;
};

const MODE_CONFIG: Record<ConnectionMode, ModeConfig> = {
  native:       { icon: 'terminal',  colorKey: 'command',  label: 'Native',   description: 'JNI Terminal' },
  disconnected: { icon: 'cloud-off', colorKey: 'inactive', label: 'Off',      description: '\u672A\u63A5\u7D9A' },
};

const MODE_CYCLE: ConnectionMode[] = ['native', 'disconnected'];

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
    setConnectionMode,
    settings,
  } = useTerminalStore();
  const layout = useDeviceLayout();
  const { isMultiPane, toggleMultiPane } = useMultiPaneStore();

  const previewOpen = usePreviewStore((s) => s.isOpen);
  const hasNewContent = usePreviewStore((s) => s.hasNewContent);
  const togglePreview = useCallback(() => {
    const store = usePreviewStore.getState();
    if (store.isOpen) store.closePreview();
    else store.openPreview();
  }, []);

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

    setConnectionMode(nextMode);
  }, [connectionMode, settings.hapticFeedback, setConnectionMode, badgeScale]);

  const handleModeLongPress = useCallback(() => {
    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    useSettingsStore.getState().setShowConfigTUI(true);
  }, [settings.hapticFeedback]);

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
            onLongPress={() => {
              if (settings.hapticFeedback) {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              }
              const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Reset',
                  onPress: () => {
                    useTerminalStore.getState().requestResetSession(session.id);
                  },
                },
              ];
              if (sessions.length > 1) {
                buttons.push({
                  text: 'Close',
                  style: 'destructive',
                  onPress: () => removeSession(session.id),
                });
              }
              Alert.alert(
                `Session ${index + 1}`,
                'Reset restarts the shell.\nClose removes this tab.',
                buttons,
              );
            }}
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
        {sessions.length < 6 && (
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

      {/* Preview button */}
      <Pressable
        onPress={togglePreview}
        hitSlop={6}
        style={[styles.previewButton, previewOpen && { backgroundColor: withAlpha(colors.accent, 0.15) }]}
      >
        <MaterialIcons name="open-in-new" size={14} color={previewOpen ? colors.accent : colors.muted} />
        {!isMultiPane && (
          <Text style={[styles.previewLabel, { color: previewOpen ? colors.accent : colors.muted }]}>Preview</Text>
        )}
        {hasNewContent && !previewOpen && (
          <View style={styles.previewBadge} />
        )}
      </Pressable>

      {/* Usage cost */}
      <UsageIndicator />

      {/* Connection mode badge — compact in split view */}
      <Animated.View style={badgeAnimStyle}>
        <Pressable
          onPress={handleModePress}
          onLongPress={handleModeLongPress}
          delayLongPress={600}
          style={[
            styles.statusContainer,
            { backgroundColor: colors.surface, borderColor: colors.borderLight },
            connectionMode === 'disconnected' && {
              borderColor: colors.borderLight,
              opacity: 0.6,
            },
          ]}
        >
          <MaterialIcons name={modeConfig.icon} size={13} color={modeColor} />
          {!isMultiPane && (
            <Text style={[styles.statusText, { color: modeColor }]}>
              {modeConfig.label}
            </Text>
          )}
        </Pressable>
      </Animated.View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: HEADER_PADDING_H,
    height: HEADER_HEIGHT,
    borderBottomWidth: BORDER_WIDTH,
    gap: 4,
  },
  appNameContainer: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginRight: 'auto' as any,
  },
  appName: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'GeistPixel-Square',
    letterSpacing: 0.5,
  },
  cursor: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: 'GeistPixel-Square',
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
    fontFamily: 'GeistPixel-Square',
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
    fontFamily: 'GeistPixel-Square',
  },
  fullscreenButton: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 5,
    marginRight: 2,
  },
  previewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  previewLabel: {
    fontFamily: 'GeistPixel-Square',
    fontSize: 11,
    fontWeight: '600',
  },
  previewBadge: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#22C55E',
    position: 'absolute',
    top: 2,
    right: 2,
  },
});
