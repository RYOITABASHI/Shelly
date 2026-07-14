// hooks/use-skill-save-offer.ts pulls in react-native (Alert) and lib/i18n
// (which in turn pulls in expo-localization / AsyncStorage) purely for the
// React-hook half of the module. This project has no React hook test harness
// (no @testing-library/react-hooks, no react-test-renderer — see jest.config.cjs:
// testEnvironment 'node', testMatch only *.test.ts), so we don't render the hook
// itself. Instead we exercise the pure, side-effect-free gate it delegates to
// (shouldOfferSkillSave), which is what actually encodes the "never re-offer /
// only offer on success" invariants this task must not regress.
jest.mock('react-native', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-file-system/legacy', () => ({}));

import { shouldOfferSkillSave } from '@/hooks/use-skill-save-offer';

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
});
