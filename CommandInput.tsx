import React, { useState, useRef, useCallback, forwardRef, useImperativeHandle, useEffect, useMemo } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Text,
  Platform,
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withSequence,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTerminalStore } from '@/store/terminal-store';
import { isShellCommand } from '@/lib/input-router';
import { useSpeechInput } from '@/hooks/use-speech-input';
import { ShortcutBar } from './ShortcutBar';
import { AutocompleteDropdown } from '@/components/input/AutocompleteDropdown';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { SPRING_CONFIGS } from '@/hooks/use-motion';
import { playSound } from '@/lib/sounds';

export type ImageAttachment = {
  uri: string;
  base64: string;
  mimeType: string;
  width: number;
  height: number;
};

type Props = {
  onSend: (command: string, images?: ImageAttachment[]) => void;
  onHistoryUp: () => string;
  onHistoryDown: () => string;
  onCtrlC?: () => void;
  isRunning?: boolean;
  isBridgeConnected?: boolean;
};

export type CommandInputHandle = {
  setText: (text: string) => void;
};

const MAX_IMAGES = 4;

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

export const CommandInput = forwardRef<CommandInputHandle, Props>(function CommandInput({
  onSend,
  onHistoryUp,
  onHistoryDown,
  onCtrlC,
  isRunning = false,
  isBridgeConnected = true,
}: Props, ref: React.Ref<CommandInputHandle>) {
  const { colors } = useTheme();
  const [inputText, setInputText] = useState('');
  const [inputHeight, setInputHeight] = useState(40);
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([]);
  const inputRef = useRef<TextInput>(null);

  // Speech input hook
  const { state: speechState, startRecording, stopRecording } = useSpeechInput();

  // Animation shared values
  const sendScale = useSharedValue(1);
  const promptScale = useSharedValue(1);
  const recordingScale = useSharedValue(1);

  // Handle transcription result
  useEffect(() => {
    if (speechState.transcribedText) {
      setInputText((prev) => prev + speechState.transcribedText);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [speechState.transcribedText]);

  // Recording pulse animation
  useEffect(() => {
    if (speechState.status === 'recording') {
      recordingScale.value = withRepeat(
        withSequence(
          withTiming(1.2, { duration: 500 }),
          withTiming(1, { duration: 500 }),
        ),
        -1,
        false,
      );
    } else {
      recordingScale.value = withSpring(1, SPRING_CONFIGS.quick);
    }
  }, [speechState.status]);

  useImperativeHandle(ref, () => ({
    setText: (text: string) => {
      setInputText(text);
      setTimeout(() => inputRef.current?.focus(), 100);
    },
  }), []);
  const { settings } = useTerminalStore();
  const insets = useSafeAreaInsets();

  const isNaturalMode = useMemo(() => {
    const trimmed = inputText.trim();
    if (!trimmed) return false;
    return !isShellCommand(trimmed);
  }, [inputText]);

  // Mode switch animation
  const prevMode = useRef(isNaturalMode);
  useEffect(() => {
    if (prevMode.current !== isNaturalMode) {
      prevMode.current = isNaturalMode;
      promptScale.value = withSequence(
        withSpring(0.8, SPRING_CONFIGS.quick),
        withSpring(1.1, SPRING_CONFIGS.bouncy),
        withSpring(1, SPRING_CONFIGS.snappy),
      );
      playSound('mode_switch');
    }
  }, [isNaturalMode]);

  const ctrlHeld = useRef(false);
  const bottomPad = Platform.OS === 'android' ? Math.max(insets.bottom, 0) : insets.bottom;

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control') ctrlHeld.current = true;
      if ((e.ctrlKey || ctrlHeld.current) && e.key === 'c') {
        if (isRunning) {
          e.preventDefault();
          onCtrlC?.();
        }
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') ctrlHeld.current = false;
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isRunning, onCtrlC]);

  // Send animation + sound
  const handleSend = useCallback(() => {
    const cmd = inputText.trim();
    if (!cmd && attachedImages.length === 0) return;
    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    // Send button animation
    sendScale.value = withSequence(
      withSpring(0.85, SPRING_CONFIGS.quick),
      withSpring(1, SPRING_CONFIGS.bouncy),
    );
    playSound('send');

    onSend(cmd, attachedImages.length > 0 ? attachedImages : undefined);
    setInputText('');
    setInputHeight(40);
    setAttachedImages([]);
  }, [inputText, attachedImages, onSend, settings.hapticFeedback, sendScale]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await Clipboard.getStringAsync();
      if (text) {
        setInputText((prev) => prev + text);
        if (settings.hapticFeedback) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }
      }
    } catch { /* ignore */ }
  }, [settings.hapticFeedback]);

  const pickImageFromGallery = useCallback(async () => {
    if (attachedImages.length >= MAX_IMAGES) return;
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: MAX_IMAGES - attachedImages.length,
        quality: 0.7,
        base64: true,
      });
      if (!result.canceled && result.assets) {
        const newImages: ImageAttachment[] = result.assets
          .filter((a) => a.base64)
          .slice(0, MAX_IMAGES - attachedImages.length)
          .map((a) => ({
            uri: a.uri,
            base64: a.base64!,
            mimeType: a.mimeType || 'image/jpeg',
            width: a.width,
            height: a.height,
          }));
        setAttachedImages((prev) => [...prev, ...newImages].slice(0, MAX_IMAGES));
      }
    } catch { /* ignore */ }
  }, [attachedImages.length]);

  const pickImageFromCamera = useCallback(async () => {
    if (attachedImages.length >= MAX_IMAGES) return;
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') return;
      const result = await ImagePicker.launchCameraAsync({
        quality: 0.7,
        base64: true,
      });
      if (!result.canceled && result.assets?.[0]?.base64) {
        const a = result.assets[0];
        setAttachedImages((prev) => [...prev, {
          uri: a.uri,
          base64: a.base64!,
          mimeType: a.mimeType || 'image/jpeg',
          width: a.width,
          height: a.height,
        }].slice(0, MAX_IMAGES));
      }
    } catch { /* ignore */ }
  }, [attachedImages.length]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleMicToggle = useCallback(async () => {
    if (speechState.status === 'recording') {
      stopRecording();
    } else if (speechState.status === 'idle') {
      startRecording();
    }
  }, [speechState.status, startRecording, stopRecording]);

  const handleSpecialKey = useCallback((key: string, modifier?: string) => {
    if (modifier === 'ctrl') {
      switch (key) {
        case 'c': onCtrlC?.(); break;
        case 'l': onSend('clear'); break;
        case 'u': setInputText(''); break;
        case 'w':
          setInputText((prev) => {
            const trimmed = prev.trimEnd();
            const lastSpace = trimmed.lastIndexOf(' ');
            return lastSpace === -1 ? '' : trimmed.slice(0, lastSpace + 1);
          });
          break;
        default: break;
      }
    } else if (key === 'tab') {
      setInputText((prev) => prev + '  ');
    }
  }, [onSend, onCtrlC]);

  const handleHistoryUp = useCallback(() => {
    const cmd = onHistoryUp();
    if (cmd !== undefined) setInputText(cmd);
  }, [onHistoryUp]);

  const handleHistoryDown = useCallback(() => {
    const cmd = onHistoryDown();
    if (cmd !== undefined) setInputText(cmd);
  }, [onHistoryDown]);

  const handleContentSizeChange = useCallback((e: any) => {
    const h = e.nativeEvent.contentSize.height;
    const clamped = Math.min(Math.max(40, h + 12), 140);
    setInputHeight(clamped);
  }, []);

  const handleKeyPress = useCallback((e: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    // Best-effort hook for future use
  }, []);

  const handleAutocomplete = useCallback((insertText: string) => {
    setInputText((prev) => {
      const parts = prev.trimStart().split(/\s+/);
      parts[parts.length - 1] = insertText;
      return parts.join(' ');
    });
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  const isActive = inputText.trim().length > 0 || attachedImages.length > 0;
  const promptSymbol = isNaturalMode ? 'AI' : '$';
  const promptColor = isNaturalMode ? colors.aiPurple : colors.accent;
  const placeholder = isNaturalMode ? '\u8CEA\u554F\u3084\u6307\u793A\u3092\u5165\u529B...' : '\u30B3\u30DE\u30F3\u30C9\u3092\u5165\u529B...';

  // Animated styles
  const sendAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: sendScale.value }],
  }));
  const promptAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: promptScale.value }],
  }));
  const recordingAnimStyle = useAnimatedStyle(() => ({
    transform: [{ scale: recordingScale.value }],
  }));

  return (
    <View style={[styles.wrapper, { backgroundColor: colors.surfaceHigh, borderTopColor: colors.borderLight, paddingBottom: bottomPad }]}>
      <ShortcutBar
        onSpecialKey={handleSpecialKey}
        onHistoryUp={handleHistoryUp}
        onHistoryDown={handleHistoryDown}
        onCtrlC={onCtrlC}
        isRunning={isRunning}
        isBridgeConnected={isBridgeConnected}
      />

      {!isNaturalMode && inputText.trim().length > 0 && (
        <AutocompleteDropdown input={inputText} onSelect={handleAutocomplete} />
      )}

      {attachedImages.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.thumbnailStrip, { borderBottomColor: colors.surface }]}
          contentContainerStyle={styles.thumbnailStripContent}
        >
          {attachedImages.map((img, i) => (
            <View key={i} style={[styles.thumbnailContainer, { borderColor: colors.border }]}>
              <Image
                source={{ uri: img.uri }}
                style={styles.thumbnail}
                contentFit="cover"
              />
              <TouchableOpacity
                style={styles.thumbnailRemove}
                onPress={() => removeImage(i)}
                activeOpacity={0.7}
              >
                <MaterialIcons name="close" size={12} color="#FFF" />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      <View style={styles.inputRow}>
        {/* Prompt indicator with mode-switch animation */}
        <Animated.Text style={[
          styles.promptText,
          { fontSize: settings.fontSize, color: promptColor },
          isNaturalMode && styles.promptTextAi,
          promptAnimStyle,
        ]}>
          {promptSymbol}
        </Animated.Text>

        <TextInput
          ref={inputRef}
          style={[
            styles.input,
            {
              height: Math.max(40, inputHeight),
              fontSize: settings.fontSize,
              lineHeight: Math.round(settings.fontSize * settings.lineHeight),
              backgroundColor: colors.backgroundDeep,
              color: colors.foreground,
              borderColor: colors.borderLight,
            },
          ]}
          value={inputText}
          onChangeText={setInputText}
          onContentSizeChange={handleContentSizeChange}
          onKeyPress={handleKeyPress}
          multiline
          placeholder={placeholder}
          placeholderTextColor={colors.hint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          keyboardType="default"
          returnKeyType="default"
          blurOnSubmit={false}
          textAlignVertical="top"
          scrollEnabled={inputHeight >= 140}
          inputMode="text"
          onSubmitEditing={undefined}
        />

        {/* Right side: attach (top) + send/mic (bottom) stacked vertically, matching input height */}
        <View style={[styles.sideColumn, { height: Math.max(40, inputHeight) }]}>
          {/* Attach — top half */}
          <TouchableOpacity
            onPress={pickImageFromGallery}
            onLongPress={pickImageFromCamera}
            activeOpacity={0.7}
            style={[styles.halfBtn, { backgroundColor: colors.surface, borderColor: colors.border }, attachedImages.length >= MAX_IMAGES && styles.btnDisabled]}
            disabled={attachedImages.length >= MAX_IMAGES}
          >
            <MaterialIcons name="add" size={18} color={attachedImages.length >= MAX_IMAGES ? colors.borderHeavy : colors.muted} />
          </TouchableOpacity>

          {/* Send / Mic — bottom half */}
          {isActive ? (
            <AnimatedTouchable
              onPress={handleSend}
              activeOpacity={0.7}
              style={[
                styles.halfBtn,
                sendAnimStyle,
                { backgroundColor: colors.accent, borderColor: colors.accent },
              ]}
            >
              <MaterialIcons name="send" size={18} color={colors.background} />
            </AnimatedTouchable>
          ) : (
            <TouchableOpacity
              onPress={handleMicToggle}
              activeOpacity={0.7}
              style={[
                styles.halfBtn,
                { backgroundColor: colors.surface, borderColor: colors.border },
                speechState.status === 'recording' && { borderColor: '#FF4444', backgroundColor: withAlpha(colors.error, 0.1) },
              ]}
              disabled={speechState.status === 'transcribing'}
            >
              {speechState.status === 'transcribing' ? (
                <ActivityIndicator size={16} color={colors.aiPurple} />
              ) : speechState.status === 'recording' ? (
                <Animated.View style={recordingAnimStyle}>
                  <MaterialIcons name="mic" size={18} color="#FF4444" />
                </Animated.View>
              ) : (
                <MaterialIcons name="mic" size={18} color={colors.muted} />
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>

      {speechState.status === 'recording' && (
        <View style={[styles.recordingIndicator, { backgroundColor: withAlpha(colors.error, 0.1) }]}>
          <Animated.View style={[styles.recordingDot, recordingAnimStyle]} />
          <Text style={styles.recordingText}>{'\u9332\u97F3\u4E2D...'}</Text>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    borderTopWidth: 1,
  },
  thumbnailStrip: {
    maxHeight: 68,
    borderBottomWidth: 1,
  },
  thumbnailStripContent: {
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 6,
    flexDirection: 'row',
  },
  thumbnailContainer: {
    position: 'relative',
    width: 56,
    height: 56,
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: 1,
  },
  thumbnail: {
    width: 56,
    height: 56,
  },
  thumbnailRemove: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 8,
    paddingTop: 5,
    paddingBottom: 6,
    gap: 6,
    minHeight: 52,
  },
  promptText: {
    fontFamily: 'monospace',
    fontWeight: '700',
    paddingBottom: 10,
    width: 20,
    textAlign: 'center',
  },
  promptTextAi: {
    fontSize: 12,
    width: 22,
  },
  input: {
    flex: 1,
    fontFamily: 'monospace',
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingTop: 8,
    paddingBottom: 8,
    borderWidth: 1,
    minHeight: 40,
    maxHeight: 140,
  },
  sideColumn: {
    flexDirection: 'column',
    width: 38,
    gap: 3,
  },
  halfBtn: {
    flex: 1,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  btnDisabled: {
    opacity: 0.3,
  },
  recordingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 4,
    gap: 6,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FF4444',
  },
  recordingText: {
    color: '#FF4444',
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '600',
  },
});
