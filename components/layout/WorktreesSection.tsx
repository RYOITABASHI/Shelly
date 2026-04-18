// components/layout/WorktreesSection.tsx
//
// Phase 1 Worktrees UI. One accordion section in the sidebar that lists
// worktrees for the currently active repository and lets the user add or
// remove them. Tapping a row opens a fresh Terminal pane, cd's into the
// worktree, and (if an agent is bound) launches the matching CLI.
//
// Explicitly out of scope for Phase 1:
//   - cross-repo worktree registry
//   - merge / diff / discard UI beyond a confirm-and-delete
//   - immortal session pinning per worktree (wait on bug #65 Case B)

import React, { useCallback, useState } from 'react';
import { View, Text, Pressable, Alert, StyleSheet } from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSidebarStore } from '@/store/sidebar-store';
import { useWorktreeStore, type WorktreeAgent } from '@/store/worktree-store';
import { useMultiPaneStore } from '@/hooks/use-multi-pane';
import { useTerminalStore } from '@/store/terminal-store';
import { WorktreeAddModal } from './WorktreeAddModal';
import { SidebarSection } from './SidebarSection';
import { colors as C, fonts as F, padding as P, sizes as S } from '@/theme.config';

const AGENT_COLORS: Record<WorktreeAgent, string> = {
  claude: '#A78BFA',
  gemini: '#60A5FA',
  codex:  '#22C55E',
  none:   '#9CA3AF',
};

const AGENT_EMOJI: Record<WorktreeAgent, string> = {
  claude: '🟣',
  gemini: '🔵',
  codex:  '🟢',
  none:   '⚪',
};

type Props = {
  isOpen: boolean;
  onToggle: () => void;
  iconsOnly: boolean;
};

export function WorktreesSection({ isOpen, onToggle, iconsOnly }: Props) {
  const activeRepoPath = useSidebarStore((s) => s.activeRepoPath);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const removeWorktree = useWorktreeStore((s) => s.removeWorktree);
  const touch = useWorktreeStore((s) => s.touch);

  const [addVisible, setAddVisible] = useState(false);
  const [initialAgent, setInitialAgent] = useState<WorktreeAgent>('claude');

  const repoWorktrees = activeRepoPath
    ? worktrees.filter((w) => w.repoPath === activeRepoPath)
    : [];

  const handleOpen = useCallback(
    (worktreeId: string) => {
      const wt = useWorktreeStore.getState().worktrees.find((w) => w.id === worktreeId);
      if (!wt) return;

      // Mint a fresh terminal pane and queue a `cd` (plus the agent CLI
      // when one is bound) to run as soon as the session is alive. The
      // insertCommand / pendingCommand plumbing on terminal-store already
      // handles the "wait for prompt → write" dance for us (bug #63).
      useMultiPaneStore.getState().addPane('terminal');
      const shellEscapedPath = wt.worktreePath.replace(/'/g, "'\\''");
      const cdCmd = `cd '${shellEscapedPath}'`;
      const fullCmd =
        wt.agent === 'none' ? cdCmd : `${cdCmd} && ${wt.agent}`;
      useTerminalStore.getState().insertCommand(fullCmd);
      touch(worktreeId);
    },
    [touch],
  );

  const handleRemove = useCallback(
    (worktreeId: string, branch: string) => {
      Alert.alert(
        'Remove worktree',
        `Remove the "${branch}" worktree? The branch itself will not be deleted.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              const r = await removeWorktree(worktreeId);
              if (r.error) {
                Alert.alert('Removed with warnings', r.error);
              }
            },
          },
        ],
      );
    },
    [removeWorktree],
  );

  const handleAdd = useCallback((agent: WorktreeAgent) => {
    setInitialAgent(agent);
    setAddVisible(true);
  }, []);

  return (
    <>
      <SidebarSection
        title="WORKTREES"
        icon="call-split"
        isOpen={isOpen}
        onToggle={onToggle}
        iconsOnly={iconsOnly}
      >
        {!activeRepoPath ? (
          <Text style={styles.empty}>
            Select a repository to manage worktrees.
          </Text>
        ) : repoWorktrees.length === 0 ? (
          <Text style={styles.empty}>
            No worktrees yet. Add one per agent to work in parallel.
          </Text>
        ) : (
          repoWorktrees.map((wt) => (
            <View key={wt.id} style={styles.row}>
              <Pressable style={styles.rowMain} onPress={() => handleOpen(wt.id)}>
                <Text style={styles.emoji}>{AGENT_EMOJI[wt.agent]}</Text>
                <Text style={[styles.branch, { color: AGENT_COLORS[wt.agent] }]} numberOfLines={1}>
                  {wt.branch}
                </Text>
              </Pressable>
              <Pressable
                hitSlop={8}
                onPress={() => handleRemove(wt.id, wt.branch)}
                style={styles.removeBtn}
              >
                <MaterialIcons name="close" size={12} color={C.text3} />
              </Pressable>
            </View>
          ))
        )}

        {/* Per-agent quick-add buttons — users pick the agent first so the
            default branch name can be agent-prefixed when they hit the
            modal without extra UI. Users who don't care about agent
            binding can still pick "None" inside the modal. */}
        {activeRepoPath ? (
          <View style={styles.addRow}>
            {(['claude', 'gemini', 'codex'] as WorktreeAgent[]).map((a) => (
              <Pressable
                key={a}
                style={[styles.addChip, { borderColor: AGENT_COLORS[a] }]}
                onPress={() => handleAdd(a)}
              >
                <Text style={styles.addChipEmoji}>{AGENT_EMOJI[a]}</Text>
                <Text style={[styles.addChipText, { color: AGENT_COLORS[a] }]}>+ {a}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </SidebarSection>

      <WorktreeAddModal
        visible={addVisible}
        repoPath={activeRepoPath}
        initialAgent={initialAgent}
        onClose={() => setAddVisible(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  empty: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    color: C.text3,
    fontStyle: 'italic',
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 6,
    lineHeight: 13,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: P.sidebarItem.px,
    height: S.sidebarItemHeight,
    gap: 6,
  },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  emoji: {
    fontSize: 10,
  },
  branch: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.3,
    flex: 1,
  },
  removeBtn: {
    padding: 4,
  },
  addRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 4,
  },
  addChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 3,
    backgroundColor: 'transparent',
  },
  addChipEmoji: {
    fontSize: 9,
  },
  addChipText: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
