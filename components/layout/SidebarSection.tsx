// components/layout/SidebarSection.tsx
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';

const ACCENT = '#00D4AA';

type Props = {
  title: string;
  icon: string;
  isOpen: boolean;
  onToggle: () => void;
  badge?: number;
  iconsOnly?: boolean;
  children: React.ReactNode;
};

export function SidebarSection({
  title,
  icon,
  isOpen,
  onToggle,
  badge,
  iconsOnly,
  children,
}: Props) {
  const theme = useTheme();
  const c = theme.colors;

  if (iconsOnly) {
    return (
      <Pressable style={styles.iconBtn} onPress={onToggle} hitSlop={4}>
        <MaterialIcons name={icon as any} size={18} color={isOpen ? ACCENT : '#6B7280'} />
        {badge != null && badge > 0 && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
          </View>
        )}
      </Pressable>
    );
  }

  return (
    <View style={styles.section}>
      <Pressable style={styles.header} onPress={onToggle}>
        <Text style={styles.title}>{title}</Text>
        {badge != null && badge > 0 && (
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{badge}</Text>
          </View>
        )}
        <View style={styles.spacer} />
        <MaterialIcons
          name={isOpen ? 'expand-less' : 'expand-more'}
          size={14}
          color="#6B7280"
        />
      </Pressable>
      {isOpen && <View style={styles.body}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 0,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  title: {
    fontSize: 8,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    color: '#6B7280',
  },
  spacer: { flex: 1 },
  countBadge: {
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginLeft: 4,
    backgroundColor: 'rgba(0,212,170,0.15)',
  },
  countText: {
    fontSize: 7,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '800',
    color: ACCENT,
  },
  body: {
    paddingBottom: 4,
  },
  iconBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: 6,
    right: 8,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#000',
    fontSize: 8,
    fontWeight: '800',
  },
});
