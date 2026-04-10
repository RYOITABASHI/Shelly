import React, { useState, useMemo, createContext, useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { PANE_REGISTRY } from './pane-registry';
import { PaneSelector } from './PaneSelector';
import type { PaneTab } from '@/hooks/use-multi-pane';
import { usePaneStore, getAgentColor, AGENT_COLORS } from '@/store/pane-store';
import { useSettingsStore } from '@/store/settings-store';
import { onCommandComplete } from '@/lib/cli-notification';
import { useSidebarStore } from '@/store/sidebar-store';
import { useBrowserStore } from '@/store/browser-store';

const ACCENT = '#00D4AA';
const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** Context to let child screens know their pane width */
export const MultiPaneContext = createContext<{ paneWidth: number } | null>(null);

/** Context to let child pane components know their leaf ID */
export const PaneIdContext = React.createContext<string>('');

type Props = {
  leafId: string;
  tab: PaneTab;
  onChangeTab: (tab: PaneTab) => void;
  onRemove: () => void;
  onSplitH: (tab: PaneTab) => void;
  onSplitV: (tab: PaneTab) => void;
  canSplit: boolean;
};

/** Derive display title for pane header matching mock style */
function getPaneTitle(tab: PaneTab): string {
  switch (tab) {
    case 'terminal': return 'CLAUDE CODE';
    case 'ai': return 'CLAUDE CODE';
    case 'browser': return 'BROWSER';
    case 'markdown': return 'MARKDOWN';
    default: return String(tab).toUpperCase();
  }
}

const PaneSlotInner = ({ leafId, tab, onChangeTab, onRemove, onSplitH, onSplitV, canSplit }: Props) => {
  const [selectorVisible, setSelectorVisible] = useState(false);
  const [splitMenuVisible, setSplitMenuVisible] = useState(false);
  const [agentMenuVisible, setAgentMenuVisible] = useState(false);
  const [paneWidth, setPaneWidth] = useState(0);
  const [notification, setNotification] = useState<{ status: 'done' | 'error' } | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasBrowserRef = useRef(tab === 'browser');
  const entry = PANE_REGISTRY[tab];
  const agentColor = usePaneStore((s) => getAgentColor(s.paneAgents, leafId));
  const boundAgent = usePaneStore((s) => s.paneAgents[leafId] ?? null);
  const { bindAgent } = usePaneStore();
  const focusedPaneId = usePaneStore((s) => s.focusedPaneId);
  const { setFocusedPane } = usePaneStore();
  const teamMembers = useSettingsStore((s) => s.settings.teamMembers);
  const activeRepoPath = useSidebarStore((s) => s.activeRepoPath);
  const Component = useMemo(() => entry.getComponent(), [tab]);
  const BrowserComponent = useMemo(() => PANE_REGISTRY['browser'].getComponent(), []);
  const ctxValue = useMemo(() => ({ paneWidth }), [paneWidth]);

  useEffect(() => {
    if (tab === 'browser') {
      wasBrowserRef.current = true;
    }
  }, [tab]);

  useEffect(() => {
    const unsub = onCommandComplete((event) => {
      if (event.paneId !== leafId) return;
      if (focusedPaneId === leafId) return;
      setNotification({ status: event.exitCode === 0 ? 'done' : 'error' });
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = setTimeout(() => setNotification(null), 5000);
    });
    return () => {
      unsub();
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [leafId, focusedPaneId]);

  const paneTitle = getPaneTitle(tab);
  const cwdDisplay = activeRepoPath
    ? `— ${activeRepoPath.replace(/^\/data\/data\/com\.termux\/files\/home/, '~')}`
    : '';

  return (
    <View
      style={styles.pane}
      onTouchStart={() => setFocusedPane(leafId)}
      onLayout={(e) => setPaneWidth(e.nativeEvent.layout.width)}
    >
      {/* Pane header — rich info display matching mock */}
      <View style={[styles.header, { borderTopColor: agentColor }]}>
        {/* Left: pane icon + title + cwd */}
        <Pressable
          style={styles.headerLeft}
          onPress={() => setSelectorVisible(true)}
        >
          <MaterialIcons name={entry.icon as any} size={12} color={ACCENT} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            {paneTitle}
          </Text>
          {cwdDisplay ? (
            <Text style={styles.headerPath} numberOfLines={1}>
              {cwdDisplay}
            </Text>
          ) : null}
        </Pressable>

        {/* Center: token/usage indicator (terminal/ai) or nav buttons (browser) */}
        {tab === 'browser' ? (
          <View style={styles.browserNav}>
            <Pressable style={styles.navMiniBtn} hitSlop={4} onPress={() => useBrowserStore.getState().triggerNav('back')}>
              <MaterialIcons name="arrow-back" size={12} color="#6B7280" />
            </Pressable>
            <Pressable style={styles.navMiniBtn} hitSlop={4} onPress={() => useBrowserStore.getState().triggerNav('forward')}>
              <MaterialIcons name="arrow-forward" size={12} color="#6B7280" />
            </Pressable>
            <Pressable style={styles.navMiniBtn} hitSlop={4} onPress={() => useBrowserStore.getState().triggerNav('reload')}>
              <MaterialIcons name="refresh" size={12} color="#6B7280" />
            </Pressable>
          </View>
        ) : (
          <View style={styles.headerCenter}>
            <MaterialIcons name="data-usage" size={10} color="#6B7280" />
            <Text style={styles.tokenText}>42K / 1H</Text>
          </View>
        )}

        {notification && (
          <View style={[
            styles.notificationBadge,
            notification.status === 'done' ? styles.notifDone : styles.notifError,
          ]}>
            <Text style={styles.notifText}>
              {notification.status === 'done' ? 'Done' : 'Error'}
            </Text>
          </View>
        )}

        <View style={styles.headerSpacer} />

        {/* Right action icons matching mock: split-h, split-grid, close */}
        <View style={styles.headerActions}>
          {canSplit && (
            <>
              <Pressable
                style={styles.actionBtn}
                onPress={() => onSplitH('terminal')}
                hitSlop={6}
              >
                <MaterialIcons name="view-column" size={13} color="#6B7280" />
              </Pressable>
              <Pressable
                style={styles.actionBtn}
                onPress={() => setSplitMenuVisible(true)}
                hitSlop={6}
              >
                <MaterialIcons name="grid-view" size={13} color="#6B7280" />
              </Pressable>
            </>
          )}
          <Pressable
            style={styles.actionBtn}
            onPress={onRemove}
            hitSlop={6}
          >
            <MaterialIcons name="close" size={13} color="#6B7280" />
          </Pressable>
        </View>
      </View>

      {/* Pane content */}
      <View style={styles.content}>
        <SafeAreaInsetsContext.Provider value={ZERO_INSETS}>
          <MultiPaneContext.Provider value={ctxValue}>
            <PaneIdContext.Provider value={leafId}>
              {tab !== 'browser' && <Component />}
              {(tab === 'browser' || wasBrowserRef.current) && (
                <View style={tab === 'browser' ? styles.fill : styles.hidden}>
                  <BrowserComponent />
                </View>
              )}
            </PaneIdContext.Provider>
          </MultiPaneContext.Provider>
        </SafeAreaInsetsContext.Provider>
      </View>

      {/* Tab selector modal */}
      <PaneSelector
        visible={selectorVisible}
        currentTab={tab}
        onSelect={(newTab) => onChangeTab(newTab)}
        onClose={() => setSelectorVisible(false)}
      />

      {/* Split direction menu */}
      <SplitMenu
        visible={splitMenuVisible}
        onClose={() => setSplitMenuVisible(false)}
        onSplitH={onSplitH}
        onSplitV={onSplitV}
        currentTab={tab}
      />

      {/* Agent selector menu */}
      {tab === 'ai' && (
        <AgentMenu
          visible={agentMenuVisible}
          onClose={() => setAgentMenuVisible(false)}
          teamMembers={teamMembers}
          boundAgent={boundAgent}
          onSelect={(key) => {
            bindAgent(leafId, key);
            setAgentMenuVisible(false);
          }}
        />
      )}
    </View>
  );
};

export const PaneSlot = React.memo(PaneSlotInner);

// ─── Split Direction Menu ────────────────────────────────────────────────────

function SplitMenu({
  visible,
  onClose,
  onSplitH,
  onSplitV,
  currentTab,
}: {
  visible: boolean;
  onClose: () => void;
  onSplitH: (tab: PaneTab) => void;
  onSplitV: (tab: PaneTab) => void;
  currentTab: PaneTab;
}) {
  const [step, setStep] = useState<'direction' | 'tab'>('direction');
  const [direction, setDirection] = useState<'h' | 'v'>('h');

  if (!visible) return null;

  const handleDirection = (dir: 'h' | 'v') => {
    setDirection(dir);
    setStep('tab');
  };

  const handleTabSelect = (tab: PaneTab) => {
    if (direction === 'h') onSplitH(tab);
    else onSplitV(tab);
    setStep('direction');
    onClose();
  };

  const handleClose = () => {
    setStep('direction');
    onClose();
  };

  const suggestedTab: PaneTab = (['terminal', 'ai', 'browser', 'markdown'] as PaneTab[])
    .find((t) => t !== currentTab) ?? 'terminal';

  return (
    <Pressable style={menuStyles.backdrop} onPress={handleClose}>
      <Pressable style={menuStyles.menu} onPress={(e) => e.stopPropagation()}>
        {step === 'direction' ? (
          <>
            <Text style={menuStyles.title}>Split Pane</Text>
            <Pressable style={menuStyles.option} onPress={() => handleDirection('h')}>
              <MaterialIcons name="view-column" size={18} color={ACCENT} />
              <Text style={menuStyles.optionText}>Split Right</Text>
            </Pressable>
            <Pressable style={menuStyles.option} onPress={() => handleDirection('v')}>
              <MaterialIcons name="view-stream" size={18} color={ACCENT} />
              <Text style={menuStyles.optionText}>Split Down</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={menuStyles.title}>Open In New Pane</Text>
            {(['terminal', 'ai', 'browser', 'markdown'] as PaneTab[]).map((t) => (
              <Pressable
                key={t}
                style={[menuStyles.option, t === suggestedTab && menuStyles.optionHighlight]}
                onPress={() => handleTabSelect(t)}
              >
                <MaterialIcons name={PANE_REGISTRY[t].icon as any} size={16} color={t === suggestedTab ? ACCENT : '#6B7280'} />
                <Text style={[menuStyles.optionText, t === suggestedTab && { color: ACCENT }]}>
                  {PANE_REGISTRY[t].title}
                </Text>
              </Pressable>
            ))}
          </>
        )}
      </Pressable>
    </Pressable>
  );
}

// ─── Agent Menu ──────────────────────────────────────────────────────────────

function AgentMenu({
  visible,
  onClose,
  teamMembers,
  boundAgent,
  onSelect,
}: {
  visible: boolean;
  onClose: () => void;
  teamMembers: Record<string, boolean>;
  boundAgent: string | null;
  onSelect: (key: string) => void;
}) {
  if (!visible) return null;

  const agents = Object.entries(teamMembers)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);

  return (
    <Pressable style={menuStyles.backdrop} onPress={onClose}>
      <Pressable style={agentStyles.menu} onPress={(e) => e.stopPropagation()}>
        <Text style={menuStyles.title}>Switch Agent</Text>
        {agents.map((key) => {
          const color = AGENT_COLORS[key] ?? AGENT_COLORS.unbound;
          const isActive = key === boundAgent;
          return (
            <Pressable
              key={key}
              style={[agentStyles.row, isActive && agentStyles.rowActive]}
              onPress={() => onSelect(key)}
            >
              <View style={[agentStyles.dot, { backgroundColor: color }]} />
              <Text style={[agentStyles.label, isActive && { color: ACCENT }]}>
                {key.charAt(0).toUpperCase() + key.slice(1)}
              </Text>
              {isActive && (
                <MaterialIcons name="check" size={12} color={ACCENT} style={{ marginLeft: 'auto' }} />
              )}
            </Pressable>
          );
        })}
      </Pressable>
    </Pressable>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  pane: {
    flex: 1,
    backgroundColor: '#0A0A0A',
  },
  header: {
    height: 28,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    backgroundColor: '#111',
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A1A',
    borderTopWidth: 2,
    gap: 4,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1,
  },
  headerTitle: {
    color: '#E5E7EB',
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  headerPath: {
    color: '#6B7280',
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '500',
    flexShrink: 1,
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 8,
  },
  tokenText: {
    color: '#6B7280',
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  browserNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginLeft: 6,
  },
  navMiniBtn: {
    padding: 2,
    borderRadius: 3,
  },
  headerSpacer: {
    flex: 1,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  notificationBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    marginLeft: 4,
  },
  notifDone: {
    backgroundColor: 'rgba(34,197,94,0.15)',
  },
  notifError: {
    backgroundColor: 'rgba(239,68,68,0.15)',
  },
  notifText: {
    color: '#E5E7EB',
    fontSize: 8,
    fontFamily: 'monospace',
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  actionBtn: {
    padding: 3,
    borderRadius: 3,
  },
  content: {
    flex: 1,
  },
  fill: {
    flex: 1,
  },
  hidden: {
    display: 'none',
  },
});

const menuStyles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  menu: {
    width: 220,
    backgroundColor: '#1A1A1A',
    borderRadius: 10,
    padding: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  title: {
    color: '#6B7280',
    fontSize: 9,
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
    paddingHorizontal: 8,
    fontWeight: '700',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 6,
  },
  optionHighlight: {
    backgroundColor: 'rgba(0,212,170,0.08)',
  },
  optionText: {
    color: '#E5E7EB',
    fontSize: 12,
    fontFamily: 'monospace',
  },
});

const agentStyles = StyleSheet.create({
  menu: {
    width: 180,
    backgroundColor: '#1A1A1A',
    borderRadius: 10,
    padding: 8,
    borderWidth: 1,
    borderColor: '#333',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  rowActive: {
    backgroundColor: 'rgba(0,212,170,0.08)',
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    color: '#E5E7EB',
    fontSize: 11,
    fontFamily: 'monospace',
  },
});
