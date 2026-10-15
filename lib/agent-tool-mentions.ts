/**
 * lib/agent-tool-mentions.ts — the single table of "the user NAMED a tool"
 * patterns (Perplexity / local LLM / Codex / Gemini), shared by:
 *
 *   - lib/agent-orchestration.ts's per-clause step pinning
 *     (detectToolPinnedSteps / tagStepsWithToolMentions) — a clause of a
 *     ≥2-clause chain that mentions a tool gets `.tool` pinned to it;
 *   - lib/agent-tool-router.ts's suggestToolForDraft — a SINGLE-clause request
 *     that explicitly says to USE a tool ("パープレで…", "research X with
 *     Perplexity") pins the agent-level `tool` to it, overriding keyword
 *     scoring (2026-10-15: before this, a single-clause "パープレで最新のLLM
 *     論文をリサーチして要約して" was routed purely by suggestTool's keyword
 *     tiers, so the named tool was only honored when it happened to coincide
 *     with the topic heuristic).
 *
 * Kept in its own module (rather than inside agent-orchestration.ts) so
 * agent-tool-router.ts can import it without an import cycle.
 */
import type { ToolChoice } from '@/store/types';
import { GEMINI_WEB, PERPLEXITY_WEB } from './agent-router-scoring';

export interface ToolMention {
  re: RegExp;
  tool: ToolChoice;
}

// Ordered; the FIRST pattern that matches a clause wins (a clause naming two
// tools is not a supported phrasing — pick the earliest/most specific). JP
// tokens match as a plain substring (no word boundary — CJK has none); Latin
// tokens use \b so e.g. "codex" doesn't fire inside an unrelated longer word.
export const TOOL_MENTIONS: readonly ToolMention[] = [
  { re: /パープレ(?:キシティ)?|perplexity/i, tool: PERPLEXITY_WEB },
  { re: /ローカル\s*llm|local\s*llm|ローカル/i, tool: { type: 'local' } },
  { re: /\bcodex\b/i, tool: { type: 'cli', cli: 'codex' } },
  { re: /\bgemini\b/i, tool: GEMINI_WEB },
];

/** Per-clause match used by the multi-step chain detectors: inside a chain,
 *  each clause is short and its tool mention is almost always the instrument
 *  ("パープレで集めて、ローカルLLMで要約して"), so a bare mention suffices. */
export function matchToolMention(clause: string): ToolChoice | undefined {
  for (const { re, tool } of TOOL_MENTIONS) {
    if (re.test(clause)) return tool;
  }
  return undefined;
}

// A single-clause request can also merely be ABOUT a tool ("Geminiの最新
// ニュースを集めて", "summarize Perplexity's new features"), so the
// agent-level pin additionally requires instrumental usage context around the
// SAME TOOL_MENTIONS token: JA 「<tool>で / <tool>を使って / <tool>経由で /
// <tool>に聞いて…」 (optionally "<tool>(の)API…"), EN "with / using / via /
// through / use / ask <tool>".
const JA_USAGE_SUFFIX =
  '(?:\\s*の?\\s*api)?\\s*(?:で|を\\s*(?:使|用い|利用|経由)|経由|に\\s*(?:聞|訊|尋|調べ|頼|依頼|リサーチ|検索|まとめ|要約))';
const EN_USAGE_PREFIX = '\\b(?:with|using|via|through|use|ask)\\s+(?:the\\s+)?';

const EXPLICIT_TOOL_USAGE: ReadonlyArray<{ re: RegExp; tool: ToolChoice }> = TOOL_MENTIONS.map(({ re, tool }) => ({
  re: new RegExp(`(?:${re.source})${JA_USAGE_SUFFIX}|${EN_USAGE_PREFIX}(?:${re.source})`, 'i'),
  tool,
}));

/**
 * The tool the user EXPLICITLY said to use in a single-clause request, or
 * undefined. Same TOOL_MENTIONS table (and the same first-match-wins order)
 * as matchToolMention, narrowed by the usage context above.
 */
export function detectExplicitToolUsage(text: string | undefined): ToolChoice | undefined {
  if (!text) return undefined;
  for (const { re, tool } of EXPLICIT_TOOL_USAGE) {
    if (re.test(text)) return { ...tool } as ToolChoice;
  }
  return undefined;
}
