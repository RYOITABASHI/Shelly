// components/layout/AgentBar.tsx
import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { usePaneStore, AGENT_COLORS } from '@/store/pane-store';
import { useSettingsStore } from '@/store/settings-store';
import { useCommandPaletteStore } from '@/hooks/use-command-palette';
import { SettingsDropdown } from './SettingsDropdown';
import { AddPaneSheet } from '@/components/multi-pane/AddPaneSheet';
import { neonTextGlow, neonDotGlow } from '@/lib/neon-glow';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R } from '@/theme.config';

type AgentDef = {
  name: string;
  key: string;
};

const BUILT_IN_AGENTS: AgentDef[] = [
  { name: 'CLAUDE', key: 'claude' },
  { name: 'GEMINI', key: 'gemini' },
  { name: 'CODEX', key: 'codex' },
  { name: 'OPENCODE', key: 'opencode' },
  { name: 'COPILOT', key: 'copilot' },
];

export function AgentBar() {
  const { focusedPaneId, paneAgents, bindAgent } = usePaneStore();
  const settings = useSettingsStore((s) => s.settings);
  const [addPaneSheetVisible, setAddPaneSheetVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const agents = BUILT_IN_AGENTS.filter(
    (a) => settings.teamMembers?.[a.key as keyof typeof settings.teamMembers]
  );

  const activeAgent = focusedPaneId ? paneAgents[focusedPaneId] : null;

  const handleAgentTap = (agentKey: string) => {
    if (!focusedPaneId) return;
    bindAgent(focusedPaneId, agentKey);
  };

  return (
    <View style={styles.bar}>
      {/* Agent tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
        style={styles.scroll}
      >
        {agents.map((agent) => {
          const isActive = activeAgent === agent.key;
          return (
            <Pressable
              key={agent.key}
              style={[
                styles.agentTab,
                isActive && styles.agentTabActive,
              ]}
              onPress={() => handleAgentTap(agent.key)}
            >
              <View style={[styles.statusDot, { backgroundColor: isActive ? C.accent : C.text2 }, isActive && neonDotGlow]} />
              <Text
                style={[
                  styles.agentText,
                  { color: isActive ? C.text1 : C.text2 },
                  isActive && { fontWeight: '800', ...neonTextGlow },
                ]}
              >
                {agent.name}
              </Text>
            </Pressable>
          );
        })}
        {/* Add pane button (opens bottom sheet) */}
        <Pressable style={styles.addBtn} hitSlop={8} onPress={() => setAddPaneSheetVisible(true)}>
          <Text style={styles.addBtnText}>+</Text>
        </Pressable>
      </ScrollView>

      {/* Right-side: search + settings (dropdown) */}
      <View style={styles.rightBtns}>
        <Pressable
          style={styles.iconBtn}
          onPress={() => useCommandPaletteStore.getState().toggle()}
          hitSlop={8}
        >
          <MaterialIcons name="search" size={16} color={C.text2} />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={() => setSettingsOpen((v) => !v)}
          hitSlop={8}
        >
          <MaterialIcons name="settings" size={15} color={C.text2} />
        </Pressable>
      </View>

      <SettingsDropdown visible={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <AddPaneSheet visible={addPaneSheetVisible} onClose={() => setAddPaneSheetVisible(false)} />
    </View>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  bar: {
    height: S.agentBarHeight,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: S.borderWidth,
    borderBottomColor: C.border,
    backgroundColor: C.bgSidebar,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
    paddingHorizontal: P.agentBar.px,
    gap: 2,
  },
  agentTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: P.agentTab.px,
    paddingVertical: P.agentTab.py,
    borderRadius: R.agentTab,
    borderWidth: S.borderWidth,
    borderColor: 'transparent',
  },
  agentTabActive: {
    backgroundColor: 'rgba(0,212,170,0.10)',
    borderColor: 'rgba(0,212,170,0.25)',
  },
  statusDot: {
    width: S.agentDotSize,
    height: S.agentDotSize,
    borderRadius: S.agentDotSize / 2,
  },
  agentText: {
    fontSize: F.agentTab.size,
    fontFamily: F.family,
    fontWeight: F.agentTab.weight,
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  addBtn: {
    paddingHorizontal: P.agentTab.px,
    paddingVertical: 4,
  },
  addBtnText: {
    color: C.text2,
    fontSize: 14,
    fontFamily: F.family,
    fontWeight: '600',
  },
  rightBtns: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: 8,
    gap: 6,
  },
  iconBtn: {
    padding: 4,
    borderRadius: R.agentTab,
  },
});
