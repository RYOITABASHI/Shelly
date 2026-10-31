/**
 * lib/agent-cli-workers.ts — the CLI agent workers (`ToolChoice { type: 'cli' }`).
 *
 * One table per CLI so every surface (labels, NL tool mentions, MONITOR
 * provider ids / picker, provider overrides, the run-script generator, the
 * driver engine) reads the same facts. Adding a CLI (e.g. Antigravity `agy`)
 * means: a new AgentCliId in store/types.ts, a row here, an `--engine` in
 * scripts/shelly-agent-driver.js that maps its permission requests onto the
 * shared gateCommandActions() core, and the MONITOR / override enums.
 *
 *  - codex  — Codex CLI (`codex_tui app-server`), approvals over JSON-RPC.
 *  - claude — Claude Code (official linux-arm64 glibc build, Claude glibc
 *             S1–S4), headless stream-json with `--permission-prompt-tool stdio`.
 *
 * Pure, no store / RN imports.
 */
import type { AgentCliId, ToolChoice } from '@/store/types';

export type { AgentCliId };

export interface AgentCliWorker {
  id: AgentCliId;
  /** toolChoiceToLabel / run-log label. */
  label: string;
  /** Short product name (MONITOR picker, summaries). */
  shortLabel: string;
  /** lib/monitor-team.ts MonitorProvider id. */
  monitorProvider: 'codex-cli' | 'claude-cli';
  /** scripts/shelly-agent-driver.js --engine value. */
  driverEngine: AgentCliId;
  /** Regex source for "the user named this CLI" (lib/agent-tool-mentions.ts).
   *  Latin tokens are \b-bounded; JA tokens are plain substrings. */
  mentionSrc: string;
}

export const AGENT_CLI_WORKERS: Readonly<Record<AgentCliId, AgentCliWorker>> = {
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    shortLabel: 'Codex',
    monitorProvider: 'codex-cli',
    driverEngine: 'codex',
    mentionSrc: String.raw`\bcodex\b`,
  },
  claude: {
    id: 'claude',
    label: 'Claude Code',
    shortLabel: 'Claude Code',
    monitorProvider: 'claude-cli',
    driverEngine: 'claude',
    mentionSrc: String.raw`\bclaude(?:\s*code)?\b|クロード(?:\s*コード)?`,
  },
};

export const AGENT_CLI_IDS: readonly AgentCliId[] = ['codex', 'claude'];

export function isAgentCliId(value: unknown): value is AgentCliId {
  return typeof value === 'string' && (AGENT_CLI_IDS as readonly string[]).includes(value);
}

export function cliTool(id: AgentCliId): ToolChoice {
  return { type: 'cli', cli: id };
}

/** The CLI a tool runs on, or undefined for a non-CLI tool. Unknown `cli`
 *  values (an older/foreign file) fall back to codex — the only CLI that
 *  existed before S4 — so legacy data keeps its meaning. */
export function cliIdOf(tool: { type?: string; cli?: unknown } | null | undefined): AgentCliId | undefined {
  if (!tool || tool.type !== 'cli') return undefined;
  return isAgentCliId(tool.cli) ? tool.cli : 'codex';
}

/** Provider identity: type, plus the CLI for `cli` tools ("is this the same
 *  provider", ignoring models). */
export function providerIdentity(tool: { type?: string; cli?: unknown } | null | undefined): string {
  if (!tool || typeof tool.type !== 'string') return '';
  return tool.type === 'cli' ? `cli:${cliIdOf(tool)}` : tool.type;
}

export function sameProvider(
  a: { type?: string; cli?: unknown } | null | undefined,
  b: { type?: string; cli?: unknown } | null | undefined,
): boolean {
  return providerIdentity(a) !== '' && providerIdentity(a) === providerIdentity(b);
}
