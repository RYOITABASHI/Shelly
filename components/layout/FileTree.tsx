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
    marginHorizontal: 8,
    marginBottom: 4,
    paddingHorizontal: 6,
    height: 24,
    gap: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1A1A1A',
  },
  search: {
    flex: 1,
    height: 24,
    fontSize: 10,
    fontFamily: 'monospace',
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
    fontSize: 11,
    fontFamily: 'monospace',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  fileName: {
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
    letterSpacing: 0.3,
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
