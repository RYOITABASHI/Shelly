import React, { memo } from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import { getCompletions } from '@/lib/completions';
import { colors as C } from '@/theme.config';

type Props = {
  input: string;
  onSelect: (insertText: string) => void;
};

function AutocompleteDropdownInner({ input, onSelect }: Props) {
  const completions = getCompletions(input);

  if (completions.length === 0) return null;

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.scroll}
      >
        {completions.map((c, i) => (
          <Pressable
            key={`${c.label}-${i}`}
            style={styles.chip}
            onPress={() => onSelect(c.insertText)}
          >
            <Text style={styles.chipLabel}>{c.label}</Text>
            {c.detail && (
              <Text style={styles.chipDetail}>{c.detail}</Text>
            )}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

export const AutocompleteDropdown = memo(AutocompleteDropdownInner);

const styles = StyleSheet.create({
  container: {
    backgroundColor: C.bgSurface,
    borderTopWidth: 1,
    borderTopColor: '#1E1E1E',
    paddingVertical: 4,
  },
  scroll: {
    paddingHorizontal: 8,
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: C.border,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  chipLabel: {
    color: C.accent,
    fontSize: 12,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  chipDetail: {
    color: C.text3,
    fontSize: 10,
    fontFamily: 'monospace',
  },
});
