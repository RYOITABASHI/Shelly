import { parseAgentNL } from '@/lib/agent-nl-parser';

// The scheduler accepts ONLY these three cron shapes (lib/agent-scheduler.ts).
// Any non-null schedule the parser emits MUST match one of them, or the agent
// would silently never fire — the spec's hard requirement (§2.1).
const WHITELIST_CRON = /^(\*\/\d+ \* \* \* \*|\d+ \d+ \* \* \*|\d+ \d+ \* \* [0-6])$/;

describe('parseAgentNL — schedule (JP)', () => {
  it('毎日8時 → daily 0 8 * * *, confident', () => {
    const d = parseAgentNL('毎日8時にXの下書きを作って');
    expect(d.schedule).toBe('0 8 * * *');
    expect(d.scheduleConfident).toBe(true);
    expect(d.action.type).toBe('draft');
  });

  it('毎日20時30分 → 30 20 * * *', () => {
    const d = parseAgentNL('毎日20時30分に通知して');
    expect(d.schedule).toBe('30 20 * * *');
    expect(d.action.type).toBe('notify');
  });

  it('毎朝7時 → 0 7 * * *', () => {
    expect(parseAgentNL('毎朝7時にニュースをまとめて').schedule).toBe('0 7 * * *');
  });

  it('毎日夜8時 → 0 20 * * * (PM meridiem)', () => {
    expect(parseAgentNL('毎日夜8時に集計して').schedule).toBe('0 20 * * *');
  });

  it('毎日午後3時半 → 30 15 * * * (午後 + 半)', () => {
    expect(parseAgentNL('毎日午後3時半にレポートを作成して').schedule).toBe('30 15 * * *');
  });
});

describe('parseAgentNL — interval', () => {
  it('15分ごと → */15 * * * *', () => {
    expect(parseAgentNL('15分ごとにポートをチェックして').schedule).toBe('*/15 * * * *');
  });

  it('every 5 minutes → */5 * * * *, notify', () => {
    const d = parseAgentNL('every 5 minutes notify me of new mail');
    expect(d.schedule).toBe('*/5 * * * *');
    expect(d.action.type).toBe('notify');
  });

  it('90分ごと (out of */N range) → null, not confident', () => {
    const d = parseAgentNL('90分ごとに実行して');
    expect(d.schedule).toBeNull();
    expect(d.scheduleConfident).toBe(false);
  });

  it('2時間ごと (hour interval not in whitelist) → null', () => {
    const d = parseAgentNL('2時間ごとにバックアップして');
    expect(d.schedule).toBeNull();
    expect(d.scheduleConfident).toBe(false);
  });
});

describe('parseAgentNL — weekly', () => {
  it('毎週月曜9時 → 0 9 * * 1', () => {
    expect(parseAgentNL('毎週月曜9時に週報を作って').schedule).toBe('0 9 * * 1');
  });

  it('毎週日曜10時 → 0 10 * * 0 (Sunday = 0)', () => {
    expect(parseAgentNL('毎週日曜10時にまとめて').schedule).toBe('0 10 * * 0');
  });

  it('every monday at 9am → 0 9 * * 1', () => {
    expect(parseAgentNL('every monday at 9am send a summary').schedule).toBe('0 9 * * 1');
  });

  it('weekly with no time → null, not confident (needs manual time)', () => {
    const d = parseAgentNL('毎週金曜にまとめて');
    expect(d.schedule).toBeNull();
    expect(d.scheduleConfident).toBe(false);
    expect(d.scheduleLabel).toContain('金');
  });
});

describe('parseAgentNL — daily (EN)', () => {
  it('every day at 8 → 0 8 * * *', () => {
    expect(parseAgentNL('every day at 8 draft a post').schedule).toBe('0 8 * * *');
  });
});

describe('parseAgentNL — ambiguous / unparseable (never silently register)', () => {
  it('bare time, no frequency → null + suggestedTime pre-fill', () => {
    const d = parseAgentNL('8時にメールをチェックして');
    expect(d.schedule).toBeNull();
    expect(d.scheduleConfident).toBe(false);
    expect(d.suggestedTime).toEqual({ hour: 8, minute: 0 });
  });

  it('no time, no frequency → null, not confident', () => {
    const d = parseAgentNL('ニュースを要約して');
    expect(d.schedule).toBeNull();
    expect(d.scheduleConfident).toBe(false);
  });
});

describe('parseAgentNL — action layer (capability boundary)', () => {
  it('URL present → webhook with extracted url', () => {
    const d = parseAgentNL('毎日8時に https://example.com/hook にPOSTして');
    expect(d.schedule).toBe('0 8 * * *');
    expect(d.action.type).toBe('webhook');
    expect(d.action.webhookUrl).toBe('https://example.com/hook');
  });

  it('explicit "コマンド実行" → cli (no command inferred)', () => {
    const d = parseAgentNL('毎日9時にコマンド実行して結果を保存');
    expect(d.action.type).toBe('cli');
    expect(d.action.command).toBeUndefined();
  });

  it('default delivery is draft (never publish)', () => {
    const d = parseAgentNL('毎日8時にブログ記事を書いて');
    expect(d.action.type).toBe('draft');
    // 'publish' is not a representable action type — draft is the safe default.
    expect(['draft', 'notify', 'webhook', 'cli']).toContain(d.action.type);
  });

  it('SNS publish wording still stays draft-only unless a webhook or cli is explicit', () => {
    for (const text of [
      '毎日8時にXへ投稿する下書きを作って',
      '毎朝Substackに公開する記事を準備して',
      'every day at 8 prepare a post for X and publish it later',
    ]) {
      expect(parseAgentNL(text).action.type).toBe('draft');
    }
  });

  it('generic task does NOT escalate to cli', () => {
    expect(parseAgentNL('毎日8時に要約を作って').action.type).toBe('draft');
  });
});

describe('parseAgentNL — invariants', () => {
  const samples = [
    '毎日8時にXの下書きを作って',
    '毎日20時30分に通知して',
    '毎朝7時にニュースをまとめて',
    '15分ごとにポートをチェックして',
    'every 5 minutes notify me',
    '毎週月曜9時に週報を作って',
    'every monday at 9am send a summary',
    'every day at 8 draft a post',
  ];

  it('every confident schedule matches a whitelisted cron shape', () => {
    for (const s of samples) {
      const d = parseAgentNL(s);
      if (d.scheduleConfident) {
        expect(d.schedule).not.toBeNull();
        expect(d.schedule!).toMatch(WHITELIST_CRON);
      }
    }
  });

  it('always returns a non-empty name and a routed tool', () => {
    for (const s of [...samples, 'ニュースを要約して', '']) {
      const d = parseAgentNL(s);
      expect(typeof d.name).toBe('string');
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.tool).toBeDefined();
      expect(typeof d.toolLabel).toBe('string');
    }
  });

  it('does not throw on empty / whitespace input', () => {
    expect(() => parseAgentNL('')).not.toThrow();
    expect(() => parseAgentNL('   ')).not.toThrow();
    expect(parseAgentNL('').schedule).toBeNull();
  });
});

describe('parseAgentNL — memory (Phase 1)', () => {
  it('JP: 覚えておいて → memory.remember with the fact captured', () => {
    const d = parseAgentNL('私は簡潔な要約が好みだと覚えておいて');
    expect(d.memory?.remember).toBe(true);
    expect(d.memory?.rememberFact).toContain('簡潔な要約');
  });

  it('EN: "remember that …" → memory.remember with the fact captured', () => {
    const d = parseAgentNL('remember that I prefer concise summaries');
    expect(d.memory?.remember).toBe(true);
    expect(d.memory?.rememberFact?.toLowerCase()).toContain('concise summaries');
  });

  it('is absent for ordinary tasks (no false positives)', () => {
    expect(parseAgentNL('毎日8時にニュースを要約して').memory).toBeUndefined();
    expect(parseAgentNL('summarize the news every day').memory).toBeUndefined();
  });

  it('does NOT fire on negated "remember" (statement of not recalling)', () => {
    expect(parseAgentNL("I don't remember the password").memory).toBeUndefined();
    expect(parseAgentNL("I can't remember where I put my keys").memory).toBeUndefined();
    expect(parseAgentNL('覚えていないことを調べて').memory).toBeUndefined();
    expect(parseAgentNL('パスワードを思い出せない').memory).toBeUndefined();
  });

  it('still fires on "don\'t forget" (affirmative keep-this)', () => {
    const d = parseAgentNL("don't forget to water the plants");
    expect(d.memory?.remember).toBe(true);
  });
});
