import React from 'react';
import { View, StyleSheet, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { PaneSlot } from './PaneSlot';

export function MultiPaneContainer() {
  const insets = useSafeAreaInsets();
  const { panes, maxPanes, setPane, addPane, removePane } = useMultiPaneStore();

  const canAdd = panes.length < maxPanes;

  const handleAdd = () => {
    const used = new Set(panes);
    const available = (
      ['projects', 'snippets', 'browser', 'obsidian', 'search', 'settings', 'index', 'terminal'] as const
    ).find((t) => !used.has(t));
    addPane(available ?? 'snippets');
  };

  return (
    <View style={[StyleSheet.absoluteFill, styles.root, { paddingTop: insets.top }]}>
      <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
      <View style={styles.panesRow}>
        {panes.map((tab, i) => (
          <PaneSlot
            key={`${i}-${tab}`}
            tab={tab}
            index={i}
            onChangeTab={setPane}
            onRemove={removePane}
            canAddPane={canAdd}
            onAddPane={handleAdd}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    backgroundColor: '#0A0A0A',
    zIndex: 50,
  },
  panesRow: {
    flex: 1,
    flexDirection: 'row',
  },
});
