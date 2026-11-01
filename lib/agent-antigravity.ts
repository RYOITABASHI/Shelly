/**
 * lib/agent-antigravity.ts — "the user asked for Antigravity" detection.
 *
 * Antigravity (`agy`) is deliberately NOT an agent worker and Shelly never
 * launches it (see lib/agent-cli-workers.ts's header). Before 2026-11-01 an
 * @agent request that named it as the instrument ("using Antigravity, …",
 * 「Antigravityで…」, 「agyで…」) was silently ignored: the mention stayed in the
 * task text and the step ran on the default engine with no notice.
 *
 * This module only DETECTS and STRIPS the instrument phrase. It never yields a
 * ToolChoice — there is no Antigravity pin anywhere. The parser records which
 * steps named it (ParsedAgentDraft.antigravityRequested) so the confirm
 * summary can say which engine runs them instead.
 *
 * Same instrument rules as the Codex / Claude Code mentions
 * (lib/agent-tool-mentions.ts, lib/agent-orchestration.ts stripToolPhrase):
 *   JA 「<tok>で / <tok>を使って / <tok>を用いて / <tok>を利用して / <tok>経由で /
 *      <tok>にて」 — 「で」 must not continue into での/では/でも (a topic), and
 *      「Antigravityで作ったアプリ」 (past attributive + noun) describes an object.
 *   EN "with / using / via / through <tok>", a leading "on <tok>,", "use <tok>
 *      to …", and a leading "Antigravity CLI:" label — never in a comparison, never after a past
 *      participle ("the app built with Antigravity").
 *
 * Pure, no store / RN imports.
 */

const TOKEN_SRC = String.raw`(?:\bantigravity\b|アンチグラビティ|\bagy\b)(?:\s*(?:cli\b|agent\b|エージェント))?`;

const JA_RE = new RegExp(
  String.raw`(${TOKEN_SRC})\s*(?:で(?!の|は|も)|にて|を\s*(?:使って|使い|用いて|利用して)|経由で)\s*[、,]?\s*`,
  'gi',
);
const EN_PREP_RE = new RegExp(
  String.raw`\s*,?\s*\b(?:with|using|via|through)\s+(?:(?:the|a)\s+)?${TOKEN_SRC}\s*[,:]?`,
  'gi',
);
// "on Antigravity" only as the lead of the text — mid-sentence ("the news on
// Antigravity") it names the topic.
const EN_ON_LEAD_RE = new RegExp(String.raw`^\s*on\s+(?:the\s+)?${TOKEN_SRC}\s*[,:]?\s*`, 'i');
const EN_USE_TO_RE = new RegExp(String.raw`\buse\s+(?:the\s+)?${TOKEN_SRC}\s+to\s+`, 'gi');
const EN_LABEL_RE = new RegExp(String.raw`^\s*(?:\bantigravity\b|\bagy\b)\s+cli\s*[:：,]\s*`, 'i');

const COMPARISON_RE = /\bcompar(?:e|es|ed|ing|ison)\b|\bvs\.?(?=\s|$)|\bversus\b|比較|比べ|対決|どっち|どちら|違い/i;
const JA_PAST_ATTRIBUTIVE_RE = /^[぀-ゟ一-鿿]{0,6}?[ただ](?=[一-鿿゠-ヿA-Za-z])/;
const EN_PAST_PARTICIPLE_END_RE =
  /\b(?:\w+ed|written|made|done|drawn|taken|given|built|shown|seen|known|chosen|spoken|driven|grown|begun|run|got|gotten|found|told|said)$/i;

/** Filler that may be left of a clause that did nothing but name the tool. */
const FILLER_ONLY_RE = /^(?:(?:全部|すべて|全て|ぜんぶ)\s*)?[、。,.:：!！\s]*$/;

function tidy(s: string): string {
  return s
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s、,:：]+/, '')
    .replace(/\s+([、。,.!?！？])/g, '$1')
    .trim();
}

/**
 * `text` with every Antigravity instrument phrase removed, or null when it has
 * none (a bare topic mention — 「Antigravityについて調べて」 — is not one).
 * Returns '' when the text was nothing but the instrument phrase.
 */
export function stripAntigravityInstrument(text: string | undefined): string | null {
  if (!text) return null;
  if (COMPARISON_RE.test(text)) return null;
  let found = false;
  let out = text;
  out = out.replace(EN_LABEL_RE, () => {
    found = true;
    return '';
  });
  out = out.replace(EN_ON_LEAD_RE, () => {
    found = true;
    return '';
  });
  out = out.replace(JA_RE, (match, _tok, offset: number, whole: string) => {
    const rest = whole.slice(offset + match.length);
    if (JA_PAST_ATTRIBUTIVE_RE.test(rest)) return match;
    found = true;
    return '';
  });
  out = out.replace(EN_USE_TO_RE, () => {
    found = true;
    return '';
  });
  out = out.replace(EN_PREP_RE, (match, offset: number, whole: string) => {
    const before = whole.slice(0, offset).trim();
    if (before && EN_PAST_PARTICIPLE_END_RE.test(before)) return match;
    found = true;
    // Mid-sentence phrase: keep one separating space.
    return offset > 0 && offset + match.length < whole.length ? ' ' : '';
  });
  if (!found) return null;
  const cleaned = tidy(out);
  return FILLER_ONLY_RE.test(cleaned) ? '' : cleaned;
}

/** true when `text` names Antigravity as the instrument of the work. */
export function mentionsAntigravityInstrument(text: string | undefined): boolean {
  return stripAntigravityInstrument(text) !== null;
}

type StepLike = string | { instruction: string; tool?: unknown; apiCall?: unknown };

/**
 * Strip the Antigravity instrument phrase from each step and report which
 * steps named it (indexes into the RETURNED list). A clause that does nothing
 * but name it (「Antigravityで、」) is not a step: like a tool-only clause in
 * lib/agent-orchestration.ts applyToolScopes, it covers the following steps
 * that carry no tool of their own, or — at the very end — the step before it.
 * Pins are never added or changed.
 */
export function markAntigravitySteps<T extends StepLike>(steps: readonly T[]): { steps: T[]; flagged: number[] } {
  const out: T[] = [];
  const flagged = new Set<number>();
  let scope = false;
  steps.forEach((step, idx) => {
    const instruction = typeof step === 'string' ? step : step.instruction;
    const ownTool = typeof step !== 'string' && (step.tool !== undefined || step.apiCall !== undefined);
    const stripped = stripAntigravityInstrument(instruction);
    if (stripped === '') {
      if (idx === steps.length - 1 && out.length > 0) flagged.add(out.length - 1);
      scope = true;
      return;
    }
    const next = stripped === null
      ? step
      : ((typeof step === 'string' ? stripped : { ...(step as object), instruction: stripped }) as T);
    if (stripped !== null || (scope && !ownTool)) flagged.add(out.length);
    out.push(next);
  });
  return { steps: out, flagged: [...flagged].sort((a, b) => a - b) };
}
