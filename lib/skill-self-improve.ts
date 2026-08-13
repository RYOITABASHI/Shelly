/**
 * lib/skill-self-improve.ts — Hermes-gap skill self-improvement (2026-08-13).
 *
 * Hermes Agent's saved skills improve as they are used. Shelly's equivalent is
 * DELIBERATELY deterministic: the only way a skill BODY ever gains content is
 * by promoting a resolved failure hint into a persistent "learning" — a
 * failure note (recordSkillFailure) that a LATER verified success proved was
 * worth heeding. The original recipe `prompt` stays immutable; the 2026-08-03
 * Track C decision against LLM auto-rewrites of a recipe that used to work
 * still stands (an LLM-refinement pass is tracked in DEFERRED.md instead).
 *
 * Safety boundaries, in the same spirit as the Track B unattended-save gate:
 * - secret/PII gate on EVERY update that adds content: a failure note that
 *   fails scanForSecrets is withheld (generic note persisted instead); a
 *   learning whose text fails the scan is never promoted; and a belt-and-
 *   braces scan of the full improved markdown refuses any improvement that
 *   would newly introduce a secret into the file.
 * - bloat caps: MAX_SKILL_LEARNINGS learnings (FIFO), each note hard-capped
 *   at MAX_SKILL_LEARNING_NOTE_CHARS (see lib/agent-skills.ts).
 * - audit: frontmatter lastImprovedAt/improveCount plus an append-only JSONL
 *   log (~/.shelly/agents/skills/improvements.log, self-rotating) record when
 *   and why each body change happened, and when one was reverted.
 * - attended = confirm, unattended = auto + notification with a one-tap
 *   revert action — the exact skillSaveMode discipline
 *   (hooks/use-skill-save-offer.ts) applied to updates.
 * - idempotence: proposals compare the run timestamp against the recipe's
 *   lastUsed / lastFailure.at, so repeated log-sync polls of the same run
 *   (the same shape the auto-save path already defends against) are no-ops.
 */
import * as Notifications from 'expo-notifications';
import { getHomePath } from '@/lib/home-path';
import { scanForSecrets } from '@/lib/secret-guard';
import {
  MAX_SKILL_LEARNINGS,
  MAX_SKILL_LEARNING_NOTE_CHARS,
  buildSkillRecipeMarkdown,
  bumpSkillUsage,
  readSkillRecipes,
  recordSkillFailure,
  writeSkillRecipe,
  type SkillLearning,
  type SkillRecipe,
} from '@/lib/agent-skills';
import type { AgentRunLog } from '@/store/types';

export const SKILL_IMPROVED_NOTIFICATION_CATEGORY = 'skill-improved';
export const REVERT_SKILL_IMPROVEMENT_ACTION = 'revert-skill-improvement';

/** Persisted instead of a failure note that failed the secret scan. */
export const WITHHELD_FAILURE_NOTE =
  'run failed; details withheld (output may contain a secret)';

export type SkillImprovementKind =
  /** Nothing to do (already recorded for this run, or no signal). */
  | 'noop'
  /** Metadata-only success bump (successCount/lastUsed) — status quo. */
  | 'bump'
  /** Success bump PLUS a resolved failure promoted into a body learning. */
  | 'bump-with-learning'
  /** Failure hint recorded (secret-scanned note) — status quo plus the gate. */
  | 'failure-hint';

export interface SkillImprovementProposal {
  improved: SkillRecipe;
  kind: SkillImprovementKind;
  /** Present only for 'bump-with-learning'. */
  learning?: SkillLearning;
  /** Source agent's display name, for confirm/notification copy. */
  agentName?: string;
}

/**
 * Mirror of skillSaveMode (hooks/use-skill-save-offer.ts) for UPDATES: 'none'
 * when the run outcome carries no learnable signal, otherwise attended runs
 * confirm body changes and unattended runs auto-apply + notify. Metadata-only
 * updates (bump / failure hint) are automatic in both modes — that is today's
 * behavior, unchanged; this mode gates only the BODY-changing learning.
 */
export function skillImproveMode(params: {
  status: AgentRunLog['status'] | undefined;
  hasSkillId: boolean;
  unattended?: boolean;
}): 'none' | 'confirm' | 'auto' {
  if (!params.hasSkillId) return 'none';
  // Same outcome filter updateReusedSkillFromRun (lib/agent-manager.ts) has
  // always used: 'unavailable'/'skipped' are excluded for the same reason the
  // circuit breaker excludes them — a flaky network is not evidence.
  if (params.status !== 'success' && params.status !== 'error') return 'none';
  return params.unattended === true ? 'auto' : 'confirm';
}

function flattenNote(note: string): string {
  return note.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Deterministic learning text for a failure hint a verified success resolved. */
export function buildResolvedFailureLearningNote(
  failure: NonNullable<SkillRecipe['lastFailure']>,
  resolvedAtMs: number
): string {
  const resolvedDay = new Date(resolvedAtMs).toISOString().slice(0, 10);
  return flattenNote(`Past failure (resolved ${resolvedDay}): ${failure.note}`).slice(
    0,
    MAX_SKILL_LEARNING_NOTE_CHARS
  );
}

/** Append one learning (pure): FIFO cap + audit counters. Inputs untouched. */
export function appendSkillLearning(
  recipe: SkillRecipe,
  learning: SkillLearning
): SkillRecipe {
  const entry: SkillLearning = {
    at: learning.at,
    note: flattenNote(learning.note).slice(0, MAX_SKILL_LEARNING_NOTE_CHARS),
  };
  const learnings = [...(recipe.learnings ?? []), entry].slice(-MAX_SKILL_LEARNINGS);
  return {
    ...recipe,
    learnings,
    lastImprovedAt: entry.at,
    improveCount: (recipe.improveCount ?? 0) + 1,
  };
}

/**
 * The ONE decision function: given a reused skill's recipe and the outcome of
 * a run that used it, compute the update to persist. Pure and IO-free so the
 * trigger conditions, secret gates, caps and idempotence are host-testable.
 */
export function proposeSkillImprovement(params: {
  recipe: SkillRecipe;
  status: 'success' | 'error';
  outputPreview?: string;
  timestamp?: number;
}): SkillImprovementProposal {
  const { recipe, status } = params;
  const ts = params.timestamp ?? Date.now();

  if (status === 'success') {
    // Idempotence: bumpSkillUsage sets lastUsed to the run timestamp, so a
    // re-poll of the same (or an older) run proposes nothing.
    const lastUsedMs = Date.parse(recipe.lastUsed);
    if (Number.isFinite(lastUsedMs) && lastUsedMs >= ts) {
      return { improved: recipe, kind: 'noop' };
    }
    const bumped = bumpSkillUsage(recipe, ts);
    const failure = recipe.lastFailure;
    if (!failure) return { improved: bumped, kind: 'bump' };

    // Evidence gate satisfied: this skill failed before and now verifiably
    // succeeded — promote the (about to be cleared) hint into a learning.
    const note = buildResolvedFailureLearningNote(failure, ts);
    // Secret gate #1: never promote a note the scanner flags.
    if (scanForSecrets(note).hasSecret) return { improved: bumped, kind: 'bump' };
    // Dedup: an identical lesson must not stack up to the cap.
    if ((bumped.learnings ?? []).some((l) => l.note === note)) {
      return { improved: bumped, kind: 'bump' };
    }
    const learning: SkillLearning = { at: new Date(ts).toISOString(), note };
    const improved = appendSkillLearning(bumped, learning);
    // Secret gate #2 (belt and braces): refuse any improvement that would
    // NEWLY introduce a secret into the persisted markdown.
    const hadSecret = scanForSecrets(buildSkillRecipeMarkdown(recipe)).hasSecret;
    const hasSecret = scanForSecrets(buildSkillRecipeMarkdown(improved)).hasSecret;
    if (!hadSecret && hasSecret) return { improved: bumped, kind: 'bump' };
    return { improved, kind: 'bump-with-learning', learning };
  }

  // status === 'error'
  const lastFailureMs = recipe.lastFailure ? Date.parse(recipe.lastFailure.at) : NaN;
  if (Number.isFinite(lastFailureMs) && lastFailureMs >= ts) {
    return { improved: recipe, kind: 'noop' };
  }
  const raw = flattenNote(params.outputPreview ?? '');
  // Secret gate on the failure side too (Track B discipline at update time):
  // the note lands in frontmatter AND is later eligible for body promotion,
  // so a flagged preview is withheld outright.
  const note = raw && scanForSecrets(raw).hasSecret ? WITHHELD_FAILURE_NOTE : raw;
  return { improved: recordSkillFailure(recipe, note, ts), kind: 'failure-hint' };
}

// ─── Audit log ──────────────────────────────────────────────────────────────

export interface SkillImprovementAuditEntry {
  at: string;
  skillId: string;
  action: 'learning-added' | 'learning-reverted';
  note: string;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function skillImprovementAuditLogPath(): string {
  return `${getHomePath()}/.shelly/agents/skills/improvements.log`;
}

/**
 * One JSONL line per body change (simple append-only log, per the audit
 * requirement — not a versioning system). Self-rotates past 1000 lines so it
 * can never grow without bound. Best-effort by construction (no `set -e`).
 */
export function buildSkillImprovementAuditCommand(
  entry: SkillImprovementAuditEntry
): string {
  const file = skillImprovementAuditLogPath();
  const dir = file.slice(0, file.lastIndexOf('/'));
  const tmp = `${file}.tmp`;
  return [
    `mkdir -p ${shellQuote(dir)}`,
    `printf '%s\\n' ${shellQuote(JSON.stringify(entry))} >> ${shellQuote(file)}`,
    `if [ "$(wc -l < ${shellQuote(file)} 2>/dev/null || echo 0)" -gt 1000 ]; then tail -n 500 ${shellQuote(file)} > ${shellQuote(tmp)} && mv ${shellQuote(tmp)} ${shellQuote(file)}; fi`,
  ].join('\n');
}

/** Persist an accepted proposal (recipe write + audit line for body changes). */
export async function persistSkillImprovement(
  runCommand: (cmd: string) => Promise<string>,
  proposal: SkillImprovementProposal
): Promise<void> {
  if (proposal.kind === 'noop') return;
  await writeSkillRecipe(runCommand, proposal.improved);
  if (proposal.kind === 'bump-with-learning' && proposal.learning) {
    try {
      await runCommand(
        buildSkillImprovementAuditCommand({
          at: proposal.learning.at,
          skillId: proposal.improved.id,
          action: 'learning-added',
          note: proposal.learning.note,
        })
      );
    } catch {
      // The audit line is best-effort; the recipe write above is the record.
    }
  }
}

// ─── Attended staging (confirm flow) ────────────────────────────────────────

/**
 * Body-change proposals from attended runs wait here for the foreground
 * confirm (hooks/use-skill-save-offer.ts's offerSkillImprovement). Same
 * in-memory single-slot pattern as agent-manager's pendingRollbackHandles:
 * a confirm is a fresh-result affordance, never persisted state.
 */
const pendingSkillImprovements = new Map<string, SkillImprovementProposal>();

export function stageSkillImprovementProposal(
  agentId: string,
  proposal: SkillImprovementProposal
): void {
  pendingSkillImprovements.set(agentId, proposal);
}

export function consumeSkillImprovementProposal(
  agentId: string
): SkillImprovementProposal | null {
  const proposal = pendingSkillImprovements.get(agentId) ?? null;
  if (proposal) pendingSkillImprovements.delete(agentId);
  return proposal;
}

export function clearSkillImprovementProposal(agentId: string): void {
  pendingSkillImprovements.delete(agentId);
}

// ─── Unattended flow (auto + notification with one-tap revert) ──────────────

/**
 * Apply an unattended improvement and, when the BODY changed, post a
 * notification with a one-tap revert action — the exact mirror of
 * saveUnattendedSkillWithNotification's post-hoc delete affordance.
 * Metadata-only updates stay silent (they always were).
 */
export async function applyUnattendedSkillImprovement(
  runCommand: (cmd: string) => Promise<string>,
  proposal: SkillImprovementProposal,
  notificationText: { title: string; body: string; revertButton: string }
): Promise<void> {
  if (proposal.kind === 'noop') return;
  await persistSkillImprovement(runCommand, proposal);
  if (proposal.kind !== 'bump-with-learning' || !proposal.learning) return;
  await Notifications.setNotificationCategoryAsync(SKILL_IMPROVED_NOTIFICATION_CATEGORY, [
    {
      identifier: REVERT_SKILL_IMPROVEMENT_ACTION,
      buttonTitle: notificationText.revertButton,
      // Revert is handled by the app's JS notification-response listener.
      options: { opensAppToForeground: true },
    },
  ]);
  await Notifications.scheduleNotificationAsync({
    content: {
      title: notificationText.title,
      body: notificationText.body,
      categoryIdentifier: SKILL_IMPROVED_NOTIFICATION_CATEGORY,
      data: { skillId: proposal.improved.id, learningAt: proposal.learning.at },
    },
    trigger: null,
  });
}

/**
 * Remove ONE learning (identified by its `at` timestamp) from a skill — the
 * post-hoc revert for an unattended auto-improvement. The success bump stays
 * (the run really did succeed); only the body addition is undone. Returns
 * false when there was nothing to revert (already reverted, skill deleted).
 */
export async function revertSkillImprovement(
  runCommand: (cmd: string) => Promise<string>,
  skillId: string,
  learningAt: string
): Promise<boolean> {
  const recipe = (await readSkillRecipes()).find((r) => r.id === skillId);
  if (!recipe?.learnings?.length) return false;
  const kept = recipe.learnings.filter((l) => l.at !== learningAt);
  if (kept.length === recipe.learnings.length) return false;
  const { learnings: _dropped, ...rest } = recipe;
  const updated: SkillRecipe = kept.length > 0 ? { ...rest, learnings: kept } : rest;
  await writeSkillRecipe(runCommand, updated);
  try {
    await runCommand(
      buildSkillImprovementAuditCommand({
        at: new Date().toISOString(),
        skillId,
        action: 'learning-reverted',
        note: learningAt,
      })
    );
  } catch {
    // Best-effort audit, same as persistSkillImprovement.
  }
  return true;
}
