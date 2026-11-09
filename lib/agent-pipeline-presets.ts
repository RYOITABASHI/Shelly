/**
 * lib/agent-pipeline-presets.ts — G6: ready-made multi-step pipelines: the
 * collection pipeline for a topic the user names (collect → primary source → summarize → char-limited
 * re-summarize), the char-limit guarantee helper, and the article pipeline
 * builders, which take a user-supplied config.
 *
 * Pure & deterministic (no store/native deps) so it is unit-testable. A preset
 * produces the pieces createAgent() needs: a base prompt, an orchestration
 * config (steps + charLimit), a suggested schedule, and the autonomous flag.
 * The orchestration machinery (runAgentOrchestrated) already runs each step
 * through its own ladder — a "collect" step routes to Gemini/Perplexity (web),
 * a "summarize" step to the on-device model — so the preset only has to author
 * the right step instructions.
 */
import type { AgentAction, AgentArticleEditorConfig, AgentLocalStepConfig, AgentOrchestrationConfig, AgentOrchestrationStep, ToolChoice } from '@/store/types';
import {
  EDITOR_DEFAULT_MIN_SCORE,
  EDITOR_RUBRIC_MAX_CHARS,
  MATERIALS_DEFAULT_MAX_BYTES,
  MATERIALS_MAX_BYTES,
  MATERIALS_MAX_FILES,
  MAX_STEP_INSTRUCTION_CHARS,
  REVIEW_OUTPUT_CONTRACT,
  materialsRootOk,
  normalizeStepLocal,
} from './agent-orchestration';

export interface PipelinePreset {
  /** Human-friendly agent name (editable in the confirm card). */
  name: string;
  /** Overall goal, prefixed onto every step prompt by buildStepPrompt. */
  prompt: string;
  /** The multi-step chain + char-limit guarantee. */
  orchestration: AgentOrchestrationConfig;
  /** Suggested cron. null = run once. */
  schedule: string | null;
  /** Pipelines collect from the web unattended → autonomous. */
  autonomous: boolean;
  /** Fixed by the preset instead of derived from the utterance. Absent = the
   *  parser derives them, as for the collection preset. */
  tool?: ToolChoice;
  action?: AgentAction;
  /** Shown in the plain-text confirm when `schedule` is the preset's own. */
  scheduleLabel?: string;
  /** Where the agent's draft action saves. */
  output?: { outputPath: string; outputTemplate: string };
  /** No "remember that …" from the utterance (recall is off for longform
   *  chains, lib/agent-manager.ts applyMemoryAndSkills). */
  memoryOff?: boolean;
}

/** Asks for a pipeline from the user's config file, never a built-in one. */
export function isArticlePipelineRequest(text: string): boolean {
  return /記事パイプライン|\barticle pipelines?\b/i.test(text);
}

/** Default cadence of the collection pipeline: Mon & Fri at 08:00. */
export const COLLECTION_DEFAULT_CRON = '0 8 * * 1,5';
/** X/Twitter post budget (characters). */
export const X_CHAR_LIMIT = 280;

/**
 * Build the collection pipeline for the topic the user named: search the web for fresh papers/news
 * WITH sources, go to the primary source, summarize, then re-summarize within a
 * character budget for an X post. The save is the agent's draft action (writes
 * to the configured output destination), so it is NOT a pipeline step.
 */
export function buildCollectionPipeline(opts: {
  topic: string;
  charLimit?: number;
  schedule?: string | null;
  count?: number;
}): PipelinePreset {
  const topic = opts.topic.trim();
  if (!topic) throw new Error('a collection pipeline needs a topic');
  const charLimit = clampCharLimit(opts.charLimit ?? X_CHAR_LIMIT);
  const count = Math.min(Math.max(opts.count ?? 5, 1), 10);
  const schedule = opts.schedule === undefined ? COLLECTION_DEFAULT_CRON : opts.schedule;

  const steps = [
    // 1) Collect — web-mandatory (collection verb + freshness) → Gemini grounded
    //    / Perplexity academic. "出典付き" so the source URLs survive downstream.
    `今日の${topic}の最新ニュース・論文を${count}件、出典URL付きで集めて`,
    // 2) Primary source — go to the actual sources and pull the real facts, not a
    //    second-hand blurb. Worded as "collect the latest primary info on the web"
    //    (collection verb + freshness) so the scorer routes it to a WEB backend —
    //    on-device can't fetch URLs.
    `前段で挙がった各トピックについて、最新の一次情報をWebで収集し、重要な事実・数値・主張を出典URL付きで抽出して`,
    // 3) Summarize — transform (no collection verb) → on-device model.
    `一次情報をもとに各トピックを2〜3文の日本語で要約し、各項目に出典URLを付けて`,
    // 4) Re-summarize for X within the char budget. charLimit is X's real
    //    WEIGHTED budget (280 for a free-tier post); since Codex writes this
    //    step in Japanese and full-width characters count as 2 units on X,
    //    the character target given to the model is halved so the output
    //    actually fits. enforceCharLimit (using the true weighted charLimit)
    //    is the hard guarantee after the run regardless of what the model does.
    `全体をX(Twitter)投稿用に${Math.floor(charLimit / 2)}文字以内（日本語の全角文字はXでは2文字分としてカウントされるため）で再要約して。最重要トピックのみ、絵文字は使わず、${Math.floor(charLimit / 2)}文字を絶対に超えないこと`,
  ];

  const orchestration: AgentOrchestrationConfig = { steps, charLimit };

  return {
    name: `${topic} 収集`,
    // Base prompt with no collection verb — no collection verb / freshness word. buildStepPrompt
    // prepends this to EVERY step, and the escalation ladder routes a step by its
    // FULL prompt; a freshness/collection word here would force needsWeb on the
    // summarize/re-summarize steps too. Keep routing driven by each step's verb.
    prompt: `${topic}の定例レポート`,
    orchestration,
    schedule,
    autonomous: true,
  };
}

// ── Article pipelines: a user-supplied config ────────────────────────────────
//
// The longform chain is generic: research, write, two review and revise rounds,
// then assemble, with optional topic-queue steps first, and a digest over the
// drafts. Shelly ships no article agent, topic, schedule, engine choice or
// output folder: all of that comes from the user's own file (see
// lib/agent-article-pipeline-file.ts).
//
// A config grants nothing new. The action is always `draft`, the agent is never
// autonomous, and the steps are only model steps and local steps, which the
// executor re-checks in longformPlanRefusal and normalizeStepLocal. A CLI engine
// is text-only: no tools, re-checked in the executor's textOnlyPlanRefusal.

export const ARTICLE_PIPELINE_FILE_VERSION = 1;

/** HTTP engines a longform model step can run on. The local LLM's token cap
 *  cannot finish a long document, and the executor keeps it off a longform
 *  ladder. The list matches STEP_TOOL_DISPATCHABLE_TYPES in
 *  scripts/shelly-plan-executor.js. */
export const ARTICLE_ENGINE_TYPES = ['gemini-api', 'cerebras', 'groq', 'perplexity'] as const;
export type ArticleEngine = { type: (typeof ARTICLE_ENGINE_TYPES)[number]; model?: string };

/** The CLIs a write or review engine can name, always in text-only mode: the
 *  turn has no tools, because its prompt carries web-derived text. Matches
 *  CLI_STEP_ENGINES in scripts/shelly-plan-executor.js. */
export const ARTICLE_TEXT_ONLY_CLIS = ['claude', 'codex'] as const;
export type ArticleTextOnlyEngine = { type: 'cli'; cli: (typeof ARTICLE_TEXT_ONLY_CLIS)[number]; textOnly: true; model?: string };

/** The ghostwritten author view (executor v38). Off without this key. */
export interface ArticleVoiceConfig {
  /** The voice profile, a `.md` file given relative to the vault
   *  (`Drafts/_voice-profile.md`). Its frontmatter needs `reviewed: <date>`,
   *  or the step does not run. */
  profile: string;
  /** The profile's SHA-256 (lower-case hex), set by the owner after reviewing
   *  it. The step runs only while the profile still has this hash; this file
   *  is the pin because agent workers cannot write it. */
  profileSha256: string;
  /** The name in the fixed ghostwritten footer. */
  author: string;
  /** Default: Claude Code, text-only. */
  engine?: ArticleTextOnlyEngine;
  /** An HTTP engine, so always another family than the CLI writer. */
  review: ArticleEngine;
}

export interface ArticlePipelineConfig {
  /** Frontmatter `stream`, the draft's file name, and the name to ask for. */
  id: string;
  name: string;
  /** Rules for the series, prefixed onto every model step. */
  prompt: string;
  /** Language of the display labels of the steps with no model. */
  lang: 'ja' | 'en';
  /** Five-field cron. Minute and hour are fixed values, so at most hourly. */
  schedule: string;
  scheduleLabel?: string;
  /** Absolute folder the draft is saved to. See articleOutputFolderError. */
  outputFolder: string;
  /** Fixed text at the end of every draft. */
  footer: string;
  /** Start with `queue-pop`: the topic comes from `<outputFolder>/_queue.md`. */
  queue?: boolean;
  /** Each at most MAX_STEP_INSTRUCTION_CHARS, like any step, and refused rather
   *  than cut. `topics` adds `queue-refill` and needs `queue`; the review gets
   *  REVIEW_OUTPUT_CONTRACT appended, and the limit counts that too. */
  instructions: { research: string; write: string; review: string; revise: string; topics?: string };
  /** No defaults: the user picks. `agent` is the agent-level tool (default:
   *  `research`). `write` and `review` may be text-only CLIs. */
  engines: { research: ArticleEngine; write: ArticleEngine | ArticleTextOnlyEngine; review: ArticleEngine | ArticleTextOnlyEngine; agent?: ArticleEngine };
  /** Flagged in frontmatter `lint`, never rewritten. */
  lintTerms?: string[];
  nameLint?: { canonical: string; forms: string[] };
  /** Also lint the chain's source titles and URLs. */
  lintSources?: boolean;
  quality?: { minChars?: number; minWords?: number; minSources?: number };
  /** A ghostwritten section in place of the marker, after the last revise. */
  voice?: ArticleVoiceConfig;
  /** The editor quality gate (executor v44): frontmatter `quality`. */
  editor?: ArticleEditorConfig;
  /** The owner's own files named under a queue item (executor v44). Needs `queue`. */
  materials?: ArticleMaterialsConfig;
}

/** The editor quality gate: an engine (as for review) plus the owner's rubric. */
export type ArticleEditorConfig = (ArticleEngine | ArticleTextOnlyEngine) & {
  /** What the owner wants from a draft, at most EDITOR_RUBRIC_MAX_CHARS. */
  rubric: string;
  /** 1 to 5 in steps of 0.5. Default EDITOR_DEFAULT_MIN_SCORE. */
  minScore?: number;
};

/** Local materials: a folder of the owner's own files. */
export interface ArticleMaterialsConfig {
  /** Absolute folder of plain names (no dot segment), at least two deep. */
  root: string;
  /** At most MATERIALS_MAX_FILES (the default) files a run. */
  maxFiles?: number;
  /** At most MATERIALS_MAX_BYTES bytes a run (default MATERIALS_DEFAULT_MAX_BYTES). */
  maxBytes?: number;
}

export interface ArticleDigestConfig {
  name: string;
  prompt: string;
  lang: 'ja' | 'en';
  schedule: string;
  scheduleLabel?: string;
  outputFolder: string;
  footer: string;
  /** An agent needs a tool. The digest never calls it. */
  engine: ArticleEngine;
  /** Folders next to `outputFolder`. */
  streams: { folder: string; label: string; intent?: boolean }[];
}

export interface ArticlePipelineFile {
  version: typeof ARTICLE_PIPELINE_FILE_VERSION;
  pipelines: ArticlePipelineConfig[];
  digest?: ArticleDigestConfig;
}

const ARTICLE_ID_RE = /^[a-z0-9-]{1,32}$/;
const ARTICLE_LINE_MAX_CHARS = 64;
const ARTICLE_PROMPT_MAX_CHARS = 2000;
const ARTICLE_FOLDER_MAX_CHARS = 200;
const ARTICLE_MAX_PIPELINES = 16;
const ARTICLE_MODEL_RE = /^[A-Za-z0-9._:/-]{1,64}$/;
// Allows a newline; everything else in C0/C1 is refused.
const ARTICLE_CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
// No dot segments and no shell or template characters: `.shelly`, `..`, `~` and
// `$HOME` all fail here.
const ARTICLE_FOLDER_RE = /^(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)+\/?$/;
// Minute and hour fixed, so a typo cannot start a chain every minute.
const ARTICLE_CRON_RE = /^(?:[0-9]|[1-5][0-9]) (?:[0-9]|1[0-9]|2[0-3])(?:,(?:[0-9]|1[0-9]|2[0-3]))* [0-9*,/-]+ [0-9*,/-]+ [0-9*,/-]+$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function unknownKeyError(r: Record<string, unknown>, keys: readonly string[], where: string): string | null {
  const extra = Object.keys(r).find((k) => !keys.includes(k));
  return extra === undefined ? null : `${where}: unknown field "${extra}"`;
}

function articleTextError(v: unknown, max: number, where: string, multiline = false): string | null {
  if (typeof v !== 'string' || !v.trim() || v !== v.trim()) return `${where}: needs text with no space around it`;
  if (Array.from(v).length > max) return `${where}: longer than ${max} characters`;
  if (ARTICLE_CONTROL_RE.test(v) || (!multiline && v.includes('\n'))) return `${where}: has a control character`;
  return null;
}

function articleEngineError(v: unknown, where: string, textOnlyCliAllowed = false): string | null {
  if (!isPlainObject(v)) return `${where}: needs { "type": ... }`;
  if (v.type === 'cli') {
    if (!textOnlyCliAllowed) return `${where}: a CLI cannot run this step`;
    const keyError = unknownKeyError(v, ['type', 'cli', 'textOnly', 'model'], where);
    if (keyError) return keyError;
    if (!(ARTICLE_TEXT_ONLY_CLIS as readonly unknown[]).includes(v.cli)) return `${where}.cli: use one of ${ARTICLE_TEXT_ONLY_CLIS.join(', ')}`;
    if (v.textOnly !== true) return `${where}: a CLI runs an article step only with "textOnly": true`;
    if (v.model !== undefined && (typeof v.model !== 'string' || !ARTICLE_MODEL_RE.test(v.model))) return `${where}: bad model name`;
    return null;
  }
  if (v.type === 'local') return `${where}: the local LLM cannot finish an article`;
  if (!(ARTICLE_ENGINE_TYPES as readonly unknown[]).includes(v.type)) return `${where}: use one of ${ARTICLE_ENGINE_TYPES.join(', ')}`;
  const keyError = unknownKeyError(v, ['type', 'model'], where);
  if (keyError) return keyError;
  if (v.model !== undefined && (typeof v.model !== 'string' || !ARTICLE_MODEL_RE.test(v.model))) return `${where}: bad model name`;
  return null;
}

/** The fields a pipeline and a digest share. */
function articleCommonError(r: Record<string, unknown>, where: string): string | null {
  if (r.lang !== 'ja' && r.lang !== 'en') return `${where}.lang: use "ja" or "en"`;
  if (typeof r.schedule !== 'string' || !ARTICLE_CRON_RE.test(r.schedule)) return `${where}.schedule: needs a cron with a fixed minute and hour`;
  if (typeof r.outputFolder !== 'string' || r.outputFolder.length > ARTICLE_FOLDER_MAX_CHARS || !ARTICLE_FOLDER_RE.test(r.outputFolder)) {
    return `${where}.outputFolder: needs an absolute path of plain folder names`;
  }
  return (
    articleTextError(r.name, ARTICLE_LINE_MAX_CHARS, `${where}.name`) ??
    articleTextError(r.prompt, ARTICLE_PROMPT_MAX_CHARS, `${where}.prompt`, true) ??
    (r.scheduleLabel === undefined ? null : articleTextError(r.scheduleLabel, ARTICLE_LINE_MAX_CHARS, `${where}.scheduleLabel`))
  );
}

const ARTICLE_PIPELINE_KEYS = ['id', 'name', 'prompt', 'lang', 'schedule', 'scheduleLabel', 'outputFolder', 'footer', 'queue', 'instructions', 'engines', 'lintTerms', 'nameLint', 'lintSources', 'quality', 'voice', 'editor', 'materials'] as const;

function articleEditorError(v: unknown, where: string): string | null {
  if (!isPlainObject(v)) return `${where}: needs { "type", "rubric" }`;
  const keyError = unknownKeyError(v, ['type', 'cli', 'textOnly', 'model', 'rubric', 'minScore'], where);
  if (keyError) return keyError;
  const { rubric, minScore, ...engine } = v;
  const engineError = articleEngineError(engine, where, true);
  if (engineError) return engineError;
  const rubricError = articleTextError(rubric, EDITOR_RUBRIC_MAX_CHARS, `${where}.rubric`, true);
  if (rubricError) return rubricError;
  if (minScore !== undefined && (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < 1 || minScore > 5 || !Number.isInteger(minScore * 2))) {
    return `${where}.minScore: use a number from 1 to 5 in steps of 0.5`;
  }
  return null;
}

function articleMaterialsError(v: unknown, where: string): string | null {
  if (!isPlainObject(v)) return `${where}: needs { "root" }`;
  const keyError = unknownKeyError(v, ['root', 'maxFiles', 'maxBytes'], where);
  if (keyError) return keyError;
  if (!materialsRootOk(v.root)) return `${where}.root: needs an absolute folder of plain names, at least two deep, with no dot folder`;
  if (v.maxFiles !== undefined && (typeof v.maxFiles !== 'number' || !Number.isInteger(v.maxFiles) || v.maxFiles < 1 || v.maxFiles > MATERIALS_MAX_FILES)) {
    return `${where}.maxFiles: use 1 to ${MATERIALS_MAX_FILES}`;
  }
  if (v.maxBytes !== undefined && (typeof v.maxBytes !== 'number' || !Number.isInteger(v.maxBytes) || v.maxBytes < 1 || v.maxBytes > MATERIALS_MAX_BYTES)) {
    return `${where}.maxBytes: use 1 to ${MATERIALS_MAX_BYTES}`;
  }
  return null;
}

// A `.md` file relative to the vault, of plain names, so `.obsidian`, `..`,
// `~`, `$HOME` and an absolute path all fail.
const ARTICLE_VOICE_PROFILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*\.md$/;
const ARTICLE_VOICE_PROFILE_MAX_CHARS = 240;
const DEFAULT_VOICE_ENGINE: ArticleTextOnlyEngine = { type: 'cli', cli: 'claude', textOnly: true };

function articleVoiceError(v: unknown, where: string): string | null {
  if (!isPlainObject(v)) return `${where}: needs { "profile", "profileSha256", "author", "review" }`;
  const keyError = unknownKeyError(v, ['profile', 'profileSha256', 'author', 'engine', 'review'], where);
  if (keyError) return keyError;
  if (typeof v.profile !== 'string' || v.profile.length > ARTICLE_VOICE_PROFILE_MAX_CHARS || !ARTICLE_VOICE_PROFILE_RE.test(v.profile)) {
    return `${where}.profile: needs a .md file inside the vault, as a path of plain names relative to it`;
  }
  if (typeof v.profileSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(v.profileSha256)) return `${where}.profileSha256: needs the profile's SHA-256 in lower-case hex`;
  const authorError = articleTextError(v.author, ARTICLE_LINE_MAX_CHARS, `${where}.author`);
  if (authorError) return authorError;
  if (v.engine !== undefined) {
    if (!isPlainObject(v.engine) || v.engine.type !== 'cli') return `${where}.engine: the section is written by a text-only CLI`;
    const engineError = articleEngineError(v.engine, `${where}.engine`, true);
    if (engineError) return engineError;
  }
  return articleEngineError(v.review, `${where}.review`);
}

/** Why `raw` is not a usable pipeline config, or null. Pure. */
export function articlePipelineConfigError(raw: unknown, where = 'pipeline'): string | null {
  if (!isPlainObject(raw)) return `${where}: needs an object`;
  const keyError = unknownKeyError(raw, ARTICLE_PIPELINE_KEYS, where);
  if (keyError) return keyError;
  if (typeof raw.id !== 'string' || !ARTICLE_ID_RE.test(raw.id)) return `${where}.id: use lower-case letters, digits and hyphens, at most 32`;
  const commonError = articleCommonError(raw, where);
  if (commonError) return commonError;
  if (raw.queue !== undefined && typeof raw.queue !== 'boolean') return `${where}.queue: needs true or false`;
  if (raw.lintSources !== undefined && typeof raw.lintSources !== 'boolean') return `${where}.lintSources: needs true or false`;
  if (raw.voice !== undefined) {
    const voiceError = articleVoiceError(raw.voice, `${where}.voice`);
    if (voiceError) return voiceError;
  }
  if (raw.editor !== undefined) {
    const editorError = articleEditorError(raw.editor, `${where}.editor`);
    if (editorError) return editorError;
  }
  if (raw.materials !== undefined) {
    if (raw.queue !== true) return `${where}.materials: needs "queue": true (the files are named under a queue item)`;
    const materialsError = articleMaterialsError(raw.materials, `${where}.materials`);
    if (materialsError) return materialsError;
  }

  const ins = raw.instructions;
  if (!isPlainObject(ins)) return `${where}.instructions: needs research, write, review and revise`;
  const insKeyError = unknownKeyError(ins, ['research', 'write', 'review', 'revise', 'topics'], `${where}.instructions`);
  if (insKeyError) return insKeyError;
  for (const key of ['research', 'write', 'revise'] as const) {
    const error = articleTextError(ins[key], MAX_STEP_INSTRUCTION_CHARS, `${where}.instructions.${key}`, true);
    if (error) return error;
  }
  const reviewBudget = MAX_STEP_INSTRUCTION_CHARS - Array.from(REVIEW_OUTPUT_CONTRACT).length - 2;
  const reviewError = articleTextError(ins.review, reviewBudget, `${where}.instructions.review`, true);
  if (reviewError) return reviewError;
  if (ins.topics !== undefined) {
    if (raw.queue !== true) return `${where}.instructions.topics: needs "queue": true`;
    const topicsError = articleTextError(ins.topics, MAX_STEP_INSTRUCTION_CHARS, `${where}.instructions.topics`, true);
    if (topicsError) return topicsError;
  }

  const engines = raw.engines;
  if (!isPlainObject(engines)) return `${where}.engines: needs research, write and review`;
  const enginesKeyError = unknownKeyError(engines, ['research', 'write', 'review', 'agent'], `${where}.engines`);
  if (enginesKeyError) return enginesKeyError;
  for (const key of ['research', 'write', 'review'] as const) {
    const error = articleEngineError(engines[key], `${where}.engines.${key}`, key !== 'research');
    if (error) return error;
  }
  if (engines.agent !== undefined) {
    const error = articleEngineError(engines.agent, `${where}.engines.agent`);
    if (error) return error;
  }

  // The bounds of the local step itself. The chain's indexes are built by
  // buildArticlePipeline, so `parts` here is only a placeholder.
  const assemble = normalizeStepLocal({
    kind: 'assemble',
    parts: [[0]],
    stream: raw.id,
    footer: raw.footer,
    ...(raw.lintTerms !== undefined ? { lintTerms: raw.lintTerms } : {}),
    ...(raw.nameLint !== undefined ? { nameLint: raw.nameLint } : {}),
    ...(raw.quality !== undefined ? { quality: raw.quality } : {}),
  });
  if (!assemble) return `${where}: footer, lintTerms, nameLint or quality is out of bounds`;
  if (isPlainObject(raw.quality)) {
    const qualityKeyError = unknownKeyError(raw.quality, ['minChars', 'minWords', 'minSources'], `${where}.quality`);
    if (qualityKeyError) return qualityKeyError;
  }
  return null;
}

const ARTICLE_DIGEST_KEYS = ['name', 'prompt', 'lang', 'schedule', 'scheduleLabel', 'outputFolder', 'footer', 'engine', 'streams'] as const;

/** Why `raw` is not a usable digest config, or null. Pure. */
export function articleDigestConfigError(raw: unknown, where = 'digest'): string | null {
  if (!isPlainObject(raw)) return `${where}: needs an object`;
  const keyError = unknownKeyError(raw, ARTICLE_DIGEST_KEYS, where);
  if (keyError) return keyError;
  const commonError = articleCommonError(raw, where) ?? articleEngineError(raw.engine, `${where}.engine`);
  if (commonError) return commonError;
  if (!normalizeStepLocal({ kind: 'list-drafts', streams: raw.streams })) return `${where}.streams: needs folders and labels, within bounds`;
  if (!normalizeStepLocal({ kind: 'assemble', parts: [[0]], stream: 'digest', footer: raw.footer })) return `${where}.footer: out of bounds`;
  return null;
}

/** Parse the text of the user's config file. Never throws. */
export function parseArticlePipelineFile(text: string): { file: ArticlePipelineFile } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'not valid JSON' };
  }
  if (!isPlainObject(raw)) return { error: 'needs an object' };
  const keyError = unknownKeyError(raw, ['version', 'pipelines', 'digest'], 'file');
  if (keyError) return { error: keyError };
  if (raw.version !== ARTICLE_PIPELINE_FILE_VERSION) return { error: `version: use ${ARTICLE_PIPELINE_FILE_VERSION}` };
  if (!Array.isArray(raw.pipelines) || raw.pipelines.length > ARTICLE_MAX_PIPELINES) return { error: `pipelines: needs a list of at most ${ARTICLE_MAX_PIPELINES}` };
  const ids = new Set<string>(['digest']);
  for (let i = 0; i < raw.pipelines.length; i++) {
    const where = `pipelines[${i}]`;
    const error = articlePipelineConfigError(raw.pipelines[i], where);
    if (error) return { error };
    const id = (raw.pipelines[i] as ArticlePipelineConfig).id;
    if (ids.has(id)) return { error: `${where}.id: "${id}" is taken` };
    ids.add(id);
  }
  if (raw.digest !== undefined) {
    const error = articleDigestConfigError(raw.digest);
    if (error) return { error };
  }
  return { file: raw as unknown as ArticlePipelineFile };
}

export interface ArticleOutputRoots {
  /** The Obsidian vault: settings' agentVaultPath, or its default. */
  vault: string;
  /** The custom output root: settings' agentCustomPath, or ~/agent-output. */
  custom: string;
}

// The same storage under its other names. The executor compares real paths.
const canonicalFolder = (p: string): string =>
  p.replace(/^\/storage\/(?:emulated\/0|self\/primary)(?=\/|$)/, '/sdcard').replace(/\/+$/, '');

const folderInside = (folder: string, root: string): boolean => {
  const f = canonicalFolder(folder);
  const r = canonicalFolder(root);
  return !!r && (f === r || f.startsWith(`${r}/`));
};

/**
 * Why a folder cannot work on this device, or null. Needs the user's settings,
 * so it runs when the file is used, not in the pure config checks. The broker
 * saves only under its roots, and the executor reads a queue and a digest only
 * inside the vault, so `vaultOnly` is set for those.
 */
export function articleOutputFolderError(folder: string, roots: ArticleOutputRoots, vaultOnly: boolean): string | null {
  if (folderInside(folder, roots.vault)) return null;
  if (vaultOnly) return `outputFolder: needs to be inside the vault (${roots.vault})`;
  if (folderInside(folder, roots.custom)) return null;
  return `outputFolder: needs to be inside the vault (${roots.vault}) or the custom folder (${roots.custom})`;
}

const withFolderSlash = (folder: string): string => (folder.endsWith('/') ? folder : `${folder}/`);
const pinned = (tool: ArticleEngine | ArticleTextOnlyEngine): { tool: ToolChoice; toolPinned: true } => ({ tool: tool as ToolChoice, toolPinned: true });

function voiceStep(config: ArticlePipelineConfig, of: number[]): AgentLocalStepConfig {
  const voice = config.voice as ArticleVoiceConfig;
  return { kind: 'voice', of, profile: voice.profile, profileSha256: voice.profileSha256, lang: config.lang, writer: voice.engine ?? DEFAULT_VOICE_ENGINE, review: voice.review, author: voice.author };
}

function editorConfig(config: ArticlePipelineConfig, notes: number[]): AgentArticleEditorConfig {
  const { rubric, minScore, ...engine } = config.editor as ArticleEditorConfig;
  return { notes, lang: config.lang, engine: engine as AgentArticleEditorConfig['engine'], rubric, minScore: minScore ?? EDITOR_DEFAULT_MIN_SCORE };
}

/**
 * One config's draft agent: [research, write, review1, revise1, review2,
 * revise2, assemble] (with `voice` before assemble when configured), with `queue-pop` first on a queued config and
 * `queue-refill` before that when it has a topics instruction. Run by the
 * PlanSpec executor, on the cron or on Run now (the same executor and plan,
 * lib/agent-attended-route.ts isExecutorOnlyChain). It ends in the draft
 * action: it saves a file and publishes nothing. autonomous:false keeps the
 * pinned engines and the local steps (an autonomous plan strips pins). Throws
 * on a config articlePipelineConfigError refuses.
 */
export function buildArticlePipeline(config: ArticlePipelineConfig): PipelinePreset {
  const error = articlePipelineConfigError(config);
  if (error) throw new Error(error);
  const { instructions: ins, engines, lang } = config;
  const refill = ins.topics !== undefined;
  // `of` and `parts` count from the research step.
  const at = (k: number) => k + (config.queue ? 1 : 0) + (refill ? 1 : 0);
  const review = `${ins.review}\n\n${REVIEW_OUTPUT_CONTRACT}`;
  const assemble: AgentLocalStepConfig = {
    kind: 'assemble',
    parts: [[at(1), at(3), at(5)]],
    stream: config.id,
    footer: config.footer,
    ...(config.lintTerms ? { lintTerms: config.lintTerms } : {}),
    ...(config.nameLint ? { nameLint: config.nameLint } : {}),
    ...(config.lintSources ? { lintSources: true } : {}),
    quality: { ...config.quality, selfTalk: true },
    ...(config.editor ? { editor: editorConfig(config, [at(0)]) } : {}),
  };
  const pop: AgentLocalStepConfig = config.materials
    ? {
        kind: 'queue-pop',
        materials: {
          root: config.materials.root,
          maxFiles: config.materials.maxFiles ?? MATERIALS_MAX_FILES,
          maxBytes: config.materials.maxBytes ?? MATERIALS_DEFAULT_MAX_BYTES,
          lang,
        },
      }
    : { kind: 'queue-pop' };
  const popLabel = config.materials
    ? lang === 'en' ? 'Take the next topic from the queue and read the materials it names (no model)' : 'キューから次のテーマを取り、書かれた材料を読む（モデルは使わない）'
    : lang === 'en' ? 'Take the next topic from the queue (no model)' : 'キューから次のテーマを取る（モデルは使わない）';
  const steps: AgentOrchestrationStep[] = [
    ...(refill ? [{ instruction: ins.topics as string, local: { kind: 'queue-refill' } as AgentLocalStepConfig }] : []),
    ...(config.queue ? [{ instruction: popLabel, local: pop }] : []),
    { instruction: ins.research, ...pinned(engines.research) },
    { instruction: ins.write, ...pinned(engines.write) },
    { instruction: review, ...pinned(engines.review), handoff: { kind: 'review', of: [at(0), at(1)], round: 1 } },
    { instruction: ins.revise, ...pinned(engines.write), handoff: { kind: 'revise', of: [at(1), at(2)], round: 1 } },
    { instruction: review, ...pinned(engines.review), handoff: { kind: 'review', of: [at(0), at(3)], round: 2 } },
    { instruction: ins.revise, ...pinned(engines.write), handoff: { kind: 'revise', of: [at(3), at(4)], round: 2 } },
    ...(config.voice ? [{ instruction: lang === 'en' ? 'Ghostwrite the author view from the voice profile (text-only CLI, then a review)' : '本人の見解をプロフィールから代筆する（テキストのみの CLI、査読つき）', local: voiceStep(config, [at(1), at(3), at(5)]) }] : []),
    {
      instruction: config.editor
        ? lang === 'en' ? 'Have the editor score the draft, then assemble it with frontmatter and Sources' : '編集者が下書きを採点し、フロントマターと Sources を付けて組み立てる'
        : lang === 'en' ? 'Assemble the draft with frontmatter and Sources (no model)' : '記事を組み立てて、フロントマターと Sources を付ける（モデルは使わない）',
      local: assemble,
    },
  ];
  return {
    name: config.name,
    prompt: config.prompt,
    orchestration: { steps, longform: true },
    schedule: config.schedule,
    scheduleLabel: config.scheduleLabel ?? config.schedule,
    autonomous: false,
    tool: (engines.agent ?? engines.research) as ToolChoice,
    action: { type: 'draft' },
    output: { outputPath: withFolderSlash(config.outputFolder), outputTemplate: `{date}-${config.id}.md` },
    memoryOff: true,
  };
}

/**
 * The digest agent: [list-drafts, assemble], no model call anywhere. Schedule it
 * after the last stream has had time to finish. It alone notifies on success
 * (its first lines are the notification). Throws on a config
 * articleDigestConfigError refuses.
 */
export function buildArticleDigestPipeline(config: ArticleDigestConfig): PipelinePreset {
  const error = articleDigestConfigError(config);
  if (error) throw new Error(error);
  const en = config.lang === 'en';
  const save: AgentLocalStepConfig = { kind: 'assemble', parts: [[0]], stream: 'digest', footer: config.footer, plain: true };
  return {
    name: config.name,
    prompt: config.prompt,
    orchestration: {
      steps: [
        { instruction: en ? "List today's drafts (no model)" : 'きょうの下書きを一覧にする（モデルは使わない）', local: { kind: 'list-drafts', streams: config.streams } },
        { instruction: en ? 'Save the list as the digest (no model)' : '一覧をダイジェストとして保存する（モデルは使わない）', local: save },
      ],
      longform: true,
    },
    schedule: config.schedule,
    scheduleLabel: config.scheduleLabel ?? config.schedule,
    autonomous: false,
    tool: config.engine as ToolChoice,
    action: { type: 'draft' },
    output: { outputPath: withFolderSlash(config.outputFolder), outputTemplate: '{date}-digest.md' },
    memoryOff: true,
  };
}

/** Hard clamp so a typo can't request a 5-char or 50000-char "limit". */
export function clampCharLimit(limit: number): number {
  if (!Number.isFinite(limit)) return X_CHAR_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 40), 4000);
}

/**
 * X's actual free-tier post budget is 280 "weighted" units, where full-width
 * characters (hiragana/katakana/CJK ideographs/fullwidth forms/hangul) count
 * as 2 and everything else counts as 1 — so an all-Japanese post effectively
 * caps at 140 characters, not 280. `enforceCharLimit` used to count plain code
 * points (Japanese = 1), which let an all-Japanese "280文字以内" post through
 * at roughly double X's real budget — found via on-device testing 2026-07-31
 * when a generated post couldn't actually fit on X. Not a full reimplementation
 * of twitter-text (no t.co URL discounting to 23, so URL-bearing text has some
 * extra real-world slack beyond what this conservatively counts).
 */
const X_FULLWIDTH_RE = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;

export function xWeightedLength(text: string): number {
  let total = 0;
  for (const ch of Array.from(text)) total += X_FULLWIDTH_RE.test(ch) ? 2 : 1;
  return total;
}

/**
 * Guarantee text is ≤ `limit` X-weighted units (see xWeightedLength) — i.e.
 * the result is guaranteed to actually fit in an X post of that budget.
 * Prefers cutting at a sentence boundary (。．.!?！？ or newline) at or before the
 * limit so the result reads cleanly; falls back to a hard cut + ellipsis. The
 * ellipsis is included WITHIN the budget (result weighted-length ≤ limit).
 */
export function enforceCharLimit(text: string, limit: number): string {
  // Clamp first so a raw 0 / negative / NaN can never break the ≤-limit guarantee.
  const lim = clampCharLimit(limit);
  if (xWeightedLength(text) <= lim) return text;
  const ELLIPSIS = '…'; // not full-width per X_FULLWIDTH_RE — costs 1 unit.
  const budget = Math.max(lim - 1, 1); // reserve 1 unit for the ellipsis
  const chars = Array.from(text);
  let acc = 0;
  let cutIdx = chars.length;
  for (let i = 0; i < chars.length; i++) {
    const w = X_FULLWIDTH_RE.test(chars[i]) ? 2 : 1;
    if (acc + w > budget) {
      cutIdx = i;
      break;
    }
    acc += w;
  }
  const head = chars.slice(0, cutIdx);
  // Find the last sentence terminator within the kept head; only honour it if it
  // keeps a reasonable amount (≥ 60% of the consumed budget) so we don't gut the text.
  const terminators = new Set(['。', '．', '.', '!', '?', '！', '？', '\n']);
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i--) {
    if (terminators.has(head[i])) {
      cut = i;
      break;
    }
  }
  if (cut >= 0 && xWeightedLength(head.slice(0, cut + 1).join('')) >= Math.floor(acc * 0.6)) {
    return head.slice(0, cut + 1).join('').trimEnd();
  }
  return head.join('').trimEnd() + ELLIPSIS;
}
