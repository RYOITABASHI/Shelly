import { parseAgentNL } from '@/lib/agent-nl-parser';

// The scheduler accepts ONLY these three cron shapes (lib/agent-scheduler.ts).
// Any non-null schedule the parser emits MUST match one of them, or the agent
// would silently never fire — the spec's hard requirement (§2.1).
// Single-day OR a multi-day DOW list (e.g. "1,5" = Mon/Fri) — both accepted by
// lib/agent-scheduler.ts (DOW_LIST_RE) and the native AgentAlarmReceiver.
const WHITELIST_CRON = /^(\*\/\d+ \* \* \* \*|0 \*\/\d+ \* \* \*|\d+ \d+ \* \* \*|\d+ \d+ \* \* [0-6](,[0-6])*)$/;

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

describe('parseAgentNL — run immediately (Once)', () => {
  // 'once' here is a sentinel consumed only by decodeCron/buildCron inside
  // AgentConfirmCard (buildCron('once', ...) => null at actual registration
  // time) — never a real cron, so it's deliberately excluded from
  // WHITELIST_CRON / the "invariants" describe block below. Bug: a bare
  // "すぐに"/"今すぐ" answer to the schedule slot-fill question previously fell
  // through every branch to confident:false, looping the follow-up question
  // forever instead of landing on the Once frequency.
  it.each([
    'すぐに', '今すぐ', '直ちに', '即時', '即座に',
    'right now', 'immediately', 'now', 'asap', 'right away',
  ])('%s → schedule "once", confident', (phrase) => {
    const d = parseAgentNL(phrase);
    expect(d.schedule).toBe('once');
    expect(d.scheduleConfident).toBe(true);
  });

  it('does not misfire on a sentence that merely contains "now"/"すぐ"', () => {
    const d = parseAgentNL('毎日8時にすぐ終わるタスクを実行して');
    expect(d.schedule).not.toBe('once');
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

  it('2時間ごと → 0 */2 * * *, confident', () => {
    const d = parseAgentNL('2時間ごとにバックアップして');
    expect(d.schedule).toBe('0 */2 * * *');
    expect(d.scheduleConfident).toBe(true);
  });

  it('23時間ごと (upper boundary) → 0 */23 * * *, confident', () => {
    const d = parseAgentNL('23時間ごとにバックアップして');
    expect(d.schedule).toBe('0 */23 * * *');
    expect(d.scheduleConfident).toBe(true);
  });

  it('every 3 hours → 0 */3 * * *, confident', () => {
    const d = parseAgentNL('every 3 hours check the server');
    expect(d.schedule).toBe('0 */3 * * *');
    expect(d.scheduleConfident).toBe(true);
  });

  it('25時間ごと (out of */N range) → null, not confident', () => {
    const d = parseAgentNL('25時間ごとにバックアップして');
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

  it('月曜と金曜の朝8時 → 0 8 * * 1,5 (multi-day, no 毎週 needed)', () => {
    const d = parseAgentNL('月曜と金曜の朝8時にSTEAM×AIの論文を集めて');
    expect(d.schedule).toBe('0 8 * * 1,5');
    expect(d.scheduleConfident).toBe(true);
    expect(d.scheduleLabel).toContain('月・金');
  });

  it('毎週月・水・金 → sorted dow list, deduped', () => {
    expect(parseAgentNL('毎週月曜・水曜・金曜の10時に集計して').schedule).toBe('0 10 * * 1,3,5');
  });

  it('EN multi-day: mon and thu at 7am → 0 7 * * 1,4', () => {
    expect(parseAgentNL('every monday and thursday at 7am send a digest').schedule).toBe('0 7 * * 1,4');
  });

  it('multi-day with no time → null, not confident, label keeps all days', () => {
    const d = parseAgentNL('月曜と金曜にまとめて');
    expect(d.schedule).toBeNull();
    expect(d.scheduleConfident).toBe(false);
    expect(d.scheduleLabel).toContain('月・金');
  });

  it('explicit 毎日 outranks an incidental weekday → daily, not weekly', () => {
    // Regression guard: a 曜-weekday must not hijack an explicit daily marker.
    expect(parseAgentNL('毎日月曜の予定を8時に通知して').schedule).toBe('0 8 * * *');
  });

  it('multi-day schedule clause is stripped from the agent prompt', () => {
    const d = parseAgentNL('月曜と金曜の朝8時にSTEAM×AIの論文を集めて');
    expect(d.schedule).toBe('0 8 * * 1,5');
    expect(d.prompt).not.toContain('月曜');
    expect(d.prompt).not.toContain('8時');
    expect(d.prompt).toContain('論文');
  });

  it('bare separator run 火・金 (no 曜) → 0 8 * * 2,5', () => {
    const d = parseAgentNL('火・金の朝8時にニュースを集めて');
    expect(d.schedule).toBe('0 8 * * 2,5');
    expect(d.scheduleConfident).toBe(true);
    expect(d.prompt).not.toContain('火');
    expect(d.prompt).toContain('ニュース');
  });

  it('bare run 月、水、金 → 0 9 * * 1,3,5', () => {
    expect(parseAgentNL('月、水、金の9時に集計して').schedule).toBe('0 9 * * 1,3,5');
  });

  it('a LONE bare weekday char is NOT treated as a schedule (金=gold ambiguity)', () => {
    // "金" alone (no 曜, no separator run) must stay ambiguous, not become Friday.
    const d = parseAgentNL('金の価格を8時に教えて');
    expect(d.schedule).not.toBe('0 8 * * 5');
    expect(d.prompt).toContain('金の価格');
  });

  it('element pair 火・水 (fire/water) followed by a NOUN is NOT a schedule', () => {
    // Regression (review): a bare run is only a schedule when it leads directly
    // into the time. 火・水の実験を9時に… is 五行 vocab, not Tue/Wed.
    const d = parseAgentNL('火・水の実験を9時に記録して');
    expect(d.schedule).not.toBe('0 9 * * 2,3');
    expect(d.prompt).toContain('実験');
  });

  it('celestial pair 日・月 (sun/moon) followed by a NOUN is NOT a schedule', () => {
    const d = parseAgentNL('日・月の周期を8時に観測する');
    expect(d.schedule).not.toBe('0 8 * * 0,1');
    expect(d.prompt).toContain('周期');
  });

  it('but 火・水 leading DIRECTLY into the time IS a schedule (Tue/Wed)', () => {
    // Same chars, schedule shape: adjacency to the time is the disambiguator.
    expect(parseAgentNL('火・水の朝8時に在庫を確認して').schedule).toBe('0 8 * * 2,3');
  });

  it('colon time after a bare run schedules AND strips the clause from the prompt', () => {
    const d = parseAgentNL('火・金の8:00にニュースを集めて');
    expect(d.schedule).toBe('0 8 * * 2,5');
    expect(d.prompt).not.toContain('火・金');
    expect(d.prompt).not.toContain('8:00');
    expect(d.prompt).toContain('ニュース');
  });
});

describe('parseAgentNL — daily (EN)', () => {
  it('every day at 8 → 0 8 * * *', () => {
    expect(parseAgentNL('every day at 8 draft a post').schedule).toBe('0 8 * * *');
  });
});

describe('parseAgentNL — "daily-multi" (multiple specific times per day)', () => {
  it('毎日朝8:00と夜21:00に (colon form) → shared-minute multi-hour cron, confident', () => {
    const d = parseAgentNL('毎日朝8:00と夜21:00にニュースをまとめて');
    expect(d.schedule).toBe('0 8,21 * * *');
    expect(d.scheduleConfident).toBe(true);
  });

  it('every day at 8am and 9pm (EN) → shared-minute multi-hour cron, confident', () => {
    const d = parseAgentNL('every day at 8am and 9pm send a summary');
    expect(d.schedule).toBe('0 8,21 * * *');
    expect(d.scheduleConfident).toBe(true);
  });

  it('毎日8時 (plain single time) is unaffected by the new multi-time path', () => {
    expect(parseAgentNL('毎日8時にニュースをまとめて').schedule).toBe('0 8 * * *');
  });

  it('differing minutes between the two times is out of scope → not confident, no silent drop', () => {
    const d = parseAgentNL('毎日8時15分と21時45分にニュースをまとめて');
    expect(d.schedule).toBeNull();
    expect(d.scheduleConfident).toBe(false);
  });

  // Bug-fix regressions (found via pre-push adversarial review, just fixed in
  // derivePrompt): the pre-existing single-時 schedule strip only consumed the
  // FIRST "毎日朝8時" occurrence, leaving a dangling "と夜21時に" / "と夜21:00に"
  // leftover fragment in the prompt sent to the agent. A companion leftover-strip
  // regex now removes it. These pin the fix.
  it('kanji-時 form, two times joined by と: prompt drops BOTH time clauses entirely', () => {
    const d = parseAgentNL('毎日朝8時と夜21時にAをやって');
    expect(d.prompt).toBe('Aをやって');
  });

  it('mixed 時-form + colon-form: prompt drops BOTH time clauses (colon-shaped leftover)', () => {
    const d = parseAgentNL('毎日朝8時と夜21:00にAをやって');
    expect(d.prompt).toBe('Aをやって');
  });

  it('the schedule side of the kanji-時 two-time case was already correct before the prompt fix', () => {
    expect(parseAgentNL('毎日朝8時と夜21時にAをやって').schedule).toBe('0 8,21 * * *');
  });
});

describe('parseAgentNL — cross-model (Codex) review fixes', () => {
  // G-1: "1日1回" family = once per day → daily marker.
  it('1日1回 / 1日に1回 / 一日一回 are recognised as a daily recurrence', () => {
    for (const u of [
      'arxivを1日1回チェックして8時に通知',
      '1日に1回ニュースを8時にまとめて',
      '一日一回8時に集計して',
    ]) {
      expect(parseAgentNL(u).schedule).toBe('0 8 * * *');
    }
  });

  it('1日1回 WITHOUT a time → daily suggestion, not a one-shot', () => {
    const d = parseAgentNL('arxivを1日1回チェックして要点を3行で教えて');
    expect(d.schedule).toBeNull();
    expect(d.scheduleConfident).toBe(false);
    expect(d.suggestedFrequency).toBe('daily');
  });

  // G-1 date-collision guard: "7月1日" / "21日" are DATES, not "once per day".
  it('a date context (7月1日に1回 / 21日に1回) is NOT treated as daily', () => {
    expect(parseAgentNL('7月1日に1回9時に通知して').schedule).not.toBe('0 9 * * *');
    expect(parseAgentNL('21日に1回9時にまとめて').schedule).not.toBe('0 9 * * *');
  });

  // G-1 compound-日 guard (pre-push review): a kanji day-word + "1回" is a ONE-SHOT
  // ("today/tomorrow, once"), NOT a daily recurrence. The required leading "1日"
  // run keeps these out.
  it('compound 日 one-shots (今日に1回 / 明日に1回 / 誕生日に1回) are NOT daily', () => {
    for (const u of ['今日に1回9時にまとめて', '明日に1回9時に通知して', '誕生日に1回9時に祝って']) {
      expect(parseAgentNL(u).schedule).not.toBe('0 9 * * *');
      expect(parseAgentNL(u).scheduleConfident).toBe(false);
    }
  });

  // G-2: a stated recurrence without a time carries a frequency suggestion so the
  // card pre-selects it instead of falling to 'once'/run-now.
  it('毎日 without a time → suggestedFrequency daily (schedule still null)', () => {
    const d = parseAgentNL('毎日ニュースまとめて');
    expect(d.schedule).toBeNull();
    expect(d.scheduleConfident).toBe(false);
    expect(d.suggestedFrequency).toBe('daily');
  });

  it('毎週金曜 without a time → weekly suggestion with the dow', () => {
    const d = parseAgentNL('毎週金曜にまとめて');
    expect(d.suggestedFrequency).toBe('weekly');
    expect(d.suggestedDowList).toBe('5');
  });

  it('月曜と金曜 without a time → weekly suggestion with the multi-dow', () => {
    expect(parseAgentNL('月曜と金曜にまとめて').suggestedDowList).toBe('1,5');
  });

  // EN time: the number bound to "at" wins over an earlier bare number.
  it('EN: "top 10 posts at 8" → 8:00, not 10:00', () => {
    expect(parseAgentNL('every day process top 10 posts at 8').schedule).toBe('0 8 * * *');
  });

  // EN H:MM with meridiem — minute AND am/pm must both survive (pre-push review).
  it('EN: H:MMpm / H:MMam keep both minute and meridiem', () => {
    expect(parseAgentNL('every day at 8:30pm summarize').schedule).toBe('30 20 * * *');
    expect(parseAgentNL('daily 11:45pm digest').schedule).toBe('45 23 * * *');
    expect(parseAgentNL('every day 9:15am report').schedule).toBe('15 9 * * *');
    expect(parseAgentNL('every day 12:30am notify').schedule).toBe('30 0 * * *');
    expect(parseAgentNL('every day 8pm post').schedule).toBe('0 20 * * *');
  });

  it('EN: a bare number with no time marker is NOT a time', () => {
    const d = parseAgentNL('summarize 5 articles every day');
    expect(d.suggestedFrequency).toBe('daily'); // daily intent kept
    expect(d.suggestedTime).toBeUndefined(); // "5" not mistaken for 5:00
  });

  // derivePrompt: a topic BEFORE a mid-sentence schedule clause survives.
  it('strips the schedule clause in place, preserving the leading topic', () => {
    const d = parseAgentNL('GitHub Trendingを毎日8時にまとめて');
    expect(d.schedule).toBe('0 8 * * *');
    expect(d.prompt).toContain('GitHub Trending');
    expect(d.prompt).not.toContain('毎日');
    expect(d.prompt).not.toContain('8時');
  });

  // JP time: 昼N時 is afternoon, but 昼12時 stays noon (guarded by hour < 12).
  it('昼3時 → 15:00, 昼12時 → 12:00', () => {
    expect(parseAgentNL('毎日昼3時に通知して').schedule).toBe('0 15 * * *');
    expect(parseAgentNL('毎日昼12時に通知して').schedule).toBe('0 12 * * *');
  });

  // 2nd-pass Codex review (correct branch): cadences not expressible in the
  // whitelisted weekly cron must NOT be registered as a plain weekly.
  it('隔週/第N週/第N曜/週N回 are forced to manual, not silently registered weekly', () => {
    for (const u of ['隔週月曜9時にまとめて', '第2月曜の9時に集計して', '第3週の月曜9時に通知', '週3回9時にまとめて']) {
      const d = parseAgentNL(u);
      expect(d.scheduleConfident).toBe(false);
      expect(d.schedule).toBeNull();
    }
  });

  // The trailing 日 of 曜日 must not be mis-read as Sunday in the bare-run path.
  it('月曜日と火曜日 / 水・木曜日 → no spurious Sunday (0)', () => {
    expect(parseAgentNL('月曜日と火曜日の9時にまとめて').schedule).toBe('0 9 * * 1,2');
    expect(parseAgentNL('水・木曜日の9時に集計して').schedule).toBe('0 9 * * 3,4');
  });

  // Ordering invariant: the non-expressible-cadence guard must run BEFORE the
  // daily/weekly paths, so a 毎日+第N collision stays manual (not confident daily).
  it('the 隔週/第N guard outranks an explicit daily marker (ordering regression)', () => {
    expect(parseAgentNL('毎日第2週の月曜9時に通知して').scheduleConfident).toBe(false);
    expect(parseAgentNL('毎日第2週の月曜9時に通知して').schedule).toBeNull();
  });

  // Genuine weekday 日 (Sunday) must survive — only the 曜日 trailer is stripped.
  it('日曜日と土曜日 keeps Sunday → 0,6', () => {
    expect(parseAgentNL('日曜日と土曜日の9時にまとめて').schedule).toBe('0 9 * * 0,6');
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

  it('an explicit "ドラフト" mention wins over "通知" used as a NOTIFY-001 trigger-condition word, not a delivery verb', () => {
    // Live on-device bug (2026-07-13): "LINEで通知が来たら…ドラフトを作成して" was
    // misclassified as action=notify because detectAction's notify check matched
    // the bare "通知" substring, even though it describes the notification-trigger
    // CONDITION here, not the delivery action -- the user explicitly asked for a
    // draft. The explicit "ドラフト" signal must take priority.
    const d = parseAgentNL('LINEで通知が来たら「新着メッセージあり」ってドラフトを作成して');
    expect(d.action.type).toBe('draft');
  });

  it('a bare "通知" with no draft/下書き mention still resolves to notify (regression guard for the fix above)', () => {
    expect(parseAgentNL('LINEで通知が来たら教えて').action.type).toBe('notify');
  });

  it('the mirror case also resolves correctly: 下書き as the trigger condition, 通知 as the delivery action', () => {
    // Found during review of the fix above: naively prioritizing draft-keywords
    // over notify-keywords fixes "通知(条件)+ドラフト(動作)" but breaks the mirror
    // "下書き(条件)+通知(動作)" case the same way. Scoping both keyword scans to
    // the clause after "たら" (the delivery clause) resolves both directions.
    expect(parseAgentNL('下書きができたら通知して').action.type).toBe('notify');
    expect(parseAgentNL('下書きを保存したらLINEで知らせて').action.type).toBe('notify');
  });
});

describe('parseAgentNL — X-posting resolves to a real app-act action (Phase 6)', () => {
  // X-posting used to fall back to 'draft' + a caveat (Phase 0) because there was
  // no `app-act` action type to target. Phase 2 added the schema; this parser
  // now targets it for real. LINE-posting still hits the old fallback — see the
  // next describe block — so these two phrasings must NOT be confused.
  it('"Xに投稿して" resolves to app-act x.post with no caveat', () => {
    const d = parseAgentNL('毎日8時にXに投稿して');
    expect(d.action.type).toBe('app-act');
    if (d.action.type === 'app-act') {
      expect(d.action.appActRecipeId).toBe('x.post');
      expect(d.action.appActParams).toEqual({ text: '{{result}}' });
    }
    expect(d.actionCaveat).toBeUndefined();
  });

  it('"post to X" (EN phrasing) also resolves to app-act x.post', () => {
    const d = parseAgentNL('every day at 8 post to X');
    expect(d.action.type).toBe('app-act');
    if (d.action.type === 'app-act') expect(d.action.appActRecipeId).toBe('x.post');
    expect(d.actionCaveat).toBeUndefined();
  });

  it('"tweet this" also resolves to app-act x.post', () => {
    const d = parseAgentNL('毎朝ニュースをまとめてtweet this');
    expect(d.action.type).toBe('app-act');
    if (d.action.type === 'app-act') expect(d.action.appActRecipeId).toBe('x.post');
  });

  it('a たら-conditional scopes app-act detection to the delivery clause, not the condition', () => {
    // "記事が完成したらXに投稿して" — condition = "記事が完成", action = "Xに投稿して".
    // Mirrors detectAction's own たら-scoping (see its comment above) so a
    // trigger-condition clause never falsely fires the X-post detector.
    const d = parseAgentNL('記事が完成したらXに投稿して');
    expect(d.action.type).toBe('app-act');
    if (d.action.type === 'app-act') expect(d.action.appActRecipeId).toBe('x.post');
  });

  it('stays draft (not app-act) when X-posting phrasing is absent', () => {
    const d = parseAgentNL('毎日8時にブログ記事を書いて');
    expect(d.action.type).toBe('draft');
    expect(d.actionCaveat).toBeUndefined();
  });

  it('no caveat when the action resolves to something other than draft', () => {
    const d = parseAgentNL('毎日9時にコマンド実行して結果を保存');
    expect(d.action.type).toBe('cli');
    expect(d.actionCaveat).toBeUndefined();
  });
});

describe('parseAgentNL — LINE-posting caveat (still not supported, unlike X)', () => {
  // LINE-posting deliberately keeps the OLD Phase-0-style fallback: `draft` +
  // a user-facing caveat. Only X graduated to a real app-act action this phase
  // (see the describe block above) — LINE NL detection/dispatch is out of scope
  // here even though a `line.send-message` recipe is scaffolded natively.
  it('"LINEに投稿して" stays draft and sets a user-facing caveat', () => {
    const d = parseAgentNL('毎日8時にLINEに投稿して');
    expect(d.action.type).toBe('draft');
    expect(typeof d.actionCaveat).toBe('string');
    expect(d.actionCaveat!.length).toBeGreaterThan(0);
  });

  it('"send this to LINE" (EN phrasing) also stays draft with a caveat', () => {
    const d = parseAgentNL('every day at 8 send this to LINE');
    expect(d.action.type).toBe('draft');
    expect(d.actionCaveat).toBeTruthy();
  });

  it('a bare "LINEで知らせて" (notify, not post) is unaffected — resolves to notify, no caveat', () => {
    // Regression guard: LINE_POST_RE must not collide with the pre-existing
    // notify-keyword branch ("知らせ") that already handles this phrasing.
    const d = parseAgentNL('毎日8時にLINEで知らせて');
    expect(d.action.type).toBe('notify');
    expect(d.actionCaveat).toBeUndefined();
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

describe('parseAgentNL — G6 pipeline preset', () => {
  it('a "パイプライン" request builds the multi-step collection preset (Mon/Fri, autonomous)', () => {
    const d = parseAgentNL('STEAMのパイプライン');
    expect(d.orchestrationSteps?.length).toBe(4);
    expect(d.charLimit).toBe(280);
    expect(d.autonomous).toBe(true);
    expect(d.schedule).toBe('0 8 * * 1,5');
    expect(d.scheduleConfident).toBe(true);
    expect(d.schedule!).toMatch(WHITELIST_CRON);
  });

  it('carries a custom topic stated before the keyword', () => {
    const d = parseAgentNL('量子コンピュータのパイプライン');
    expect(d.orchestrationSteps?.[0]).toContain('量子コンピュータ');
    expect(d.name).toContain('量子コンピュータ');
  });

  it("the user's own schedule overrides the preset's Mon/Fri, and the topic drops the schedule clause", () => {
    const d = parseAgentNL('毎日8時に量子コンピュータのパイプライン');
    expect(d.schedule).toBe('0 8 * * *');
    expect(d.orchestrationSteps?.length).toBe(4);
    // Topic must be the subject, not "8時に量子コンピュータ".
    expect(d.orchestrationSteps?.[0]).toContain('量子コンピュータ');
    expect(d.orchestrationSteps?.[0]).not.toContain('8時');
  });

  it('an unparseable user schedule falls to manual selection, NOT silently Mon/Fri', () => {
    const d = parseAgentNL('90分ごとにSTEAMのパイプライン');
    expect(d.orchestrationSteps?.length).toBe(4); // still the pipeline
    expect(d.scheduleConfident).toBe(false); // but the schedule needs picking
    expect(d.schedule).toBeNull();
  });

  it('a normal collection utterance (no パイプライン) stays single-step', () => {
    const d = parseAgentNL('STEAMの最新ニュースを集めて');
    expect(d.orchestrationSteps).toBeUndefined();
  });

  it('does NOT hijack the DevOps / design senses of "pipeline" into the collection preset', () => {
    expect(parseAgentNL('CI/CDパイプラインのエラーを直して').orchestrationSteps).toBeUndefined();
    expect(parseAgentNL('build pipeline failed, fix it').orchestrationSteps).toBeUndefined();
    expect(parseAgentNL('デプロイパイプラインのジョブが失敗した').orchestrationSteps).toBeUndefined();
    expect(parseAgentNL('データパイプラインを設計して').orchestrationSteps).toBeUndefined();
    expect(parseAgentNL('design an ML pipeline architecture').orchestrationSteps).toBeUndefined();
  });
});

describe('parseAgentNL — name derivation does not eat 日/月/金 from non-weekday words', () => {
  // Regression: the weekday stripper '[日月火水木金土]曜?日?' matched a BARE
  // 日月火水木金土, so 今日→今, 日本→本, 金融→融 lost a character in the name.
  it('keeps 今日 in the name (does not strip the 日)', () => {
    expect(parseAgentNL('今日の主要ニュースを出典付きで3つ集めて').name).toContain('今日');
  });
  it('keeps 日本 and 金融 intact', () => {
    expect(parseAgentNL('日本の金融ニュースをまとめて').name).toContain('日本');
    expect(parseAgentNL('日本の金融ニュースをまとめて').name).toContain('金融');
  });
  it('still strips a real weekday token from the name', () => {
    // 月曜日 / 月曜 are schedule words and should NOT survive in the display name.
    expect(parseAgentNL('毎週月曜日に週報を作って').name).not.toContain('月曜');
  });
});

describe('parseAgentNL — autonomous intent (explicit unattended-execution phrasing)', () => {
  // On-device finding 2026-07-15: a hand-authored multi-step app-act draft
  // (Perplexity->local-LLM->Obsidian->X, correctly tool-pinned and
  // scheduled) was silently registered non-autonomous because there was
  // NO way to set draft.autonomous=true outside the G6 "パイプライン"
  // preset (a fixed-shape exception) -- AgentChatConfirm (used for
  // app-act/tool-pinned drafts) has no toggle UI, so app-act's Tier-B
  // trust gate could never unlock for a free-form instruction.
  it('is false by default for an ordinary instruction with no autonomy phrasing', () => {
    expect(parseAgentNL('毎日8時にXの下書きを作って').autonomous).toBe(false);
  });

  it('JP: 自律で → autonomous', () => {
    expect(parseAgentNL('毎週月曜と金曜の9時に自律でXに投稿して').autonomous).toBe(true);
  });

  it('JP: 完全無人で → autonomous', () => {
    expect(parseAgentNL('毎日8時に完全無人でニュースをまとめてXに投稿して').autonomous).toBe(true);
  });

  it('JP: 確認なしで → autonomous', () => {
    expect(parseAgentNL('毎日8時に確認なしでXに投稿して').autonomous).toBe(true);
  });

  it('EN: autonomously → autonomous', () => {
    expect(parseAgentNL('every day at 8am, autonomously post a summary to X').autonomous).toBe(true);
  });

  it('EN: without approval → autonomous', () => {
    expect(parseAgentNL('every day at 8am, post to X without approval').autonomous).toBe(true);
  });

  it('does not false-positive on an unrelated use of 確認 ("...を確認して" as a normal instruction verb)', () => {
    expect(parseAgentNL('毎日8時にニュースを確認して通知して').autonomous).toBe(false);
  });

  it('the G6 "パイプライン" preset stays hardcoded autonomous regardless of phrasing (unchanged behavior)', () => {
    expect(parseAgentNL('STEAM×AIのパイプラインを作って').autonomous).toBe(true);
  });

  // Negation blind spot (same bug class independently found and fixed in
  // the older detectAutonomousExecutionIntent by f13f56160, 2026-07-11 —
  // that fix never got ported to this newer detector added 2026-07-15,
  // found again during a dead-branch porting-gap audit the same night).
  // A sentence wrapping an AUTONOMOUS_INTENT_RE-matching substring in an
  // outer negation must never resolve to true — the unsafe direction.
  it('EN: "don\'t send it without my approval" is NOT misread as autonomous=true', () => {
    expect(parseAgentNL("every day at 8am post to X, don't send it without my approval").autonomous).toBe(false);
  });

  it('JP: "承認なしでは送信しないでください" is NOT misread as autonomous=true', () => {
    expect(parseAgentNL('毎日8時にコマンド実行して、承認なしでは送信しないでください').autonomous).toBe(false);
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

  it('strips memory markers from the derived display name (G2 P3)', () => {
    // JP: the trigger phrase is not the topic.
    const jp = parseAgentNL('私は簡潔な要約が好みだと覚えておいて');
    expect(jp.name).not.toContain('覚えて');
    expect(jp.name).toContain('簡潔な要約');
    // EN: "remember that" is the trigger, the fact is the name.
    const en = parseAgentNL('remember that I prefer concise summaries');
    expect(en.name.toLowerCase()).not.toContain('remember');
    expect(en.name.toLowerCase()).toContain('concise');
  });
});

describe('parseAgentNL — Phase 6 target scenario: tool-pinned て-form chain → app-act', () => {
  // The literal Japanese utterance from the Phase 6 brief: a weekly schedule +
  // a plain て-form conjunctive chain naming Perplexity then the local LLM, that
  // ends in an X-post. No explicit sequence marker (まず/次に/…) appears anywhere,
  // so this MUST come from detectToolPinnedSteps, not parseStepsFromText.
  const JP_UTTERANCE =
    '毎週月曜9時に、パープレでSTEAM教育×AIの最新論文を集めて、ローカルLLMで日本語要約と自分の見解とリンクを付けて、Xに自動投稿して';

  it('produces a confident weekly Monday 9:00 schedule', () => {
    const d = parseAgentNL(JP_UTTERANCE);
    expect(d.scheduleConfident).toBe(true);
    expect(d.schedule).toBe('0 9 * * 1');
  });

  it('produces >= 2 orchestration steps with the correct per-step tool pins', () => {
    const d = parseAgentNL(JP_UTTERANCE);
    expect(d.orchestrationSteps).toBeDefined();
    expect(d.orchestrationSteps!.length).toBeGreaterThanOrEqual(2);

    const steps = d.orchestrationSteps!;
    const first = steps[0];
    const second = steps[1];
    expect(typeof first).not.toBe('string');
    expect(typeof second).not.toBe('string');
    if (typeof first !== 'string') {
      expect(first.tool).toEqual({ type: 'perplexity', model: 'sonar-deep-research' });
      expect(first.instruction).toContain('パープレ');
    }
    if (typeof second !== 'string') {
      expect(second.tool).toEqual({ type: 'local' });
      expect(second.instruction).toContain('ローカルLLM');
    }
  });

  it('resolves action to a real app-act x.post (not draft + caveat)', () => {
    const d = parseAgentNL(JP_UTTERANCE);
    expect(d.action.type).toBe('app-act');
    if (d.action.type === 'app-act') {
      expect(d.action.appActRecipeId).toBe('x.post');
      expect(d.action.appActParams).toEqual({ text: '{{result}}' });
    }
    expect(d.actionCaveat).toBeUndefined();
  });

  // English paraphrase of the same scenario (kept schedule-free — derivePrompt's
  // EN weekday-clause stripping only handles a LEADING "on Monday at 9" shape,
  // not "Every Monday at 9,"; that pre-existing limitation is orthogonal to what
  // this phase is testing, so the schedule clause is left out of this variant to
  // isolate the orchestration + action assertions).
  const EN_UTTERANCE =
    'Collect the latest STEAM x AI papers with Perplexity, summarize them in Japanese with the local LLM and add my take with links, then post to X automatically.';

  it('EN paraphrase: produces the same tool-pinned steps and app-act action', () => {
    const d = parseAgentNL(EN_UTTERANCE);
    expect(d.orchestrationSteps).toBeDefined();
    expect(d.orchestrationSteps!.length).toBeGreaterThanOrEqual(2);
    const [first, second] = d.orchestrationSteps!;
    if (typeof first !== 'string') expect(first.tool).toEqual({ type: 'perplexity', model: 'sonar-deep-research' });
    if (typeof second !== 'string') expect(second.tool).toEqual({ type: 'local' });

    expect(d.action.type).toBe('app-act');
    if (d.action.type === 'app-act') expect(d.action.appActRecipeId).toBe('x.post');
  });

  it('REGRESSION: ordinary て、-containing prose with no tool mention stays single-step', () => {
    // Same clause-boundary shape (て-form + 、) as the target scenario, but no
    // tool name anywhere — must NOT spuriously produce pinned steps. This is
    // the guard for "don't widen the generic splitter" from the Phase 6 brief.
    const d = parseAgentNL('毎朝8時にニュースを集めて、要約して、保存して');
    expect(d.orchestrationSteps).toBeUndefined();
  });

  it('REGRESSION: a plain single-tool mention with no clause chain stays single-step', () => {
    const d = parseAgentNL('パープレで論文を集めて');
    expect(d.orchestrationSteps).toBeUndefined();
  });
});
