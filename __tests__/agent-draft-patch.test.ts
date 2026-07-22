import { applyDraftPatch, applyPatchToPendingSession } from '@/lib/agent-draft-patch';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';
import type { PendingAgentSession } from '@/store/ai-pane-store';

function baseDraft(overrides: Partial<ParsedAgentDraft> = {}): ParsedAgentDraft {
  return {
    name: '株価チェック',
    prompt: '株価をまとめて',
    schedule: '0 8 * * *',
    scheduleConfident: true,
    scheduleLabel: '毎日 08:00',
    action: { type: 'draft' },
    tool: { type: 'local' },
    toolLabel: 'Local LLM',
    rawText: '毎日8時に株価をまとめて',
    ...overrides,
  };
}

function baseSession(overrides: Partial<PendingAgentSession> = {}): PendingAgentSession {
  return {
    draft: baseDraft(),
    phase: 'await-confirm',
    attemptCounts: {},
    hasAssumptions: false,
    createdAt: Date.now(),
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('applyDraftPatch — schedule field', () => {
  it('a full confident restatement replaces the schedule outright', () => {
    const r = applyDraftPatch(baseDraft(), '毎日9時にして');
    expect(r).not.toBeNull();
    expect(r!.changedFields).toEqual(['schedule']);
    expect(r!.patchedDraft.schedule).toBe('0 9 * * *');
    expect(r!.patchedDraft.scheduleConfident).toBe(true);
  });

  it('a full confident restatement to weekly replaces the schedule and dow', () => {
    const r = applyDraftPatch(baseDraft(), '毎週火曜9時にして');
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.schedule).toBe('0 9 * * 2');
  });

  it('a bare time-only reply merges into the EXISTING daily frequency', () => {
    const r = applyDraftPatch(baseDraft({ schedule: '0 8 * * *' }), '9時にして');
    expect(r).not.toBeNull();
    expect(r!.changedFields).toEqual(['schedule']);
    expect(r!.patchedDraft.schedule).toBe('0 9 * * *');
    expect(r!.patchedDraft.scheduleConfident).toBe(true);
  });

  it('a bare time-only reply with a "変更して" filler also merges', () => {
    const r = applyDraftPatch(baseDraft({ schedule: '0 8 * * *' }), '夜9時に変更して');
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.schedule).toBe('0 21 * * *');
  });

  it('a bare time-only reply with minutes merges the minute too', () => {
    const r = applyDraftPatch(baseDraft({ schedule: '0 8 * * *' }), '9時30分にして');
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.schedule).toBe('30 9 * * *');
  });

  it('a bare time-only reply merges into the EXISTING weekly (single-day) frequency', () => {
    const r = applyDraftPatch(
      baseDraft({ schedule: '0 8 * * 1', scheduleLabel: '毎週月 08:00' }),
      '9時にして',
    );
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.schedule).toBe('0 9 * * 1');
  });

  it('a bare time-only reply merges into the EXISTING multi-day ("custom") frequency, preserving the dow list', () => {
    const r = applyDraftPatch(
      baseDraft({ schedule: '0 8 * * 1,5', scheduleLabel: '毎週月・金 08:00' }),
      '9時にして',
    );
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.schedule).toBe('0 9 * * 1,5');
  });

  it('an EN bare time-only reply also merges', () => {
    const r = applyDraftPatch(baseDraft({ schedule: '0 8 * * *' }), 'make it 9am');
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.schedule).toBe('0 9 * * *');
  });

  it('does not merge a bare time onto an interval/hourly schedule (out of scope, no single well-defined meaning)', () => {
    const r = applyDraftPatch(
      baseDraft({ schedule: '*/15 * * * *', scheduleLabel: '15分ごと' }),
      '9時にして',
    );
    expect(r).toBeNull();
  });

  it('clears a stale scheduleAssumed flag once an explicit time is given', () => {
    const draft = baseDraft({
      schedule: '0 8 * * *',
      scheduleAssumed: true,
      suggestedTime: { hour: 8, minute: 0 },
    });
    const r = applyDraftPatch(draft, '9時にして');
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.scheduleAssumed).toBeUndefined();
  });

  // ── The false-positive containment case named in the task spec: a time
  // mentioned as part of the PROMPT CONTENT ("9時のニュース" = "the 9 o'clock
  // news"), not a schedule-change instruction. The narrow isBareTimeChangeUtterance
  // shape gate (module doc comment) requires the WHOLE utterance to be just a
  // time + short change-filler, so this longer sentence never reaches the
  // merge branch — and even if some OTHER phrasing did slip through, the
  // safety design (never auto-register, always show a diff) contains the
  // blast radius; see the ai-pane-pending-session-shaped tests below for that
  // containment guarantee. ──
  it('does NOT misread "9時のニュースをまとめて" (a time inside prompt content) as a schedule change', () => {
    const r = applyDraftPatch(baseDraft({ schedule: '0 8 * * *' }), '9時のニュースをまとめて');
    expect(r).toBeNull();
  });

  it('does NOT misread a longer sentence containing a time as a schedule change even with other filler words', () => {
    const r = applyDraftPatch(
      baseDraft({ schedule: '0 8 * * *' }),
      '9時に届く速報を見てから判断してください',
    );
    expect(r).toBeNull();
  });
});

describe('applyDraftPatch — name field', () => {
  it('"名前は◯◯にして" renames the draft', () => {
    const r = applyDraftPatch(baseDraft(), '名前は朝の株価チェックにして');
    expect(r).not.toBeNull();
    expect(r!.changedFields).toEqual(['name']);
    expect(r!.patchedDraft.name).toBe('朝の株価チェック');
  });

  it('"タイトルを◯◯に" renames the draft (no して)', () => {
    const r = applyDraftPatch(baseDraft(), 'タイトルを株価まとめに');
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.name).toBe('株価まとめ');
  });

  it('an EN "rename it to X" renames the draft', () => {
    const r = applyDraftPatch(baseDraft(), 'rename it to Daily Digest');
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.name).toBe('Daily Digest');
  });

  it('renaming to the SAME name is not reported as a change', () => {
    const r = applyDraftPatch(baseDraft({ name: '株価まとめ' }), 'タイトルを株価まとめに');
    expect(r).toBeNull();
  });
});

describe('applyDraftPatch — action field', () => {
  it('"通知でいいや" switches a draft action to notify', () => {
    const r = applyDraftPatch(baseDraft({ action: { type: 'draft' } }), '通知でいいや');
    expect(r).not.toBeNull();
    expect(r!.changedFields).toEqual(['action']);
    expect(r!.patchedDraft.action).toEqual({ type: 'notify' });
  });

  it('"ファイル保存で" switches a notify action to draft (explicit keyword, not the silent default)', () => {
    const r = applyDraftPatch(baseDraft({ action: { type: 'notify' } }), 'ドラフトで保存して');
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.action).toEqual({ type: 'draft' });
  });

  it('an unrelated reply never silently downgrades a non-draft action to draft via detectAction\'s default fallback', () => {
    // "9時にして" matches none of detectAction's explicit keyword branches, so
    // detectAction() itself falls through to its {type:'draft'} default. If
    // that default were trusted blindly, a schedule-only reply would also
    // silently flip a `notify` action to `draft` — this must NOT happen.
    const r = applyDraftPatch(baseDraft({ action: { type: 'notify' }, schedule: '0 8 * * *' }), '9時にして');
    expect(r).not.toBeNull();
    expect(r!.changedFields).toEqual(['schedule']); // action untouched
    expect(r!.patchedDraft.action).toEqual({ type: 'notify' });
  });

  it('clears a stale actionCaveat when the action type is patched', () => {
    const draft = baseDraft({ action: { type: 'draft' }, actionCaveat: 'LINEへの投稿にはまだ対応していません' });
    const r = applyDraftPatch(draft, '通知でいいや');
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.actionCaveat).toBeUndefined();
  });
});

describe('applyDraftPatch — autonomous field', () => {
  it('"承認なしで" turns autonomous ON', () => {
    const r = applyDraftPatch(baseDraft({ autonomous: undefined }), '承認なしでお願いします');
    expect(r).not.toBeNull();
    expect(r!.changedFields).toEqual(['autonomous']);
    expect(r!.patchedDraft.autonomous).toBe(true);
  });

  it('"自律で" turns autonomous ON', () => {
    const r = applyDraftPatch(baseDraft({ autonomous: false }), '自律でお願い');
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.autonomous).toBe(true);
  });

  it('an unrelated reply never turns autonomous ON via a false positive', () => {
    const r = applyDraftPatch(baseDraft({ autonomous: false, schedule: '0 8 * * *' }), '9時にして');
    expect(r).not.toBeNull();
    expect(r!.changedFields).toEqual(['schedule']);
    expect(r!.patchedDraft.autonomous).toBe(false);
  });

  it('never flips an already-true autonomous flag off (no safe way to distinguish "no signal" from "explicit off")', () => {
    const r = applyDraftPatch(baseDraft({ autonomous: true, schedule: '0 8 * * *' }), '9時にして');
    expect(r).not.toBeNull();
    expect(r!.patchedDraft.autonomous).toBe(true);
    expect(r!.changedFields).not.toContain('autonomous');
  });

  it('a negated autonomous phrase is not treated as a turn-on signal', () => {
    const r = applyDraftPatch(
      baseDraft({ autonomous: false }),
      '承認なしでは送信しないでください',
    );
    expect(r).toBeNull();
  });
});

describe('applyDraftPatch — multiple fields at once', () => {
  it('a single utterance naming both name and a full schedule restatement patches BOTH', () => {
    const r = applyDraftPatch(baseDraft(), '名前は株価まとめにして、毎日9時に実行して');
    expect(r).not.toBeNull();
    expect(new Set(r!.changedFields)).toEqual(new Set(['name', 'schedule']));
    expect(r!.patchedDraft.name).toBe('株価まとめ');
    expect(r!.patchedDraft.schedule).toBe('0 9 * * *');
  });

  it('a single utterance naming action + autonomous patches BOTH', () => {
    const r = applyDraftPatch(
      baseDraft({ action: { type: 'draft' }, autonomous: false }),
      '通知でいいや、承認なしでお願いします',
    );
    expect(r).not.toBeNull();
    expect(new Set(r!.changedFields)).toEqual(new Set(['action', 'autonomous']));
    expect(r!.patchedDraft.action).toEqual({ type: 'notify' });
    expect(r!.patchedDraft.autonomous).toBe(true);
  });
});

describe('applyDraftPatch — no hits', () => {
  it('returns null for an utterance that matches none of the field detectors', () => {
    const r = applyDraftPatch(baseDraft(), 'うーん、それどうなのかな');
    expect(r).toBeNull();
  });

  it('returns null for an empty/whitespace-only utterance', () => {
    expect(applyDraftPatch(baseDraft(), '')).toBeNull();
    expect(applyDraftPatch(baseDraft(), '   ')).toBeNull();
  });

  it('the original draft object is never mutated', () => {
    const draft = baseDraft();
    const snapshot = { ...draft };
    applyDraftPatch(draft, '9時にして');
    expect(draft).toEqual(snapshot);
  });
});

describe('applyPatchToPendingSession — safety invariants', () => {
  it('returns null (session untouched) when applyDraftPatch found nothing to change', () => {
    const session = baseSession();
    const r = applyPatchToPendingSession(session, 'うーん、それどうなのかな');
    expect(r).toBeNull();
  });

  it('a hit ALWAYS keeps phase "await-confirm" — never auto-registers, regardless of what changed', () => {
    const session = baseSession({ phase: 'await-confirm' });
    const r = applyPatchToPendingSession(session, '毎日9時にして');
    expect(r).not.toBeNull();
    expect(r!.session.phase).toBe('await-confirm');
  });

  it('a hit on a draft that ALSO carries an assumed-schedule flag still stays await-confirm (no bypass of the assumption gate)', () => {
    const session = baseSession({
      draft: baseDraft({ scheduleAssumed: true }),
    });
    const r = applyPatchToPendingSession(session, '名前は株価まとめにして');
    expect(r).not.toBeNull();
    expect(r!.session.phase).toBe('await-confirm');
  });

  it('updates the session draft to the patched draft and refreshes createdAt', () => {
    const oldCreatedAt = Date.now() - 999999;
    const session = baseSession({ createdAt: oldCreatedAt });
    const r = applyPatchToPendingSession(session, '毎日9時にして');
    expect(r).not.toBeNull();
    expect(r!.session.draft.schedule).toBe('0 9 * * *');
    expect(r!.session.createdAt).toBeGreaterThan(oldCreatedAt);
  });

  it('preserves messageId/agentLabel/attemptCounts/hasAssumptions from the original session', () => {
    const session = baseSession({
      messageId: 'msg-42',
      agentLabel: 'groq',
      attemptCounts: { confirm: 2 },
      hasAssumptions: true,
    });
    const r = applyPatchToPendingSession(session, '毎日9時にして');
    expect(r).not.toBeNull();
    expect(r!.session.messageId).toBe('msg-42');
    expect(r!.session.agentLabel).toBe('groq');
    expect(r!.session.attemptCounts).toEqual({ confirm: 2 });
    expect(r!.session.hasAssumptions).toBe(true);
  });

  it('reports the same changedFields the underlying applyDraftPatch found', () => {
    const session = baseSession();
    const r = applyPatchToPendingSession(session, '名前は株価まとめにして、毎日9時に実行して');
    expect(r).not.toBeNull();
    expect(new Set(r!.changedFields)).toEqual(new Set(['name', 'schedule']));
  });
});
