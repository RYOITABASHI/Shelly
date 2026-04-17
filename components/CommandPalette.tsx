import React, { useState, useMemo, useCallback } from 'react';
import { colors as C, fonts as F } from '@/theme.config';
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
import { useCosmeticStore } from '@/store/cosmetic-store';
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



export function CommandPalette() {
  const { isOpen, close } = useCommandPaletteStore();
  const layout = useDeviceLayout();
  const { enableMultiPane, disableMultiPane, isMultiPane } = useMultiPaneStore();
  const snippets = useSnippetStore((s) => s.snippets);
  const [query, setQuery] = useState('');
  const { t } = useTranslation();

  const actions = useMemo((): PaletteAction[] => {
    const list: PaletteAction[] = [
      // Navigation
      { id: 'tab-settings', label: 'Settings', hint: t('palette.hint_settings'), icon: 'settings', category: 'action',
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

      // Git actions — run in whichever terminal pane is active, same
      // pendingCommand channel as the tmux shortcuts above.
      { id: 'git-status', label: 'Git: Status', hint: 'git status -sb', icon: 'info', category: 'action',
        onExecute: () => {
          useTerminalStore.setState({ pendingCommand: 'git status -sb' });
          close();
        } },
      { id: 'git-diff', label: 'Git: Diff', hint: 'git diff', icon: 'compare-arrows', category: 'action',
        onExecute: () => {
          useTerminalStore.setState({ pendingCommand: 'git diff' });
          close();
        } },
      { id: 'git-log', label: 'Git: Log', hint: 'git log --oneline -10', icon: 'history', category: 'action',
        onExecute: () => {
          useTerminalStore.setState({ pendingCommand: 'git log --oneline -10' });
          close();
        } },
      { id: 'git-add-all', label: 'Git: Add all', hint: 'git add -A', icon: 'add', category: 'action',
        onExecute: () => {
          useTerminalStore.setState({ pendingCommand: 'git add -A' });
          close();
        } },
      { id: 'git-commit', label: 'Git: Commit', hint: 'prompts for message', icon: 'check', category: 'action',
        onExecute: () => {
          // Leave the quoted string open so the user can type the message
          // and hit Enter; the shell doesn't execute until they close it.
          useTerminalStore.setState({ pendingCommand: 'git commit -m "' });
          close();
        } },
      { id: 'git-push', label: 'Git: Push', hint: 'git push', icon: 'cloud-upload', category: 'action',
        onExecute: () => {
          useTerminalStore.setState({ pendingCommand: 'git push' });
          close();
        } },
      { id: 'git-pull', label: 'Git: Pull', hint: 'git pull --rebase', icon: 'cloud-download', category: 'action',
        onExecute: () => {
          useTerminalStore.setState({ pendingCommand: 'git pull --rebase' });
          close();
        } },

      // Pane add — route through the multi-pane store's addPane helper,
      // which splits the last leaf horizontally. Empty state also
      // handled (it creates a root leaf of the requested tab).
      { id: 'pane-add-terminal', label: 'Pane: Add Terminal', hint: 'split current layout', icon: 'terminal', category: 'pane',
        onExecute: () => { useMultiPaneStore.getState().addPane('terminal'); close(); } },
      { id: 'pane-add-ai', label: 'Pane: Add AI', hint: 'split current layout', icon: 'smart-toy', category: 'pane',
        onExecute: () => { useMultiPaneStore.getState().addPane('ai'); close(); } },
      { id: 'pane-add-browser', label: 'Pane: Add Browser', hint: 'split current layout', icon: 'public', category: 'pane',
        onExecute: () => { useMultiPaneStore.getState().addPane('browser'); close(); } },
      { id: 'pane-add-markdown', label: 'Pane: Add Markdown', hint: 'split current layout', icon: 'article', category: 'pane',
        onExecute: () => { useMultiPaneStore.getState().addPane('markdown'); close(); } },
      { id: 'pane-add-preview', label: 'Pane: Add Preview', hint: 'split current layout', icon: 'preview', category: 'pane',
        onExecute: () => { useMultiPaneStore.getState().addPane('preview'); close(); } },

      // Font preset — flips uiFont in settings, RootLayout's effect
      // picks the change up and calls applyThemePreset automatically.
      { id: 'font-shelly', label: 'Font: Shelly', hint: 'mock-faithful palette', icon: 'palette', category: 'action',
        onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'shelly' }); close(); } },
      { id: 'font-silkscreen', label: 'Font: Silk', hint: 'previous green palette', icon: 'palette', category: 'action',
        onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'silkscreen' }); close(); } },
      { id: 'font-pixel', label: 'Font: 8bit', hint: 'PressStart2P', icon: 'palette', category: 'action',
        onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'pixel' }); close(); } },
      { id: 'font-mono', label: 'Font: Mono', hint: 'system monospace', icon: 'palette', category: 'action',
        onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'mono' }); close(); } },

      // Theme presets — color swaps that keep Silkscreen as the font
      { id: 'theme-default', label: 'Theme: Default (Shelly)', hint: 'reset to teal-on-black', icon: 'palette', category: 'action',
        onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'shelly' }); close(); } },
      { id: 'theme-dracula', label: 'Theme: Dracula', hint: 'purple accent', icon: 'palette', category: 'action',
        onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'dracula' }); close(); } },
      { id: 'theme-nord', label: 'Theme: Nord', hint: 'arctic blue', icon: 'palette', category: 'action',
        onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'nord' }); close(); } },
      { id: 'theme-gruvbox', label: 'Theme: Gruvbox', hint: 'retro amber', icon: 'palette', category: 'action',
        onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'gruvbox' }); close(); } },
      { id: 'theme-tokyo-night', label: 'Theme: Tokyo Night', hint: 'deep blue', icon: 'palette', category: 'action',
        onExecute: () => { useSettingsStore.getState().updateSettings({ uiFont: 'tokyo-night' }); close(); } },

      // CRT toggle
      { id: 'crt-toggle', label: 'CRT: Toggle', hint: 'scanline + bloom overlay', icon: 'tv', category: 'action',
        onExecute: () => {
          const cs = useCosmeticStore.getState();
          cs.setCrt(!cs.crtEnabled);
          close();
        } },

      // Voice dialogue
      { id: 'voice-open', label: 'Voice: Open Dialogue', hint: 'mic long-press shortcut', icon: 'mic', category: 'action',
        onExecute: () => { useSettingsStore.getState().setShowVoiceMode(true); close(); } },

      // Layout presets — rebuilds the pane tree from scratch. Any
      // existing PTY sessions attached to the destroyed leaves will be
      // torn down (unlike font swap which preserves identity).
      { id: 'layout-single-terminal', label: 'Layout: Single Terminal', hint: 'one terminal pane', icon: 'crop-square', category: 'pane',
        onExecute: () => { useMultiPaneStore.getState().enableMultiPane(['terminal']); close(); } },
      { id: 'layout-terminal-ai', label: 'Layout: Terminal + AI', hint: '2-col split', icon: 'view-column', category: 'pane',
        onExecute: () => { useMultiPaneStore.getState().enableMultiPane(['terminal', 'ai']); close(); } },
      { id: 'layout-terminal-browser', label: 'Layout: Terminal + Browser', hint: '2-col split', icon: 'view-column', category: 'pane',
        onExecute: () => { useMultiPaneStore.getState().enableMultiPane(['terminal', 'browser']); close(); } },
      { id: 'layout-triple', label: 'Layout: 3-Way Triple', hint: 'terminal + ai + browser', icon: 'view-week', category: 'pane',
        onExecute: () => { useMultiPaneStore.getState().enableMultiPane(['terminal', 'ai', 'browser']); close(); } },
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
      { id: 'action-packages', label: t('pkg.title'), hint: 'Bundled tools status', icon: 'inventory-2', category: 'action',
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
    <Pressable
      style={styles.item}
      onPress={() => handleSelect(item)}
      accessibilityRole="button"
      accessibilityLabel={item.label}
      accessibilityHint={item.hint}
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
              selectionColor={C.accent}
              returnKeyType="go"
            />
            <Pressable
              onPress={handleClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close command palette"
            >
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
    fontFamily: F.family,
    fontSize: 15,
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
    fontFamily: F.family,
    fontSize: 14,
  },
  itemHint: {
    color: '#4B5563',
    fontFamily: F.family,
    fontSize: 11,
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
    fontFamily: F.family,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 0.5,
  },
  emptyText: {
    color: '#4B5563',
    fontFamily: F.family,
    fontSize: 13,
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
    fontFamily: F.family,
    fontSize: 9,
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
    fontFamily: F.family,
    fontSize: 10,
  },
});
