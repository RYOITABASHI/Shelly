// components/layout/FileTree.tsx
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, FlatList, TextInput, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSidebarStore } from '@/store/sidebar-store';
import { execCommand } from '@/hooks/use-native-exec';
import { openMarkdownFile } from '@/components/panes/MarkdownPane';
import { useTerminalStore } from '@/store/terminal-store';
import { colors as C, fonts as F, sizes as S, padding as P, icons as I } from '@/theme.config';

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

export function FileTree() {
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
          <MaterialIcons name="search" size={10} color={C.text2} />
          <TextInput
            style={styles.search}
            placeholder="SEARCH FILES..."
            placeholderTextColor={C.text2}
            editable={false}
          />
          <MaterialIcons name="edit" size={9} color={C.text2} />
        </View>
        {MOCK_TREE.map((item, i) => (
          <View key={i} style={[styles.row, { paddingLeft: 8 + item.depth * 12 }]}>
            <MaterialIcons
              name={item.isDir ? 'folder' : 'insert-drive-file'}
              size={I.fileIcon}
              color={item.isDir ? C.text3 : C.text3}
            />
            <Text style={[
              styles.fileName,
              { color: item.special === 'red' ? C.errorText : C.text1 },
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
        <MaterialIcons name="search" size={I.fileIcon} color={C.text2} />
        <TextInput
          style={styles.search}
          placeholder="SEARCH FILES..."
          placeholderTextColor={C.text2}
          value={search}
          onChangeText={setSearch}
        />
        <MaterialIcons name="edit" size={11} color={C.text2} />
      </View>

      {/* Breadcrumb */}
      {cwd !== repoPath && (
        <Pressable style={styles.breadcrumb} onPress={handleGoUp}>
          <MaterialIcons name="arrow-back" size={I.fileIcon} color={C.accent} />
          <Text style={[styles.breadcrumbText, { color: C.accent }]} numberOfLines={1}>
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
              size={I.fileIcon}
              color={item.isDirectory ? C.text2 : C.text3}
            />
            <Text
              style={[
                styles.fileName,
                {
                  color: item.name.toLowerCase() === 'readme.md'
                    ? C.errorText
                    : C.text1,
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
    borderBottomWidth: S.borderWidth,
    borderBottomColor: C.border,
  },
  search: {
    flex: 1,
    height: 20,
    fontSize: F.fileName.size,
    fontFamily: F.family,
    fontWeight: F.fileName.weight,
    letterSpacing: 0.3,
    padding: 0,
    color: C.text1,
  },
  breadcrumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: P.sidebarItem.py,
  },
  breadcrumbText: {
    fontSize: F.fileName.size,
    fontFamily: F.family,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    height: S.sidebarItemHeight,
  },
  fileName: {
    fontSize: F.fileName.size,
    fontFamily: F.family,
    fontWeight: F.fileName.weight,
    letterSpacing: 0.3,
    color: C.text1,
    flex: 1,
  },
});
