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
import { useCommandPaletteStore, type PaletteAction } from '@/hooks/use-command-palette';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { useSettingsStore } from '@/store/settings-store';
import { useSnippetStore } from '@/store/snippet-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useDeviceLayout } from '@/hooks/use-device-layout';
import { buildTmuxListCommand } from '@/lib/session-restore';
import { useTranslation } from '@/lib/i18n';
import { suggestFeatures } from '@/lib/feature-catalog';

// ---------------------------------------------------------------------------
// Recent actions — module-level so they persist across palette open/close
// ---------------------------------------------------------------------------
const MAX_RECENT = 5;

interface RecentEntry {
  label: string;
  action: () => void;
  ts: number;
}

const _recentActions: RecentEntry[] = [];

/**
 * Register an action as recently used. Call this from any component that
 * executes a palette-style action (e.g. settings screens, terminal shortcuts).
 */
export function addRecentAction(label: string, action: () => void): void {
  // Remove existing entry with same label to avoid duplicates
  const idx = _recentActions.findIndex((r) => r.label === label);
  if (idx !== -1) _recentActions.splice(idx, 1);
  _recentActions.unshift({ label, action, ts: Date.now() });
  if (_recentActions.length > MAX_RECENT) _recentActions.length = MAX_RECENT;
}

const ACCENT = '#00D4AA';

export function CommandPalette() {
  const { isOpen, close } = useCommandPaletteStore();
  const layout = useDeviceLayout();
  const { enableMultiPane, disableMultiPane, isMultiPane } = useMultiPaneStore();
  const snippets = useSnippetStore((s) => s.snippets);
  const [query, setQuery] = useState('');
  const { t } = useTranslation();

  const actions = useMemo((): PaletteAction[] => {
    const list: PaletteAction[] = [
      // Navigation actions (new layout — terminal is always visible, AI/projects are panes)
      { id: 'tab-projects', label: 'Projects', hint: t('palette.hint_projects'), icon: 'folder', category: 'tab',
        onExecute: () => { close(); } },
      { id: 'tab-chat', label: 'Chat / AI', hint: t('palette.hint_chat'), icon: 'chat', category: 'tab',
        onExecute: () => { (() => { const s = useMultiPaneStore.getState(); const root = s.root; if (root) { const leaf = root.type === 'leaf' ? root.id : root.children[0].type === 'leaf' ? root.children[0].id : ''; if (leaf) s.splitPane(leaf, 'horizontal', 'ai'); } })(); close(); } },
      { id: 'tab-terminal', label: 'Terminal', hint: t('palette.hint_terminal'), icon: 'terminal', category: 'tab',
        onExecute: () => { close(); } },
      { id: 'tab-settings', label: 'Settings', hint: t('palette.hint_settings'), icon: 'settings', category: 'tab',
        onExecute: () => { useSettingsStore.getState().setShowConfigTUI(true); close(); } },

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
          close();
        } },
      { id: 'action-tmux-attach', label: t('palette.tmux_attach'), hint: t('palette.hint_tmux_attach'), icon: 'link', category: 'action',
        onExecute: () => {
          useTerminalStore.setState({ pendingCommand: 'tmux attach' });
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
          useSettingsStore.getState().setShowConfigTUI(true);
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
          close();
        },
      });
    });

    return list;
  }, [snippets, isMultiPane, layout.isWide]);

  const searchResults = useMemo(() => {
    if (!query.trim()) return null; // null = show sectioned view
    const q = query.toLowerCase();
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        (a.hint && a.hint.toLowerCase().includes(q)) ||
        a.category.includes(q),
    );
  }, [query, actions]);

  // Recent section — snapshot at render time (stable reference via useMemo)
  const recentSection = useMemo((): PaletteAction[] => {
    return _recentActions.map((r, i) => ({
      id: `recent-${i}-${r.label}`,
      label: r.label,
      icon: 'history' as const,
      category: 'recent',
      onExecute: r.action,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]); // re-snapshot each time palette opens (query resets to '')

  // Suggested section — context from active session command history
  const suggestedSection = useMemo((): PaletteAction[] => {
    const activeSession = useTerminalStore
      .getState()
      .sessions.find((s) => s.id === useTerminalStore.getState().activeSessionId);
    const recentCmds = activeSession?.commandHistory?.slice(0, 10) ?? [];
    const features = suggestFeatures(recentCmds);
    return features.map((f) => ({
      id: `suggest-${f.id}`,
      label: f.name,
      hint: f.description,
      icon: 'auto-awesome' as const,
      category: 'suggest',
      onExecute: () => {
        if (f.id === 'ai-pane') { (() => { const s = useMultiPaneStore.getState(); const root = s.root; if (root) { const leaf = root.type === 'leaf' ? root.id : root.children[0].type === 'leaf' ? root.children[0].id : ''; if (leaf) s.splitPane(leaf, 'horizontal', 'ai'); } })(); close(); }
        else { close(); }
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const handleSelect = useCallback((action: PaletteAction) => {
    // Record to recents (skip entries that are already tagged as recent/suggest)
    if (action.category !== 'recent' && action.category !== 'suggest') {
      addRecentAction(action.label, action.onExecute);
    }
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
      case 'recent': return 'RECENT';
      case 'suggest': return 'SUGGEST';
      default: return cat.toUpperCase();
    }
  };

  /** Render a dim section divider */
  const SectionHeader = ({ title }: { title: string }) => (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionHeaderText}>{title}</Text>
    </View>
  );

  /** Render a single palette row */
  const ActionRow = ({ item }: { item: PaletteAction }) => (
    <Pressable style={styles.item} onPress={() => handleSelect(item)}>
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
  );

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
          {searchResults !== null ? (
            /* ── Search mode: flat filtered list ── */
            <FlatList
              data={searchResults}
              keyExtractor={(item) => item.id}
              keyboardShouldPersistTaps="handled"
              style={styles.list}
              renderItem={({ item }) => <ActionRow item={item} />}
              ListEmptyComponent={
                <Text style={styles.emptyText}>{t('palette.no_results')}</Text>
              }
            />
          ) : (
            /* ── Browse mode: Recent + Suggested + All Features ── */
            <FlatList
              keyboardShouldPersistTaps="handled"
              style={styles.list}
              data={[]}
              renderItem={null}
              ListHeaderComponent={
                <>
                  {/* Recent */}
                  {recentSection.length > 0 && (
                    <>
                      <SectionHeader title="RECENT" />
                      {recentSection.map((item) => (
                        <ActionRow key={item.id} item={item} />
                      ))}
                    </>
                  )}

                  {/* Suggested */}
                  {suggestedSection.length > 0 && (
                    <>
                      <SectionHeader title="SUGGESTED FOR YOU" />
                      {suggestedSection.map((item) => (
                        <ActionRow key={item.id} item={item} />
                      ))}
                    </>
                  )}

                  {/* All Features */}
                  <SectionHeader title="ALL FEATURES" />
                  {actions.map((item) => (
                    <ActionRow key={item.id} item={item} />
                  ))}
                </>
              }
            />
          )}

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
  sectionHeader: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: '#0E0E0E',
  },
  sectionHeaderText: {
    color: '#374151',
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 1.2,
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
