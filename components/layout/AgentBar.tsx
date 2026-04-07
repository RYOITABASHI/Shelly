// components/layout/AgentBar.tsx
import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';
import { usePaneStore, AGENT_COLORS } from '@/store/pane-store';
import { useSettingsStore } from '@/store/settings-store';
import { useCommandPaletteStore } from '@/hooks/use-command-palette';
import { useSettingsStore as useSettingsStoreImport } from '@/store/settings-store';

type AgentDef = {
  name: string;
  icon: string;
  key: string;
};

const BUILT_IN_AGENTS: AgentDef[] = [
  { name: 'Claude', icon: 'auto-awesome', key: 'claude' },
  { name: 'Gemini', icon: 'diamond', key: 'gemini' },
  { name: 'Codex', icon: 'code', key: 'codex' },
  { name: 'Local', icon: 'smartphone', key: 'local' },
  { name: 'Perplexity', icon: 'travel-explore', key: 'perplexity' },
];

export function AgentBar() {
  const theme = useTheme();
  const c = theme.colors;
  const { focusedPaneId, paneAgents, bindAgent } = usePaneStore();
  const settings = useSettingsStore((s) => s.settings);

  const agents = BUILT_IN_AGENTS.filter(
    (a) => settings.teamMembers?.[a.key as keyof typeof settings.teamMembers]
  );

  const activeAgent = focusedPaneId ? paneAgents[focusedPaneId] : null;

  const handleAgentTap = (agentKey: string) => {
    if (!focusedPaneId) return;
    bindAgent(focusedPaneId, agentKey);
  };

  return (
    <View style={[styles.bar, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        style={styles.scroll}
      >
        {agents.map((agent) => {
          const isActive = activeAgent === agent.key;
          const color = AGENT_COLORS[agent.key] ?? c.muted;
          return (
            <Pressable
              key={agent.key}
              style={[styles.agentBtn, isActive && { backgroundColor: color + '20' }]}
              onPress={() => handleAgentTap(agent.key)}
            >
              <MaterialIcons name={agent.icon as any} size={14} color={isActive ? color : c.muted} />
              <Text style={[styles.agentText, { color: isActive ? color : c.muted }]}>
                {agent.name}
              </Text>
              {isActive && <View style={[styles.activeDot, { backgroundColor: color }]} />}
            </Pressable>
          );
        })}
      </ScrollView>

      {/* Right-side buttons */}
      <View style={styles.rightBtns}>
        <Pressable style={styles.iconBtn} hitSlop={8}>
          <MaterialIcons name="add" size={18} color={c.muted} />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={() => useCommandPaletteStore.getState().toggle()}
          hitSlop={8}
        >
          <MaterialIcons name="search" size={18} color={c.muted} />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={() => useSettingsStoreImport.getState().setShowConfigTUI(true)}
          hitSlop={8}
        >
          <MaterialIcons name="settings" size={16} color={c.muted} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: 36,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
    paddingHorizontal: 8,
    gap: 4,
  },
  agentBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  agentText: {
    fontSize: 11,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  activeDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
  },
  rightBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
    gap: 4,
  },
  iconBtn: {
    padding: 4,
    borderRadius: 4,
  },
});
