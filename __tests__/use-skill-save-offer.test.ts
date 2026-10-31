// hooks/use-skill-save-offer.ts pulls in react-native (Alert) and lib/i18n
// (which in turn pulls in expo-localization / AsyncStorage) purely for the
// React-hook half of the module. This project has no React hook test harness
// (no @testing-library/react-hooks, no react-test-renderer — see jest.config.cjs:
// testEnvironment 'node', testMatch only *.test.ts), so we don't render the hook
// itself. Instead we exercise the pure, side-effect-free gate it delegates to
// (shouldOfferSkillSave), which is what actually encodes the "never re-offer /
// only offer on success" invariants this task must not regress.
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  setNotificationCategoryAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
}));
jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-file-system/legacy', () => ({}));

import {
  saveSkillWithoutConfirmation,
  shouldOfferSkillSave,
  skillSaveMode,
} from '@/hooks/use-skill-save-offer';

describe('shouldOfferSkillSave', () => {
  it('offers when the run succeeded and no skill is already bound', () => {
    expect(shouldOfferSkillSave({ status: 'success' })).toBe(true);
  });

  it('does not offer for a non-success status', () => {
    expect(shouldOfferSkillSave({ status: 'error' })).toBe(false);
    expect(shouldOfferSkillSave({ status: 'skipped' })).toBe(false);
    expect(shouldOfferSkillSave({ status: 'unavailable' })).toBe(false);
    expect(shouldOfferSkillSave({ status: undefined })).toBe(false);
  });

  it('does not re-offer when the agent already reuses a skill, even on success', () => {
    expect(shouldOfferSkillSave({ status: 'success', alreadySkillId: 'skill-abc123' })).toBe(false);
  });

  // 2026-10-31 on-device bug (agent-mvvx3o28): offered "… succeeded" after a
  // 2-step run whose step 2 was SKIPPED (approval timed out) — reduceStatus
  // reads success + skipped as 'success'.
  it('does not offer when a step was skipped, even though the aggregate status is success', () => {
    expect(shouldOfferSkillSave({
      status: 'success',
      steps: [{ status: 'success' }, { status: 'skipped' }],
      plannedStepCount: 2,
    })).toBe(false);
  });

  it('does not offer for a chain that stopped before its last planned step', () => {
    expect(shouldOfferSkillSave({ status: 'success', steps: [{ status: 'success' }], plannedStepCount: 2 })).toBe(false);
  });

  it('does not offer when any step failed or is still pending', () => {
    expect(shouldOfferSkillSave({ status: 'success', steps: [{ status: 'success' }, { status: 'error' }] })).toBe(false);
    expect(shouldOfferSkillSave({ status: 'success', steps: [{ status: 'success' }, { status: 'pending' }] })).toBe(false);
  });

  it('offers for a multi-step run where every planned step succeeded', () => {
    expect(shouldOfferSkillSave({
      status: 'success',
      steps: [{ status: 'success' }, { status: 'success' }],
      plannedStepCount: 2,
    })).toBe(true);
  });

  it('a skipped step also blocks the unattended auto-save mode', () => {
    expect(skillSaveMode({
      status: 'success',
      unattended: true,
      steps: [{ status: 'success' }, { status: 'skipped' }],
    })).toBe('none');
  });
});

describe('skill save mode', () => {
  it('auto-saves only successful unattended runs', () => {
    expect(skillSaveMode({ status: 'success', unattended: true })).toBe('auto');
    expect(skillSaveMode({ status: 'success', unattended: false })).toBe('confirm');
    expect(skillSaveMode({ status: 'success' })).toBe('confirm');
    expect(skillSaveMode({ status: 'error', unattended: true })).toBe('none');
    expect(
      skillSaveMode({ status: 'success', unattended: true, alreadySkillId: 'skill-existing' }),
    ).toBe('none');
  });

  it('writes the distilled unattended skill immediately without an Alert dependency', async () => {
    const runCommand = jest.fn(async (_cmd: string): Promise<string> => '');
    const id = await saveSkillWithoutConfirmation(runCommand, {
      name: 'Morning digest',
      prompt: 'Summarize the morning news in three bullets.',
      status: 'success',
      unattended: true,
      timestamp: Date.UTC(2026, 6, 28),
    });
    expect(id).toMatch(/^skill-/);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toContain('Morning digest');
  });
});
