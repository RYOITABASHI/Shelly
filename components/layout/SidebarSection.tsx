// components/layout/SidebarSection.tsx
import React from 'react';
import { View, Text, Pressable, StyleSheet, TextStyle } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';

type Props = {
  title: string;
  icon: string;
  isOpen: boolean;
  onToggle: () => void;
  badge?: number;
  iconsOnly?: boolean;
  children: React.ReactNode;
  /**
   * Phase C "ビカビカ" pass — per-section neon hue. The default (undefined)
   * keeps the old muted `C.text2` heading. Passing a color makes the
   * heading, chevron, count badge, and icon-mode glyph light up in that
   * hue + a matching halo. We pass shellyPalette accent tokens so theme
   * swaps flow through (tokyoNight's pink reads as pastel, shelly's as
   * neon, etc).
   */
  accent?: string;
  /** Matching per-color text-glow style so the title reads as neon */
  glow?: TextStyle;
};

export function SidebarSection({
  title,
  icon,
  isOpen,
  onToggle,
  badge,
  iconsOnly,
  accent,
  glow,
  children,
}: Props) {
  const headingColor = accent ?? C.text2;
  const chevronColor = accent ? withAlpha(accent, 0.8) : C.text2;
  const iconActiveColor = accent ?? C.accent;

  if (iconsOnly) {
    return (
      <Pressable style={styles.iconBtn} onPress={onToggle} hitSlop={4}>
        <MaterialIcons
          name={icon as any}
          size={18}
          color={isOpen ? iconActiveColor : C.text2}
        />
        {badge != null && badge > 0 && (
          <View
            style={[
              styles.badge,
              accent ? { backgroundColor: accent } : null,
            ]}
          >
            <Text style={styles.badgeText}>{badge > 9 ? '9+' : badge}</Text>
          </View>
        )}
      </Pressable>
    );
  }

  return (
    <View style={styles.section}>
      <Pressable style={styles.header} onPress={onToggle}>
        <Text style={[styles.title, { color: headingColor }, glow]}>{title}</Text>
        {badge != null && badge > 0 && (
          <View
            style={[
              styles.countBadge,
              accent
                ? { backgroundColor: withAlpha(accent, 0.18), borderColor: withAlpha(accent, 0.55) }
                : null,
            ]}
          >
            <Text style={[styles.countText, accent ? { color: accent } : null]}>{badge}</Text>
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
    backgroundColor: C.badgeRunningBg,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  countText: {
    fontSize: F.badge.size - 1,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    color: C.badgeRunningText,
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
    backgroundColor: C.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: C.btnPrimaryText,
    fontFamily: F.family,
    fontSize: F.badge.size,
    fontWeight: F.badge.weight,
  },
});
