// components/layout/Sidebar.tsx
import React, { useState, useEffect } from 'react';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { usePortsStore, parseProcNet, portLabel } from '@/store/ports-store';
import { useFocusStore } from '@/store/focus-store';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  Modal,
  Alert,
  AppState,
} from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';
import { useSidebarStore } from '@/store/sidebar-store';
import { normalizePath } from '@/lib/normalize-path';
import { readDirEntries } from '@/lib/fs-native';
import { logInfo } from '@/lib/debug-logger';
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
import { WorktreesSection } from './WorktreesSection';
import {
  neonTextGlow,
  neonDotGlow,
  neonBorderGlow,
  neonGlowSky,
  neonGlowPink,
  neonGlowPurple,
  neonGlowAmber,
  neonGlowGreen,
  neonGlowBlue,
  neonGlowTeal,
} from '@/lib/neon-glow';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R, icons as I } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { usePanelBackground } from '@/hooks/use-panel-background';

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

// Per-quick-folder neon palette. Each shortcut gets its own hue so the
// DEVICE section reads as a colour-coded grid instead of a teal column.
// Uses shellyPalette accent tokens so theme swaps flow through (TokyoNight
// / Catppuccin pastels replace the shelly neons automatically).
const QUICK_FOLDERS = [
  { label: '~',        path: '~/',                 icon: 'home',          color: C.accentPink,   glow: neonGlowPink },
  { label: 'DCIM',     path: '/sdcard/DCIM',       icon: 'photo-camera',  color: C.accentAmber,  glow: neonGlowAmber },
  { label: 'DOWNLOAD', path: '/sdcard/Download',   icon: 'download',      color: C.accentBlue,   glow: neonGlowBlue },
  { label: 'DOCUMENT', path: '/sdcard/Documents',  icon: 'description',   color: C.accentPurple, glow: neonGlowPurple },
  { label: 'MUSIC',    path: '/sdcard/Music',      icon: 'music-note',    color: C.accentGreen,  glow: neonGlowGreen },
] as const;

export function Sidebar() {
  const theme = useTheme();
  const c = theme.colors;

  const { mode, openSections, toggleSection, activeRepoPath, repoPaths, setActiveRepo, setMode, addRepo, removeRepo } =
    useSidebarStore();
  const agents = useAgentStore((s) => s.agents);
  const runHistory = useAgentStore((s) => s.runHistory);
  const [addRepoVisible, setAddRepoVisible] = useState(false);
  const [repoInput, setRepoInput] = useState('');

  /**
   * bug #73: validate a repo path before adding it. Previously the UI
   * accepted any string and stored it, leading to ghost entries that just
   * showed empty file trees and 0 git dirty counts. Now we try to list
   * the directory via JNI readDir (which never throws; it returns an empty
   * array on ENOENT/EACCES) and refuse the add if the readdir yields
   * nothing AND a probe lstat via readDirEntries on the parent also shows
   * the entry is missing. The heuristic is cheap and catches the common
   * mistakes: typos, Termux-era paths, and unmounted SD-card paths.
   */
  const tryAddRepo = async (rawPath: string): Promise<void> => {
    const path = rawPath.trim();
    if (!path) return;
    const normalized = normalizePath(path);
    logInfo('Sidebar', `tryAddRepo raw="${path}" normalized="${normalized}"`);
    // readDirEntries returns [] on missing dir; empty repo is unlikely.
    // To distinguish "empty" from "missing", probe the parent and check
    // whether the basename is present. Still permissive: if the parent is
    // unreadable we fall through and accept the add (likely a permission
    // corner case rather than a typo).
    const slash = normalized.lastIndexOf('/');
    const parent = slash > 0 ? normalized.slice(0, slash) : '/';
    const basename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    let exists = false;
    try {
      const parentEntries = await readDirEntries(parent);
      if (parentEntries.length === 0) {
        // Parent unreadable — fall through and accept the add.
        logInfo('Sidebar', `tryAddRepo parent="${parent}" unreadable, accepting add`);
        exists = true;
      } else {
        exists = parentEntries.some((e) => e.name === basename && (e.type === 'd' || e.type === 'l'));
        logInfo('Sidebar', `tryAddRepo probe parent="${parent}" basename="${basename}" exists=${exists}`);
      }
    } catch (e) {
      logInfo('Sidebar', `tryAddRepo probe threw: ${String(e)}; accepting add`);
      exists = true; // don't block on probe failure
    }
    if (!exists) {
      Alert.alert(
        'Directory not found',
        `The path "${path}" does not exist on this device. Double-check the spelling or pick an existing folder.`,
      );
      return;
    }
    addRepo(path);
    setActiveRepo(path);
    setRepoInput('');
    setAddRepoVisible(false);
    useFocusStore.getState().requestTerminalRefocus();
  };

  const focusedPaneId = usePaneStore((s) => s.focusedPaneId);
  const setLeafTab = useMultiPaneStore((s) => s.setLeafTab);
  const openUrl = useBrowserStore((s) => s.openUrl);
  const portsSectionOpen = useSidebarStore((s) => s.openSections.ports);
  const portsPollingDisabled = usePortsStore((s) => s.pollingDisabled);

  // Poll active localhost listeners every 15s. Single-writer pattern
  // (Sidebar owns the interval, usePortsStore is the one state source)
  // so the list stays stable across renders without duplicate work.
  //
  // Plan B does not bundle ss / netstat / lsof, so we read
  // /proc/net/tcp and /proc/net/tcp6 directly and decode the hex
  // columns in JS. Those files are world-readable on Android — the
  // kernel filters rows by uid so we only see sockets owned by this
  // app, which is exactly what the Sidebar needs.
  const portEntries = usePortsStore((s) => s.entries);
  useEffect(() => {
    const setEntries = usePortsStore.getState().setEntries;
    const setPollingDisabled = usePortsStore.getState().setPollingDisabled;
    let cancelled = false;
    const refresh = async () => {
      if (usePortsStore.getState().pollingDisabled) return;
      // bug #99: Android 10+ SELinux denies app_data_file reads of
      // /proc/net/tcp{,6}, so the Plan B fopen path (readProcNetFile)
      // returns EACCES silently. Primary path is now NETLINK_SOCK_DIAG
      // (queryListenSockets) which kernel-filters by caller uid — no
      // policy blocks it and it only returns sockets this app owns.
      // readProcNetFile is kept as a fallback for pre-Android-10
      // devices where the file is still readable.
      const [nlV4, nlV6] = await Promise.all([
        TerminalEmulator.queryListenSockets(4).catch(() => ''),
        TerminalEmulator.queryListenSockets(6).catch(() => ''),
      ]);
      let v4 = nlV4 ?? '';
      let v6 = nlV6 ?? '';
      if (!v4 && !v6) {
        const [pV4, pV6] = await Promise.all([
          TerminalEmulator.readProcNetFile('/proc/net/tcp').catch(() => ''),
          TerminalEmulator.readProcNetFile('/proc/net/tcp6').catch(() => ''),
        ]);
        v4 = pV4 ?? '';
        v6 = pV6 ?? '';
      }
      if (cancelled) return;
      if (!v4 && !v6) {
        setEntries([]);
        setPollingDisabled(true);
        return;
      }
      setEntries(parseProcNet(v4, v6));
    };
    // bug #103: actually pause polling while backgrounded. Earlier revision
    // kept the setInterval running and only added an extra refresh on
    // resume, which defeated the purpose. Track the timer in a ref-style
    // holder and tear it down on blur / rebuild on focus.
    let ivHandle: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (ivHandle !== null) return;
      ivHandle = setInterval(refresh, 15_000);
    };
    const stopPolling = () => {
      if (ivHandle !== null) { clearInterval(ivHandle); ivHandle = null; }
    };
    if (portsSectionOpen && !portsPollingDisabled) {
      refresh();
      startPolling();
    }
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && portsSectionOpen && !usePortsStore.getState().pollingDisabled) { refresh(); startPolling(); }
      else { stopPolling(); }
    });
    return () => { cancelled = true; stopPolling(); sub.remove(); };
  }, [portsSectionOpen, portsPollingDisabled]);

  // Git dirty-count polling removed 2026-04-21. The count was run against
  // `$HOME` which is not a sane repo context — CLI bg updates, install
  // logs, npm caches, and .claude state all counted as "dirty", surfacing
  // alarming 3-digit numbers that did not track any real work in progress.
  // If this returns it should be scoped to a real repo path (a row in
  // REPOSITORIES) and use git's own per-file metadata rather than a
  // porcelain line count.

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

  // usePanelBackground MUST be called before any early return to satisfy
  // Rules of Hooks. It picks up wallpaper state from cosmetic-store and
  // returns either the solid C.bgSidebar or a half-alpha variant when
  // the user has a wallpaper set.
  const sidebarBg = usePanelBackground(C.bgSidebar);

  if (mode === 'hidden') return null;

  return (
    <Animated.View style={[styles.container, animatedStyle, { backgroundColor: sidebarBg, borderRightColor: C.border }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* TASKS */}
        <SidebarSection
          title="TASKS"
          icon="task-alt"
          isOpen={openSections.tasks}
          onToggle={() => toggleSection('tasks')}
          badge={runningAgents.length}
          iconsOnly={iconsOnly}
          accent={C.accentPink}
          glow={neonGlowPink}
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
              {agents.filter((a) => a.enabled).map((agent) => (
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
                    accessibilityRole="button"
                    accessibilityLabel={`Run agent ${agent.name} now`}
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
                    accessibilityRole="button"
                    accessibilityLabel={`Delete agent ${agent.name}`}
                  >
                    <MaterialIcons name="delete-outline" size={12} color={C.errorText} />
                  </Pressable>
                </View>
              ))}
            </>
          )}
          {runningAgents.length === 0 && recentTasks.length === 0 && agents.length === 0 && (
            <Text style={styles.tasksEmpty}>
              Type `@agent status` in an AI pane to manage background agents.
            </Text>
          )}
        </SidebarSection>

        {/* REPOSITORIES */}
        <SidebarSection
          title="REPOSITORIES"
          icon="folder"
          isOpen={openSections.repos}
          onToggle={() => toggleSection('repos')}
          iconsOnly={iconsOnly}
          accent={C.accent}
          glow={neonGlowTeal}
        >
          {repoPaths.length === 0 ? (
            <Text style={styles.emptyRepoHint}>
              No repositories yet. Tap + ADD REPOSITORY to browse your code.
            </Text>
          ) : (
            repoPaths.map((p) => {
              const isActive = p === activeRepoPath;
              const name = p.replace(/^.*\//, '') || p;
              return (
                <Pressable
                  key={p}
                  style={[styles.repoRow, isActive && styles.repoRowActive, isActive && neonBorderGlow]}
                  onPress={() => setActiveRepo(p)}
                  onLongPress={() => {
                    Alert.alert(
                      'Remove repository',
                      `Remove "${name}" from the sidebar? This does not delete the files on disk.`,
                      [
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Remove', style: 'destructive', onPress: () => removeRepo(p) },
                      ],
                    );
                  }}
                  delayLongPress={350}
                >
                  <View style={[styles.repoIcon, { backgroundColor: isActive ? C.accent : C.btnSecondaryBg }, isActive && neonDotGlow]}>
                    <MaterialIcons
                      name="folder"
                      size={10}
                      color={isActive ? C.btnPrimaryText : C.accentSky}
                      style={isActive ? undefined : neonGlowSky}
                    />
                  </View>
                  <Text
                    style={[styles.repoName, { color: isActive ? C.accent : C.text1 }, isActive && neonTextGlow]}
                    numberOfLines={1}
                  >
                    {name.toUpperCase()}
                  </Text>
                  {isActive && (
                    <Text style={[styles.repoVersion, neonGlowSky]}>V9.2</Text>
                  )}
                </Pressable>
              );
            })
          )}
          <Pressable style={styles.addRow} onPress={() => setAddRepoVisible(true)}>
            <Text style={styles.addRowText}>+ ADD REPOSITORY</Text>
          </Pressable>
        </SidebarSection>

        {/* WORKTREES — parallel agent branches for the active repo (Phase 1).
            Lives directly under REPOSITORIES because it's a child concept: a
            worktree is always anchored to a specific repo. */}
        <WorktreesSection
          isOpen={openSections.worktrees}
          onToggle={() => toggleSection('worktrees')}
          iconsOnly={iconsOnly}
        />

        {/* FILE TREE */}
        <SidebarSection
          title="FILE TREE"
          icon="description"
          isOpen={openSections.files}
          onToggle={() => toggleSection('files')}
          iconsOnly={iconsOnly}
          accent={C.accentSky}
          glow={neonGlowSky}
        >
          <FileTree />
        </SidebarSection>

        {/* DEVICE */}
        <SidebarSection
          title="DEVICE"
          icon="stay-current-portrait"
          isOpen={openSections.device}
          onToggle={() => toggleSection('device')}
          iconsOnly={iconsOnly}
          accent={C.accentAmber}
          glow={neonGlowAmber}
        >
          {QUICK_FOLDERS.map(({ label, path, icon, color, glow }) => (
            <Pressable
              key={path}
              style={styles.deviceRow}
              onPress={() => setActiveRepo(path)}
            >
              <MaterialIcons name={icon as any} size={13} color={color} style={glow} />
              <Text style={[styles.deviceLabel, { color }]} numberOfLines={1} ellipsizeMode="tail">
                {label}
              </Text>
            </Pressable>
          ))}
        </SidebarSection>

        {/* PORTS — live /proc/net/tcp{,6} scan every 15s (see useEffect above) */}
        <SidebarSection
          title="PORTS"
          icon="hub"
          isOpen={openSections.ports}
          onToggle={() => toggleSection('ports')}
          iconsOnly={iconsOnly}
          accent={C.accentGreen}
          glow={neonGlowGreen}
        >
          {portEntries.length === 0 ? (
            // Android 10+ SELinux denies BOTH /proc/net/tcp reads AND
            // NETLINK_SOCK_DIAG from untrusted_app, so this panel is
            // permanently empty on modern phones until bug #99 gets a
            // privileged-helper path. Say so plainly.
            <Text style={styles.portEmpty}>
              Listener detection unavailable on Android 10+ (SELinux).
            </Text>
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
                  <Text style={styles.portLabel}>{`${entry.address}:${entry.port}`}</Text>
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
          icon="person-outline"
          isOpen={openSections.profiles}
          onToggle={() => toggleSection('profiles')}
          iconsOnly={iconsOnly}
          accent={C.accentBlue}
          glow={neonGlowBlue}
        >
          <ProfilesSection />
        </SidebarSection>
      </ScrollView>

      {/* Add repository modal */}
      <Modal
        visible={addRepoVisible}
        transparent
        animationType="fade"
        onRequestClose={() => { setAddRepoVisible(false); useFocusStore.getState().requestTerminalRefocus(); }}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => { setAddRepoVisible(false); useFocusStore.getState().requestTerminalRefocus(); }}>
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
              onSubmitEditing={() => void tryAddRepo(repoInput)}
            />
            <View style={styles.modalBtns}>
              <Pressable
                style={styles.modalCancelBtn}
                onPress={() => { setRepoInput(''); setAddRepoVisible(false); useFocusStore.getState().requestTerminalRefocus(); }}
              >
                <Text style={styles.modalCancelText}>CANCEL</Text>
              </Pressable>
              <Pressable
                style={styles.modalAddBtn}
                onPress={() => void tryAddRepo(repoInput)}
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
    // Always reserve 2px on the left so toggling isActive does not shift
    // the row horizontally — the only thing that changes is the colour.
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  repoRowActive: {
    // Teal-tinted glow instead of the muddy amber that clashed with the
    // accent border. Pairs with neonBorderGlow (passed inline) for the
    // subtle bleed effect.
    backgroundColor: withAlpha(C.accent, 0.12),
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
    // Sky so it bleeds together with the neonGlowSky applied inline; using
    // text2 (gray) made the glow look ghosted against a washed-out label.
    color: C.accentSky,
  },
  emptyRepoHint: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    color: C.text2,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontStyle: 'italic',
    lineHeight: 14,
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
    flex: 1,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    // Default colour is overridden inline per-row (QUICK_FOLDERS carries
    // a per-folder neon hue); text1 stays as the fallback for any other
    // caller that reuses this style.
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
