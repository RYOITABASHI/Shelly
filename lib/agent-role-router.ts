/**
 * lib/agent-role-router.ts — agent roles (Inc A, WP3): deterministic routing
 * of an `@agent` draft's units of work to the user's roles.
 *
 * Design: docs/superpowers/specs/2026-11-02-agent-roles-design.md §3.
 *
 *  - Units = the draft's orchestration steps, else its prompt. A unit that
 *    names two or more roles ("have the implementer build X and the reviewer
 *    check it") is split at each later role mention.
 *  - Kind = classifyTaskKind; a role named in the unit overrides the kind.
 *  - Candidates = roles handling the kind, oldest first. Codex / Claude Code
 *    roles are excluded when the agent runs unattended (a fireable schedule,
 *    continuous mode, a notification trigger) and after a research unit
 *    (taint: its input carries web text).
 *  - A parallel group gets different roles, preferably different engines.
 *    "compete" / "both … compare" / 「競わせて」 with ≥2 implementer roles
 *    duplicates the implement unit into 2–3 branches (MAX_PARALLEL_BRANCHES).
 *  - An `autoAttach: 'after-implement'` reviewer is appended after the last
 *    implement unit (not after competing branches — the final step compares).
 *  - The last unit on a CLI role with ≥2 units → an unpinned final summary
 *    step, so the agent tool stays local and decideAttendedRoute can pick the
 *    PlanSpec executor. Multi-step routed agents always use tool `local`.
 *  - A single unit → a single-step agent on the role's engine, the role block
 *    prefixed to the prompt.
 *
 * No routing when the user named a tool, pinned a step, asked for
 * Antigravity, said "without roles" / 「ロールなしで」, has an api-call step,
 * a ClosePaw / social-post / browser-pane action, a matched skill with an
 * executable plan, asked for autonomous mode, or roles are unavailable.
 * Routed agents are never autonomous.
 *
 * Pure: no RN / store / shell. The caller passes the loaded roles and their
 * verified levels.
 */
import type { ParsedAgentDraft } from './agent-nl-parser';
import type { AgentOrchestrationStep } from '@/store/types';
import { classifyTaskKind, type AgentRole, type LoadedRoles, type RoleEngine, type RoleKind, type RoleLevel, type RoleRoutingAssignment, type RoleRoutingInfo, type TaskKind } from './agent-role-types';
import { composeRoleInstructions, minRoleLevel, roleDefinitionHash, toStepRole } from './agent-role-store';
import { roleNameKey } from './agent-role-intent';
import {
  HARD_MAX_STEPS,
  MAX_HANDOFF_ROUNDS,
  MAX_PARALLEL_BRANCHES,
  REVIEW_OUTPUT_CONTRACT,
  judgeOutputContract,
  type StepHandoff,
} from './agent-orchestration';
import { toolChoiceToLabel } from './agent-tool-router';
import { runWithoutApprovalAllAllowedFor } from './agent-run-without-approval';
import { detectMessageLocale } from './agent-slot-fill';
import { tFor, type Locale } from './i18n';

/** Where the draft came from. Only 'chat' (the user's own typing) may carry a
 *  role level into the agent at confirm. */
export type RoleRouteSource = 'chat' | 'voice' | 'widget-ask' | 'terminal-request' | 'monitor-team';

export interface RoleRouteContext {
  /** Verified level per role id (getRoleLevel). Missing = 'off'. */
  levels: Map<string, RoleLevel>;
  source: RoleRouteSource;
}

export type RoleRouteSkip =
  | 'already-routed'
  | 'opt-out'
  | 'monitor-team'
  | 'tool-explicit'
  | 'tool-pinned'
  | 'antigravity'
  | 'api-call'
  | 'action'
  | 'skill-plan'
  | 'autonomous'
  | 'unavailable'
  | 'no-roles'
  | 'no-match';

export interface RoleRouteResult {
  draft: ParsedAgentDraft;
  info: RoleRoutingInfo | null;
  skipped?: RoleRouteSkip;
}

// ─── Phrases ───────────────────────────────────────────────────────────────

const OPT_OUT_RE =
  /\b(?:without|no)\s+(?:(?:my|the|any)\s+)?roles?\b|\bdon'?t\s+use\s+(?:my\s+|the\s+|any\s+)?roles\b|ロール(?:なし|無し)で|ロールを使わず(?:に)?|役割(?:なし|無し)で/i;

/** "without roles" / 「ロールなしで」 — the user opts out of role routing. */
export function detectRoleOptOut(text: string | null | undefined): boolean {
  return OPT_OUT_RE.test(String(text ?? ''));
}

function tidy(s: string): string {
  return s
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.、。!?！？])/g, '$1')
    .replace(/^[\s,、。;:]+|[\s,、;:]+$/g, '')
    .replace(/([、,])\1+/g, '$1')
    .trim();
}

function stripRe(text: string, re: RegExp): string {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return tidy(String(text ?? '').replace(g, ' '));
}

export function stripRoleOptOut(text: string): string {
  return stripRe(text, OPT_OUT_RE);
}

// 「ロールで」 must not match 「コントロールで」 (katakana before ロ).
const TEAM_WORDS_RE =
  /(?:^|[^ァ-ヶー])ロール(?:で|を使って)|役割分担して|チーム(?:で|に)任せて|\b(?:with|using)\s+my\s+roles\b|\b(?:have|let)\s+(?:my\s+|the\s+)team\b/i;

/** Team words that ask for the user's roles without naming one. */
export function mentionsTeamWords(text: string | null | undefined): boolean {
  return TEAM_WORDS_RE.test(String(text ?? ''));
}

function stripTeamWords(text: string): string {
  const src = String(text ?? '');
  return tidy(
    src
      .replace(/(^|[^ァ-ヶー])ロール(?:で|を使って)/g, '$1 ')
      .replace(/役割分担して|チーム(?:で|に)任せて/g, ' ')
      .replace(/\b(?:with|using)\s+my\s+roles\b/gi, ' ')
      .replace(/\b(?:have|let)\s+(?:my\s+|the\s+)team\s+(?:to\s+)?/gi, ' '),
  );
}

const COMPETE_STRONG_RE = /\bcompet(?:e|ing|ition)\b|\bagainst\s+each\s+other\b|競わせ|競争させ|競合させ/i;
const COMPETE_BOTH_RE = /\bboth\b|両方|二人とも|2人とも|二人に|2人に/i;
const COMPARE_RE = /\bcompare\b|比較|比べ/i;
const COMPETE_TWO_RE = /\b(?:both|two|2)\b|両方|二人|2人|2つ/i;

const COMPETE_TAIL_RE =
  /(?:[\s,、]*(?:,\s*)?(?:and\s+)?(?:then\s+)?(?:compare(?:\s+(?:them|the\s+(?:results|two|implementations)|results))?|have\s+them\s+compete|let\s+them\s+compete|compete))+\s*[.!。]?$|(?:[、\s]*(?:結果を|2つを|二つを)?(?:競わせて|競争させて|比較して|比べて)(?:ください|ね)?)+[。]?$/i;

// ─── Role mentions ─────────────────────────────────────────────────────────

interface RoleMention {
  role: AgentRole;
  index: number;
  length: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ASCII_RE = /^[\x20-\x7e]+$/;

function mentionPattern(key: string): RegExp {
  return ASCII_RE.test(key)
    ? new RegExp(`(^|[^a-z0-9])(${escapeRe(key)}(?:s|es)?)(?![a-z0-9])`, 'gi')
    : new RegExp(`()(${escapeRe(key)})`, 'g');
}

/** Every role named in `text` (longest match wins on overlap), in text order. */
export function findRoleMentions(text: string, roles: readonly AgentRole[]): RoleMention[] {
  const lower = String(text ?? '').toLowerCase();
  const hits: RoleMention[] = [];
  for (const role of roles) {
    const key = roleNameKey(role.name);
    if (Array.from(key).length < 2) continue;
    const re = mentionPattern(key);
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      hits.push({ role, index: m.index + m[1].length, length: m[2].length });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  hits.sort((a, b) => a.index - b.index || b.length - a.length);
  const out: RoleMention[] = [];
  for (const h of hits) {
    const prev = out[out.length - 1];
    if (prev && h.index < prev.index + prev.length) continue;
    out.push(h);
  }
  return out;
}

/** true when `text` names at least one of `roles`. */
export function mentionsRoleName(text: string | null | undefined, roles: readonly AgentRole[]): boolean {
  return findRoleMentions(String(text ?? ''), roles).length > 0;
}

const TAIL_CONNECTOR_RE =
  /(?:\s|[,、。;；]|\b(?:and|then|after\s+that|next|have|let|ask|get|the|my|our|both)\b|それから|次に|その後|最後に|そして)+$/i;

/** Strip a leading role mention ("have the implementer …", 「実装役が…」). */
function stripLeadingMention(text: string, role: AgentRole): string {
  const key = escapeRe(roleNameKey(role.name));
  const en = new RegExp(
    `^\\s*(?:(?:please|now|then|and)\\s+)*(?:(?:have|let|ask|get|use)\\s+)?(?:(?:both|all|each)\\s+(?:of\\s+)?)?(?:(?:the|my|our)\\s+)?(?:(?:two|three|2|3)\\s+)?${key}(?:s|es)?(?![a-z0-9])\\s*(?:role\\s+)?(?:to\\s+)?[,:]?\\s*`,
    'i',
  );
  const ja = new RegExp(
    `^\\s*(?:両方の|2人の|二人の)?${key}(?:ロール)?(?:の?(?:2人|二人|両方))?(?:とも)?(?:が|に|は|で|には)?[、\\s]*`,
  );
  const out = ASCII_RE.test(roleNameKey(role.name)) ? text.replace(en, '') : text.replace(ja, '');
  return out.trim() ? out : text;
}

interface Unit {
  text: string;
  group?: string;
  named?: AgentRole;
}

/** Split a unit naming ≥2 distinct roles at each later mention. */
function splitByMentions(text: string, group: string | undefined, roles: readonly AgentRole[]): Unit[] {
  const mentions = findRoleMentions(text, roles);
  const distinct = new Set(mentions.map((m) => m.role.id));
  if (distinct.size < 2) {
    const named = mentions[0]?.role;
    const cleaned = named ? stripLeadingMention(text, named) : text;
    return [{ text: tidy(cleaned) || text, group, named }];
  }
  // One cut per change of named role.
  const cuts: RoleMention[] = [];
  for (const m of mentions) if (!cuts.length || cuts[cuts.length - 1].role.id !== m.role.id) cuts.push(m);
  const units: Unit[] = [];
  for (let k = 0; k < cuts.length; k++) {
    const start = k === 0 ? 0 : cuts[k].index;
    const end = k + 1 < cuts.length ? cuts[k + 1].index : text.length;
    let piece = text.slice(start, end);
    if (k + 1 < cuts.length) piece = piece.replace(TAIL_CONNECTOR_RE, '');
    const cleaned = tidy(stripLeadingMention(piece, cuts[k].role));
    if (cleaned) units.push({ text: cleaned, group, named: cuts[k].role });
  }
  return units.length ? units : [{ text, group }];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isCliEngine(engine: RoleEngine | undefined): boolean {
  return !!engine && engine.type === 'cli';
}

function engineKey(engine: RoleEngine): string {
  return engine.type === 'cli' ? `cli:${engine.cli}` : engine.type;
}

/** The agent will run without a human present (no CLI roles then). */
export function draftRunsUnattended(draft: Pick<ParsedAgentDraft, 'schedule' | 'continuous' | 'notificationTrigger' | 'suggestedFrequency'>): boolean {
  if (draft.schedule && draft.schedule !== 'once') return true;
  if (draft.suggestedFrequency) return true;
  if (draft.continuous) return true;
  return !!draft.notificationTrigger && (draft.notificationTrigger.packageNames?.length ?? 0) > 0;
}

function stepOf(s: string | AgentOrchestrationStep): AgentOrchestrationStep {
  return typeof s === 'string' ? { instruction: s } : s;
}

function skipReason(draft: ParsedAgentDraft, ctx: RoleRouteContext): RoleRouteSkip | null {
  if (draft.roleRouting) return 'already-routed';
  if (ctx.source === 'monitor-team' || draft.monitorTeamToken) return 'monitor-team';
  if (draft.toolExplicit) return 'tool-explicit';
  const steps = (draft.orchestrationSteps ?? []).map(stepOf);
  if (steps.some((s) => s.apiCall)) return 'api-call';
  if (steps.some((s) => s.tool !== undefined || s.toolPinned === true)) return 'tool-pinned';
  if (draft.antigravityRequested) return 'antigravity';
  const actions = [draft.action, ...(draft.actions ?? [])];
  if (actions.some((a) => a && (a.type === 'social-post' || a.type === 'browser-pane' || (a.type === 'intent' && a.intentMode === 'closepaw')))) {
    return 'action';
  }
  if (draft.closePawRouting) return 'action';
  if (draft.matchedSkill?.executablePlan) return 'skill-plan';
  if (draft.autonomous) return 'autonomous';
  return null;
}

function stripOptOutFromDraft(draft: ParsedAgentDraft): ParsedAgentDraft {
  const steps = draft.orchestrationSteps?.map((s) =>
    typeof s === 'string' ? stripRoleOptOut(s) || s : { ...s, instruction: stripRoleOptOut(s.instruction) || s.instruction },
  );
  return {
    ...draft,
    name: stripRoleOptOut(draft.name) || draft.name,
    prompt: stripRoleOptOut(draft.prompt) || draft.prompt,
    ...(steps ? { orchestrationSteps: steps } : {}),
  };
}

function nextGroupId(units: readonly Unit[]): string {
  const used = new Set(units.map((u) => u.group).filter(Boolean));
  for (let i = 1; ; i++) if (!used.has(`r${i}`)) return `r${i}`;
}

/** Branch folder letters — the same labels the judge sees (Candidate A/B/C). */
const BRANCH_DIR_LETTERS = ['A', 'B', 'C'] as const;

function byAge(a: AgentRole, b: AgentRole): number {
  return a.createdAt - b.createdAt || a.name.localeCompare(b.name);
}

// ─── Router ────────────────────────────────────────────────────────────────

export function routeDraftToRoles(draft: ParsedAgentDraft, loaded: LoadedRoles, ctx: RoleRouteContext): RoleRouteResult {
  if (!draft.roleRouting && detectRoleOptOut(draft.rawText)) {
    return { draft: stripOptOutFromDraft(draft), info: null, skipped: 'opt-out' };
  }
  const skip = skipReason(draft, ctx);
  if (skip) return { draft, info: null, skipped: skip };
  if (loaded.unavailable) return { draft: { ...draft, roleRoutingNotice: 'unavailable' }, info: null, skipped: 'unavailable' };
  const roles = [...loaded.roles].sort(byAge);
  if (!roles.length) return { draft, info: null, skipped: 'no-roles' };

  const locale: Locale = detectMessageLocale(draft.rawText || draft.prompt);
  const tl = (key: string, params?: Record<string, string | number>) => tFor(locale, key, params);
  const notes: string[] = [];
  const addNote = (n: string) => {
    if (!notes.includes(n)) notes.push(n);
  };

  // 1. Units.
  const sourceUnits: Unit[] = draft.orchestrationSteps && draft.orchestrationSteps.length >= 2
    ? draft.orchestrationSteps.map(stepOf).map((s) => ({ text: s.instruction, group: s.parallelGroup }))
    : [{ text: draft.prompt }];
  let units: Unit[] = [];
  for (const u of sourceUnits) {
    const text = stripTeamWords(u.text) || u.text;
    units.push(...splitByMentions(text, u.group, roles));
  }

  const unattended = draftRunsUnattended(draft);
  // A single-prompt request the parser already routed to web research
  // ("research …, then build …" in one sentence) reads web text in the same
  // unit — no Codex / Claude Code role for it (taint, design §5.4).
  const singleUnitResearch = sourceUnits.length === 1 && draft.tool?.type === 'perplexity';
  const implementers = roles.filter((r) => r.handles.includes('implement'));
  const eligibleImplementers = implementers.filter((r) => !(unattended && isCliEngine(r.engine)));

  // 2. Compete: duplicate the first implement unit into branches.
  let competeApplied = false;
  const raw = draft.rawText || draft.prompt;
  const competeAsked = COMPETE_STRONG_RE.test(raw) || (COMPETE_BOTH_RE.test(raw) && (COMPARE_RE.test(raw) || implementers.some((r) => mentionsRoleName(raw, [r]))));
  if (competeAsked) {
    const idx = units.findIndex((u) => !u.group && classifyTaskKind(u.text) === 'implement');
    if (idx !== -1) {
      if (eligibleImplementers.length >= 2) {
        const cap = COMPETE_TWO_RE.test(raw) ? 2 : MAX_PARALLEL_BRANCHES;
        const n = Math.min(eligibleImplementers.length, cap, MAX_PARALLEL_BRANCHES);
        const text = tidy(units[idx].text.replace(COMPETE_TAIL_RE, '')) || units[idx].text;
        const group = nextGroupId(units);
        // Prefer distinct engines across branches.
        const picked: AgentRole[] = [];
        const engines = new Set<string>();
        for (const r of eligibleImplementers) if (picked.length < n && !engines.has(engineKey(r.engine))) { picked.push(r); engines.add(engineKey(r.engine)); }
        for (const r of eligibleImplementers) if (picked.length < n && !picked.includes(r)) picked.push(r);
        const branches: Unit[] = picked.map((r) => ({ text, group, named: r }));
        units = [...units.slice(0, idx), ...branches, ...units.slice(idx + 1)];
        competeApplied = true;
        // A trailing "and compare" unit that the parser split off is the final step's job.
        const after = idx + branches.length;
        if (after === units.length - 1 && classifyTaskKind(units[after].text) === 'judge' && !units[after].named) {
          units = units.slice(0, after);
        }
      } else {
        addNote(tl('roles.route.compete_needs_two'));
      }
    }
  }

  // 3. Assign.
  type Assigned = { unit: Unit; role?: AgentRole; kind: TaskKind | null; handoff?: StepHandoff };
  const assigned: Assigned[] = [];
  let tainted = false;
  let taintGroup: string | undefined;
  const groupRoles = new Map<string, AgentRole[]>();
  for (const unit of units) {
    const kindRaw = classifyTaskKind(unit.text);
    const kind: TaskKind | null = kindRaw === 'publish' ? null : kindRaw;
    const taintedHere = (tainted && !(unit.group && unit.group === taintGroup)) || singleUnitResearch;
    let candidates: AgentRole[] = unit.named ? [unit.named] : kind ? roles.filter((r) => r.handles.includes(kind as RoleKind)) : [];
    const before = candidates.length;
    candidates = candidates.filter((r) => !(isCliEngine(r.engine) && (unattended || taintedHere)));
    if (before > 0 && candidates.length === 0) {
      addNote(tl(unattended ? 'roles.route.cli_unattended_note' : 'roles.route.cli_after_research_note', { instruction: unit.text }));
    }
    let role: AgentRole | undefined;
    if (unit.group) {
      const used = groupRoles.get(unit.group) ?? [];
      const free = candidates.filter((r) => !used.includes(r));
      const usedEngines = new Set(used.map((r) => engineKey(r.engine)));
      role = free.find((r) => !usedEngines.has(engineKey(r.engine))) ?? free[0];
      if (role) {
        if (usedEngines.has(engineKey(role.engine)) && isCliEngine(role.engine)) {
          addNote(tl('roles.route.same_engine_note', { engine: toolChoiceToLabel(role.engine) }));
        }
        groupRoles.set(unit.group, [...used, role]);
      }
    } else {
      role = candidates[0];
    }
    assigned.push({ unit, role, kind: role && unit.named ? (kind ?? unit.named.handles[0]) : kind });
    if (kind === 'research' || (role && role.handles.includes('research') && !isCliEngine(role.engine))) {
      if (!tainted) taintGroup = unit.group;
      tainted = true;
    }
  }

  // 4. Auto-attached reviewer after the last implement unit. Inc B: when the
  //    implement unit is serial and the reviewer (auto-attached, or named
  //    right after it) is an autoAttach reviewer, the review is unrolled into
  //    a bounded loop [impl, review r1, revise r1, review r2, revise r2]
  //    (MAX_HANDOFF_ROUNDS, within HARD_MAX_STEPS) + a final summary. Revise
  //    steps use the implementer's role and engine (same pin, same gate).
  let loop: { rounds: number; reviewAt: number } | null = null;
  if (!competeApplied) {
    let lastImpl = -1;
    assigned.forEach((a, i) => {
      if (a.role && a.kind === 'implement') lastImpl = i;
    });
    if (lastImpl !== -1) {
      // After the whole group the implement unit belongs to.
      let insertAt = lastImpl + 1;
      const g = assigned[lastImpl].unit.group;
      if (g) while (insertAt < assigned.length && assigned[insertAt].unit.group === g) insertAt++;
      const reviewedAfter = assigned.slice(insertAt).some((a) => a.role && a.kind === 'review');
      const taintedAt = singleUnitResearch || assigned.slice(0, insertAt).some((a) => a.kind === 'research');
      const reviewer = roles.find(
        (r) => r.autoAttach === 'after-implement' && r.handles.includes('review') && !(isCliEngine(r.engine) && (unattended || taintedAt)),
      );
      let reviewAt = -1;
      if (!reviewedAfter && reviewer) {
        assigned.splice(insertAt, 0, { unit: { text: tl('roles.route.review_step'), named: reviewer }, role: reviewer, kind: 'review' });
        reviewAt = insertAt;
      } else if (
        assigned[insertAt]?.kind === 'review' &&
        assigned[insertAt].role?.autoAttach === 'after-implement' &&
        !assigned[insertAt].unit.group
      ) {
        reviewAt = insertAt;
      }
      const impl = assigned[lastImpl];
      if (reviewAt !== -1 && reviewAt === lastImpl + 1 && !impl.unit.group && impl.role) {
        // + the final summary step the loop always ends with.
        let rounds = MAX_HANDOFF_ROUNDS;
        const extra = (r: number) => (r <= 0 ? 0 : 2 * r - 1);
        while (rounds > 0 && assigned.length + extra(rounds) + 1 > HARD_MAX_STEPS) rounds--;
        const reviewA = assigned[reviewAt];
        const withContract = (text: string, contract: string) =>
          `${Array.from(text).slice(0, Math.max(40, 480 - contract.length)).join('')}\n\n${contract}`;
        reviewA.unit = { ...reviewA.unit, text: withContract(reviewA.unit.text, REVIEW_OUTPUT_CONTRACT) };
        reviewA.handoff = { kind: 'review', of: [lastImpl], round: 1 };
        const added: Assigned[] = [];
        // Absolute step indexes: nothing is inserted before these later.
        let lastWork = lastImpl;
        let lastReview = reviewAt;
        for (let r = 1; r <= rounds; r++) {
          const reviseAt = reviewAt + added.length + 1;
          added.push({
            unit: { text: tl('roles.route.revise_step'), named: impl.role },
            role: impl.role,
            kind: 'implement',
            handoff: { kind: 'revise', of: [lastWork, lastReview], round: r as 1 | 2 },
          });
          if (r < rounds) {
            const nextReviewAt = reviseAt + 1;
            added.push({
              unit: { text: withContract(tl('roles.route.review_again_step'), REVIEW_OUTPUT_CONTRACT), named: reviewA.role },
              role: reviewA.role,
              kind: 'review',
              handoff: { kind: 'review', of: [lastReview, reviseAt], round: (r + 1) as 1 | 2 },
            });
            lastReview = nextReviewAt;
          }
          lastWork = reviseAt;
        }
        assigned.splice(reviewAt + 1, 0, ...added);
        loop = { rounds, reviewAt };
      }
    }
  } else if (roles.some((r) => r.autoAttach === 'after-implement')) {
    addNote(tl('roles.route.compete_no_review'));
  }

  // 4b. Inc B judge: competing branches are compared by a judge role when the
  //     user has one (else the existing unpinned comparison step). The judge
  //     sees the candidates as "Candidate A / B" (no role or engine names).
  let judgeApplied = false;
  if (competeApplied) {
    const groupEnd = (() => {
      let end = -1;
      assigned.forEach((a, i) => {
        if (a.unit.group && assigned.some((b, j) => j !== i && b.unit.group === a.unit.group)) end = i;
      });
      return end;
    })();
    const g = groupEnd !== -1 ? assigned[groupEnd].unit.group : undefined;
    const branchIdx = g ? assigned.map((a, i) => (a.unit.group === g ? i : -1)).filter((i) => i !== -1) : [];
    const judge = roles.find((r) => r.handles.includes('judge') && !(isCliEngine(r.engine) && unattended));
    const existing = assigned[groupEnd + 1];
    if (branchIdx.length >= 2 && (judge || (existing?.kind === 'judge' && existing.role))) {
      const contract = judgeOutputContract(branchIdx.length);
      const withJudgeContract = (text: string) => `${Array.from(text).slice(0, Math.max(40, 480 - contract.length)).join('')}\n\n${contract}`;
      if (existing && existing.kind === 'judge' && existing.role) {
        existing.unit = { ...existing.unit, text: withJudgeContract(existing.unit.text) };
        existing.handoff = { kind: 'judge', of: branchIdx, round: 1 };
      } else if (judge) {
        assigned.splice(groupEnd + 1, 0, {
          unit: { text: withJudgeContract(tl('roles.route.judge_step')), named: judge },
          role: judge,
          kind: 'judge',
          handoff: { kind: 'judge', of: branchIdx, round: 1 },
        });
      }
      judgeApplied = true;
    }
  }

  if (!assigned.some((a) => a.role)) return { draft, info: null, skipped: 'no-match' };

  // 5. Final summary step when the last unit is a CLI role.
  const last = assigned[assigned.length - 1];
  // Inc B: a hand-off loop always ends with the summary (its last revise step
  // may be skipped after a PASS, and the final step performs the action).
  const appendFinal =
    loop !== null || ((assigned.length >= 2 || competeApplied) && !!last.role && isCliEngine(last.role.engine));

  // 6. Workspace: request > first fixed role path > none.
  const usedRoles: AgentRole[] = [];
  for (const a of assigned) if (a.role && !usedRoles.includes(a.role)) usedRoles.push(a.role);
  const fixed = usedRoles.filter((r) => r.workspace.mode === 'fixed') as Array<AgentRole & { workspace: { mode: 'fixed'; path: string } }>;
  const workspaceRoot = draft.workspaceRoot ?? fixed[0]?.workspace.path;
  for (const r of fixed) {
    if (workspaceRoot && r.workspace.path !== workspaceRoot) {
      addNote(tl('roles.route.workspace_conflict', { role: r.name, path: r.workspace.path, used: workspaceRoot }));
    }
  }

  // 6b. One folder per competing branch (2026-11-02 on-device finding: two
  //     implementers building "in ~/demo" in parallel both wrote into ~/demo,
  //     and the judge could read the other branch's files). Every parallel
  //     group with ≥2 role-pinned implement units gets `<workspace>/a`, `/b`,
  //     `/c` (letters = the judge's Candidate labels). Instruction-level: the
  //     workspace path in the branch's instruction is retargeted and a
  //     "work only inside" line added; the dirs are created at confirm. The
  //     gate boundary stays the workspace root (the dirs are inside it).
  const branchDirs: Array<{ stepIndex: number; label: string; dir: string; group: string }> = [];
  if (workspaceRoot) {
    const root = workspaceRoot.replace(/\/+$/, '');
    const groups: string[] = [];
    const subPathRe = new RegExp(`${escapeRe(root)}/[^\\s/]`);
    for (const a of assigned) {
      const g = a.unit.group;
      if (!g || groups.includes(g)) continue;
      const impl = assigned.filter((b) => b.unit.group === g && b.role && b.kind === 'implement');
      // A group whose units already name their own folders under the
      // workspace ("build a timer in ~/demo/a, a clock in ~/demo/b") keeps
      // the user's layout.
      if (impl.length >= 2 && !impl.some((b) => subPathRe.test(b.unit.text))) groups.push(g);
    }
    groups.forEach((g, gi) => {
      let k = 0;
      assigned.forEach((a, i) => {
        if (a.unit.group !== g || !a.role || a.kind !== 'implement' || k >= BRANCH_DIR_LETTERS.length) return;
        const letter = BRANCH_DIR_LETTERS[k++];
        const dir = `${root}/${gi === 0 ? letter.toLowerCase() : `${g}-${letter.toLowerCase()}`}`;
        const note = tl('roles.route.branch_dir_note', { dir });
        const pathRe = new RegExp(`${escapeRe(root)}(?![A-Za-z0-9_.\\-/])`, 'g');
        const body = a.unit.text.replace(pathRe, dir);
        a.unit = { ...a.unit, text: `${Array.from(body).slice(0, Math.max(40, 480 - note.length)).join('')}\n\n${note}` };
        branchDirs.push({ stepIndex: i, label: letter, dir, group: g });
      });
    });
  }
  const firstGroupDirs = branchDirs.filter((b) => b.group === branchDirs[0]?.group);
  const candidateDirsLine = firstGroupDirs.length >= 2
    ? tl('roles.route.candidate_dirs', { dirs: firstGroupDirs.map((b) => `${b.label} = ${b.dir}`).join(', ') })
    : '';
  if (candidateDirsLine && judgeApplied) {
    // The judge compares the candidates' outputs; tell it where their files are.
    const judgeEntry = assigned.find((a) => a.handoff?.kind === 'judge');
    if (judgeEntry) {
      const text = judgeEntry.unit.text;
      const at = text.indexOf('\n\nOutput contract:');
      judgeEntry.unit = {
        ...judgeEntry.unit,
        text: at === -1 ? `${text}\n${candidateDirsLine}` : `${text.slice(0, at)}\n${candidateDirsLine}${text.slice(at)}`,
      };
    }
  }

  // 7. Build the draft.
  const levelOf = (r: AgentRole): RoleLevel => ctx.levels.get(r.id) ?? 'off';
  const assignments: RoleRoutingAssignment[] = [];
  assigned.forEach((a, i) => {
    if (!a.role) return;
    assignments.push({
      stepIndex: i,
      roleId: a.role.id,
      roleName: a.role.name,
      engine: a.role.engine,
      kind: a.kind ?? a.role.handles[0],
      roleHash: roleDefinitionHash(a.role),
      level: levelOf(a.role),
    });
  });
  const info: RoleRoutingInfo = {
    assignments,
    minLevel: minRoleLevel(usedRoles.map(levelOf)),
    levelEligible: ctx.source === 'chat',
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(branchDirs.length ? { branchDirs: branchDirs.map(({ stepIndex, label, dir }) => ({ stepIndex, label, dir })) } : {}),
    ...(notes.length ? { notes } : {}),
  };
  const { roleRouting: _drop, ...original } = draft;
  void _drop;

  let routed: ParsedAgentDraft;
  if (assigned.length === 1 && !appendFinal) {
    const role = assigned[0].role!;
    routed = {
      ...draft,
      prompt: `${composeRoleInstructions(role)}\n\n# Task\n${assigned[0].unit.text}`,
      tool: role.engine,
      toolLabel: toolChoiceToLabel(role.engine),
      toolExplicit: true,
      orchestrationSteps: undefined,
    };
  } else {
    const steps: Array<string | AgentOrchestrationStep> = assigned.map((a) => {
      const group = a.unit.group ? { parallelGroup: a.unit.group } : {};
      if (!a.role) return a.unit.group ? { instruction: a.unit.text, ...group } : a.unit.text;
      return {
        instruction: a.unit.text,
        tool: a.role.engine,
        toolPinned: true,
        role: toStepRole(a.role),
        ...group,
        ...(a.handoff ? { handoff: { kind: a.handoff.kind, of: [...a.handoff.of], round: a.handoff.round } } : {}),
      };
    });
    if (appendFinal) {
      const compare = competeApplied && !judgeApplied;
      const finalText = tl(compare ? 'roles.route.compare_step' : 'roles.route.summary_step');
      steps.push(compare && candidateDirsLine ? `${finalText} ${candidateDirsLine}` : finalText);
    }
    routed = {
      ...draft,
      tool: { type: 'local' },
      toolLabel: toolChoiceToLabel({ type: 'local' }),
      toolExplicit: true,
      orchestrationSteps: steps,
    };
  }
  routed = {
    ...routed,
    autonomous: false,
    workspaceRoot,
    roleRoutingNotice: undefined,
    roleRouting: { ...info, original },
  };
  return { draft: routed, info };
}

// ─── Revert / conflicts / levels ───────────────────────────────────────────

/** Restore the fields routing replaced; later patches to other fields stay. */
export function revertRoleRouting(draft: ParsedAgentDraft): ParsedAgentDraft {
  const routing = draft.roleRouting;
  if (!routing) return draft;
  const o = routing.original;
  return {
    ...draft,
    prompt: o.prompt,
    tool: o.tool,
    toolLabel: o.toolLabel,
    toolExplicit: o.toolExplicit,
    orchestrationSteps: o.orchestrationSteps,
    workspaceRoot: o.workspaceRoot,
    autonomous: o.autonomous,
    roleRouting: undefined,
    roleRoutingNotice: undefined,
  };
}

/** Why a routed draft can no longer keep its routing after a later change
 *  (a schedule / trigger made it unattended with CLI roles, or it became
 *  autonomous), else null. */
export function roleRoutingConflict(draft: ParsedAgentDraft): 'autonomous' | 'unattended-cli' | null {
  const routing = draft.roleRouting;
  if (!routing) return null;
  if (draft.autonomous) return 'autonomous';
  if (draftRunsUnattended(draft) && routing.assignments.some((a) => isCliEngine(a.engine))) return 'unattended-cli';
  return null;
}

/** Drop the routing of the given step indexes (their engine was overridden). */
export function dropStepAssignments(draft: ParsedAgentDraft, stepIndexes: readonly number[]): ParsedAgentDraft {
  const routing = draft.roleRouting;
  if (!routing || !stepIndexes.length) return draft;
  const assignments = routing.assignments.filter((a) => !stepIndexes.includes(a.stepIndex));
  if (assignments.length === routing.assignments.length) return draft;
  if (!assignments.length) return { ...draft, roleRouting: undefined };
  const levelByRole = new Map(assignments.map((a) => [a.roleId, a.level ?? 'off'] as const));
  return { ...draft, roleRouting: { ...routing, assignments, minLevel: minRoleLevel([...levelByRole.values()]) } };
}

/**
 * The level the routed agent gets when nothing in the request named one:
 * the minimum of the assigned roles' levels; "all" only for an agent that
 * reads no untrusted input (else standard).
 */
export function effectiveRoutedLevel(draft: ParsedAgentDraft): { level: RoleLevel; degraded: boolean } {
  const routing = draft.roleRouting;
  if (!routing || routing.levelEligible !== true) return { level: 'off', degraded: false };
  const level = routing.minLevel;
  if (level === 'all' && !runWithoutApprovalAllAllowedFor(draft)) return { level: 'standard', degraded: true };
  return { level, degraded: false };
}

/** What the confirm re-verifies: each assigned role's id + definition hash. */
export interface RoutedRoleRef {
  id: string;
  roleHash: string;
}

/**
 * The level to write at the typed OK: re-load the roles, and for each
 * assigned role require the SAME definition (hash) — a role that changed or
 * vanished counts as 'off' — then take the minimum of the verified levels.
 */
export async function resolveRoutedRoleLevel(
  refs: readonly RoutedRoleRef[],
  loaded: LoadedRoles,
  getLevel: (role: AgentRole) => Promise<RoleLevel>,
): Promise<RoleLevel> {
  if (!refs.length || loaded.unavailable) return 'off';
  const levels: RoleLevel[] = [];
  for (const ref of refs) {
    const role = loaded.roles.find((r) => r.id === ref.id);
    if (!role || roleDefinitionHash(role) !== ref.roleHash) return 'off';
    levels.push(await getLevel(role).catch(() => 'off' as RoleLevel));
  }
  return minRoleLevel(levels);
}

/** Unique role refs of a routed draft, in order. */
export function routedRoleRefs(draft: ParsedAgentDraft): RoutedRoleRef[] {
  const out: RoutedRoleRef[] = [];
  for (const a of draft.roleRouting?.assignments ?? []) {
    if (a.roleHash && !out.some((r) => r.id === a.roleId)) out.push({ id: a.roleId, roleHash: a.roleHash });
  }
  return out;
}
