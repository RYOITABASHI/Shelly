import React, { useRef, useEffect, useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useQuickTerminalStore } from '@/hooks/use-quick-terminal';
import { useTerminalStore } from '@/store/terminal-store';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { useTranslation } from '@/lib/i18n';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { SPRING_CONFIGS, TIMING_CONFIGS } from '@/hooks/use-motion';
import { playSound } from '@/lib/sounds';

const PANEL_HEIGHT = 280;

export function QuickTerminal() {
  const { colors } = useTheme();
  const { isOpen, close } = useQuickTerminalStore();
  const insets = useSafeAreaInsets();
  const inputRef = useRef<TextInput>(null);
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<{ cmd: string; output: string }[]>([]);

  const { connectionMode, runCommand } = useTerminalStore();
  const { sendCommand, isConnected } = useTermuxBridge();
  const { t } = useTranslation();

  // Reanimated shared values
  const translateY = useSharedValue(-PANEL_HEIGHT);
  const backdropOpacity = useSharedValue(0);

  useEffect(() => {
    if (isOpen) {
      playSound('quick_open');
      translateY.value = withSpring(0, SPRING_CONFIGS.gentle);
      backdropOpacity.value = withTiming(1, TIMING_CONFIGS.normal);
      setTimeout(() => inputRef.current?.focus(), 200);
    } else {
      translateY.value = withSpring(-PANEL_HEIGHT, SPRING_CONFIGS.gentle);
      backdropOpacity.value = withTiming(0, TIMING_CONFIGS.exit);
    }
  }, [isOpen]);

  // Swipe-up gesture to close
  const panGesture = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationY < 0) {
        translateY.value = e.translationY;
      }
    })
    .onEnd((e) => {
      if (e.translationY < -80) {
        translateY.value = withSpring(-PANEL_HEIGHT, SPRING_CONFIGS.gentle);
        backdropOpacity.value = withTiming(0, TIMING_CONFIGS.exit);
        runOnJS(playSound)('quick_close');
        runOnJS(close)();
      } else {
        translateY.value = withSpring(0, SPRING_CONFIGS.gentle);
      }
    });

  const panelAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const backdropAnimStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.value,
  }));

  const handleSend = useCallback(() => {
    const cmd = input.trim();
    if (!cmd) return;
    setInput('');
    playSound('send');

    if (connectionMode === 'termux' && isConnected) {
      sendCommand(cmd);
      setHistory((h) => [...h.slice(-9), { cmd, output: t('quick.running_termux') }]);
    } else {
      runCommand(cmd);
      setHistory((h) => [...h.slice(-9), { cmd, output: t('quick.completed') }]);
    }
  }, [input, connectionMode, isConnected, sendCommand, runCommand]);

  const handleClose = useCallback(() => {
    playSound('quick_close');
    close();
  }, [close]);

  if (!isOpen) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Backdrop */}
      <Animated.View style={[styles.backdrop, backdropAnimStyle]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
      </Animated.View>

      {/* Slide-down panel */}
      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[
            styles.panel,
            { paddingTop: insets.top, backgroundColor: colors.background, borderBottomColor: colors.border },
            panelAnimStyle,
          ]}
        >
          {/* Header */}
          <View style={[styles.header, { borderBottomColor: colors.surface }]}>
            <MaterialIcons name="keyboard-arrow-down" size={18} color={colors.muted} />
            <Text style={[styles.headerTitle, { color: colors.infoText }]}>Quick Terminal</Text>
            <View style={styles.headerRight}>
              <View style={[styles.statusDot, { backgroundColor: isConnected ? colors.accent : colors.error }]} />
              <Pressable onPress={handleClose} hitSlop={8}>
                <MaterialIcons name="close" size={16} color={colors.muted} />
              </Pressable>
            </View>
          </View>

          {/* Mini history */}
          <View style={styles.historyArea}>
            {history.length === 0 ? (
              <Text style={[styles.placeholder, { color: colors.borderHeavy }]}>{t('quick.placeholder')}</Text>
            ) : (
              history.map((entry, i) => (
                <View key={i} style={styles.historyEntry}>
                  <Text style={[styles.historyCmd, { color: colors.command }]}>$ {entry.cmd}</Text>
                  <Text style={[styles.historyOutput, { color: colors.muted }]}>{entry.output}</Text>
                </View>
              ))
            )}
          </View>

          {/* Input */}
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={[styles.inputRow, { borderTopColor: colors.surface }]}>
              <Text style={[styles.promptChar, { color: colors.accent }]}>$</Text>
              <TextInput
                ref={inputRef}
                style={[styles.input, { color: colors.foreground }]}
                value={input}
                onChangeText={setInput}
                placeholder="command..."
                placeholderTextColor={colors.inactive}
                selectionColor={colors.accent}
                onSubmitEditing={handleSend}
                returnKeyType="send"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Pressable style={styles.sendBtn} onPress={handleSend}>
                <MaterialIcons name="send" size={18} color={colors.accent} />
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  panel: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: PANEL_HEIGHT + 60,
    borderBottomWidth: 1,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    zIndex: 200,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    gap: 8,
  },
  headerTitle: {
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
    flex: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  historyArea: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  placeholder: {
    fontSize: 12,
    fontFamily: 'monospace',
    textAlign: 'center',
    marginTop: 20,
  },
  historyEntry: {
    marginBottom: 4,
  },
  historyCmd: {
    fontSize: 12,
    fontFamily: 'monospace',
  },
  historyOutput: {
    fontSize: 11,
    fontFamily: 'monospace',
    marginLeft: 16,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    gap: 8,
  },
  promptChar: {
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  input: {
    flex: 1,
    fontSize: 14,
    fontFamily: 'monospace',
    paddingVertical: 6,
  },
  sendBtn: {
    padding: 6,
  },
});
