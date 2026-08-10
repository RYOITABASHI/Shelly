/**
 * lib/agent-skills.ts — Phase 2a skill registry for the AI secretary.
 *
 * The secretary distills a successful run into a reusable "skill recipe"
 * (gated, never silent — the caller shows the user what would be saved) and can
 * recall + reuse it when a later task matches. Skills are GLOBAL (cross-agent)
 * markdown files stored on-device under the app-private agents home, best-effort
 * mirrored into the Obsidian Vault for human inspection.
 *
 * Mirrors the G2 memory machinery (lib/agent-memory.ts): same crash-safe verified
 * shell write, same frontmatter discipline, same on-device-only invariant. A
 * skill recipe injected into a run prompt flows through the SAME secret-guard as
 * memory (agent-manager prepends it into agent.prompt → resolveAgentRoute scans
 * it), so a secret inside a skill can never silently reach a cloud route.
 *
 * Pure helpers (markdown build/parse, id, match scoring, injection context,
 * distillation) are IO-free for offline unit tests. The one exception is
 * matchSkillRecipesHybrid, which OPTIONALLY calls out to an injected
 * EmbeddingPort (see its own doc comment) — every existing caller and test
 * that doesn't pass one gets the exact same pure, synchronous-feeling
 * bigram-only behavior as matchSkillRecipes.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { getHomePath } from '@/lib/home-path';
import { tokenizeForMatch } from '@/lib/agent-text-match';
import type { Agent, AgentRouteDecision, ToolChoice } from '@/store/types';
import type { AgentPlanSpecV1 } from '@/lib/agent-plan-spec';
import { cosineSimilarity } from '@/lib/memory/ranking-semantic';
import { MEMORY_EMBEDDING_ENABLED } from '@/lib/memory/wiring';
import type { EmbeddingPort } from '@/lib/memory/types';
import { scanForSecrets } from '@/lib/secret-guard';

export interface SkillRecipe {
  id: string;
  /** Short human label (usually the source agent's name). */
  name: string;
  /** Trigger phrase/keywords used to match future tasks. */
  trigger: string;
  /** The prompt/recipe that worked. */
  prompt: string;
  /** Route that worked: 'on-device' | 'cloud' | 'hybrid'. */
  route: string;
  /** Human-readable tool label that worked. */
  toolLabel: string;
  tags: string[];
  successCount: number;
  /** ISO-8601. */
  lastUsed: string;
  /** ISO-8601. */
  created: string;
  /** Where this recipe came from: distilled from agent runs (default/omitted)
   *  vs. imported from a local SKILL.md via the SKILL-001 quarantine flow. */
  source?: 'distilled' | 'imported';
  /** Executable procedure captured from a successful multi-step run. It is
   *  converted back into Agent.orchestration and run by the existing executor. */
  planSpec?: AgentPlanSpecV1;
  /** Learning-loop failure hint (2026-08-03): the most recent FAILED run that
   *  used this skill. buildSkillInjectionContext surfaces it as a corrective
   *  caution the next time the skill matches, and the next verified success
   *  clears it (bumpSkillUsage). Deliberately NOT an auto-rewrite of `prompt`:
   *  the recipe body only ever changes through the existing gated distill/save
   *  flow, so a hallucinated "improvement" can never silently replace a recipe
   *  that used to work. */
  lastFailure?: { at: string; note: string };
  /** Curator (2026-08-05): set once successCount crosses
   *  SKILL_PROMOTION_MIN_SUCCESS_COUNT (lib/skill-curator.ts) so a future
   *  consumer (e.g. the "use skill X?" confirm card) can prioritize proven
   *  recipes. Additive metadata only — matching/injection behavior today is
   *  unchanged, and files without the field parse exactly as before. */
  promoted?: boolean;
  /** Curator: stale/never-reused recipe. Excluded from the match candidate
   *  pool (scoreSkillRecipes skips it) but NEVER deleted from disk — archival
   *  is a reversible flag, deletion stays a separate explicit decision. A
   *  later verified use (bumpSkillUsage) clears it, since a skillId-attached
   *  agent can still exercise an archived recipe without going through the
   *  matcher. */
  archived?: boolean;
}

/** Obsidian Vault folder for agent skills (sibling of 90_Agent_Memory). */
export const VAULT_SKILLS_DIR = '91_Agent_Skills';
const DEFAULT_VAULT_PATH = '/sdcard/Documents/ObsidianVault';
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
/** Reuse is conservative: only surface a few strong matches. */
export const DEFAULT_SKILL_MATCH_LIMIT = 3;
/** A match must clear this score to be offered — avoids spurious reuse.
 *  Tuned for the CJK-bigram tokenizer (a similar task shares several bigrams;
 *  an unrelated one shares ~none). */
export const MIN_SKILL_MATCH_SCORE = 3;
const MAX_RECIPE_PROMPT_CHARS = 2000;
const MAX_INJECTION_CHARS = 800;
/** A failure hint is a one-line nudge, not a log dump — mirrors the ~200-char
 *  outputPreview discipline the run logs themselves use. */
const MAX_FAILURE_NOTE_CHARS = 200;

function skillsDir(): string {
  return `${getHomePath()}/.shelly/agents/skills`;
}

function toFileUri(path: string): string {
  return path.startsWith('file://') ? path : `file://${path}`;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/** djb2 → base36; matches the memory module's id strategy. */
function shortHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

/** Frontmatter is line-based — never let a value introduce a newline. */
function safeLine(value: string | undefined): string {
  if (!value) return '';
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/** Stable id from name+trigger so re-distilling the same skill overwrites it. */
export function skillRecipeId(name: string, trigger: string): string {
  return `skill-${shortHash(`${name.trim()} ${trigger.trim()}`)}`;
}

export function makeSkillRecipe(params: {
  name: string;
  trigger: string;
  prompt: string;
  route: string;
  toolLabel: string;
  tags?: string[];
  successCount?: number;
  lastUsed?: string;
  created?: string;
  planSpec?: AgentPlanSpecV1;
}): SkillRecipe {
  const trigger = params.trigger.trim().slice(0, 200);
  const name = params.name.trim().slice(0, 80) || 'skill';
  return {
    id: skillRecipeId(name, trigger),
    name,
    trigger,
    prompt: params.prompt.trim().slice(0, MAX_RECIPE_PROMPT_CHARS),
    route: safeLine(params.route) || 'on-device',
    toolLabel: safeLine(params.toolLabel) || 'Local LLM',
    tags: normalizeTags(params.tags),
    successCount: Math.max(0, params.successCount ?? 1),
    lastUsed: safeLine(params.lastUsed) || new Date().toISOString(),
    created: safeLine(params.created) || new Date().toISOString(),
    ...(params.planSpec?.steps?.list && params.planSpec.steps.list.length >= 2
      ? { planSpec: params.planSpec }
      : {}),
  };
}

export function buildSkillRecipeMarkdown(recipe: SkillRecipe): string {
  const fm = [
    '---',
    `name: ${safeLine(recipe.name)}`,
    `trigger: ${safeLine(recipe.trigger)}`,
    `route: ${safeLine(recipe.route)}`,
    `tool: ${safeLine(recipe.toolLabel)}`,
    `tags: [${recipe.tags.join(', ')}]`,
    `successCount: ${recipe.successCount}`,
    `lastUsed: ${safeLine(recipe.lastUsed)}`,
    `created: ${safeLine(recipe.created)}`,
    // Curator flags are emitted ONLY when true, so a never-curated recipe's
    // markdown stays byte-identical to the pre-curator format.
    ...(recipe.promoted ? ['promoted: true'] : []),
    ...(recipe.archived ? ['archived: true'] : []),
    // Failure hint rides the SAME line-based frontmatter as successCount —
    // same persistence, same crash-safe write, same Vault mirror.
    ...(recipe.lastFailure
      ? [
          `lastFailureAt: ${safeLine(recipe.lastFailure.at)}`,
          `lastFailureNote: ${safeLine(recipe.lastFailure.note).slice(0, MAX_FAILURE_NOTE_CHARS)}`,
        ]
      : []),
    '---',
    '',
  ].join('\n');
  const executable = recipe.planSpec
    ? `\n<!-- shelly-plan-spec\n${JSON.stringify(recipe.planSpec)}\n-->\n`
    : '\n';
  return `${fm}${recipe.prompt}${executable}`;
}

export function parseSkillRecipeMarkdown(content: string): SkillRecipe | null {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const [, frontmatter, body] = match;
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  const name = fields.name;
  const trigger = fields.trigger;
  const planMatch = body.match(/\n?<!-- shelly-plan-spec\n([\s\S]*?)\n-->\s*$/);
  const prompt = (planMatch ? body.slice(0, planMatch.index) : body).trim();
  if (!name || !trigger || !prompt) return null;
  const tags = (fields.tags ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const successCount = Number.parseInt(fields.successCount ?? '1', 10);
  let planSpec: AgentPlanSpecV1 | undefined;
  if (planMatch) {
    try {
      const parsed = JSON.parse(planMatch[1]) as AgentPlanSpecV1;
      if (parsed.kind === 'shelly.agent.plan' && parsed.steps?.list?.length >= 2) {
        planSpec = parsed;
      }
    } catch {
      // A malformed executable payload degrades to the safe prompt-only skill.
    }
  }
  return {
    id: skillRecipeId(name, trigger),
    name,
    trigger,
    prompt,
    route: fields.route || 'on-device',
    toolLabel: fields.tool || 'Local LLM',
    tags: normalizeTags(tags),
    successCount: Number.isFinite(successCount) ? Math.max(0, successCount) : 1,
    lastUsed: fields.lastUsed || new Date(0).toISOString(),
    created: fields.created || new Date(0).toISOString(),
    // Curator flags: absent lines parse to absent fields (additive migration).
    ...(fields.promoted === 'true' ? { promoted: true } : {}),
    ...(fields.archived === 'true' ? { archived: true } : {}),
    ...(planSpec ? { planSpec } : {}),
    ...(fields.lastFailureNote
      ? {
          lastFailure: {
            at: fields.lastFailureAt || new Date(0).toISOString(),
            note: fields.lastFailureNote.slice(0, MAX_FAILURE_NOTE_CHARS),
          },
        }
      : {}),
  };
}

/**
 * Crash-safe shell write (set -e + unique quoted heredoc + verified [ -s ]) with
 * a best-effort Obsidian Vault mirror. Same defensive shape as the memory module.
 */
export function buildSkillWriteCommand(recipe: SkillRecipe): string {
  if (!SAFE_ID_RE.test(recipe.id)) {
    throw new Error(`refusing skill write for unsafe id: ${recipe.id}`);
  }
  const dir = skillsDir();
  const file = `${dir}/${recipe.id}.md`;
  const marker = `SHELLY_SKILL_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const markdown = buildSkillRecipeMarkdown(recipe);
  const vaultMirror = scanForSecrets(markdown).hasSecret
    ? []
    : [
        `__vault="\${OBSIDIAN_VAULT_PATH:-${DEFAULT_VAULT_PATH}}"`,
        `if [ -d "$__vault" ]; then`,
        `  mkdir -p "$__vault/${VAULT_SKILLS_DIR}" 2>/dev/null || true`,
        `  cp ${shellQuote(file)} "$__vault/${VAULT_SKILLS_DIR}/${recipe.id}.md" 2>/dev/null || true`,
        `fi`,
      ];
  return [
    `set -e`,
    `mkdir -p ${shellQuote(dir)}`,
    `cat > ${shellQuote(file)} <<'${marker}'`,
    markdown.replace(/\n$/, ''),
    marker,
    `[ -s ${shellQuote(file)} ] || { echo "skill write failed: ${recipe.id}" >&2; exit 1; }`,
    ...vaultMirror,
  ].join('\n');
}

export async function writeSkillRecipe(
  runCommand: (cmd: string) => Promise<string>,
  recipe: SkillRecipe
): Promise<void> {
  await runCommand(buildSkillWriteCommand(recipe));
}

/** Crash-safe delete of a skill recipe (authoritative file + Vault mirror). */
export function buildSkillDeleteCommand(skillId: string): string {
  if (!SAFE_ID_RE.test(skillId)) {
    throw new Error(`refusing skill delete for unsafe id: ${skillId}`);
  }
  const dir = skillsDir();
  return [
    `set -e`,
    `rm -f ${shellQuote(`${dir}/${skillId}.md`)}`,
    `__vault="\${OBSIDIAN_VAULT_PATH:-${DEFAULT_VAULT_PATH}}"`,
    `rm -f "$__vault/${VAULT_SKILLS_DIR}/${skillId}.md" 2>/dev/null || true`,
  ].join('\n');
}

export async function deleteSkillRecipe(
  runCommand: (cmd: string) => Promise<string>,
  skillId: string
): Promise<void> {
  await runCommand(buildSkillDeleteCommand(skillId));
}

/** Read all skill recipes (most successful first). Reads via Expo FileSystem. */
export async function readSkillRecipes(): Promise<SkillRecipe[]> {
  try {
    const dirUri = toFileUri(skillsDir());
    const info = await FileSystem.getInfoAsync(dirUri);
    if (!info.exists || !info.isDirectory) return [];
    const names = await FileSystem.readDirectoryAsync(dirUri);
    const recipes: SkillRecipe[] = [];
    for (const name of names.filter((n) => n.endsWith('.md'))) {
      try {
        const content = await FileSystem.readAsStringAsync(`${dirUri}/${name}`);
        const recipe = parseSkillRecipeMarkdown(content);
        if (recipe) recipes.push(recipe);
      } catch {
        // Skip malformed or concurrently-written recipes.
      }
    }
    return recipes.sort(
      (a, b) => b.successCount - a.successCount || b.lastUsed.localeCompare(a.lastUsed)
    );
  } catch {
    return [];
  }
}

interface ScoredSkill {
  recipe: SkillRecipe;
  score: number;
}

/**
 * Score skills against a task via CJK-bigram/token overlap. Unlike memory
 * recall, reuse is CONSERVATIVE: only recipes that clear MIN_SKILL_MATCH_SCORE
 * are kept (no recency fallback), so the "use skill X?" gate only fires on a
 * genuine match. Shared by matchSkillRecipes (bigram-only, byte-identical to
 * before) and matchSkillRecipesHybrid (optional embedding re-rank) below —
 * this function is the ONLY thing that decides which recipes qualify at all;
 * the hybrid matcher can reorder its output but never add or drop a recipe.
 */
function scoreSkillRecipes(taskText: string, recipes: SkillRecipe[]): ScoredSkill[] {
  if (recipes.length === 0) return [];
  const taskTokens = tokenizeForMatch(taskText);
  const scored: ScoredSkill[] = [];
  for (const recipe of recipes) {
    // Curator archival: an archived recipe is out of the candidate pool
    // entirely (both bigram-only and hybrid matchers flow through here). The
    // file stays on disk; a later verified use un-archives it (bumpSkillUsage).
    if (recipe.archived) continue;
    const score = scoreRecipeAgainstTaskTokens(taskTokens, recipe);
    if (score >= MIN_SKILL_MATCH_SCORE) scored.push({ recipe, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || b.recipe.successCount - a.recipe.successCount
  );
  return scored;
}

/** The ONE scoring core (2 pts per matched tag, 1 pt per matched trigger
 *  token) — extracted verbatim from scoreSkillRecipes so the curator's
 *  duplicate detection reuses it instead of reinventing a second similarity
 *  metric that could drift. */
function scoreRecipeAgainstTaskTokens(taskTokens: Set<string>, recipe: SkillRecipe): number {
  const triggerTokens = tokenizeForMatch(`${recipe.trigger} ${recipe.tags.join(' ')}`);
  let score = 0;
  for (const tag of recipe.tags) if (taskTokens.has(tag)) score += 2;
  for (const tok of triggerTokens) if (taskTokens.has(tok)) score += 1;
  return score;
}

/**
 * Symmetric near-duplicate signal between two recipes, built on the SAME
 * scoring core matchSkillRecipes uses: each recipe's trigger+tags text is
 * scored as if it were the incoming task for the other recipe, and the MIN of
 * the two directions is returned. Taking the min is deliberately conservative:
 * a short trigger fully contained in a much longer, broader one scores high in
 * one direction only, and must NOT read as a duplicate.
 */
export function skillPairSimilarity(a: SkillRecipe, b: SkillRecipe): number {
  const aTokens = tokenizeForMatch(`${a.trigger} ${a.tags.join(' ')}`);
  const bTokens = tokenizeForMatch(`${b.trigger} ${b.tags.join(' ')}`);
  return Math.min(
    scoreRecipeAgainstTaskTokens(aTokens, b),
    scoreRecipeAgainstTaskTokens(bTokens, a)
  );
}

/**
 * Score skills against a task. Unlike memory recall, reuse is CONSERVATIVE: only
 * recipes that clear MIN_SKILL_MATCH_SCORE are returned (no recency fallback), so
 * the "use skill X?" gate only fires on a genuine match.
 */
export function matchSkillRecipes(
  taskText: string,
  recipes: SkillRecipe[],
  limit = DEFAULT_SKILL_MATCH_LIMIT
): SkillRecipe[] {
  return scoreSkillRecipes(taskText, recipes)
    .slice(0, limit)
    .map((s) => s.recipe);
}

export interface HybridSkillMatchOptions {
  limit?: number;
  /** Injected on-device embedding port (e.g. a LlamaEmbeddingPort pointed at
   *  the local llama-server). Omitted entirely by default — this function
   *  never constructs network capability itself, the caller decides whether
   *  and how to reach the local LLM. When omitted, or when
   *  MEMORY_EMBEDDING_ENABLED (lib/memory/wiring.ts) is false, this degrades
   *  to exactly matchSkillRecipes' bigram-only ordering. */
  embeddingPort?: EmbeddingPort;
}

/**
 * ADDITIVE hybrid variant of matchSkillRecipes — matchSkillRecipes itself is
 * completely untouched and stays the byte-identical bigram-only default (see
 * its own tests). Design: bigram overlap is the FAST PRE-FILTER — it alone
 * decides which recipes clear MIN_SKILL_MATCH_SCORE, preserving the
 * "conservative reuse" invariant documented above (an embedding can never
 * pull in a recipe the bigram matcher would have rejected, and can never
 * reject one it accepted). The embedding is used ONLY to RE-RANK: when two or
 * more qualifying recipes tie on bigram score (a coarse integer count, so
 * ties are common), cosine similarity of a real semantic embedding is a much
 * better tiebreaker than the previous arbitrary "most successCount wins".
 * Ties on score AND similarity still fall through to successCount, so the
 * ordering stays fully deterministic with or without an embedding.
 *
 * Fails silently to the bigram-only ordering on ANY problem: no port
 * injected, the flag is off, the embed() call throws, times out (see
 * DEFAULT_EMBEDDING_TIMEOUT_MS in lib/memory/embedding-llama.ts), or returns
 * a malformed/mismatched result. Skill matching must never feel slower or
 * less reliable than today just because a local LLM happens to be starting,
 * busy, or absent.
 */
export async function matchSkillRecipesHybrid(
  taskText: string,
  recipes: SkillRecipe[],
  options: HybridSkillMatchOptions = {}
): Promise<SkillRecipe[]> {
  const limit = options.limit ?? DEFAULT_SKILL_MATCH_LIMIT;
  const scored = scoreSkillRecipes(taskText, recipes);
  if (scored.length === 0) return [];

  const bigramOnly = () => scored.slice(0, limit).map((s) => s.recipe);
  if (!MEMORY_EMBEDDING_ENABLED || !options.embeddingPort || scored.length < 2) {
    return bigramOnly();
  }

  try {
    const texts = [
      taskText,
      ...scored.map((s) => `${s.recipe.trigger} ${s.recipe.tags.join(' ')}`),
    ];
    const vectors = await options.embeddingPort.embed(texts);
    if (!Array.isArray(vectors) || vectors.length !== texts.length) {
      return bigramOnly();
    }
    const [taskVector, ...recipeVectors] = vectors;
    const withSimilarity = scored.map((s, i) => ({
      ...s,
      similarity: cosineSimilarity(taskVector, recipeVectors[i]),
    }));
    withSimilarity.sort(
      (a, b) =>
        b.score - a.score || // bigram pre-filter tier always wins first
        b.similarity - a.similarity || // semantic re-rank within a tier
        b.recipe.successCount - a.recipe.successCount // final deterministic tiebreak
    );
    return withSimilarity.slice(0, limit).map((s) => s.recipe);
  } catch {
    return bigramOnly();
  }
}

/** Build the recipe block prepended to a run prompt. '' when no recipe. */
export function buildSkillInjectionContext(recipe: SkillRecipe | null): string {
  if (!recipe) return '';
  const prompt = recipe.prompt.replace(/\s+/g, ' ').slice(0, MAX_INJECTION_CHARS);
  const lines = [
    `# Reusable skill: ${recipe.name} (${recipe.successCount}× successful, on-device)`,
    'A recipe that worked before for a similar task. Adapt it if helpful.',
    prompt,
  ];
  // Learning loop: surface the most recent failure as a corrective hint —
  // auxiliary context only, the recipe body above is untouched. This block is
  // part of the run prompt, so it flows through the SAME secret-guard scan as
  // the recipe itself (a secret inside a failure note can never silently
  // reach a cloud route).
  if (recipe.lastFailure) {
    lines.push(
      `Caution: the most recent run using this skill FAILED (${recipe.lastFailure.at}): ` +
        `${recipe.lastFailure.note}`,
      'Adjust the approach to avoid repeating that failure.',
    );
  }
  return lines.join('\n');
}

/**
 * Distill a successful run into a skill recipe candidate (not yet written — the
 * caller gates the save). Trigger is derived from the task's salient tokens.
 */
export function distillSkillFromRun(params: {
  name: string;
  taskText: string;
  prompt: string;
  routeDecision?: AgentRouteDecision;
  timestamp?: number;
  planSpec?: AgentPlanSpecV1;
}): SkillRecipe {
  const trigger = deriveTrigger(params.taskText);
  const tags = [...tokenizeForMatch(params.taskText)].slice(0, 6);
  const created = params.timestamp ? new Date(params.timestamp).toISOString() : new Date().toISOString();
  return makeSkillRecipe({
    name: params.name,
    trigger,
    prompt: params.prompt,
    route: params.routeDecision?.route ?? 'on-device',
    toolLabel: params.routeDecision?.toolLabel ?? 'Local LLM',
    tags,
    successCount: 1,
    lastUsed: created,
    created,
    planSpec: params.planSpec,
  });
}

function planToolChoice(spec: AgentPlanSpecV1): ToolChoice | null {
  switch (spec.tool.type) {
    case 'local':
      return { type: 'local', model: spec.tool.model };
    case 'gemini-api':
    case 'perplexity':
    case 'cerebras':
    case 'groq':
      return { type: spec.tool.type, model: spec.tool.model };
    default:
      return null;
  }
}

/**
 * Rehydrate a stored PlanSpec onto a newly-confirmed agent. Only the procedure
 * (steps, provider and budgets) is reused; the new task prompt and its reviewed
 * action remain authoritative. runAgentNow/buildAgentPlanSpec then use the
 * existing executor unchanged.
 */
export function applyExecutableSkillPlan(agent: Agent, recipe: SkillRecipe | null): Agent {
  const spec = recipe?.planSpec;
  if (!spec?.steps || spec.steps.list.length < 2) return agent;
  const tool = planToolChoice(spec);
  return {
    ...agent,
    ...(tool ? { tool } : {}),
    orchestration: {
      steps: spec.steps.list.map((step) => ({
        instruction: step.instruction,
        ...(step.tool ? { tool: step.tool } : {}),
        ...(step.apiCall ? { apiCall: step.apiCall } : {}),
      })),
      maxSteps: spec.steps.budget.maxSteps,
      totalTimeoutMs: spec.steps.budget.totalTimeoutMs,
      ...(spec.limits.charLimit !== undefined ? { charLimit: spec.limits.charLimit } : {}),
    },
  };
}

/** Bump an existing skill's success count + lastUsed (idempotent id is unchanged).
 *  A verified success also CLEARS any stored failure hint — the deterministic
 *  "trust only after verification" signal that the correction worked; keeping a
 *  stale caution on a now-working recipe would only mislead the next run.
 *  It likewise clears the curator's `archived` flag: a skillId-attached agent
 *  bypasses the matcher, so an archived recipe can still be exercised — and a
 *  verified success is exactly the "this is alive" signal archival predicted
 *  would never come. */
export function bumpSkillUsage(recipe: SkillRecipe, timestamp?: number): SkillRecipe {
  const { lastFailure: _cleared, archived: _unarchived, ...rest } = recipe;
  return {
    ...rest,
    successCount: recipe.successCount + 1,
    lastUsed: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
  };
}

/**
 * Learning loop (failure side of bumpSkillUsage): record the latest FAILED run
 * that used this skill so the next injection carries a corrective hint. Pure —
 * the caller persists via the same writeSkillRecipe path as the success bump.
 * The note is flattened to one line and hard-capped; the recipe prompt itself
 * is never modified (auto-rewriting the body from an LLM's failure output is
 * a hallucination risk and explicitly out of scope). successCount/lastUsed are
 * left untouched: a failure is evidence about the LAST run, not a demotion of
 * the recipe's verified history.
 */
export function recordSkillFailure(
  recipe: SkillRecipe,
  failureNote: string,
  timestamp?: number
): SkillRecipe {
  const note =
    failureNote.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FAILURE_NOTE_CHARS) ||
    'run failed with no output';
  return {
    ...recipe,
    lastFailure: {
      at: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
      note,
    },
  };
}

/** Exported so lib/skill-import.ts (SKILL-001) can derive an imported skill's
 *  trigger from its description with the same tokenizer, instead of
 *  reimplementing this logic. */
export function deriveTrigger(taskText: string): string {
  const tokens = [...tokenizeForMatch(taskText)].slice(0, 8);
  return tokens.length ? tokens.join(' ') : taskText.trim().slice(0, 80);
}
