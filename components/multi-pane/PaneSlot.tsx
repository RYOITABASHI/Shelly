import React, { useState, useMemo, createContext, useEffect, useRef, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { PANE_REGISTRY } from './pane-registry';
import { PaneSelector } from './PaneSelector';
import PaneCliTabs from './PaneCliTabs';
import type { PaneTab } from '@/hooks/use-multi-pane';
import { useMultiPaneStore, type SlotIndex } from '@/hooks/use-multi-pane';
import { usePaneStore, getAgentColor, AGENT_COLORS } from '@/store/pane-store';
import { useSettingsStore } from '@/store/settings-store';
import { useTerminalStore } from '@/store/terminal-store';
import { useFocusStore } from '@/store/focus-store';
import { onCommandComplete } from '@/lib/cli-notification';
import { useSidebarStore } from '@/store/sidebar-store';
import { useBrowserStore } from '@/store/browser-store';
import { neonTextGlow } from '@/lib/neon-glow';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** Context to let child screens know their pane width/height */
export const MultiPaneContext = createContext<{ paneWidth: number; paneHeight: number } | null>(null);

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
    case 'terminal': return 'TERMINAL';
    case 'ai':       return 'AI';
    case 'browser':  return 'BROWSER';
    case 'markdown': return 'MARKDOWN';
    case 'preview':  return 'PREVIEW';
    default:         return String(tab).toUpperCase();
  }
}

const PaneSlotInner = ({ leafId, tab, onChangeTab, onRemove, onSplitH, onSplitV, canSplit }: Props) => {
  const [selectorVisible, setSelectorVisible] = useState(false);
  const [splitMenuVisible, setSplitMenuVisible] = useState(false);
  const [agentMenuVisible, setAgentMenuVisible] = useState(false);
  const [paneWidth, setPaneWidth] = useState(0);
  const [paneHeight, setPaneHeight] = useState(0);
  const [notification, setNotification] = useState<{ status: 'done' | 'error' } | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasBrowserRef = useRef(tab === 'browser');
  const isMaximized = useMultiPaneStore((s) => s.maximizedPaneId === leafId);
  const entry = PANE_REGISTRY[tab];
  const agentColor = usePaneStore((s) => getAgentColor(s.paneAgents, leafId));
  const boundAgent = usePaneStore((s) => s.paneAgents[leafId] ?? null);
  const { bindAgent } = usePaneStore();
  const focusedPaneId = usePaneStore((s) => s.focusedPaneId);
  const { setFocusedPane } = usePaneStore();
  // Pane's own terminal session id. Read from the MultiPane slot matching
  // `leafId`, NOT from `useTerminalStore.activeSessionId` (which is global
  // and cross-contaminates when another pane is focused).
  const paneSessionId = useMultiPaneStore((s) => {
    for (const slot of s.slots) {
      if (slot && slot.id === leafId && slot.tab === 'terminal') return slot.sessionId ?? null;
    }
    return null;
  });
  const teamMembers = useSettingsStore((s) => s.settings.teamMembers);
  const activeRepoPath = useSidebarStore((s) => s.activeRepoPath);
  const Component = useMemo(() => entry.getComponent(), [tab]);
  const BrowserComponent = useMemo(() => PANE_REGISTRY['browser'].getComponent(), []);
  const ctxValue = useMemo(() => ({ paneWidth, paneHeight }), [paneWidth, paneHeight]);

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

  // Multi-layer focus handoff when the user taps a pane. Four stores need to
  // agree on which pane owns keyboard input:
  //   1. `usePaneStore.focusedPaneId`       — per-pane chrome (green ring, bind dropdown)
  //   2. `useMultiPaneStore.focusedSlot`    — layout-level focus (tracked per slot index)
  //   3. `useTerminalStore.activeSessionId` — which PTY session is "active" globally
  //   4. native TerminalView focus          — which Android view receives commitText
  // Without this handoff, tapping a different terminal pane leaves the IME
  // writing to whichever pane was last tapped, because nothing consumes
  // `focusedPaneId` to move native view focus or switch the active session.
  // Triggering `requestTerminalRefocus()` fires the existing refocus effect
  // in TerminalPane so the right native view gets `requestFocus()` +
  // `showSoftInput()`.
  const handleFocusPane = useCallback(() => {
    setFocusedPane(leafId);
    const mps = useMultiPaneStore.getState();
    const slotIdx = mps.slots.findIndex((s) => s?.id === leafId);
    if (slotIdx >= 0 && slotIdx < 4) {
      mps.focusSlot(slotIdx as SlotIndex);
      const slot = mps.slots[slotIdx];
      if (slot && slot.tab === 'terminal' && slot.sessionId) {
        useTerminalStore.getState().setActiveSession(slot.sessionId);
      }
    }
    useFocusStore.getState().requestTerminalRefocus();
  }, [leafId, setFocusedPane]);

  const paneTitle = getPaneTitle(tab);
  const cwdDisplay = activeRepoPath
    ? `— ${activeRepoPath.replace(/^\/data\/data\/com\.termux\/files\/home/, '~')}`
    : '';
  // Pane-width-aware density. Grid layouts (2×2 etc) drop each pane below
  // ~350dp which is where the mock-faithful header starts overflowing: the
  // cwd path, token badge, and full pane-title label all compete for the
  // same row. Hide them progressively so the action icons at the right
  // edge always stay tappable.
  const isNarrow = paneWidth > 0 && paneWidth < 360;
  const isVeryNarrow = paneWidth > 0 && paneWidth < 260;

  return (
    <View
      style={styles.pane}
      onTouchStart={handleFocusPane}
      onLayout={(e) => {
        setPaneWidth(e.nativeEvent.layout.width);
        setPaneHeight(e.nativeEvent.layout.height);
      }}
    >
      {/* Pane header */}
      <View style={[styles.header, { borderTopColor: agentColor }]}>
        {/* Pane-type pill — tap to switch this pane between Terminal / AI /
            Browser / Markdown. The dropdown chevron makes it obvious that
            this is interactive. */}
        <Pressable
          style={styles.paneTypePill}
          onPress={() => setSelectorVisible(true)}
          hitSlop={6}
          accessibilityLabel="Change pane type"
        >
          <MaterialIcons name={entry.icon as any} size={11} color={C.accent} />
          {!isVeryNarrow && (
            <Text style={styles.paneTypeLabel} numberOfLines={1}>
              {paneTitle}
            </Text>
          )}
          <MaterialIcons name="arrow-drop-down" size={12} color={C.text2} />
        </Pressable>
        {cwdDisplay && !isNarrow ? (
          <Text style={styles.headerPath} numberOfLines={1}>
            {cwdDisplay}
          </Text>
        ) : null}

        {tab === 'browser' ? (
          <View style={styles.browserNav}>
            <Pressable style={styles.navMiniBtn} hitSlop={4} onPress={() => useBrowserStore.getState().triggerNav('back')}>
              <MaterialIcons name="arrow-back" size={12} color={C.text2} />
            </Pressable>
            <Pressable style={styles.navMiniBtn} hitSlop={4} onPress={() => useBrowserStore.getState().triggerNav('forward')}>
              <MaterialIcons name="arrow-forward" size={12} color={C.text2} />
            </Pressable>
            <Pressable style={styles.navMiniBtn} hitSlop={4} onPress={() => useBrowserStore.getState().triggerNav('reload')}>
              <MaterialIcons name="refresh" size={12} color={C.text2} />
            </Pressable>
          </View>
        ) : tab === 'ai' ? (
          <Pressable
            style={[styles.agentBadge, { borderColor: agentColor + '66', backgroundColor: agentColor + '14' }]}
            onPress={() => setAgentMenuVisible(true)}
            hitSlop={6}
            accessibilityLabel="Switch agent"
          >
            <View style={[styles.agentBadgeDot, { backgroundColor: agentColor }]} />
            <Text style={styles.agentBadgeLabel} numberOfLines={1}>
              {boundAgent ? boundAgent.toUpperCase() : 'AGENT'}
            </Text>
            <MaterialIcons name="arrow-drop-down" size={12} color={C.text2} />
          </Pressable>
        ) : tab === 'terminal' ? (
          <PaneCliTabs paneSessionId={paneSessionId} leafId={leafId} />
        ) : null}

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

        <View style={styles.headerActions}>
          {canSplit && !isVeryNarrow && (
            <Pressable
              style={styles.actionBtn}
              onPress={() => setSplitMenuVisible(true)}
              hitSlop={6}
              accessibilityLabel="Split pane"
            >
              <MaterialIcons name="call-split" size={13} color={C.text2} />
            </Pressable>
          )}
          <Pressable
            style={styles.actionBtn}
            onPress={() => useMultiPaneStore.getState().toggleMaximize(leafId)}
            hitSlop={6}
            accessibilityLabel="Maximize pane"
          >
            <MaterialIcons
              name={isMaximized ? 'fullscreen-exit' : 'fullscreen'}
              size={14}
              color={isMaximized ? C.accent : C.text2}
            />
          </Pressable>
          <Pressable
            style={styles.actionBtn}
            onPress={onRemove}
            hitSlop={6}
            accessibilityLabel="Close pane"
          >
            <MaterialIcons name="close" size={13} color={C.text2} />
          </Pressable>
        </View>
      </View>

      <View style={styles.content}>
        <SafeAreaInsetsContext.Provider value={ZERO_INSETS}>
          <MultiPaneContext.Provider value={ctxValue}>
            <PaneIdContext.Provider value={leafId}>
              {tab !== 'browser' && <Component />}
              {(tab === 'browser' || wasBrowserRef.current) && (
                <View style={tab === 'browser' ? styles.fill : styles.hidden}>
                  {React.createElement(BrowserComponent as any, { visible: tab === 'browser' })}
                </View>
              )}
            </PaneIdContext.Provider>
          </MultiPaneContext.Provider>
        </SafeAreaInsetsContext.Provider>
      </View>


      <PaneSelector
        visible={selectorVisible}
        currentTab={tab}
        onSelect={(newTab) => onChangeTab(newTab)}
        onClose={() => setSelectorVisible(false)}
      />

      <SplitMenu
        visible={splitMenuVisible}
        onClose={() => setSplitMenuVisible(false)}
        onSplitH={onSplitH}
        onSplitV={onSplitV}
        currentTab={tab}
      />

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

  const suggestedTab: PaneTab = (['terminal', 'ai', 'browser', 'markdown', 'ask'] as PaneTab[])
    .find((t) => t !== currentTab) ?? 'terminal';

  return (
    <Pressable style={menuStyles.backdrop} onPress={handleClose}>
      <Pressable style={menuStyles.menu} onPress={(e) => e.stopPropagation()}>
        {step === 'direction' ? (
          <>
            <Text style={menuStyles.title}>Split Pane</Text>
            <Pressable style={menuStyles.option} onPress={() => handleDirection('h')}>
              <MaterialIcons name="view-column" size={18} color={C.accent} />
              <Text style={menuStyles.optionText}>Split Right</Text>
            </Pressable>
            <Pressable style={menuStyles.option} onPress={() => handleDirection('v')}>
              <MaterialIcons name="view-stream" size={18} color={C.accent} />
              <Text style={menuStyles.optionText}>Split Down</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={menuStyles.title}>Open In New Pane</Text>
            {(['terminal', 'ai', 'browser', 'markdown', 'ask'] as PaneTab[]).map((t) => (
              <Pressable
                key={t}
                style={[menuStyles.option, t === suggestedTab && menuStyles.optionHighlight]}
                onPress={() => handleTabSelect(t)}
              >
                <MaterialIcons name={PANE_REGISTRY[t].icon as any} size={16} color={t === suggestedTab ? C.accent : C.text2} />
                <Text style={[menuStyles.optionText, t === suggestedTab && { color: C.accent }]}>
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
              <Text style={[agentStyles.label, isActive && { color: C.accent }]}>
                {key.charAt(0).toUpperCase() + key.slice(1)}
              </Text>
              {isActive && (
                <MaterialIcons name="check" size={12} color={C.accent} style={{ marginLeft: 'auto' }} />
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
    backgroundColor: C.bgDeep,
  },
  header: {
    height: S.paneHeaderHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: P.paneHeader.px,
    backgroundColor: C.bgSurface,
    borderBottomWidth: S.borderWidth,
    borderBottomColor: C.border,
    borderTopWidth: 2,
    borderRadius: R.paneHeader,
    gap: 4,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    flexShrink: 1,
  },
  paneTypePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: withAlpha(C.accent, 0.25),
    backgroundColor: withAlpha(C.accent, 0.06),
    flexShrink: 0,
  },
  agentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    marginLeft: 6,
  },
  agentBadgeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  agentBadgeLabel: {
    color: C.text1,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    letterSpacing: 0.5,
  },
  paneTypeLabel: {
    color: C.text1,
    fontSize: F.paneHeader.size,
    fontFamily: F.family,
    fontWeight: F.paneHeader.weight,
    letterSpacing: 0.5,
  },
  headerTitle: {
    color: C.text1,
    fontSize: F.paneHeader.size,
    fontFamily: F.family,
    fontWeight: F.paneHeader.weight,
    letterSpacing: 0.5,
  },
  headerPath: {
    color: C.text2,
    fontSize: F.paneHeader.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    flexShrink: 1,
  },
  headerCenter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 8,
  },
  tokenText: {
    color: C.text2,
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    fontWeight: F.contextBar.weight,
  },
  headerMiniBtn: {
    padding: 2,
    borderRadius: 2,
    marginLeft: 2,
  },
  browserNav: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginLeft: 6,
  },
  navMiniBtn: {
    padding: 2,
    borderRadius: R.actionButton,
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
    paddingHorizontal: P.statusBadge.px,
    paddingVertical: P.statusBadge.py,
    borderRadius: R.badge,
    marginLeft: 4,
  },
  notifDone: {
    backgroundColor: C.badgeRunningBg,
  },
  notifError: {
    backgroundColor: C.errorBg,
  },
  notifText: {
    color: C.text1,
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    textTransform: 'uppercase',
  },
  actionBtn: {
    padding: 3,
    borderRadius: R.actionButton,
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
  fabContainer: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    flexDirection: 'row',
    gap: 8,
    zIndex: 50,
  },
  fab: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: C.accent,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
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
    backgroundColor: C.bgSurface,
    borderRadius: 10,
    padding: 10,
    borderWidth: S.borderWidth,
    borderColor: C.border,
  },
  title: {
    color: C.text2,
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
    paddingHorizontal: 8,
    fontWeight: F.paneHeader.weight,
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
    backgroundColor: withAlpha(C.accent, 0.08),
  },
  optionText: {
    color: C.text1,
    fontSize: 12,
    fontFamily: F.family,
  },
});

const agentStyles = StyleSheet.create({
  menu: {
    width: 180,
    backgroundColor: C.bgSurface,
    borderRadius: 10,
    padding: 8,
    borderWidth: S.borderWidth,
    borderColor: C.border,
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
    backgroundColor: withAlpha(C.accent, 0.08),
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    color: C.text1,
    fontSize: 11,
    fontFamily: F.family,
  },
});
