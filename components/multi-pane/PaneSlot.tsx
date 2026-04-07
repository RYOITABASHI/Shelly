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

const PaneSlotInner = ({ leafId, tab, onChangeTab, onRemove, onSplitH, onSplitV, canSplit }: Props) => {
  const [selectorVisible, setSelectorVisible] = useState(false);
  const [splitMenuVisible, setSplitMenuVisible] = useState(false);
  const [agentMenuVisible, setAgentMenuVisible] = useState(false);
  const [paneWidth, setPaneWidth] = useState(0);
  const [notification, setNotification] = useState<{ status: 'done' | 'error' } | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep track of whether browser was ever the active tab so we can preserve its mount
  const wasBrowserRef = useRef(tab === 'browser');
  const entry = PANE_REGISTRY[tab];
  const agentColor = usePaneStore((s) => getAgentColor(s.paneAgents, leafId));
  const boundAgent = usePaneStore((s) => s.paneAgents[leafId] ?? null);
  const { bindAgent } = usePaneStore();
  const focusedPaneId = usePaneStore((s) => s.focusedPaneId);
  const { setFocusedPane } = usePaneStore();
  const teamMembers = useSettingsStore((s) => s.settings.teamMembers);
  const Component = useMemo(() => entry.getComponent(), [tab]);
  // BrowserComponent is memoised once — never remounts, even when hidden
  const BrowserComponent = useMemo(() => PANE_REGISTRY['browser'].getComponent(), []);
  const ctxValue = useMemo(() => ({ paneWidth }), [paneWidth]);

  // Latch wasBrowserRef once the browser tab has been shown
  useEffect(() => {
    if (tab === 'browser') {
      wasBrowserRef.current = true;
    }
  }, [tab]);

  useEffect(() => {
    const unsub = onCommandComplete((event) => {
      // Only show badge when the event is for this pane and it's not focused
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

  return (
    <View
      style={styles.pane}
      onTouchStart={() => setFocusedPane(leafId)}
      onLayout={(e) => setPaneWidth(e.nativeEvent.layout.width)}
    >
      {/* Pane header */}
      <View style={[styles.header, { borderTopWidth: 2, borderTopColor: agentColor }]}>
        <Pressable
          style={styles.headerTabBtn}
          onPress={() => setSelectorVisible(true)}
        >
          <MaterialIcons name={entry.icon as any} size={13} color={ACCENT} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            {entry.title}
          </Text>
          <MaterialIcons name="arrow-drop-down" size={14} color="#9BA1A6" />
        </Pressable>
        {tab === 'ai' && (
          <Pressable
            style={styles.agentBadgeBtn}
            onPress={() => setAgentMenuVisible(true)}
            hitSlop={6}
          >
            <View style={[styles.agentDot, { backgroundColor: agentColor }]} />
            <Text style={styles.agentBadgeText}>
              {boundAgent ?? 'unbound'}
            </Text>
            <MaterialIcons name="arrow-drop-down" size={12} color="#9BA1A6" />
          </Pressable>
        )}
        {notification && (
          <View style={[
            styles.notificationBadge,
            notification.status === 'done' ? styles.notificationBadgeDone : styles.notificationBadgeError,
          ]}>
            <Text style={styles.notificationBadgeText}>
              {notification.status === 'done' ? 'Done' : 'Error'}
            </Text>
          </View>
        )}
        <View style={styles.headerSpacer} />
        {canSplit && (
          <Pressable
            style={styles.actionBtn}
            onPress={() => setSplitMenuVisible(true)}
            hitSlop={8}
          >
            <MaterialIcons name="dashboard" size={13} color={ACCENT} />
          </Pressable>
        )}
        <Pressable
          style={styles.actionBtn}
          onPress={onRemove}
          hitSlop={8}
        >
          <MaterialIcons name="close" size={13} color="#666" />
        </Pressable>
      </View>

      {/* Pane content — override SafeArea to prevent double padding */}
      <View style={styles.content}>
        <SafeAreaInsetsContext.Provider value={ZERO_INSETS}>
          <MultiPaneContext.Provider value={ctxValue}>
            <PaneIdContext.Provider value={leafId}>
              {/* Active non-browser pane — hidden when browser is active */}
              {tab !== 'browser' && <Component />}
              {/* Browser pane rendered once and toggled via display so audio keeps playing */}
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

  // Find a suggested tab that's not currently shown
  const suggestedTab: PaneTab = (['terminal', 'ai', 'browser', 'markdown'] as PaneTab[])
    .find((t) => t !== currentTab) ?? 'terminal';

  return (
    <Pressable style={splitStyles.backdrop} onPress={handleClose}>
      <Pressable style={splitStyles.menu} onPress={(e) => e.stopPropagation()}>
        {step === 'direction' ? (
          <>
            <Text style={splitStyles.title}>Split Pane</Text>
            <Pressable style={splitStyles.option} onPress={() => handleDirection('h')}>
              <MaterialIcons name="view-column" size={20} color={ACCENT} />
              <Text style={splitStyles.optionText}>Split Right</Text>
            </Pressable>
            <Pressable style={splitStyles.option} onPress={() => handleDirection('v')}>
              <MaterialIcons name="view-stream" size={20} color={ACCENT} />
              <Text style={splitStyles.optionText}>Split Down</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={splitStyles.title}>Open In New Pane</Text>
            {(['terminal', 'ai', 'browser', 'markdown'] as PaneTab[]).map((t) => (
              <Pressable
                key={t}
                style={[splitStyles.option, t === suggestedTab && splitStyles.optionHighlight]}
                onPress={() => handleTabSelect(t)}
              >
                <MaterialIcons name={PANE_REGISTRY[t].icon as any} size={18} color={t === suggestedTab ? ACCENT : '#9BA1A6'} />
                <Text style={[splitStyles.optionText, t === suggestedTab && { color: ACCENT }]}>
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
    <Pressable style={splitStyles.backdrop} onPress={onClose}>
      <Pressable style={agentMenuStyles.menu} onPress={(e) => e.stopPropagation()}>
        <Text style={splitStyles.title}>Switch Agent</Text>
        {agents.map((key) => {
          const color = AGENT_COLORS[key] ?? AGENT_COLORS.unbound;
          const isActive = key === boundAgent;
          return (
            <Pressable
              key={key}
              style={[agentMenuStyles.row, isActive && agentMenuStyles.rowActive]}
              onPress={() => onSelect(key)}
            >
              <View style={[agentMenuStyles.dot, { backgroundColor: color }]} />
              <Text style={[agentMenuStyles.label, isActive && { color: ACCENT }]}>
                {key.charAt(0).toUpperCase() + key.slice(1)}
              </Text>
              {isActive && (
                <MaterialIcons name="check" size={13} color={ACCENT} style={{ marginLeft: 'auto' }} />
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
    paddingHorizontal: 6,
    backgroundColor: '#111',
    borderBottomWidth: 1,
    borderBottomColor: '#1E1E1E',
    gap: 2,
  },
  headerTabBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  headerTitle: {
    color: '#ECEDEE',
    fontSize: 10,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  headerSpacer: {
    flex: 1,
  },
  notificationBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    marginLeft: 4,
  },
  notificationBadgeDone: {
    backgroundColor: 'rgba(34,197,94,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.4)',
  },
  notificationBadgeError: {
    backgroundColor: 'rgba(239,68,68,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.4)',
  },
  notificationBadgeText: {
    color: '#ECEDEE',
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '700',
  },
  actionBtn: {
    padding: 3,
    borderRadius: 4,
  },
  agentBadgeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  agentDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  agentBadgeText: {
    color: '#9BA1A6',
    fontSize: 9,
    fontFamily: 'monospace',
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  fill: {
    flex: 1,
  },
  hidden: {
    // Keep mounted (audio alive) but invisible and zero-size
    display: 'none',
  },
});

const splitStyles = StyleSheet.create({
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
    borderRadius: 12,
    padding: 10,
    borderWidth: 1,
    borderColor: '#333',
  },
  title: {
    color: '#9BA1A6',
    fontSize: 10,
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
    paddingHorizontal: 8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  optionHighlight: {
    backgroundColor: 'rgba(0,212,170,0.08)',
  },
  optionText: {
    color: '#ECEDEE',
    fontSize: 13,
    fontFamily: 'monospace',
  },
});

const agentMenuStyles = StyleSheet.create({
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
    paddingVertical: 7,
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
    color: '#ECEDEE',
    fontSize: 12,
    fontFamily: 'monospace',
  },
});
