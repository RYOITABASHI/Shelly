/**
 * lib/agent-handoff.ts — visible agent hand-off narration for multi-step /
 * fan-out orchestrated runs ("Grok Bot"-style group thread, 2026-10-06).
 *
 * When an orchestrated run (Agent.orchestration with >= 2 steps, optionally
 * with `parallelGroup` fan-out branches) executes, the agent's own chat
 * thread (`agent:<id>`, see store/ai-pane-store.ts) gets short plain-text
 * lines such as 「調査役 → 執筆役: 3件の項目を渡しました」 so the user can see
 * context flowing between steps. Lines are informational only — plain chat
 * text, never a card/modal — and the full step output stays where it lives
 * today (the run log's per-step records).
 *
 * This module is PURE (no store/RN imports) so the same narration drives both
 * executors:
 *   - attended (lib/agent-manager.ts runAgentOrchestratedBody): fed live, one
 *     call per step boundary, each returned line posted as it happens;
 *   - unattended (scripts/shelly-plan-executor.js): that executor runs outside
 *     RN and already writes per-step records (index/instruction/status/
 *     outputPreview/parallelGroup) into its run log, so the RN-side log sync
 *     replays those records through the same narrator after the fact and
 *     posts ONE coalesced digest message. No executor change, no new file.
 *
 * Coalescing contract: at most one line per step BOUNDARY. A fan-out group's
 * branches are folded into a single "N branches aggregated" line emitted when
 * the group's LAST branch finishes (branch completions themselves emit
 * nothing), so a 3-branch fan-out costs one line, not three. A per-run line
 * cap (MAX_HANDOFF_LINES_PER_RUN) bounds a pathological long chain; the
 * terminal line (finished/stopped) is always emitted regardless of the cap.
 *
 * Secrets: every summary passes through redactSecretsText (lib/redact-
 * secrets.ts) BEFORE truncation, so a key can never be cut in half into a
 * shape the patterns no longer recognise.
 */

import { redactSecretsText } from './redact-secrets';

export type HandoffTranslate = (key: string, params?: Record<string, string | number>) => string;

/** Minimal step shape the narrator needs — satisfied by both
 *  lib/agent-orchestration.ts's NormalizedStep and AgentRunStep. */
export interface HandoffStepInput {
  instruction: string;
  /** EFFECTIVE parallel-group id (planParallelGroups().group[i] for the
   *  attended path, AgentRunStep.parallelGroup for the unattended replay) —
   *  never the raw declared marker, which may have been demoted to serial. */
  parallelGroup?: string;
}

/** Minimal per-step result shape — satisfied by AgentRunStep. */
export interface HandoffRecordInput {
  index: number;
  status: 'success' | 'error' | 'skipped' | 'unavailable';
  outputPreview: string;
}

/** Max visible characters of a step's output snippet in a hand-off line. */
export const HANDOFF_SNIPPET_MAX_CHARS = 60;
/** Branch snippets are shorter — they share one aggregated line. */
export const HANDOFF_BRANCH_SNIPPET_MAX_CHARS = 32;
/** Upper bound on non-terminal lines per run (the terminal line is extra). */
export const MAX_HANDOFF_LINES_PER_RUN = 8;

type RoleKey =
  | 'researcher'
  | 'summarizer'
  | 'writer'
  | 'reviewer'
  | 'translator'
  | 'publisher';

// Ordered: the first matching rule wins, so the more specific verbs come
// first (e.g. "summarize the research" is a summarizer, not a researcher).
const ROLE_RULES: Array<{ role: RoleKey; pattern: RegExp }> = [
  { role: 'translator', pattern: /translat|翻訳|訳し/i },
  { role: 'summarizer', pattern: /summari[sz]|digest|aggregat|condense|要約|まとめ|集約|整理/i },
  { role: 'reviewer', pattern: /review|verif|check|proofread|fact[- ]?check|確認|検証|レビュー|校正|チェック/i },
  // An instruction that LEADS with a delivery verb ("post the draft to X")
  // publishes; otherwise "write a post" / 「投稿文を書いて」 is a writing job,
  // so the writer rule outranks the general delivery-noun rule below it.
  { role: 'publisher', pattern: /^\s*(?:post|publish|tweet|send|notify)\b/i },
  { role: 'writer', pattern: /writ|draft|compose|article|執筆|書い|書く|下書き|作文|記事/i },
  { role: 'publisher', pattern: /\bpost\b|publish|tweet|send|notify|投稿|送信|通知|配信|ポスト/i },
  { role: 'researcher', pattern: /research|collect|gather|search|find|fetch|look up|investigat|調査|収集|集め|検索|探|調べ|リサーチ/i },
];

/** Keyword role of one step instruction, or null when nothing matches. */
export function classifyStepRole(instruction: string): RoleKey | null {
  for (const rule of ROLE_RULES) {
    if (rule.pattern.test(instruction)) return rule.role;
  }
  return null;
}

/**
 * Display label per step. A recognised verb maps to a role (調査役/執筆役/…);
 * otherwise "Step N". When two steps share a role the label gets its 1-based
 * step number appended so "調査役 → 調査役" never appears ambiguous.
 */
export function deriveStepRoleLabels(steps: HandoffStepInput[], tr: HandoffTranslate): string[] {
  const roles = steps.map((s) => classifyStepRole(s.instruction));
  const counts = new Map<RoleKey, number>();
  for (const r of roles) if (r) counts.set(r, (counts.get(r) ?? 0) + 1);
  return roles.map((role, i) => {
    if (!role) return tr('handoff.role.step', { n: i + 1 });
    const base = tr(`handoff.role.${role}`);
    return (counts.get(role) ?? 0) > 1 ? `${base}${i + 1}` : base;
  });
}

const LIST_ITEM_RE = /^\s*(?:[-*•・]|\d{1,3}[.)、:])\s+\S/;

/** Number of list-shaped lines (bullets / numbered items) in a step output. */
export function countListItems(text: string): number {
  return text.split(/\r?\n/).filter((line) => LIST_ITEM_RE.test(line)).length;
}

/** Redact, de-markdown, collapse whitespace, then truncate to `max` chars. */
export function snippetForHandoff(text: string, max: number = HANDOFF_SNIPPET_MAX_CHARS): string {
  const cleaned = redactSecretsText(text ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*•・]|\d{1,3}[.)、:])\s+/gm, '')
    .replace(/[*_`>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** "3件の項目を渡しました — 「…」" style summary of what a step handed on. */
export function summarizeHandoffPayload(
  output: string,
  tr: HandoffTranslate,
  max: number = HANDOFF_SNIPPET_MAX_CHARS,
): string {
  const snippet = snippetForHandoff(output, max);
  if (!snippet) return tr('handoff.no_output');
  const items = countListItems(redactSecretsText(output ?? ''));
  return items >= 2
    ? tr('handoff.summary_items', { count: items, snippet })
    : tr('handoff.summary_text', { snippet });
}

/**
 * Stateful narrator for ONE run. Feed it every step start/finish in execution
 * order; it returns the (0..n) lines to post at that boundary. Never throws on
 * out-of-range indices — an unknown index simply narrates nothing — because a
 * cosmetic narration bug must never be able to fail a real agent run.
 */
export class HandoffNarrator {
  private readonly labels: string[];
  private readonly groupResults = new Map<string, HandoffRecordInput[]>();
  private emitted = 0;
  private terminated = false;

  constructor(
    private readonly steps: HandoffStepInput[],
    private readonly tr: HandoffTranslate,
  ) {
    this.labels = deriveStepRoleLabels(steps, tr);
  }

  /** Label for step i (exposed for tests and log lines). */
  labelOf(i: number): string {
    return this.labels[i] ?? this.tr('handoff.role.step', { n: i + 1 });
  }

  private groupOf(i: number): string | undefined {
    return this.steps[i]?.parallelGroup;
  }

  /** Member indices of the contiguous group containing step i. */
  private groupMembers(i: number): number[] {
    const g = this.groupOf(i);
    if (!g) return [i];
    let start = i;
    while (start > 0 && this.groupOf(start - 1) === g) start--;
    const members: number[] = [];
    for (let j = start; j < this.steps.length && this.groupOf(j) === g; j++) members.push(j);
    return members;
  }

  /** Label of the destination of a hand-off out of step i: the next serial
   *  step, or "N branches (A / B / C)" when the next step opens a group. */
  private destinationLabel(nextIndex: number): string {
    if (this.groupOf(nextIndex)) {
      const members = this.groupMembers(nextIndex);
      return this.tr('handoff.branches_label', {
        count: members.length,
        roles: members.map((j) => this.labelOf(j)).join(' / '),
      });
    }
    return this.labelOf(nextIndex);
  }

  private push(lines: string[], line: string): void {
    if (this.emitted >= MAX_HANDOFF_LINES_PER_RUN) return;
    this.emitted++;
    lines.push(line);
  }

  /** Call right before step i is dispatched. Only a group opening at the very
   *  start of the chain narrates here (otherwise the preceding step's
   *  hand-off line already announced the branches). */
  stepStarting(i: number): string[] {
    const lines: string[] = [];
    if (this.terminated || i !== 0 || !this.groupOf(0)) return lines;
    const members = this.groupMembers(0);
    this.push(lines, this.tr('handoff.group_start', {
      count: members.length,
      roles: members.map((j) => this.labelOf(j)).join(' / '),
    }));
    return lines;
  }

  /** Call when the chain stops early for a non-failure reason (step/time
   *  budget). Terminal; a no-op once a terminal line was already emitted. */
  chainHalted(): string[] {
    if (this.terminated) return [];
    this.terminated = true;
    return [this.tr('handoff.halted')];
  }

  /** Call right after step `record.index` finished (any status). */
  stepFinished(record: HandoffRecordInput): string[] {
    const lines: string[] = [];
    const i = record.index;
    if (this.terminated || i < 0 || i >= this.steps.length) return lines;

    if (record.status !== 'success') {
      // Fail-fast in both executors: a non-success step stops the chain.
      // Terminal line — always emitted, bypasses the cap.
      this.terminated = true;
      lines.push(this.tr('handoff.stopped', {
        role: this.labelOf(i),
        summary: snippetForHandoff(record.outputPreview) || this.tr('handoff.no_output'),
      }));
      return lines;
    }

    const isLast = i === this.steps.length - 1;
    const group = this.groupOf(i);
    if (group) {
      const bucket = this.groupResults.get(group) ?? [];
      bucket.push(record);
      this.groupResults.set(group, bucket);
      const members = this.groupMembers(i);
      // Coalesce: branches emit nothing until the group's last member is in.
      if (bucket.length < members.length) return lines;
      this.groupResults.delete(group);
      const next = members[members.length - 1] + 1;
      const branchLines = members.map((j) => {
        const rec = bucket.find((r) => r.index === j);
        return `• ${this.labelOf(j)}: ${snippetForHandoff(rec?.outputPreview ?? '', HANDOFF_BRANCH_SNIPPET_MAX_CHARS) || this.tr('handoff.no_output')}`;
      });
      const head = next < this.steps.length
        ? this.tr('handoff.group_done', { count: members.length, to: this.destinationLabel(next) })
        : this.tr('handoff.group_done_final', { count: members.length });
      this.push(lines, [head, ...branchLines].join('\n'));
      return lines;
    }

    if (isLast) {
      this.terminated = true;
      lines.push(this.tr('handoff.finished', {
        role: this.labelOf(i),
        steps: this.steps.length,
        // Neutral result snippet: the final step hands nothing on, so the
        // "N件の項目を渡しました" phrasing would misdescribe it.
        result: snippetForHandoff(record.outputPreview) || this.tr('handoff.no_output'),
      }));
      return lines;
    }

    this.push(lines, this.tr('handoff.pass', {
      from: this.labelOf(i),
      to: this.destinationLabel(i + 1),
      summary: summarizeHandoffPayload(record.outputPreview, this.tr),
    }));
    return lines;
  }
}

/**
 * Unattended replay: narrate an already-finished run's per-step records (as
 * written into the run log by scripts/shelly-plan-executor.js) into ONE
 * digest string, or null when there is nothing worth showing (a single-step
 * run, or no records). The planned step list is not in the log, so the
 * records themselves stand in for it — a chain the budget cut short after a
 * success therefore reads as finished at its last executed step.
 */
export function buildHandoffDigest(
  agentName: string,
  records: Array<HandoffRecordInput & HandoffStepInput>,
  tr: HandoffTranslate,
): string | null {
  if (!Array.isArray(records) || records.length < 2) return null;
  const ordered = [...records].sort((a, b) => a.index - b.index)
    // Re-index densely: the narrator addresses steps by position.
    .map((r, pos) => ({ ...r, index: pos }));
  const narrator = new HandoffNarrator(
    ordered.map((r) => ({ instruction: r.instruction, parallelGroup: r.parallelGroup })),
    tr,
  );
  const lines: string[] = [];
  for (const rec of ordered) {
    lines.push(...narrator.stepStarting(rec.index));
    lines.push(...narrator.stepFinished(rec));
  }
  if (lines.length === 0) return null;
  return [tr('handoff.digest_header', { agentName: redactSecretsText(agentName) }), ...lines].join('\n');
}
