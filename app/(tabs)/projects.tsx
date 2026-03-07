/**
 * app/(tabs)/projects.tsx
 *
 * Projects tab — Chat history + Project folders.
 * GPT/Claude left-panel equivalent, as a tab for mobile.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import { useChatStore, type ChatSession } from '@/store/chat-store';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { useTerminalStore } from '@/store/terminal-store';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'chats' | 'projects';

interface ProjectEntry {
  name: string;
  path: string;
  isGit: boolean;
  hasPackageJson: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProjectsScreen() {
  const insets = useSafeAreaInsets();
  const { colors: c } = useTheme();
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<Tab>('chats');
  const [searchQuery, setSearchQuery] = useState('');

  // ── Chat Store ──
  const {
    sessions,
    activeSessionId,
    isLoaded,
    load: loadChat,
    createSession,
    deleteSession,
    setActiveSession,
    searchSessions,
  } = useChatStore();

  useEffect(() => {
    if (!isLoaded) loadChat();
  }, [isLoaded]);

  // ── Project scanning ──
  const { bridgeStatus } = useTerminalStore();
  const { runCommand } = useTermuxBridge();
  const isConnected = bridgeStatus === 'connected';
  const [projectDirs, setProjectDirs] = useState<ProjectEntry[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);

  const exec = useCallback(async (cmd: string): Promise<string | null> => {
    try {
      const result = await runCommand(cmd);
      if (result.exitCode !== 0 && !result.stdout) return null;
      return result.stdout || null;
    } catch { return null; }
  }, [runCommand]);

  const scanProjects = useCallback(async () => {
    if (!isConnected) return;
    setIsLoadingProjects(true);
    try {
      const scanDirs = ['~/dev', '~/projects', '~/Shelly', '~/storage/shared/Documents/development'];
      const entries: ProjectEntry[] = [];
      for (const dir of scanDirs) {
        const listing = await exec(`ls -1 ${dir} 2>/dev/null | head -20`);
        if (!listing) continue;
        const items = listing.split('\n').filter(Boolean);
        for (const item of items) {
          const fullPath = `${dir}/${item}`;
          const checks = await exec(
            `[ -d "${fullPath}" ] && echo "dir" || echo "file"; [ -d "${fullPath}/.git" ] && echo "git" || echo "nogit"; [ -f "${fullPath}/package.json" ] && echo "pkg" || echo "nopkg"`,
          );
          if (!checks) continue;
          const lines = checks.split('\n');
          if (lines[0] !== 'dir') continue;
          entries.push({ name: item, path: fullPath, isGit: lines[1] === 'git', hasPackageJson: lines[2] === 'pkg' });
        }
      }
      setProjectDirs(entries);
    } catch { /* ignore */ }
    setIsLoadingProjects(false);
  }, [isConnected, exec]);

  useEffect(() => {
    if (isConnected && activeTab === 'projects') scanProjects();
  }, [isConnected, activeTab]);

  // ── Debounced search (300ms) ──
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    debounceTimer.current = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(debounceTimer.current);
  }, [searchQuery]);

  const filteredSessions = debouncedQuery
    ? searchSessions(debouncedQuery)
    : sessions;

  // ── Handlers ──
  const handleNewChat = useCallback(() => {
    createSession('New Chat');
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/(tabs)/' as any);
  }, [createSession, router]);

  const handleSelectChat = useCallback((session: ChatSession) => {
    setActiveSession(session.id);
    router.push('/(tabs)/' as any);
  }, [setActiveSession, router]);

  const handleDeleteChat = useCallback((session: ChatSession) => {
    Alert.alert(
      'チャットを削除',
      `「${session.title}」を削除しますか？`,
      [
        { text: 'キャンセル', style: 'cancel' },
        { text: '削除', style: 'destructive', onPress: () => deleteSession(session.id) },
      ],
    );
  }, [deleteSession]);

  const handleOpenProject = useCallback((path: string) => {
    // Create a new chat session linked to this project
    const name = path.split('/').pop() ?? path;
    createSession(name, path);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push('/(tabs)/' as any);
  }, [createSession, router]);

  // ── Chat list item ──
  const renderChatItem = useCallback(({ item }: { item: ChatSession }) => {
    const isActive = item.id === activeSessionId;
    const lastMsg = item.messages[item.messages.length - 1];
    const preview = lastMsg?.content?.slice(0, 60) || 'No messages';
    const timeAgo = formatTimeAgo(item.updatedAt);

    return (
      <TouchableOpacity
        style={[
          styles.chatItem,
          { backgroundColor: isActive ? withAlpha(c.accent, 0.08) : 'transparent', borderColor: c.border },
        ]}
        onPress={() => handleSelectChat(item)}
        onLongPress={() => handleDeleteChat(item)}
        activeOpacity={0.7}
      >
        <View style={styles.chatItemContent}>
          <View style={styles.chatItemHeader}>
            <Text style={[styles.chatTitle, { color: isActive ? c.accent : c.foreground }]} numberOfLines={1}>
              {item.title}
            </Text>
            <Text style={[styles.chatTime, { color: c.inactive }]}>{timeAgo}</Text>
          </View>
          <Text style={[styles.chatPreview, { color: c.muted }]} numberOfLines={2}>
            {preview}
          </Text>
          <View style={styles.chatMeta}>
            <Text style={[styles.chatMsgCount, { color: c.inactive }]}>
              {item.messages.length} messages
            </Text>
            {item.projectPath && (
              <View style={[styles.projectBadge, { backgroundColor: withAlpha(c.accent, 0.1) }]}>
                <MaterialIcons name="folder" size={10} color={c.accent} />
                <Text style={[styles.projectBadgeText, { color: c.accent }]}>
                  {item.projectPath.split('/').pop()}
                </Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  }, [activeSessionId, c, handleSelectChat, handleDeleteChat]);

  return (
    <View style={[styles.container, { backgroundColor: c.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <Text style={[styles.headerTitle, { color: c.foreground }]}>Projects</Text>
        <TouchableOpacity onPress={handleNewChat} style={[styles.newBtn, { backgroundColor: withAlpha(c.accent, 0.1) }]}>
          <MaterialIcons name="add" size={18} color={c.accent} />
          <Text style={[styles.newBtnText, { color: c.accent }]}>New Chat</Text>
        </TouchableOpacity>
      </View>

      {/* Tab switcher */}
      <View style={[styles.tabRow, { borderBottomColor: c.border }]}>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'chats' && { borderBottomColor: c.accent, borderBottomWidth: 2 }]}
          onPress={() => setActiveTab('chats')}
        >
          <MaterialIcons name="chat" size={16} color={activeTab === 'chats' ? c.accent : c.inactive} />
          <Text style={[styles.tabText, { color: activeTab === 'chats' ? c.accent : c.inactive }]}>
            Chats ({sessions.length})
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, activeTab === 'projects' && { borderBottomColor: c.accent, borderBottomWidth: 2 }]}
          onPress={() => setActiveTab('projects')}
        >
          <MaterialIcons name="folder" size={16} color={activeTab === 'projects' ? c.accent : c.inactive} />
          <Text style={[styles.tabText, { color: activeTab === 'projects' ? c.accent : c.inactive }]}>
            Folders {projectDirs.length > 0 ? `(${projectDirs.length})` : ''}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Search */}
      {activeTab === 'chats' && (
        <View style={[styles.searchRow, { borderBottomColor: c.border }]}>
          <MaterialIcons name="search" size={18} color={c.inactive} />
          <TextInput
            style={[styles.searchInput, { color: c.foreground }]}
            placeholder="Search chats..."
            placeholderTextColor={c.inactive}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <MaterialIcons name="close" size={16} color={c.inactive} />
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* Content */}
      {activeTab === 'chats' ? (
        <FlatList
          data={filteredSessions}
          renderItem={renderChatItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyBox}>
              <MaterialIcons name="chat-bubble-outline" size={40} color={c.inactive} />
              <Text style={[styles.emptyText, { color: c.muted }]}>
                {searchQuery ? 'No matching chats' : 'No chats yet.\nTap + New Chat to start.'}
              </Text>
            </View>
          }
        />
      ) : (
        <ScrollView
          style={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={isLoadingProjects}
              onRefresh={scanProjects}
              tintColor={c.accent}
            />
          }
        >
          {!isConnected && (
            <View style={styles.emptyBox}>
              <MaterialIcons name="link-off" size={40} color={c.inactive} />
              <Text style={[styles.emptyText, { color: c.muted }]}>
                Termuxに接続するとプロジェクトフォルダが表示されます
              </Text>
            </View>
          )}

          {isConnected && isLoadingProjects && (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="small" color={c.accent} />
              <Text style={[styles.loadingText, { color: c.muted }]}>Scanning...</Text>
            </View>
          )}

          {isConnected && !isLoadingProjects && projectDirs.map((proj) => (
            <TouchableOpacity
              key={proj.path}
              style={[styles.projectCard, { backgroundColor: c.surfaceHigh, borderColor: c.border }]}
              onPress={() => handleOpenProject(proj.path)}
              activeOpacity={0.7}
            >
              <View style={[styles.projectIcon, { backgroundColor: withAlpha(proj.isGit ? '#60A5FA' : '#FBBF24', 0.15) }]}>
                <MaterialIcons
                  name={proj.isGit ? 'source' : 'folder'}
                  size={22}
                  color={proj.isGit ? '#60A5FA' : '#FBBF24'}
                />
              </View>
              <View style={styles.projectInfo}>
                <Text style={[styles.projectName, { color: c.foreground }]}>{proj.name}</Text>
                <Text style={[styles.projectPath, { color: c.muted }]}>
                  {proj.path.replace(/^~\//, '')}
                </Text>
                <View style={styles.badgeRow}>
                  {proj.isGit && (
                    <View style={[styles.badge, { backgroundColor: '#60A5FA20' }]}>
                      <Text style={[styles.badgeText, { color: '#60A5FA' }]}>git</Text>
                    </View>
                  )}
                  {proj.hasPackageJson && (
                    <View style={[styles.badge, { backgroundColor: '#34D39920' }]}>
                      <Text style={[styles.badgeText, { color: '#34D399' }]}>node</Text>
                    </View>
                  )}
                </View>
              </View>
              <MaterialIcons name="chevron-right" size={20} color={c.inactive} />
            </TouchableOpacity>
          ))}

          {isConnected && !isLoadingProjects && projectDirs.length === 0 && (
            <View style={styles.emptyBox}>
              <MaterialIcons name="create-new-folder" size={40} color={c.inactive} />
              <Text style={[styles.emptyText, { color: c.muted }]}>
                {'~/dev/ や ~/projects/ に\nフォルダがありません'}
              </Text>
            </View>
          )}
          <View style={{ height: 80 }} />
        </ScrollView>
      )}
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(timestamp).toLocaleDateString();
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  newBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  newBtnText: {
    fontSize: 12,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  tabRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
  },
  tabText: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    fontFamily: 'monospace',
    paddingVertical: 4,
  },
  listContent: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 8,
  },
  // Chat items
  chatItem: {
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 6,
    overflow: 'hidden',
  },
  chatItemContent: {
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chatItemHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  chatTitle: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
    flex: 1,
  },
  chatTime: {
    fontSize: 10,
    fontFamily: 'monospace',
    marginLeft: 8,
  },
  chatPreview: {
    fontSize: 11,
    fontFamily: 'monospace',
    lineHeight: 16,
    marginBottom: 6,
  },
  chatMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chatMsgCount: {
    fontSize: 10,
    fontFamily: 'monospace',
  },
  projectBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  projectBadgeText: {
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  // Project items
  projectCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
  },
  projectIcon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  projectInfo: { flex: 1 },
  projectName: {
    fontSize: 13,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  projectPath: {
    fontSize: 10,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  badgeRow: {
    flexDirection: 'row',
    gap: 4,
    marginTop: 4,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 3,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  // Empty / Loading
  emptyBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    gap: 12,
  },
  emptyText: {
    fontSize: 12,
    fontFamily: 'monospace',
    textAlign: 'center',
    lineHeight: 20,
  },
  loadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 30,
  },
  loadingText: {
    fontSize: 12,
    fontFamily: 'monospace',
  },
});
