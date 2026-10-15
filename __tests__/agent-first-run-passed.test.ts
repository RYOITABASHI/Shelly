/**
 * Follow-up item 7 (2026-10-15, on-device): a draft for 16:20 confirmed at
 * 16:21 silently started tomorrow. The confirm result now says so.
 */
import * as fs from 'fs';
import * as path from 'path';
import { firstRunPassedNote, missedFirstRunAtConfirm } from '@/lib/agent-plan-summary';

const at = (h: number, m: number, dayOffset = 0) => new Date(2026, 9, 15 + dayOffset, h, m, 0, 0).getTime();

describe('missedFirstRunAtConfirm', () => {
  it('daily 16:20: presented 16:15, confirmed 16:21 → missed today, next tomorrow 16:20', () => {
    const r = missedFirstRunAtConfirm('20 16 * * *', at(16, 15), at(16, 21));
    expect(r).not.toBeNull();
    expect(r!.missedAt.getTime()).toBe(at(16, 20));
    expect(r!.nextAt.getTime()).toBe(at(16, 20, 1));
  });

  it('confirmed before the time → nothing to report', () => {
    expect(missedFirstRunAtConfirm('20 16 * * *', at(16, 15), at(16, 19))).toBeNull();
  });

  it('presented after today\'s time already (first occurrence is tomorrow anyway) → nothing to report', () => {
    expect(missedFirstRunAtConfirm('20 16 * * *', at(16, 30), at(16, 35))).toBeNull();
  });

  it('one-shot / null / stale drafts are ignored', () => {
    expect(missedFirstRunAtConfirm(null, at(16, 15), at(16, 21))).toBeNull();
    expect(missedFirstRunAtConfirm('20 16 * * *', at(16, 15, -2), at(16, 21))).toBeNull();
  });

  it('localized note (en / ja) names the passed time, the real first run and how to run once now', () => {
    const en = firstRunPassedNote('20 16 * * *', at(16, 15), at(16, 21), 'en');
    expect(en).toContain('16:20');
    expect(en).toContain('2026-10-16 16:20');
    expect(en).toContain('"now"');
    const ja = firstRunPassedNote('20 16 * * *', at(16, 15), at(16, 21), 'ja');
    expect(ja).toContain('16:20 はすでに過ぎている');
    expect(ja).toContain('今すぐ実行して');
    expect(firstRunPassedNote('20 16 * * *', at(16, 15), at(16, 19), 'en')).toBe('');
  });

  it('is wired into the chat confirm result and the CLI ctl result', () => {
    const root = path.resolve(__dirname, '..');
    const hook = fs.readFileSync(path.join(root, 'hooks/use-ai-pane-dispatch.ts'), 'utf8');
    expect(hook).toContain('firstRunPassedNote(created.schedule, originatingMessage.timestamp, Date.now(), noticeLocale, created.startNotBefore)');
    expect(hook).toContain('content: registeredContentWithTiming,');
    const flow = fs.readFileSync(path.join(root, 'lib/agent-add-flow.ts'), 'utf8');
    expect(flow).toContain("firstRunPassedNote(created.schedule, msg.timestamp, Date.now(), 'en', created.startNotBefore)");
  });
});
