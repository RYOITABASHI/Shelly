/**
 * components/VoiceChat.tsx — Voice Conversation Overlay
 *
 * Full-screen overlay for voice dialogue mode.
 * Tap to talk → AI responds with voice → auto-continues.
 */

import React, { useCallback, useEffect } from 'react';
import { useTranslation } from '@/lib/i18n';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  Modal,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useVoiceChat, type VoiceChatStatus } from '@/hooks/use-voice-chat';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';

type Props = {
  visible: boolean;
  onClose: () => void;
};

const STATUS_LABELS: Record<VoiceChatStatus, string> = {
  idle: 'Tap to talk',
  listening: 'Listening...',
  transcribing: 'Transcribing...',
  thinking: 'Thinking...',
  executing: 'Running command...',
  speaking: 'Speaking...',
};

const STATUS_ICONS: Record<VoiceChatStatus, keyof typeof MaterialIcons.glyphMap> = {
  idle: 'mic',
  listening: 'mic',
  transcribing: 'hearing',
  thinking: 'psychology',
  executing: 'terminal',
  speaking: 'volume-up',
};

export function VoiceChat({ visible, onClose }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const {
    state,
    startListening,
    stopAndProcess,
    activate,
    deactivate,
    toggleAutoContinue,
  } = useVoiceChat();

  // Activate on open, deactivate on close
  useEffect(() => {
    if (visible) {
      activate();
    } else {
      deactivate();
    }
  }, [visible]);

  // Auto-start listening when idle and active with autoContinue
  useEffect(() => {
    if (state.isActive && state.status === 'idle' && state.autoContinue && state.response) {
      // Small delay after TTS finishes before next listen
      const timer = setTimeout(() => {
        startListening();
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [state.status, state.isActive, state.autoContinue, state.response]);

  // Pulse animation for recording
  const pulseScale = useSharedValue(1);
  useEffect(() => {
    if (state.status === 'listening') {
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.15, { duration: 600, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 600, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        false,
      );
    } else {
      pulseScale.value = withTiming(1, { duration: 200 });
    }
  }, [state.status]);

  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulseScale.value }],
  }));

  const handleMicPress = useCallback(() => {
    if (state.status === 'idle') {
      startListening();
    } else if (state.status === 'listening') {
      stopAndProcess();
    }
  }, [state.status, startListening, stopAndProcess]);

  const handleClose = useCallback(() => {
    deactivate();
    onClose();
  }, [deactivate, onClose]);

  const isRecording = state.status === 'listening';
  const isProcessing = state.status === 'transcribing' || state.status === 'thinking' || state.status === 'executing';
  const isBusy = isProcessing || state.status === 'speaking';

  const micColor = isRecording ? '#FF4444' : isBusy ? colors.inactive : colors.accent;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
    >
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.92)' }]}>
        {/* Close button */}
        <TouchableOpacity
          style={styles.closeBtn}
          onPress={handleClose}
          activeOpacity={0.7}
        >
          <MaterialIcons name="close" size={24} color={colors.inactive} />
        </TouchableOpacity>

        {/* Header */}
        <View style={styles.header}>
          <MaterialIcons name="record-voice-over" size={20} color={colors.accent} />
          <Text style={[styles.title, { color: colors.foreground }]}>Voice Chat</Text>
        </View>

        {/* Transcript area */}
        <View style={styles.contentArea}>
          {state.transcript ? (
            <View style={styles.textBlock}>
              <Text style={[styles.label, { color: colors.inactive }]}>You:</Text>
              <Text style={[styles.transcript, { color: colors.foreground }]}>
                {state.transcript}
              </Text>
            </View>
          ) : null}

          {state.executedCommand ? (
            <View style={styles.textBlock}>
              <Text style={[styles.label, { color: '#22C55E' }]}>$</Text>
              <Text style={[styles.commandText, { color: '#22C55E' }]}>
                {state.executedCommand}
              </Text>
            </View>
          ) : null}

          {state.response ? (
            <View style={styles.textBlock}>
              <Text style={[styles.label, { color: colors.accent }]}>
                {state.executedCommand ? 'Result:' : 'AI:'}
              </Text>
              <Text style={[styles.response, { color: colors.foregroundDim }]}>
                {state.response}
              </Text>
            </View>
          ) : null}

          {state.error ? (
            <Text style={styles.error}>{state.error}</Text>
          ) : null}
        </View>

        {/* Status */}
        <Text style={[styles.statusText, { color: colors.inactive }]}>
          {STATUS_LABELS[state.status]}
        </Text>

        {/* Mic button */}
        <Pressable
          onPress={handleMicPress}
          disabled={isBusy}
          style={styles.micArea}
        >
          <Animated.View
            style={[
              styles.micOuter,
              {
                backgroundColor: withAlpha(micColor, 0.15),
                borderColor: withAlpha(micColor, 0.3),
              },
              pulseStyle,
            ]}
          >
            <View
              style={[
                styles.micInner,
                { backgroundColor: withAlpha(micColor, 0.2) },
              ]}
            >
              <MaterialIcons
                name={STATUS_ICONS[state.status]}
                size={40}
                color={micColor}
              />
            </View>
          </Animated.View>
        </Pressable>

        {/* Auto-continue toggle */}
        <TouchableOpacity
          style={[
            styles.toggleBtn,
            {
              backgroundColor: state.autoContinue
                ? withAlpha(colors.accent, 0.12)
                : colors.surface,
              borderColor: state.autoContinue
                ? withAlpha(colors.accent, 0.3)
                : colors.border,
            },
          ]}
          onPress={toggleAutoContinue}
          activeOpacity={0.7}
        >
          <MaterialIcons
            name={state.autoContinue ? 'loop' : 'stop'}
            size={14}
            color={state.autoContinue ? colors.accent : colors.inactive}
          />
          <Text
            style={[
              styles.toggleText,
              { color: state.autoContinue ? colors.accent : colors.inactive },
            ]}
          >
            {state.autoContinue ? t('voice.auto_on') : t('voice.auto_off')}
          </Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  closeBtn: {
    position: 'absolute',
    top: 48,
    right: 20,
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    position: 'absolute',
    top: 52,
    left: 24,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
  },
  contentArea: {
    width: '100%',
    maxHeight: '40%',
    marginBottom: 24,
    gap: 16,
  },
  textBlock: {
    gap: 4,
  },
  label: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  transcript: {
    fontSize: 16,
    lineHeight: 24,
  },
  commandText: {
    fontSize: 14,
    lineHeight: 20,
  },
  response: {
    fontSize: 15,
    lineHeight: 23,
  },
  error: {
    fontSize: 12,
    color: '#F87171',
  },
  statusText: {
    fontSize: 12,
    marginBottom: 20,
  },
  micArea: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  micOuter: {
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  micInner: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 28,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  toggleText: {
    fontSize: 11,
    fontWeight: '600',
  },
});
