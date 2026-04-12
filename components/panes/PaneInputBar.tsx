/**
 * components/panes/PaneInputBar.tsx
 *
 * Shared bottom input bar for all pane types.
 * Layout: [> TextInput] [attach circle] [send circle]
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
};

export default function PaneInputBar({ placeholder, onSubmit, onAttach }: Props) {
  const [text, setText] = useState('');
  const inputRef = useRef<TextInput>(null);

  const handleSubmit = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText('');
  }, [text, onSubmit]);

  return (
    <View style={styles.container}>
      <View style={styles.inputRow}>
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
      </View>

      <TouchableOpacity
        onPress={onAttach}
        style={styles.circleBtn}
        accessibilityLabel="Attach file"
        accessibilityRole="button"
      >
        <MaterialIcons name="attach-file" size={16} color={C.btnPrimaryText} />
      </TouchableOpacity>

      <TouchableOpacity
        onPress={handleSubmit}
        style={styles.circleBtn}
        accessibilityLabel="Send"
        accessibilityRole="button"
      >
        <MaterialIcons name="arrow-upward" size={16} color={C.btnPrimaryText} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    height: 44,
    backgroundColor: C.bgSidebar,
    borderTopWidth: S.borderWidth,
    borderTopColor: C.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 6,
  },
  inputRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
  },
  promptGlyph: {
    fontSize: 14,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.accent,
    marginRight: 6,
  },
  input: {
    flex: 1,
    height: 34,
    fontFamily: F.family,
    fontSize: 13,
    color: C.text1,
    paddingVertical: 0,
  },
  circleBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.accent,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
