/**
 * lib/agent-tool-mentions.ts — the single table of "the user NAMED a tool"
 * patterns (Perplexity / local LLM / Codex / Claude Code / Gemini), shared by:
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
import { AGENT_CLI_WORKERS } from './agent-cli-workers';

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
  { re: new RegExp(AGENT_CLI_WORKERS.codex.mentionSrc, 'i'), tool: { type: 'cli', cli: 'codex' } },
  // Claude glibc S4: 「Claude/クロード(コード)で…」 / "with Claude Code".
  { re: new RegExp(AGENT_CLI_WORKERS.claude.mentionSrc, 'i'), tool: { type: 'cli', cli: 'claude' } },
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
// agent-level pin additionally requires the tool to be the INSTRUMENT of the
// request, around the SAME TOOL_MENTIONS token:
//   JA 「<tool>で / <tool>を使って / <tool>経由で / <tool>に聞いて…」 (optionally
//      "<tool>(の)API…"); 「で」 must not continue into での/では/でも
//      (「Codexでの評判を調べて」 is about Codex, not done with it).
//   EN "with / using / via / through / ask <tool>", and "use <tool> to …"
//      only (bare "how developers use Codex" is a topic).
// Review M2 (2026-10-15).
const JA_USAGE_SUFFIX = String.raw`(?:\s*の?\s*api)?\s*(?:で(?!の|は|も)|を\s*(?:使|用い|利用|経由)|経由|に\s*(?:聞|訊|尋|調べ|頼|依頼|リサーチ|検索|まとめ|要約))`;
const EN_USAGE_PREFIX = String.raw`\b(?:with|using|via|through|ask)\s+(?:the\s+)?`;
const EN_USE_TO = (src: string) => String.raw`\buse\s+(?:the\s+)?(?:` + src + String.raw`)(?:\s+api)?\s+to\b`;

const EXPLICIT_TOOL_USAGE: ReadonlyArray<{ re: RegExp; tool: ToolChoice }> = TOOL_MENTIONS.map(({ re, tool }) => ({
  re: new RegExp(`(?:${re.source})${JA_USAGE_SUFFIX}|${EN_USAGE_PREFIX}(?:${re.source})|${EN_USE_TO(re.source)}`, 'i'),
  tool,
}));

// A comparison of tools ("compare Gemini with Codex", "Gemini vs Codex",
// 「GeminiとCodexを比較して」) names tools as the SUBJECT of the task — never a pin.
const COMPARISON_RE = /\bcompar(?:e|es|ed|ing|ison)\b|\bvs\.?(?=\s|$)|\bversus\b|比較|比べ|対決|どっち|どちら|違い/i;
// "developers are using Codex" / "people who use Gemini" — the tool is what
// someone else uses, i.e. the topic.
const THIRD_PARTY_USE_RE = /\b(?:are|is|was|were|be|been|people|developers|users|who|they|teams?)\s+(?:using|use|used)\b/i;

/**
 * The tool the user EXPLICITLY said to use in a single-clause request, or
 * undefined. Same TOOL_MENTIONS table (and the same first-match-wins order)
 * as matchToolMention, narrowed by the instrument context above and never
 * for a comparison or a third-party-usage topic.
 */
export function detectExplicitToolUsage(text: string | undefined): ToolChoice | undefined {
  if (!text) return undefined;
  if (COMPARISON_RE.test(text) || THIRD_PARTY_USE_RE.test(text)) return undefined;
  for (const { re, tool } of EXPLICIT_TOOL_USAGE) {
    if (re.test(text)) return { ...tool } as ToolChoice;
  }
  return undefined;
}
