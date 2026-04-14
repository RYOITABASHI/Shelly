// components/settings/ModalHeader.tsx
//
// Shared header for Settings wrapper modals (MCP, Local LLM, future
// integrations). Three-column layout — BACK on the left, centered title,
// CLOSE on the right. Both BACK and CLOSE call the same onClose handler;
// the redundancy is deliberate so users can reach back navigation from
// either side of the header regardless of their thumb position or
// Android back-gesture availability.

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors as C, fonts as F } from '@/theme.config';

type Props = {
  title: string;
  onClose: () => void;
  /** Optional extra element rendered under the title bar (e.g., endpoint URL). */
  subtitle?: React.ReactNode;
};

export function ModalHeader({ title, onClose, subtitle }: Props) {
  // Respect Android status bar / notch — otherwise BACK/× collide with
  // the system clock and battery icons on devices like the Z Fold6 (bug #33).
  const insets = useSafeAreaInsets();
  return (
    <View>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable
          onPress={onClose}
          hitSlop={10}
          style={styles.backButton}
          accessibilityRole="button"
          accessibilityLabel={`Back from ${title}`}
        >
          <MaterialIcons name="arrow-back" size={16} color={C.accent} />
          <Text style={styles.backText}>BACK</Text>
        </Pressable>
        <View style={styles.titleWrap} pointerEvents="none">
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
        </View>
        <Pressable
          onPress={onClose}
          hitSlop={10}
          style={styles.closeButton}
          accessibilityRole="button"
          accessibilityLabel={`Close ${title}`}
        >
          <MaterialIcons name="close" size={16} color={C.text2} />
        </Pressable>
      </View>
      {subtitle}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
    // Relative positioning so the absolute-positioned titleWrap centers
    // against the full header width regardless of left/right button widths.
    position: 'relative',
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    minHeight: 32,
    zIndex: 2,
  },
  backText: {
    fontFamily: F.family,
    fontSize: 11,
    fontWeight: '700',
    color: C.accent,
    letterSpacing: 0.5,
  },
  titleWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1,
  },
  title: {
    fontFamily: F.family,
    fontSize: 12,
    fontWeight: '700',
    color: C.accent,
    letterSpacing: 0.5,
  },
  closeButton: {
    marginLeft: 'auto',
    paddingHorizontal: 8,
    paddingVertical: 4,
    minHeight: 32,
    minWidth: 32,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
});
