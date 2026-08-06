/**
 * components/panes/MemoryWorkbenchPane.tsx — Memory Workbench pane.
 *
 * Browse / search / edit / delete an agent's saved memory notes, plus the
 * shared GLOBAL_MEMORY_SCOPE (_global) notes every agent recalls. The two
 * groups are rendered as separate sections and never merged: an agent's own
 * facts and the user's standing shared preferences are different things.
 *
 * Reads mirror Sidebar.tsx's production fallback exactly: with MEMORY_ENABLED,
 * activateMemoryList (the live MEMORY-001 strangler store) is the primary
 * path, falling back to G2's readMemoryNotes only when it returns null
 * (internal failure). Writes (delete/edit) go through lib/memory/shadow.ts's
 * deleteMemoryNoteById / updateMemoryNoteById — never directly to files.
 *
 * The target agent flows through agent-store's memoryWorkbenchAgentId,
 * set by the Sidebar agent detail popup's Memory button.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import {
  GLOBAL_MEMORY_SCOPE,
  readMemoryNotes,
  type MemoryNote,
} from '@/lib/agent-memory';
import { MEMORY_ENABLED } from '@/lib/memory/wiring';
import {
  activateMemoryList,
  deleteMemoryNoteById,
  updateMemoryNoteById,
} from '@/lib/memory/shadow';
import { filterMemoryNotes, parseTagsInput } from '@/lib/memory-workbench';
import { useAgentStore } from '@/store/agent-store';
import { useTranslation } from '@/lib/i18n';
import { useTheme } from '@/hooks/use-theme';
import type { ThemeColorPalette } from '@/lib/theme';
import { usePaneContentBackground, usePanelBackground } from '@/hooks/use-panel-background';
import { withAlpha } from '@/lib/theme-utils';

// Same fallback shape as Sidebar.tsx's showAgentDetail memory read: activated
// list first, G2 only when the store reports an internal failure (null).
async function listNotesWithFallback(agentId: string): Promise<MemoryNote[]> {
  try {
    if (MEMORY_ENABLED) {
      const activated = await activateMemoryList(agentId);
      return activated ?? (await readMemoryNotes(agentId));
    }
    return await readMemoryNotes(agentId);
  } catch {
    return [];
  }
}

type EditState = {
  scopeAgentId: string;
  noteId: string;
  text: string;
  tags: string;
};

export default function MemoryWorkbenchPane() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const paneBg = usePaneContentBackground(colors.background);
  const headerBg = usePanelBackground(colors.surface);

  const agentId = useAgentStore((s) => s.memoryWorkbenchAgentId);
  const agentName = useAgentStore(
    (s) => s.agents.find((a) => a.id === s.memoryWorkbenchAgentId)?.name ?? s.memoryWorkbenchAgentId ?? ''
  );

  const [loading, setLoading] = useState(false);
  const [ownNotes, setOwnNotes] = useState<MemoryNote[]>([]);
  const [globalNotes, setGlobalNotes] = useState<MemoryNote[]>([]);
  const [query, setQuery] = useState('');
  const [expandedNoteId, setExpandedNoteId] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [own, shared] = await Promise.all([
        agentId ? listNotesWithFallback(agentId) : Promise.resolve<MemoryNote[]>([]),
        listNotesWithFallback(GLOBAL_MEMORY_SCOPE),
      ]);
      setOwnNotes(own);
      setGlobalNotes(shared);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filteredOwn = useMemo(() => filterMemoryNotes(ownNotes, query), [ownNotes, query]);
  const filteredGlobal = useMemo(() => filterMemoryNotes(globalNotes, query), [globalNotes, query]);
  const hasQuery = query.trim().length > 0;

  const handleDelete = useCallback(
    (scopeAgentId: string, note: MemoryNote) => {
      Alert.alert(
        t('pane.memory_workbench.delete_title'),
        t('pane.memory_workbench.delete_body'),
        [
          { text: t('pane.memory_workbench.cancel'), style: 'cancel' },
          {
            text: t('pane.memory_workbench.delete_confirm'),
            style: 'destructive',
            onPress: () => {
              void (async () => {
                const ok = await deleteMemoryNoteById(scopeAgentId, note.id);
                if (!ok) {
                  Alert.alert(t('pane.memory_workbench.delete_failed'));
                }
                await reload();
              })();
            },
          },
        ],
        { cancelable: true }
      );
    },
    [t, reload]
  );

  const startEdit = useCallback((scopeAgentId: string, note: MemoryNote) => {
    setEditState({
      scopeAgentId,
      noteId: note.id,
      text: note.text,
      tags: note.tags.join(', '),
    });
  }, []);

  const handleSaveEdit = useCallback(async () => {
    if (!editState || saving) return;
    const text = editState.text.trim();
    if (!text) return;
    setSaving(true);
    try {
      const updated = await updateMemoryNoteById({
        agentId: editState.scopeAgentId,
        id: editState.noteId,
        text,
        tags: parseTagsInput(editState.tags),
      });
      if (!updated) {
        Alert.alert(t('pane.memory_workbench.save_failed'));
      } else {
        setEditState(null);
      }
      await reload();
    } finally {
      setSaving(false);
    }
  }, [editState, saving, t, reload]);

  const renderNote = useCallback(
    (scopeAgentId: string, note: MemoryNote) => {
      const isEditing =
        editState !== null &&
        editState.scopeAgentId === scopeAgentId &&
        editState.noteId === note.id;
      const isExpanded = expandedNoteId === note.id;

      if (isEditing) {
        return (
          <View key={note.id} style={styles.noteCard}>
            <TextInput
              style={styles.editTextInput}
              value={editState.text}
              onChangeText={(text) => setEditState((prev) => (prev ? { ...prev, text } : prev))}
              multiline
              autoFocus
              placeholderTextColor={colors.hint}
            />
            <Text style={styles.editTagsLabel}>{t('pane.memory_workbench.tags_label')}</Text>
            <TextInput
              style={styles.editTagsInput}
              value={editState.tags}
              onChangeText={(tags) => setEditState((prev) => (prev ? { ...prev, tags } : prev))}
              placeholderTextColor={colors.hint}
            />
            <View style={styles.editActions}>
              <Pressable
                style={[styles.editButton, styles.editCancelButton]}
                onPress={() => setEditState(null)}
                disabled={saving}
              >
                <Text style={styles.editCancelText}>{t('pane.memory_workbench.cancel')}</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.editButton,
                  styles.editSaveButton,
                  (!editState.text.trim() || saving) && styles.editButtonDisabled,
                ]}
                onPress={() => void handleSaveEdit()}
                disabled={!editState.text.trim() || saving}
              >
                <Text style={styles.editSaveText}>{t('pane.memory_workbench.save')}</Text>
              </Pressable>
            </View>
          </View>
        );
      }

      return (
        <View key={note.id} style={styles.noteCard}>
          <View style={styles.noteMetaRow}>
            <Text style={styles.noteType}>[{note.type}]</Text>
            <Text style={styles.noteDate}>{note.created.slice(0, 10)}</Text>
            <View style={styles.noteActions}>
              <Pressable
                onPress={() => startEdit(scopeAgentId, note)}
                accessibilityLabel={t('pane.memory_workbench.edit_a11y')}
                hitSlop={6}
                style={styles.noteActionButton}
              >
                <MaterialIcons name="edit" size={15} color={colors.accent} />
              </Pressable>
              <Pressable
                onPress={() => handleDelete(scopeAgentId, note)}
                accessibilityLabel={t('pane.memory_workbench.delete_a11y')}
                hitSlop={6}
                style={styles.noteActionButton}
              >
                <MaterialIcons name="delete-outline" size={15} color={colors.error} />
              </Pressable>
            </View>
          </View>
          <Text style={styles.noteText} numberOfLines={isExpanded ? undefined : 3}>
            {note.text}
          </Text>
          {note.text.length > 120 && (
            <Pressable onPress={() => setExpandedNoteId(isExpanded ? null : note.id)}>
              <Text style={styles.expandToggle}>
                {isExpanded
                  ? t('pane.memory_workbench.collapse')
                  : t('pane.memory_workbench.show_full')}
              </Text>
            </Pressable>
          )}
          {note.tags.length > 0 && (
            <View style={styles.tagRow}>
              {note.tags.map((tag) => (
                <View key={tag} style={styles.tagChip}>
                  <Text style={styles.tagText}>#{tag}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      );
    },
    [editState, expandedNoteId, saving, styles, colors, t, startEdit, handleDelete, handleSaveEdit]
  );

  return (
    <View style={[styles.container, { backgroundColor: paneBg }]}>
      {/* Header */}
      <View style={[styles.header, { backgroundColor: headerBg }]}>
        <MaterialIcons name="psychology" size={14} color={colors.accent} />
        <Text style={styles.headerTitle} numberOfLines={1}>
          {t('pane.memory_workbench.header')}
          {agentName ? ` — ${agentName}` : ''}
        </Text>
        <Pressable
          onPress={() => void reload()}
          accessibilityLabel={t('pane.memory_workbench.refresh_a11y')}
          hitSlop={8}
        >
          <MaterialIcons name="refresh" size={16} color={colors.muted} />
        </Pressable>
      </View>

      {/* Search */}
      <View style={styles.searchRow}>
        <MaterialIcons name="search" size={14} color={colors.muted} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder={t('pane.memory_workbench.search_placeholder')}
          placeholderTextColor={colors.hint}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {hasQuery && (
          <Pressable onPress={() => setQuery('')} hitSlop={8}>
            <MaterialIcons name="close" size={14} color={colors.muted} />
          </Pressable>
        )}
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {/* Agent's own notes */}
          {agentId ? (
            <>
              <Text style={styles.sectionHeader}>
                {t('pane.memory_workbench.section_agent', {
                  name: agentName,
                  count: filteredOwn.length,
                })}
              </Text>
              {filteredOwn.length === 0 ? (
                <Text style={styles.emptyText}>
                  {hasQuery
                    ? t('pane.memory_workbench.no_results')
                    : t('pane.memory_workbench.empty_agent')}
                </Text>
              ) : (
                filteredOwn.map((note) => renderNote(agentId, note))
              )}
            </>
          ) : (
            <Text style={styles.emptyText}>{t('pane.memory_workbench.no_agent')}</Text>
          )}

          {/* Shared _global notes — always a distinct section, never merged */}
          <Text style={[styles.sectionHeader, styles.globalSectionHeader]}>
            {t('pane.memory_workbench.section_global', { count: filteredGlobal.length })}
          </Text>
          {filteredGlobal.length === 0 ? (
            <Text style={styles.emptyText}>
              {hasQuery
                ? t('pane.memory_workbench.no_results')
                : t('pane.memory_workbench.empty_global')}
            </Text>
          ) : (
            filteredGlobal.map((note) => renderNote(GLOBAL_MEMORY_SCOPE, note))
          )}
        </ScrollView>
      )}
    </View>
  );
}

function makeStyles(colors: ThemeColorPalette) {
  return StyleSheet.create({
    container: {
      flex: 1,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 6,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      minHeight: 32,
    },
    headerTitle: {
      flex: 1,
      color: colors.foreground,
      fontSize: 12,
      fontWeight: '700',
    },
    searchRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginHorizontal: 8,
      marginVertical: 6,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
    },
    searchInput: {
      flex: 1,
      color: colors.foreground,
      fontSize: 12,
      paddingVertical: 6,
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      paddingHorizontal: 8,
      paddingBottom: 24,
    },
    sectionHeader: {
      color: colors.accent,
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      marginTop: 8,
      marginBottom: 4,
    },
    globalSectionHeader: {
      marginTop: 16,
      color: colors.success,
    },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
    },
    emptyText: {
      color: colors.muted,
      fontSize: 11,
      paddingVertical: 6,
    },
    noteCard: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 6,
      padding: 8,
      marginBottom: 6,
      backgroundColor: withAlpha(colors.surface, 0.6),
    },
    noteMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 4,
    },
    noteType: {
      color: colors.warning,
      fontSize: 10,
      fontWeight: '700',
    },
    noteDate: {
      color: colors.hint,
      fontSize: 10,
      flex: 1,
    },
    noteActions: {
      flexDirection: 'row',
      gap: 12,
    },
    noteActionButton: {
      padding: 2,
    },
    noteText: {
      color: colors.foreground,
      fontSize: 12,
      lineHeight: 17,
    },
    expandToggle: {
      color: colors.link,
      fontSize: 10,
      marginTop: 4,
    },
    tagRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 4,
      marginTop: 6,
    },
    tagChip: {
      borderWidth: 1,
      borderColor: withAlpha(colors.accent, 0.5),
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    tagText: {
      color: colors.accent,
      fontSize: 9,
    },
    editTextInput: {
      color: colors.foreground,
      fontSize: 12,
      lineHeight: 17,
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: 4,
      padding: 6,
      minHeight: 60,
      textAlignVertical: 'top',
    },
    editTagsLabel: {
      color: colors.muted,
      fontSize: 10,
      marginTop: 6,
      marginBottom: 2,
    },
    editTagsInput: {
      color: colors.foreground,
      fontSize: 11,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 4,
    },
    editActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
      marginTop: 8,
    },
    editButton: {
      borderRadius: 4,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    editButtonDisabled: {
      opacity: 0.5,
    },
    editCancelButton: {
      borderWidth: 1,
      borderColor: colors.border,
    },
    editCancelText: {
      color: colors.muted,
      fontSize: 11,
    },
    editSaveButton: {
      backgroundColor: colors.accent,
    },
    editSaveText: {
      color: colors.background,
      fontSize: 11,
      fontWeight: '700',
    },
  });
}
