/**
 * lib/agent-draft-patch.ts — Phase C (2026-07-22): partial-patch a pending
 * chat-native agent draft from a follow-up utterance during await-confirm.
 *
 * Background: chat-native confirm (Phase A/B, `433bdae93`) replaced
 * AgentConfirmCard's editable form with a plain-language summary + typed
 * confirm/cancel reply. That closed the "editing a card is a hassle" gap for
 * confirm/cancel, but reopened a NARROWER version of the SAME complaint for
 * partial edits: a reply that is neither a confirm phrase nor a cancel phrase
 * during await-confirm previously always fell through to "登録待ちの下書きが
 * あります" guidance + a bare re-post of the summary — there was no way to
 * fix just the time, just the name, etc. without cancelling and re-typing the
 * WHOLE utterance from scratch. This module is that missing piece.
 *
 * Design (per the Fable5 UX consult that scoped this phase): a regex-based
 * patch WILL occasionally misfire — text like "9時のニュースをまとめて" names
 * a time as part of the PROMPT content, not a schedule-change request. Making
 * that impossible in general is not achievable with a deterministic parser,
 * so the design goal is containment, not prevention:
 *   1. Never apply a patch silently — every hit is echoed back with a ★
 *      marker on the changed line(s) (see lib/agent-plan-summary.ts's
 *      summarizeAgentDraftAsText `changedFields` param) so a misread is easy
 *      to spot before it does anything.
 *   2. Never auto-register a patched draft — the caller (hooks/
 *      use-ai-pane-dispatch.ts's dispatch()) keeps `pendingAgentSession.phase`
 *      at `'await-confirm'` after applying a patch, exactly as if nothing had
 *      been said at all; a SEPARATE confirm phrase is still required. See
 *      applyPatchToPendingSession below, which hard-codes this invariant so
 *      the caller cannot accidentally skip it.
 *   3. "Say it again" always works — since nothing is silently applied and
 *      nothing is auto-registered, a wrong patch (or a non-patch that
 *      resembled one) costs the user one more typed correction, never a
 *      wrongly-registered agent.
 *
 * Each field detector below is deliberately narrow (an explicit change-intent
 * shape, not a loose keyword scan) for the same reason #1 above exists to
 * mitigate: the narrower the match, the fewer prompt-content false positives
 * reach the user's screen at all. See each function's own doc comment for its
 * specific false-positive guard.
 *
 * Pure, offline, unit-testable — same convention as lib/agent-nl-parser.ts /
 * lib/agent-slot-fill.ts. No store reads, no RN.
 */
import {
  ParsedAgentDraft,
  parseSchedule,
  detectAction,
  detectAutonomousIntent,
  fmtTime,
  JP_DOW_LABEL,
} from './agent-nl-parser';
import { decodeCron } from './agent-card-cron';
import { toolChoiceToLabel } from './agent-tool-router';
import type { Agent } from '@/store/types';
// Type-only: erased at compile time — same "no RN in this pure module"
// convention lib/agent-plan-summary.ts already follows for ConfirmedAgentDraft.
import type { PendingAgentSession } from '@/store/ai-pane-store';

export interface DraftPatchResult {
  patchedDraft: ParsedAgentDraft;
  /** Field names touched by this patch — 'schedule' | 'name' | 'action' |
   *  'autonomous'. Feed straight into summarizeAgentDraftAsText's
   *  changedFields param so the re-posted summary marks exactly these lines. */
  changedFields: string[];
}

/** Convert persisted metadata into the same draft shape used by chat editing. */
export function agentToParsedAgentDraft(agent: Agent): ParsedAgentDraft {
  return {
    name: agent.name,
    prompt: agent.prompt,
    schedule: agent.schedule,
    scheduleConfident: true,
    scheduleLabel: agent.schedule ?? 'Manual only',
    action: agent.action ?? { type: 'draft' },
    tool: agent.tool,
    toolLabel: toolChoiceToLabel(agent.tool),
    autonomous: agent.autonomous,
    memory: agent.memory,
    orchestrationSteps: agent.orchestration?.steps,
    charLimit: agent.orchestration?.charLimit,
    notificationTrigger: agent.notificationTrigger ?? undefined,
    rawText: agent.prompt,
  };
}

/** Single decision point for confirm: edit in place, or preserve creation. */
export async function persistAgentDraft<T, C, U>(args: {
  editingAgentId?: string;
  createParams: C;
  updatePartial: U;
  runCommand: (cmd: string) => Promise<string>;
  create: (params: C) => T;
  update: (agentId: string, partial: U, runCommand: (cmd: string) => Promise<string>) => Promise<T | null>;
}): Promise<{ agent: T | null; edited: boolean }> {
  if (args.editingAgentId) {
    return {
      agent: await args.update(args.editingAgentId, args.updatePartial, args.runCommand),
      edited: true,
    };
  }
  return { agent: args.create(args.createParams), edited: false };
}

// ── Schedule patch ──────────────────────────────────────────────────────────

// A bare time-of-day expression with only a short "change it to" filler
// around it, and NOTHING ELSE in the utterance. This is the gate that decides
// whether a non-confident parseSchedule() result (just a suggestedTime, no
// stated frequency) is trusted as a genuine "change the time" request rather
// than a time mentioned as part of unrelated prompt content — the exact
// "9時のニュースをまとめて" false-positive case the module doc comment above
// calls out. Requiring the WHOLE trimmed utterance to match this narrow shape
// (as opposed to searching for the shape anywhere in a longer string) is what
// keeps "9時のニュースをまとめて" out: the "の" right after "9時" is not part
// of this shape's allowed filler set, so the match fails on the FULL string
// and the bare-time merge branch below never fires for it. A full recurring
// restatement ("毎日9時にして") does not need this gate at all — it is caught
// by parseSchedule()'s own `confident: true` branch first (parseSchedule
// scans the whole string for its keywords, unanchored), so this narrow
// bare-time gate is only ever consulted for a genuinely time-only reply.
//
// 2026-07-24 fuzz-sweep finding: the trailing filler alternation required
// either a verb ("して"/"変更して"/…) or the full "でお願いします" phrase, so
// two extremely common terse corrections — a bare "20時で" and a leading
// "やっぱり9時" ("on second thought, 9") — fell through to "no patch" even
// though they are unambiguous time-change replies. Added a bare trailing "で"
// alternative and an optional leading "やっぱり|やっぱ" filler. Both additions
// stay INSIDE the existing whole-string anchor (^…$), so they can only ever
// match when the ENTIRE trimmed utterance is just [やっぱり] + a time + this
// short filler and nothing else — the exact same "must be the whole string"
// containment the "9時のニュースをまとめて" guard above already relies on, so
// this cannot newly false-positive on any longer sentence that happens to
// contain a time.
const JP_BARE_TIME_CHANGE_RE =
  /^(?:やっぱり|やっぱ)?\s*(?:午前|午後|朝|夜|夕方|晩|深夜|昼)?\s*\d{1,2}\s*時\s*(?:半|\d{1,2}\s*分)?\s*(?:に|へ)?\s*(?:して(?:ください)?|変更して(?:ください)?|変えて(?:ください)?|直して(?:ください)?|でお願いします?|お願いします?|で)?$/;
const EN_BARE_TIME_CHANGE_RE =
  /^(?:change\s+(?:it\s+)?to\s+|make\s+it\s+|set\s+(?:it\s+)?to\s+)?(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s+instead)?[.!]?$/i;

function isBareTimeChangeUtterance(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return JP_BARE_TIME_CHANGE_RE.test(trimmed) || EN_BARE_TIME_CHANGE_RE.test(trimmed);
}

/** The subset of ParsedAgentDraft's schedule-related fields a schedule patch
 *  can rewrite. All keys are always present (even when `undefined`) in a
 *  returned patch so Object.assign correctly CLEARS a stale suggestedTime/
 *  suggestedFrequency/scheduleAssumed from the pre-patch draft, not just add
 *  new ones. */
type SchedulePatchFields = Pick<
  ParsedAgentDraft,
  'schedule' | 'scheduleConfident' | 'scheduleLabel' | 'suggestedTime' | 'suggestedFrequency' | 'suggestedDowList' | 'scheduleAssumed'
>;

/**
 * Try to derive a new schedule from a follow-up utterance. Two paths:
 *  (a) parseSchedule(utterance) is itself confident (a full restatement like
 *      "毎日9時にして" or "毎週月曜9時に変更して") — trust it outright, same
 *      as the initial parse would.
 *  (b) parseSchedule found a bare time only (no frequency stated) AND the
 *      utterance is narrowly shaped as JUST a time-change request (see
 *      isBareTimeChangeUtterance) AND the current draft already has a
 *      confident daily/weekly/custom(multi-day) cron to inherit the
 *      frequency from — merge the new time into the EXISTING frequency
 *      (decoded via lib/agent-card-cron.ts's decodeCron, the same codec
 *      AgentConfirmCard/agent-plan-summary already trust) rather than
 *      forcing the user to restate the whole schedule. Interval/hourly/
 *      daily-multi frequencies are deliberately NOT merged here (no single
 *      well-defined "just change the time" meaning for them) — the user
 *      falls back to a full restatement for those, same as before this
 *      module existed.
 * Returns null when neither path applies.
 */
function tryPatchSchedule(draft: ParsedAgentDraft, utterance: string): SchedulePatchFields | null {
  const parsed = parseSchedule(utterance);

  if (parsed.confident) {
    return {
      schedule: parsed.schedule,
      scheduleConfident: true,
      scheduleLabel: parsed.label,
      suggestedTime: parsed.suggestedTime,
      suggestedFrequency: parsed.suggestedFrequency,
      suggestedDowList: parsed.suggestedDowList,
      scheduleAssumed: parsed.assumedTimeOfDay || undefined,
    };
  }

  if (
    parsed.suggestedTime &&
    isBareTimeChangeUtterance(utterance) &&
    draft.schedule &&
    draft.schedule !== 'once'
  ) {
    const decoded = decodeCron(draft.schedule);
    const t = parsed.suggestedTime;
    if (decoded.frequency === 'daily') {
      return {
        schedule: `${t.minute} ${t.hour} * * *`,
        scheduleConfident: true,
        scheduleLabel: `毎日 ${fmtTime(t)}`,
        suggestedTime: t,
        suggestedFrequency: undefined,
        suggestedDowList: undefined,
        scheduleAssumed: undefined,
      };
    }
    if (decoded.frequency === 'weekly' || decoded.frequency === 'custom') {
      const dowField = decoded.dowList || String(decoded.weekday);
      const dayLabel = dowField
        .split(',')
        .map((d) => JP_DOW_LABEL[parseInt(d, 10)] ?? d)
        .join('・');
      return {
        schedule: `${t.minute} ${t.hour} * * ${dowField}`,
        scheduleConfident: true,
        scheduleLabel: `毎週${dayLabel} ${fmtTime(t)}`,
        suggestedTime: t,
        suggestedFrequency: undefined,
        suggestedDowList: undefined,
        scheduleAssumed: undefined,
      };
    }
    // interval / hourly / daily-multi: no single well-defined "just the
    // time" merge — fall through to null (no patch) below.
  }

  return null;
}

// ── Name patch ───────────────────────────────────────────────────────────

// "名前は◯◯にして" / "タイトルを◯◯に" / "エージェント名を◯◯に変更して" — an
// explicit rename marker (名前/タイトル/エージェント名/名称) followed by the
// new name, ending in a "change to" verb (に/にして/に変更して/に変えて) OR a
// polite request filler (でお願いします), immediately before a clause
// boundary (、。, or end of string) so a rename clause embedded earlier in a
// longer multi-field utterance ("名前は◯◯にして、9時にして") is still
// recognized (the lookahead, not a hard `$` anchor, is what makes that work).
//
// 2026-07-24 fuzz-sweep finding: the capture group used to be an unrestricted
// lazy `(.+?)`, which is free to cross a 、/, that appears BEFORE the actual
// rename verb — e.g. "名前はそのままで、9時にしてください" (intent: "leave
// the name alone, just change the time") lazily matched all the way out to
// the "9時に" ending and captured "そのままで、9時" as if THAT were the new
// name, silently renaming the agent to garbage while also (in the un-narrowed
// version) never even reaching the time correction the user actually asked
// for. Restricting the capture to `[^、,]+?` (no comma character permitted
// INSIDE the captured span) makes a rename clause stop at the first clause
// boundary the way every other field detector in this module already
// does — a real name essentially never needs a bare 、/, before the change
// verb, so this can only narrow which utterances match, never widen it.
const NAME_PATCH_JP_RE =
  /(?:名前|タイトル|エージェント名|名称)\s*(?:は|を)?\s*[「『]?([^、,]+?)[」』]?\s*(?:に(?:して(?:ください)?|変更して(?:ください)?|変えて(?:ください)?)?|でお願いします?)(?=[、。,]|$)/;
const NAME_PATCH_EN_RE =
  /\b(?:rename(?:\s+it)?\s+to|name\s+it|call\s+it|set\s+(?:the\s+)?name\s+to|title\s+it)\s+["']?(.+?)["']?(?=[,.!]|$)/i;

// 2026-07-24 fuzz-sweep finding (companion to the comma-narrowing above): even
// WITHOUT a comma in play, "名前はそのままでお願いします" ("please leave the
// name as it is") still hits the marker+ending shape and captures the literal
// placeholder word "そのまま" ("as-is"/"unchanged") as if it were the actual
// new name — the opposite of the user's stated intent. Same for "名前は変え
// ずに9時にして" ("without changing the name, make it 9") — the capture
// includes the trailing time fragment too ("変えずに9時"), so a plain equals
// check isn't enough; the guard below matches these as a PREFIX instead (^,
// no trailing $) so any capture that STARTS with one of these "leave it
// alone" markers is rejected regardless of what (if anything) follows. This
// stays narrowing/low-risk because every listed phrase is a negation/state-
// preservation word, never a plausible leading word of an actual new agent
// name (real names in this app are topics — "株価チェック", "ニュースまとめ"
// — never literally "そのまま…"/"変えずに…"/"same…"), and the EN alternatives
// are \b-bounded so they can't reject an unrelated name that merely starts
// with the same letters (e.g. "Sameday Digest" still passes — verified).
const NAME_PATCH_NO_CHANGE_PLACEHOLDER_RE =
  /^(?:その\s*まま|元\s*の\s*まま|変えな(?:い|くて)|変えずに?|\bsame\b|\bas[- ]?is\b|\bunchanged\b|\bno\s+change\b)/i;

/** Extract a new display name from a "rename it to X" style utterance.
 *  Returns null when no such marker is present, the captured name is
 *  empty/implausibly long (guards against a runaway lazy match swallowing an
 *  entire unrelated sentence when no clause boundary follows), or the
 *  capture is one of the "leave it as-is" placeholder phrases above (a
 *  negative statement about the name, not a new name). */
function tryPatchName(text: string): string | null {
  const jp = text.match(NAME_PATCH_JP_RE);
  if (jp?.[1]) {
    const name = jp[1].trim();
    if (name.length > 0 && name.length <= 40 && !NAME_PATCH_NO_CHANGE_PLACEHOLDER_RE.test(name)) return name;
  }
  const en = text.match(NAME_PATCH_EN_RE);
  if (en?.[1]) {
    const name = en[1].trim();
    if (name.length > 0 && name.length <= 40 && !NAME_PATCH_NO_CHANGE_PLACEHOLDER_RE.test(name)) return name;
  }
  return null;
}

// ── Action-type patch ───────────────────────────────────────────────────

// Same literal draft-keyword check detectAction() itself uses for its own
// explicit 'draft' branch (lib/agent-nl-parser.ts) — duplicated verbatim
// (not imported; it's a private module-level const there) ONLY to answer the
// narrow question "did detectAction's 'draft' result come from an EXPLICIT
// keyword, or from its silent default-to-draft fallback", which detectAction's
// return value alone can't distinguish. See tryPatchAction's doc comment for
// why that distinction matters.
const EXPLICIT_DRAFT_KEYWORD_RE = /ドラフト|下書き|\bdraft\b/i;

/**
 * Try to detect an explicit action-type change ("通知でいいや" → notify,
 * "ファイル保存で" → draft, "Xに投稿して" → app-act, …) by reusing
 * lib/agent-nl-parser.ts's own detectAction() — the exact same detector the
 * initial parse uses, so a patch can never disagree with what a fresh
 * utterance containing the same words would have produced.
 *
 * detectAction() DEFAULTS to `{ type: 'draft' }` when nothing else matches —
 * which means calling it on a totally unrelated follow-up ("9時にして", "了
 * 解", …) would otherwise ALWAYS look like "an explicit change to draft" and
 * silently downgrade e.g. a `notify` action on every unrelated reply. Guard:
 * a 'draft' result is only trusted when the EXPLICIT draft keyword regex
 * above actually matched — every OTHER action type detectAction() can return
 * (webhook/cli/notify/app-act/social-post-adjacent) only ever comes from one
 * of its own explicit keyword/URL branches, never a silent default, so those
 * are trusted unconditionally.
 */
function tryPatchAction(draft: ParsedAgentDraft, text: string): ParsedAgentDraft['action'] | null {
  const detected = detectAction(text);
  const isExplicitHit = detected.type !== 'draft' || EXPLICIT_DRAFT_KEYWORD_RE.test(text);
  if (!isExplicitHit) return null;
  if (detected.type === draft.action.type) return null; // no actual change
  return detected;
}

// ── Autonomous-toggle patch ─────────────────────────────────────────────

/**
 * Try to detect an explicit "run without approval" turn-ON request, via
 * lib/agent-nl-parser.ts's own detectAutonomousIntent() — same detector the
 * initial parse uses. Only a `true` result is ever trusted: detectAutonomousIntent
 * returns `false` for BOTH "no autonomous language at all" (the overwhelming
 * majority of replies) and "explicitly negated" ("承認なしでは送信しないで"),
 * and neither of those should silently flip an already-true autonomous flag
 * back off — there is no safe way to tell them apart from `false` alone, so
 * turning autonomous OFF via this patch mechanism is out of scope (same "no
 * silent downgrade of a set-once field" caution as tryPatchAction above).
 */
function tryPatchAutonomous(draft: ParsedAgentDraft, text: string): boolean | null {
  if (draft.autonomous === true) return null; // already on — nothing to change
  return detectAutonomousIntent(text) === true ? true : null;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Apply whatever field-level patches `utterance` implies to `draft`. Runs
 * every detector (schedule / name / action / autonomous) independently, so a
 * single utterance naming more than one field ("名前は株価まとめにして、毎日
 * 9時に実行して") patches all of them at once. Returns null when NONE of the
 * detectors found anything to change — the caller should fall back to its
 * existing "登録待ちの下書きがあります" guidance in that case, exactly as if
 * this function didn't exist.
 *
 * Pure: never mutates `draft`, never registers anything, never decides
 * confirm/cancel. See the module doc comment's safety design — the CALLER is
 * responsible for keeping the surrounding session in `await-confirm` after
 * applying a patch (see applyPatchToPendingSession below for the version of
 * that contract hooks/use-ai-pane-dispatch.ts should actually call).
 */
export function applyDraftPatch(draft: ParsedAgentDraft, utterance: string): DraftPatchResult | null {
  const text = utterance.trim();
  if (!text) return null;
  // "@…" is this project's established "fresh command, not a reply to
  // whatever is pending" marker (same precedent as pendingAgentSession's own
  // "@" branch in hooks/use-ai-pane-dispatch.ts and this module's OWN
  // applyCorrectionToJustRegisteredAgent below, which already guards this
  // exact case). applyCorrectionToJustRegisteredAgent enforces it itself;
  // applyPatchToPendingSession previously relied ENTIRELY on its caller to
  // filter "@…" out first — today that caller does, but nothing in this
  // module stopped a fresh "@agent 名前は◯◯にして"-shaped command from being
  // misread as a literal rename patch if ever called directly or from a
  // future call site that forgot the same guard (confirmed via direct call:
  // applyDraftPatch(draft, '@agent 名前は株価まとめにして') renamed the draft
  // before this fix). Hoisting the check here, additive/narrowing only (it
  // can only turn an existing match into `null`, never the reverse), closes
  // that gap for both of this module's public entry points at once.
  if (text.startsWith('@')) return null;

  const changedFields: string[] = [];
  const patched: ParsedAgentDraft = { ...draft };

  const schedulePatch = tryPatchSchedule(draft, text);
  if (schedulePatch) {
    Object.assign(patched, schedulePatch);
    changedFields.push('schedule');
  }

  const namePatch = tryPatchName(text);
  if (namePatch && namePatch !== draft.name) {
    patched.name = namePatch;
    changedFields.push('name');
  }

  const actionPatch = tryPatchAction(draft, text);
  if (actionPatch) {
    patched.action = actionPatch;
    // The old actionCaveat (e.g. a "LINE posting not supported yet" note, or
    // a "register a social connector first" note) almost certainly no longer
    // applies to the NEW action type — drop it rather than leave a stale
    // caveat attached to an action it wasn't computed for. A fresh caveat
    // for the new action type is out of scope for this lightweight patch
    // (matches the module's "don't over-engineer" scope boundary); the
    // confirm-time summary will simply show the new action with no caveat.
    patched.actionCaveat = undefined;
    changedFields.push('action');
  }

  const autonomousPatch = tryPatchAutonomous(draft, text);
  if (autonomousPatch !== null) {
    patched.autonomous = autonomousPatch;
    changedFields.push('autonomous');
  }

  if (changedFields.length === 0) return null;
  return { patchedDraft: patched, changedFields };
}

/**
 * hooks/use-ai-pane-dispatch.ts's ONE call site for applying a patch to a
 * live `pendingAgentSession` — deliberately hard-codes `phase: 'await-confirm'`
 * on the returned session regardless of what applyDraftPatch found, so the
 * hard "never auto-register a patched draft" invariant (module doc comment,
 * point 2) cannot be accidentally dropped at a future call site: nothing
 * short of a SEPARATE, subsequent confirm-phrase reply can ever register the
 * patched draft, no matter what requireRegistrationConfirm/autonomous default
 * is in effect. `createdAt` is refreshed the same way the existing
 * neither-confirm-nor-cancel re-ask branch already does, so a patch reply
 * also resets the session's staleness clock. Returns null (session
 * untouched) when applyDraftPatch found nothing to change, so the caller can
 * fall through to its existing guidance branch unchanged.
 */
export function applyPatchToPendingSession(
  session: PendingAgentSession,
  utterance: string,
): { session: PendingAgentSession; changedFields: string[] } | null {
  const result = applyDraftPatch(session.draft, utterance);
  if (!result) return null;
  return {
    session: {
      ...session,
      draft: result.patchedDraft,
      phase: 'await-confirm',
      createdAt: Date.now(),
    },
    changedFields: result.changedFields,
  };
}

/** Partial<Agent>-shaped subset applyCorrectionToJustRegisteredAgent can fill
 *  in without any external input. Deliberately excludes `autonomous` (an
 *  autonomous-toggle correction also needs a tool/runOn recompute — see
 *  resolveAutonomousFinalTool in lib/agent-tool-router.ts — which needs live
 *  settings, specifically cloud consent, that this pure module has no
 *  business reading; see the doc comment below). Typed loosely (not
 *  `Partial<Agent>` from '@/store/types') to avoid pulling a heavier,
 *  RN-adjacent type graph into this "no RN" module for 3 fields. */
export interface RegisteredAgentPatch {
  schedule?: string | null;
  name?: string;
  action?: ParsedAgentDraft['action'];
}

export interface RegisteredAgentCorrectionResult {
  patchedDraft: ParsedAgentDraft;
  changedFields: string[];
  agentPartial: RegisteredAgentPatch;
  /** true when the utterance also carried an explicit autonomous-ON signal
   *  (i.e. 'autonomous' is in changedFields) — the caller (hooks/
   *  use-ai-pane-dispatch.ts) is responsible for that one field's separate
   *  tool/runOn resolution; this function only flags that it's needed. */
  autonomousTurnedOn: boolean;
}

/**
 * hooks/use-ai-pane-dispatch.ts's pure decision core for the "correct the
 * agent I just registered" routing block (2026-07-23,
 * store/ai-pane-store.ts's JustRegisteredAgentRef) — mirrors
 * applyPatchToPendingSession's role for the OTHER (pendingAgentSession,
 * Phase C) routing block just above: the hook itself only wires this
 * function's result to store reads/writes, lib/agent-manager.ts's
 * updateAgent, and message posting; every actual ROUTING DECISION (is the
 * correction window still live? does an "@…" fresh command bypass it? did
 * the utterance patch anything at all?) lives here instead, so it is
 * unit-testable without any RN/store/native-module setup — the same
 * "extract the pure decision core" reasoning that already applies to
 * applyPatchToPendingSession above.
 *
 * Returns null in every case the caller must stay COMPLETELY silent for (no
 * message, no store write) per the task's own "ヒットしない限り一切介入し
 * ない" requirement:
 *  - the correction window (`now - createdAt`) has expired (`staleMs`);
 *  - the utterance is a fresh "@…" command (same bypass precedent as
 *    pendingAgentSession's own "@" branch — passed through untouched,
 *    intentionally NOT treated as "no patch found" so a caller can tell the
 *    two apart if it ever needs to, even though today's caller treats them
 *    identically: do nothing, don't touch the reference);
 *  - applyDraftPatch itself found nothing to change.
 */
export function applyCorrectionToJustRegisteredAgent(
  draftSnapshot: ParsedAgentDraft,
  utterance: string,
  createdAt: number,
  staleMs: number,
  now: number = Date.now(),
): RegisteredAgentCorrectionResult | null {
  if (now - createdAt > staleMs) return null;
  if (utterance.trim().startsWith('@')) return null;

  const result = applyDraftPatch(draftSnapshot, utterance);
  if (!result) return null;

  const agentPartial: RegisteredAgentPatch = {};
  if (result.changedFields.includes('schedule')) {
    // 'once' is parseSchedule's "run now, don't schedule" sentinel — same
    // normalization draftToConfirmedAgentDraft applies (lib/agent-plan-
    // summary.ts, see its own comment) so a corrected agent is never
    // persisted with a literal 'once' schedule cronToIntervalMs can't parse.
    agentPartial.schedule = result.patchedDraft.schedule === 'once' ? null : result.patchedDraft.schedule;
  }
  if (result.changedFields.includes('name')) {
    agentPartial.name = result.patchedDraft.name;
  }
  if (result.changedFields.includes('action')) {
    agentPartial.action = result.patchedDraft.action;
  }

  return {
    patchedDraft: result.patchedDraft,
    changedFields: result.changedFields,
    agentPartial,
    autonomousTurnedOn: result.changedFields.includes('autonomous'),
  };
}
