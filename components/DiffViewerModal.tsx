/**
 * DiffViewerModal — Shows git diff with syntax highlighting.
 * Green for additions, red for deletions, blue for hunk headers.
 */
import React from 'react';
import {
  Modal, View, Text, ScrollView, Pressable, StyleSheet,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';
import { useTranslation } from '@/lib/i18n';

type Props = {
  visible: boolean;
  diff: string;
  onClose: () => void;
};

export function DiffViewerModal({ visible, diff, onClose }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const lines = diff.split('\n');

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.overlay, { paddingTop: insets.top }]}>
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.foreground }]}>
              {t('savepoint.view_changes')}
            </Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <MaterialIcons name="close" size={20} color={colors.inactive} />
            </Pressable>
          </View>
          <ScrollView style={styles.scroll}>
            {lines.map((line, i) => {
              let bg = 'transparent';
              let fg = colors.foreground;
              if (line.startsWith('+') && !line.startsWith('+++')) {
                bg = '#00440020';
                fg = '#4ADE80';
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                bg = '#44000020';
                fg = '#F87171';
              } else if (line.startsWith('@@')) {
                fg = '#60A5FA';
              } else if (line.startsWith('diff ')) {
                fg = colors.accent;
              }
              return (
                <Text
                  key={i}
                  style={[styles.line, { color: fg, backgroundColor: bg }]}
                >
                  {line}
                </Text>
              );
            })}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: '#00000088',
  },
  container: {
    flex: 1,
    marginTop: 40,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  title: {
    fontSize: 14,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  scroll: {
    flex: 1,
    padding: 12,
  },
  line: {
    fontFamily: 'monospace',
    fontSize: 11,
    lineHeight: 16,
    paddingHorizontal: 4,
  },
});
