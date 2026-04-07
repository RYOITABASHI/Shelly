import React, { useState, useMemo, createContext } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { PANE_REGISTRY } from './pane-registry';
import { PaneSelector } from './PaneSelector';
import type { PaneTab } from '@/hooks/use-multi-pane';
import { usePaneStore, getAgentColor } from '@/store/pane-store';

const ACCENT = '#00D4AA';
const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

/** Context to let child screens know their pane width */
export const MultiPaneContext = createContext<{ paneWidth: number } | null>(null);

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
  const [paneWidth, setPaneWidth] = useState(0);
  const entry = PANE_REGISTRY[tab];
  const agentColor = usePaneStore((s) => getAgentColor(s.paneAgents, leafId));
  const { setFocusedPane } = usePaneStore();
  const Component = useMemo(() => entry.getComponent(), [tab]);
  const ctxValue = useMemo(() => ({ paneWidth }), [paneWidth]);

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
            <Component />
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
  const suggestedTab: PaneTab = (['terminal', 'index', 'browser', 'projects', 'settings'] as PaneTab[])
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
            {(['index', 'terminal', 'projects', 'browser', 'creator', 'obsidian', 'snippets', 'search', 'settings'] as PaneTab[]).map((t) => (
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
  actionBtn: {
    padding: 3,
    borderRadius: 4,
  },
  content: {
    flex: 1,
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
