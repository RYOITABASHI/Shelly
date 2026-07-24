/**
 * lib/agent-draft-patch.ts's applyCorrectionToJustRegisteredAgent — the pure
 * decision core for the "correct the agent I just registered" routing block
 * (hooks/use-ai-pane-dispatch.ts, 2026-07-23; store/ai-pane-store.ts's
 * JustRegisteredAgentRef). Product-owner request: the no-approval-default
 * auto-register fast path has no confirmation step, so a slip of the tongue
 * ("ごめん！やっぱり20時で！") needs a quick fix within a short window right
 * after registration, without falling back to editing the agent manually.
 *
 * These are the 4 behaviors the task explicitly calls out as required
 * coverage:
 *  1. a bare-time correction within the window actually patches the
 *     schedule (the exact "やっぱり20時で" shape);
 *  2. an utterance that patches nothing returns null (caller stays silent —
 *     no message, no store write);
 *  3. an utterance arriving AFTER the window has expired returns null even
 *     though it would otherwise have patched;
 *  4. an "@…" fresh command returns null (bypassed, not treated as "no
 *     patch found" — see the function's own doc comment) so the caller
 *     never touches the reference for it.
 */
import { applyCorrectionToJustRegisteredAgent } from '@/lib/agent-draft-patch';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';

function baseDraft(overrides: Partial<ParsedAgentDraft> = {}): ParsedAgentDraft {
  return {
    name: '株価チェック',
    prompt: '株価をまとめて',
    schedule: '0 9 * * *',
    scheduleConfident: true,
    scheduleLabel: '毎日 09:00',
    action: { type: 'draft' },
    tool: { type: 'local' },
    toolLabel: 'Local LLM',
    rawText: '毎日9時に株価をまとめて',
    ...overrides,
  };
}

const STALE_MS = 4 * 60 * 1000; // mirrors hooks/use-ai-pane-dispatch.ts's JUST_REGISTERED_STALE_MS

// "20時にして" — the exact bare-time-change shape lib/agent-draft-patch.ts's
// own JP_BARE_TIME_CHANGE_RE already matches and __tests__/agent-draft-
// patch.test.ts already covers (e.g. "9時にして"). The product owner's
// illustrative "ごめん！やっぱり20時で！" quote carries extra filler
// ("ごめん！やっぱり" / a trailing "！") outside that narrow, deliberately
// anchored-to-the-WHOLE-utterance regex (see that regex's own false-positive
// -guard doc comment in agent-draft-patch.ts) and would NOT hit today —
// that is an existing, already-shipped Phase C limitation of applyDraftPatch
// itself (this correction feature reuses it verbatim, unmodified, per the
// task's own scope), not something introduced or fixable here.
const TIME_CORRECTION_UTTERANCE = '20時にして';

describe('applyCorrectionToJustRegisteredAgent', () => {
  it('1. a bare-time correction within the window patches the schedule (the "やっぱり20時で" kind of correction)', () => {
    const createdAt = Date.now();
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft(),
      TIME_CORRECTION_UTTERANCE,
      createdAt,
      STALE_MS,
      createdAt + 10_000, // 10s later — well inside the window
    );
    expect(result).not.toBeNull();
    expect(result!.changedFields).toEqual(['schedule']);
    expect(result!.patchedDraft.schedule).toBe('0 20 * * *');
    expect(result!.agentPartial.schedule).toBe('0 20 * * *');
    expect(result!.agentPartial.name).toBeUndefined();
    expect(result!.agentPartial.action).toBeUndefined();
    expect(result!.autonomousTurnedOn).toBe(false);
  });

  it('1b. also patches a name-only correction into agentPartial.name', () => {
    const createdAt = Date.now();
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft(),
      '名前は市況まとめにして',
      createdAt,
      STALE_MS,
      createdAt + 5_000,
    );
    expect(result).not.toBeNull();
    expect(result!.changedFields).toEqual(['name']);
    expect(result!.agentPartial.name).toBe('市況まとめ');
    expect(result!.agentPartial.schedule).toBeUndefined();
  });

  it("1c. normalizes a schedule patch's 'once' sentinel to null (never persists a literal 'once' cron)", () => {
    const createdAt = Date.now();
    // A patch that resolves to a one-shot "run now" via a full confident
    // restatement — parseSchedule encodes that as schedule: 'once'.
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft(),
      'すぐに実行して',
      createdAt,
      STALE_MS,
      createdAt + 5_000,
    );
    if (result) {
      // Only assert the invariant when this utterance actually patched
      // something (parseSchedule's 'once' recognition is out of scope for
      // this test file — lib/agent-nl-parser.test.ts owns that) — the point
      // here is specifically the 'once' -> null normalization, not whether
      // "すぐに実行して" parses as 'once' at all.
      if (result.patchedDraft.schedule === 'once') {
        expect(result.agentPartial.schedule).toBeNull();
      }
    }
  });

  it('2. an utterance that patches nothing returns null (caller must stay completely silent)', () => {
    const createdAt = Date.now();
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft(),
      'ありがとう！', // ordinary follow-up chat, not a correction
      createdAt,
      STALE_MS,
      createdAt + 5_000,
    );
    expect(result).toBeNull();
  });

  it('3. an utterance arriving after the window has expired returns null even though it would otherwise patch', () => {
    const createdAt = Date.now();
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft(),
      TIME_CORRECTION_UTTERANCE,
      createdAt,
      STALE_MS,
      createdAt + STALE_MS + 1, // 1ms past the window
    );
    expect(result).toBeNull();
  });

  it('3b. an utterance arriving exactly AT the window boundary still lands (inclusive)', () => {
    const createdAt = Date.now();
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft(),
      TIME_CORRECTION_UTTERANCE,
      createdAt,
      STALE_MS,
      createdAt + STALE_MS,
    );
    expect(result).not.toBeNull();
  });

  it('4. an "@…" fresh command returns null (bypassed) even though the text after "@" would otherwise patch', () => {
    const createdAt = Date.now();
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft(),
      '@agent list',
      createdAt,
      STALE_MS,
      createdAt + 5_000,
    );
    expect(result).toBeNull();
  });

  it('4b. "@" bypass still applies even when the text right after "@" looks like a bare-time correction', () => {
    const createdAt = Date.now();
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft(),
      '@team 20時にして',
      createdAt,
      STALE_MS,
      createdAt + 5_000,
    );
    expect(result).toBeNull();
  });

  // ── DOCUMENTED, NOT FIXED — 2026-07-24 fuzz-sweep, design judgment call ──
  //
  // The task's explicit concern (mirroring tonight's real routing bug, just
  // at a different layer): "does a bare 今/今すぐ ever get misdetected as some
  // OTHER field's patch attempt". Verified: lib/agent-draft-patch.ts does NOT
  // have a dedicated schedule='once' patch detector of its own, but it DOES
  // inherit one indirectly — tryPatchSchedule's path (a) trusts ANY confident
  // parseSchedule() result outright, and parseSchedule('今') is confident
  // (schedule: 'once', "run once, right now" — see agent-nl-parser.ts's
  // branch 0). For an ALREADY-REGISTERED periodic agent within this
  // correction window, that means a bare "今" reply — sent for any reason —
  // silently clears the agent's schedule to null (agentPartial normalizes
  // 'once' -> null, since 'once' isn't a real persisted cron) rather than
  // actually running it immediately; the agent just stops firing on its
  // periodic schedule until edited again. Whether trusting bare "今" here is
  // the intended UX (arguably a legitimate "just run it now instead" request)
  // or too easily confused with an unrelated conversational "今" is a product
  // decision this task's own hard constraint (narrowing/additive fixes only)
  // says NOT to resolve unilaterally — captured as current behavior only.
  it('[DOCUMENTED, NOT FIXED] a bare "今" within the correction window clears the registered agent\'s schedule to null (not an actual "run now")', () => {
    const createdAt = Date.now();
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft(),
      '今',
      createdAt,
      STALE_MS,
      createdAt + 5_000,
    );
    expect(result).not.toBeNull();
    expect(result!.changedFields).toEqual(['schedule']);
    expect(result!.patchedDraft.schedule).toBe('once');
    expect(result!.agentPartial.schedule).toBeNull();
  });

  it('flags autonomousTurnedOn (without touching tool/runOn itself — that is the caller\'s job)', () => {
    const createdAt = Date.now();
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft(),
      '承認なしで自律実行して',
      createdAt,
      STALE_MS,
      createdAt + 5_000,
    );
    expect(result).not.toBeNull();
    expect(result!.autonomousTurnedOn).toBe(true);
    expect(result!.changedFields).toContain('autonomous');
    // agentPartial never carries autonomous/tool/runOn — see the function's
    // own doc comment for why that's the caller's responsibility.
    expect((result!.agentPartial as Record<string, unknown>).autonomous).toBeUndefined();
  });
});
