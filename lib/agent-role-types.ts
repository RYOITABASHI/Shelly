/**
 * lib/agent-role-types.ts — agent roles (Inc A, WP0): types, limits and the
 * shared task-kind classifier.
 *
 * A role is a reusable definition (name, instructions, engine, workspace
 * policy, the task kinds it handles). Roles live in ~/.shelly/agents/roles.json
 * (lib/agent-role-store.ts) and are SNAPSHOTTED onto orchestration steps at
 * creation time (AgentOrchestrationStep.role) — no runtime ever reads the
 * roles file. Design: docs/superpowers/specs/2026-11-02-agent-roles-design.md.
 *
 * Pure: no RN / store imports (type-only import of ToolChoice).
 */
import type { ToolChoice } from '@/store/types';

/** What a role can be assigned to. */
export type RoleKind = 'implement' | 'review' | 'research' | 'write' | 'summarize' | 'translate' | 'judge';

export const ROLE_KINDS: readonly RoleKind[] = ['implement', 'review', 'research', 'write', 'summarize', 'translate', 'judge'];

/**
 * Task kind of one unit of work: every RoleKind plus `publish` (a delivery
 * step — never assigned to a role, but the hand-off narrator labels it).
 */
export type TaskKind = RoleKind | 'publish';

/**
 * Engines a role may use. `auto` and the A/B article evaluator are excluded;
 * Antigravity is unrepresentable (AgentCliId is codex | claude only), so a
 * role can never name it.
 */
export type RoleEngine = Exclude<ToolChoice, { type: 'auto' } | { type: 'ab-article-eval' }>;

export const ROLE_ENGINE_TYPES: readonly RoleEngine['type'][] = [
  'cli',
  'gemini-api',
  'cerebras',
  'groq',
  'openrouter',
  'local',
  'perplexity',
];

/** Which workspace a role's step runs in. */
export type AgentRoleWorkspace = { mode: 'request' } | { mode: 'fixed'; path: string };

export interface AgentRole {
  id: string;
  name: string;
  instructions: string;
  engine: RoleEngine;
  handles: RoleKind[];
  workspace: AgentRoleWorkspace;
  defaultSteps?: string[];
  autoAttach?: 'after-implement';
  createdAt: number;
  updatedAt: number;
}

/** On-disk shape of ~/.shelly/agents/roles.json. No top-level `id`, so every
 *  agents-dir scanner (isAgentMetadata etc.) skips it like policy.json. */
export interface AgentRolesFile {
  kind: 'shelly-roles';
  version: 1;
  roles: AgentRole[];
}

/** Result of loading roles. `unavailable` = fail-closed (routing disabled). */
export interface LoadedRoles {
  roles: AgentRole[];
  unavailable: boolean;
  reason?: string;
}

/** The snapshot of a role carried on an orchestration step. */
export interface AgentStepRole {
  id: string;
  name: string;
  instructions: string;
  /** roleDefinitionHash of the role at snapshot time. */
  roleHash: string;
}

/** Per-role approval level (stored only in SecureStore, never in roles.json). */
export type RoleLevel = 'off' | 'standard' | 'all';

/** Who asked for a level change. Only the user's typed chat may set one. */
export type RoleLevelVia = 'chat';

/** What the router decided for one draft (WP3 fills it; WP0 only types it). */
export interface RoleRoutingAssignment {
  /** Index into the routed draft's orchestration steps (0 for a single unit). */
  stepIndex: number;
  roleId: string;
  roleName: string;
  engine: RoleEngine;
  kind: TaskKind;
  /** roleDefinitionHash of the role when it was assigned (the confirm
   *  re-verifies the level against it). */
  roleHash?: string;
  /** The role's verified level when it was assigned (display + minLevel). */
  level?: RoleLevel;
}

export interface RoleRoutingInfo {
  assignments: RoleRoutingAssignment[];
  /** Minimum level of the assigned roles — what the confirm text states. */
  minLevel: RoleLevel;
  /** true only when the draft came from the user's own typing in the chat:
   *  only then may the confirm write the roles' level to the agent (never
   *  for a terminal request / voice / widget / inbound / MONITOR team draft). */
  levelEligible?: boolean;
  /** Home-relative workspace the routed agent will use, when one was chosen. */
  workspaceRoot?: string;
  /** Plain-text caveats for the confirm text (workspace conflict, serialized
   *  same-engine branches, ...). i18n keys or already-translated lines. */
  notes?: string[];
}

/** Pending role operation awaiting the user's typed confirm (WP2). */
export type PendingRoleChange =
  | { op: 'create'; role: AgentRole; level?: RoleLevel; attempts: number; createdAt: number }
  | { op: 'edit'; roleId: string; role: AgentRole; level?: RoleLevel; attempts: number; createdAt: number }
  | { op: 'delete'; roleId: string; roleName: string; attempts: number; createdAt: number }
  | { op: 'level'; roleId: string; roleName: string; level: RoleLevel; attempts: number; createdAt: number }
  | { op: 'reset'; attempts: number; createdAt: number };

// ─── Limits ────────────────────────────────────────────────────────────────

export const MAX_ROLES = 20;
export const ROLE_NAME_MAX_CHARS = 24;
export const ROLE_INSTRUCTIONS_MAX_CHARS = 600;
/** Cap of the composed `# Your role` prompt block. */
export const ROLE_PROMPT_MAX_CHARS = 900;
export const MAX_ROLE_DEFAULT_STEPS = 3;
export const ROLE_DEFAULT_STEP_MAX_CHARS = 300;
export const ROLE_WORKSPACE_PATH_MAX_CHARS = 256;

/** Relative to $HOME. Inside the gate-protected agents dir. */
export const ROLES_RELATIVE_PATH = '.shelly/agents/roles.json';

// ─── Task-kind classifier ──────────────────────────────────────────────────

/**
 * Ordered keyword table: the first matching rule wins. `implement` and
 * `judge` lead; the rest is the hand-off narrator's original table
 * (lib/agent-handoff.ts), in its original order, so the narrator — which
 * classifies with those two kinds excluded — keeps its exact behavior.
 */
export const TASK_KIND_RULES: ReadonlyArray<{ kind: TaskKind; pattern: RegExp }> = [
  {
    kind: 'implement',
    // An instruction that LEADS with a review verb ("review the build
    // script") is a review, even when it names something buildable. The
    // noun forms ("implementations", 「2つの実装を比べて」) are not implement
    // work, so a comparison falls through to `judge`.
    pattern:
      /^(?!\s*(?:please\s+)?(?:review|check|verify|audit|inspect|proofread)\b)[\s\S]*(?:\bimplement(?:s|ed|ing)?\b|\bbuild\b(?!\s+(?:logs?|status|output|errors?)\b)|\bdevelop\b|\brefactor|\bprogram(?:ming)?\b|\bwrite\s+(?:[\w-]+\s+){0,2}(?:code|script|program|tests?)\b|\bfix\s+(?:the\s+|a\s+|this\s+|these\s+)?(?:bugs?|errors?|issues?|code|findings)\b|\b(?:make|create)\s+(?:an?\s+|the\s+)?(?:[\w-]+\s+){0,2}(?:app|game|website|site|script|tool|program|cli|function|page)\b|実装(?:して|する|しろ|しな|を(?:して|お願い))|開発|コードを書|プログラムを書|プログラミング|リファクタ|バグを(?:直|修正)|バグ修正|(?:ゲーム|アプリ|ツール|サイト|スクリプト|ページ|プログラム)を(?:作|つく))/i,
  },
  {
    kind: 'judge',
    pattern: /\bjudge\b|\bcompare\b|\b(?:pick|choose|select)\s+the\s+(?:better|best)\b|\bwhich\s+(?:one\s+)?is\s+better\b|審査|比較|比べ|判定|良い方を選|どちらが良い|優劣/i,
  },
  { kind: 'translate', pattern: /translat|翻訳|訳し/i },
  { kind: 'summarize', pattern: /summari[sz]|digest|aggregat|condense|要約|まとめ|集約|整理/i },
  { kind: 'review', pattern: /review|verif|check|proofread|fact[- ]?check|確認|検証|レビュー|校正|チェック/i },
  // An instruction that LEADS with a delivery verb ("post the draft to X")
  // publishes; otherwise "write a post" / 「投稿文を書いて」 is a writing job,
  // so the writer rule outranks the general delivery-noun rule below it.
  { kind: 'publish', pattern: /^\s*(?:post|publish|tweet|send|notify)\b/i },
  { kind: 'write', pattern: /writ|draft|compose|article|執筆|書い|書く|下書き|作文|記事/i },
  { kind: 'publish', pattern: /\bpost\b|publish|tweet|send|notify|投稿|送信|通知|配信|ポスト/i },
  { kind: 'research', pattern: /research|collect|gather|search|find|fetch|look up|investigat|調査|収集|集め|検索|探|調べ|リサーチ/i },
];

export interface ClassifyTaskKindOptions {
  /** Kinds to skip (the hand-off narrator skips implement / judge). */
  exclude?: readonly TaskKind[];
}

/** Keyword task kind of one instruction, or null when nothing matches. */
export function classifyTaskKind(instruction: string, opts: ClassifyTaskKindOptions = {}): TaskKind | null {
  const text = String(instruction ?? '');
  const exclude = opts.exclude;
  for (const rule of TASK_KIND_RULES) {
    if (exclude && exclude.includes(rule.kind)) continue;
    if (rule.pattern.test(text)) return rule.kind;
  }
  return null;
}

export function isRoleKind(v: unknown): v is RoleKind {
  return typeof v === 'string' && (ROLE_KINDS as readonly string[]).includes(v);
}
