import React from 'react';
import {
  
  View,
  Text,
  Pressable,
  StyleSheet,
  FlatList,
} from 'react-native';
import { ShellyModal } from '@/components/layout/ShellyModal';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { PANE_REGISTRY } from './pane-registry';
import type { PaneTab } from '@/hooks/use-multi-pane';
import { colors as C, fonts as F, sizes as S } from '@/theme.config';

const ALL_TABS = Object.keys(PANE_REGISTRY) as PaneTab[];

type Props = {
  visible: boolean;
  currentTab: PaneTab;
  onSelect: (tab: PaneTab) => void;
  onClose: () => void;
};

export function PaneSelector({ visible, currentTab, onSelect, onClose }: Props) {
  return (
    <ShellyModal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.menu}>
          <Text style={styles.title}>Select Tab</Text>
          <FlatList
            data={ALL_TABS}
            keyExtractor={(item) => item}
            renderItem={({ item }) => {
              const entry = PANE_REGISTRY[item];
              const isActive = item === currentTab;
              return (
                <Pressable
                  style={[styles.item, isActive && styles.itemActive]}
                  onPress={() => {
                    onSelect(item);
                    onClose();
                  }}
                >
                  <MaterialIcons
                    name={entry.icon as any}
                    size={20}
                    color={isActive ? C.accent : C.text2}
                  />
                  <Text style={[styles.itemText, isActive && styles.itemTextActive]}>
                    {entry.title}
                  </Text>
                </Pressable>
              );
            }}
          />
        </View>
      </Pressable>
    </ShellyModal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  menu: {
    width: 240,
    backgroundColor: C.bgSurface,
    borderRadius: 12,
    padding: 12,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    maxHeight: 400,
  },
  title: {
    color: C.text2,
    fontSize: 11,
    fontFamily: F.family,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 8,
    paddingHorizontal: 8,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  itemActive: {
    backgroundColor: 'rgba(0,212,170,0.1)',
  },
  itemText: {
    color: C.text1,
    fontSize: 14,
    fontFamily: F.family,
  },
  itemTextActive: {
    color: C.accent,
    fontWeight: '600',
  },
});
