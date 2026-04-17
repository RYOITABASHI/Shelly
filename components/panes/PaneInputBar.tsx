/**
 * components/panes/PaneInputBar.tsx
 *
 * Shared bottom input bar for all pane types. Buttons live inside a
 * rounded pill next to the input so the whole row reads as one control
 * rather than three separate circles. Pass `showMic` + `onMicPress` to
 * render a mic button next to send (AI pane). Leave off for browser /
 * markdown panes.
 */

import React, { useRef, useState, useCallback } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Text,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

type Props = {
  placeholder?: string;
  onSubmit: (text: string) => void;
  onAttach?: () => void;
  showMic?: boolean;
  isRecording?: boolean;
  onMicPress?: () => void;
  onMicLongPress?: () => void;
};

export default function PaneInputBar({
  placeholder,
  onSubmit,
  onAttach,
  showMic,
  isRecording,
  onMicPress,
  onMicLongPress,
}: Props) {
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText('');
  }, [text, onSubmit]);

  const hasText = text.trim().length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.pill}>
        <Text style={styles.promptGlyph}>{'>'}</Text>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder={placeholder ?? ''}
          placeholderTextColor={C.text3}
          onSubmitEditing={handleSubmit}
          blurOnSubmit={false}
          returnKeyType="send"
          autoCapitalize="none"
          autoCorrect={false}
        />
        {onAttach ? (
          <TouchableOpacity
            onPress={onAttach}
            style={styles.iconBtn}
            hitSlop={6}
            accessibilityLabel="Attach file"
            accessibilityRole="button"
          >
            <MaterialIcons name="attach-file" size={14} color={C.text2} />
          </TouchableOpacity>
        ) : null}
        {showMic ? (
          <TouchableOpacity
            onPress={onMicPress}
            onLongPress={onMicLongPress}
            delayLongPress={500}
            style={[styles.iconBtn, isRecording && styles.iconBtnRecording]}
            hitSlop={6}
            accessibilityLabel={isRecording ? 'Stop recording' : 'Start voice input'}
            accessibilityRole="button"
          >
            <MaterialIcons
              name={isRecording ? 'mic' : 'mic-none'}
              size={14}
              color={isRecording ? '#000' : C.text2}
            />
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={handleSubmit}
          disabled={!hasText}
          style={[styles.sendBtn, !hasText && styles.sendBtnDisabled]}
          hitSlop={6}
          accessibilityLabel="Send"
          accessibilityRole="button"
        >
          <MaterialIcons
            name="arrow-upward"
            size={14}
            color={hasText ? C.btnPrimaryText : C.text3}
          />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: C.bgSidebar,
    borderTopWidth: S.borderWidth,
    borderTopColor: C.border,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: C.bgSurface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 16,
    paddingLeft: 10,
    paddingRight: 4,
    minHeight: 32,
  },
  promptGlyph: {
    fontSize: 10,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.accent,
    marginRight: 6,
  },
  input: {
    flex: 1,
    fontFamily: F.family,
    fontSize: 11,
    color: C.text1,
    paddingVertical: 4,
    paddingHorizontal: 0,
  },
  iconBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 2,
  },
  iconBtnRecording: {
    backgroundColor: C.accent,
  },
  sendBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: C.accent,
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 4,
  },
  sendBtnDisabled: {
    backgroundColor: C.bgSidebar,
  },
});
