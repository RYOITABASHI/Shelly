// components/layout/FileTree.tsx
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, FlatList, TextInput, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/lib/theme-engine';
import { useSidebarStore } from '@/store/sidebar-store';
import { execCommand } from '@/hooks/use-native-exec';

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
    }
    // File taps will be handled in Plan 2 (open in Markdown pane or cat in terminal)
  };

  const handleGoUp = () => {
    const parent = cwd.replace(/\/[^/]+$/, '') || '/';
    setCwd(parent);
    loadDir(parent);
  };

  if (!repoPath) {
    return (
      <View style={styles.empty}>
        <Text style={[styles.emptyText, { color: c.muted }]}>
          Select a repository
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Search */}
      <TextInput
        style={[styles.search, { color: c.foreground, borderColor: c.border }]}
        placeholder="Search files..."
        placeholderTextColor={c.muted}
        value={search}
        onChangeText={setSearch}
      />

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
              color={item.isDirectory ? c.accent : c.muted}
            />
            <Text style={[styles.fileName, { color: c.foreground }]} numberOfLines={1}>
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
  search: {
    height: 28,
    marginHorizontal: 8,
    marginBottom: 4,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 8,
    fontSize: 11,
    fontFamily: 'monospace',
  },
  breadcrumb: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  breadcrumbText: {
    fontSize: 11,
    fontFamily: 'monospace',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  fileName: {
    fontSize: 11,
    fontFamily: 'monospace',
    flex: 1,
  },
  empty: {
    padding: 16,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 11,
    fontFamily: 'monospace',
  },
});
