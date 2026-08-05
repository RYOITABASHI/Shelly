/**
 * lib/skill-curator.ts — conservative curation pass over the skill registry
 * (2026-08-05, Hermes-gap follow-up).
 *
 * Before this module, skills only ever accumulated: every distilled recipe
 * stayed forever with a bare successCount. Hermes Agent actively curates its
 * skill library (merge near-duplicates, promote proven skills, archive stale
 * ones); this is the minimal Shelly equivalent, landed dormant-but-tested in
 * the same spirit as MEMORY-001's tracks: pure logic + additive persistence,
 * no UI, no NL trigger.
 *
 * Three passes, all PURE (curateSkillRecipes) so they are host-testable:
 *
 * 1. Duplicate detection — skillPairSimilarity (the EXACT bigram scoring core
 *    matchSkillRecipes uses, min of both directions) at a conservative
 *    threshold. Produces PROPOSALS only: nothing is merged or deleted until a
 *    caller explicitly applies an approved proposal (applySkillMergeProposal).
 * 2. Promotion — successCount >= SKILL_PROMOTION_MIN_SUCCESS_COUNT sets
 *    `promoted: true` (additive metadata for a future consumer to prioritize).
 * 3. Archival — a recipe that was NEVER reused (successCount <= 1) and hasn't
 *    been touched for SKILL_ARCHIVE_AFTER_DAYS gets `archived: true`, which
 *    only removes it from the match candidate pool. The file stays on disk;
 *    deletion remains a separate, explicit, more destructive decision this
 *    module never takes.
 *
 * The IO wrapper (runSkillCuratorSweep) follows the same fire-and-forget
 * startup-sweep pattern as cleanupStalePlaintextMemoryFiles (lib/memory/
 * dev-data-cleanup.ts): best-effort, catches everything, never blocks or
 * breaks the caller's path.
 */
import { logInfo, logWarn } from '@/lib/debug-logger';
import {
  MIN_SKILL_MATCH_SCORE,
  readSkillRecipes,
  skillPairSimilarity,
  writeSkillRecipe,
  deleteSkillRecipe,
  type SkillRecipe,
} from '@/lib/agent-skills';

const LOG_MODULE = 'SkillCurator';

/**
 * A pair must clear this in BOTH directions (skillPairSimilarity takes the
 * min) to be proposed as a duplicate. 2× the reuse gate MIN_SKILL_MATCH_SCORE
 * (= 6 today): the reuse gate marks "similar enough to OFFER", and offering a
 * recipe is cheap/reversible, while merging collapses two recipes — so the
 * bar is deliberately twice as high, and mutual (a broad trigger containing a
 * narrow one scores high one-way only and is NOT proposed).
 */
export const SKILL_DUPLICATE_MIN_SCORE = MIN_SKILL_MATCH_SCORE * 2;

/**
 * Promotion threshold. Recipes are born at successCount 1 (the distilled
 * run itself), so 5 means the initial success PLUS four later verified
 * reuses (bumpSkillUsage fires only on a verified 'success' run) — repeated,
 * confirmed utility rather than a lucky pair of runs, while still reachable
 * for a weekly-cadence skill within about a month.
 */
export const SKILL_PROMOTION_MIN_SUCCESS_COUNT = 5;

/**
 * Archival window. 60 days of zero activity: a monthly-cadence task (the
 * slowest realistic legitimate cadence for a distilled recipe — e.g. a
 * monthly report) gets two full cycles to fire before its skill is deemed
 * stale, so one missed month never archives a live skill. Archival is a
 * reversible flag and bumpSkillUsage un-archives, so erring even this far on
 * the patient side costs only candidate-pool noise.
 */
export const SKILL_ARCHIVE_AFTER_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SkillMergeProposal {
  /** Survivor: higher successCount (ties: newer lastUsed, then smaller id). */
  canonical: SkillRecipe;
  /** The recipe the proposal would discard (only via applySkillMergeProposal). */
  duplicate: SkillRecipe;
  /** skillPairSimilarity score that triggered the proposal. */
  score: number;
  /** The already-computed merged recipe a caller persists on approval. */
  merged: SkillRecipe;
}

export interface SkillCurationResult {
  /** Proposals only — the curator NEVER applies these itself. */
  mergeProposals: SkillMergeProposal[];
  /** Copies with `promoted: true` newly applied (inputs are never mutated). */
  promote: SkillRecipe[];
  /** Copies with `archived: true` newly applied (inputs are never mutated). */
  archive: SkillRecipe[];
}

function lastActivityMs(recipe: SkillRecipe): number {
  const lastUsed = Date.parse(recipe.lastUsed);
  const created = Date.parse(recipe.created);
  return Math.max(
    Number.isFinite(lastUsed) ? lastUsed : 0,
    Number.isFinite(created) ? created : 0
  );
}

/** Deterministic survivor pick: proven history first, then recency, then id. */
function pickCanonical(a: SkillRecipe, b: SkillRecipe): [SkillRecipe, SkillRecipe] {
  if (a.successCount !== b.successCount) {
    return a.successCount > b.successCount ? [a, b] : [b, a];
  }
  const cmp = a.lastUsed.localeCompare(b.lastUsed);
  if (cmp !== 0) return cmp > 0 ? [a, b] : [b, a];
  return a.id <= b.id ? [a, b] : [b, a];
}

/**
 * Merge policy (pure): the canonical recipe survives byte-for-byte (id, name,
 * trigger, prompt, route, tool, planSpec) — a merge must never rewrite a
 * recipe body that worked. Only the bookkeeping is combined: successCounts
 * sum, tags union, lastUsed = newest, created = oldest, lastFailure = the
 * more recent hint if either side has one, promoted survives if either side
 * had earned it. `archived` never survives a merge — a recipe worth merging
 * into is by definition in active enough use to stay matchable.
 */
export function mergeSkillRecipes(canonical: SkillRecipe, duplicate: SkillRecipe): SkillRecipe {
  const tags = [...new Set([...canonical.tags, ...duplicate.tags])];
  const lastUsed =
    canonical.lastUsed.localeCompare(duplicate.lastUsed) >= 0
      ? canonical.lastUsed
      : duplicate.lastUsed;
  const created =
    canonical.created.localeCompare(duplicate.created) <= 0
      ? canonical.created
      : duplicate.created;
  const failures = [canonical.lastFailure, duplicate.lastFailure]
    .filter((f): f is NonNullable<SkillRecipe['lastFailure']> => !!f)
    .sort((x, y) => y.at.localeCompare(x.at));
  const { archived: _dropped, ...rest } = canonical;
  return {
    ...rest,
    tags,
    successCount: canonical.successCount + duplicate.successCount,
    lastUsed,
    created,
    ...(failures.length > 0 ? { lastFailure: failures[0] } : {}),
    ...(canonical.promoted || duplicate.promoted ? { promoted: true } : {}),
  };
}

/**
 * Find near-duplicate pairs (pure). Conservative by construction:
 * - the score is the SAME bigram core the matcher uses, min of both directions;
 * - threshold is 2× the reuse gate;
 * - archived recipes are skipped (curating dead entries is churn for nothing);
 * - greedy one-proposal-per-recipe: once a recipe appears in a proposal it is
 *   consumed, so a caller can apply any subset without conflicting merges.
 * Pairs are examined best-score-first so the greedy pass keeps the strongest
 * pairing when three or more recipes overlap.
 */
export function findDuplicateSkillPairs(recipes: SkillRecipe[]): SkillMergeProposal[] {
  const live = recipes.filter((r) => !r.archived);
  const scoredPairs: Array<{ a: SkillRecipe; b: SkillRecipe; score: number }> = [];
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      if (live[i].id === live[j].id) continue;
      const score = skillPairSimilarity(live[i], live[j]);
      if (score >= SKILL_DUPLICATE_MIN_SCORE) {
        scoredPairs.push({ a: live[i], b: live[j], score });
      }
    }
  }
  scoredPairs.sort((x, y) => y.score - x.score);
  const consumed = new Set<string>();
  const proposals: SkillMergeProposal[] = [];
  for (const { a, b, score } of scoredPairs) {
    if (consumed.has(a.id) || consumed.has(b.id)) continue;
    consumed.add(a.id);
    consumed.add(b.id);
    const [canonical, duplicate] = pickCanonical(a, b);
    proposals.push({ canonical, duplicate, score, merged: mergeSkillRecipes(canonical, duplicate) });
  }
  return proposals;
}

/** Promotion eligibility (pure): proven, live, and not already flagged (so a
 *  repeated sweep is a no-op instead of rewriting the same file each launch). */
export function isSkillPromotionEligible(recipe: SkillRecipe): boolean {
  return (
    !recipe.promoted &&
    !recipe.archived &&
    recipe.successCount >= SKILL_PROMOTION_MIN_SUCCESS_COUNT
  );
}

/**
 * Archival eligibility (pure). Deliberately narrow: ONLY recipes that were
 * never reused (successCount <= 1 — recipes are born at 1) and have had zero
 * activity for the whole window. A recipe with even one verified reuse is
 * evidence the distillation earned its keep, and promoted recipes are never
 * auto-archived regardless of quiet periods.
 */
export function isSkillArchiveEligible(recipe: SkillRecipe, nowMs: number): boolean {
  if (recipe.archived || recipe.promoted) return false;
  if (recipe.successCount > 1) return false;
  return nowMs - lastActivityMs(recipe) > SKILL_ARCHIVE_AFTER_DAYS * DAY_MS;
}

/** One pure curation pass over the full registry. Inputs are never mutated. */
export function curateSkillRecipes(recipes: SkillRecipe[], nowMs: number): SkillCurationResult {
  const promote = recipes
    .filter(isSkillPromotionEligible)
    .map((r) => ({ ...r, promoted: true as const }));
  // A recipe promoted THIS pass is proven — it must not also archive.
  const promotedNow = new Set(promote.map((r) => r.id));
  const archive = recipes
    .filter((r) => !promotedNow.has(r.id) && isSkillArchiveEligible(r, nowMs))
    .map((r) => ({ ...r, archived: true as const }));
  return { mergeProposals: findDuplicateSkillPairs(recipes), promote, archive };
}

/**
 * Apply ONE approved merge proposal: persist the merged canonical recipe, then
 * delete the duplicate's file (authoritative + Vault mirror). This is the only
 * place the curator ever deletes anything, and it only runs when a caller has
 * explicitly approved the specific proposal — the sweep below never calls it.
 */
export async function applySkillMergeProposal(
  runCommand: (cmd: string) => Promise<string>,
  proposal: SkillMergeProposal
): Promise<void> {
  await writeSkillRecipe(runCommand, proposal.merged);
  await deleteSkillRecipe(runCommand, proposal.duplicate.id);
}

export interface SkillCuratorSweepSummary {
  promoted: number;
  archived: number;
  /** Detected but NOT applied — surfaced for a future approval UI. */
  mergeProposals: SkillMergeProposal[];
}

/**
 * Best-effort startup sweep (same defensive contract as
 * cleanupStalePlaintextMemoryFiles): reads the registry, persists the two
 * safe/reversible flag updates (promotion, archival), and only LOGS merge
 * proposals — merging discards a file, so it always waits for explicit
 * approval via applySkillMergeProposal. Never throws; returns null on any
 * failure so the caller's startup path is untouched.
 */
export async function runSkillCuratorSweep(
  runCommand: (cmd: string) => Promise<string>,
  opts: { recipes?: SkillRecipe[]; nowMs?: number } = {}
): Promise<SkillCuratorSweepSummary | null> {
  try {
    const recipes = opts.recipes ?? (await readSkillRecipes());
    if (recipes.length === 0) return { promoted: 0, archived: 0, mergeProposals: [] };
    const result = curateSkillRecipes(recipes, opts.nowMs ?? Date.now());
    for (const recipe of [...result.promote, ...result.archive]) {
      await writeSkillRecipe(runCommand, recipe);
    }
    if (result.mergeProposals.length > 0) {
      logInfo(
        LOG_MODULE,
        `${result.mergeProposals.length} near-duplicate skill pair(s) detected (not merged — awaiting explicit approval): ` +
          result.mergeProposals
            .map((p) => `${p.duplicate.id}→${p.canonical.id} (score ${p.score})`)
            .join(', ')
      );
    }
    if (result.promote.length > 0 || result.archive.length > 0) {
      logInfo(
        LOG_MODULE,
        `sweep promoted ${result.promote.length}, archived ${result.archive.length} skill(s)`
      );
    }
    return {
      promoted: result.promote.length,
      archived: result.archive.length,
      mergeProposals: result.mergeProposals,
    };
  } catch (error) {
    logWarn(
      LOG_MODULE,
      'curator sweep failed (skill registry untouched)',
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}
