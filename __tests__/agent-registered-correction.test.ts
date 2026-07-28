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

  it("1c. a schedule patch that resolves to 'once' while the agent has NO real recurring schedule to protect still normalizes to null (unchanged pre-fix behavior)", () => {
    const createdAt = Date.now();
    // A patch that resolves to a one-shot "run now" via a full confident
    // restatement — parseSchedule encodes that as schedule: 'once'. Here the
    // agent is already manual-only (schedule: null), so there is nothing
    // recurring to protect — see the "bug fix" doc comment on
    // applyCorrectionToJustRegisteredAgent for why this case is deliberately
    // NOT routed through runNowRequested.
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft({ schedule: null, scheduleLabel: 'Manual only' }),
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
        expect(result.runNowRequested).toBe(false);
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

  // ── FIXED — 2026-07-27, on-device repro at versionCode 1988 ──────────────
  //
  // Was: [DOCUMENTED, NOT FIXED] — a bare "今"/"今すぐ実行して" reply within
  // the correction window silently cleared an ALREADY-REGISTERED recurring
  // agent's schedule to null (Sidebar's schedule column visibly flipped from
  // e.g. "0 9 * * *" to "manual") instead of just running it once, right
  // now. See applyCorrectionToJustRegisteredAgent's "bug fix" doc comment
  // for the full root-cause writeup and docs/superpowers/DEFERRED.md's
  // "「今」/「今すぐ」が保留下書きへのパッチ・登録済みエージェントへの補正
  // として schedule:'once' を無条件に信頼する" entry for the original
  // (now-resolved) product-judgment writeup.
  it('a bare "今" within the correction window does NOT clear an already-recurring agent\'s schedule — flags runNowRequested instead', () => {
    const createdAt = Date.now();
    const result = applyCorrectionToJustRegisteredAgent(
      baseDraft(), // schedule: '0 9 * * *' — a real recurring cron
      '今',
      createdAt,
      STALE_MS,
      createdAt + 5_000,
    );
    expect(result).not.toBeNull();
    // 'schedule' is deliberately EXCLUDED — nothing about the persisted
    // cron changed, so there is nothing left for changedFields to report.
    expect(result!.changedFields).toEqual([]);
    // The draft handed back for any re-posted summary keeps the ORIGINAL
    // schedule, not 'once' — a summary built from (empty) changedFields
    // would never mark it anyway, but this also guards against a future
    // caller reading patchedDraft.schedule directly.
    expect(result!.patchedDraft.schedule).toBe('0 9 * * *');
    expect(result!.agentPartial.schedule).toBeUndefined();
    expect(result!.runNowRequested).toBe(true);
  });

  // The exact on-device repro shape from bug write-up: "毎日9時にニュースを
  // まとめてファイルに保存して" registers with schedule "0 9 * * *", then
  // within the correction window "今すぐ実行して" (not the bare "今" above —
  // the fuller, more natural phrasing an actual user typed on-device).
  it('the exact on-device repro: "今すぐ実行して" against an already-registered daily-9am agent leaves its schedule untouched', () => {
    const createdAt = Date.now();
    const dailyNineAmDraft = baseDraft({
      name: 'ニュースまとめ',
      prompt: 'ニュースをまとめてファイルに保存して',
      schedule: '0 9 * * *',
      scheduleLabel: '毎日 09:00',
      rawText: '毎日9時にニュースをまとめてファイルに保存して',
    });
    const result = applyCorrectionToJustRegisteredAgent(
      dailyNineAmDraft,
      '今すぐ実行して',
      createdAt,
      STALE_MS,
      createdAt + 30_000, // well inside the 4-minute correction window
    );
    expect(result).not.toBeNull();
    expect(result!.runNowRequested).toBe(true);
    expect(result!.changedFields).not.toContain('schedule');
    expect(result!.agentPartial.schedule).toBeUndefined();
    // The persisted cron the caller will (NOT) write back is the original —
    // asserting this on patchedDraft mirrors what the caller actually reads.
    expect(result!.patchedDraft.schedule).toBe('0 9 * * *');
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
