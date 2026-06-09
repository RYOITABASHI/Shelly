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
import { useWorktreeStore, type WorktreeAgent, type Worktree } from '@/store/worktree-store';
import { useAddPane } from '@/hooks/use-add-pane';
import { useTerminalStore } from '@/store/terminal-store';
import { usePaneStore } from '@/store/pane-store';
import { WorktreeAddModal } from './WorktreeAddModal';
import { SidebarSection } from './SidebarSection';
import { colors as C, fonts as F, padding as P, sizes as S } from '@/theme.config';
import { useTranslation } from '@/lib/i18n';

function agentColor(agent: WorktreeAgent): string {
  return agent === 'none' ? C.text3 : C.accent;
}

function supportedAgent(agent: WorktreeAgent | string): WorktreeAgent {
  return agent === 'codex' ? 'codex' : 'none';
}

/** Phase 2: pick the right CLI invocation for a worktree. Once the agent
 *  has been started at least once in this worktree we want the CLI to
 *  resume its previous conversation instead of a cold start. */
function resumeCommandFor(wt: Worktree): string | null {
  const agent = supportedAgent(wt.agent);
  if (agent === 'none') return null;
  if (!wt.agentStarted) return agent;
  // Codex: `codex --continue` resumes the most recent session in the
  // current directory on supported codex-termux builds.
  return `${agent} --continue`;
}

/** Render "3h ago" / "just now" / "2d ago" for the LastTouched badge. */
function relativeTime(ms: number): string {
  const delta = Math.max(0, Date.now() - ms);
  const sec = Math.floor(delta / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  return `${d}d ago`;
}

type Props = {
  isOpen: boolean;
  onToggle: () => void;
  iconsOnly: boolean;
};

export function WorktreesSection({ isOpen, onToggle, iconsOnly }: Props) {
  const { t } = useTranslation();
  const activeRepoPath = useSidebarStore((s) => s.activeRepoPath);
  const worktrees = useWorktreeStore((s) => s.worktrees);
  const removeWorktree = useWorktreeStore((s) => s.removeWorktree);
  const touch = useWorktreeStore((s) => s.touch);
  const markAgentStarted = useWorktreeStore((s) => s.markAgentStarted);
  const setSession = useWorktreeStore((s) => s.setSession);

  const [addVisible, setAddVisible] = useState(false);
  const [initialAgent, setInitialAgent] = useState<WorktreeAgent>('codex');
  const addPane = useAddPane();

  const repoWorktrees = activeRepoPath
    ? worktrees.filter((w) => w.repoPath === activeRepoPath)
    : [];

  const handleOpen = useCallback(
    (worktreeId: string) => {
      const wt = useWorktreeStore.getState().worktrees.find((w) => w.id === worktreeId);
      if (!wt) return;

      // Phase 3 session pinning: if we spawned a tmux session for this
      // worktree previously, attach to it so the exact bash process (with
      // its env, history, and agent CLI still running) comes back. We
      // delegate the attach dance to `tmux attach-session -t <id>` which
      // returns to the prior TUI immediately on supported builds.
      const addResult = addPane('terminal');
      if (addResult !== null) {
        // Cap reached — Alert shown by useAddPane. Bail out so we don't
        // try to write to a pane that wasn't created.
        return;
      }
      const shellEscapedPath = wt.worktreePath.replace(/'/g, "'\\''");
      const cdCmd = `cd '${shellEscapedPath}'`;
      const agentCmd = resumeCommandFor(wt);

      let fullCmd: string;
      if (wt.sessionId) {
        // Attempt to reattach first; if the session is gone the command
        // falls through to a fresh new-session with the same id so the
        // mapping in the store stays usable next time.
        const s = wt.sessionId.replace(/[^A-Za-z0-9_-]/g, '');
        fullCmd =
          `${cdCmd} && (tmux attach-session -t ${s} 2>/dev/null` +
          ` || tmux new-session -s ${s}${agentCmd ? ` '${agentCmd.replace(/'/g, "'\\''")}'` : ''})`;
      } else {
        // First-open path: spawn a brand new tmux session anchored to
        // this worktree so subsequent taps can attach. The session id is
        // derived from the worktree id so it's stable across app restarts.
        const s = `shelly_${wt.id.replace(/[^A-Za-z0-9_-]/g, '')}`;
        fullCmd = agentCmd
          ? `${cdCmd} && tmux new-session -s ${s} '${agentCmd.replace(/'/g, "'\\''")}'`
          : `${cdCmd} && tmux new-session -s ${s}`;
        setSession(worktreeId, s);
      }

      useTerminalStore.getState().insertCommand(fullCmd);

      // Bind an AI pane (if one exists in the tree) to this worktree so
      // stageAiEdit resolves file paths inside it. Phase 2 plumbing uses
      // the pane-store's agent binding hook.
      const bindAgent = supportedAgent(wt.agent);
      if (bindAgent !== 'none') {
        try {
          const paneAgents = usePaneStore.getState().paneAgents;
          const focused = usePaneStore.getState().focusedPaneId;
          if (focused && paneAgents[focused] == null) {
            usePaneStore.getState().bindAgent(focused, bindAgent);
          }
        } catch { /* pane binding is best-effort */ }
      }

      touch(worktreeId);
      if (bindAgent !== 'none') markAgentStarted(worktreeId);
    },
    [touch, setSession, markAgentStarted, addPane],
  );

  const handleRemove = useCallback(
    (worktreeId: string, branch: string) => {
      Alert.alert(
        t('worktrees.remove_title'),
        t('worktrees.remove_body', { branch }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('common.remove'),
            style: 'destructive',
            onPress: async () => {
              const r = await removeWorktree(worktreeId);
              if (r.error) {
                Alert.alert(t('worktrees.removed_warnings'), r.error);
              }
            },
          },
        ],
      );
    },
    [removeWorktree, t],
  );

  const handleAdd = useCallback((agent: WorktreeAgent) => {
    setInitialAgent(agent);
    setAddVisible(true);
  }, []);

  return (
    <>
      <SidebarSection
        title={t('worktrees.title')}
        icon="call-split"
        isOpen={isOpen}
        onToggle={onToggle}
        iconsOnly={iconsOnly}
      >
        {!activeRepoPath ? (
          <Text style={styles.empty}>
            {t('worktrees.select_repo')}
          </Text>
        ) : repoWorktrees.length === 0 ? (
          <Text style={styles.empty}>
            {t('worktrees.empty')}
          </Text>
        ) : (
          repoWorktrees.map((wt) => {
            const agent = supportedAgent(wt.agent);
            const resumable = wt.agentStarted === true && agent !== 'none';
            return (
              <View key={wt.id} style={styles.row}>
                <Pressable style={styles.rowMain} onPress={() => handleOpen(wt.id)}>
                  <MaterialIcons name="account-tree" size={12} color={agent === 'none' ? C.text2 : C.accent} />
                  <View style={styles.rowText}>
                    <Text style={[styles.branch, { color: agentColor(agent) }]} numberOfLines={1}>
                      {wt.branch}
                    </Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      {relativeTime(wt.lastTouchedAt)}
                      {resumable ? ' · resume' : ''}
                    </Text>
                  </View>
                  {resumable ? (
                    <MaterialIcons name="play-arrow" size={12} color={C.accent} />
                  ) : null}
                </Pressable>
                <Pressable
                  hitSlop={8}
                  onPress={() => handleRemove(wt.id, wt.branch)}
                  style={styles.removeBtn}
                >
                  <MaterialIcons name="close" size={12} color={C.text3} />
                </Pressable>
              </View>
            );
          })
        )}

        {/* Per-agent quick-add buttons — users pick the agent first so the
            default branch name can be agent-prefixed when they hit the
            modal without extra UI. Users who don't care about agent
            binding can still pick "None" inside the modal. */}
        {activeRepoPath ? (
          <View style={styles.addRow}>
            {(['codex'] as WorktreeAgent[]).map((a) => (
              <Pressable
                key={a}
                style={[styles.addChip, { borderColor: agentColor(a) }]}
                onPress={() => handleAdd(a)}
              >
                <Text style={[styles.addChipText, { color: C.accent }]}>+ {a}</Text>
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
  rowText: {
    flex: 1,
    gap: 1,
  },
  branch: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  meta: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    color: C.text3,
    letterSpacing: 0.2,
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
    color: C.text2,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
