import React, { memo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';

type Props = { filePath: string };

export const PdfRenderer = memo(function PdfRenderer({ filePath }: Props) {
  const { colors } = useTheme();

  return (
    <View style={styles.container}>
      <MaterialIcons name="picture-as-pdf" size={48} color="#EF4444" />
      <Text style={[styles.text, { color: colors.foreground }]}>PDF Preview</Text>
      <Text style={[styles.subtext, { color: colors.muted }]}>{filePath.split('/').pop()}</Text>
      <TouchableOpacity
        style={[styles.button, { backgroundColor: withAlpha(colors.accent, 0.15) }]}
        onPress={() => Linking.openURL(`file://${filePath}`).catch(() => {})}
        activeOpacity={0.7}
      >
        <MaterialIcons name="open-in-new" size={16} color={colors.accent} />
        <Text style={[styles.buttonText, { color: colors.accent }]}>Open externally</Text>
      </TouchableOpacity>
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  text: { fontFamily: 'Silkscreen', fontSize: 16, fontWeight: '600' },
  subtext: { fontFamily: 'Silkscreen', fontSize: 12 },
  button: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  buttonText: { fontFamily: 'Silkscreen', fontSize: 13, fontWeight: '600' },
});
