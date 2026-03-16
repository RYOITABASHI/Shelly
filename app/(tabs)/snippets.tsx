/**
 * app/(tabs)/snippets.tsx
 *
 * Snippets tab — list, search, run, edit, delete saved commands.
 * Optimised for Z Fold6 (wide inner screen) and one-handed use.
 */

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  Pressable,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useSnippetStore } from '@/store/snippet-store';
import { useTerminalStore } from '@/store/terminal-store';
import { Snippet, SnippetSortOrder } from '@/store/types';
import { SnippetEditModal } from '@/components/snippets/SnippetEditModal';
import { exportSnippets } from '@/lib/snippet-io';
import { ImportModal } from '@/components/snippets/ImportModal';
import { useTranslation } from '@/lib/i18n';

// ─── Sort options ─────────────────────────────────────────────────────────────

const SORT_KEYS: { key: SnippetSortOrder; labelKey: string }[] = [
  { key: 'lastUsed', labelKey: 'snippets.sort_recent' },
  { key: 'useCount', labelKey: 'snippets.sort_frequency' },
  { key: 'createdAt', labelKey: 'snippets.sort_created' },
];

// ─── Snippet Card ─────────────────────────────────────────────────────────────

type CardProps = {
  item: Snippet;
  onRun: (snippet: Snippet) => void;
  onEdit: (snippet: Snippet) => void;
  onDelete: (snippet: Snippet) => void;
};

const SnippetCard = React.memo(function SnippetCard({ item, onRun, onEdit, onDelete }: CardProps) {
  const [swipeX, setSwipeX] = useState(0);
  const touchStartX = useRef(0);

  const handleTouchStart = useCallback((e: any) => {
    touchStartX.current = e.nativeEvent.pageX;
  }, []);

  const handleTouchEnd = useCallback((e: any) => {
    const dx = e.nativeEvent.pageX - touchStartX.current;
    if (dx > 60) {
      // Right swipe → Run
      onRun(item);
    } else if (dx < -60) {
      // Left swipe → Delete
      onDelete(item);
    }
    setSwipeX(0);
  }, [item, onRun, onDelete]);

  const handleTouchMove = useCallback((e: any) => {
    const dx = e.nativeEvent.pageX - touchStartX.current;
    setSwipeX(Math.max(-80, Math.min(80, dx)));
  }, []);

  const swipeHint = swipeX > 40 ? '▶ Run' : swipeX < -40 ? '🗑 Delete' : null;
  const swipeHintColor = swipeX > 40 ? '#00D4AA' : '#F87171';

  return (
    <View style={styles.cardWrapper}>
      {/* Swipe hint background */}
      {swipeHint && (
        <View style={[styles.swipeHint, { backgroundColor: swipeX > 0 ? '#00D4AA18' : '#F8717118' }]}>
          <Text style={[styles.swipeHintText, { color: swipeHintColor }]}>{swipeHint}</Text>
        </View>
      )}

      <Pressable
        style={[styles.card, { transform: [{ translateX: swipeX * 0.3 }] }]}
        onLongPress={() => onEdit(item)}
        delayLongPress={350}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
      >
        <View style={styles.cardMain}>
          <View style={styles.cardLeft}>
            {/* Title */}
            <Text style={styles.cardTitle} numberOfLines={1}>{item.title}</Text>
            {/* Command preview */}
            <Text style={styles.cardCommand} numberOfLines={2}>{item.command}</Text>
            {/* Tags + meta */}
            <View style={styles.cardMeta}>
              {item.tags.slice(0, 3).map((tag) => (
                <View key={tag} style={styles.tag}>
                  <Text style={styles.tagText}>{tag}</Text>
                </View>
              ))}
              {item.useCount > 0 && (
                <Text style={styles.useCount}>×{item.useCount}</Text>
              )}
            </View>
          </View>

          {/* Run button */}
          <TouchableOpacity
            style={styles.runBtn}
            onPress={() => onRun(item)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.runBtnText}>▶</Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </View>
  );
});

// ─── Main Screen ──────────────────────────────────────────────────────────────

export default function SnippetsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { t } = useTranslation();

  const { snippets, isLoaded, loadSnippets, deleteSnippet, incrementUseCount, search, getSorted, sortOrder, setSortOrder } = useSnippetStore();
  const { settings, runCommand } = useTerminalStore();

  const [query, setQuery] = useState('');
  const [editTarget, setEditTarget] = useState<Snippet | null>(null);
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  // Load snippets on mount
  useEffect(() => {
    if (!isLoaded) {
      loadSnippets();
    }
  }, [isLoaded, loadSnippets]);

  // Filtered + sorted list
  const displayList = useMemo(() => {
    return query.trim() ? search(query) : getSorted();
  }, [query, search, getSorted, snippets, sortOrder]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const handleRun = useCallback((snippet: Snippet) => {
    if (settings.hapticFeedback && Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    incrementUseCount(snippet.id);

    if (settings.snippetRunMode === 'insertAndRun') {
      // Run immediately and navigate to Terminal
      runCommand(snippet.command);
      if (settings.snippetAutoReturn) {
        router.push('/(tabs)');
      }
    } else {
      // Insert only — navigate to Terminal with command pre-filled
      // We use a global event via the store's pending command mechanism
      useTerminalStore.setState({ pendingCommand: snippet.command });
      if (settings.snippetAutoReturn) {
        router.push('/(tabs)');
      }
    }
  }, [settings, incrementUseCount, runCommand, router]);

  const handleEdit = useCallback((snippet: Snippet) => {
    if (settings.hapticFeedback && Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    setEditTarget(snippet);
    setEditModalVisible(true);
  }, [settings.hapticFeedback]);

  const handleExport = useCallback(async () => {
    setShowMenu(false);
    if (snippets.length === 0) {
      Alert.alert(t('snippets.export_title'), t('snippets.export_empty'));
      return;
    }
    await exportSnippets(snippets);
  }, [snippets]);

  const handleImport = useCallback(() => {
    setShowMenu(false);
    setShowImportModal(true);
  }, []);

  const handleDelete = useCallback((snippet: Snippet) => {
    Alert.alert(
      t('snippets.delete_title'),
      t('snippets.delete_confirm', { title: snippet.title }),
      [
        { text: t('snippets.cancel'), style: 'cancel' },
        {
          text: t('snippets.delete'),
          style: 'destructive',
          onPress: () => {
            if (settings.hapticFeedback && Platform.OS !== 'web') {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            }
            deleteSnippet(snippet.id);
          },
        },
      ]
    );
  }, [deleteSnippet, settings.hapticFeedback]);

  const renderItem = useCallback(({ item }: { item: Snippet }) => (
    <SnippetCard
      item={item}
      onRun={handleRun}
      onEdit={handleEdit}
      onDelete={handleDelete}
    />
  ), [handleRun, handleEdit, handleDelete]);

  const keyExtractor = useCallback((item: Snippet) => item.id, []);

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Snippets</Text>
        <View style={styles.headerRight}>
          <Text style={styles.headerCount}>{t('snippets.count', { count: snippets.length })}</Text>
          <Pressable
            onPress={() => setShowMenu((v) => !v)}
            style={styles.menuBtn}
          >
            <Text style={styles.menuBtnText}>⋯</Text>
          </Pressable>
        </View>
      </View>

      {/* Dropdown menu */}
      {showMenu && (
        <View style={styles.dropdownMenu}>
          <Pressable style={styles.dropdownItem} onPress={handleExport}>
            <Text style={styles.dropdownIcon}>↑</Text>
            <Text style={styles.dropdownLabel}>{t('snippets.export')}</Text>
          </Pressable>
          <View style={styles.dropdownDivider} />
          <Pressable style={styles.dropdownItem} onPress={handleImport}>
            <Text style={styles.dropdownIcon}>↓</Text>
            <Text style={[styles.dropdownLabel, { color: '#60A5FA' }]}>{t('snippets.import')}</Text>
          </Pressable>
        </View>
      )}

      {/* Search bar */}
      <View style={styles.searchRow}>
        <View style={styles.searchBar}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder={t('snippets.search_placeholder')}
            placeholderTextColor="#4B5563"
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            returnKeyType="search"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} style={styles.clearBtn}>
              <Text style={styles.clearBtnText}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Sort selector */}
      <View style={styles.sortRow}>
        {SORT_KEYS.map((opt) => (
          <TouchableOpacity
            key={opt.key}
            style={[styles.sortBtn, sortOrder === opt.key && styles.sortBtnActive]}
            onPress={() => setSortOrder(opt.key)}
          >
            <Text style={[styles.sortBtnText, sortOrder === opt.key && styles.sortBtnTextActive]}>
              {t(opt.labelKey)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* List */}
      {!isLoaded ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyText}>{t('snippets.loading')}</Text>
        </View>
      ) : displayList.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyIcon}>{query ? '🔍' : '☆'}</Text>
          <Text style={styles.emptyText}>
            {query
              ? t('snippets.empty_search', { query })
              : t('snippets.empty')}
          </Text>
        </View>
      ) : (
        <FlatList
          data={displayList}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: insets.bottom + 16 },
          ]}
          removeClippedSubviews
          maxToRenderPerBatch={20}
          windowSize={10}
          initialNumToRender={15}
          keyboardShouldPersistTaps="handled"
        />
      )}

      {/* Edit modal */}
      <SnippetEditModal
        snippet={editTarget}
        visible={editModalVisible}
        onClose={() => {
          setEditModalVisible(false);
          setEditTarget(null);
        }}
      />

      {/* Import modal */}
      <ImportModal
        visible={showImportModal}
        onClose={() => setShowImportModal(false)}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
    backgroundColor: '#111111',
  },
  headerTitle: {
    color: '#ECEDEE',
    fontSize: 16,
    fontWeight: '700',
    fontFamily: 'monospace',
  },
  headerCount: {
    color: '#4B5563',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  searchRow: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#111111',
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1A1A1A',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#2D2D2D',
    paddingHorizontal: 10,
    height: 36,
  },
  searchIcon: {
    color: '#4B5563',
    fontSize: 16,
    marginRight: 6,
  },
  searchInput: {
    flex: 1,
    color: '#ECEDEE',
    fontFamily: 'monospace',
    fontSize: 13,
    paddingVertical: 0,
  },
  clearBtn: {
    padding: 4,
  },
  clearBtnText: {
    color: '#4B5563',
    fontSize: 12,
  },
  sortRow: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 6,
    backgroundColor: '#0A0A0A',
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  sortBtn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2D2D2D',
    backgroundColor: '#111111',
  },
  sortBtnActive: {
    borderColor: '#00D4AA',
    backgroundColor: '#00D4AA18',
  },
  sortBtnText: {
    color: '#6B7280',
    fontSize: 11,
    fontFamily: 'monospace',
  },
  sortBtnTextActive: {
    color: '#00D4AA',
    fontWeight: '600',
  },
  listContent: {
    paddingTop: 8,
    paddingHorizontal: 8,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyIcon: {
    fontSize: 40,
  },
  emptyText: {
    color: '#4B5563',
    fontSize: 13,
    fontFamily: 'monospace',
    textAlign: 'center',
    lineHeight: 20,
  },
  // Card
  cardWrapper: {
    marginVertical: 3,
    borderRadius: 8,
    overflow: 'hidden',
  },
  swipeHint: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  swipeHintText: {
    fontSize: 13,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  card: {
    backgroundColor: '#161616',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#272727',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  cardMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  cardLeft: {
    flex: 1,
    gap: 3,
  },
  cardTitle: {
    color: '#ECEDEE',
    fontSize: 13,
    fontWeight: '600',
    fontFamily: 'monospace',
  },
  cardCommand: {
    color: '#93C5FD',
    fontSize: 12,
    fontFamily: 'monospace',
    lineHeight: 17,
  },
  cardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 2,
  },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: '#1E2A3A',
    borderWidth: 1,
    borderColor: '#2D3D50',
  },
  tagText: {
    color: '#60A5FA',
    fontSize: 10,
    fontFamily: 'monospace',
  },
  useCount: {
    color: '#4B5563',
    fontSize: 10,
    fontFamily: 'monospace',
  },
  runBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#00D4AA18',
    borderWidth: 1,
    borderColor: '#00D4AA44',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  runBtnText: {
    color: '#00D4AA',
    fontSize: 14,
  },
  // Header right group
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  menuBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: '#1E1E1E',
  },
  menuBtnText: {
    color: '#9BA1A6',
    fontSize: 18,
    lineHeight: 20,
    letterSpacing: 2,
  },
  // Dropdown menu
  dropdownMenu: {
    position: 'absolute',
    top: 52,
    right: 12,
    backgroundColor: '#1E1E1E',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2D2D2D',
    zIndex: 100,
    minWidth: 200,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  dropdownItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  dropdownIcon: {
    color: '#9BA1A6',
    fontSize: 16,
    width: 20,
    textAlign: 'center',
  },
  dropdownLabel: {
    color: '#ECEDEE',
    fontSize: 14,
    fontFamily: 'monospace',
  },
  dropdownDivider: {
    height: 1,
    backgroundColor: '#2D2D2D',
    marginHorizontal: 12,
  },
});
