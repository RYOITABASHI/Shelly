import { renderHook } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as Notifications from 'expo-notifications';

const mockConsumeSkillImprovementProposal = jest.fn();
const mockRevertSkillImprovement = jest.fn(async () => undefined);
let notificationResponseListener: ((response: any) => void) | undefined;

jest.mock('react-native', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn((listener) => {
    notificationResponseListener = listener;
    return { remove: jest.fn() };
  }),
}));
jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (key === 'sidebar.skill_improve_title') return 'Improve this skill?';
      if (key === 'sidebar.skill_improve_body') {
        return `“${params?.name}” succeeded. Add this lesson?\n\n${params?.note}`;
      }
      return key;
    },
  }),
}));
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));
jest.mock('@/lib/agent-skills', () => ({
  deleteSkillRecipe: jest.fn(async () => undefined),
  distillSkillFromRun: jest.fn(),
  writeSkillRecipe: jest.fn(async () => undefined),
}));
jest.mock('@/lib/unattended-skill-save', () => ({
  DELETE_SAVED_SKILL_ACTION: 'delete-saved-skill',
  saveUnattendedSkillWithNotification: jest.fn(async () => undefined),
}));
jest.mock('@/lib/skill-self-improve', () => ({
  REVERT_SKILL_IMPROVEMENT_ACTION: 'revert-skill-improvement',
  consumeSkillImprovementProposal: (...args: unknown[]) => mockConsumeSkillImprovementProposal(...args),
  persistSkillImprovement: jest.fn(async () => undefined),
  revertSkillImprovement: (...args: unknown[]) => mockRevertSkillImprovement(...args),
}));

import { useSkillSaveOffer } from '@/hooks/use-skill-save-offer';

describe('useSkillSaveOffer UI and notification wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    notificationResponseListener = undefined;
  });

  it('shows the attended improvement agent name and proposed learning in the Alert message', () => {
    mockConsumeSkillImprovementProposal.mockReturnValue({
      kind: 'bump-with-learning',
      agentName: 'Morning researcher',
      improved: { name: 'Research skill' },
      learning: { at: '2026-08-14T00:00:00.000Z', note: 'Verify publication dates before summarizing.' },
    });
    const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand: jest.fn() }));

    result.current.offerSkillImprovement('agent-1');

    expect(Alert.alert).toHaveBeenCalledWith(
      'Improve this skill?',
      expect.stringMatching(/Morning researcher[\s\S]*Verify publication dates before summarizing\./),
      expect.any(Array),
      { cancelable: true },
    );
    expect((Alert.alert as jest.Mock).mock.calls[0][1]).not.toHaveLength(0);
    unmount();
  });

  it('registers one native listener and processes one revert with multiple hook instances', async () => {
    const first = renderHook(() => useSkillSaveOffer({ runCommand: jest.fn() }));
    const second = renderHook(() => useSkillSaveOffer({ runCommand: jest.fn() }));

    expect(Notifications.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    notificationResponseListener?.({
      actionIdentifier: 'revert-skill-improvement',
      notification: { request: { content: { data: { skillId: 'skill-1', learningAt: 'learn-at' } } } },
    });
    await Promise.resolve();

    expect(mockRevertSkillImprovement).toHaveBeenCalledTimes(1);
    expect(mockRevertSkillImprovement).toHaveBeenCalledWith(expect.any(Function), 'skill-1', 'learn-at');
    first.unmount();
    second.unmount();
  });

  describe('save offer after a declined gate escalation (2026-11-01)', () => {
    const runEnd = Date.parse('2026-11-01T10:00:00.000Z');
    const declinedAudit = JSON.stringify({
      ts: new Date(runEnd - 10_000).toISOString(),
      kind: 'escalation_resolved',
      decision: 'decline',
    });
    const baseParams = {
      name: 'Two step',
      prompt: 'Use Codex then Claude Code',
      status: 'success' as const,
      steps: [
        { status: 'success' as const, outputPreview: 'step 1 ok' },
        { status: 'success' as const, outputPreview: 'Here is the summary.' },
      ],
      plannedStepCount: 2,
      agentId: 'agent-1',
      timestamp: runEnd,
      durationMs: 60_000,
    };

    it('does not offer when the audit trail shows a declined escalation in this run', async () => {
      const runCommand = jest.fn(async () => declinedAudit);
      const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand }));
      await result.current.offerSkillSave(baseParams);
      expect(runCommand).toHaveBeenCalledTimes(1);
      expect(Alert.alert).not.toHaveBeenCalled();
      unmount();
    });

    it('explains instead of offering when the user tapped Save as skill', async () => {
      const runCommand = jest.fn(async () => declinedAudit);
      const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand }));
      await result.current.offerSkillSave({ ...baseParams, explainWhenBlocked: true });
      expect(Alert.alert).toHaveBeenCalledTimes(1);
      expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('sidebar.skill_save_blocked_title');
      unmount();
    });

    it('does not offer when a step answer reports the gate block (no audit read needed)', async () => {
      const runCommand = jest.fn(async () => '');
      const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand }));
      await result.current.offerSkillSave({
        ...baseParams,
        steps: [
          baseParams.steps[0],
          { status: 'success', outputPreview: "The command was blocked by Shelly's agent gate, so I didn't base a summary on it." },
        ],
      });
      expect(runCommand).not.toHaveBeenCalled();
      expect(Alert.alert).not.toHaveBeenCalled();
      unmount();
    });

    it('still offers after a clean run', async () => {
      const runCommand = jest.fn(async () => JSON.stringify({
        ts: new Date(runEnd - 10_000).toISOString(),
        kind: 'gate_decision',
        decision: 'accept',
      }));
      const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand }));
      await result.current.offerSkillSave(baseParams);
      expect(Alert.alert).toHaveBeenCalledTimes(1);
      expect((Alert.alert as jest.Mock).mock.calls[0][0]).toBe('sidebar.skill_save_title');
      unmount();
    });
  });
});
