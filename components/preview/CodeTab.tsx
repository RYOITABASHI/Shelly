import React, { memo, useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, ToastAndroid } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { usePreviewStore } from '@/store/preview-store';
import { useNativeExec } from '@/hooks/use-native-exec';
import { CodeRenderer } from '@/components/preview/renderers/CodeRenderer';
import { detectLanguage, shellEscape, MAX_PREVIEW_SIZE } from '@/lib/preview-file-detector';
import { stageAiEdit } from '@/lib/ai-edit';

export const CodeTab = memo(function CodeTab() {
  const { colors } = useTheme();
  const recentFiles = usePreviewStore((s) => s.recentFiles);
  const activeFile = usePreviewStore((s) => s.activeCodeFile);
  const setActiveFile = usePreviewStore((s) => s.setActiveCodeFile);
  const { runRawCommand: nativeRun } = useNativeExec();
  const runRawCommand = useCallback(async (cmd: string): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> => {
    const result = await nativeRun(cmd);
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
  }, [nativeRun]);

  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [showDiff, setShowDiff] = useState(false);

  // Load file content
  const loadFile = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const sizeResult = await runRawCommand(`stat -c %s ${shellEscape(path)} 2>/dev/null`);
      const size = parseInt(sizeResult.stdout?.trim() || '0', 10);
      const cmd = size > MAX_PREVIEW_SIZE
        ? `head -n 1000 ${shellEscape(path)}`
        : `cat ${shellEscape(path)}`;
      const result = await runRawCommand(cmd);
      setContent(result.stdout || '');
    } catch {
      setContent('// Error loading file');
    }
    setLoading(false);
  }, [runRawCommand]);

  // Load diff
  const loadDiff = useCallback(async (path: string) => {
    setLoading(true);
    try {
      const result = await runRawCommand(`git diff ${shellEscape(path)} 2>/dev/null`);
      setContent(result.stdout || '// No diff available');
    } catch {
      setContent('// git diff failed');
    }
    setLoading(false);
  }, [runRawCommand]);

  // Refresh git file list on mount
  useEffect(() => {
    (async () => {
      try {
        const result = await runRawCommand(
          `cd $(pwd) && { git diff --name-only HEAD 2>/dev/null; git diff --name-only 2>/dev/null; } | sort -u`
        );
        const paths = (result.stdout || '').split('\n').filter(Boolean);
        const store = usePreviewStore.getState();
        for (const p of paths) {
          if (!store.recentFiles.some((f) => f.path === p)) {
            store.notifyFileChange(p);
          }
        }
      } catch {}
    })();
  }, [runRawCommand]);

  // Load active file
  useEffect(() => {
    if (!activeFile) return;
    if (showDiff) loadDiff(activeFile);
    else loadFile(activeFile);
  }, [activeFile, showDiff, loadFile, loadDiff]);

  if (recentFiles.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <MaterialIcons name="code" size={32} color={colors.muted} />
        <Text style={[styles.emptyText, { color: colors.muted }]}>No recent changes</Text>
      </View>
    );
  }

  const language = activeFile ? detectLanguage(activeFile) : 'text';

  return (
    <View style={styles.container}>
      {/* File selector + diff toggle + AI edit */}
      <View style={[styles.toolbar, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={[styles.fileChip, { backgroundColor: withAlpha(colors.accent, 0.1) }]}
          activeOpacity={0.7}
        >
          <Text style={[styles.filePath, { color: colors.accent }]} numberOfLines={1}>
            {activeFile || 'Select file'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleBtn, showDiff && { backgroundColor: withAlpha(colors.accent, 0.15) }]}
          onPress={() => setShowDiff(!showDiff)}
          activeOpacity={0.7}
        >
          <Text style={[styles.toggleText, { color: showDiff ? colors.accent : colors.muted }]}>
            {showDiff ? 'Diff' : 'Full'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleBtn, { backgroundColor: withAlpha(colors.accent, 0.2) }]}
          disabled={!activeFile}
          onPress={async () => {
            if (!activeFile) return;
            try {
              const ok = await stageAiEdit(activeFile);
              if (!ok) {
                ToastAndroid.show('Open an AI pane first', ToastAndroid.SHORT);
              } else {
                ToastAndroid.show('Staged for AI — type in AI pane', ToastAndroid.SHORT);
              }
            } catch (err) {
              ToastAndroid.show(
                err instanceof Error ? err.message : 'Stage failed',
                ToastAndroid.LONG,
              );
            }
          }}
          activeOpacity={0.7}
        >
          <MaterialIcons name="auto-awesome" size={12} color={colors.accent} />
          <Text style={[styles.toggleText, { color: colors.accent, marginLeft: 3 }]}>
            AI
          </Text>
        </TouchableOpacity>
      </View>

      {/* File list (horizontal scroll) */}
      {recentFiles.length > 1 && (
        <View style={styles.fileList}>
          {recentFiles.slice(0, 10).map((f) => (
            <TouchableOpacity
              key={f.path}
              style={[styles.fileTab, f.path === activeFile && { borderBottomColor: colors.accent, borderBottomWidth: 2 }]}
              onPress={() => setActiveFile(f.path)}
              activeOpacity={0.7}
            >
              <Text style={[styles.fileTabText, { color: f.path === activeFile ? colors.foreground : colors.muted }]} numberOfLines={1}>
                {f.path.split('/').pop()}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {/* Content */}
      {loading ? (
        <View style={styles.emptyContainer}>
          <ActivityIndicator size="small" color={colors.accent} />
        </View>
      ) : (
        <CodeRenderer content={content} language={language} />
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderBottomWidth: 1, gap: 8 },
  fileChip: { flex: 1, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  filePath: { fontFamily: 'monospace', fontSize: 11 },
  toggleBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  toggleText: { fontFamily: 'monospace', fontSize: 11, fontWeight: '600' },
  fileList: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#222' },
  fileTab: { paddingHorizontal: 10, paddingVertical: 6 },
  fileTabText: { fontFamily: 'monospace', fontSize: 10 },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8 },
  emptyText: { fontFamily: 'monospace', fontSize: 13 },
});
