// components/layout/FileTree.tsx
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, FlatList, TextInput, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';
import { useSidebarStore } from '@/store/sidebar-store';
import { execCommand } from '@/hooks/use-native-exec';
import { openMarkdownFile } from '@/components/panes/MarkdownPane';
import { useTerminalStore } from '@/store/terminal-store';

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export function FileTree() {
  const theme = useTheme();
  const c = theme.colors;
  const repoPath = useSidebarStore((s) => s.activeRepoPath);
  const [cwd, setCwd] = useState(repoPath ?? '');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [search, setSearch] = useState('');

  const loadDir = useCallback(async (dir: string) => {
    try {
      const result = await execCommand(
        `ls -1pa "${dir}" 2>/dev/null | head -100`
      );
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      const parsed: FileEntry[] = lines
        .filter((l) => l !== './' && l !== '../')
        .map((l) => ({
          name: l.replace(/\/$/, ''),
          path: `${dir}/${l.replace(/\/$/, '')}`,
          isDirectory: l.endsWith('/'),
        }));
      setEntries(parsed);
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    if (repoPath) {
      setCwd(repoPath);
      loadDir(repoPath);
    }
  }, [repoPath, loadDir]);

  const filtered = search
    ? entries.filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))
    : entries;

  const handleTap = (entry: FileEntry) => {
    if (entry.isDirectory) {
      setCwd(entry.path);
      loadDir(entry.path);
    } else if (entry.name.endsWith('.md')) {
      openMarkdownFile(entry.path);
    } else {
      useTerminalStore.getState().runCommand(`cat '${entry.path.replace(/'/g, "'\\''")}'`);
    }
  };

  const handleGoUp = () => {
    const parent = cwd.replace(/\/[^/]+$/, '') || '/';
    setCwd(parent);
    loadDir(parent);
  };

  // Mock dummy file tree matching mock screenshot (shown when no repo selected)
  if (!repoPath) {
    const MOCK_TREE = [
      { name: 'APP', isDir: true, depth: 0 },
      { name: 'COMPONENTS', isDir: true, depth: 0 },
      { name: 'CHAT', isDir: true, depth: 1 },
      { name: 'TERMINAL', isDir: true, depth: 1 },
      { name: 'WELCOMEWIZARD.TSX', isDir: false, depth: 1 },
      { name: 'LIB', isDir: true, depth: 0 },
      { name: 'INPUT-ROUTER.TS', isDir: false, depth: 1 },
      { name: 'STORE', isDir: true, depth: 0 },
      { name: 'APP.CONFIG.TS', isDir: false, depth: 0 },
      { name: 'PACKAGE.JSON', isDir: false, depth: 0 },
      { name: 'README.MD', isDir: false, depth: 0, special: 'red' },
    ];
    return (
      <View style={styles.container}>
        <View style={styles.searchRow}>
          <MaterialIcons name="search" size={10} color="#6B7280" />
          <TextInput
            style={[styles.search, { color: c.foreground }]}
            placeholder="SEARCH FILES..."
            placeholderTextColor="#6B7280"
            editable={false}
          />
          <MaterialIcons name="edit" size={9} color="#6B7280" />
        </View>
        {MOCK_TREE.map((item, i) => (
          <View key={i} style={[styles.row, { paddingLeft: 8 + item.depth * 12 }]}>
            <MaterialIcons
              name={item.isDir ? 'folder' : 'insert-drive-file'}
              size={12}
              color={item.isDir ? '#4B5563' : '#3D4451'}
            />
            <Text style={[
              styles.fileName,
              { color: item.special === 'red' ? '#EF4444' : '#D1D5DB' },
            ]}>
              {item.name}
            </Text>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Search */}
      <View style={styles.searchRow}>
        <MaterialIcons name="search" size={12} color="#6B7280" />
        <TextInput
          style={[styles.search, { color: c.foreground }]}
          placeholder="SEARCH FILES..."
          placeholderTextColor="#6B7280"
          value={search}
          onChangeText={setSearch}
        />
        <MaterialIcons name="edit" size={11} color="#6B7280" />
      </View>

      {/* Breadcrumb */}
      {cwd !== repoPath && (
        <Pressable style={styles.breadcrumb} onPress={handleGoUp}>
          <MaterialIcons name="arrow-back" size={12} color={c.accent} />
          <Text style={[styles.breadcrumbText, { color: c.accent }]} numberOfLines={1}>
            ..
          </Text>
        </Pressable>
      )}

      {/* File list */}
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.path}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => handleTap(item)}>
            <MaterialIcons
              name={item.isDirectory ? 'folder' : 'insert-drive-file'}
              size={14}
              color={item.isDirectory ? '#6B7280' : '#4B5563'}
            />
            <Text
              style={[
                styles.fileName,
                {
                  color: item.name.toLowerCase() === 'readme.md'
                    ? '#EF4444'
                    : item.isDirectory
                    ? c.foreground
                    : c.foreground,
                },
              ]}
              numberOfLines={1}
            >
              {item.name}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    maxHeight: 300,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 6,
    marginBottom: 3,
    paddingHorizontal: 5,
    height: 20,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1A1A1A',
  },
  search: {
    flex: 1,
    height: 20,
    fontSize: 8,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '600',
    letterSpacing: 0.3,
    padding: 0,
  },
  breadcrumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  breadcrumbText: {
    fontSize: 8,
    fontFamily: 'GeistPixel-Square',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  fileName: {
    fontSize: 8,
    fontFamily: 'GeistPixel-Square',
    fontWeight: '600',
    letterSpacing: 0.3,
    color: '#D1D5DB',
    flex: 1,
  },
  empty: {
    padding: 10,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 8,
    fontFamily: 'GeistPixel-Square',
  },
});
