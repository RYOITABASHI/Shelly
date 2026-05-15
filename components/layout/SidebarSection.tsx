// components/layout/SidebarSection.tsx
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R } from '@/theme.config';

type Props = {
  title: string;
  icon: string;
  isOpen: boolean;
  onToggle: () => void;
  badge?: number;
  iconsOnly?: boolean;
  children: React.ReactNode;
  /** Legacy accent hooks accepted for compatibility while the sidebar uses theme chrome. */
  accent?: string;
  glow?: unknown;
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
  const headingColor = isOpen ? C.accent : C.text2;
  const chevronColor = isOpen ? C.accent : C.text2;
  const iconActiveColor = C.accent;

  if (iconsOnly) {
    return (
      <Pressable style={styles.iconBtn} onPress={onToggle} hitSlop={4}>
        <MaterialIcons
          name={icon as any}
          size={18}
          color={isOpen ? iconActiveColor : C.text2}
        />
        {badge != null && badge > 0 && (
          <View style={[styles.badge, { backgroundColor: C.accent }]}>
            <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
          </View>
        )}
      </Pressable>
    );
  }

  return (
    <View style={styles.section}>
      <Pressable style={styles.header} onPress={onToggle}>
        <Text style={[styles.title, { color: headingColor }]}>{title}</Text>
        {badge != null && badge > 0 && (
          <View
            style={[
              styles.countBadge,
              isOpen && { borderColor: C.accent, backgroundColor: C.accent },
            ]}
          >
            <Text style={[styles.countText, isOpen && { color: C.bgDeep }]}>{badge}</Text>
          </View>
        )}
        <View style={styles.spacer} />
        <MaterialIcons
          name={isOpen ? 'expand-less' : 'expand-more'}
          size={14}
          color={chevronColor}
        />
      </Pressable>
      {isOpen && <View style={styles.body}>{children}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    borderBottomWidth: S.borderWidth,
    borderBottomColor: C.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    height: S.sidebarSectionHeaderHeight,
    paddingHorizontal: P.sidebarItem.px,
  },
  title: {
    fontSize: F.sidebarSection.size,
    fontFamily: F.family,
    fontWeight: F.sidebarSection.weight,
    textTransform: 'uppercase',
    letterSpacing: F.sidebarSection.letterSpacing,
    color: C.text2,
  },
  spacer: { flex: 1 },
  countBadge: {
    borderRadius: R.badge,
    paddingHorizontal: P.statusBadge.px,
    paddingVertical: P.statusBadge.py,
    marginLeft: 4,
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: C.border,
  },
  countText: {
    fontSize: F.badge.size - 1,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    color: C.text2,
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
    backgroundColor: C.text1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: C.bgDeep,
    fontFamily: F.family,
    fontSize: F.badge.size,
    fontWeight: F.badge.weight,
  },
});
