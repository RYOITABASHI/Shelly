// components/layout/FileTree.tsx
import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, FlatList, TextInput, StyleSheet, Alert, ToastAndroid } from 'react-native';
import { ShellyModal } from '@/components/layout/ShellyModal';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Clipboard from 'expo-clipboard';
import { useSidebarStore } from '@/store/sidebar-store';
import { execCommand } from '@/hooks/use-native-exec';
import { readDirEntries } from '@/lib/fs-native';
import { openFile } from '@/lib/open-file';
import { normalizePath } from '@/lib/normalize-path';
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

// Shell-quote a path so spaces and special chars survive execCommand.
function sq(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

export function FileTree() {
  // bug #43: defensively normalize any stale `~/` from a pre-fix persisted store.
  const rawRepoPath = useSidebarStore((s) => s.activeRepoPath);
  const repoPath = rawRepoPath ? normalizePath(rawRepoPath) : rawRepoPath;
  const [cwd, setCwd] = useState(repoPath ?? '');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [search, setSearch] = useState('');
  // Create-file prompt state (RN has no Alert.prompt on Android so we
  // roll a minimal one-field modal)
  const [createMode, setCreateMode] = useState<null | 'file' | 'dir'>(null);
  const [createName, setCreateName] = useState('');
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameName, setRenameName] = useState('');

  // Bug #70: use in-process readDir (JNI opendir/readdir/lstat) instead of
  // shelling out to `ls -1pa ... | head -100`. The shell path returns
  // exit=0 stdout=0chars on some devices and silently blanks the FILE TREE.
  const loadDir = useCallback(async (dir: string) => {
    try {
      const items = await readDirEntries(dir);
      items.sort((a, b) => {
        const ad = a.type === 'd' ? 0 : 1;
        const bd = b.type === 'd' ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      });
      const parsed: FileEntry[] = items.slice(0, 500).map((e) => ({
        name: e.name,
        path: `${dir}/${e.name}`,
        isDirectory: e.type === 'd',
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

  // ── Context menu actions ──────────────────────────────────────────
  const handleLongPress = useCallback((entry: FileEntry) => {
    Alert.alert(
      entry.name,
      entry.isDirectory ? 'Directory' : 'File',
      [
        {
          text: 'Rename',
          onPress: () => {
            setRenameTarget(entry);
            setRenameName(entry.name);
          },
        },
        {
          text: 'Copy path',
          onPress: async () => {
            await Clipboard.setStringAsync(entry.path);
            ToastAndroid.show('Path copied', ToastAndroid.SHORT);
          },
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            Alert.alert('Delete ' + entry.name + '?', 'This cannot be undone.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete',
                style: 'destructive',
                onPress: async () => {
                  const cmd = entry.isDirectory
                    ? `rm -rf ${sq(entry.path)}`
                    : `rm ${sq(entry.path)}`;
                  const r = await execCommand(cmd, 10_000);
                  if (r.exitCode === 0) {
                    ToastAndroid.show('Deleted', ToastAndroid.SHORT);
                    loadDir(cwd);
                  } else {
                    ToastAndroid.show('rm failed: ' + (r.stderr || '').trim(), ToastAndroid.LONG);
                  }
                },
              },
            ]);
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ],
      { cancelable: true },
    );
  }, [cwd, loadDir]);

  const performCreate = useCallback(async () => {
    const name = createName.trim();
    if (!name || !createMode) return;
    const target = `${cwd}/${name}`;
    const cmd = createMode === 'dir' ? `mkdir -p ${sq(target)}` : `touch ${sq(target)}`;
    const r = await execCommand(cmd, 10_000);
    if (r.exitCode === 0) {
      ToastAndroid.show(createMode === 'dir' ? 'Folder created' : 'File created', ToastAndroid.SHORT);
      setCreateMode(null);
      setCreateName('');
      loadDir(cwd);
    } else {
      ToastAndroid.show('create failed: ' + (r.stderr || '').trim(), ToastAndroid.LONG);
    }
  }, [createMode, createName, cwd, loadDir]);

  const performRename = useCallback(async () => {
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name || name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    const parent = renameTarget.path.replace(/\/[^/]+$/, '');
    const newPath = `${parent}/${name}`;
    const r = await execCommand(`mv ${sq(renameTarget.path)} ${sq(newPath)}`, 10_000);
    if (r.exitCode === 0) {
      ToastAndroid.show('Renamed', ToastAndroid.SHORT);
      setRenameTarget(null);
      loadDir(cwd);
    } else {
      ToastAndroid.show('mv failed: ' + (r.stderr || '').trim(), ToastAndroid.LONG);
    }
  }, [renameTarget, renameName, cwd, loadDir]);

  // No repo bound — prompt the user to pick one. The Sidebar's REPOSITORIES
  // section has the + ADD REPOSITORY affordance; just hint toward it.
  if (!repoPath) {
    return (
      <View style={styles.container}>
        <Text style={styles.emptyHint}>Add a repository above to browse files.</Text>
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
        <Pressable onPress={() => { setCreateMode('file'); setCreateName(''); }} hitSlop={6}>
          <MaterialIcons name="note-add" size={11} color={C.text2} />
        </Pressable>
        <Pressable onPress={() => { setCreateMode('dir'); setCreateName(''); }} hitSlop={6}>
          <MaterialIcons name="create-new-folder" size={11} color={C.text2} />
        </Pressable>
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
          <Pressable
            style={styles.row}
            onPress={() => handleTap(item)}
            onLongPress={() => handleLongPress(item)}
            delayLongPress={350}
          >
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

      {/* Create file/folder prompt */}
      <ShellyModal visible={createMode !== null} transparent animationType="fade" onRequestClose={() => setCreateMode(null)}>
        <Pressable style={promptStyles.backdrop} onPress={() => setCreateMode(null)}>
          <Pressable style={promptStyles.card} onPress={(e) => e.stopPropagation()}>
            <Text style={promptStyles.title}>
              {createMode === 'dir' ? 'New Folder' : 'New File'}
            </Text>
            <TextInput
              style={promptStyles.input}
              placeholder={createMode === 'dir' ? 'folder name' : 'file.ext'}
              placeholderTextColor={C.text3}
              value={createName}
              onChangeText={setCreateName}
              autoFocus
              onSubmitEditing={performCreate}
            />
            <View style={promptStyles.actions}>
              <Pressable onPress={() => setCreateMode(null)} style={promptStyles.btn}>
                <Text style={promptStyles.btnText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={performCreate} style={[promptStyles.btn, promptStyles.btnPrimary]}>
                <Text style={[promptStyles.btnText, promptStyles.btnPrimaryText]}>Create</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </ShellyModal>

      {/* Rename prompt */}
      <ShellyModal visible={renameTarget !== null} transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}>
        <Pressable style={promptStyles.backdrop} onPress={() => setRenameTarget(null)}>
          <Pressable style={promptStyles.card} onPress={(e) => e.stopPropagation()}>
            <Text style={promptStyles.title}>Rename</Text>
            <TextInput
              style={promptStyles.input}
              value={renameName}
              onChangeText={setRenameName}
              autoFocus
              onSubmitEditing={performRename}
            />
            <View style={promptStyles.actions}>
              <Pressable onPress={() => setRenameTarget(null)} style={promptStyles.btn}>
                <Text style={promptStyles.btnText}>Cancel</Text>
              </Pressable>
              <Pressable onPress={performRename} style={[promptStyles.btn, promptStyles.btnPrimary]}>
                <Text style={[promptStyles.btnText, promptStyles.btnPrimaryText]}>Rename</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </ShellyModal>
    </View>
  );
}

const promptStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    width: 260,
    backgroundColor: C.bgSurface,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 6,
    padding: 12,
    gap: 10,
  },
  title: {
    fontFamily: F.family,
    fontSize: 10,
    fontWeight: '700',
    color: C.accent,
    letterSpacing: 0.5,
  },
  input: {
    fontFamily: F.family,
    fontSize: 11,
    color: C.text1,
    backgroundColor: C.bgDeep,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  btn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: C.border,
  },
  btnPrimary: {
    backgroundColor: C.accent,
    borderColor: C.accent,
  },
  btnText: {
    fontFamily: F.family,
    fontSize: 10,
    fontWeight: '700',
    color: C.text2,
  },
  btnPrimaryText: {
    color: C.bgDeep,
  },
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 120,
  },
  emptyHint: {
    fontFamily: F.family,
    fontSize: F.fileName.size,
    color: C.text3,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 10,
    letterSpacing: 0.3,
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
