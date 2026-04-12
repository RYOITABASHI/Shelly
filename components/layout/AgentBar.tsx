// components/layout/AgentBar.tsx
import React, { useState, useRef } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, PanResponder } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { usePaneStore, AGENT_COLORS } from '@/store/pane-store';
import { useSettingsStore } from '@/store/settings-store';
import { useCommandPaletteStore } from '@/hooks/use-command-palette';
import { useCosmeticStore } from '@/store/cosmetic-store';
import { useI18n, type Locale } from '@/lib/i18n';
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
                  <View style={[styles.statusDot, { backgroundColor: C.text2 }]} />
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
          <MaterialIcons name="search" size={16} color={C.text2} />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={() => useSettingsStore.getState().setShowConfigTUI(true)}
          hitSlop={8}
        >
          <MaterialIcons name="settings" size={15} color={C.text2} />
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
  // CRT controls
  crtGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginRight: 6,
  },
  crtBadge: {
    paddingHorizontal: P.statusBadge.px,
    paddingVertical: P.statusBadge.py,
    borderRadius: R.badge,
    backgroundColor: C.crtBadgeBg,
    borderWidth: S.borderWidth,
    borderColor: C.border,
  },
  crtBadgeOn: {
    backgroundColor: 'rgba(0,212,170,0.15)',
    borderColor: 'rgba(0,212,170,0.4)',
  },
  crtBadgeText: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    color: C.text2,
    letterSpacing: 0.5,
  },
  crtBadgeTextOn: {
    color: C.crtBadgeText,
    textShadowColor: 'rgba(0, 212, 170, 0.6)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
  crtSliderWrap: {
    width: 56,
    height: 20,
    justifyContent: 'center',
  },
  crtTrack: {
    width: 56,
    height: 4,
    backgroundColor: C.border,
    borderRadius: 2,
    position: 'relative',
  },
  crtTrackFill: {
    height: 4,
    backgroundColor: C.accent,
    borderRadius: 2,
  },
  crtThumb: {
    position: 'absolute',
    top: -3,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: C.accent,
  },
  crtPercent: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    color: C.text2,
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
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    fontWeight: F.contextBar.weight,
    color: C.text2,
  },
  langTextActive: {
    color: C.text1,
  },
  langSep: {
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    color: C.text3,
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
    backgroundColor: C.border,
    borderRadius: 8,
    padding: 8,
    borderWidth: S.borderWidth,
    borderColor: C.btnSecondaryBg,
  },
  addModalTitle: {
    color: C.text2,
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 4,
    paddingHorizontal: 6,
  },
  addModalEmpty: {
    color: C.text2,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
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
    borderRadius: R.agentTab,
  },
  addModalLabel: {
    flex: 1,
    color: C.text1,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  addModalAction: {
    color: C.accent,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    letterSpacing: 0.5,
  },
});
