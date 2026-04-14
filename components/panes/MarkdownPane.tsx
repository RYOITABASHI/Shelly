/**
 * components/panes/MarkdownPane.tsx — Rendered markdown viewer pane.
 *
 * - Renders markdown with dark theme using react-native-markdown-display
 * - "Edit" button shows toast directing user to vim in terminal
 * - Export openMarkdownFile(path) reads file via execCommand and sets content
 */
import React, { useState, useCallback, useContext } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ToastAndroid,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import Markdown from 'react-native-markdown-display';
import { useTheme } from '@/lib/theme-engine';
import { execCommand } from '@/hooks/use-native-exec';
import PaneInputBar from '@/components/panes/PaneInputBar';
import { MultiPaneContext } from '@/components/multi-pane/PaneSlot';
import { usePaneLayout } from '@/hooks/use-pane-density';

// ── Module-level state for imperative openMarkdownFile ────────────────────────

type SetContentFn = (content: string, filePath: string | null) => void;
let _setContent: SetContentFn | null = null;

/**
 * Opens a markdown file by path, reads it via execCommand, and renders it.
 * Can be called from outside React (e.g. file tree tap handlers).
 */
export async function openMarkdownFile(path: string): Promise<void> {
  if (!_setContent) return;
  try {
    const result = await execCommand(`cat '${path.replace(/'/g, "'\\''")}'`, 30_000);
    if (result.exitCode === 0) {
      _setContent(result.stdout ?? '', path);
    } else {
      _setContent(`*Error reading file:* \`${result.stderr ?? 'unknown error'}\``, path);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    _setContent(`*Failed to read file:* \`${msg}\``, path);
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MarkdownPane() {
  const theme = useTheme();
  const [content, setContent] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Bug #56 — density scaling for grid layouts. Scale the markdown
  // typography down when the pane drops below ~420dp so headings and
  // prose reflow instead of overflowing.
  const mp = useContext(MultiPaneContext);
  const pw = mp?.paneWidth ?? 0;
  const ph = mp?.paneHeight ?? 0;
  const mdScale = pw > 0 && pw < 260 ? 0.65
                : pw > 0 && pw < 360 ? 0.78
                : pw > 0 && pw < 480 ? 0.9
                : 1;
  const sf = (n: number) => Math.max(9, Math.round(n * mdScale));
  // Wave F — cap prose width so long paragraphs reflow inside the pane
  // instead of being pushed out by the right-hand chrome. We subtract a
  // conservative padding budget (16 from scrollContent + 6 safety).
  const layout = usePaneLayout(pw, ph);
  const proseMaxWidth = Math.max(pw - 44, 200);
  // When the pane drops to compact density, halve the bullet indent so
  // list items don't wrap on every word.
  const listIndent = layout.density === 'compact' ? 8 : 16;

  // Register setter so openMarkdownFile can push content in
  const stableSetContent = useCallback<SetContentFn>((c, fp) => {
    setContent(c);
    setFilePath(fp);
    setLoading(false);
  }, []);

  React.useEffect(() => {
    _setContent = stableSetContent;
    return () => {
      if (_setContent === stableSetContent) _setContent = null;
    };
  }, [stableSetContent]);

  const handleEdit = useCallback(() => {
    ToastAndroid.show('Edit with vim in terminal', ToastAndroid.SHORT);
  }, []);

  const handleSearch = useCallback((_text: string) => {
    // Future: search within document
    ToastAndroid.show('Search within document — coming soon', ToastAndroid.SHORT);
  }, []);

  // ── Markdown style rules keyed to current theme ──────────────────────────
  const markdownStyles = StyleSheet.create({
    body: {
      backgroundColor: '#0A0A0A',
      color: theme.colors.foreground,
      fontSize: sf(14),
      lineHeight: sf(22),
      maxWidth: proseMaxWidth,
    },
    heading1: {
      color: theme.colors.accent,
      fontSize: sf(24),
      fontWeight: '700',
      marginTop: 16,
      marginBottom: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.colors.border,
      paddingBottom: 4,
    },
    heading2: {
      color: theme.colors.accent,
      fontSize: sf(20),
      fontWeight: '700',
      marginTop: 14,
      marginBottom: 6,
    },
    heading3: {
      color: theme.colors.accent,
      fontSize: sf(17),
      fontWeight: '600',
      marginTop: 12,
      marginBottom: 4,
    },
    heading4: {
      color: theme.colors.accent,
      fontSize: sf(15),
      fontWeight: '600',
      marginTop: 10,
      marginBottom: 4,
    },
    heading5: {
      color: theme.colors.accent,
      fontSize: sf(14),
      fontWeight: '600',
      marginTop: 8,
      marginBottom: 2,
    },
    heading6: {
      color: theme.colors.accent,
      fontSize: sf(13),
      fontWeight: '600',
      marginTop: 8,
      marginBottom: 2,
    },
    paragraph: {
      color: '#ECEDEE',
      fontSize: sf(14),
      lineHeight: sf(22),
      marginVertical: 6,
      maxWidth: proseMaxWidth,
    },
    code_inline: {
      backgroundColor: '#1A1A1A',
      color: theme.colors.ansiCyan,
      fontSize: sf(13),
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 3,
    },
    fence: {
      backgroundColor: '#1A1A1A',
      borderRadius: 6,
      padding: 12,
      marginVertical: 8,
    },
    code_block: {
      backgroundColor: '#1A1A1A',
      color: '#ECEDEE',
      fontSize: sf(13),
      lineHeight: sf(20),
      padding: 12,
      borderRadius: 6,
      marginVertical: 8,
    },
    link: {
      color: theme.colors.accent,
      textDecorationLine: 'underline',
    },
    blockquote: {
      backgroundColor: '#111111',
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.accent,
      paddingLeft: 12,
      paddingVertical: 4,
      marginVertical: 8,
    },
    list_item: {
      color: '#ECEDEE',
      fontSize: sf(14),
      lineHeight: sf(22),
      maxWidth: proseMaxWidth,
      paddingLeft: listIndent,
    },
    bullet_list_icon: {
      color: theme.colors.accent,
    },
    ordered_list_icon: {
      color: theme.colors.accent,
    },
    hr: {
      backgroundColor: theme.colors.border,
      height: 1,
      marginVertical: 12,
    },
    table: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      marginVertical: 8,
    },
    th: {
      backgroundColor: '#1A1A1A',
      color: theme.colors.accent,
      fontWeight: '700',
      padding: 8,
    },
    td: {
      color: '#ECEDEE',
      padding: 8,
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    strong: {
      color: '#FFFFFF',
      fontWeight: '700',
    },
    em: {
      color: '#ECEDEE',
      fontStyle: 'italic',
    },
  });

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      {/* Header bar */}
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <Text style={[styles.headerTitle, { color: theme.colors.muted }]} numberOfLines={1}>
          {filePath ? filePath.split('/').pop() : 'Markdown'}
        </Text>
        {content !== null && (
          <TouchableOpacity
            onPress={handleEdit}
            style={[styles.editButton, { borderColor: theme.colors.border }]}
            accessibilityLabel="Edit file"
          >
            <Text style={[styles.editButtonText, { color: theme.colors.accent }]}>Edit</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Content area */}
      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : content === null ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>Open a .md file from the sidebar</Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={true}
        >
          <Markdown style={markdownStyles}>{content}</Markdown>
        </ScrollView>
      )}

      {/* Bottom search bar */}
      <PaneInputBar
        placeholder="Search in document..."
        onSubmit={handleSearch}
      />
    </View>
  );
}

// ── Static styles ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderBottomWidth: 1,
    minHeight: 44,
  },
  headerTitle: {
    flex: 1,
    fontSize: 13,
  },
  editButton: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginLeft: 8,
  },
  editButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    color: '#555',
    fontSize: 14,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
  },
});
