/**
 * AutocompletePopup — floating completion panel for the Shelly terminal.
 *
 * Wide mode  (isWide=true) : vertical list, up to 6 items, min-width 240 px, above input
 * Narrow mode (isWide=false): horizontal chip strip, max 3 items, full-width
 */

import React, { useCallback } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  FadeIn,
  SlideInDown,
} from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

import type { CompletionItem } from '@/lib/autocomplete-engine';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

// ── Icon mapping ──────────────────────────────────────────────────────────────

type MaterialIconName = React.ComponentProps<typeof MaterialIcons>['name'];

const KIND_ICON: Record<CompletionItem['kind'], MaterialIconName> = {
  command: 'terminal',
  flag:    'flag',
  path:    'folder',
  branch:  'call-split',
  history: 'history',
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface AutocompletePopupProps {
  items:    CompletionItem[];
  onSelect: (item: CompletionItem) => void;
  visible:  boolean;
  isWide:   boolean;
}

// ── Wide-mode row ─────────────────────────────────────────────────────────────

const WideRow = React.memo(function WideRow({
  item,
  onPress,
}: {
  item:    CompletionItem;
  onPress: () => void;
}) {
  const iconName = KIND_ICON[item.kind] ?? 'terminal';
  return (
    <Pressable
      style={({ pressed }) => [styles.wideRow, pressed && styles.rowPressed]}
      onPress={onPress}
      android_ripple={{ color: '#333' }}
    >
      <MaterialIcons name={iconName} size={15} color="#888" style={styles.rowIcon} />
      <Text style={styles.labelText} numberOfLines={1}>{item.label}</Text>
      {item.detail ? (
        <Text style={styles.detailText} numberOfLines={1}>{item.detail}</Text>
      ) : null}
    </Pressable>
  );
});

// ── Narrow-mode chip ──────────────────────────────────────────────────────────

const NarrowChip = React.memo(function NarrowChip({
  item,
  onPress,
}: {
  item:    CompletionItem;
  onPress: () => void;
}) {
  const iconName = KIND_ICON[item.kind] ?? 'terminal';
  return (
    <Pressable
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
      onPress={onPress}
      android_ripple={{ color: '#333' }}
    >
      <MaterialIcons name={iconName} size={13} color="#888" style={styles.chipIcon} />
      <Text style={styles.chipLabel} numberOfLines={1}>{item.label}</Text>
    </Pressable>
  );
});

// ── Main component ────────────────────────────────────────────────────────────

export function AutocompletePopup({
  items,
  onSelect,
  visible,
  isWide,
}: AutocompletePopupProps) {
  if (!visible || items.length === 0) return null;

  const displayItems = isWide ? items.slice(0, 6) : items.slice(0, 3);

  const handleSelect = useCallback(
    (item: CompletionItem) => {
      onSelect(item);
    },
    [onSelect],
  );

  if (isWide) {
    return (
      <Animated.View
        entering={FadeIn.duration(120).springify().damping(18)}
        style={styles.wideContainer}
      >
        <FlatList
          data={displayItems}
          keyExtractor={(item, idx) => `${item.kind}-${item.label}-${idx}`}
          renderItem={({ item }) => (
            <WideRow item={item} onPress={() => handleSelect(item)} />
          )}
          keyboardShouldPersistTaps="always"
          scrollEnabled={false}
          style={styles.wideList}
        />
      </Animated.View>
    );
  }

  // Narrow: horizontal chip strip
  return (
    <Animated.View
      entering={SlideInDown.duration(140).springify().damping(20)}
      style={styles.narrowContainer}
    >
      <FlatList
        data={displayItems}
        keyExtractor={(item, idx) => `${item.kind}-${item.label}-${idx}`}
        renderItem={({ item }) => (
          <NarrowChip item={item} onPress={() => handleSelect(item)} />
        )}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="always"
        contentContainerStyle={styles.narrowContent}
      />
    </Animated.View>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const SURFACE    = C.border;
const BORDER     = '#333333';
const ACCENT     = '#E8E8E8';
const MUTED      = '#777777';
const RADIUS     = 8;
const SHADOW = {
  shadowColor:   '#000',
  shadowOffset:  { width: 0, height: -2 },
  shadowOpacity: 0.35,
  shadowRadius:  6,
  elevation:     8,
} as const;

const styles = StyleSheet.create({
  // ── Wide ──────────────────────────────────────────────────────────────────
  wideContainer: {
    position:        'absolute',
    bottom:          '100%',
    left:            0,
    minWidth:        240,
    backgroundColor: SURFACE,
    borderWidth:     1,
    borderColor:     BORDER,
    borderRadius:    RADIUS,
    marginBottom:    4,
    overflow:        'hidden',
    ...SHADOW,
  },
  wideList: {
    flexGrow: 0,
  },
  wideRow: {
    flexDirection:  'row',
    alignItems:     'center',
    paddingHorizontal: 12,
    paddingVertical:   9,
  },
  rowPressed: {
    backgroundColor: '#252525',
  },
  rowIcon: {
    marginRight: 8,
    flexShrink:  0,
  },
  labelText: {
    flex:       1,
    color:      ACCENT,
    fontSize:   13,
    fontFamily: 'monospace',
  },
  detailText: {
    color:      MUTED,
    fontSize:   11,
    fontFamily: 'monospace',
    marginLeft: 8,
    flexShrink: 1,
  },

  // ── Narrow ────────────────────────────────────────────────────────────────
  narrowContainer: {
    position:        'absolute',
    bottom:          '100%',
    left:            0,
    right:           0,
    backgroundColor: SURFACE,
    borderTopWidth:  1,
    borderColor:     BORDER,
    marginBottom:    2,
    ...SHADOW,
  },
  narrowContent: {
    paddingHorizontal: 8,
    paddingVertical:   6,
    gap:               6,
  },
  chip: {
    flexDirection:     'row',
    alignItems:        'center',
    backgroundColor:   '#252525',
    borderWidth:       1,
    borderColor:       BORDER,
    borderRadius:      16,
    paddingHorizontal: 10,
    paddingVertical:   5,
  },
  chipPressed: {
    backgroundColor: '#303030',
  },
  chipIcon: {
    marginRight: 4,
    flexShrink:  0,
  },
  chipLabel: {
    color:      ACCENT,
    fontSize:   12,
    fontFamily: 'monospace',
    maxWidth:   120,
  },
});
