import {
  needsNotificationTrigger,
  nextMissingSlot,
  applySlotAnswer,
  isCancelPhrase,
  detectMessageLocale,
} from '@/lib/agent-slot-fill';
import type { ParsedAgentDraft } from '@/lib/agent-nl-parser';

// Minimal, fully-specified draft factory — tests override only the fields
// relevant to the scenario under test, keeping each case terse and honest
// about what actually varies.
function makeDraft(overrides: Partial<ParsedAgentDraft> = {}): ParsedAgentDraft {
  return {
    name: 'Test Agent',
    prompt: 'テストタスク',
    schedule: '0 8 * * *',
    scheduleConfident: true,
    scheduleLabel: '毎日 08:00',
    action: { type: 'notify' },
    tool: { type: 'auto' },
    toolLabel: 'Auto',
    rawText: 'テストタスク',
    ...overrides,
  };
}

describe('needsNotificationTrigger', () => {
  it('is true for an English "when I get a notification from" trigger phrase', () => {
    const d = makeDraft({ rawText: 'when I get a notification from Slack, summarize it', prompt: 'summarize it' });
    expect(needsNotificationTrigger(d)).toBe(true);
  });

  it('is true for a Japanese "◯◯の通知が来たら実行して" trigger phrase', () => {
    const d = makeDraft({ rawText: 'LINEの通知が来たら実行して', prompt: '実行して' });
    expect(needsNotificationTrigger(d)).toBe(true);
  });

  it('is false for an ordinary "notify me daily at 8am" agent (action.type=notify, no trigger phrasing)', () => {
    const d = makeDraft({
      rawText: '毎日8時に天気を通知して',
      prompt: '天気を通知して',
      action: { type: 'notify' },
    });
    expect(needsNotificationTrigger(d)).toBe(false);
  });

  it('is false when notificationTrigger.packageNames is already set', () => {
    const d = makeDraft({
      rawText: 'LINEの通知が来たら実行して',
      prompt: '実行して',
      notificationTrigger: { packageNames: ['jp.naver.line.android'] },
    });
    expect(needsNotificationTrigger(d)).toBe(false);
  });

  it('does not false-positive on notification-delivery phrasing ("notification from")', () => {
    const draft = makeDraft({ rawText: 'send me a notification from this report when it finishes', prompt: 'send me a notification from this report when it finishes' });
    expect(needsNotificationTrigger(draft)).toBe(false);
  });
});

describe('nextMissingSlot', () => {
  it('prioritises schedule over other missing slots even when other things are also missing', () => {
    const d = makeDraft({
      scheduleConfident: false,
      rawText: 'LINEの通知が来たら実行して',
      prompt: '実行して',
      action: { type: 'draft' },
    });
    const slot = nextMissingSlot(d, {});
    expect(slot?.field).toBe('schedule');
  });

  it('returns null for a fully-resolved draft whose action is not draft, even with no vault path configured', () => {
    const d = makeDraft({ scheduleConfident: true, action: { type: 'notify' } });
    expect(nextMissingSlot(d, {})).toBeNull();
  });

  it('asks for notificationTrigger when the schedule is confident but the trigger phrase is unresolved', () => {
    const d = makeDraft({
      scheduleConfident: true,
      rawText: 'LINEの通知が来たら実行して',
      prompt: '実行して',
      action: { type: 'notify' },
    });
    const slot = nextMissingSlot(d, {});
    expect(slot?.field).toBe('notificationTrigger');
  });

  it('asks for outputPath when action=draft and no vault/topic folder is configured', () => {
    const d = makeDraft({ scheduleConfident: true, action: { type: 'draft' } });
    const slot = nextMissingSlot(d, {});
    expect(slot?.field).toBe('outputPath');
  });

  it('skips the outputPath question when action=draft but agentVaultPath is already configured', () => {
    const d = makeDraft({ scheduleConfident: true, action: { type: 'draft' } });
    expect(nextMissingSlot(d, { agentVaultPath: '/sdcard/Obsidian/Vault' })).toBeNull();
  });

  it('skips the outputPath question when action=draft but agentTopicFolder is already configured', () => {
    const d = makeDraft({ scheduleConfident: true, action: { type: 'draft' } });
    expect(nextMissingSlot(d, { agentTopicFolder: 'STEAM_AI' })).toBeNull();
  });
});

describe('applySlotAnswer — schedule', () => {
  it('a confident answer resolves and updates the draft schedule fields', () => {
    const d = makeDraft({ scheduleConfident: false, schedule: null, scheduleLabel: '未設定（要選択）' });
    const { draft, resolved } = applySlotAnswer('schedule', d, '毎日8時', 0);
    expect(resolved).toBe(true);
    expect(draft.schedule).toBe('0 8 * * *');
    expect(draft.scheduleConfident).toBe(true);
  });

  it('an unparseable answer with attemptCount=0 does NOT resolve (asks again)', () => {
    const d = makeDraft({ scheduleConfident: false, schedule: null });
    const { resolved } = applySlotAnswer('schedule', d, 'いい感じの時間で', 0);
    expect(resolved).toBe(false);
  });

  it('attemptCount=2 force-resolves with scheduleConfident:false (hands off to the card picker)', () => {
    const d = makeDraft({ scheduleConfident: false, schedule: null });
    const { draft, resolved } = applySlotAnswer('schedule', d, 'いい感じの時間で', 2);
    expect(resolved).toBe(true);
    expect(draft.scheduleConfident).toBe(false);
  });
});

describe('applySlotAnswer — notificationTrigger', () => {
  it('valid packages resolve', () => {
    const d = makeDraft();
    const { draft, resolved } = applySlotAnswer('notificationTrigger', d, 'com.whatsapp', 0);
    expect(resolved).toBe(true);
    expect(draft.notificationTrigger).toEqual({ packageNames: ['com.whatsapp'] });
  });

  it('an unparseable answer with attemptCount=0 does NOT resolve (asks again)', () => {
    const d = makeDraft();
    const { resolved } = applySlotAnswer('notificationTrigger', d, 'わからない', 0);
    expect(resolved).toBe(false);
  });

  it('attemptCount=1 force-resolves even with empty/invalid input', () => {
    const d = makeDraft();
    const { draft, resolved } = applySlotAnswer('notificationTrigger', d, 'わからない', 1);
    expect(resolved).toBe(true);
    expect(draft.notificationTrigger).toBeUndefined();
  });
});

describe('applySlotAnswer — outputPath', () => {
  it('a real string sets outputPath and resolves', () => {
    const d = makeDraft();
    const { draft, resolved } = applySlotAnswer('outputPath', d, '/sdcard/Documents/agent-output', 0);
    expect(resolved).toBe(true);
    expect(draft.outputPath).toBe('/sdcard/Documents/agent-output');
  });

  it('a skip-phrase leaves outputPath undefined, still resolved:true', () => {
    const d = makeDraft();
    const { draft, resolved } = applySlotAnswer('outputPath', d, 'そのままでいい', 0);
    expect(resolved).toBe(true);
    expect(draft.outputPath).toBeUndefined();
  });

  it('an empty string leaves outputPath undefined, still resolved:true', () => {
    const d = makeDraft();
    const { draft, resolved } = applySlotAnswer('outputPath', d, '   ', 0);
    expect(resolved).toBe(true);
    expect(draft.outputPath).toBeUndefined();
  });
});

describe('isCancelPhrase', () => {
  it('matches the listed phrases exactly, case-insensitively', () => {
    expect(isCancelPhrase('cancel')).toBe(true);
    expect(isCancelPhrase('CANCEL')).toBe(true);
    expect(isCancelPhrase('  Never Mind  ')).toBe(true);
    expect(isCancelPhrase('nevermind')).toBe(true);
    expect(isCancelPhrase('やめて')).toBe(true);
    expect(isCancelPhrase('キャンセル')).toBe(true);
    expect(isCancelPhrase('中止')).toBe(true);
  });

  it('does NOT match a longer message that merely contains "cancel" as a substring', () => {
    expect(isCancelPhrase('please cancel my subscription reminder agent')).toBe(false);
  });
});

describe('detectMessageLocale', () => {
  it('detects ja from Hiragana/Katakana/CJK-ideograph presence', () => {
    expect(detectMessageLocale('毎日8時にニュースをまとめて')).toBe('ja');
    expect(detectMessageLocale('レポート作成')).toBe('ja');
  });

  it('detects en for ASCII-only text', () => {
    expect(detectMessageLocale('summarize the news every day at 8am')).toBe('en');
    expect(detectMessageLocale('123')).toBe('en');
  });
});

describe('nextMissingSlot — question language follows the ORIGINAL utterance, not any global setting', () => {
  it('asks in Japanese for a Japanese-language draft', () => {
    const d = makeDraft({ scheduleConfident: false, rawText: 'ニュースをまとめて', prompt: 'ニュースをまとめて' });
    const missing = nextMissingSlot(d, {});
    expect(missing?.field).toBe('schedule');
    expect(missing?.question).toMatch(/[ぁ-んァ-ヶ一-龯]/);
  });

  it('asks in English for an English-language draft', () => {
    const d = makeDraft({ scheduleConfident: false, rawText: 'summarize the news', prompt: 'summarize the news' });
    const missing = nextMissingSlot(d, {});
    expect(missing?.field).toBe('schedule');
    expect(missing?.question).not.toMatch(/[ぁ-んァ-ヶ一-龯]/);
  });

  it('a later English answer to a Japanese-opened conversation does not itself change the question language (attemptCount retry stays on rawText)', () => {
    // rawText is fixed at the original utterance throughout a slot-fill
    // conversation — applySlotAnswer never overwrites it — so re-asking
    // after a failed attempt must stay in the language the conversation
    // started in, even if the user's retry reply happens to be in English.
    const d = makeDraft({ scheduleConfident: false, rawText: '毎日レポートを作って', prompt: 'レポートを作って' });
    const missing = nextMissingSlot(d, {});
    expect(missing?.question).toMatch(/[ぁ-んァ-ヶ一-龯]/);
  });
});
