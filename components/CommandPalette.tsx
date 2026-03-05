import React, { useState, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  Modal,
  FlatList,
  StyleSheet,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import { useCommandPaletteStore, type PaletteAction } from '@/hooks/use-command-palette';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { useSnippetStore } from '@/store/snippet-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { buildTmuxListCommand } from '@/lib/session-restore';
import { useTranslation } from '@/lib/i18n';

const ACCENT = '#00D4AA';

export function CommandPalette() {
  const { isOpen, close } = useCommandPaletteStore();
  const router = useRouter();
  const layout = useDeviceLayout();
  const { enableMultiPane, disableMultiPane, isMultiPane } = useMultiPaneStore();
  const snippets = useSnippetStore((s) => s.snippets);
  const [query, setQuery] = useState('');
  const { t } = useTranslation();

  const actions = useMemo((): PaletteAction[] => {
    const list: PaletteAction[] = [
      // Tab navigation
      { id: 'tab-projects', label: 'Projects', hint: t('palette.hint_projects'), icon: 'folder', category: 'tab',
        onExecute: () => { router.push('/(tabs)/projects' as any); close(); } },
      { id: 'tab-chat', label: 'Chat', hint: t('palette.hint_chat'), icon: 'chat', category: 'tab',
        onExecute: () => { router.push('/(tabs)/' as any); close(); } },
      { id: 'tab-terminal', label: 'Terminal', hint: t('palette.hint_terminal'), icon: 'terminal', category: 'tab',
        onExecute: () => { router.push('/(tabs)/terminal' as any); close(); } },
      { id: 'tab-snippets', label: 'Snippets', hint: t('palette.hint_snippets'), icon: 'bookmark', category: 'tab',
        onExecute: () => { router.push('/(tabs)/snippets' as any); close(); } },
      { id: 'tab-browser', label: 'Browser', hint: t('palette.hint_browser'), icon: 'public', category: 'tab',
        onExecute: () => { router.push('/(tabs)/browser' as any); close(); } },
      { id: 'tab-obsidian', label: 'Obsidian', hint: t('palette.hint_obsidian'), icon: 'psychology', category: 'tab',
        onExecute: () => { router.push('/(tabs)/obsidian' as any); close(); } },
      { id: 'tab-search', label: 'Search', hint: t('palette.hint_search'), icon: 'search', category: 'tab',
        onExecute: () => { router.push('/(tabs)/search' as any); close(); } },
      { id: 'tab-settings', label: 'Settings', hint: t('palette.hint_settings'), icon: 'settings', category: 'tab',
        onExecute: () => { router.push('/(tabs)/settings' as any); close(); } },

      // Actions
      { id: 'action-clear', label: t('palette.clear_terminal'), hint: t('palette.hint_clear'), icon: 'delete-sweep', category: 'action',
        onExecute: () => {
          useTerminalStore.getState().clearSession();
          close();
        } },
      { id: 'action-new-session', label: t('palette.new_session'), hint: t('palette.hint_new_session'), icon: 'add-box', category: 'action',
        onExecute: () => {
          useTerminalStore.getState().addSession();
          close();
        } },
      { id: 'action-tmux-list', label: t('palette.restore_tmux'), hint: t('palette.hint_restore_tmux'), icon: 'restore', category: 'action',
        onExecute: () => {
          useTerminalStore.setState({ pendingCommand: buildTmuxListCommand() });
          router.push('/(tabs)/' as any);
          close();
        } },
      { id: 'action-tmux-attach', label: t('palette.tmux_attach'), hint: t('palette.hint_tmux_attach'), icon: 'link', category: 'action',
        onExecute: () => {
          useTerminalStore.setState({ pendingCommand: 'tmux attach' });
          router.push('/(tabs)/' as any);
          close();
        } },
    ];

    // Multi-pane actions (inner screen only)
    if (layout.isWide) {
      list.push(
        { id: 'pane-toggle', label: isMultiPane ? t('palette.single_pane') : t('palette.multi_pane'),
          hint: isMultiPane ? t('palette.hint_single') : t('palette.hint_multi'),
          icon: isMultiPane ? 'fullscreen' : 'view-column', category: 'pane',
          onExecute: () => {
            if (isMultiPane) disableMultiPane(); else enableMultiPane();
            close();
          } },
      );
    }

    // Package Manager
    list.push(
      { id: 'action-packages', label: t('pkg.title'), hint: 'Termux pkg GUI', icon: 'inventory-2', category: 'action',
        onExecute: () => {
          router.push('/(tabs)/settings' as any);
          close();
        } },
    );

    // Snippets
    snippets.slice(0, 20).forEach((s) => {
      list.push({
        id: `snippet-${s.id}`,
        label: s.title || s.command,
        hint: s.title ? s.command : undefined,
        icon: 'play-arrow',
        category: 'snippet',
        onExecute: () => {
          useTerminalStore.setState({ pendingCommand: s.command });
          router.push('/(tabs)/' as any);
          close();
        },
      });
    });

    return list;
  }, [snippets, isMultiPane, layout.isWide]);

  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const q = query.toLowerCase();
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.hint && a.hint.toLowerCase().includes(q)) ||
        a.category.includes(q),
    );
  }, [query, actions]);

  const handleSelect = useCallback((action: PaletteAction) => {
    setQuery('');
    action.onExecute();
  }, []);

  const handleClose = useCallback(() => {
    setQuery('');
    close();
  }, [close]);

  const categoryLabel = (cat: string) => {
    switch (cat) {
      case 'tab': return 'TAB';
      case 'action': return 'ACTION';
      case 'snippet': return 'SNIPPET';
      case 'pane': return 'PANE';
      default: return cat.toUpperCase();
    }
  };

  return (
    <Modal
      visible={isOpen}
      transparent
      animationType="fade"
      onRequestClose={handleClose}
      statusBarTranslucent
    >
      <Pressable style={styles.backdrop} onPress={handleClose}>
        <View style={styles.palette}>
          {/* Search input */}
          <View style={styles.inputRow}>
            <MaterialIcons name="search" size={20} color="#6B7280" />
            <TextInput
              style={styles.input}
              placeholder={t('palette.search')}
              placeholderTextColor="#4B5563"
              value={query}
              onChangeText={setQuery}
              autoFocus
              selectionColor={ACCENT}
              returnKeyType="go"
            />
            <Pressable onPress={handleClose} hitSlop={8}>
              <MaterialIcons name="close" size={18} color="#6B7280" />
            </Pressable>
          </View>

          {/* Results */}
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            style={styles.list}
            renderItem={({ item }) => (
              <Pressable
                style={styles.item}
                onPress={() => handleSelect(item)}
              >
                <MaterialIcons name={item.icon as any} size={18} color="#9BA1A6" />
                <View style={styles.itemText}>
                  <Text style={styles.itemLabel} numberOfLines={1}>{item.label}</Text>
                  {item.hint && (
                    <Text style={styles.itemHint} numberOfLines={1}>{item.hint}</Text>
                  )}
                </View>
                <View style={styles.categoryBadge}>
                  <Text style={styles.categoryText}>{categoryLabel(item.category)}</Text>
                </View>
              </Pressable>
            )}
            ListEmptyComponent={
              <Text style={styles.emptyText}>{t('palette.no_results')}</Text>
            }
          />

          <View style={styles.footer}>
            <Text style={styles.footerText}>Ctrl+Shift+P</Text>
          </View>
        </View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-start',
    alignItems: 'center',
    paddingTop: 80,
  },
  palette: {
    width: '90%',
    maxWidth: 500,
    maxHeight: '60%',
    backgroundColor: '#141414',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2A2A2A',
    overflow: 'hidden',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#2A2A2A',
    gap: 10,
  },
  input: {
    flex: 1,
    color: '#ECEDEE',
    fontSize: 15,
    fontFamily: 'monospace',
    paddingVertical: 4,
  },
  list: {
    maxHeight: 360,
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
  },
  itemText: {
    flex: 1,
  },
  itemLabel: {
    color: '#ECEDEE',
    fontSize: 14,
    fontFamily: 'monospace',
  },
  itemHint: {
    color: '#4B5563',
    fontSize: 11,
    fontFamily: 'monospace',
    marginTop: 2,
  },
  categoryBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    backgroundColor: '#1E1E1E',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  categoryText: {
    color: '#6B7280',
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  emptyText: {
    color: '#4B5563',
    fontSize: 13,
    fontFamily: 'monospace',
    textAlign: 'center',
    paddingVertical: 24,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: '#2A2A2A',
    paddingVertical: 8,
    alignItems: 'center',
  },
  footerText: {
    color: '#333',
    fontSize: 10,
    fontFamily: 'monospace',
  },
});
