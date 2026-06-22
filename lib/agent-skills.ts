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
 * distillation) are IO-free for offline unit tests.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { getHomePath } from '@/lib/home-path';
import { tokenizeForMatch } from '@/lib/agent-text-match';
import type { AgentRouteDecision } from '@/store/types';

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
    '---',
    '',
  ].join('\n');
  return `${fm}${recipe.prompt}\n`;
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
  const prompt = body.trim();
  if (!name || !trigger || !prompt) return null;
  const tags = (fields.tags ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const successCount = Number.parseInt(fields.successCount ?? '1', 10);
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
  return [
    `set -e`,
    `mkdir -p ${shellQuote(dir)}`,
    `cat > ${shellQuote(file)} <<'${marker}'`,
    markdown.replace(/\n$/, ''),
    marker,
    `[ -s ${shellQuote(file)} ] || { echo "skill write failed: ${recipe.id}" >&2; exit 1; }`,
    `__vault="\${OBSIDIAN_VAULT_PATH:-${DEFAULT_VAULT_PATH}}"`,
    `if [ -d "$__vault" ]; then`,
    `  mkdir -p "$__vault/${VAULT_SKILLS_DIR}" 2>/dev/null || true`,
    `  cp ${shellQuote(file)} "$__vault/${VAULT_SKILLS_DIR}/${recipe.id}.md" 2>/dev/null || true`,
    `fi`,
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
 * Score skills against a task. Unlike memory recall, reuse is CONSERVATIVE: only
 * recipes that clear MIN_SKILL_MATCH_SCORE are returned (no recency fallback), so
 * the "use skill X?" gate only fires on a genuine match.
 */
export function matchSkillRecipes(
  taskText: string,
  recipes: SkillRecipe[],
  limit = DEFAULT_SKILL_MATCH_LIMIT
): SkillRecipe[] {
  if (recipes.length === 0) return [];
  const taskTokens = tokenizeForMatch(taskText);
  const scored: ScoredSkill[] = [];
  for (const recipe of recipes) {
    const triggerTokens = tokenizeForMatch(`${recipe.trigger} ${recipe.tags.join(' ')}`);
    let score = 0;
    for (const tag of recipe.tags) if (taskTokens.has(tag)) score += 2;
    for (const tok of triggerTokens) if (taskTokens.has(tok)) score += 1;
    if (score >= MIN_SKILL_MATCH_SCORE) scored.push({ recipe, score });
  }
  scored.sort(
    (a, b) => b.score - a.score || b.recipe.successCount - a.recipe.successCount
  );
  return scored.slice(0, limit).map((s) => s.recipe);
}

/** Build the recipe block prepended to a run prompt. '' when no recipe. */
export function buildSkillInjectionContext(recipe: SkillRecipe | null): string {
  if (!recipe) return '';
  const prompt = recipe.prompt.replace(/\s+/g, ' ').slice(0, MAX_INJECTION_CHARS);
  return [
    `# Reusable skill: ${recipe.name} (${recipe.successCount}× successful, on-device)`,
    'A recipe that worked before for a similar task. Adapt it if helpful.',
    prompt,
  ].join('\n');
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
  });
}

/** Bump an existing skill's success count + lastUsed (idempotent id is unchanged). */
export function bumpSkillUsage(recipe: SkillRecipe, timestamp?: number): SkillRecipe {
  return {
    ...recipe,
    successCount: recipe.successCount + 1,
    lastUsed: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
  };
}

function deriveTrigger(taskText: string): string {
  const tokens = [...tokenizeForMatch(taskText)].slice(0, 8);
  return tokens.length ? tokens.join(' ') : taskText.trim().slice(0, 80);
}
