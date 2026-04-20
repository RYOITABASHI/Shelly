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
 * Tap to switch active session; long-press is handled by TerminalPane's
 * own Reset/Close flow so nothing is lost.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet, ScrollView } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useTerminalStore } from '@/store/terminal-store';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { colors as C, fonts as F } from '@/theme.config';

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
};

export default function PaneCliTabs({ paneSessionId }: Props = {}) {
  const sessions = useTerminalStore((s) => s.sessions);
  const globalActiveSessionId = useTerminalStore((s) => s.activeSessionId);
  const setActiveSession = useTerminalStore((s) => s.setActiveSession);
  const addSession = useTerminalStore((s) => s.addSession);
  const removeSession = useTerminalStore((s) => s.removeSession);

  // Prefer the pane-scoped session id. Fall back to the global one only for
  // legacy call sites (e.g. non-pane usage) that haven't threaded the prop
  // yet — this keeps backward compatibility.
  const effectiveActiveId = paneSessionId ?? globalActiveSessionId;

  const canAdd = sessions.length < MAX_TABS;
  const canClose = sessions.length > 1;

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
            onPress={() => setActiveSession(sess.id)}
            style={[styles.tab, isActive && styles.tabActive]}
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
                onPress={async (e) => {
                  e.stopPropagation();
                  try {
                    await TerminalEmulator.destroySession(sess.nativeSessionId);
                  } catch {}
                  removeSession(sess.id);
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
          onPress={() => addSession()}
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
  tabActive: {
    backgroundColor: 'rgba(0,212,170,0.08)',
    borderColor: 'rgba(0,212,170,0.35)',
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
