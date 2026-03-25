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
 Alert } from 'react-native';
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
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTerminalStore } from '@/store/terminal-store';
import { isShellCommand } from '@/lib/input-router';
import { useSpeechInput } from '@/hooks/use-speech-input';
import { ShortcutBar } from './ShortcutBar';
import { AutocompleteDropdown } from '@/components/input/AutocompleteDropdown';
import { MentionDropdown } from '@/components/input/MentionDropdown';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { SPRING_CONFIGS } from '@/hooks/use-motion';
import { playSound } from '@/lib/sounds';
import { useTranslation } from '@/lib/i18n';

export type ImageAttachment = {
  uri: string;
  base64: string;
  mimeType: string;
  width: number;
  height: number;
};

export type FileAttachment = {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  content?: string; // text content (for text files)
};

type Props = {
  onSend: (command: string, images?: ImageAttachment[], files?: FileAttachment[]) => void;
  onHistoryUp: () => string;
  onHistoryDown: () => string;
  onCtrlC?: () => void;
  onStdin?: (data: string) => void;
  isRunning?: boolean;
  isBridgeConnected?: boolean;
  showShortcutBar?: boolean;
};

export type CommandInputHandle = {
  setText: (text: string) => void;
};

const MAX_IMAGES = 4;
const MAX_FILE_SIZE = 100 * 1024; // 100KB
const SENSITIVE_PATTERNS = /\.(env(\.\w+)?|pem|key|p12|pfx|jks|keystore|credentials|secret|ppk)$|^(id_rsa|id_ed25519|\.htpasswd|\.pgpass|\.netrc|\.npmrc|\.pypirc)$/i;

const AnimatedTouchable = Animated.createAnimatedComponent(TouchableOpacity);

export const CommandInput = forwardRef<CommandInputHandle, Props>(function CommandInput({
  onSend,
  onHistoryUp,
  onHistoryDown,
  onCtrlC,
  onStdin,
  isRunning = false,
  showShortcutBar = true,
  isBridgeConnected = true,
}: Props, ref: React.Ref<CommandInputHandle>) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [inputText, setInputText] = useState('');
  const [inputHeight, setInputHeight] = useState(40);
  const [attachedImages, setAttachedImages] = useState<ImageAttachment[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<FileAttachment[]>([]);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
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

  // Detected routing mode for visual indicator
  const detectedMode = useMemo((): { label: string; color: string } | null => {
    const trimmed = inputText.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('@claude')) return { label: 'Claude', color: '#F59E0B' };
    if (trimmed.startsWith('@gemini')) return { label: 'Gemini', color: '#3B82F6' };
    if (trimmed.startsWith('@local')) return { label: 'Local LLM', color: '#8B5CF6' };
    if (trimmed.startsWith('@perplexity')) return { label: 'Perplexity', color: '#14B8A6' };
    if (trimmed.startsWith('@team')) return { label: 'Team', color: '#EC4899' };
    if (trimmed.startsWith('@git')) return { label: 'Git', color: '#F97316' };
    if (trimmed.startsWith('@open')) return { label: 'Browser', color: '#3B82F6' };
    if (trimmed.startsWith('@')) return { label: 'AI', color: '#8B5CF6' };
    if (!isShellCommand(trimmed)) return { label: 'AI', color: '#8B5CF6' };
    return { label: 'Shell', color: '#93C5FD' };
  }, [inputText]);

  // @mention detection: show dropdown when input starts with @ (no space yet after trigger)
  const mentionState = useMemo(() => {
    let trimmed = inputText.trimStart();
    // Support fullwidth @ (Japanese keyboards)
    if (trimmed.startsWith('＠')) trimmed = '@' + trimmed.slice(1);
    if (!trimmed.startsWith('@')) return null;
    // If there's a space after the @word, mention is already "committed"
    const firstSpace = trimmed.indexOf(' ');
    if (firstSpace !== -1) return null;
    // Extract query after @
    return { query: trimmed.slice(1) };
  }, [inputText]);

  const handleMentionSelect = useCallback((trigger: string) => {
    setInputText(trigger + ' ');
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

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
  const bottomPad = Platform.OS === 'android' ? Math.max(insets.bottom, 8) : insets.bottom;

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
    if (!cmd && attachedImages.length === 0 && attachedFiles.length === 0) return;

    // If a process is running and onStdin is available, send as stdin
    if (isRunning && onStdin) {
      onStdin(inputText + '\n');
      setInputText('');
      setInputHeight(40);
      if (settings.hapticFeedback) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
      return;
    }

    if (settings.hapticFeedback) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    // Send button animation
    sendScale.value = withSequence(
      withSpring(0.85, SPRING_CONFIGS.quick),
      withSpring(1, SPRING_CONFIGS.bouncy),
    );
    playSound('send');

    onSend(
      cmd,
      attachedImages.length > 0 ? attachedImages : undefined,
      attachedFiles.length > 0 ? attachedFiles : undefined,
    );
    setInputText('');
    setInputHeight(40);
    setAttachedImages([]);
    setAttachedFiles([]);
  }, [inputText, attachedImages, attachedFiles, onSend, onStdin, isRunning, settings.hapticFeedback, sendScale]);

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

  const pickFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        multiple: true,
      });
      if (result.canceled || !result.assets) return;
      const newFiles: FileAttachment[] = [];
      for (const asset of result.assets.slice(0, 4 - attachedFiles.length)) {
        // Sensitive file warning
        if (SENSITIVE_PATTERNS.test(asset.name)) {
          const confirmed = await new Promise<boolean>((resolve) => {
            Alert.alert(
              t('input.sensitive_title'),
              t('input.sensitive_message', { name: asset.name }),
              [
                { text: t('input.sensitive_cancel'), style: 'cancel', onPress: () => resolve(false) },
                { text: t('input.sensitive_attach'), style: 'destructive', onPress: () => resolve(true) },
              ],
            );
          });
          if (!confirmed) continue;
        }

        const file: FileAttachment = {
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType || 'application/octet-stream',
          size: asset.size || 0,
        };
        // Read text content for text-based files (with size limit)
        if (asset.mimeType?.startsWith('text/') || /\.(txt|md|json|js|ts|tsx|jsx|py|sh|yml|yaml|toml|xml|csv|log|conf|cfg|env|html|css|sql)$/i.test(asset.name)) {
          try {
            const fileSize = asset.size || 0;
            if (fileSize > MAX_FILE_SIZE) {
              // Read full content then truncate (readAsStringAsync doesn't support length option)
              const fullContent = await FileSystem.readAsStringAsync(asset.uri);
              file.content = fullContent.slice(0, MAX_FILE_SIZE) +
                `\n\n... (${Math.round(fileSize / 1024)}KB, first 100KB only)`;
            } else {
              file.content = await FileSystem.readAsStringAsync(asset.uri);
            }
          } catch { /* binary file, skip content */ }
        }
        newFiles.push(file);
      }
      setAttachedFiles((prev) => [...prev, ...newFiles].slice(0, 4));
    } catch { /* ignore */ }
  }, [attachedFiles.length]);

  const removeFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
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

  const isStdinMode = isRunning && !!onStdin;
  const isActive = inputText.trim().length > 0 || attachedImages.length > 0 || attachedFiles.length > 0;
  const promptSymbol = isStdinMode ? '>' : isNaturalMode ? 'AI' : '$';
  const promptColor = isStdinMode ? colors.warning ?? '#F59E0B' : isNaturalMode ? colors.aiPurple : colors.accent;
  const placeholder = isStdinMode ? t('input.placeholder_stdin') : isNaturalMode ? t('input.placeholder_ai') : t('input.placeholder_shell');

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
      {showShortcutBar && (
        <ShortcutBar
          onSpecialKey={handleSpecialKey}
          onHistoryUp={handleHistoryUp}
          onHistoryDown={handleHistoryDown}
          onCtrlC={onCtrlC}
          onCtrlD={isStdinMode ? () => onStdin?.('\x04') : undefined}
          isRunning={isRunning}
          isBridgeConnected={isBridgeConnected}
        />
      )}

      {mentionState ? (
        <MentionDropdown query={mentionState.query} onSelect={handleMentionSelect} />
      ) : !isNaturalMode && inputText.trim().length > 0 ? (
        <AutocompleteDropdown input={inputText} onSelect={handleAutocomplete} />
      ) : null}

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

      {attachedFiles.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.thumbnailStrip, { borderBottomColor: colors.surface }]}
          contentContainerStyle={styles.thumbnailStripContent}
        >
          {attachedFiles.map((file, i) => (
            <View key={`file-${i}`} style={[styles.fileChip, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <MaterialIcons name="attach-file" size={12} color={colors.muted} />
              <Text style={[styles.fileChipName, { color: colors.foreground }]} numberOfLines={1}>
                {file.name}
              </Text>
              <Text style={[styles.fileChipSize, { color: colors.inactive }]}>
                {file.size < 1024 ? `${file.size}B` : file.size < 1048576 ? `${(file.size / 1024).toFixed(0)}KB` : `${(file.size / 1048576).toFixed(1)}MB`}
              </Text>
              <TouchableOpacity onPress={() => removeFile(i)} activeOpacity={0.7}>
                <MaterialIcons name="close" size={14} color={colors.inactive} />
              </TouchableOpacity>
            </View>
          ))}
        </ScrollView>
      )}

      {/* Route mode indicator */}
      {detectedMode && (
        <View style={styles.modeIndicatorRow}>
          <View style={[styles.modeBadge, { backgroundColor: withAlpha(detectedMode.color, 0.12), borderColor: withAlpha(detectedMode.color, 0.3) }]}>
            <View style={[styles.modeDot, { backgroundColor: detectedMode.color }]} />
            <Text style={[styles.modeLabel, { color: detectedMode.color }]}>{detectedMode.label}</Text>
          </View>
        </View>
      )}

      {/* Attach popup menu */}
      {showAttachMenu && (
        <View style={[styles.attachMenu, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <TouchableOpacity
            style={[styles.attachMenuItem, { borderBottomColor: colors.border }]}
            onPress={() => { setShowAttachMenu(false); pickImageFromGallery(); }}
            activeOpacity={0.7}
            disabled={attachedImages.length >= MAX_IMAGES}
            accessibilityRole="button"
            accessibilityLabel="Pick image from gallery"
          >
            <MaterialIcons name="photo-library" size={18} color={attachedImages.length >= MAX_IMAGES ? colors.borderHeavy : colors.accent} />
            <Text style={[styles.attachMenuLabel, { color: attachedImages.length >= MAX_IMAGES ? colors.borderHeavy : colors.foreground }]}>{t('input.gallery')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.attachMenuItem, { borderBottomColor: colors.border }]}
            onPress={() => { setShowAttachMenu(false); pickImageFromCamera(); }}
            activeOpacity={0.7}
            disabled={attachedImages.length >= MAX_IMAGES}
            accessibilityRole="button"
            accessibilityLabel={t('input.camera')}
          >
            <MaterialIcons name="camera-alt" size={18} color={attachedImages.length >= MAX_IMAGES ? colors.borderHeavy : colors.accent} />
            <Text style={[styles.attachMenuLabel, { color: attachedImages.length >= MAX_IMAGES ? colors.borderHeavy : colors.foreground }]}>{t('input.camera')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.attachMenuItem, { borderBottomColor: colors.border }]}
            onPress={() => { setShowAttachMenu(false); pickFile(); }}
            activeOpacity={0.7}
            disabled={attachedFiles.length >= 4}
            accessibilityRole="button"
            accessibilityLabel={t('input.file')}
          >
            <MaterialIcons name="attach-file" size={18} color={attachedFiles.length >= 4 ? colors.borderHeavy : colors.accent} />
            <Text style={[styles.attachMenuLabel, { color: attachedFiles.length >= 4 ? colors.borderHeavy : colors.foreground }]}>{t('input.file')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.attachMenuItem, { borderBottomColor: colors.border }]}
            onPress={() => { setShowAttachMenu(false); handlePaste(); }}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={t('input.paste')}
          >
            <MaterialIcons name="content-paste" size={18} color={colors.accent} />
            <Text style={[styles.attachMenuLabel, { color: colors.foreground }]}>{t('input.paste')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.attachMenuItem}
            onPress={() => { setShowAttachMenu(false); handleMicToggle(); }}
            activeOpacity={0.7}
            disabled={speechState.status === 'transcribing'}
            accessibilityRole="button"
            accessibilityLabel={t('input.voice')}
          >
            <MaterialIcons name="mic" size={18} color={speechState.status === 'recording' ? '#FF4444' : colors.accent} />
            <Text style={[styles.attachMenuLabel, { color: colors.foreground }]}>{t('input.voice')}</Text>
          </TouchableOpacity>
        </View>
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

        <View style={styles.actionButtons}>
          {/* "+" attach menu toggle */}
          <TouchableOpacity
            onPress={() => setShowAttachMenu((v) => !v)}
            activeOpacity={0.7}
            style={[styles.smallBtn, { backgroundColor: showAttachMenu ? withAlpha(colors.accent, 0.15) : colors.surface, borderColor: showAttachMenu ? colors.accent : colors.border }]}
            accessibilityRole="button"
            accessibilityLabel="Attach menu"
          >
            <MaterialIcons name={showAttachMenu ? 'close' : 'add'} size={17} color={showAttachMenu ? colors.accent : colors.muted} />
          </TouchableOpacity>
          {/* Send button */}
          <AnimatedTouchable
            onPress={handleSend}
            activeOpacity={0.7}
            style={[
              styles.sendBtn,
              sendAnimStyle,
              isActive
                ? { backgroundColor: colors.accent }
                : { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Send"
          >
            <MaterialIcons
              name="send"
              size={15}
              color={isActive ? colors.background : colors.inactive}
            />
          </AnimatedTouchable>
        </View>
      </View>

      {speechState.status === 'recording' && (
        <View style={[styles.recordingIndicator, { backgroundColor: withAlpha(colors.error, 0.1) }]}>
          <Animated.View style={[styles.recordingDot, recordingAnimStyle]} />
          <Text style={styles.recordingText}>{t('input.recording')}</Text>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  wrapper: {
    borderTopWidth: 1,
  },
  modeIndicatorRow: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingTop: 6,
    paddingBottom: 2,
  },
  modeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
  },
  modeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  modeLabel: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '700',
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
    gap: 5,
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
  attachMenu: {
    borderWidth: 1,
    borderRadius: 8,
    marginHorizontal: 10,
    marginBottom: 4,
    overflow: 'hidden',
  },
  attachMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderBottomWidth: StyleSheet.hairlineWidth,
    minHeight: 34,
  },
  attachMenuLabel: {
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '500',
  },
  actionButtons: {
    flexDirection: 'row',
    gap: 5,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
  },
  smallBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  btnDisabled: {
    opacity: 0.3,
  },
  sendBtn: {
    width: 40,
    height: 40,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
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
  fileChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
    maxWidth: 200,
  },
  fileChipName: {
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
  },
  fileChipSize: {
    fontSize: 9,
    fontFamily: 'monospace',
  },
});
