/**
 * app/(tabs)/projects.tsx — v1.0
 *
 * Projects タブ: プロジェクトフォルダ管理・ファイルブラウザ。
 * - 開発ディレクトリの一覧表示
 * - プロジェクトの作成履歴（Creator storeと連携）
 * - ファイルツリー表示
 * - git status / package.json 情報
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import { useTerminalStore } from '@/store/terminal-store';
import { useCreatorStore } from '@/store/creator-store';
import { useTheme } from '@/lib/theme-engine';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProjectEntry {
  name: string;
  path: string;
  isGit: boolean;
  hasPackageJson: boolean;
}

interface FileEntry {
  name: string;
  isDirectory: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProjectsScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const c = theme.colors;
  const { bridgeStatus } = useTerminalStore();
  const { runCommand } = useTermuxBridge();
  const { projects: creatorProjects } = useCreatorStore();
  const isConnected = bridgeStatus === 'connected';

  const [projectDirs, setProjectDirs] = useState<ProjectEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [isLoadingFiles, setIsLoadingFiles] = useState(false);
  const [projectInfo, setProjectInfo] = useState<{
    gitBranch?: string;
    gitStatus?: string;
    packageName?: string;
    packageVersion?: string;
  } | null>(null);

  // ── Helper: runCommandでstdoutを取得 ──────────────────────────────────────

  const exec = useCallback(async (cmd: string): Promise<string | null> => {
    try {
      const result = await runCommand(cmd);
      if (result.exitCode !== 0 && !result.stdout) return null;
      return result.stdout || null;
    } catch {
      return null;
    }
  }, [runCommand]);

  // ── プロジェクトディレクトリの走査 ─────────────────────────────────────────

  const scanProjects = useCallback(async () => {
    if (!isConnected) return;
    setIsLoading(true);

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
          entries.push({
            name: item,
            path: fullPath,
            isGit: lines[1] === 'git',
            hasPackageJson: lines[2] === 'pkg',
          });
        }
      }

      // scanDirs自体もプロジェクトかチェック
      for (const dir of scanDirs) {
        const checks = await exec(
          `[ -d "${dir}" ] && echo "dir" || echo "nodir"; [ -d "${dir}/.git" ] && echo "git" || echo "nogit"; [ -f "${dir}/package.json" ] && echo "pkg" || echo "nopkg"`,
        );
        if (!checks) continue;
        const lines = checks.split('\n');
        if (lines[0] !== 'dir') continue;
        if (lines[1] === 'git' || lines[2] === 'pkg') {
          const name = dir.split('/').pop() || dir;
          if (!entries.find((e) => e.path === dir)) {
            entries.push({
              name,
              path: dir,
              isGit: lines[1] === 'git',
              hasPackageJson: lines[2] === 'pkg',
            });
          }
        }
      }

      setProjectDirs(entries);
    } catch {
      // ignore
    } finally {
      setIsLoading(false);
      setRefreshing(false);
    }
  }, [isConnected, exec]);

  useEffect(() => {
    if (isConnected) scanProjects();
  }, [isConnected]);

  // ── ファイル一覧の取得 ──────────────────────────────────────────────────

  const openProject = useCallback(async (path: string) => {
    if (!isConnected) return;
    setCurrentPath(path);
    setIsLoadingFiles(true);
    setProjectInfo(null);

    try {
      const listing = await exec(`ls -1Ap "${path}" 2>/dev/null | head -50`);
      if (listing) {
        const items = listing.split('\n').filter(Boolean).map((name): FileEntry => ({
          name: name.replace(/\/$/, ''),
          isDirectory: name.endsWith('/'),
        }));
        setFiles(items);
      }

      const gitInfo = await exec(
        `cd "${path}" && git branch --show-current 2>/dev/null; echo "---"; git status --short 2>/dev/null | head -5`,
      );
      if (gitInfo) {
        const [branch, , ...statusLines] = gitInfo.split('\n');
        const cleanBranch = branch?.trim();
        const statusSummary = statusLines.filter(Boolean).join(', ');
        if (cleanBranch) {
          setProjectInfo((prev) => ({
            ...prev,
            gitBranch: cleanBranch,
            gitStatus: statusSummary || 'clean',
          }));
        }
      }

      const pkgInfo = await exec(
        `cat "${path}/package.json" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('name','')); print(d.get('version',''))" 2>/dev/null`,
      );
      if (pkgInfo) {
        const [name, version] = pkgInfo.split('\n');
        if (name) {
          setProjectInfo((prev) => ({
            ...prev,
            packageName: name,
            packageVersion: version,
          }));
        }
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingFiles(false);
    }
  }, [isConnected, exec]);

  const goBack = useCallback(() => {
    if (!currentPath) return;
    const parent = currentPath.replace(/\/[^/]+$/, '');
    if (parent && parent !== currentPath) {
      openProject(parent);
    } else {
      setCurrentPath(null);
      setFiles([]);
      setProjectInfo(null);
    }
  }, [currentPath, openProject]);

  const navigateToFile = useCallback((entry: FileEntry) => {
    if (entry.isDirectory && currentPath) {
      openProject(`${currentPath}/${entry.name}`);
    }
  }, [currentPath, openProject]);

  // ── Render ──────────────────────────────────────────────────────────────

  const renderProjectList = () => (
    <ScrollView
      style={styles.scrollView}
      contentContainerStyle={{ paddingBottom: 80 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); scanProjects(); }}
          tintColor={c.accent}
        />
      }
    >
      {!isConnected && (
        <View style={[styles.emptyBox, { borderColor: c.border }]}>
          <MaterialIcons name="link-off" size={32} color="#4B5563" />
          <Text style={styles.emptyText}>
            Termux Bridgeに接続するとプロジェクトフォルダを表示できます
          </Text>
        </View>
      )}

      {isLoading && (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="small" color={c.accent} />
          <Text style={styles.loadingText}>プロジェクトを走査中...</Text>
        </View>
      )}

      {isConnected && !isLoading && projectDirs.length > 0 && (
        <>
          <Text style={[styles.sectionLabel, { color: c.foreground }]}>
            Detected Projects ({projectDirs.length})
          </Text>
          {projectDirs.map((proj) => (
            <TouchableOpacity
              key={proj.path}
              style={[styles.projectCard, { backgroundColor: '#111318', borderColor: c.border }]}
              onPress={() => openProject(proj.path)}
              activeOpacity={0.7}
            >
              <View style={styles.projectIcon}>
                <MaterialIcons
                  name={proj.isGit ? 'source' : 'folder'}
                  size={24}
                  color={proj.isGit ? '#60A5FA' : '#FBBF24'}
                />
              </View>
              <View style={styles.projectInfo}>
                <Text style={styles.projectName}>{proj.name}</Text>
                <Text style={styles.projectPath}>{proj.path.replace(/^~\//, '')}</Text>
                <View style={styles.projectBadges}>
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
              <MaterialIcons name="chevron-right" size={20} color="#4B5563" />
            </TouchableOpacity>
          ))}
        </>
      )}

      {creatorProjects.length > 0 && (
        <>
          <Text style={[styles.sectionLabel, { color: c.foreground, marginTop: 20 }]}>
            Created Projects ({creatorProjects.length})
          </Text>
          {creatorProjects.slice(0, 10).map((proj) => (
            <TouchableOpacity
              key={proj.id}
              style={[styles.projectCard, { backgroundColor: '#111318', borderColor: c.border }]}
              onPress={() => {
                if (proj.path) openProject(proj.path);
              }}
              activeOpacity={0.7}
              disabled={!proj.path}
            >
              <View style={styles.projectIcon}>
                <MaterialIcons name="auto-awesome" size={24} color="#A78BFA" />
              </View>
              <View style={styles.projectInfo}>
                <Text style={styles.projectName}>{proj.name}</Text>
                <Text style={styles.projectPath}>{proj.userInput?.slice(0, 50)}</Text>
                <View style={styles.projectBadges}>
                  <View style={[styles.badge, { backgroundColor: '#A78BFA20' }]}>
                    <Text style={[styles.badgeText, { color: '#A78BFA' }]}>
                      {proj.status === 'done' ? 'complete' : proj.status}
                    </Text>
                  </View>
                </View>
              </View>
              {proj.path && (
                <MaterialIcons name="chevron-right" size={20} color="#4B5563" />
              )}
            </TouchableOpacity>
          ))}
        </>
      )}

      {isConnected && !isLoading && projectDirs.length === 0 && creatorProjects.length === 0 && (
        <View style={[styles.emptyBox, { borderColor: c.border }]}>
          <MaterialIcons name="create-new-folder" size={32} color="#4B5563" />
          <Text style={styles.emptyText}>
            プロジェクトが見つかりません{'\n'}
            ~/dev/ や ~/projects/ にフォルダを作成してください
          </Text>
        </View>
      )}
    </ScrollView>
  );

  const renderFileDetail = () => (
    <ScrollView style={styles.scrollView} contentContainerStyle={{ paddingBottom: 80 }}>
      <View style={styles.navBar}>
        <TouchableOpacity style={styles.backBtn} onPress={goBack}>
          <MaterialIcons name="arrow-back" size={20} color={c.accent} />
          <Text style={[styles.backText, { color: c.accent }]}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.currentPathText} numberOfLines={1}>
          {currentPath?.replace(/^\/data\/data\/com\.termux\/files\/home\//, '~/')}
        </Text>
      </View>

      {projectInfo && (
        <View style={[styles.infoBox, { borderColor: c.border }]}>
          {projectInfo.packageName && (
            <View style={styles.infoRow}>
              <MaterialIcons name="inventory-2" size={14} color="#34D399" />
              <Text style={styles.infoText}>
                {projectInfo.packageName}
                {projectInfo.packageVersion ? ` v${projectInfo.packageVersion}` : ''}
              </Text>
            </View>
          )}
          {projectInfo.gitBranch && (
            <View style={styles.infoRow}>
              <MaterialIcons name="source" size={14} color="#60A5FA" />
              <Text style={styles.infoText}>
                {projectInfo.gitBranch}
                {projectInfo.gitStatus && projectInfo.gitStatus !== 'clean'
                  ? ` (${projectInfo.gitStatus})`
                  : ' (clean)'}
              </Text>
            </View>
          )}
        </View>
      )}

      {isLoadingFiles ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="small" color={c.accent} />
        </View>
      ) : (
        files.map((file) => (
          <TouchableOpacity
            key={file.name}
            style={styles.fileRow}
            onPress={() => navigateToFile(file)}
            disabled={!file.isDirectory}
            activeOpacity={file.isDirectory ? 0.7 : 1}
          >
            <MaterialIcons
              name={file.isDirectory ? 'folder' : fileIcon(file.name)}
              size={18}
              color={file.isDirectory ? '#FBBF24' : '#6B7280'}
            />
            <Text style={[
              styles.fileName,
              file.isDirectory && styles.fileNameDir,
              !file.isDirectory && styles.fileNameFile,
            ]}>
              {file.name}
            </Text>
          </TouchableOpacity>
        ))
      )}
    </ScrollView>
  );

  return (
    <View style={[styles.container, { backgroundColor: c.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: c.border }]}>
        <Text style={[styles.headerTitle, { color: c.foreground }]}>Projects</Text>
        {isConnected && !currentPath && (
          <TouchableOpacity onPress={scanProjects} disabled={isLoading}>
            <MaterialIcons name="refresh" size={22} color={c.accent} />
          </TouchableOpacity>
        )}
      </View>

      {currentPath ? renderFileDetail() : renderProjectList()}
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fileIcon(name: string): 'code' | 'description' | 'image' | 'insert-drive-file' {
  if (/\.(ts|tsx|js|jsx|py|rb|go|rs|java|kt|swift|c|cpp|h)$/.test(name)) return 'code';
  if (/\.(md|txt|json|yml|yaml|toml|xml|csv)$/.test(name)) return 'description';
  if (/\.(png|jpg|jpeg|gif|svg|webp|ico)$/.test(name)) return 'image';
  return 'insert-drive-file';
}

// ─── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  scrollView: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: 'monospace',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  projectCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
  },
  projectIcon: {
    width: 40,
    height: 40,
    borderRadius: 8,
    backgroundColor: '#1F2937',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  projectInfo: { flex: 1 },
  projectName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#E5E7EB',
    fontFamily: 'monospace',
  },
  projectPath: {
    fontSize: 11,
    color: '#6B7280',
    fontFamily: 'monospace',
    marginTop: 2,
  },
  projectBadges: {
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
    fontSize: 10,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  emptyBox: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 12,
    marginTop: 20,
  },
  emptyText: {
    fontSize: 13,
    color: '#6B7280',
    fontFamily: 'monospace',
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 20,
  },
  loadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 20,
  },
  loadingText: {
    fontSize: 12,
    color: '#6B7280',
    fontFamily: 'monospace',
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 8,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  backText: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  currentPathText: {
    fontSize: 12,
    color: '#6B7280',
    fontFamily: 'monospace',
    flex: 1,
  },
  infoBox: {
    backgroundColor: '#111318',
    borderRadius: 8,
    borderWidth: 1,
    padding: 10,
    marginBottom: 12,
    gap: 6,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  infoText: {
    fontSize: 12,
    color: '#D1D5DB',
    fontFamily: 'monospace',
  },
  fileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: '#1F2937',
  },
  fileName: {
    fontSize: 13,
    fontFamily: 'monospace',
  },
  fileNameDir: {
    color: '#FBBF24',
    fontWeight: '600',
  },
  fileNameFile: {
    color: '#9CA3AF',
  },
});
