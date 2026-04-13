// components/layout/Sidebar.tsx
import React, { useState, useEffect } from 'react';
import { execCommand } from '@/hooks/use-native-exec';
import { useGitStatusStore } from '@/store/git-status-store';
import { usePortsStore, parseSsOutput, portLabel } from '@/store/ports-store';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  Modal,
  Alert,
} from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';
import { useSidebarStore } from '@/store/sidebar-store';
import { useAgentStore } from '@/store/agent-store';
import { useTerminalStore } from '@/store/terminal-store';
import { deleteAgent } from '@/lib/agent-manager';
import { generateRunNowCommand } from '@/lib/agent-executor';
import { useSettingsStore } from '@/store/settings-store';
import { usePaneStore } from '@/store/pane-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { useBrowserStore } from '@/store/browser-store';
import { SidebarSection } from './SidebarSection';
import { FileTree } from './FileTree';
import { ProfilesSection } from './ProfilesSection';
import { neonTextGlow, neonDotGlow } from '@/lib/neon-glow';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R, icons as I } from '@/theme.config';

const WIDTH_ICONS = 48;
const WIDTH_HIDDEN = 0;
const TIMING_MS = 200;

function formatTimeAgo(ts: number): string {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}S AGO`;
  if (diff < 3600) return `${Math.floor(diff / 60)}M AGO`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}H AGO`;
  return `${Math.floor(diff / 86400)}D AGO`;
}

const QUICK_FOLDERS = [
  { label: '~/', path: '~/', icon: 'home' },
  { label: 'DCIM', path: '~/storage/dcim', icon: 'photo-camera' },
  { label: 'DOWNLOAD', path: '~/storage/downloads', icon: 'download' },
  { label: 'DOCUMENTS', path: '~/storage/shared/Documents', icon: 'description' },
  { label: 'MUSIC', path: '~/storage/music', icon: 'music-note' },
] as const;

export function Sidebar() {
  const theme = useTheme();
  const c = theme.colors;

  const { mode, openSections, toggleSection, activeRepoPath, repoPaths, setActiveRepo, setMode, addRepo } =
    useSidebarStore();
  const agents = useAgentStore((s) => s.agents);
  const runHistory = useAgentStore((s) => s.runHistory);
  const [addRepoVisible, setAddRepoVisible] = useState(false);
  const [repoInput, setRepoInput] = useState('');

  const focusedPaneId = usePaneStore((s) => s.focusedPaneId);
  const setLeafTab = useMultiPaneStore((s) => s.setLeafTab);
  const openUrl = useBrowserStore((s) => s.openUrl);

  // Poll active localhost listeners every 20s. Single-writer pattern
  // (Sidebar owns the interval, usePortsStore is the one state source)
  // so the list stays stable across renders without duplicate work.
  // `ss -tlnp` is the modern iproute2 replacement for netstat and is
  // present in the bundled toolbox.
  const portEntries = usePortsStore((s) => s.entries);
  useEffect(() => {
    const setEntries = usePortsStore.getState().setEntries;
    let cancelled = false;
    const refresh = async () => {
      const r = await execCommand('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null', 5_000);
      if (cancelled) return;
      setEntries(parseSsOutput(r.stdout || ''));
    };
    refresh();
    const iv = setInterval(refresh, 20_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  // Count uncommitted changes in the active repo. Sidebar owns the
  // single 20-second poller; results go into useGitStatusStore so the
  // Sidebar badge and the AgentBar badge stay in sync without running
  // two loops.
  const gitDirtyCount = useGitStatusStore((s) => s.dirtyCount);
  useEffect(() => {
    const setDirty = useGitStatusStore.getState().setDirty;
    if (!activeRepoPath) {
      setDirty(null);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const r = await execCommand(
        `cd '${activeRepoPath.replace(/'/g, "'\\''")}' && git status --porcelain 2>/dev/null | wc -l`,
        5_000,
      );
      if (cancelled) return;
      const n = parseInt((r.stdout || '').trim(), 10);
      setDirty(Number.isNaN(n) ? null : n);
    };
    refresh();
    const iv = setInterval(refresh, 20_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [activeRepoPath]);

  // Derive recent completed tasks from run history
  const recentTasks = React.useMemo(() => {
    const allLogs: Array<{ id: string; name: string; timestamp: number }> = [];
    for (const [agentId, logs] of Object.entries(runHistory)) {
      const agent = agents.find((a) => a.id === agentId);
      for (const log of logs) {
        if (log.status === 'success' || log.status === 'error') {
          allLogs.push({
            id: `${agentId}-${log.timestamp}`,
            name: agent?.name ?? agentId,
            timestamp: log.timestamp,
          });
        }
      }
    }
    return allLogs
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 5)
      .map((log) => ({
        ...log,
        age: formatTimeAgo(log.timestamp),
      }));
  }, [runHistory, agents]);

  const runningAgents = agents.filter((a) => a.enabled);

  const targetWidth =
    mode === 'expanded' ? S.sidebarWidth : mode === 'icons' ? WIDTH_ICONS : WIDTH_HIDDEN;

  const animatedStyle = useAnimatedStyle(() => ({
    width: withTiming(targetWidth, { duration: TIMING_MS }),
    overflow: 'hidden',
  }));

  const iconsOnly = mode === 'icons';

  function handleToggle() {
    if (mode === 'expanded') setMode('icons');
    else setMode('expanded');
  }

  if (mode === 'hidden') return null;

  return (
    <Animated.View style={[styles.container, animatedStyle, { backgroundColor: C.bgSidebar, borderRightColor: C.border }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* TASKS */}
        <SidebarSection
          title="TASKS"
          icon="smart-toy"
          isOpen={openSections.tasks}
          onToggle={() => toggleSection('tasks')}
          badge={runningAgents.length}
          iconsOnly={iconsOnly}
        >
          {runningAgents.map((agent) => (
            <View key={`running-${agent.id}`} style={styles.taskRow}>
              <View style={[styles.taskDot, { backgroundColor: C.accentGreen }]} />
              <View style={styles.taskInfo}>
                <Text style={styles.taskName} numberOfLines={1}>
                  {agent.name.toUpperCase()}
                </Text>
              </View>
              <View style={[styles.statusBadge, { backgroundColor: C.badgeRunningBg }]}>
                <Text style={[styles.statusBadgeText, { color: C.badgeRunningText }]}>RUNNING</Text>
              </View>
            </View>
          ))}
          {recentTasks.map((task) => (
            <View key={`recent-${task.id}`} style={styles.taskRow}>
              <MaterialIcons name="check-circle" size={10} color={C.accent} />
              <View style={styles.taskInfo}>
                <Text style={styles.taskName} numberOfLines={1}>
                  {task.name.toUpperCase()}
                </Text>
              </View>
              <Text style={styles.taskAge}>{task.age}</Text>
            </View>
          ))}
          {agents.length > 0 && (
            <>
              {(runningAgents.length > 0 || recentTasks.length > 0) && (
                <View style={styles.tasksSeparator} />
              )}
              <Text style={styles.tasksSubheader}>SCHEDULED</Text>
              {agents.filter((a) => !a.enabled).map((agent) => (
                <View key={`sched-${agent.id}`} style={styles.taskRow}>
                  <View style={[styles.taskDot, { backgroundColor: C.text3 }]} />
                  <View style={styles.taskInfo}>
                    <Text style={styles.taskName} numberOfLines={1}>
                      {agent.name.toUpperCase()}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => {
                      useTerminalStore.setState({ pendingCommand: generateRunNowCommand(agent.id) });
                    }}
                    hitSlop={8}
                    style={styles.tasksAction}
                  >
                    <MaterialIcons name="play-arrow" size={12} color={C.accentGreen} />
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      Alert.alert(
                        'Delete agent',
                        `Delete "${agent.name}"?`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Delete',
                            style: 'destructive',
                            onPress: async () => {
                              await deleteAgent(agent.id);
                              useAgentStore.getState().removeAgent(agent.id);
                            },
                          },
                        ],
                      );
                    }}
                    hitSlop={8}
                    style={styles.tasksAction}
                  >
                    <MaterialIcons name="delete-outline" size={12} color={C.errorText} />
                  </Pressable>
                </View>
              ))}
            </>
          )}
          {runningAgents.length === 0 && recentTasks.length === 0 && agents.length === 0 && (
            <Text style={styles.tasksEmpty}>Use @agent to create background agents</Text>
          )}
        </SidebarSection>

        {/* REPOSITORIES */}
        <SidebarSection
          title="REPOSITORIES"
          icon="folder-special"
          isOpen={openSections.repos}
          onToggle={() => toggleSection('repos')}
          iconsOnly={iconsOnly}
        >
          {repoPaths.length === 0 ? (
            <>
              {/* Mock dummy repos matching mock screenshot */}
              {[
                { name: 'SHELLY', version: 'V9.2', active: true },
                { name: 'NACRE', version: null, active: false },
                { name: 'LLM-BENCH-V2', version: null, active: false },
              ].map((repo) => (
                <View
                  key={repo.name}
                  style={[styles.repoRow, repo.active && styles.repoRowActive]}
                >
                  <View style={[styles.repoIcon, { backgroundColor: repo.active ? C.accent : C.btnSecondaryBg }]}>
                    <MaterialIcons name="folder" size={10} color={repo.active ? C.btnPrimaryText : C.accentBlue} />
                  </View>
                  <Text style={[styles.repoName, { color: repo.active ? C.accent : C.text1 }]} numberOfLines={1}>
                    {repo.name}
                  </Text>
                  {repo.version && <Text style={styles.repoVersion}>{repo.version}</Text>}
                </View>
              ))}
            </>
          ) : (
            repoPaths.map((p) => {
              const isActive = p === activeRepoPath;
              const name = p.replace(/^.*\//, '') || p;
              return (
                <Pressable
                  key={p}
                  style={[styles.repoRow, isActive && styles.repoRowActive]}
                  onPress={() => setActiveRepo(p)}
                >
                  <View style={[styles.repoIcon, { backgroundColor: isActive ? C.accent : C.btnSecondaryBg }]}>
                    <MaterialIcons
                      name="folder"
                      size={10}
                      color={isActive ? C.btnPrimaryText : C.accentBlue}
                    />
                  </View>
                  <Text
                    style={[styles.repoName, { color: isActive ? C.accent : C.text1 }, isActive && neonTextGlow]}
                    numberOfLines={1}
                  >
                    {name.toUpperCase()}
                  </Text>
                  {isActive && gitDirtyCount !== null && gitDirtyCount > 0 && (
                    <View style={styles.gitDirtyBadge}>
                      <Text style={styles.gitDirtyText}>{String(gitDirtyCount)}</Text>
                    </View>
                  )}
                  {isActive && (
                    <Text style={styles.repoVersion}>V9.2</Text>
                  )}
                </Pressable>
              );
            })
          )}
          <Pressable style={styles.addRow} onPress={() => setAddRepoVisible(true)}>
            <Text style={styles.addRowText}>+ ADD REPOSITORY</Text>
          </Pressable>
        </SidebarSection>

        {/* FILE TREE */}
        <SidebarSection
          title="FILE TREE"
          icon="folder-open"
          isOpen={openSections.files}
          onToggle={() => toggleSection('files')}
          iconsOnly={iconsOnly}
        >
          <FileTree />
        </SidebarSection>

        {/* DEVICE */}
        <SidebarSection
          title="DEVICE"
          icon="phone-android"
          isOpen={openSections.device}
          onToggle={() => toggleSection('device')}
          iconsOnly={iconsOnly}
        >
          {QUICK_FOLDERS.map(({ label, path, icon }) => (
            <Pressable
              key={path}
              style={styles.deviceRow}
              onPress={() => setActiveRepo(path)}
            >
              <MaterialIcons name={icon as any} size={13} color={C.accentBlue} />
              <Text style={styles.deviceLabel}>{label}</Text>
            </Pressable>
          ))}
        </SidebarSection>

        {/* PORTS — live `ss -tlnp` scan every 20s (see useEffect above) */}
        <SidebarSection
          title="PORTS"
          icon="lan"
          isOpen={openSections.ports}
          onToggle={() => toggleSection('ports')}
          iconsOnly={iconsOnly}
        >
          {portEntries.length === 0 ? (
            <Text style={styles.portEmpty}>No listeners</Text>
          ) : (
            portEntries.map((entry) => {
              // Color map: Expo ports go sky, everything else green.
              const isExpo = entry.port === 8081 || (entry.port >= 19000 && entry.port <= 19002);
              const dotColor = isExpo ? C.accentSky : C.accentGreen;
              const label = portLabel(entry);
              return (
                <Pressable
                  key={entry.port}
                  style={styles.portRow}
                  onPress={() => openUrl(`http://localhost:${entry.port}`)}
                >
                  <View style={[styles.portDot, { backgroundColor: dotColor }, neonDotGlow]} />
                  <Text style={styles.portLabel}>{`:${entry.port}`}</Text>
                  {label ? <Text style={styles.portName}>{label}</Text> : null}
                  <View style={{ flex: 1 }} />
                  <MaterialIcons name="open-in-new" size={I.externalLink} color={C.text2} />
                </Pressable>
              );
            })
          )}
        </SidebarSection>

        {/* PROFILES */}
        <SidebarSection
          title="PROFILES"
          icon="manage-accounts"
          isOpen={openSections.profiles}
          onToggle={() => toggleSection('profiles')}
          iconsOnly={iconsOnly}
        >
          <ProfilesSection />
        </SidebarSection>
      </ScrollView>

      {/* Add repository modal */}
      <Modal
        visible={addRepoVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setAddRepoVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setAddRepoVisible(false)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>ADD REPOSITORY</Text>
            <TextInput
              style={styles.modalInput}
              value={repoInput}
              onChangeText={setRepoInput}
              placeholder="~/projects/my-repo"
              placeholderTextColor={C.text2}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onSubmitEditing={() => {
                const path = repoInput.trim();
                if (path) {
                  addRepo(path);
                  setActiveRepo(path);
                  setRepoInput('');
                  setAddRepoVisible(false);
                }
              }}
            />
            <View style={styles.modalBtns}>
              <Pressable
                style={styles.modalCancelBtn}
                onPress={() => { setRepoInput(''); setAddRepoVisible(false); }}
              >
                <Text style={styles.modalCancelText}>CANCEL</Text>
              </Pressable>
              <Pressable
                style={styles.modalAddBtn}
                onPress={() => {
                  const path = repoInput.trim();
                  if (path) {
                    addRepo(path);
                    setActiveRepo(path);
                    setRepoInput('');
                    setAddRepoVisible(false);
                  }
                }}
              >
                <Text style={styles.modalAddText}>ADD</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Collapse toggle */}
      <Pressable
        style={[styles.toggleBtn, { borderTopColor: C.border }]}
        onPress={handleToggle}
        hitSlop={8}
      >
        <MaterialIcons
          name={mode === 'expanded' ? 'chevron-left' : 'chevron-right'}
          size={20}
          color={C.text2}
        />
        {!iconsOnly && (
          <Text style={styles.toggleLabel}>Collapse</Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'column',
    borderRightWidth: S.borderWidth,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 8,
  },
  // Tasks
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: P.sidebarItem.px,
    height: S.sidebarItemHeight,
    gap: 5,
  },
  tasksSeparator: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: P.sidebarItem.px,
    marginVertical: 2,
  },
  tasksSubheader: {
    fontFamily: F.family,
    fontSize: 7,
    color: C.text3,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 2,
    letterSpacing: 0.5,
  },
  tasksAction: {
    paddingHorizontal: 3,
  },
  tasksEmpty: {
    fontFamily: F.family,
    fontSize: 8,
    color: C.text3,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 4,
    letterSpacing: 0.3,
  },
  taskDot: {
    width: S.agentDotSize,
    height: S.agentDotSize,
    borderRadius: S.agentDotSize / 2,
  },
  taskInfo: {
    flex: 1,
  },
  taskAge: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text2,
    letterSpacing: 0.3,
  },
  taskName: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text1,
    letterSpacing: 0.3,
  },
  statusBadge: {
    paddingHorizontal: P.statusBadge.px,
    paddingVertical: P.statusBadge.py,
    borderRadius: R.badge,
  },
  statusBadgeText: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    letterSpacing: 0.5,
  },
  // Repos
  repoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: P.sidebarItem.px,
    height: S.sidebarItemHeight,
    borderRadius: R.badge,
    borderLeftWidth: 0,
    borderLeftColor: 'transparent',
  },
  repoRowActive: {
    backgroundColor: C.badgeRunningBg,
    borderLeftWidth: 2,
    borderLeftColor: C.accent,
  },
  repoIcon: {
    width: 14,
    height: 14,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  repoName: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.5,
    flex: 1,
  },
  repoVersion: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text2,
  },
  gitDirtyBadge: {
    backgroundColor: C.badgeRunningBg,
    borderRadius: R.badge,
    paddingHorizontal: 4,
    paddingVertical: 1,
    marginRight: 4,
  },
  gitDirtyText: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.badgeRunningText,
    letterSpacing: 0.3,
  },
  addRow: {
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: P.sidebarItem.py,
  },
  addRowText: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text2,
    letterSpacing: 0.3,
  },
  // Device
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: P.sidebarItem.px,
    height: S.sidebarItemHeight,
  },
  deviceLabel: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text1,
    letterSpacing: 0.3,
  },
  // Ports
  // (cloudSpacer was reused here historically; inline flex:1 View now.)
  // Ports
  portRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: P.sidebarItem.px,
    height: S.sidebarItemHeight,
  },
  portDot: {
    width: S.agentDotSize,
    height: S.agentDotSize,
    borderRadius: S.agentDotSize / 2,
  },
  portLabel: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.text1,
  },
  portName: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text2,
  },
  portEmpty: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    color: C.text3,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 6,
    letterSpacing: 0.3,
  },
  // Toggle
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderTopWidth: S.borderWidth,
    gap: 4,
  },
  toggleLabel: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    color: C.text2,
  },
  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: 280,
    backgroundColor: C.bgSurface,
    borderRadius: 10,
    padding: 16,
    borderWidth: S.borderWidth,
    borderColor: C.border,
  },
  modalTitle: {
    color: C.text2,
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 12,
  },
  modalInput: {
    height: 36,
    backgroundColor: C.bgDeep,
    borderRadius: 6,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    paddingHorizontal: 10,
    fontFamily: F.family,
    fontSize: 12,
    color: C.text1,
    marginBottom: 12,
  },
  modalBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  modalCancelBtn: {
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 6,
    borderRadius: R.agentTab,
    backgroundColor: C.btnSecondaryBg,
  },
  modalCancelText: {
    color: C.btnSecondaryText,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
  },
  modalAddBtn: {
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 6,
    borderRadius: R.agentTab,
    backgroundColor: C.badgeRunningBg,
  },
  modalAddText: {
    color: C.accent,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
  },
});
