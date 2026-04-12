// components/layout/FileTree.tsx
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, FlatList, TextInput, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSidebarStore } from '@/store/sidebar-store';
import { execCommand } from '@/hooks/use-native-exec';
import { openFile } from '@/lib/open-file';
import { colors as C, fonts as F, sizes as S, padding as P, icons as I } from '@/theme.config';

type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
};

/**
 * Per-extension color palette. Matches the mock's colored file icons where
 * .tsx / .ts / .json / .md / .py / README each read as a different hue. Keeps
 * the default blue for unknown extensions and directories.
 */
function fileIconColor(name: string, isDir: boolean): string {
  if (isDir) return C.accentBlue;
  const lower = name.toLowerCase();
  if (lower === 'readme.md' || lower === 'readme') return C.errorText;
  const dot = lower.lastIndexOf('.');
  const ext = dot === -1 ? '' : lower.slice(dot + 1);
  switch (ext) {
    case 'tsx':
    case 'jsx':       return C.accentSky;       // React: sky
    case 'ts':        return C.accentBlue;      // TypeScript: blue
    case 'js':
    case 'mjs':
    case 'cjs':       return C.accentAmber;     // JavaScript: amber
    case 'json':
    case 'toml':
    case 'yaml':
    case 'yml':       return C.accentAmber;     // config: amber
    case 'md':
    case 'mdx':       return C.accentPurple;    // markdown: purple
    case 'py':        return C.accentGreen;     // python: green
    case 'go':        return C.accentSky;
    case 'rs':        return C.errorText;       // rust: red
    case 'sh':
    case 'bash':
    case 'zsh':       return C.accentGreen;
    case 'css':
    case 'scss':      return C.accentPink;
    case 'html':      return C.accentAmber;
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':      return C.accentPink;
    default:          return C.accentBlue;
  }
}

function fileNameColor(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'readme.md' || lower === 'readme') return C.errorText;
  return C.text1;
}

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
    } else {
      openFile(entry.path).catch(() => {});
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
              color={fileIconColor(item.name, item.isDir)}
            />
            <Text
              style={[styles.fileName, { color: fileNameColor(item.name) }]}
            >
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
              color={fileIconColor(item.name, item.isDirectory)}
            />
            <Text
              style={[styles.fileName, { color: fileNameColor(item.name) }]}
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
    height: 18,
    gap: 4,
    borderBottomWidth: S.borderWidth,
    borderBottomColor: C.border,
  },
  search: {
    flex: 1,
    height: 18,
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
