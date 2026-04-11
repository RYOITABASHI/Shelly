// components/layout/Sidebar.tsx
import React, { useState } from 'react';
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
import { useSettingsStore } from '@/store/settings-store';
import { SidebarSection } from './SidebarSection';
import { FileTree } from './FileTree';
import { ProfilesSection } from './ProfilesSection';
import { neonTextGlow, neonDotGlow } from '@/lib/neon-glow';

const WIDTH_EXPANDED = 170;
const WIDTH_ICONS = 48;
const WIDTH_HIDDEN = 0;
const TIMING_MS = 200;
const ACCENT = '#00D4AA';

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

const CLOUD_SERVICES = [
  { label: 'GOOGLE DRIVE', status: 'LINKED', icon: 'cloud', linked: true },
  { label: 'DROPBOX', status: 'CONNECT', icon: 'cloud-queue', linked: false },
  { label: 'ONEDRIVE', status: 'CONNECT', icon: 'cloud-queue', linked: false },
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
    mode === 'expanded' ? WIDTH_EXPANDED : mode === 'icons' ? WIDTH_ICONS : WIDTH_HIDDEN;

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
    <Animated.View style={[styles.container, animatedStyle, { backgroundColor: '#0D0D0D', borderRightColor: c.border }]}>
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
          {/* Mock dummy tasks (fallback when no real data) */}
          {runningAgents.length === 0 && recentTasks.length === 0 ? (
            <>
              <View style={styles.taskRow}>
                <View style={[styles.taskDot, { backgroundColor: ACCENT }]} />
                <View style={styles.taskInfo}>
                  <Text style={styles.taskName} numberOfLines={1}>NPM RUN DEV</Text>
                </View>
                <View style={[styles.statusBadge, { backgroundColor: 'rgba(239,68,68,0.15)' }]}>
                  <Text style={[styles.statusBadgeText, { color: '#EF4444' }]}>RUNNING</Text>
                </View>
              </View>
              <View style={styles.taskRow}>
                <MaterialIcons name="check-circle" size={10} color={ACCENT} />
                <View style={styles.taskInfo}>
                  <Text style={styles.taskName} numberOfLines={1}>GIT PUSH</Text>
                </View>
                <Text style={styles.taskAge}>25 AGO</Text>
              </View>
            </>
          ) : (
            <>
              {runningAgents.map((agent) => (
                <View key={agent.id} style={styles.taskRow}>
                  <View style={[styles.taskDot, { backgroundColor: ACCENT }]} />
                  <View style={styles.taskInfo}>
                    <Text style={styles.taskName} numberOfLines={1}>
                      {agent.name.toUpperCase()}
                    </Text>
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: 'rgba(239,68,68,0.15)' }]}>
                    <Text style={[styles.statusBadgeText, { color: '#EF4444' }]}>RUNNING</Text>
                  </View>
                </View>
              ))}
              {recentTasks.map((task) => (
                <View key={task.id} style={styles.taskRow}>
                  <MaterialIcons name="check-circle" size={10} color={ACCENT} />
                  <View style={styles.taskInfo}>
                    <Text style={styles.taskName} numberOfLines={1}>
                      {task.name.toUpperCase()}
                    </Text>
                  </View>
                  <Text style={styles.taskAge}>{task.age}</Text>
                </View>
              ))}
            </>
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
                  style={[styles.repoRow, repo.active && { backgroundColor: ACCENT + '15', borderLeftWidth: 2, borderLeftColor: ACCENT }]}
                >
                  <View style={[styles.repoIcon, { backgroundColor: repo.active ? ACCENT : '#333' }]}>
                    <MaterialIcons name="folder" size={10} color={repo.active ? '#000' : '#999'} />
                  </View>
                  <Text style={[styles.repoName, { color: repo.active ? ACCENT : '#E5E7EB' }]} numberOfLines={1}>
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
                  style={[styles.repoRow, isActive && { backgroundColor: ACCENT + '15', borderLeftWidth: 2, borderLeftColor: ACCENT }]}
                  onPress={() => setActiveRepo(p)}
                >
                  <View style={[styles.repoIcon, { backgroundColor: isActive ? ACCENT : '#333' }]}>
                    <MaterialIcons
                      name="folder"
                      size={10}
                      color={isActive ? '#000' : '#999'}
                    />
                  </View>
                  <Text
                    style={[styles.repoName, { color: isActive ? ACCENT : '#E5E7EB' }, isActive && neonTextGlow]}
                    numberOfLines={1}
                  >
                    {name.toUpperCase()}
                  </Text>
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
              <MaterialIcons name={icon as any} size={13} color="#6B7280" />
              <Text style={styles.deviceLabel}>{label}</Text>
            </Pressable>
          ))}
        </SidebarSection>

        {/* CLOUD */}
        <SidebarSection
          title="CLOUD"
          icon="cloud"
          isOpen={openSections.cloud}
          onToggle={() => toggleSection('cloud')}
          iconsOnly={iconsOnly}
        >
          {CLOUD_SERVICES.map((svc) => (
            <Pressable
              key={svc.label}
              style={styles.cloudRow}
              onPress={() => {
                if (!svc.linked) {
                  Alert.alert(
                    svc.label,
                    'Cloud storage integration coming soon. Configure in Settings.',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Open Settings', onPress: () => useSettingsStore.getState().setShowConfigTUI(true) },
                    ]
                  );
                }
              }}
            >
              <MaterialIcons
                name={svc.icon as any}
                size={13}
                color={svc.linked ? ACCENT : '#6B7280'}
              />
              <Text style={styles.cloudLabel}>{svc.label}</Text>
              <View style={styles.cloudSpacer} />
              <Text
                style={[
                  styles.cloudStatus,
                  { color: svc.linked ? ACCENT : '#6B7280' },
                ]}
              >
                {svc.status}
              </Text>
            </Pressable>
          ))}
        </SidebarSection>

        {/* PORTS */}
        <SidebarSection
          title="PORTS"
          icon="lan"
          isOpen={openSections.ports}
          onToggle={() => toggleSection('ports')}
          iconsOnly={iconsOnly}
        >
          <View style={styles.portRow}>
            <View style={[styles.portDot, { backgroundColor: ACCENT }, neonDotGlow]} />
            <Text style={styles.portLabel}>:3000</Text>
            <Text style={styles.portName}>NEXT.JS</Text>
            <View style={styles.cloudSpacer} />
            <MaterialIcons name="open-in-new" size={11} color="#6B7280" />
          </View>
          <View style={styles.portRow}>
            <View style={[styles.portDot, { backgroundColor: ACCENT }, neonDotGlow]} />
            <Text style={styles.portLabel}>:8081</Text>
            <Text style={styles.portName}>EXPO</Text>
            <View style={styles.cloudSpacer} />
            <MaterialIcons name="open-in-new" size={11} color="#6B7280" />
          </View>
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
              placeholderTextColor="#6B7280"
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
        style={[styles.toggleBtn, { borderTopColor: c.border }]}
        onPress={handleToggle}
        hitSlop={8}
      >
        <MaterialIcons
          name={mode === 'expanded' ? 'chevron-left' : 'chevron-right'}
          size={20}
          color="#6B7280"
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
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 8,
  },
  emptyText: {
    fontSize: 10,
    fontFamily: 'GeistPixel-Square',
    color: '#6B7280',
    paddingHorizontal: 12,
    paddingVertical: 6,
    fontStyle: 'italic',
  },
  // Tasks
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 3,
    gap: 6,
  },
  taskDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  taskInfo: {
    flex: 1,
  },
  taskAge: {
    fontSize: 8,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '600',
    color: '#6B7280',
    letterSpacing: 0.3,
  },
  taskName: {
    fontSize: 10,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '600',
    color: '#E5E7EB',
    letterSpacing: 0.3,
  },
  statusBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  statusBadgeText: {
    fontSize: 8,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  // Repos
  repoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 3,
    borderLeftWidth: 0,
    borderLeftColor: 'transparent',
  },
  repoIcon: {
    width: 18,
    height: 18,
    borderRadius: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  repoName: {
    fontSize: 10,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '700',
    letterSpacing: 0.5,
    flex: 1,
  },
  repoVersion: {
    fontSize: 9,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '600',
    color: '#6B7280',
  },
  addRow: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  addRowText: {
    fontSize: 10,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '600',
    color: '#6B7280',
    letterSpacing: 0.3,
  },
  // Device
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  deviceLabel: {
    fontSize: 10,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '600',
    color: '#E5E7EB',
    letterSpacing: 0.3,
  },
  // Cloud
  cloudRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  cloudLabel: {
    fontSize: 10,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '600',
    color: '#E5E7EB',
    letterSpacing: 0.3,
  },
  cloudSpacer: {
    flex: 1,
  },
  cloudStatus: {
    fontSize: 8,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '800',
    letterSpacing: 0.5,
  },
  // Ports
  portRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  portDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  portLabel: {
    fontSize: 10,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '700',
    color: '#E5E7EB',
  },
  portName: {
    fontSize: 10,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '600',
    color: '#6B7280',
  },
  // Toggle
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  toggleLabel: {
    fontSize: 10,
    fontFamily: 'GeistPixel-Square',
    color: '#6B7280',
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
    backgroundColor: '#1A1A1A',
    borderRadius: 10,
    padding: 16,
    borderWidth: 1,
    borderColor: '#333',
  },
  modalTitle: {
    color: '#6B7280',
    fontSize: 9,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 12,
  },
  modalInput: {
    height: 36,
    backgroundColor: '#111',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#333',
    paddingHorizontal: 10,
    fontFamily: 'GeistPixel-Square',
    fontSize: 12,
    color: '#E5E7EB',
    marginBottom: 12,
  },
  modalBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  modalCancelBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: '#222',
  },
  modalCancelText: {
    color: '#6B7280',
    fontSize: 10,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '700',
  },
  modalAddBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    backgroundColor: 'rgba(0,212,170,0.15)',
  },
  modalAddText: {
    color: ACCENT,
    fontSize: 10,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '700',
  },
});
