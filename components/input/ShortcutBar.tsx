import React, { useState, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ScrollView,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { useTerminalStore } from '@/store/terminal-store';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { SPRING_CONFIGS, TIMING_CONFIGS } from '@/hooks/use-motion';
import { playSound } from '@/lib/sounds';

type ShortcutKey = {
  label: string;
  key: string;
  longPressLabel?: string;
  longPressKey?: string;
  isModifier?: boolean;
  isAction?: boolean;
  width?: number;
};

const SHORTCUT_KEYS: ShortcutKey[] = [
  { label: 'Ctrl', key: 'ctrl', longPressLabel: 'Alt', longPressKey: 'alt', isModifier: true, width: 46 },
  { label: 'Esc',  key: 'escape', width: 40 },
  { label: 'Tab',  key: 'tab',    width: 40 },
  { label: '\u2191',    key: 'arrowup' },
  { label: '\u2193',    key: 'arrowdown' },
  { label: '\u2190',    key: 'arrowleft' },
  { label: '\u2192',    key: 'arrowright' },
  { label: 'Home', key: 'home', width: 46 },
  { label: 'End',  key: 'end',  width: 40 },
  { label: 'Del',  key: 'delete', width: 40 },
  { label: 'PgUp', key: 'pageup',   width: 46 },
  { label: 'PgDn', key: 'pagedown', width: 46 },
  { label: '^C', key: 'ctrl_c', isAction: true, width: 40 },
  { label: '^D', key: 'ctrl_d', isAction: true, width: 40 },
  { label: '\u21b5', key: 'newline', width: 40 },
];

type ToastMessage = 'no_running' | 'not_connected' | null;

type Props = {
  onSpecialKey: (key: string, modifier?: string) => void;
  onHistoryUp: () => void;
  onHistoryDown: () => void;
  onCtrlC?: () => void;
  onCtrlD?: () => void;
  isRunning?: boolean;
  isBridgeConnected?: boolean;
};

// ── AnimatedKey sub-component ─────────────────────────────────────────────────

function AnimatedKey({
  shortcut,
  isActive,
  isCtrlCReady,
  isCtrlCDim,
  onPress,
  onLongPress,
  colors,
}: {
  shortcut: ShortcutKey;
  isActive: boolean;
  isCtrlCReady: boolean;
  isCtrlCDim: boolean;
  onPress: () => void;
  onLongPress: () => void;
  colors: ReturnType<typeof useTheme>['colors'];
}) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = () => {
    scale.value = withSpring(0.92, SPRING_CONFIGS.quick);
  };

  const handlePressOut = () => {
    scale.value = withSpring(1, SPRING_CONFIGS.quick);
  };

  return (
    <Animated.View
      style={[
        animatedStyle,
        styles.key,
        shortcut.width ? { width: shortcut.width } : null,
        { backgroundColor: colors.borderHeavy, borderColor: colors.inactive },
        isActive && { backgroundColor: withAlpha(colors.accent, 0.13), borderColor: colors.accent },
        isCtrlCReady && { backgroundColor: withAlpha(colors.error, 0.13), borderColor: colors.error },
        isCtrlCDim && { opacity: 0.45 },
      ]}
    >
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        delayLongPress={400}
        style={styles.keyInner}
      >
        <Text style={[
          styles.keyLabel,
          { color: colors.keyLabel },
          isActive && { color: colors.accent },
          isCtrlCReady && { color: colors.error, fontWeight: '700' },
          isCtrlCDim && { color: colors.inactive },
        ]}>
          {shortcut.label}
        </Text>
        {shortcut.longPressLabel && (
          <Text style={[styles.keySubLabel, { color: colors.hint }]}>{shortcut.longPressLabel}</Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function ShortcutBar({
  onSpecialKey,
  onHistoryUp,
  onHistoryDown,
  onCtrlC,
  onCtrlD,
  isRunning = false,
  isBridgeConnected = true,
}: Props) {
  const { colors } = useTheme();
  const [ctrlActive, setCtrlActive] = useState(false);
  const [altActive,  setAltActive]  = useState(false);
  const [toast, setToast] = useState<ToastMessage>(null);
  const toastOpacity = useSharedValue(0);
  const toastTranslateY = useSharedValue(10);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { settings } = useTerminalStore();

  const toastAnimStyle = useAnimatedStyle(() => ({
    opacity: toastOpacity.value,
    transform: [{ translateY: toastTranslateY.value }],
  }));

  const showToast = useCallback((msg: ToastMessage) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastOpacity.value = withSpring(1, SPRING_CONFIGS.quick);
    toastTranslateY.value = withSpring(0, SPRING_CONFIGS.snappy);
    toastTimer.current = setTimeout(() => {
      toastOpacity.value = withTiming(0, TIMING_CONFIGS.exit);
      toastTranslateY.value = withTiming(10, TIMING_CONFIGS.exit);
      setTimeout(() => setToast(null), 250);
    }, 1200);
  }, [toastOpacity, toastTranslateY]);

  const haptic = useCallback((style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light) => {
    if (settings.hapticFeedback) {
      Haptics.impactAsync(style);
    }
  }, [settings.hapticFeedback]);

  const handleCtrlC = useCallback(() => {
    if (!isRunning) {
      haptic(Haptics.ImpactFeedbackStyle.Light);
      showToast('no_running');
      return;
    }
    haptic(Haptics.ImpactFeedbackStyle.Medium);
    playSound('ctrl_c');
    onCtrlC?.();
  }, [isRunning, onCtrlC, haptic, showToast]);

  const handlePress = useCallback((shortcut: ShortcutKey) => {
    if (shortcut.isAction && shortcut.key === 'ctrl_c') {
      handleCtrlC();
      return;
    }
    if (shortcut.isAction && shortcut.key === 'ctrl_d') {
      if (!isRunning) {
        haptic(Haptics.ImpactFeedbackStyle.Light);
        showToast('no_running');
        return;
      }
      haptic(Haptics.ImpactFeedbackStyle.Medium);
      onCtrlD?.();
      return;
    }
    haptic();
    playSound('key_press');

    if (shortcut.isModifier) {
      if (shortcut.key === 'ctrl') {
        setCtrlActive((v) => !v);
        setAltActive(false);
      }
      return;
    }
    if (shortcut.key === 'arrowup' && !ctrlActive && !altActive) {
      onHistoryUp();
      return;
    }
    if (shortcut.key === 'arrowdown' && !ctrlActive && !altActive) {
      onHistoryDown();
      return;
    }

    const modifier = ctrlActive ? 'ctrl' : altActive ? 'alt' : undefined;
    onSpecialKey(shortcut.key, modifier);

    if (ctrlActive || altActive) {
      setCtrlActive(false);
      setAltActive(false);
    }
  }, [handleCtrlC, haptic, ctrlActive, altActive, onHistoryUp, onHistoryDown, onSpecialKey, isRunning, onCtrlD, showToast]);

  const handleLongPress = useCallback((shortcut: ShortcutKey) => {
    if (!shortcut.longPressKey) return;
    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    if (shortcut.longPressKey === 'alt') {
      setAltActive((v) => !v);
      setCtrlActive(false);
    }
  }, [settings.hapticFeedback]);

  const toastText =
    toast === 'no_running'     ? 'No running command' :
    toast === 'not_connected'  ? 'Not connected' :
    '';

  return (
    <View style={[styles.container, { backgroundColor: colors.backgroundDeep, borderTopColor: colors.borderHeavy }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="always"
      >
        {SHORTCUT_KEYS.map((shortcut) => {
          const isCtrlKey    = shortcut.key === 'ctrl';
          const isCtrlCKey   = shortcut.key === 'ctrl_c';
          const isActive     = isCtrlKey ? ctrlActive : false;
          const isCtrlDKey    = shortcut.key === 'ctrl_d';
          const isCtrlCReady = (isCtrlCKey || isCtrlDKey) && isRunning;
          const isCtrlCDim   = (isCtrlCKey || isCtrlDKey) && !isRunning;

          return (
            <AnimatedKey
              key={shortcut.key}
              shortcut={shortcut}
              isActive={isActive}
              isCtrlCReady={isCtrlCReady}
              isCtrlCDim={isCtrlCDim}
              onPress={() => handlePress(shortcut)}
              onLongPress={() => handleLongPress(shortcut)}
              colors={colors}
            />
          );
        })}
      </ScrollView>

      {toast && (
        <Animated.View style={[
          styles.toast,
          { backgroundColor: colors.surface, borderColor: colors.borderHeavy },
          toastAnimStyle,
        ]}>
          <Text style={[styles.toastText, { color: colors.infoText }]}>{toastText}</Text>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    height: 46,
  },
  scrollContent: {
    paddingHorizontal: 6,
    paddingVertical: 6,
    gap: 6,
    alignItems: 'center',
  },
  key: {
    minWidth: 38,
    height: 34,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 7,
    borderWidth: 1,
    position: 'relative',
  },
  keyInner: {
    flex: 1,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  keyLabel: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  keySubLabel: {
    fontSize: 7,
    fontFamily: 'monospace',
    position: 'absolute',
    bottom: 1,
    right: 2,
  },
  toast: {
    position: 'absolute',
    top: -30,
    alignSelf: 'center',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderWidth: 1,
    zIndex: 100,
  },
  toastText: {
    fontSize: 11,
    fontFamily: 'monospace',
  },
});
