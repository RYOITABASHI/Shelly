import React, { memo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Pressable } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { usePreviewStore, type PreviewTabId } from '@/store/preview-store';
import { WebTab } from '@/components/preview/WebTab';
import { CodeTab } from '@/components/preview/CodeTab';
import { FilesTab } from '@/components/preview/FilesTab';

type Props = {
  onClose: () => void;
  onEditSubmit?: (prompt: string) => void;
};

const TABS: Array<{ id: PreviewTabId; label: string; icon: string }> = [
  { id: 'web', label: 'Web', icon: 'language' },
  { id: 'code', label: 'Code', icon: 'code' },
  { id: 'files', label: 'Files', icon: 'folder' },
];

export const PreviewTabs = memo(function PreviewTabs({ onClose, onEditSubmit }: Props) {
  const { colors } = useTheme();
  const activeTab = usePreviewStore((s) => s.activeTab);
  const setActiveTab = usePreviewStore((s) => s.setActiveTab);
  const previewUrl = usePreviewStore((s) => s.previewUrl);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Tab bar */}
      <View style={[styles.tabBar, { backgroundColor: colors.surfaceHigh, borderBottomColor: colors.border }]}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.id}
            style={[styles.tab, activeTab === tab.id && { borderBottomColor: colors.accent, borderBottomWidth: 2 }]}
            onPress={() => setActiveTab(tab.id)}
            activeOpacity={0.7}
          >
            <MaterialIcons name={tab.icon as any} size={14} color={activeTab === tab.id ? colors.accent : colors.muted} />
            <Text style={[styles.tabLabel, { color: activeTab === tab.id ? colors.accent : colors.muted }]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
        <View style={{ flex: 1 }} />
        <Pressable onPress={onClose} hitSlop={8} style={styles.closeBtn}>
          <MaterialIcons name="close" size={16} color={colors.muted} />
        </Pressable>
      </View>

      {/* Tab content (lazy mount) */}
      {activeTab === 'web' && <WebTab url={previewUrl} onClose={onClose} onEditSubmit={onEditSubmit} />}
      {activeTab === 'code' && <CodeTab />}
      {activeTab === 'files' && <FilesTab />}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  tabBar: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, paddingHorizontal: 4 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, paddingVertical: 8 },
  tabLabel: { fontFamily: 'monospace', fontSize: 12, fontWeight: '600' },
  closeBtn: { padding: 8 },
});
