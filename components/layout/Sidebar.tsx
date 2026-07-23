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
import Animated, { useAnimatedStyle, useSharedValue, withTiming, withSequence, Easing } from 'react-native-reanimated';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useSidebarStore } from '@/store/sidebar-store';
import { useSettingsStore } from '@/store/settings-store';
import { normalizePath } from '@/lib/normalize-path';
import { readDirEntries } from '@/lib/fs-native';
import { logInfo } from '@/lib/debug-logger';
import { nextTriggerMs, isScheduleMissed } from '@/lib/agent-scheduler';
import { useAgentStore } from '@/store/agent-store';
import type { Agent, ToolChoice } from '@/store/types';
import { deleteAgent, installAgent, runAgentNow, stopAgent, syncAgentRunLogsFromDisk, setAgentEnabled, haltAllAgents, resumeAllAgents } from '@/lib/agent-manager';
import { toolChoiceToLabel } from '@/lib/agent-tool-router';
import { normalizeSteps } from '@/lib/agent-orchestration';
import { readMemoryNotes, type MemoryNote } from '@/lib/agent-memory';
import { openFile } from '@/lib/open-file';
import { formatElapsedMs } from '@/lib/agent-running-format';
import { useMotion } from '@/hooks/use-motion';
import { parseNotificationTriggerPackages } from '@/lib/notification-trigger';
import {
  deleteSkillRecipe,
  readSkillRecipes,
  type SkillRecipe,
} from '@/lib/agent-skills';
import { useSkillSaveOffer } from '@/hooks/use-skill-save-offer';
import { AgentCapabilitiesModal } from '@/components/layout/AgentCapabilitiesModal';
import {
  listQuarantinedSkills,
  listImportedSkills,
  importSkillToQuarantine,
  importSkillFromPickedFile,
  pickedSkillFileAsset,
  importSkillContentToQuarantine,
  promoteSkillFromQuarantine,
  rejectQuarantinedSkill,
  deleteImportedSkill,
  quarantineDir,
  importedDir,
  type QuarantinedSkill,
  type ImportedSkill,
  type RunCommand,
} from '@/lib/skill-import';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import {
  fetchSkillCatalogManifest,
  fetchCatalogSkillContent,
  type SkillCatalogEntry,
  type SkillCatalogManifest,
} from '@/lib/skill-catalog';
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
import { useMultiPaneStore, type SlotIndex } from '@/hooks/use-multi-pane';
import { usePaneStore } from '@/store/pane-store';
import { useAIPaneStore } from '@/store/ai-pane-store';
import { agentToParsedAgentDraft } from '@/lib/agent-draft-patch';
import { summarizeAgentDraftAsText, hasDraftAssumptions } from '@/lib/agent-plan-summary';

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

// RUNNING sub-section (Fable5 UX consultation, 2026-07-21): live detail for
// each agent currently holding a lock file, gathered in the same batched poll
// as refreshRunningAgents' `kill -0` check — see that callback below for the
// shell command that populates this per agent.
interface RunningAgentDetail {
  /** Lock file mtime, ms since epoch — when the run was picked up. Null if
   *  `stat` failed (should not normally happen once the lock file exists). */
  lockMtimeMs: number | null;
  /** Parsed $LOG_DIR/current.json, only for the same-script Codex
   *  orchestration chain (lib/agent-executor.ts). Absent for the far more
   *  common JS-driven per-step orchestration path (agent-manager.ts's
   *  runAgentOrchestrated) — that is NOT an error, just no live step detail. */
  currentStep: { step: number; total: number; tool: string; startedAtMs: number } | null;
}

// Stall thresholds (proposed by the 2026-07-21 Fable5 UX consultation): a row
// with a live current.json step marker uses the marker's OWN startedAt (a
// single step rarely runs this long even though the overall lock may be
// older across several steps); a row with no marker falls back to the lock's
// own age, which is the only signal available for the JS-driven orchestrated
// path or a single-step run.
const RUNNING_STALL_THRESHOLD_NO_MARKER_MS = 8 * 60_000;
const RUNNING_STALL_THRESHOLD_WITH_MARKER_MS = 10 * 60_000;


// SKILL-001 row preview length — matches the ~60-80 char range other sidebar
// meta lines use (e.g. showAgentDetail's step/instruction slices).
const IMPORTED_SKILL_DESC_TRUNCATE = 72;

// SKILL-002: prefix stamped onto a catalog-sourced quarantine entry's
// sourcePath metadata, so showImportedSkillDetail's "Source" line reads
// "catalog:<name>" instead of a local filesystem path — makes the
// provenance visible during the mandatory human review step.
const SKILL_CATALOG_SOURCE_PREFIX = 'catalog:';

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
  // Project owner directive 2026-07-14: runtime per-action approval defaults
  // to OFF (no human tap). Removing that mandatory gate must not remove
  // visibility into which mode an agent will actually run under — see the
  // agentApprovalLabel() row/detail-popup usage below.
  const defaultRequireActionApproval = useSettingsStore((s) => s.settings.defaultRequireActionApproval === true);
  const agentApprovalLabel = React.useCallback(
    (agent: Agent) =>
      t((agent.requireActionApproval ?? defaultRequireActionApproval)
        ? 'sidebar.agent_approval_manual'
        : 'sidebar.agent_approval_auto'),
    [t, defaultRequireActionApproval],
  );
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
  const [runningAgentDetails, setRunningAgentDetails] = useState<Record<string, RunningAgentDetail>>({});
  const [pendingAgentIds, setPendingAgentIds] = useState<Set<string>>(new Set());
  const mountedAtRef = React.useRef(Date.now());
  const wasAgentsSectionOpenRef = React.useRef(mode === 'expanded' && openSections.tasks);
  // Task D: TASKS is always the first ScrollView child, so "scroll it into
  // view" is a plain scroll-to-top — no per-section y-offset tracking needed.
  const scrollRef = React.useRef<ScrollView>(null);
  const { reduceMotion: runningHighlightReduceMotion } = useMotion();
  const runningHighlightOpacity = useSharedValue(0);
  const runningHighlightStyle = useAnimatedStyle(() => ({ opacity: runningHighlightOpacity.value }));
  const [addRepoVisible, setAddRepoVisible] = useState(false);
  const [repoInput, setRepoInput] = useState('');
  const [notifTriggerAgent, setNotifTriggerAgent] = useState<Agent | null>(null);
  const [notifTriggerDraft, setNotifTriggerDraft] = useState('');
  const [agentCapabilitiesVisible, setAgentCapabilitiesVisible] = useState(false);

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

  // Derive latest completed task per agent from run history. Also batches in
  // (Task B) the lock file's mtime (`stat -c %Y`, same pattern already used
  // by lib/agent-executor.ts for its own staleness checks) and — best-effort —
  // the per-agent $LOG_DIR/current.json live step marker, so the RUNNING
  // sub-section never needs a second round-trip per agent. One tab-separated
  // line per running agent: `<id>\t<lockMtimeEpochSec>\t<current.json line>`.
  const refreshRunningAgents = React.useCallback(async () => {
    const result = await TerminalEmulator.execCommand(
      `for f in "$HOME"/.shelly/agents/locks/*.pid; do ` +
        `[ -f "$f" ] || continue; ` +
        `pid="$(cat "$f" 2>/dev/null || true)"; ` +
        `[ -n "$pid" ] || continue; ` +
        `if kill -0 "$pid" 2>/dev/null; then ` +
          `id="$(basename "$f" .pid)"; ` +
          `mtime="$(stat -c %Y "$f" 2>/dev/null || echo 0)"; ` +
          `cur="$HOME/.shelly/agents/logs/$id/current.json"; ` +
          `curline=""; ` +
          `[ -f "$cur" ] && curline="$(tr -d '\\n' < "$cur" 2>/dev/null)"; ` +
          `printf '%s\\t%s\\t%s\\n' "$id" "$mtime" "$curline"; ` +
        `fi; ` +
      `done`,
      10_000,
    ).catch(() => null);
    const stdout = result?.exitCode === 0 ? result.stdout : '';
    const ids: string[] = [];
    const details: Record<string, RunningAgentDetail> = {};
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line) continue;
      const tab1 = line.indexOf('\t');
      const tab2 = tab1 >= 0 ? line.indexOf('\t', tab1 + 1) : -1;
      const id = tab1 >= 0 ? line.slice(0, tab1) : line;
      if (!id) continue;
      const mtimeStr = tab1 >= 0 ? line.slice(tab1 + 1, tab2 >= 0 ? tab2 : undefined) : '';
      const curJson = tab2 >= 0 ? line.slice(tab2 + 1) : '';
      ids.push(id);
      const mtimeSec = Number(mtimeStr);
      const lockMtimeMs = Number.isFinite(mtimeSec) && mtimeSec > 0 ? mtimeSec * 1000 : null;
      let currentStep: RunningAgentDetail['currentStep'] = null;
      if (curJson) {
        try {
          const parsed = JSON.parse(curJson);
          if (
            parsed && typeof parsed.step === 'number' && typeof parsed.total === 'number' &&
            typeof parsed.tool === 'string' && typeof parsed.startedAt === 'number'
          ) {
            currentStep = { step: parsed.step, total: parsed.total, tool: parsed.tool, startedAtMs: parsed.startedAt * 1000 };
          }
        } catch {
          // Malformed/partial current.json (e.g. read mid-write, or an older
          // script version) — best-effort only, never blocks the row.
        }
      }
      details[id] = { lockMtimeMs, currentStep };
    }
    setRunningAgentIds(new Set(ids));
    setRunningAgentDetails(details);
    // Task A: mirror into agent-store so AgentBar's RunningAgentsChip (and any
    // other future consumer) observes run state without its own poll.
    useAgentStore.getState().setRunningAgentIds(ids);
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
  // reusable skill (user-visible — never silent). Shared with the one-shot
  // @agent chat flow (use-ai-pane-dispatch.ts) via hooks/use-skill-save-offer.
  const { offerSkillSave: offerSkillSaveForRun } = useSkillSaveOffer({
    runCommand: runCommandForAgentSync,
    onSaved: loadSkills,
  });
  // Agent-id shaped wrapper for call sites here — resolves the agent + its
  // latest run log from the store (still-registered scheduled agent), then
  // defers to the shared gate (skipped for agents already reusing a skill).
  const offerSkillSave = React.useCallback((agentId: string) => {
    const agent = useAgentStore.getState().agents.find((a) => a.id === agentId);
    if (!agent) return;
    const latest = useAgentStore.getState().getRunHistory(agentId).at(-1);
    offerSkillSaveForRun({
      name: agent.name,
      prompt: agent.prompt,
      routeDecision: latest?.routeDecision,
      timestamp: latest?.timestamp,
      status: latest?.status,
      alreadySkillId: agent.skillId,
    });
  }, [offerSkillSaveForRun]);

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

  // Inline "+ IMPORT SKILL" form (SKILL-001 import trigger). The user types a
  // path to a SKILL.md folder (the terminal-first flow: git clone / curl it
  // into place first, then paste the path here) — no native file picker.
  // Same expand/collapse + saving-flag shape as SettingsDropdown's
  // CustomAuthRefsSection, adapted to Sidebar's narrower rows.
  const [skillImportOpen, setSkillImportOpen] = React.useState(false);
  const [skillImportPath, setSkillImportPath] = React.useState('');
  const [skillImporting, setSkillImporting] = React.useState(false);

  const handleImportSkill = React.useCallback(async () => {
    const path = skillImportPath.trim();
    if (!path) return;
    setSkillImporting(true);
    try {
      // Path-shape validation (absolute or ~) lives in importSkillToQuarantine
      // itself — its errors are surfaced below, not duplicated here.
      const result = await importSkillToQuarantine(path, runSkillImportCommand);
      if (result.ok) {
        setSkillImportPath('');
        setSkillImportOpen(false);
        ToastAndroid.show(
          t('sidebar.skill_import_success', { name: result.name ?? path }),
          ToastAndroid.SHORT,
        );
        await loadImportedSkills();
      } else {
        // Keep the form open (input intact) so the user can fix and retry.
        const lines = [...result.errors, ...result.warnings.map((w) => `⚠ ${w}`)];
        Alert.alert(
          t('sidebar.skill_action_failed_title'),
          lines.join('\n') || t('sidebar.skill_action_failed_generic'),
        );
      }
    } catch (error) {
      Alert.alert(t('sidebar.skill_action_failed_title'), String((error as Error)?.message || error));
    } finally {
      setSkillImporting(false);
    }
  }, [skillImportPath, runSkillImportCommand, loadImportedSkills, t]);

  // SAF alternative to the path-paste flow above: a user who has NOT granted
  // MANAGE_EXTERNAL_STORAGE (first-launch-setup.ts's broad, all-files
  // permission — see bug #92) can still import a single SKILL.md this way,
  // because expo-document-picker's system picker grants a scoped, per-file
  // content:// URI read permission that needs no special permission at all.
  // Mirrors SettingsDropdown.tsx's importPets (Scouter pet-ZIP import), the
  // other SAF-based import flow in this app. Both paths land in the exact
  // same quarantine → approve/reject lifecycle; only the source-read side
  // differs (shell `cat` on a pasted path vs. a picker-granted URI read
  // here).
  const handlePickSkillFile = React.useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/markdown', 'text/plain', 'application/octet-stream', '*/*'],
        copyToCacheDirectory: true,
      });
      const asset = pickedSkillFileAsset(result);
      if (!asset) return;
      setSkillImporting(true);
      try {
        const raw = await FileSystem.readAsStringAsync(asset.uri);
        const importResult = await importSkillFromPickedFile(raw, runSkillImportCommand);
        if (importResult.ok) {
          setSkillImportPath('');
          setSkillImportOpen(false);
          ToastAndroid.show(
            t('sidebar.skill_import_success', { name: importResult.name ?? asset.name }),
            ToastAndroid.SHORT,
          );
          await loadImportedSkills();
        } else {
          const lines = [...importResult.errors, ...importResult.warnings.map((w) => `⚠ ${w}`)];
          Alert.alert(
            t('sidebar.skill_action_failed_title'),
            lines.join('\n') || t('sidebar.skill_action_failed_generic'),
          );
        }
      } finally {
        setSkillImporting(false);
      }
    } catch (error) {
      Alert.alert(t('sidebar.skill_action_failed_title'), String((error as Error)?.message || error));
    }
  }, [runSkillImportCommand, loadImportedSkills, t]);

  // "Browse catalog" (curated first-party skill catalog, sibling to the
  // path-based import above). Fetched lazily on open, mirroring
  // BuildsModal.tsx's on-visible refresh pattern rather than eagerly polling
  // GitHub on every Sidebar mount. Adding an entry routes through the exact
  // same importSkillContentToQuarantine → quarantine → approve/reject review
  // as a manually-dropped SKILL.md — see lib/skill-catalog.ts's module doc.
  const [catalogModalVisible, setCatalogModalVisible] = React.useState(false);
  const [catalogLoading, setCatalogLoading] = React.useState(false);
  const [catalogError, setCatalogError] = React.useState<string | null>(null);
  const [catalogManifest, setCatalogManifest] = React.useState<SkillCatalogManifest | null>(null);
  const [catalogAddingName, setCatalogAddingName] = React.useState<string | null>(null);

  const loadCatalog = React.useCallback(async () => {
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const manifest = await fetchSkillCatalogManifest();
      if (!manifest) {
        setCatalogManifest(null);
        setCatalogError(t('sidebar.skill_catalog_unavailable'));
      } else {
        setCatalogManifest(manifest);
      }
    } catch (error) {
      setCatalogManifest(null);
      setCatalogError(String((error as Error)?.message || error));
    } finally {
      setCatalogLoading(false);
    }
  }, [t]);

  const openCatalogModal = React.useCallback(() => {
    setCatalogModalVisible(true);
    if (!catalogManifest && !catalogLoading) void loadCatalog();
  }, [catalogManifest, catalogLoading, loadCatalog]);

  const handleAddCatalogSkill = React.useCallback(async (entry: SkillCatalogEntry) => {
    setCatalogAddingName(entry.name);
    try {
      const downloaded = await fetchCatalogSkillContent(entry);
      if (!downloaded.ok || !downloaded.content) {
        Alert.alert(
          t('sidebar.skill_action_failed_title'),
          downloaded.error || t('sidebar.skill_action_failed_generic'),
        );
        return;
      }
      // sourceLabel identifies this as catalog-sourced (not a local path) in
      // the quarantine review dialog's "Source" line — same
      // showImportedSkillDetail rendering the path-based flow uses.
      const result = await importSkillContentToQuarantine(
        downloaded.content,
        entry.name,
        `${SKILL_CATALOG_SOURCE_PREFIX}${entry.name}`,
        runSkillImportCommand,
      );
      if (result.ok) {
        ToastAndroid.show(
          t('sidebar.skill_import_success', { name: result.name ?? entry.name }),
          ToastAndroid.SHORT,
        );
        await loadImportedSkills();
      } else {
        const lines = [...result.errors, ...result.warnings.map((w) => `⚠ ${w}`)];
        Alert.alert(
          t('sidebar.skill_action_failed_title'),
          lines.join('\n') || t('sidebar.skill_action_failed_generic'),
        );
      }
    } catch (error) {
      Alert.alert(t('sidebar.skill_action_failed_title'), String((error as Error)?.message || error));
    } finally {
      setCatalogAddingName(null);
    }
  }, [runSkillImportCommand, loadImportedSkills, t]);

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
    // Concurrency-race investigation (2026-07-17/18, agent-mrorpolq): this is
    // the single choke point BOTH RUN NOW triggers (the agent row's play-arrow
    // Pressable and the detail-popup Alert's "Run Now" button) call — neither
    // had a guard, so a double-tap/ghost-tap could fire two overlapping runs
    // for the same agent before the first one's own materialize/run-log
    // writes landed. `pendingAgentIds`/`runningAgentIds` were already tracked
    // for the "running agents" list display but never read here to block a
    // re-entrant press. lib/agent-manager.ts's runAgentNow now also dedupes
    // concurrent calls for the same agentId at the JS level (a second call
    // joins the in-flight one instead of starting its own), so this is
    // defense in depth — it also avoids a silently-wasted duplicate press.
    if (pendingAgentIds.has(agentId) || runningAgentIds.has(agentId)) return;
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
  }, [refreshRunningAgents, runCommandForAgentSync, offerSkillSave, t, pendingAgentIds, runningAgentIds]);

  // Task B STOP button: reuses lib/agent-executor.ts's generateStopCommand
  // (via agent-manager's stopAgent wrapper) — the same kill+lock-cleanup
  // logic lib/agent-manager.ts's stopAgent() already exposes for a different
  // call site, rather than hand-rolling a new kill command here. Re-polls
  // immediately afterward so the row disappears without waiting out the next
  // scheduled 15s/60s poll tick.
  const handleStopRunningAgent = React.useCallback(async (agentId: string, agentName: string) => {
    try {
      await stopAgent(agentId, runCommandForAgentSync);
    } catch {
      Alert.alert(t('sidebar.agent_stop_failed_title'), t('sidebar.agent_stop_failed_body', { name: agentName }));
    } finally {
      void refreshRunningAgents();
    }
  }, [runCommandForAgentSync, refreshRunningAgents, t]);

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
      agentApprovalLabel(agent),
    ].filter(Boolean).join(' · ');
    // Phase 4: when the agent is multi-step, show the planned chain; and if the
    // last run was orchestrated, show each step's status. Phase 5: a step may
    // pin a concrete tool — normalizeSteps handles both the legacy plain-string
    // shape and the { instruction, tool? } shape, and surfacing the pinned
    // tool's label here is the transparency a later "no per-run approval by
    // default" policy needs (the user can see up front which steps skip
    // auto-routing and which backend they'll actually use).
    const plannedSteps = normalizeSteps(agent.orchestration);
    const stepDetail = lastLog?.steps?.length
      ? `${t('sidebar.agent_steps', { count: lastLog.steps.length })}\n${lastLog.steps
          .map((s) => `  ${s.index + 1}. [${s.status}] ${s.instruction.slice(0, 60)}`)
          .join('\n')}`
      : plannedSteps.length >= 2
      ? `${t('sidebar.agent_steps', { count: plannedSteps.length })}\n${plannedSteps
          .map((s, i) => `  ${i + 1}. ${s.instruction.slice(0, 60)}${s.tool ? ` (${toolChoiceToLabel(s.tool)})` : ''}`)
          .join('\n')}`
      : '';
    // Reliability block (proof-of-execution): next scheduled run, last run (time ·
    // status · duration · error), and a MISSED-RUN warning when a scheduled fire was
    // due but never recorded a run — the trust signal that surfaces OEM/Doze kills
    // ("it silently didn't fire") instead of letting them pass unnoticed.
    const relLines: string[] = [];
    // Task C: hoisted out of the `if (lastLog)` block below so the buttons
    // array (which closes over it, outside that block's narrowing) gets a
    // plain `string | undefined` instead of re-deriving it unsafely.
    const savedPath: string | undefined = lastLog?.savedPath;
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
      // Task C (Fable5 UX consultation, 2026-07-21): agent-executor.ts now
      // records the resolved primary destination for a successful draft
      // save into the run log — surface it here so "where did it go" is
      // answerable from the detail popup, not just the completion toast.
      if (lastLog.savedPath) {
        relLines.push(t('sidebar.agent_saved_path', { path: lastLog.savedPath }));
      }
    } else {
      relLines.push(t('sidebar.agent_never_run'));
    }
    if (agent.schedule && agent.enabled) {
      const lastActual = agent.lastRun ?? lastLog?.timestamp ?? agent.createdAt;
      const { missed, expectedAt } = isScheduleMissed(agent.schedule, lastActual, agent.createdAt);
      if (missed && expectedAt != null) {
        relLines.push(`⚠ ${t('sidebar.agent_missed_run', { when: formatWhen(expectedAt) })}`);
      }
    }
    // P1-B (2026-07-15 scheduling-reliability audit): exact-alarm special
    // access can be revoked at any time AFTER registration (the user backs
    // out of the grant in Settings, or an OEM resets it) — surface a LATER
    // revocation here too, not just the one-time registration-time nudge, so
    // a silent downgrade to a drifting inexact alarm is never invisible.
    // Best-effort: a native round-trip failure must not block the popup.
    if (agent.schedule && agent.enabled) {
      try {
        const exactAlarmGranted = await TerminalEmulator.canScheduleExactAlarms();
        if (!exactAlarmGranted) {
          relLines.push(`⚠ ${t('sidebar.agent_exact_alarm_missing')}`);
        }
      } catch {
        // ignore — health indicator only, never blocks the detail popup
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
      { text: t('common.edit'), onPress: () => {
        const multiPane = useMultiPaneStore.getState();
        let aiSlot = multiPane.slots.find((slot) => slot?.tab === 'ai') ?? null;
        if (aiSlot) {
          const slotIndex = multiPane.slots.findIndex((slot) => slot?.id === aiSlot!.id);
          if (slotIndex >= 0) multiPane.focusSlot(slotIndex as SlotIndex);
          usePaneStore.getState().setFocusedPane(aiSlot.id);
        } else {
          if (multiPane.addPane('ai') !== null) return;
          const next = useMultiPaneStore.getState();
          aiSlot = next.slots[next.focusedSlot];
        }
        if (!aiSlot) return;
        const draft = agentToParsedAgentDraft(agent);
        const now = Date.now();
        const messageId = `agent-edit-${now.toString(36)}`;
        const chatStore = useAIPaneStore.getState();
        chatStore.addMessage(aiSlot.id, {
          id: messageId,
          role: 'assistant',
          content: summarizeAgentDraftAsText(draft, undefined, true),
          timestamp: now,
          agentDraft: draft,
          agentChatConfirm: true,
        });
        chatStore.setPendingAgentSession(aiSlot.id, {
          draft,
          editingAgentId: agent.id,
          phase: 'await-confirm',
          attemptCounts: {},
          hasAssumptions: hasDraftAssumptions(draft),
          createdAt: now,
          messageId,
        });
      } },
      ...(memoryNotes.length
        ? [{ text: t('sidebar.agent_memory_view'), onPress: () => showMemoryList(agent, memoryNotes) }]
        : []),
      // Task C: a single extra button (not two) to keep this Alert.alert's
      // button count in check — "Open" was picked over "Copy path" because
      // it reuses lib/open-file.ts's existing MarkdownPane/Preview routing,
      // the same one-tap-to-result path the DEVICE section's AGENT/OBSIDIAN
      // shortcuts already promise.
      ...(savedPath
        ? [{ text: t('sidebar.agent_saved_path_open'), onPress: () => void openFile(savedPath) }]
        : []),
    ];
    // 2026-07-23: on-device test found the CLOSE button missing from this
    // dialog on Android after the Edit button (above) was added — Android's
    // native AlertDialog only has 3 real button slots (RN's Alert.alert
    // silently drops anything past the 3rd on Android, with no warning
    // visible at runtime), so Run Now / Pause / Edit already filled every
    // slot even in the common case (no memory notes, no saved path), pushing
    // Close off the dialog entirely. slice(0, 3) makes the truncation
    // deterministic and priority-ordered (Run Now > Pause > Edit > Memory >
    // Open path) instead of relying on RN's undocumented Android drop order.
    //
    // No explicit Close button is added back — instead the dialog is made
    // dismissible via tap-outside/Back. CORRECTION (also found on-device,
    // same session): react-native's Alert.js hardcodes
    // `cancelable: false` on Android UNLESS an `options` object with
    // `cancelable: true` is explicitly passed (see node_modules/react-native/
    // Libraries/Alert/Alert.js) — omitting `options` entirely, as this call
    // did right after the first fix, does NOT default to cancelable; it
    // defaults to NOT dismissible at all. `{ cancelable: true }` below is
    // therefore required, not optional decoration.
    //
    // A real fix — replacing this Alert.alert with a custom bottom sheet
    // that supports more than 3 actions — is tracked in DEFERRED.md.
    Alert.alert(agent.name, body, buttons.slice(0, 3), { cancelable: true });
  }, [t, handleRunScheduledAgent, handleTogglePause, showMemoryList, agentApprovalLabel]);

  const persistAgentUpdate = React.useCallback(async (agent: Agent, partial: Partial<Agent>) => {
    const updated = { ...agent, ...partial };
    useAgentStore.getState().updateAgent(agent.id, partial);
    try {
      await installAgent(updated, runCommandForAgentSync);
    } catch (error) {
      const rollback: Partial<Agent> = {};
      for (const key of Object.keys(partial) as (keyof Agent)[]) {
        (rollback as any)[key] = agent[key];
      }
      useAgentStore.getState().updateAgent(agent.id, rollback);
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

  // Task D: react to AgentBar's RunningAgentsChip tap (sidebar-store's
  // requestFocusRunningAgents() already force-opens TASKS and bumps this
  // counter — the store action's own doc comment names this exact effect as
  // its intended, previously-missing consumer). Skip the value present at
  // mount so opening the app never triggers a spurious scroll/flash.
  const focusRunningAgentsRequestId = useSidebarStore((s) => s.focusRunningAgentsRequestId);
  const focusRunningAgentsMountedRef = React.useRef(false);
  React.useEffect(() => {
    if (!focusRunningAgentsMountedRef.current) {
      focusRunningAgentsMountedRef.current = true;
      return;
    }
    scrollRef.current?.scrollTo({ y: 0, animated: !runningHighlightReduceMotion });
    if (runningHighlightReduceMotion) return; // static — no flash, matches AgentBar's chip dot
    runningHighlightOpacity.value = withSequence(
      withTiming(0.35, { duration: 180, easing: Easing.out(Easing.cubic) }),
      withTiming(0, { duration: 700, easing: Easing.in(Easing.cubic) }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRunningAgentsRequestId]);

  const runningAgents = agents.filter((a) => runningAgentIds.has(a.id) || pendingAgentIds.has(a.id));

  // Task B: RUNNING sub-section rows — only agents confirmed live via the
  // `kill -0` lock check (not merely pending/optimistic), each paired with
  // its batched detail from refreshRunningAgents. Recomputed every render
  // (cheap: at most a handful of agents), so it stays in sync with both the
  // poll tick and the 15s/60s interval without extra memoization machinery.
  const runningSectionRows = Array.from(runningAgentIds).map((id) => {
    const agent = agents.find((a) => a.id === id);
    const detail = runningAgentDetails[id];
    const now = Date.now();
    const lockElapsedMs = detail?.lockMtimeMs != null ? Math.max(0, now - detail.lockMtimeMs) : null;
    const currentStep = detail?.currentStep ?? null;
    const stepElapsedMs = currentStep ? Math.max(0, now - currentStep.startedAtMs) : null;
    const stallReferenceMs = stepElapsedMs ?? lockElapsedMs ?? 0;
    const stallThresholdMs = currentStep
      ? RUNNING_STALL_THRESHOLD_WITH_MARKER_MS
      : RUNNING_STALL_THRESHOLD_NO_MARKER_MS;
    const stalled = stallReferenceMs > stallThresholdMs;
    const displayElapsedMs = lockElapsedMs ?? stepElapsedMs ?? 0;
    return { id, agent, currentStep, displayElapsedMs, stalled };
  });

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
        ref={scrollRef}
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
          <View style={styles.agentsSubheaderRow}>
            <Text style={styles.tasksSubheader}>{t('sidebar.agents')}</Text>
            <View style={styles.agentsSubheaderActions}>
              <Pressable
                onPress={() => setAgentCapabilitiesVisible(true)}
                hitSlop={8}
                style={styles.agentHelpBtn}
                accessibilityRole="button"
                accessibilityLabel={t('sidebar.agent_capabilities_a11y')}
              >
                <MaterialIcons name="help-outline" size={12} color={C.text2} />
              </Pressable>
              {agents.length > 0 && (
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
              )}
            </View>
          </View>

          {/* RUNNING — Task B (Fable5 UX consultation, 2026-07-21). Distinct
              sub-section above the full agent list, only when at least one
              agent currently holds a live lock. Wrapped in an Animated
              highlight overlay that Task D's focusRunningAgentsRequestId
              effect flashes when the AgentBar chip is tapped. */}
          {runningSectionRows.length > 0 && (
            <View style={styles.runningSectionWrap}>
              <Animated.View
                pointerEvents="none"
                style={[styles.runningSectionHighlightOverlay, runningHighlightStyle, { backgroundColor: C.accent }]}
              />
              <Text style={styles.tasksSubheader}>{t('sidebar.running')}</Text>
              {runningSectionRows.map(({ id, agent, currentStep, displayElapsedMs, stalled }) => {
                const name = (agent?.name || id).toUpperCase();
                const elapsed = formatElapsedMs(displayElapsedMs);
                const metaText = stalled
                  ? t('sidebar.agent_running_stalled', { elapsed })
                  : currentStep
                  ? t('sidebar.agent_running_step', { step: currentStep.step, total: currentStep.total, tool: currentStep.tool, elapsed })
                  : t('sidebar.agent_running_plain', { elapsed });
                return (
                  <View
                    key={`running-${id}`}
                    style={[styles.taskRow, styles.agentRow, styles.runningRow, stalled && styles.runningRowStalled]}
                  >
                    <View style={[styles.taskDot, { backgroundColor: stalled ? C.warning : C.accent }]} />
                    <View style={styles.taskInfo}>
                      <Text style={styles.taskName} numberOfLines={1}>{name}</Text>
                      <Text
                        style={[styles.taskMeta, stalled && styles.runningMetaStalled]}
                        numberOfLines={1}
                      >
                        {metaText}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => void handleStopRunningAgent(id, agent?.name || id)}
                      hitSlop={8}
                      style={[styles.runningStopBtn, stalled && styles.runningStopBtnStalled]}
                      accessibilityRole="button"
                      accessibilityLabel={t('sidebar.agent_stop_a11y', { name: agent?.name || id })}
                    >
                      <MaterialIcons name="stop" size={11} color={stalled ? C.bgDeep : C.errorText} />
                      <Text style={[styles.runningStopBtnText, stalled && styles.runningStopBtnTextStalled]}>
                        {t('sidebar.agent_stop')}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
              <View style={styles.tasksSeparator} />
            </View>
          )}

          {agents.length > 0 && (
            <>
              {agents.map((agent) => (
                <View
                  key={`agent-${agent.id}`}
                  style={[styles.taskRow, styles.agentRow, (!agent.enabled || agentsHalted) && styles.agentRowDisabled]}
                >
                  <View style={[styles.taskDot, { backgroundColor: agent.autonomous ? C.accent : C.text3 }]} />
                  <Pressable
                    style={styles.taskInfo}
                    onPress={() => void showAgentDetail(agent)}
                    onLongPress={() => {
                      setNotifTriggerAgent(agent);
                      setNotifTriggerDraft(agent.notificationTrigger?.packageNames.join('\n') ?? '');
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.agent_detail_a11y', { name: agent.name })}
                  >
                    <Text style={styles.taskName} numberOfLines={1}>
                      {(agent.name || '').toUpperCase()}
                    </Text>
                    <Text style={styles.taskMeta} numberOfLines={1}>
                      {agent.autonomous ? '⛓ ' : ''}{agent.schedule || t('sidebar.agent_manual')} · {agent.action?.type ?? 'draft'} · {agentApprovalLabel(agent)}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void handleRunScheduledAgent(agent.id, agent.name)}
                    disabled={pendingAgentIds.has(agent.id) || runningAgentIds.has(agent.id)}
                    hitSlop={8}
                    style={styles.tasksAction}
                    accessibilityRole="button"
                    accessibilityLabel={t('sidebar.run_agent_now_a11y', { name: agent.name })}
                  >
                    <MaterialIcons
                      name="play-arrow"
                      size={12}
                      color={pendingAgentIds.has(agent.id) || runningAgentIds.has(agent.id) ? C.text3 : C.accent}
                    />
                  </Pressable>
                  <Pressable
                    onPress={() => void handleTogglePause(agent)}
                    hitSlop={8}
                    style={styles.tasksAction}
                    accessibilityRole="button"
                    accessibilityLabel={
                      agent.enabled
                        ? t('sidebar.agent_pause_a11y', { name: agent.name })
                        : t('sidebar.agent_resume_a11y', { name: agent.name })
                    }
                  >
                    <MaterialIcons
                      name={agent.enabled ? 'pause-circle-outline' : 'play-circle-outline'}
                      size={12}
                      color={agent.enabled ? C.text2 : C.warning}
                    />
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
          {/* Import trigger — always rendered (including the empty state, so a
              first-time user has an obvious way to get started). Expands into
              an inline path input; validation + quarantine copy happen in
              lib/skill-import.ts's importSkillToQuarantine. */}
          {!skillImportOpen ? (
            <Pressable
              style={styles.addRow}
              onPress={() => setSkillImportOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={t('sidebar.skill_import_button')}
            >
              <Text style={[styles.addRowText, { color: C.accent }]}>{t('sidebar.skill_import_button')}</Text>
            </Pressable>
          ) : (
            <View style={styles.skillImportForm}>
              <TextInput
                style={styles.skillImportInput}
                value={skillImportPath}
                onChangeText={setSkillImportPath}
                placeholder={t('sidebar.skill_import_placeholder')}
                placeholderTextColor={C.text3}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                autoFocus
                editable={!skillImporting}
                onSubmitEditing={() => void handleImportSkill()}
              />
              {/* SAF alternative — no MANAGE_EXTERNAL_STORAGE needed, see
                  handlePickSkillFile above. Only handles a lone SKILL.md
                  (no companion asset files); the path input above still
                  covers folder-shaped skill bundles. */}
              <Pressable
                style={styles.skillImportPickRow}
                onPress={() => void handlePickSkillFile()}
                disabled={skillImporting}
                accessibilityRole="button"
                accessibilityLabel={t('sidebar.skill_import_pick_file_a11y')}
              >
                <MaterialIcons name="folder-open" size={13} color={C.accent} />
                <Text style={styles.skillImportPickText}>{t('sidebar.skill_import_pick_file')}</Text>
              </Pressable>
              <View style={styles.skillImportBtns}>
                <Pressable
                  style={styles.modalCancelBtn}
                  onPress={() => { setSkillImportPath(''); setSkillImportOpen(false); }}
                  disabled={skillImporting}
                >
                  <Text style={styles.modalCancelText}>{t('common.cancel')}</Text>
                </Pressable>
                <Pressable
                  style={[
                    styles.modalAddBtn,
                    { backgroundColor: C.accent },
                    skillImporting && styles.agentRowDisabled,
                  ]}
                  onPress={() => void handleImportSkill()}
                  disabled={skillImporting}
                >
                  <Text style={styles.modalAddText}>
                    {skillImporting ? '…' : t('sidebar.skill_import_confirm')}
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
          {/* SKILL-002: curated catalog browse trigger — sibling to the
              path-based import row above, same section, different source.
              Opens a modal that fetches lib/skill-catalog.ts's manifest;
              tapping an entry there still lands in quarantine, same as
              path-based import. */}
          <Pressable
            style={styles.addRow}
            onPress={openCatalogModal}
            accessibilityRole="button"
            accessibilityLabel={t('sidebar.skill_catalog_browse_button')}
          >
            <Text style={[styles.addRowText, { color: C.accent }]}>{t('sidebar.skill_catalog_browse_button')}</Text>
          </Pressable>
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

      {/* Notification-trigger edit modal */}
      <Modal
        visible={!!notifTriggerAgent}
        transparent
        animationType="fade"
        onRequestClose={() => setNotifTriggerAgent(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setNotifTriggerAgent(null)}>
          <Pressable style={styles.modalContent} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>
              {t('sidebar.agent_notification_trigger_modal_title', { name: notifTriggerAgent?.name ?? '' })}
            </Text>
            <TextInput
              style={styles.modalInput}
              value={notifTriggerDraft}
              onChangeText={setNotifTriggerDraft}
              placeholder={t('agentcard.notification_trigger_placeholder')}
              placeholderTextColor={C.text2}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            {(() => {
              const { valid, skippedCount } = parseNotificationTriggerPackages(notifTriggerDraft);
              if (valid.length === 0 && skippedCount === 0) return null;
              return (
                <Text style={styles.modalHint}>
                  {t('agentcard.notification_trigger_hint_count', { valid: valid.length, skipped: skippedCount })}
                </Text>
              );
            })()}
            <View style={styles.modalBtns}>
              <Pressable
                style={styles.modalCancelBtn}
                onPress={() => setNotifTriggerAgent(null)}
              >
                <Text style={styles.modalCancelText}>{t('common.cancel')}</Text>
              </Pressable>
              <Pressable
                style={[styles.modalAddBtn, { backgroundColor: C.accent }]}
                onPress={() => {
                  const agent = notifTriggerAgent;
                  if (!agent) return;
                  const { valid } = parseNotificationTriggerPackages(notifTriggerDraft);
                  void persistAgentUpdate(agent, {
                    notificationTrigger: valid.length ? { packageNames: valid } : null,
                  });
                  setNotifTriggerAgent(null);
                }}
              >
                <Text style={styles.modalAddText}>{t('common.save')}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* "What can agents do?" discovery surface */}
      <AgentCapabilitiesModal
        visible={agentCapabilitiesVisible}
        onClose={() => setAgentCapabilitiesVisible(false)}
      />

      {/* SKILL-002: curated skill catalog browse modal. Lists
          lib/skill-catalog.ts's fetched (sha256-verified) manifest entries;
          "Add" downloads + verifies the single entry, then hands it to
          importSkillContentToQuarantine — same quarantine pool, same
          approve/reject review, as a manually-imported skill. */}
      <Modal
        visible={catalogModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setCatalogModalVisible(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setCatalogModalVisible(false)}>
          <Pressable style={styles.catalogModalContent} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>{t('sidebar.skill_catalog_title')}</Text>
            {catalogLoading ? (
              <Text style={styles.catalogStatusText}>{t('sidebar.skill_catalog_loading')}</Text>
            ) : catalogError ? (
              <>
                <Text style={styles.catalogStatusText}>{catalogError}</Text>
                <Pressable style={styles.catalogRetryBtn} onPress={() => void loadCatalog()}>
                  <Text style={styles.modalCancelText}>{t('sidebar.skill_catalog_retry')}</Text>
                </Pressable>
              </>
            ) : catalogManifest && catalogManifest.skills.length > 0 ? (
              <ScrollView style={styles.catalogList}>
                {catalogManifest.skills.map((entry) => {
                  const alreadyKnown =
                    quarantinedSkills.some((s) => s.name === entry.name) ||
                    importedSkills.some((s) => s.name === entry.name);
                  const adding = catalogAddingName === entry.name;
                  return (
                    <View key={`catalog-skill-${entry.name}`} style={styles.catalogRow}>
                      <View style={styles.catalogInfo}>
                        <Text style={styles.taskName} numberOfLines={1}>{entry.name.toUpperCase()}</Text>
                        <Text style={styles.taskMeta} numberOfLines={2}>{entry.description}</Text>
                      </View>
                      <Pressable
                        style={[
                          styles.catalogAddBtn,
                          { backgroundColor: alreadyKnown ? C.btnSecondaryBg : C.accent },
                          (adding || catalogAddingName != null) && styles.agentRowDisabled,
                        ]}
                        onPress={() => void handleAddCatalogSkill(entry)}
                        disabled={adding || catalogAddingName != null}
                        accessibilityRole="button"
                        accessibilityLabel={t('sidebar.skill_catalog_add_a11y', { name: entry.name })}
                      >
                        <Text style={[styles.catalogAddText, alreadyKnown && { color: C.btnSecondaryText }]}>
                          {adding
                            ? '…'
                            : alreadyKnown
                              ? t('sidebar.skill_catalog_added')
                              : t('sidebar.skill_catalog_add')}
                        </Text>
                      </Pressable>
                    </View>
                  );
                })}
              </ScrollView>
            ) : (
              <Text style={styles.catalogStatusText}>{t('sidebar.skill_catalog_empty')}</Text>
            )}
            <View style={styles.modalBtns}>
              <Pressable style={styles.modalCancelBtn} onPress={() => setCatalogModalVisible(false)}>
                <Text style={styles.modalCancelText}>{t('common.close')}</Text>
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
  // RUNNING sub-section (Task B) — a self-contained wrapper so the highlight
  // overlay (Task D) can sit absolutely behind just these rows, not the
  // whole TASKS section.
  runningSectionWrap: {
    position: 'relative',
  },
  runningSectionHighlightOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  runningRow: {
    borderLeftWidth: 2,
    borderLeftColor: C.accent,
  },
  runningRowStalled: {
    borderLeftColor: C.warning,
    backgroundColor: withAlpha(C.warning, 0.1),
  },
  runningMetaStalled: {
    color: C.warning,
  },
  runningStopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: R.badge,
    borderWidth: S.borderWidth,
    borderColor: C.errorText,
    backgroundColor: C.errorBg,
  },
  runningStopBtnStalled: {
    borderColor: C.warning,
    backgroundColor: C.warning,
  },
  runningStopBtnText: {
    fontSize: F.badge.size,
    fontFamily: F.family,
    fontWeight: '700',
    color: C.errorText,
    letterSpacing: 0.3,
  },
  runningStopBtnTextStalled: {
    color: C.bgDeep,
  },
  // Imported-skills inline import form (SKILL-001) — a slimmer sibling of the
  // add-repo modal's input, sized for the narrow sidebar column.
  skillImportForm: {
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 4,
    gap: 6,
  },
  skillImportInput: {
    height: 28,
    backgroundColor: C.bgDeep,
    borderRadius: 6,
    borderWidth: S.borderWidth,
    borderColor: C.border,
    paddingHorizontal: 8,
    paddingVertical: 0,
    fontFamily: F.family,
    fontSize: F.sidebarItem.size,
    color: C.text1,
  },
  skillImportBtns: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 6,
  },
  skillImportPickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
  },
  skillImportPickText: {
    fontFamily: F.family,
    fontSize: F.badge.size,
    color: C.accent,
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
  agentsSubheaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  agentHelpBtn: {
    paddingHorizontal: 2,
    paddingVertical: 2,
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
  // (cloudSpacer was reused here historically; inline flex:1 View now.)
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
  modalHint: {
    color: C.text2,
    fontSize: F.badge.size,
    fontFamily: F.family,
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
  // SKILL-002 catalog browse modal — wider than the generic modalContent
  // (280) since each row needs room for a name + two-line description.
  catalogModalContent: {
    width: 320,
    maxHeight: '80%',
    backgroundColor: C.bgSurface,
    borderRadius: 10,
    padding: 16,
    borderWidth: S.borderWidth,
    borderColor: C.border,
  },
  catalogStatusText: {
    color: C.text2,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    marginBottom: 12,
  },
  catalogRetryBtn: {
    alignSelf: 'flex-start',
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 6,
    borderRadius: R.agentTab,
    backgroundColor: C.btnSecondaryBg,
    marginBottom: 12,
  },
  catalogList: {
    maxHeight: 320,
    marginBottom: 12,
  },
  catalogRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: S.borderWidth,
    borderBottomColor: C.border,
    gap: 8,
  },
  catalogInfo: {
    flex: 1,
  },
  catalogAddBtn: {
    paddingHorizontal: P.sidebarItem.px,
    paddingVertical: 6,
    borderRadius: R.agentTab,
  },
  catalogAddText: {
    color: C.bgDeep,
    fontSize: F.sidebarItem.size,
    fontFamily: F.family,
    fontWeight: '700',
  },
});
