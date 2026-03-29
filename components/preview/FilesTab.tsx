import React, { memo, useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTheme } from '@/hooks/use-theme';
import { withAlpha } from '@/lib/theme-utils';
import { usePreviewStore } from '@/store/preview-store';
import { useTermuxBridge } from '@/hooks/use-termux-bridge';
import {
  shellEscape, detectFileType, detectLanguage, formatFileSize,
  MAX_PREVIEW_SIZE, type FileEntry, type PreviewFileType,
} from '@/lib/preview-file-detector';
// Renderers
import { CodeRenderer } from '@/components/preview/renderers/CodeRenderer';
import { MarkdownRenderer } from '@/components/preview/renderers/MarkdownRenderer';
import { ImageRenderer } from '@/components/preview/renderers/ImageRenderer';
import { JsonTreeRenderer } from '@/components/preview/renderers/JsonTreeRenderer';
import { CsvTableRenderer } from '@/components/preview/renderers/CsvTableRenderer';
import { PdfRenderer } from '@/components/preview/renderers/PdfRenderer';
import { PlainTextRenderer } from '@/components/preview/renderers/PlainTextRenderer';
import { HtmlRenderer } from '@/components/preview/renderers/HtmlRenderer';

export const FilesTab = memo(function FilesTab() {
  const { colors } = useTheme();
  const currentDir = usePreviewStore((s) => s.currentDir);
  const setCurrentDir = usePreviewStore((s) => s.setCurrentDir);
  const { runRawCommand } = useTermuxBridge();

  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(false);

  // Scan directory
  const scanDir = useCallback(async (dir: string) => {
    setLoading(true);
    try {
      const result = await runRawCommand(
        `find ${shellEscape(dir)} -maxdepth 1 -not -name '.' -exec stat -c '%n\t%s\t%F' {} \\;`,
      );
      const entries: FileEntry[] = (result.stdout || '').split('\n').filter(Boolean).map((line) => {
        const [fullPath, sizeStr, typeStr] = line.split('\t');
        const name = fullPath.split('/').pop() || fullPath;
        const isDir = typeStr?.includes('directory') ?? false;
        return {
          name,
          path: fullPath,
          isDirectory: isDir,
          size: parseInt(sizeStr || '0', 10),
          type: isDir ? 'plaintext' as PreviewFileType : detectFileType(name),
        };
      }).sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      }).filter((f) => !f.name.startsWith('.') || f.name === '.gitignore');
      setFiles(entries);
    } catch {
      setFiles([]);
    }
    setLoading(false);
  }, [runRawCommand]);

  // Init: get cwd if not set
  useEffect(() => {
    (async () => {
      let dir = currentDir;
      if (!dir) {
        try {
          const r = await runRawCommand('pwd');
          dir = r.stdout?.trim() || '/data/data/com.termux/files/home';
          setCurrentDir(dir);
        } catch {
          dir = '/data/data/com.termux/files/home';
          setCurrentDir(dir);
        }
      }
      scanDir(dir);
    })();
  }, [currentDir, scanDir, setCurrentDir, runRawCommand]);

  // Open file
  const openFile = useCallback(async (entry: FileEntry) => {
    if (entry.isDirectory) {
      setCurrentDir(entry.path);
      setSelectedFile(null);
      return;
    }
    setSelectedFile(entry);
    if (entry.type === 'image') {
      setFileLoading(true);
      try {
        const r = await runRawCommand(`base64 ${shellEscape(entry.path)}`);
        const ext = entry.name.split('.').pop()?.toLowerCase() || 'png';
        const mime = ext === 'svg' ? 'svg+xml' : ext;
        setFileContent(`data:image/${mime};base64,${r.stdout?.replace(/\s/g, '') || ''}`);
      } catch { setFileContent(''); }
      setFileLoading(false);
      return;
    }
    if (entry.type === 'pdf') return; // PdfRenderer handles its own display
    // Text-based files
    setFileLoading(true);
    try {
      const cmd = entry.size > MAX_PREVIEW_SIZE
        ? `head -n 1000 ${shellEscape(entry.path)}`
        : `cat ${shellEscape(entry.path)}`;
      const r = await runRawCommand(cmd);
      setFileContent(r.stdout || '');
    } catch { setFileContent('// Error reading file'); }
    setFileLoading(false);
  }, [runRawCommand, setCurrentDir]);

  // Back button
  const goBack = useCallback(() => {
    if (selectedFile) { setSelectedFile(null); return; }
    const parent = currentDir.split('/').slice(0, -1).join('/') || '/';
    setCurrentDir(parent);
  }, [selectedFile, currentDir, setCurrentDir]);

  // --- File Preview ---
  if (selectedFile) {
    if (fileLoading) {
      return <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>;
    }
    return (
      <View style={styles.container}>
        <TouchableOpacity style={styles.backRow} onPress={goBack}>
          <MaterialIcons name="arrow-back" size={16} color={colors.accent} />
          <Text style={[styles.backText, { color: colors.accent }]}>{selectedFile.name}</Text>
        </TouchableOpacity>
        {renderFileContent(selectedFile, fileContent, colors)}
      </View>
    );
  }

  // --- File Tree ---
  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.backRow} onPress={goBack}>
        <MaterialIcons name="arrow-back" size={14} color={colors.muted} />
        <Text style={[styles.breadcrumb, { color: colors.muted }]} numberOfLines={1}>{currentDir}</Text>
      </TouchableOpacity>
      {loading ? (
        <View style={styles.center}><ActivityIndicator color={colors.accent} /></View>
      ) : (
        <FlatList
          data={files}
          keyExtractor={(item) => item.path}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.fileRow} onPress={() => openFile(item)} activeOpacity={0.7}>
              <MaterialIcons
                name={item.isDirectory ? 'folder' : 'insert-drive-file'}
                size={16}
                color={item.isDirectory ? '#F59E0B' : colors.muted}
              />
              <Text style={[styles.fileName, { color: colors.foreground }]} numberOfLines={1}>{item.name}</Text>
              {!item.isDirectory && (
                <Text style={[styles.fileSize, { color: colors.muted }]}>{formatFileSize(item.size)}</Text>
              )}
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
});

// --- Renderer Router ----------------------------------------------------------------

function renderFileContent(file: FileEntry, content: string, colors: any) {
  switch (file.type) {
    case 'html':      return <HtmlRenderer html={content} />;
    case 'markdown':  return <MarkdownRenderer content={content} />;
    case 'image':     return <ImageRenderer uri={content} filename={file.name} />;
    case 'code':      return <CodeRenderer content={content} language={detectLanguage(file.name)} />;
    case 'json':      return <JsonTreeRenderer content={content} />;
    case 'csv':       return <CsvTableRenderer content={content} delimiter={file.name.endsWith('.tsv') ? '\t' : ','} />;
    case 'pdf':       return <PdfRenderer filePath={file.path} />;
    default:          return <PlainTextRenderer content={content} />;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  backRow: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, borderBottomWidth: 1, borderBottomColor: '#222' },
  backText: { fontFamily: 'monospace', fontSize: 12, fontWeight: '600' },
  breadcrumb: { fontFamily: 'monospace', fontSize: 10, flex: 1 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#111' },
  fileName: { fontFamily: 'monospace', fontSize: 12, flex: 1 },
  fileSize: { fontFamily: 'monospace', fontSize: 10 },
});
