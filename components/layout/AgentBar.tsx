// components/layout/AgentBar.tsx
import React, { useState, useRef } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, PanResponder } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { usePaneStore, AGENT_COLORS } from '@/store/pane-store';
import { useSettingsStore } from '@/store/settings-store';
import { useCommandPaletteStore } from '@/hooks/use-command-palette';
import { useCosmeticStore } from '@/store/cosmetic-store';
import { useI18n, type Locale } from '@/lib/i18n';

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

const ACCENT = '#00D4AA';

export function AgentBar() {
  const { focusedPaneId, paneAgents, bindAgent } = usePaneStore();
  const settings = useSettingsStore((s) => s.settings);
  const [addModalVisible, setAddModalVisible] = useState(false);

  const agents = BUILT_IN_AGENTS.filter(
    (a) => settings.teamMembers?.[a.key as keyof typeof settings.teamMembers]
  );

  const disabledAgents = BUILT_IN_AGENTS.filter(
    (a) => !settings.teamMembers?.[a.key as keyof typeof settings.teamMembers]
  );

  const activeAgent = focusedPaneId ? paneAgents[focusedPaneId] : null;

  const handleAgentTap = (agentKey: string) => {
    if (!focusedPaneId) return;
    bindAgent(focusedPaneId, agentKey);
  };

  const handleEnableAgent = (agentKey: string) => {
    useSettingsStore.getState().updateSettings({
      teamMembers: { ...settings.teamMembers, [agentKey]: true },
    });
    setAddModalVisible(false);
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
              <View style={[styles.statusDot, { backgroundColor: isActive ? ACCENT : '#6B7280' }]} />
              <Text
                style={[
                  styles.agentText,
                  { color: isActive ? '#E5E7EB' : '#6B7280' },
                  isActive && { fontWeight: '800' },
                ]}
              >
                {agent.name}
              </Text>
            </Pressable>
          );
        })}
        {/* Add agent button */}
        <Pressable style={styles.addBtn} hitSlop={8} onPress={() => setAddModalVisible(true)}>
          <Text style={styles.addBtnText}>+</Text>
        </Pressable>
      </ScrollView>

      {/* Add agent modal */}
      {addModalVisible && (
        <Pressable style={styles.addModalBackdrop} onPress={() => setAddModalVisible(false)}>
          <Pressable style={styles.addModalMenu} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.addModalTitle}>ADD AGENT</Text>
            {disabledAgents.length === 0 ? (
              <Text style={styles.addModalEmpty}>All agents enabled</Text>
            ) : (
              disabledAgents.map((agent) => (
                <Pressable
                  key={agent.key}
                  style={styles.addModalRow}
                  onPress={() => handleEnableAgent(agent.key)}
                >
                  <View style={[styles.statusDot, { backgroundColor: '#6B7280' }]} />
                  <Text style={styles.addModalLabel}>{agent.name}</Text>
                  <Text style={styles.addModalAction}>ENABLE</Text>
                </Pressable>
              ))
            )}
          </Pressable>
        </Pressable>
      )}

      {/* Right-side: CRT toggle + slider + lang + search + settings */}
      <CrtControls />
      <LangToggle />
      <View style={styles.rightBtns}>
        <Pressable
          style={styles.iconBtn}
          onPress={() => useCommandPaletteStore.getState().toggle()}
          hitSlop={8}
        >
          <MaterialIcons name="search" size={16} color="#6B7280" />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={() => useSettingsStore.getState().setShowConfigTUI(true)}
          hitSlop={8}
        >
          <MaterialIcons name="settings" size={15} color="#6B7280" />
        </Pressable>
      </View>
    </View>
  );
}

// ─── CRT ON/OFF + intensity slider ──────────────────────────────────────────

function CrtControls() {
  const crtEnabled = useCosmeticStore((s) => s.crtEnabled);
  const crtIntensity = useCosmeticStore((s) => s.crtIntensity);
  const { setCrt, setCrtIntensity } = useCosmeticStore();
  const trackWidth = 56;
  const thumbSize = 10;

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => {
        const x = e.nativeEvent.locationX;
        setCrtIntensity(Math.round(Math.max(0, Math.min(100, (x / trackWidth) * 100))));
      },
      onPanResponderMove: (e) => {
        const x = e.nativeEvent.locationX;
        setCrtIntensity(Math.round(Math.max(0, Math.min(100, (x / trackWidth) * 100))));
      },
    })
  ).current;

  const fillWidth = (crtIntensity / 100) * trackWidth;

  return (
    <View style={styles.crtGroup}>
      <Pressable
        style={[styles.crtBadge, crtEnabled && styles.crtBadgeOn]}
        onPress={() => setCrt(!crtEnabled)}
        hitSlop={6}
      >
        <Text style={[styles.crtBadgeText, crtEnabled && styles.crtBadgeTextOn]}>
          CRT: {crtEnabled ? 'ON' : 'OFF'}
        </Text>
      </Pressable>
      {crtEnabled && (
        <>
          <View style={styles.crtSliderWrap} {...panResponder.panHandlers}>
            <View style={styles.crtTrack}>
              <View style={[styles.crtTrackFill, { width: fillWidth }]} />
              <View style={[styles.crtThumb, { left: fillWidth - thumbSize / 2 }]} />
            </View>
          </View>
          <Text style={styles.crtPercent}>{crtIntensity}%</Text>
        </>
      )}
    </View>
  );
}

// ─── EN / JA language toggle ────────────────────────────────────────────────

function LangToggle() {
  const locale = useI18n((s) => s.locale);
  const { setLocale } = useI18n();

  const toggle = () => setLocale(locale === 'en' ? 'ja' : 'en');

  return (
    <Pressable style={styles.langToggle} onPress={toggle} hitSlop={6}>
      <Text style={[styles.langText, locale === 'en' && styles.langTextActive]}>EN</Text>
      <Text style={styles.langSep}>/</Text>
      <Text style={[styles.langText, locale === 'ja' && styles.langTextActive]}>JA</Text>
    </Pressable>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  bar: {
    height: 32,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
    backgroundColor: '#0D0D0D',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
    paddingHorizontal: 6,
    gap: 2,
  },
  agentTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  agentTabActive: {
    backgroundColor: 'rgba(0,212,170,0.10)',
    borderColor: 'rgba(0,212,170,0.25)',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  agentText: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  addBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  addBtnText: {
    color: '#6B7280',
    fontSize: 14,
    fontFamily: 'monospace',
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
    borderRadius: 4,
  },
  // CRT controls
  crtGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginRight: 6,
  },
  crtBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    backgroundColor: '#1A1A1A',
    borderWidth: 1,
    borderColor: '#333',
  },
  crtBadgeOn: {
    backgroundColor: 'rgba(0,212,170,0.15)',
    borderColor: 'rgba(0,212,170,0.4)',
  },
  crtBadgeText: {
    fontSize: 8,
    fontFamily: 'monospace',
    fontWeight: '800',
    color: '#6B7280',
    letterSpacing: 0.5,
  },
  crtBadgeTextOn: {
    color: ACCENT,
  },
  crtSliderWrap: {
    width: 56,
    height: 20,
    justifyContent: 'center',
  },
  crtTrack: {
    width: 56,
    height: 4,
    backgroundColor: '#333',
    borderRadius: 2,
    position: 'relative',
  },
  crtTrackFill: {
    height: 4,
    backgroundColor: ACCENT,
    borderRadius: 2,
  },
  crtThumb: {
    position: 'absolute',
    top: -3,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: ACCENT,
  },
  crtPercent: {
    fontSize: 8,
    fontFamily: 'monospace',
    fontWeight: '700',
    color: '#6B7280',
    minWidth: 22,
    textAlign: 'right',
  },
  // Language toggle
  langToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 4,
    gap: 2,
  },
  langText: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    color: '#6B7280',
  },
  langTextActive: {
    color: '#E5E7EB',
  },
  langSep: {
    fontSize: 9,
    fontFamily: 'monospace',
    color: '#333',
  },
  // Add agent modal
  addModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-start',
    alignItems: 'center',
    zIndex: 200,
    paddingTop: 36,
  },
  addModalMenu: {
    width: 200,
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#333',
  },
  addModalTitle: {
    color: '#6B7280',
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 4,
    paddingHorizontal: 6,
  },
  addModalEmpty: {
    color: '#6B7280',
    fontSize: 10,
    fontFamily: 'monospace',
    fontStyle: 'italic',
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  addModalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderRadius: 4,
  },
  addModalLabel: {
    flex: 1,
    color: '#E5E7EB',
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  addModalAction: {
    color: ACCENT,
    fontSize: 8,
    fontFamily: 'monospace',
    fontWeight: '800',
    letterSpacing: 0.5,
  },
});
