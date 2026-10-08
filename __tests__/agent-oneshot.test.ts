/**
 * One-shot ("run once at a future time") agent schedules — parser table
 * (EN + JA), confirm-time resolution with a fake clock, lifecycle / arm
 * planning, boot re-arm reference + native parity, and i18n labels.
 * See lib/agent-oneshot.ts for the sentinel design.
 */
const mockScheduleAgent = jest.fn(async () => undefined);
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { scheduleAgent: (...args: unknown[]) => (mockScheduleAgent as any)(...args), cancelAgent: jest.fn() },
}));

import * as fs from 'fs';
import * as path from 'path';
import { parseAgentNL, parseSchedule } from '@/lib/agent-nl-parser';
import {
  ONE_SHOT_CATCHUP_DELAY_MS,
  ONE_SHOT_GRACE_MS,
  encodeOnceOneShot,
  formatOneShotLabel,
  oneShotState,
  parseOneShotSchedule,
  planOneShotArm,
  reconcileOneShotAgent,
  resolveOneShotAt,
  resolveOneShotSchedule,
} from '@/lib/agent-oneshot';
import { installSchedule, isScheduleMissed, lastTriggerMs, nextTriggerMs, cronToIntervalMs } from '@/lib/agent-scheduler';
import { planBootOneShot, planBootRearm } from '@/lib/boot-autostart/plan';
import {
  hasDraftAssumptions,
  humanizeAgentSchedule,
  humanizeCronSchedule,
  summarizeAgentDraftAsText,
} from '@/lib/agent-plan-summary';
import { applyDraftPatch } from '@/lib/agent-draft-patch';
import { decodeCron, buildCron } from '@/lib/agent-card-cron';
import type { Agent } from '@/store/types';

// Wed 2026-10-07 12:00:00 local time — every expectation below is built from
// LOCAL date fields, so the suite is timezone-independent.
const NOW = new Date(2026, 9, 7, 12, 0, 0, 0).getTime();
const at = (h: number, m: number, dayOffset = 0) => new Date(2026, 9, 7 + dayOffset, h, m, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  mockScheduleAgent.mockClear();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('parser — relative one-shot (EN + JA)', () => {
  const cases: Array<[string, number]> = [
    ['in 5 minutes', 5 * MIN],
    ['in 5 min', 5 * MIN],
    ['in 5m', 5 * MIN],
    ['in 2 hours', 2 * HOUR],
    ['in an hour', HOUR],
    ['in half an hour', 30 * MIN],
    ['in a couple of hours', 2 * HOUR],
    ['in 1.5 hours', 90 * MIN],
    ['in 2 hours and a half', 150 * MIN],
    ['after 10 minutes', 10 * MIN],
    ['10 minutes from now', 10 * MIN],
    ['in 30 seconds', 30_000],
    ['5分後', 5 * MIN],
    ['5分後に', 5 * MIN],
    ['５分後に', 5 * MIN],
    ['十五分後に', 15 * MIN],
    ['1時間後', HOUR],
    ['1時間半後に', 90 * MIN],
    ['2時間30分後に', 150 * MIN],
    ['30分後に一回', 30 * MIN],
    ['あと10分で', 10 * MIN],
    ['今から3分後に', 3 * MIN],
  ];
  it.each(cases)('%s → @in %i', (utterance, ms) => {
    const r = parseSchedule(utterance);
    expect(r.confident).toBe(true);
    expect(r.schedule).toBe(`@in ${ms}`);
    expect(r.oneShotImplicit).toBeUndefined();
  });

  it('"in a second" (idiom) and unbounded delays are not one-shots', () => {
    expect(parseSchedule('summarize this in a second').schedule).toBeNull();
    expect(parseSchedule('in 90 days').schedule).toBeNull();
  });
});

describe('parser — absolute one-shot (EN + JA)', () => {
  const cases: Array<[string, string, boolean]> = [
    // [utterance, sentinel, implicit (bare time, no marker / day word)]
    ['at 14:55', '@at 14:55', true],
    ['at 2:55pm', '@at 14:55', true],
    ['at 2:55 pm today', '@at 14:55', false],
    ['today at 14:55', '@at 14:55', false],
    ['tomorrow at 8', '@at 8:00 +1', false],
    ['tomorrow morning at 8am', '@at 8:00 +1', false],
    ['tonight at 9', '@at 21:00', false],
    ['the day after tomorrow at 7am', '@at 7:00 +2', false],
    ['just once at 9pm', '@at 21:00', false],
    ['one time only, at 6:30', '@at 6:30', false],
    ['今日の14時55分', '@at 14:55', false],
    ['14:55に', '@at 14:55', true],
    ['午後2時55分に', '@at 14:55', true],
    ['明日の朝8時', '@at 8:00 +1', false],
    ['明日8時に', '@at 8:00 +1', false],
    ['明後日の9時に', '@at 9:00 +2', false],
    ['今夜9時に', '@at 21:00', false],
    ['一回だけ14時に', '@at 14:00', false],
    ['1回だけ明日9時に', '@at 9:00 +1', false],
    ['今回だけ15時に', '@at 15:00', false],
  ];
  it.each(cases)('%s → %s', (utterance, sentinel, implicit) => {
    const r = parseSchedule(utterance);
    expect(r.confident).toBe(true);
    expect(r.schedule).toBe(sentinel);
    expect(!!r.oneShotImplicit).toBe(implicit);
  });
});

describe('parser — recurring stays recurring (one-shot never steals a cadence)', () => {
  const cases: Array<[string, string | null]> = [
    ['every day at 14:55', '55 14 * * *'],
    ['daily at 8am', '0 8 * * *'],
    ['毎日14時55分', '55 14 * * *'],
    ['毎朝8時にニュースまとめて', '0 8 * * *'],
    ['every 5 minutes', '*/5 * * * *'],
    ['30分に1回', '*/30 * * * *'],
    ['15分ごと', '*/15 * * * *'],
    ['on Monday at 9', '0 9 * * 1'],
    ['火・金の朝8時にまとめて', '0 8 * * 2,5'],
    ['1日1回9時に', '0 9 * * *'],
  ];
  it.each(cases)('%s → %s', (utterance, cron) => {
    expect(parseSchedule(utterance).schedule).toBe(cron);
  });

  it('"明日から8時に" is a START anchor for a recurrence, never a one-shot', () => {
    const r = parseSchedule('明日から8時に');
    expect(r.schedule).toBeNull();
    expect(r.confident).toBe(false);
  });

  it('a once marker with no time stays fail-closed (asks when)', () => {
    const d = parseAgentNL('一回だけニュースをまとめて');
    expect(d.schedule).toBeNull();
    expect(d.scheduleConfident).toBe(false);
  });
});

describe('parseAgentNL — prompt/name strip + demo utterance', () => {
  it('demo: one-shot "in 5 minutes" + 3 explicit steps', () => {
    const d = parseAgentNL(
      'In 5 minutes, first search the web with Perplexity for the top 3 on-device AI news stories. Then summarize them with the local LLM. Finally, write a markdown briefing.',
    );
    expect(d.schedule).toBe(`@in ${5 * MIN}`);
    expect(d.scheduleConfident).toBe(true);
    expect(d.orchestrationSteps).toHaveLength(3);
    const steps = d.orchestrationSteps!.map((s) => (typeof s === 'string' ? s : s.instruction));
    expect(steps[0]).toMatch(/^search the web with Perplexity/);
    expect(steps[1]).toMatch(/summarize them with the local LLM/);
    expect(steps[2]).toMatch(/write a markdown briefing/);
    expect(d.prompt.startsWith('first search')).toBe(true);
    expect(d.name).not.toMatch(/5 minutes/i);
  });

  it('JA: timing phrases are removed from the prompt', () => {
    expect(parseAgentNL('5分後にバッテリー残量を通知して').prompt).toBe('バッテリー残量を通知して');
    expect(parseAgentNL('今日の14時55分にニュースをまとめて').prompt).toBe('ニュースをまとめて');
    expect(parseAgentNL('Summarize the news at 2:55 pm today.').prompt).toBe('Summarize the news.');
  });
});

describe('resolution at confirm time (fake clock)', () => {
  it('relative delays count from the resolve instant, not the parse instant', () => {
    const draft = parseSchedule('in 5 minutes').schedule!;
    jest.setSystemTime(NOW + 3 * MIN); // user takes 3 minutes to confirm
    expect(resolveOneShotSchedule(draft, Date.now())).toBe(encodeOnceOneShot(NOW + 8 * MIN));
  });

  it('@at today when still ahead; already past → tomorrow (rolled)', () => {
    expect(resolveOneShotAt('@at 14:55', NOW)).toEqual({ at: at(14, 55), rolledToTomorrow: false });
    expect(resolveOneShotAt('@at 9:30', NOW)).toEqual({ at: at(9, 30, 1), rolledToTomorrow: true });
    expect(resolveOneShotAt('@at 12:00', NOW)).toEqual({ at: at(12, 0, 1), rolledToTomorrow: true });
    expect(resolveOneShotAt('@at 8:00 +1', NOW)).toEqual({ at: at(8, 0, 1), rolledToTomorrow: false });
    expect(resolveOneShotAt('@at 7:00 +2', NOW)).toEqual({ at: at(7, 0, 2), rolledToTomorrow: false });
  });

  it('day arithmetic stays on local wall-clock hours (DST-safe, no fixed 24h)', () => {
    const resolved = resolveOneShotAt('@at 9:30', NOW)!;
    const d = new Date(resolved.at);
    expect([d.getHours(), d.getMinutes(), d.getDate()]).toEqual([9, 30, 8]);
  });

  it('passes every non-draft value through untouched', () => {
    expect(resolveOneShotSchedule('0 9 * * *', NOW)).toBe('0 9 * * *');
    expect(resolveOneShotSchedule('once', NOW)).toBe('once');
    expect(resolveOneShotSchedule(null, NOW)).toBeNull();
    expect(resolveOneShotSchedule('@once 123', NOW)).toBe('@once 123');
  });

  it('sentinels are never valid cron (cron-only consumers fail safe)', () => {
    for (const s of ['@in 300000', '@at 14:55', '@once 1']) {
      expect(cronToIntervalMs(s)).toBeNull();
      expect(parseOneShotSchedule(s)).not.toBeNull();
    }
  });
});

function oneShotAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-oneshot',
    name: 'Briefing',
    description: '',
    prompt: 'brief me',
    schedule: encodeOnceOneShot(NOW + 5 * MIN),
    tool: { type: 'local' },
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: NOW,
    version: 1,
    ...overrides,
  };
}

describe('lifecycle — fires once, then retired, never re-armed', () => {
  it('future → arm exactly at its instant (interval 0, sentinel as cron extra)', async () => {
    const agent = oneShotAgent();
    expect(planOneShotArm(agent, NOW)).toEqual({ action: 'arm', triggerAt: NOW + 5 * MIN, catchUp: false });
    await installSchedule(agent, NOW);
    expect(mockScheduleAgent).toHaveBeenCalledWith(agent.id, 0, NOW + 5 * MIN, agent.schedule);
    expect(nextTriggerMs(agent.schedule!)).toBe(NOW + 5 * MIN);
  });

  it('after its fire (run log at/after the instant) → done, not re-armed', async () => {
    const fired = oneShotAgent({ lastRun: NOW + 5 * MIN + 2000 });
    jest.setSystemTime(NOW + 6 * MIN);
    expect(oneShotState(fired, Date.now())).toBe('done');
    expect(planOneShotArm(fired, Date.now())).toEqual({ action: 'done' });
    expect(reconcileOneShotAgent(fired, Date.now())).toEqual({
      enabled: false,
      oneShotStatus: 'done',
      oneShotResolvedAt: Date.now(),
    });
    await installSchedule(fired, Date.now());
    expect(mockScheduleAgent).not.toHaveBeenCalled();
  });

  it('a persisted terminal status is never re-armed (even if re-enabled)', async () => {
    await installSchedule(oneShotAgent({ oneShotStatus: 'done' }), NOW);
    await installSchedule(oneShotAgent({ oneShotStatus: 'missed', enabled: true }), NOW);
    expect(mockScheduleAgent).not.toHaveBeenCalled();
    expect(reconcileOneShotAgent(oneShotAgent({ oneShotStatus: 'done', enabled: false }), NOW)).toBeNull();
  });

  it('late but within the grace window → catch-up fire a few seconds out', async () => {
    const agent = oneShotAgent({ schedule: encodeOnceOneShot(NOW - 4 * MIN) });
    expect(planOneShotArm(agent, NOW)).toEqual({ action: 'arm', triggerAt: NOW + ONE_SHOT_CATCHUP_DELAY_MS, catchUp: true });
    await installSchedule(agent, NOW);
    expect(mockScheduleAgent).toHaveBeenCalledWith(agent.id, 0, NOW + ONE_SHOT_CATCHUP_DELAY_MS, agent.schedule);
  });

  it('past the grace window with no run → missed, never fired late', async () => {
    const due = NOW - ONE_SHOT_GRACE_MS - MIN;
    const agent = oneShotAgent({ schedule: encodeOnceOneShot(due) });
    expect(planOneShotArm(agent, NOW)).toEqual({ action: 'missed', at: due });
    expect(oneShotState(agent, NOW)).toBe('missed');
    expect(reconcileOneShotAgent(agent, NOW)?.oneShotStatus).toBe('missed');
    expect(isScheduleMissed(agent.schedule!, null, agent.createdAt, NOW)).toEqual({ missed: true, expectedAt: due });
    await installSchedule(agent, NOW);
    expect(mockScheduleAgent).not.toHaveBeenCalled();
  });

  it('missed detection ignores createdAt (a 5-minute one-shot is created just before its fire)', () => {
    const due = NOW - ONE_SHOT_GRACE_MS - MIN;
    expect(isScheduleMissed(encodeOnceOneShot(due), null, due - 5 * MIN, NOW).missed).toBe(true);
    expect(isScheduleMissed(encodeOnceOneShot(due), due + 1000, due - 5 * MIN, NOW).missed).toBe(false);
    expect(isScheduleMissed(encodeOnceOneShot(NOW + MIN), null, NOW, NOW).missed).toBe(false);
  });

  it('lastTriggerMs: the instant once passed, nothing before', () => {
    expect(lastTriggerMs(encodeOnceOneShot(NOW + MIN))).toBeNull();
    expect(lastTriggerMs(encodeOnceOneShot(NOW - MIN))).toBe(NOW - MIN);
    expect(lastTriggerMs('@in 300000')).toBeNull();
  });
});

describe('boot re-arm (reference planner) + native parity', () => {
  it('future → re-arm; within grace → catch-up; older → missed (not in the plan)', () => {
    expect(planBootOneShot(encodeOnceOneShot(NOW + HOUR), NOW)).toEqual({ action: 'arm', triggerAt: NOW + HOUR });
    expect(planBootOneShot(encodeOnceOneShot(NOW - 9 * MIN), NOW)).toEqual({
      action: 'catch-up',
      triggerAt: NOW + ONE_SHOT_CATCHUP_DELAY_MS,
    });
    expect(planBootOneShot(encodeOnceOneShot(NOW - 11 * MIN), NOW)).toEqual({ action: 'missed' });
    expect(planBootOneShot('0 9 * * *', NOW)).toBeNull();

    const plan = planBootRearm(
      [
        { agentId: 'future', cron: encodeOnceOneShot(NOW + HOUR), intervalMs: 0 },
        { agentId: 'late', cron: encodeOnceOneShot(NOW - 2 * MIN), intervalMs: 0 },
        { agentId: 'stale', cron: encodeOnceOneShot(NOW - 2 * HOUR), intervalMs: 0 },
      ],
      NOW,
    );
    expect(plan.map((p) => [p.agentId, p.triggerAt, p.intervalMs])).toEqual([
      ['future', NOW + HOUR, 0],
      ['late', NOW + ONE_SHOT_CATCHUP_DELAY_MS, 0],
    ]);
  });

  const root = path.resolve(__dirname, '..');
  const kt = (f: string) =>
    fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator', f), 'utf8');

  it('AgentAlarmScheduler mirrors the sentinel + grace/catch-up constants and retires missed one-shots', () => {
    const scheduler = kt('AgentAlarmScheduler.kt');
    expect(scheduler).toContain('private const val ONE_SHOT_PREFIX = "@once "');
    expect(scheduler).toContain('const val ONE_SHOT_GRACE_MS = 10 * 60 * 1000L');
    expect(scheduler).toContain('const val ONE_SHOT_CATCHUP_DELAY_MS = 5 * 1000L');
    expect(ONE_SHOT_GRACE_MS).toBe(10 * 60 * 1000);
    expect(ONE_SHOT_CATCHUP_DELAY_MS).toBe(5 * 1000);
    expect(scheduler).toContain('completeOneShot(context, agentId, ONE_SHOT_STATUS_MISSED)');
    expect(scheduler).toContain('json.put("oneShotStatus", status)');
    expect(scheduler).toContain('json.put("enabled", false)');
  });

  it('TerminalSessionService retires a fired one-shot BEFORE (instead of) the cron re-arm path', () => {
    const service = kt('TerminalSessionService.kt');
    const oneShotIdx = service.indexOf('if (AgentAlarmScheduler.isOneShotCron(cron))');
    const rearmIdx = service.indexOf('} else if (intervalMs > 0 || !cron.isNullOrBlank())');
    expect(oneShotIdx).toBeGreaterThan(-1);
    expect(rearmIdx).toBeGreaterThan(oneShotIdx);
    expect(service).toContain('AgentAlarmScheduler.completeOneShot(applicationContext, agentId, AgentAlarmScheduler.ONE_SHOT_STATUS_DONE)');
  });
});

describe('labels — i18n-correct for one-shot and recurring', () => {
  it('one-shot countdown labels (EN / JA)', () => {
    expect(formatOneShotLabel('@in 300000', 'en', NOW)).toBe('Once · today 12:05 (in 5 min)');
    expect(formatOneShotLabel('@in 300000', 'ja', NOW)).toBe('1回 · 今日 12:05（5分後）');
    expect(formatOneShotLabel('@at 14:55', 'en', NOW)).toBe('Once · today 14:55 (in 2 h 55 min)');
    expect(formatOneShotLabel('@at 8:00 +1', 'ja', NOW)).toBe('1回 · 明日 08:00（20時間後）');
    expect(formatOneShotLabel('@at 7:00 +2', 'en', NOW)).toBe('Once · 2026-10-09 07:00 (in 43 h)');
  });

  it('terminal-state labels', () => {
    const done = oneShotAgent({ oneShotStatus: 'done', enabled: false, schedule: encodeOnceOneShot(at(11, 0)) });
    expect(humanizeAgentSchedule(done, 'en', NOW)).toBe('Done · ran once (today 11:00)');
    expect(humanizeAgentSchedule(done, 'ja', NOW)).toBe('完了 · 1回実行済み（今日 11:00）');
    const missed = oneShotAgent({ schedule: encodeOnceOneShot(at(9, 0)) });
    expect(humanizeAgentSchedule(missed, 'en', NOW)).toBe('Missed · was due today 09:00');
    expect(humanizeAgentSchedule(oneShotAgent(), 'en', NOW)).toBe('Once · today 12:05 (in 5 min)');
  });

  it('recurring labels are localized (no Japanese in the EN UI)', () => {
    expect(humanizeCronSchedule('55 14 * * *', 'en')).toBe('daily at 14:55');
    expect(humanizeCronSchedule('55 14 * * *', 'ja')).toBe('毎日14:55');
    expect(humanizeCronSchedule('0 8 * * 1', 'en')).toBe('every Mon at 08:00');
    expect(humanizeCronSchedule('0 8 * * 1,5', 'en')).toBe('every Mon, Fri at 08:00');
    expect(humanizeCronSchedule('0 8 * * 1,5', 'ja')).toBe('毎週月・金曜08:00');
  });

  it('the card codec treats a one-shot as its own frequency and keeps the sentinel', () => {
    expect(decodeCron('@in 300000').frequency).toBe('oneshot');
    expect(buildCron('oneshot', 0, 0, 0, 0, '')).toBeNull();
  });
});

describe('NL confirmation summary', () => {
  it('relative one-shot: absolute time + countdown, and the countdown-starts-at-confirm note', () => {
    const d = parseAgentNL('In 5 minutes, write a markdown briefing about on-device AI.');
    const text = summarizeAgentDraftAsText(d);
    expect(text).toContain('Schedule: Once · today 12:05 (in 5 min)');
    expect(text).toContain('The countdown starts when you confirm.');
    expect(hasDraftAssumptions(d)).toBe(false);
  });

  it('bare past time → tomorrow, declared; implicit one-shot needs a human confirm', () => {
    const d = parseAgentNL('9時にメールをチェックして');
    const text = summarizeAgentDraftAsText(d);
    expect(text).toContain('実行タイミング: 1回 · 明日 09:00（21時間後）');
    expect(text).toContain('今日の09:00は過ぎているため、明日実行します。');
    expect(text).toContain('1回だけの実行として解釈しました');
    expect(hasDraftAssumptions(d)).toBe(true);
  });

  it('explicit "every day" stays recurring and EN-labelled', () => {
    const d = parseAgentNL('every day at 14:55 summarize the news');
    expect(summarizeAgentDraftAsText(d)).toContain('Schedule: daily at 14:55');
  });
});

describe('draft patch — "actually make it in 10 minutes"', () => {
  const base = () =>
    parseAgentNL('In 5 minutes, first search the web with Perplexity for the top 3 on-device AI news stories. Then summarize them with the local LLM. Finally, write a markdown briefing.');

  it('EN relative correction replaces the one-shot delay', () => {
    const r = applyDraftPatch(base(), 'actually make it in 10 minutes');
    expect(r?.changedFields).toContain('schedule');
    expect(r?.patchedDraft.schedule).toBe(`@in ${10 * MIN}`);
    expect(r?.patchedDraft.orchestrationSteps).toHaveLength(3);
  });

  it('JA relative correction', () => {
    expect(applyDraftPatch(base(), 'やっぱり10分後にして')?.patchedDraft.schedule).toBe(`@in ${10 * MIN}`);
  });

  it('a bare time keeps the one-shot day ("tomorrow at 8" → "make it 9am")', () => {
    const d = parseAgentNL('tomorrow at 8 send me a briefing');
    expect(applyDraftPatch(d, 'make it 9am')?.patchedDraft.schedule).toBe('@at 9:00 +1');
  });

  it('a bare time on a RECURRING draft still changes the recurrence time (not a one-shot)', () => {
    const d = parseAgentNL('毎日8時に株価をまとめて');
    expect(applyDraftPatch(d, '9時にして')?.patchedDraft.schedule).toBe('0 9 * * *');
  });

  it('a one-shot correction can turn a recurring draft into a one-shot', () => {
    const d = parseAgentNL('毎日8時に株価をまとめて');
    expect(applyDraftPatch(d, '5分後にして')?.patchedDraft.schedule).toBe(`@in ${5 * MIN}`);
  });
});
