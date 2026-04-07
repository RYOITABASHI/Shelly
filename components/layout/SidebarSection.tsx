// components/layout/SidebarSection.tsx
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';

type Props = {
  title: string;
  icon: string;
  isOpen: boolean;
  onToggle: () => void;
  badge?: number;
  /** Icons-only mode: show icon only, no title or children */
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
        <MaterialIcons name={icon as any} size={18} color={isOpen ? c.accent : c.muted} />
        {badge != null && badge > 0 && (
          <View style={[styles.badge, { backgroundColor: c.accent }]}>
            <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
          </View>
        )}
      </Pressable>
    );
  }

  return (
    <View style={[styles.section, { borderBottomColor: c.border }]}>
      <Pressable style={styles.header} onPress={onToggle}>
        <MaterialIcons name={icon as any} size={14} color={c.muted} />
        <Text style={[styles.title, { color: c.foreground }]} numberOfLines={1}>
          {title}
        </Text>
        {badge != null && badge > 0 && (
          <View style={[styles.countBadge, { backgroundColor: c.accent + '30' }]}>
            <Text style={[styles.countText, { color: c.accent }]}>{badge}</Text>
          </View>
        )}
        <View style={styles.spacer} />
        <MaterialIcons
          name={isOpen ? 'expand-less' : 'expand-more'}
          size={16}
          color={c.muted}
        />
      </Pressable>
      {isOpen && <View style={styles.body}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderBottomWidth: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  title: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  spacer: { flex: 1 },
  countBadge: {
    borderRadius: 8,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  countText: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  body: {
    paddingBottom: 6,
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#000',
    fontSize: 8,
    fontWeight: '800',
  },
});
