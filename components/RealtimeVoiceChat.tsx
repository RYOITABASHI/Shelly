/**
 * components/RealtimeVoiceChat.tsx — full-duplex Gemini Live voice overlay.
 *
 * Rendered by VoiceChat.tsx instead of the default turn-based UI when
 * settings.realtimeVoiceEnabled is on (see hooks/use-realtime-voice.ts's
 * header for why this is a separate hook/component rather than folding
 * into the existing one). No mic-press interaction: the session is
 * continuous once opened — talking over the model interrupts it
 * automatically (server-side VAD), so there's no explicit "stop and send"
 * gesture to wire up here.
 */
import React, { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
} from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRealtimeVoice, type RealtimeVoiceStatus } from '@/hooks/use-realtime-voice';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { useTranslation } from '@/lib/i18n';

type Props = {
  visible: boolean;
  onClose: () => void;
};

const STATUS_ICON: Record<RealtimeVoiceStatus, keyof typeof MaterialIcons.glyphMap> = {
  idle: 'mic-off',
  connecting: 'hourglass-top',
  listening: 'mic',
  speaking: 'volume-up',
  error: 'error-outline',
};

export function RealtimeVoiceChat({ visible, onClose }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { state, start, stop } = useRealtimeVoice();

  useEffect(() => {
    if (visible) {
      start();
    } else {
      stop();
    }
    // start/stop are stable (useCallback with empty deps) — only `visible`
    // should retrigger this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const pulseScale = useSharedValue(1);
  useEffect(() => {
    if (state.status === 'listening' || state.status === 'speaking') {
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
  }, [state.status, pulseScale]);
  const pulseStyle = useAnimatedStyle(() => ({ transform: [{ scale: pulseScale.value }] }));

  const micColor =
    state.status === 'listening' ? '#FF4444'
      : state.status === 'speaking' ? colors.accent
        : state.status === 'error' ? '#F87171'
          : colors.inactive;

  const handleClose = () => {
    stop();
    onClose();
  };

  const statusLabel =
    state.status === 'error'
      ? (state.error === 'gemini_api_key_required'
          ? t('voice.realtime_key_required')
          : t('voice.realtime_error', { error: state.error ?? '' }))
      : t(`voice.realtime_status_${state.status}`);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <View style={[styles.overlay, { backgroundColor: 'rgba(0,0,0,0.92)' }]}>
        <TouchableOpacity style={styles.closeBtn} onPress={handleClose} activeOpacity={0.7}>
          <MaterialIcons name="close" size={24} color={colors.inactive} />
        </TouchableOpacity>

        <View style={styles.header}>
          <MaterialIcons name="graphic-eq" size={20} color={colors.accent} />
          <Text style={[styles.title, { color: colors.foreground }]}>{t('voice.realtime_title')}</Text>
        </View>

        <View style={styles.contentArea}>
          {state.inputTranscript ? (
            <View style={styles.textBlock}>
              <Text style={[styles.label, { color: colors.inactive }]}>{t('voice.you_label')}</Text>
              <Text style={[styles.transcript, { color: colors.foreground }]}>{state.inputTranscript}</Text>
            </View>
          ) : null}
          {state.outputTranscript ? (
            <View style={styles.textBlock}>
              <Text style={[styles.label, { color: colors.accent }]}>{t('voice.ai_label')}</Text>
              <Text style={[styles.response, { color: colors.foregroundDim }]}>{state.outputTranscript}</Text>
            </View>
          ) : null}
        </View>

        <Text style={[styles.statusText, { color: colors.inactive }]}>{statusLabel}</Text>

        <Animated.View
          style={[
            styles.micOuter,
            { backgroundColor: withAlpha(micColor, 0.15), borderColor: withAlpha(micColor, 0.3) },
            pulseStyle,
          ]}
        >
          <View style={[styles.micInner, { backgroundColor: withAlpha(micColor, 0.2) }]}>
            <MaterialIcons name={STATUS_ICON[state.status]} size={40} color={micColor} />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  closeBtn: { position: 'absolute', top: 48, right: 20, width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, position: 'absolute', top: 52, left: 24 },
  title: { fontSize: 16, fontWeight: '700' },
  contentArea: { width: '100%', maxHeight: '40%', marginBottom: 24, gap: 16 },
  textBlock: { gap: 4 },
  label: { fontSize: 10, fontWeight: '700', textTransform: 'uppercase' },
  transcript: { fontSize: 16, lineHeight: 24 },
  response: { fontSize: 15, lineHeight: 23 },
  statusText: { fontSize: 12, marginBottom: 20 },
  micOuter: { width: 120, height: 120, borderRadius: 60, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  micInner: { width: 80, height: 80, borderRadius: 40, alignItems: 'center', justifyContent: 'center' },
});
