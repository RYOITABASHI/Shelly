/**
 * components/multi-pane/PaneCliTabs.tsx
 *
 * Inline terminal-session tab row for a terminal pane's header. Replaces
 * the old standalone TerminalHeader that carried logo + tabs + preview +
 * usage + mode badge over 40px of vertical space. This component lives
 * inside PaneSlot's single 28px header row so the pane gets its full
 * height back.
 *
 * Shows each shell-N session as a small pill, plus a [+] add button.
 * Tap to switch THIS pane's active session; long-press is handled by
 * TerminalPane's own Reset/Close flow so nothing is lost.
 *
 * Multi-pane semantics (fixed after Phase C):
 *   - Each pane owns its own `slot.sessionId`. Tapping a tab in pane 2
 *     updates ONLY pane 2's slot — pane 1 is untouched. The old code
 *     called the global `useTerminalStore.setActiveSession`, which
 *     combined with a single pane's paneSessionId being null (pre-#117
 *     state) caused every tab tap anywhere to move pane 1's highlight.
 *   - Close button rebinds the slot to the first remaining session.
 *   - Add button binds the freshly-minted session to THIS pane's slot.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTerminalStore } from '@/store/terminal-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { colors as C, fonts as F } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';

const MAX_TABS = 4;

type Props = {
  /**
   * Terminal session id owned by THIS pane (derived from
   * `useMultiPaneStore.slots[i].sessionId`). Required so the green ● dot
   * and [×] close button reflect the per-pane session rather than the
   * global `useTerminalStore.activeSessionId`, which only matches the
   * most-recently focused pane and therefore bled across pane boundaries
   * (bug #116 — users saw the active indicator never move when tapping a
   * different terminal pane).
   */
  paneSessionId?: string | null;
  /**
   * Leaf id of the pane slot this tab row belongs to. When supplied, tab
   * taps update `slots[leafId].sessionId` via setSlotSessionId, giving
   * every pane an independent tab bar. When null, we fall back to the
   * global setActiveSession (legacy / non-pane callers).
   */
  leafId?: string | null;
};

export default function PaneCliTabs({ paneSessionId, leafId }: Props = {}) {
  const sessions = useTerminalStore((s) => s.sessions);
  const globalActiveSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const addSession = useTerminalStore((s) => s.addSession);
  const removeSession = useTerminalStore((s) => s.removeSession);
  const setSlotSessionId = useMultiPaneStore((s) => s.setSlotSessionId);

  // Prefer the pane-scoped session id. Fall back to the global one only for
  // legacy call sites (e.g. non-pane usage) that haven't threaded the prop
  // yet — this keeps backward compatibility.
  const effectiveActiveId = paneSessionId ?? globalActiveSessionId;

  const canAdd = sessions.length < MAX_TABS;
  const canClose = sessions.length > 1;

  const switchTo = (sessId: string) => {
    if (leafId) {
      // Per-pane tab switch: rebind this slot. Also update the global so
      // consumers that read activeSessionId (pendingCommand effect, cwd
      // tracking via onBlockCompleted) stay in sync with the pane the user
      // is actively interacting with.
      setSlotSessionId(leafId, sessId);
    }
    setActiveSession(sessId);
  };

  const closeTab = async (sessId: string) => {
    try {
      const sess = sessions.find((s) => s.id === sessId);
      if (sess) await TerminalEmulator.destroySession(sess.nativeSessionId);
    } catch {}
    // If the slot currently points at the session we're closing, rebind
    // the slot to whichever session remains so the pane keeps rendering
    // a live terminal instead of flipping to the global fallback.
    if (leafId && paneSessionId === sessId) {
      const remaining = sessions.find((s) => s.id !== sessId);
      setSlotSessionId(leafId, remaining?.id ?? null);
    }
    removeSession(sessId);
  };

  const addTab = () => {
    const newId = addSession();
    if (!newId) return;
    // Bind the freshly-created session to THIS pane so the new tab opens
    // here rather than silently becoming the global active and leaving
    // the clicked pane on its old session.
    if (leafId) setSlotSessionId(leafId, newId);
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroll}
    >
      {sessions.map((sess) => {
        const isActive = sess.id === effectiveActiveId;
        const label = (sess.activeCli ?? 'shell').toUpperCase();
        return (
          <Pressable
            key={sess.id}
            onPress={() => switchTo(sess.id)}
            style={[
              styles.tab,
              isActive && {
                backgroundColor: withAlpha(C.accent, 0.12),
                borderColor: withAlpha(C.accent, 0.55),
              },
            ]}
            hitSlop={4}
          >
            <View
              style={[
                styles.dot,
                { backgroundColor: isActive ? C.accent : C.text3 },
              ]}
            />
            <Text
              style={[
                styles.label,
                { color: isActive ? C.text1 : C.text2 },
              ]}
              numberOfLines={1}
            >
              {label}
            </Text>
            {canClose && isActive && (
              <Pressable
                onPress={(e) => {
                  e.stopPropagation();
                  void closeTab(sess.id);
                }}
                hitSlop={6}
                style={styles.closeBtn}
              >
                <MaterialIcons name="close" size={9} color={C.text2} />
              </Pressable>
            )}
          </Pressable>
        );
      })}
      {canAdd && (
        <Pressable
          onPress={addTab}
          hitSlop={6}
          style={styles.addBtn}
          accessibilityLabel="Add terminal tab"
        >
          <MaterialIcons name="add" size={11} color={C.text2} />
        </Pressable>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 2,
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
  },
  label: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.5,
    maxWidth: 70,
  },
  closeBtn: {
    marginLeft: 2,
    width: 12,
    height: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addBtn: {
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
});
