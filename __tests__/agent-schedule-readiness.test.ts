import { shouldShowScheduleReadinessNudge } from '@/lib/agent-schedule-readiness';

describe('shouldShowScheduleReadinessNudge', () => {
  it('shows the nudge for a real cron schedule the device has not seen it for', () => {
    expect(shouldShowScheduleReadinessNudge('0 8 * * *', false)).toBe(true);
  });

  it('does not re-show the nudge once the device has already seen it', () => {
    expect(shouldShowScheduleReadinessNudge('0 8 * * *', true)).toBe(false);
  });

  it('does not show the nudge for a null schedule (one-shot / notification-trigger-only agents never touch AlarmManager)', () => {
    expect(shouldShowScheduleReadinessNudge(null, false)).toBe(false);
  });

  it('does not show the nudge for an undefined schedule', () => {
    expect(shouldShowScheduleReadinessNudge(undefined, false)).toBe(false);
  });

  it('does not show the nudge for an empty-string schedule', () => {
    expect(shouldShowScheduleReadinessNudge('', false)).toBe(false);
  });

  it('stays suppressed even for a fresh cron once the device flag is set', () => {
    expect(shouldShowScheduleReadinessNudge('*/15 * * * *', true)).toBe(false);
  });
});
