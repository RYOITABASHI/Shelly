// components/layout/Sidebar.tsx
import React, { useState, useEffect } from 'react';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import { useFocusStore } from '@/store/focus-store';
import {
  View,
  Text,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  Modal,
  Alert,
  AppState,
  ToastAndroid,
} from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSidebarStore } from '@/store/sidebar-store';
import { useSettingsStore } from '@/store/settings-store';
import { normalizePath } from '@/lib/normalize-path';
import { readDirEntries } from '@/lib/fs-native';
import { logInfo } from '@/lib/debug-logger';
import { nextTriggerMs, lastTriggerMs } from '@/lib/agent-scheduler';
import { useAgentStore } from '@/store/agent-store';
import type { Agent, ToolChoice } from '@/store/types';
import { deleteAgent, installAgent, runAgentNow, syncAgentRunLogsFromDisk, setAgentEnabled, haltAllAgents, resumeAllAgents } from '@/lib/agent-manager';
import { toolChoiceToLabel } from '@/lib/agent-tool-router';
import { readMemoryNotes, type MemoryNote } from '@/lib/agent-memory';
import {
  deleteSkillRecipe,
  distillSkillFromRun,
  readSkillRecipes,
  writeSkillRecipe,
  type SkillRecipe,
} from '@/lib/agent-skills';
import {
  listQuarantinedSkills,
  listImportedSkills,
  promoteSkillFromQuarantine,
  rejectQuarantinedSkill,
  deleteImportedSkill,
  quarantineDir,
  importedDir,
  type QuarantinedSkill,
  type ImportedSkill,
  type RunCommand,
} from '@/lib/skill-import';
import { getHomePath } from '@/lib/home-path';
import { SidebarSection } from './SidebarSection';
import { FileTree } from './FileTree';
import { ProfilesSection } from './ProfilesSection';
import { WorktreesSection } from './WorktreesSection';
import { QuickLaunchSection } from './QuickLaunchSection';
import { CodexSessionsSection } from './CodexSessionsSection';
import { colors as C, fonts as F, sizes as S, padding as P, radii as R } from '@/theme.config';
import { withAlpha } from '@/lib/theme-utils';
import { usePanelBackground } from '@/hooks/use-panel-background';
import { useTranslation } from '@/lib/i18n';

const WIDTH_ICONS = 48;
const WIDTH_HIDDEN = 0;
const TIMING_MS = 200;
const AGENT_RUNNING_POLL_START_DELAY_MS = 15_000;
const AGENT_RUNNING_POLL_INTERVAL_MS = 15_000;
const AGENT_RUNNING_BACKGROUND_POLL_INTERVAL_MS = 60_000;

const QUICK_FOLDERS = [
  { label: '~',        path: '~/',                 icon: 'home' },
  // Agent outputs land under ~/.shelly/agents/<name>/output (+ optional Obsidian
  // Vault mirror). Surface the base so a draft result is one tap away (D).
  { label: 'AGENT',    path: '~/.shelly/agents',   icon: 'smart-toy' },
  { label: 'DCIM',     path: '/sdcard/DCIM',       icon: 'photo-camera' },
  { label: 'DOWNLOAD', path: '/sdcard/Download',   icon: 'download' },
  { label: 'DOCUMENT', path: '/sdcard/Documents',  icon: 'description' },
  { label: 'MUSIC',    path: '/sdcard/Music',      icon: 'music-note' },
] as const;

// Compact local timestamp for the agent reliability block (M/D HH:mm), with a
// relative hint for very recent runs so "did it just run?" is answerable at a glance.
function formatWhen(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const deltaMin = Math.round((Date.now() - ms) / 60000);
  if (deltaMin >= 0 && deltaMin < 60) return `${stamp} (${deltaMin}m ago)`;
  if (deltaMin < 0 && deltaMin > -60) return `${stamp} (in ${-deltaMin}m)`;
  return stamp;
}

function isUiAutonomousTool(tool: ToolChoice): boolean {
  return tool.type === 'cli' || tool.type === 'local';
}

// SKILL-001 row preview length — matches the ~60-80 char range other sidebar
// meta lines use (e.g. showAgentDetail's step/instruction slices).
const IMPORTED_SKILL_DESC_TRUNCATE = 72;
function truncateSkillDescription(description: string): string {
  const trimmed = (description || '').trim();
  return trimmed.length > IMPORTED_SKILL_DESC_TRUNCATE
    ? `${trimmed.slice(0, IMPORTED_SKILL_DESC_TRUNCATE)}…`
    : trimmed;
}

// Local single-quote POSIX shell escaping — same pattern each file that shells
// out defines locally (lib/agent-skills.ts, components/layout/FileTree.tsx).
function shellQuoteSidebar(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function Sidebar() {
  const { t } = useTranslation();
  const { mode, openSections, toggleSection, activeRepoPath, repoPaths, setActiveRepo, setMode, addRepo, removeRepo } =
    useSidebarStore();
  const agents = useAgentStore((s) => s.agents);
  const agentsHalted = useAgentStore((s) => s.halted);
  // Surface the configured Obsidian vault (where collection agents write their dated
  // output folders) as a one-tap DEVICE shortcut, so generated results are easy to
  // open. Falls back to the runtime default when no custom vault path is set.
  const agentVaultPath = useSettingsStore((s) => s.settings.agentVaultPath);
  const deviceFolders = React.useMemo(() => {
    const obsidian = {
      label: 'OBSIDIAN',
      path: (agentVaultPath && agentVaultPath.trim()) || '/sdcard/Documents/ObsidianVault',
      icon: 'menu-book',
    };
    const out: { label: string; path: string; icon: string }[] = [];
    for (const f of QUICK_FOLDERS) {
      out.push(f);
      if (f.label === 'AGENT') out.push(obsidian); // group the two agent-output shortcuts
    }
    return out;
  }, [agentVaultPath]);
  const [runningAgentIds, setRunningAgentIds] = useState<Set<string>>(new Set());
  const [pendingAgentIds, setPendingAgentIds] = useState<Set<string>>(new Set());
  const mountedAtRef = React.useRef(Date.now());
  const wasAgentsSectionOpenRef = React.useRef(mode === 'expanded' && openSections.tasks);
  const [addRepoVisible, setAddRepoVisible] = useState(false);
  const [repoInput, setRepoInput] = useState('');

  /**
   * bug #73: validate a repo path before adding it. Previously the UI
   * accepted any string and stored it, leading to ghost entries that just
   * showed empty file trees and 0 git dirty counts. Now we try to list
   * the directory via JNI readDir (which never throws; it returns an empty
   * array on ENOENT/EACCES) and refuse the add if the readdir yields
   * nothing AND a probe lstat via readDirEntries on the parent also shows
   * the entry is missing. The heuristic is cheap and catches the common
   * mistakes: typos, Termux-era paths, and unmounted SD-card paths.
   */
  const tryAddRepo = async (rawPath: string): Promise<void> => {
    const path = rawPath.trim();
    if (!path) return;
    const normalized = normalizePath(path);
    logInfo('Sidebar', `tryAddRepo raw="${path}" normalized="${normalized}"`);
    // readDirEntries returns [] on missing dir; empty repo is unlikely.
    // To distinguish "empty" from "missing", probe the parent and check
    // whether the basename is present. Still permissive: if the parent is
    // unreadable we fall through and accept the add (likely a permission
    // corner case rather than a typo).
    const slash = normalized.lastIndexOf('/');
    const parent = slash > 0 ? normalized.slice(0, slash) : '/';
    const basename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    let exists = false;
    try {
      const parentEntries = await readDirEntries(parent);
      if (parentEntries.length === 0) {
        // Parent unreadable — fall through and accept the add.
        logInfo('Sidebar', `tryAddRepo parent="${parent}" unreadable, accepting add`);
        exists = true;
      } else {
        exists = parentEntries.some((e) => e.name === basename && (e.type === 'd' || e.type === 'l'));
        logInfo('Sidebar', `tryAddRepo probe parent="${parent}" basename="${basename}" exists=${exists}`);
      }
    } catch (e) {
      logInfo('Sidebar', `tryAddRepo probe threw: ${String(e)}; accepting add`);
      exists = true; // don't block on probe failure
    }
    if (!exists) {
      Alert.alert(
        t('sidebar.directory_not_found_title'),
        t('sidebar.directory_not_found_body', { path }),
      );
      return;
    }
    addRepo(path);
    setActiveRepo(path);
    setRepoInput('');
    setAddRepoVisible(false);
    useFocusStore.getState().requestTerminalRefocus();
  };

  const agentsSectionOpen = mode === 'expanded' && openSections.tasks;
  const pendingAgentCount = pendingAgentIds.size;
  const shouldPollRunningAgents = agents.length > 0 || pendingAgentCount > 0;

  // The FILE TREE section is the only consumer of activeRepoPath; if it is
  // collapsed, selecting a folder (REPOSITORIES or DEVICE shortcut) silently
  // does nothing — "押しても開けない". Expand it on select so the tapped
  // folder's contents actually appear.
  const openFolderInTree = React.useCallback((path: string) => {
    setActiveRepo(path);
    if (!useSidebarStore.getState().openSections.files) {
      toggleSection('files');
    }
  }, [setActiveRepo, toggleSection]);

  // Git dirty-count polling removed 2026-04-21. The count was run against
  // `$HOME` which is not a sane repo context — CLI bg updates, install
  // logs, npm caches, and agent state all counted as "dirty", surfacing
  // alarming 3-digit numbers that did not track any real work in progress.
  // If this returns it should be scoped to a real repo path (a row in
  // REPOSITORIES) and use git's own per-file metadata rather than a
  // porcelain line count.

  // Derive latest completed task per agent from run history
  const refreshRunningAgents = React.useCallback(async () => {
    const result = await TerminalEmulator.execCommand(
      `for f in "$HOME"/.shelly/agents/locks/*.pid; do ` +
        `[ -f "$f" ] || continue; ` +
        `pid="$(cat "$f" 2>/dev/null || true)"; ` +
        `[ -n "$pid" ] || continue; ` +
        `if kill -0 "$pid" 2>/dev/null; then basename "$f" .pid; fi; ` +
      `done`,
      10_000,
    ).catch(() => null);
    const stdout = result?.exitCode === 0 ? result.stdout : '';
    setRunningAgentIds(new Set(stdout.split(/\s+/).filter(Boolean)));
  }, []);

  const runCommandForAgentSync = React.useCallback(async (cmd: string) => {
    const result = await TerminalEmulator.execCommand(cmd, 30_000);
    if (result.exitCode !== 0) throw new Error(result.stderr || `exit ${result.exitCode}`);
    return result.stdout;
  }, []);

  // Phase 2a skill registry: list of saved skills (loaded from disk).
  const [skills, setSkills] = React.useState<SkillRecipe[]>([]);
  const loadSkills = React.useCallback(async () => {
    try {
      setSkills(await readSkillRecipes());
    } catch {
      setSkills([]);
    }
  }, []);
  React.useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  // Gated skill creation: after a successful run, offer to distill it into a
  // reusable skill (user-visible — never silent). Skipped for agents that are
  // already reusing a skill, so we don't re-offer the same recipe.
  const offerSkillSave = React.useCallback((agentId: string) => {
    const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
    if (!agent || agent.skillId) return;
    const latest = useAgentStore.getState().getRunHistory(agentId).at(-1);
    if (!latest || latest.status !== 'success') return;
    Alert.alert(t('sidebar.skill_save_title'), t('sidebar.skill_save_body', { name: agent.name }), [
      {
        text: t('sidebar.skill_save_yes'),
        onPress: () => {
          void (async () => {
            try {
              const recipe = distillSkillFromRun({
                name: agent.name,
                taskText: agent.prompt,
                prompt: agent.prompt,
                routeDecision: latest.routeDecision,
                timestamp: latest.timestamp,
              });
              await writeSkillRecipe(runCommandForAgentSync, recipe);
              await loadSkills();
            } catch (error) {
              Alert.alert(t('sidebar.skill_save_failed_title'), String((error as Error)?.message || error));
            }
          })();
        },
      },
      { text: t('common.cancel'), style: 'cancel' },
    ]);
  }, [t, runCommandForAgentSync, loadSkills]);

  const handleDeleteSkill = React.useCallback(async (skillId: string) => {
    try {
      await deleteSkillRecipe(runCommandForAgentSync, skillId);
      await loadSkills();
    } catch (error) {
      Alert.alert(t('sidebar.skill_save_failed_title'), String((error as Error)?.message || error));
    }
  }, [runCommandForAgentSync, loadSkills, t]);

  const showSkillDetail = React.useCallback((skill: SkillRecipe) => {
    Alert.alert(
      skill.name,
      [
        t('sidebar.skill_uses', { count: skill.successCount }),
        `${skill.route} · ${skill.toolLabel}`,
        '',
        skill.prompt.slice(0, 400),
      ].join('\n'),
      [
        { text: t('sidebar.skill_delete'), style: 'destructive', onPress: () => void handleDeleteSkill(skill.id) },
        { text: t('common.close'), style: 'cancel' },
      ]
    );
  }, [t, handleDeleteSkill]);

  // SKILL-001: locally-imported SKILL.md skills (agentskills.io-style), distinct
  // from the G3 distilled recipes above. Two-stage lifecycle: quarantine (parsed,
  // not yet trusted) → approved (promoted, usable). Both lists are read fresh
  // from disk via lib/skill-import.ts — no separate persisted store.
  const [quarantinedSkills, setQuarantinedSkills] = React.useState<QuarantinedSkill[]>([]);
  const [importedSkills, setImportedSkills] = React.useState<ImportedSkill[]>([]);

  // Shaped exactly like RunCommand — pass straight through to skill-import.ts's
  // mutating calls rather than runCommandForAgentSync, whose string-returning /
  // throw-on-failure shape doesn't match {stdout, stderr, exitCode}.
  const runSkillImportCommand = React.useCallback<RunCommand>(
    (cmd: string) => TerminalEmulator.execCommand(cmd, 30_000),
    [],
  );

  const loadImportedSkills = React.useCallback(async () => {
    const home = getHomePath();
    try {
      const [quarantined, imported] = await Promise.all([
        listQuarantinedSkills(home),
        listImportedSkills(home),
      ]);
      setQuarantinedSkills(quarantined);
      setImportedSkills(imported);
    } catch {
      setQuarantinedSkills([]);
      setImportedSkills([]);
    }
  }, []);
  React.useEffect(() => {
    void loadImportedSkills();
  }, [loadImportedSkills]);

  const handleApproveImportedSkill = React.useCallback(async (name: string) => {
    try {
      const result = await promoteSkillFromQuarantine(name, getHomePath(), runSkillImportCommand);
      if (result.ok) {
        ToastAndroid.show(t('sidebar.skill_approved_toast'), ToastAndroid.SHORT);
        await loadImportedSkills();
      } else {
        Alert.alert(t('sidebar.skill_action_failed_title'), result.error || t('sidebar.skill_action_failed_generic'));
      }
    } catch (error) {
      Alert.alert(t('sidebar.skill_action_failed_title'), String((error as Error)?.message || error));
    }
  }, [runSkillImportCommand, loadImportedSkills, t]);

  const handleRejectImportedSkill = React.useCallback(async (name: string) => {
    try {
      const result = await rejectQuarantinedSkill(name, getHomePath(), runSkillImportCommand);
      if (result.ok) {
        await loadImportedSkills();
      } else {
        Alert.alert(t('sidebar.skill_action_failed_title'), result.error || t('sidebar.skill_action_failed_generic'));
      }
    } catch (error) {
      Alert.alert(t('sidebar.skill_action_failed_title'), String((error as Error)?.message || error));
    }
  }, [runSkillImportCommand, loadImportedSkills, t]);

  const handleRemoveImportedSkill = React.useCallback(async (name: string) => {
    try {
      const result = await deleteImportedSkill(name, getHomePath(), runSkillImportCommand);
      if (result.ok) {
        await loadImportedSkills();
      } else {
        Alert.alert(t('sidebar.skill_action_failed_title'), result.error || t('sidebar.skill_action_failed_generic'));
      }
    } catch (error) {
      Alert.alert(t('sidebar.skill_action_failed_title'), String((error as Error)?.message || error));
    }
  }, [runSkillImportCommand, loadImportedSkills, t]);

  // Tap a row → review dialog. Reads the on-disk bundle's file listing
  // (filenames only, never contents — a bundled scripts/ dir is purely
  // informational here, this UI never offers to run it) so the human can see
  // what ships alongside SKILL.md before approving.
  const showImportedSkillDetail = React.useCallback(async (
    skill: QuarantinedSkill | ImportedSkill,
    status: 'quarantined' | 'approved',
  ) => {
    const home = getHomePath();
    // The skill's own on-disk copy — quarantineDir/importedDir (from
    // lib/skill-import.ts) are where the copy actually lives, NOT
    // QuarantinedSkill.sourcePath (that's the original external path it was
    // imported from, shown separately below as metadata).
    const dirPath = status === 'quarantined'
      ? `${quarantineDir(home)}/${skill.name}`
      : `${importedDir(home)}/${skill.name}`;
    let files: string[] = [];
    try {
      const result = await runSkillImportCommand(`ls -1 ${shellQuoteSidebar(dirPath)} 2>/dev/null`);
      if (result.exitCode === 0) {
        files = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      }
    } catch {
      files = [];
    }

    const lines: string[] = [skill.description];
    if (status === 'quarantined') {
      const q = skill as QuarantinedSkill;
      lines.push('', `${t('sidebar.imported_skill_source')}: ${q.sourcePath}`);
      if (q.warnings.length > 0) {
        lines.push('', `${t('sidebar.imported_skill_warnings')}:`, ...q.warnings.map((w) => `⚠ ${w}`));
      }
    } else {
      const im = skill as ImportedSkill;
      lines.push('', im.body.slice(0, 400));
    }
    lines.push(
      '',
      `${t('sidebar.imported_skill_files')}: ${files.length ? files.join(', ') : t('sidebar.imported_skill_files_none')}`,
    );

    const body = lines.join('\n');

    if (status === 'quarantined') {
      Alert.alert(skill.name, body, [
        { text: t('sidebar.skill_approve'), onPress: () => void handleApproveImportedSkill(skill.name) },
        { text: t('sidebar.skill_reject'), style: 'destructive', onPress: () => void handleRejectImportedSkill(skill.name) },
        { text: t('common.close'), style: 'cancel' },
      ]);
    } else {
      Alert.alert(skill.name, body, [
        { text: t('sidebar.skill_remove'), style: 'destructive', onPress: () => void handleRemoveImportedSkill(skill.name) },
        { text: t('common.close'), style: 'cancel' },
      ]);
    }
  }, [t, runSkillImportCommand, handleApproveImportedSkill, handleRejectImportedSkill, handleRemoveImportedSkill]);

  // Auto-open the quarantine review dialog when a pseudo-shell command (or
  // similar) requests it via settings-store. Single-shot: cleared right after
  // firing (or when no longer found — e.g. already approved/rejected by the
  // time this fires) so re-opening the Sidebar never re-triggers it.
  const pendingSkillApprovalName = useSettingsStore((s) => s.pendingSkillApprovalName);
  React.useEffect(() => {
    if (!pendingSkillApprovalName) return;
    const name = pendingSkillApprovalName;
    (async () => {
      let match = quarantinedSkills.find((s) => s.name === name);
      if (!match) {
        // quarantinedSkills may not have loaded yet (e.g. right after mount/
        // foreground, before loadImportedSkills' async effect resolves) — do
        // one fresh, awaited read before giving up, so a `shelly skill
        // approve <name>` issued right after app resume doesn't silently
        // fail to open the review dialog.
        const fresh = await listQuarantinedSkills(getHomePath());
        match = fresh.find((s) => s.name === name);
      }
      if (match) {
        await showImportedSkillDetail(match, 'quarantined');
      }
      useSettingsStore.getState().setPendingSkillApprovalName(null);
    })();
  }, [pendingSkillApprovalName, quarantinedSkills, showImportedSkillDetail]);

  const handleRunScheduledAgent = React.useCallback(async (agentId: string, agentName: string) => {
    setPendingAgentIds((prev) => new Set(prev).add(agentId));
    try {
      await runAgentNow(agentId, runCommandForAgentSync);
      offerSkillSave(agentId);
      setTimeout(() => void refreshRunningAgents(), 1_000);
      setTimeout(() => void refreshRunningAgents(), 5_000);
      setTimeout(() => {
        void syncAgentRunLogsFromDisk(runCommandForAgentSync, agentId).catch(() => {});
      }, 8_000);
      setTimeout(() => {
        setPendingAgentIds((prev) => {
          const next = new Set(prev);
          next.delete(agentId);
          return next;
        });
      }, 30_000);
    } catch {
      setPendingAgentIds((prev) => {
        const next = new Set(prev);
        next.delete(agentId);
        return next;
      });
      Alert.alert(t('sidebar.agent_failed_title'), t('sidebar.agent_failed_body', { name: agentName }));
    }
  }, [refreshRunningAgents, runCommandForAgentSync, offerSkillSave, t]);

  const handleTogglePause = React.useCallback(async (agent: Agent) => {
    try {
      await setAgentEnabled(agent.id, !agent.enabled, runCommandForAgentSync);
    } catch (error) {
      Alert.alert(t('sidebar.agent_update_failed_title'), String((error as Error)?.message || error));
    }
  }, [runCommandForAgentSync, t]);

  const handleToggleHalt = React.useCallback(async () => {
    const halted = useAgentStore.getState().halted;
    try {
      if (halted) {
        await resumeAllAgents(runCommandForAgentSync);
      } else {
        await haltAllAgents(runCommandForAgentSync);
      }
    } catch (error) {
      Alert.alert(t('sidebar.agent_update_failed_title'), String((error as Error)?.message || error));
    }
  }, [runCommandForAgentSync, t]);

  // Secondary popup: list the agent's saved memory notes (Phase 1).
  const showMemoryList = React.useCallback((agent: Agent, notes: MemoryNote[]) => {
    const body = notes.length
      ? notes
          .slice(0, 20)
          .map((note) => `• [${note.type}] ${note.text.replace(/\s+/g, ' ').slice(0, 160)}`)
          .join('\n\n')
      : t('sidebar.agent_memory_empty');
    Alert.alert(t('sidebar.agent_memory_title', { count: notes.length }), body, [
      { text: t('common.close'), style: 'cancel' },
    ]);
  }, [t]);

  // Tap an agent row → full detail popup (the row only has room for the name).
  const showAgentDetail = React.useCallback(async (agent: Agent) => {
    const lastLog = useAgentStore.getState().getRunHistory(agent.id).at(-1);
    const routeDecision = lastLog?.routeDecision;
    const routeDetail = routeDecision
      ? [
          `${t('sidebar.agent_route')}: ${routeDecision.route} / ${routeDecision.toolLabel}`,
          `${t('sidebar.agent_route_guard')}: ${routeDecision.guard}`,
          routeDecision.keyword ? `${t('sidebar.agent_route_keyword')}: ${routeDecision.keyword}` : null,
          routeDecision.secretKinds?.length
            ? `${t('sidebar.agent_route_secret')}: ${routeDecision.secretKinds.join(', ')}`
            : null,
          routeDecision.noCloudFallback ? t('sidebar.agent_route_no_cloud') : null,
          routeDecision.score
            ? `${t('sidebar.agent_route_score', { confidence: Math.round(routeDecision.score.confidence * 100) })}: ${routeDecision.score.candidates.map((c) => `${c.toolType} ${c.score}`).join(', ')}`
            : null,
          `${t('sidebar.agent_route_why')}: ${routeDecision.why}`,
        ].filter(Boolean).join('\n')
      : '';
    // Memory is best-effort: a read failure must not block the detail popup.
    let memoryNotes: MemoryNote[] = [];
    try {
      memoryNotes = await readMemoryNotes(agent.id);
    } catch {
      memoryNotes = [];
    }
    const meta = [
      agent.schedule || t('sidebar.agent_manual'),
      agent.action?.type ?? 'draft',
      toolChoiceToLabel(agent.tool),
      agent.autonomous ? t('sidebar.agent_autonomous') : null,
      agent.enabled ? null : t('sidebar.agent_paused'),
    ].filter(Boolean).join(' · ');
    // Phase 4: when the agent is multi-step, show the planned chain; and if the
    // last run was orchestrated, show each step's status.
    const plannedSteps = agent.orchestration?.steps ?? [];
    const stepDetail = lastLog?.steps?.length
      ? `${t('sidebar.agent_steps', { count: lastLog.steps.length })}\n${lastLog.steps
          .map((s) => `  ${s.index + 1}. [${s.status}] ${s.instruction.slice(0, 60)}`)
          .join('\n')}`
      : plannedSteps.length >= 2
      ? `${t('sidebar.agent_steps', { count: plannedSteps.length })}\n${plannedSteps
          .map((s, i) => `  ${i + 1}. ${s.slice(0, 60)}`)
          .join('\n')}`
      : '';
    // Reliability block (proof-of-execution): next scheduled run, last run (time ·
    // status · duration · error), and a MISSED-RUN warning when a scheduled fire was
    // due but never recorded a run — the trust signal that surfaces OEM/Doze kills
    // ("it silently didn't fire") instead of letting them pass unnoticed.
    const relLines: string[] = [];
    if (agent.schedule && agent.enabled) {
      relLines.push(`${t('sidebar.agent_next_run')}: ${formatWhen(nextTriggerMs(agent.schedule))}`);
    }
    if (lastLog) {
      const dur = lastLog.durationMs ? ` · ${Math.round(lastLog.durationMs / 1000)}s` : '';
      relLines.push(`${t('sidebar.agent_last_run')}: ${formatWhen(lastLog.timestamp)} · ${lastLog.status}${dur}`);
      if (lastLog.status === 'error' && lastLog.errorMessage) {
        relLines.push(`${t('sidebar.agent_last_error')}: ${lastLog.errorMessage.slice(0, 160)}`);
      } else if (lastLog.outputPreview) {
        relLines.push(`— ${lastLog.outputPreview.slice(0, 120)}`);
      }
    } else {
      relLines.push(t('sidebar.agent_never_run'));
    }
    if (agent.schedule && agent.enabled) {
      const lastExpected = lastTriggerMs(agent.schedule);
      const lastActual = agent.lastRun ?? lastLog?.timestamp ?? agent.createdAt;
      const GRACE = 5 * 60 * 1000;
      if (lastExpected != null && lastExpected < Date.now() - GRACE && lastExpected > lastActual + GRACE) {
        relLines.push(`⚠ ${t('sidebar.agent_missed_run', { when: formatWhen(lastExpected) })}`);
      }
    }
    const reliability = relLines.join('\n');
    const body = [
      (agent.prompt || agent.description || '').trim(),
      '',
      meta,
      reliability,
      `${t('sidebar.agent_memory_title', { count: memoryNotes.length })}`,
      stepDetail,
      routeDetail,
    ].filter(Boolean).join('\n');
    const buttons = [
      { text: t('sidebar.agent_run_now'), onPress: () => void handleRunScheduledAgent(agent.id, agent.name) },
      { text: agent.enabled ? t('sidebar.agent_pause') : t('sidebar.agent_resume'), onPress: () => void handleTogglePause(agent) },
      ...(memoryNotes.length
        ? [{ text: t('sidebar.agent_memory_view'), onPress: () => showMemoryList(agent, memoryNotes) }]
        : []),
      { text: t('common.close'), style: 'cancel' as const },
    ];
    Alert.alert(agent.name, body, buttons);
  }, [t, handleRunScheduledAgent, handleTogglePause, showMemoryList]);

  const persistAgentUpdate = React.useCallback(async (agent: Agent, partial: Partial<Agent>) => {
    const updated = { ...agent, ...partial };
    useAgentStore.getState().updateAgent(agent.id, partial);
    try {
      await installAgent(updated, runCommandForAgentSync);
    } catch (error) {
      useAgentStore.getState().updateAgent(agent.id, {
        autonomous: agent.autonomous,
        autonomyLevel: agent.autonomyLevel,
        workspaceRoot: agent.workspaceRoot,
        tool: agent.tool,
      });
      Alert.alert(t('sidebar.agent_update_failed_title'), error instanceof Error ? error.message : String(error));
    }
  }, [runCommandForAgentSync, t]);

  const applyAutonomousMode = React.useCallback(async (agent: Agent, enabled: boolean, forceCodex = false) => {
    const nextTool: ToolChoice = forceCodex ? { type: 'cli', cli: 'codex' } : agent.tool;
    await persistAgentUpdate(agent, {
      autonomous: enabled || undefined,
      autonomyLevel: enabled ? (agent.autonomyLevel ?? 'L2') : undefined,
      tool: nextTool,
    });
  }, [persistAgentUpdate]);

  const handleToggleAutonomous = React.useCallback((agent: Agent) => {
    const enabled = !agent.autonomous;
    if (!enabled) {
      void applyAutonomousMode(agent, false);
      return;
    }

    if (isUiAutonomousTool(agent.tool)) {
      void applyAutonomousMode(agent, true);
      return;
    }

    Alert.alert(
      t('sidebar.autonomous_tool_restricted_title'),
      t('sidebar.autonomous_tool_restricted_body', { tool: toolChoiceToLabel(agent.tool) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('sidebar.autonomous_use_codex'),
          onPress: () => void applyAutonomousMode(agent, true, true),
        },
      ],
    );
  }, [applyAutonomousMode, t]);

  useEffect(() => {
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    let startTimer: ReturnType<typeof setTimeout> | null = null;
    const becameVisible = agentsSectionOpen && !wasAgentsSectionOpenRef.current;
    wasAgentsSectionOpenRef.current = agentsSectionOpen;
    const pollIntervalMs = agentsSectionOpen
      ? AGENT_RUNNING_POLL_INTERVAL_MS
      : AGENT_RUNNING_BACKGROUND_POLL_INTERVAL_MS;
    const refreshIfMounted = async () => {
      if (!cancelled) await refreshRunningAgents();
    };
    const stopPolling = () => {
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
      if (interval) { clearInterval(interval); interval = null; }
    };
    const startPolling = (immediate: boolean) => {
      if (!shouldPollRunningAgents) return;
      if (startTimer || interval) return;
      const remainingDelay = Math.max(
        0,
        AGENT_RUNNING_POLL_START_DELAY_MS - (Date.now() - mountedAtRef.current),
      );
      startTimer = setTimeout(() => {
        startTimer = null;
        if (cancelled || AppState.currentState !== 'active') return;
        void refreshIfMounted();
        interval = setInterval(refreshIfMounted, pollIntervalMs);
      }, immediate ? 0 : remainingDelay);
    };

    startPolling(becameVisible || pendingAgentCount > 0);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') startPolling(agentsSectionOpen);
      else stopPolling();
    });
    return () => {
      cancelled = true;
      stopPolling();
      sub.remove();
    };
  }, [agents.length, agentsSectionOpen, pendingAgentCount, refreshRunningAgents, shouldPollRunningAgents]);

  const runningAgents = agents.filter((a) => runningAgentIds.has(a.id) || pendingAgentIds.has(a.id));

  const targetWidth =
    mode === 'expanded' ? S.sidebarWidth : mode === 'icons' ? WIDTH_ICONS : WIDTH_HIDDEN;

  const animatedStyle = useAnimatedStyle(() => ({
    width: withTiming(targetWidth, { duration: TIMING_MS }),
    overflow: 'hidden',
  }));

  const iconsOnly = mode === 'icons';

  function handleToggle() {
    if (mode === 'expanded') setMode('icons');
    else setMode('expanded');
  }

  // usePanelBackground MUST be called before any early return to satisfy
  // Rules of Hooks. It picks up wallpaper state from cosmetic-store and
  // returns either the solid C.bgSidebar or a half-alpha variant when
  // the user has a wallpaper set.
  const sidebarBg = usePanelBackground(C.bgSidebar);

  if (mode === 'hidden') return null;

  return (
    <Animated.View style={[styles.container, animatedStyle, { backgroundColor: sidebarBg, borderRightColor: C.border }]}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* TASKS */}
        <SidebarSection
          title={t('sidebar.tasks')}
          icon="task-alt"
          isOpen={openSections.tasks}
          onToggle={() => toggleSection('tasks')}
          badge={runningAgents.length}
          iconsOnly={iconsOnly}
        >
          {agents.length > 0 && (
            <>
              <View style={styles.agentsSubheaderRow}>
                <Text style={styles.tasksSubheader}>{t('sidebar.agents')}</Text>
                <Pressable
                  onPress={() => void handleToggleHalt()}
                  hitSlop={8}
                  style={[styles.agentModePill, styles.agentHaltPillBase, agentsHalted && styles.agentHaltPillOn]}
                  accessibilityRole="switch"
                  accessibilityState={{ checked: agentsHalted }}
                  accessibilityLabel={t(agentsHalted ? 'sidebar.resume_all_a11y' : 'sidebar.stop_all_a11y')}
                >
                  <MaterialIcons
                    name={agentsHalted ? 'play-arrow' : 'stop'}
                    size={11}
                    color={agentsHalted ? C.bgDeep : C.errorText}
                  />
                  <Text style={[styles.agentModeText, agentsHalted && styles.agentHaltTextOn]}>
                    {t(agentsHalted ? 'sidebar.resume_all' : 'sidebar.stop_all')}
                  </Text>
                </Pressable>
              </View>
              {agents.map((agent) => (
                <View
                  key={`agent-${agent.id}`}
                  style={[styles.taskRow, styles.agentRow, (!agent.enabled || agentsHalted) && styles.agentRowDisabled]}
                >
                  <View style={[styles.taskDot, { backgroundColor: agent.autonomous ? C.accent : C.text3 }]} />
                  <Pressable
                    style={styles.taskInfo}
                    onPress={() => void showAgentDetail(agent)}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.agent_detail_a11y', { name: agent.name })}
                  >
                    <Text style={styles.taskName} numberOfLines={1}>
                      {(agent.name || '').toUpperCase()}
                    </Text>
                    <Text style={styles.taskMeta} numberOfLines={1}>
                      {agent.autonomous ? '⛓ ' : ''}{agent.schedule || t('sidebar.agent_manual')} · {agent.action?.type ?? 'draft'}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void handleRunScheduledAgent(agent.id, agent.name)}
                    hitSlop={8}
                    style={styles.tasksAction}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.run_agent_now_a11y', { name: agent.name })}
                  >
                    <MaterialIcons name="play-arrow" size={12} color={C.accent} />
                  </Pressable>
                  <Pressable
                    onPress={() => handleToggleAutonomous(agent)}
                    hitSlop={8}
                    style={[
                      styles.agentModePill,
                      agent.autonomous && styles.agentModePillOn,
                    ]}
                    accessibilityRole="switch"
                    accessibilityState={{ checked: !!agent.autonomous }}
                    accessibilityLabel={t('sidebar.autonomous_toggle_a11y', { name: agent.name })}
                  >
                    <Text style={[
                      styles.agentModeText,
                      agent.autonomous && styles.agentModeTextOn,
                    ]}>
                      AUTO
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      Alert.alert(
                        t('sidebar.delete_agent_title'),
                        t('sidebar.delete_agent_body', { name: agent.name }),
                        [
                          { text: t('common.cancel'), style: 'cancel' },
                          {
                            text: t('common.delete'),
                            style: 'destructive',
                            onPress: async () => {
                              // deleteAgent removes the store entry only on a
                              // confirmed on-disk delete; surface failures instead
                              // of dropping the row while the json survives (which
                              // would reappear on restart).
                              try {
                                await deleteAgent(agent.id);
                              } catch (e) {
                                Alert.alert(t('sidebar.delete_agent_failed'), String(e));
                              }
                            },
                          },
                        ],
                      );
                    }}
                    hitSlop={8}
                    style={styles.tasksAction}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.delete_agent_a11y', { name: agent.name })}
                  >
                    <MaterialIcons name="delete-outline" size={12} color={C.text2} />
                  </Pressable>
                </View>
              ))}
            </>
          )}
          {agents.length === 0 && (
            <Text style={styles.tasksEmpty}>
              {t('sidebar.tasks_empty')}
            </Text>
          )}
        </SidebarSection>

        {/* SKILLS (Phase 2a) — reusable recipes distilled from successful runs. */}
        <SidebarSection
          title={t('sidebar.skills')}
          icon="auto-awesome"
          isOpen={openSections.skills ?? false}
          onToggle={() => toggleSection('skills')}
          badge={skills.length}
          iconsOnly={iconsOnly}
        >
          {skills.length > 0 ? (
            skills.map((skill) => (
              <View key={`skill-${skill.id}`} style={[styles.taskRow, styles.agentRow]}>
                <View style={[styles.taskDot, { backgroundColor: C.accent }]} />
                <Pressable
                  style={styles.taskInfo}
                  onPress={() => showSkillDetail(skill)}
                  accessibilityRole="button"
                  accessibilityLabel={t('sidebar.skill_detail_a11y', { name: skill.name })}
                >
                  <Text style={styles.taskName} numberOfLines={1}>{(skill.name || '').toUpperCase()}</Text>
                  <Text style={styles.taskMeta} numberOfLines={1}>
                    {t('sidebar.skill_uses', { count: skill.successCount })} · {skill.toolLabel}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => void handleDeleteSkill(skill.id)}
                  hitSlop={8}
                  style={styles.tasksAction}
                  accessibilityRole="button"
                  accessibilityLabel={t('sidebar.skill_delete_a11y', { name: skill.name })}
                >
                  <MaterialIcons name="delete-outline" size={12} color={C.text2} />
                </Pressable>
              </View>
            ))
          ) : (
            <Text style={styles.tasksEmpty}>{t('sidebar.skill_empty')}</Text>
          )}
        </SidebarSection>

        {/* IMPORTED SKILLS (SKILL-001) — SKILL.md skills imported from local
            sources, gated by human quarantine review before becoming usable.
            Sibling to SKILLS (G3 distilled recipes) above — deliberately not
            merged, different provenance and life-cycle. */}
        <SidebarSection
          title={t('sidebar.imported_skills_title')}
          icon="verified"
          isOpen={openSections.importedSkills ?? false}
          onToggle={() => toggleSection('importedSkills')}
          badge={quarantinedSkills.length + importedSkills.length}
          iconsOnly={iconsOnly}
        >
          {quarantinedSkills.length === 0 && importedSkills.length === 0 ? (
            <Text style={styles.tasksEmpty}>{t('sidebar.imported_skills_empty')}</Text>
          ) : (
            <>
              {quarantinedSkills.map((skill) => (
                <View key={`quarantined-skill-${skill.name}`} style={[styles.taskRow, styles.agentRow]}>
                  <View style={[styles.taskDot, { backgroundColor: C.warning }]} />
                  <Pressable
                    style={styles.taskInfo}
                    onPress={() => void showImportedSkillDetail(skill, 'quarantined')}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.imported_skill_detail_a11y', { name: skill.name })}
                  >
                    <Text style={styles.taskName} numberOfLines={1}>{(skill.name || '').toUpperCase()}</Text>
                    <Text style={styles.taskMeta} numberOfLines={1}>
                      {truncateSkillDescription(skill.description)}
                    </Text>
                  </Pressable>
                </View>
              ))}
              {importedSkills.map((skill) => (
                <View key={`imported-skill-${skill.name}`} style={[styles.taskRow, styles.agentRow]}>
                  <View style={[styles.taskDot, { backgroundColor: C.accentGreen }]} />
                  <Pressable
                    style={styles.taskInfo}
                    onPress={() => void showImportedSkillDetail(skill, 'approved')}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.imported_skill_detail_a11y', { name: skill.name })}
                  >
                    <Text style={styles.taskName} numberOfLines={1}>{(skill.name || '').toUpperCase()}</Text>
                    <Text style={styles.taskMeta} numberOfLines={1}>
                      {truncateSkillDescription(skill.description)}
                    </Text>
                  </Pressable>
                </View>
              ))}
            </>
          )}
        </SidebarSection>

        {/* QUICK LAUNCH — one-tap CLI shortcuts
            into a fresh Terminal pane. Sits between TASKS and REPOSITORIES
            so the most-used "I just want a REPL right now" affordance is
            top of the sidebar, mirroring Apple Superset's CLI launch row. */}
        <QuickLaunchSection
          isOpen={openSections.quickLaunch ?? true}
          onToggle={() => toggleSection('quickLaunch')}
          iconsOnly={iconsOnly}
        />

        <CodexSessionsSection
          isOpen={openSections.codexSessions ?? true}
          onToggle={() => toggleSection('codexSessions')}
          iconsOnly={iconsOnly}
        />

        {/* REPOSITORIES */}
        <SidebarSection
          title={t('sidebar.repositories')}
          icon="folder"
          isOpen={openSections.repos}
          onToggle={() => toggleSection('repos')}
          iconsOnly={iconsOnly}
        >
          {repoPaths.length === 0 ? (
            <Text style={styles.emptyRepoHint}>
              {t('sidebar.no_repositories')}
            </Text>
          ) : (
            repoPaths.map((p) => {
              const isActive = p === activeRepoPath;
              const name = p.replace(/^.*\//, '') || p;
              return (
                <Pressable
                  key={p}
                  style={[
                    styles.repoRow,
                    isActive && styles.repoRowActive,
                    isActive && {
                      backgroundColor: withAlpha(C.accent, 0.08),
                      borderLeftColor: C.accent,
                    },
                  ]}
                  onPress={() => openFolderInTree(p)}
                  onLongPress={() => {
                    Alert.alert(
                      t('sidebar.remove_repository_title'),
                      t('sidebar.remove_repository_body', { name }),
                      [
                        { text: t('common.cancel'), style: 'cancel' },
                        { text: t('common.remove'), style: 'destructive', onPress: () => removeRepo(p) },
                      ],
                    );
                  }}
                  delayLongPress={350}
                >
                  <View style={[styles.repoIcon, { backgroundColor: isActive ? C.accent : C.btnSecondaryBg }]}>
                    <MaterialIcons
                      name="folder"
                      size={10}
                      color={isActive ? C.bgDeep : C.text2}
                    />
                  </View>
                  <Text
                    style={[styles.repoName, { color: isActive ? C.accent : C.text2 }]}
                    numberOfLines={1}
                  >
                    {name.toUpperCase()}
                  </Text>
                  {isActive && (
                    <Text style={[styles.repoVersion, { color: C.accent }]}>V9.2</Text>
                  )}
                </Pressable>
              );
            })
          )}
          <Pressable style={styles.addRow} onPress={() => setAddRepoVisible(true)}>
            <Text style={[styles.addRowText, { color: C.accent }]}>{t('sidebar.add_repository')}</Text>
          </Pressable>
        </SidebarSection>

        {/* WORKTREES — parallel agent branches for the active repo (Phase 1).
            Lives directly under REPOSITORIES because it's a child concept: a
            worktree is always anchored to a specific repo. */}
        <WorktreesSection
          isOpen={openSections.worktrees}
          onToggle={() => toggleSection('worktrees')}
          iconsOnly={iconsOnly}
        />

        {/* FILE TREE */}
        <SidebarSection
          title={t('sidebar.file_tree')}
          icon="description"
          isOpen={openSections.files}
          onToggle={() => toggleSection('files')}
          iconsOnly={iconsOnly}
        >
          <FileTree />
        </SidebarSection>

        {/* DEVICE */}
        <SidebarSection
          title={t('sidebar.device')}
          icon="stay-current-portrait"
          isOpen={openSections.device}
          onToggle={() => toggleSection('device')}
          iconsOnly={iconsOnly}
        >
          {deviceFolders.map(({ label, path, icon }) => (
            <Pressable
              key={path}
              style={styles.deviceRow}
              onPress={() => openFolderInTree(path)}
            >
              <MaterialIcons name={icon as any} size={13} color={C.text2} />
              <Text style={styles.deviceLabel} numberOfLines={1} ellipsizeMode="tail">
                {label}
              </Text>
            </Pressable>
          ))}
        </SidebarSection>

        {/* PORTS — live /proc/net/tcp{,6} scan every 15s (see useEffect above) */}
        {/* PROFILES */}
        <SidebarSection
          title={t('sidebar.profiles')}
          icon="person-outline"
          isOpen={openSections.profiles}
          onToggle={() => toggleSection('profiles')}
          iconsOnly={iconsOnly}
        >
          <ProfilesSection />
        </SidebarSection>
      </ScrollView>

      {/* Add repository modal */}
      <Modal
        visible={addRepoVisible}
        transparent
        animationType="fade"
        onRequestClose={() => { setAddRepoVisible(false); useFocusStore.getState().requestTerminalRefocus(); }}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => { setAddRepoVisible(false); useFocusStore.getState().requestTerminalRefocus(); }}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>{t('sidebar.add_repo_title')}</Text>
            <TextInput
              style={styles.modalInput}
              value={repoInput}
              onChangeText={setRepoInput}
              placeholder="~/projects/my-repo"
              placeholderTextColor={C.text2}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              onSubmitEditing={() => void tryAddRepo(repoInput)}
            />
            <View style={styles.modalBtns}>
              <Pressable
                style={styles.modalCancelBtn}
                onPress={() => { setRepoInput(''); setAddRepoVisible(false); useFocusStore.getState().requestTerminalRefocus(); }}
              >
                <Text style={styles.modalCancelText}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable
                style={[styles.modalAddBtn, { backgroundColor: C.accent }]}
                onPress={() => void tryAddRepo(repoInput)}
              >
                <Text style={styles.modalAddText}>{t('common.add')}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Collapse toggle */}
      <Pressable
        style={[styles.toggleBtn, { borderTopColor: C.border }]}
        onPress={handleToggle}
        hitSlop={8}
      >
        <MaterialIcons
          name={mode === 'expanded' ? 'chevron-left' : 'chevron-right'}
          size={20}
          color={C.text2}
        />
        {!iconsOnly && (
          <Text style={styles.toggleLabel}>{t('sidebar.collapse')}</Text>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'column',
    borderRightWidth: S.borderWidth,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 8,
  },
  // Tasks
  taskRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: P.sidebarItem.px,
    height: S.sidebarItemHeight,
    gap: 5,
  },
  taskRowPressed: {
    backgroundColor: withAlpha(C.accent, 0.08),
  },
  agentRow: {
    minHeight: 34,
    height: 'auto',
    paddingVertical: 4,
  },
  tasksSeparator: {
    height: 1,
    backgroundColor: C.border,
    marginHorizontal: P.sidebarItem.px,
    marginVertical: 2,
  },
  tasksSubheader: {
    fontFamily: F.family,
    fontSize: 7,
    color: C.text3,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 2,
    letterSpacing: 0.5,
  },
  tasksAction: {
    paddingHorizontal: 3,
  },
  tasksEmpty: {
    fontFamily: F.family,
    fontSize: 8,
    color: C.text3,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 4,
    letterSpacing: 0.3,
  },
  taskDot: {
    width: S.agentDotSize,
    height: S.agentDotSize,
    borderRadius: S.agentDotSize / 2,
  },
  taskInfo: {
    flex: 1,
  },
  taskAge: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text2,
    letterSpacing: 0.3,
  },
  taskLogBadge: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: R.badge,
    backgroundColor: withAlpha('#F87171', 0.18),
  },
  taskLogBadgeText: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    color: '#F87171',
    letterSpacing: 0.5,
  },
  taskName: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text1,
    letterSpacing: 0.3,
  },
  taskMeta: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text3,
    letterSpacing: 0.2,
    marginTop: 1,
  },
  agentModePill: {
    minWidth: 28,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: R.badge,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    backgroundColor: 'transparent',
  },
  agentModePillOn: {
    borderColor: C.accent,
    backgroundColor: withAlpha(C.accent, 0.18),
  },
  agentsSubheaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  agentHaltPillBase: {
    flexDirection: 'row',
    gap: 3,
    paddingHorizontal: 6,
  },
  agentHaltPillOn: {
    borderColor: C.errorText,
    backgroundColor: withAlpha(C.errorText, 0.85),
  },
  agentHaltTextOn: {
    color: C.bgDeep,
  },
  agentRowDisabled: {
    opacity: 0.5,
  },
  agentModeText: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.text3,
    letterSpacing: 0.3,
  },
  agentModeTextOn: {
    color: C.accent,
  },
  statusBadge: {
    paddingHorizontal: P.statusBadge.px,
    paddingVertical: P.statusBadge.py,
    borderRadius: R.badge,
    backgroundColor: withAlpha(C.text2, 0.12),
  },
  statusBadgeText: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.badge.weight,
    letterSpacing: 0.5,
    color: C.text2,
  },
  // Repos
  repoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: P.sidebarItem.px,
    height: S.sidebarItemHeight,
    borderRadius: R.badge,
    // Always reserve 2px on the left so toggling isActive does not shift
    // the row horizontally — the only thing that changes is the colour.
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  repoRowActive: {
    backgroundColor: withAlpha(C.text1, 0.08),
    borderLeftColor: C.text2,
  },
  repoIcon: {
    width: 14,
    height: 14,
    borderRadius: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  repoName: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 0.5,
    flex: 1,
  },
  repoVersion: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text3,
  },
  emptyRepoHint: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    color: C.text2,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontStyle: 'italic',
    lineHeight: 14,
  },
  addRow: {
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: P.sidebarItem.py,
  },
  addRowText: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text2,
    letterSpacing: 0.3,
  },
  // Device
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: P.sidebarItem.px,
    height: S.sidebarItemHeight,
  },
  deviceLabel: {
    flex: 1,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text2,
    letterSpacing: 0.3,
  },
  // Ports
  // (cloudSpacer was reused here historically; inline flex:1 View now.)
  // Ports
  portRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: P.sidebarItem.px,
    height: S.sidebarItemHeight,
  },
  portDot: {
    width: S.agentDotSize,
    height: S.agentDotSize,
    borderRadius: S.agentDotSize / 2,
    backgroundColor: C.text2,
  },
  portLabel: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.text1,
  },
  portName: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: F.sidebarItem.weight,
    color: C.text2,
  },
  portEmpty: {
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    color: C.text3,
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 6,
    letterSpacing: 0.3,
  },
  // Toggle
  toggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    borderTopWidth: S.borderWidth,
    gap: 4,
  },
  toggleLabel: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    color: C.text2,
  },
  // Modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: 280,
    backgroundColor: C.bgSurface,
    borderRadius: 10,
    padding: 16,
    borderWidth: S.borderWidth,
    borderColor: C.border,
  },
  modalTitle: {
    color: C.text2,
    fontSize: F.contextBar.size,
    fontFamily: F.family,
    fontWeight: '700',
    letterSpacing: 1,
    marginBottom: 12,
  },
  modalInput: {
    height: 36,
    backgroundColor: C.bgDeep,
    borderRadius: 6,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    paddingHorizontal: 10,
    fontFamily: F.family,
    fontSize: 12,
    color: C.text1,
    marginBottom: 12,
  },
  modalBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  modalCancelBtn: {
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 6,
    borderRadius: R.agentTab,
    backgroundColor: C.btnSecondaryBg,
  },
  modalCancelText: {
    color: C.btnSecondaryText,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
  },
  modalAddBtn: {
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 6,
    borderRadius: R.agentTab,
    backgroundColor: C.text1,
  },
  modalAddText: {
    color: C.bgDeep,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
  },
});
