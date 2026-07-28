/**
 * components/panes/PaneInputBar.tsx
 *
 * Shared bottom input bar for all pane types. Buttons live inside a
 * rounded pill next to the input so the whole row reads as one control
 * rather than three separate circles. Pass `showMic` + `onMicPress` to
 * render a mic button next to send (AI pane). Leave off for browser /
 * markdown panes.
 */

import React, { useRef, useState, useCallback, useEffect } from 'react';
import {
  View,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Text,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';
import { usePanelBackground } from '@/hooks/use-panel-background';
import { usePaneStore } from '@/store/pane-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';

type Props = {
  placeholder?: string;
  onSubmit: (text: string) => void;
  onAttach?: () => void;
  showMic?: boolean;
  isRecording?: boolean;
  onMicPress?: () => void;
  onMicLongPress?: () => void;
  /** REMOTE-INPUT-001: this pane's leaf id (from PaneIdContext). When set,
   *  the input bar listens for the native `onRemoteTextInput` event and
   *  inserts the received text at the cursor — but only while this pane is
   *  the focused one (usePaneStore.focusedPaneId), so an adb-triggered
   *  broadcast lands in whichever AI/Browser/Markdown pane the user is
   *  actually looking at, not every mounted PaneInputBar at once. */
  paneId?: string;
};

export default function PaneInputBar({
  placeholder,
  onSubmit,
  onAttach,
  showMic,
  isRecording,
  onMicPress,
  onMicLongPress,
  paneId,
}: Props) {
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);
  const containerBg = usePanelBackground(C.bgSidebar);
  const pillBg = usePanelBackground(C.bgSurface);
  const disabledBg = usePanelBackground(C.bgSidebar);

  // REMOTE-INPUT-001: last-known cursor position, tracked passively via
  // onSelectionChange (the `selection` prop is intentionally left
  // uncontrolled — controlling it every render fights normal typing on RN).
  // Falls back to "append at end" if the user never focused/selected in
  // this field yet.
  const selectionRef = useRef({ start: 0, end: 0 });
  const textRef = useRef('');
  textRef.current = text;

  useEffect(() => {
    if (!paneId) return;
    const sub = TerminalEmulator.addListener('onRemoteTextInput', (event: { text: string }) => {
      if (usePaneStore.getState().focusedPaneId !== paneId) return;
      const current = textRef.current;
      const { start, end } = selectionRef.current;
      const from = Math.min(Math.max(start, 0), current.length);
      const to = Math.min(Math.max(end, from), current.length);
      const next = current.slice(0, from) + event.text + current.slice(to);
      const cursor = from + event.text.length;
      selectionRef.current = { start: cursor, end: cursor };
      setText(next);
    });
    return () => sub.remove();
  }, [paneId]);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText('');
  }, [text, onSubmit]);

  const hasText = text.trim().length > 0;

  return (
    <View style={[styles.container, { backgroundColor: containerBg }]}>
      <View style={[styles.pill, { backgroundColor: pillBg }]}>
        <Text style={styles.promptGlyph}>{'>'}</Text>
        <TextInput
          ref={inputRef}
          style={styles.input}
          value={text}
          onChangeText={setText}
          onSelectionChange={(e) => {
            selectionRef.current = e.nativeEvent.selection;
          }}
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
          style={[styles.sendBtn, !hasText && styles.sendBtnDisabled, !hasText && { backgroundColor: disabledBg }]}
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
    borderTopWidth: S.borderWidth,
    borderTopColor: C.border,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
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
  },
});
