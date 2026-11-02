import { renderHook } from '@testing-library/react-native';
import { Alert } from 'react-native';
import * as Notifications from 'expo-notifications';

const mockConsumeSkillImprovementProposal = jest.fn();
const mockRevertSkillImprovement = jest.fn(async () => undefined);
const mockPersistSkillImprovement = jest.fn(async () => undefined);
const mockWriteSkillRecipe = jest.fn(async () => undefined);
const mockPostSkillOfferLine = jest.fn((_key: string | null, _content: string) => true);
const mockFindSkillOfferChatKey = jest.fn((): string | null => '__companion__');
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
      if (key === 'skill_offer.save_failed') return `save failed: ${params?.error}`;
      return key;
    },
  }),
}));
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));
jest.mock('@/lib/debug-logger', () => ({ logInfo: jest.fn(), logWarn: jest.fn(), logError: jest.fn() }));
jest.mock('@/lib/agent-skills', () => ({
  deleteSkillRecipe: jest.fn(async () => undefined),
  distillSkillFromRun: jest.fn(() => ({ id: 'skill-two-step' })),
  writeSkillRecipe: (...args: unknown[]) => mockWriteSkillRecipe(...(args as [])),
}));
jest.mock('@/lib/unattended-skill-save', () => ({
  DELETE_SAVED_SKILL_ACTION: 'delete-saved-skill',
  saveUnattendedSkillWithNotification: jest.fn(async () => undefined),
}));
jest.mock('@/lib/skill-self-improve', () => ({
  REVERT_SKILL_IMPROVEMENT_ACTION: 'revert-skill-improvement',
  consumeSkillImprovementProposal: (...args: unknown[]) => mockConsumeSkillImprovementProposal(...args),
  persistSkillImprovement: (...args: unknown[]) => mockPersistSkillImprovement(...(args as [])),
  revertSkillImprovement: (...args: unknown[]) => mockRevertSkillImprovement(...(args as [])),
}));
jest.mock('@/lib/skill-offer-chat', () => {
  const actual = jest.requireActual('@/lib/skill-offer-chat');
  return {
    ...actual,
    postSkillOfferLine: (key: string | null, content: string) => mockPostSkillOfferLine(key, content),
    findSkillOfferChatKey: () => mockFindSkillOfferChatKey(),
  };
});

import { useSkillSaveOffer } from '@/hooks/use-skill-save-offer';
import {
  __resetPendingSkillOffersForTests,
  getPendingSkillOffer,
  takeSkillOfferForReply,
} from '@/lib/skill-offer-chat';

const typedReply = (chatKey: string, text: string) =>
  takeSkillOfferForReply({ chatKey, text, typedByUser: true });

describe('useSkillSaveOffer chat-text offers and notification wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindSkillOfferChatKey.mockReturnValue('__companion__');
    mockPostSkillOfferLine.mockImplementation((key) => !!key);
    notificationResponseListener = undefined;
    __resetPendingSkillOffersForTests();
  });

  it('asks the attended improvement in chat (name + lesson + reply hint), never an Alert', async () => {
    mockConsumeSkillImprovementProposal.mockReturnValue({
      kind: 'bump-with-learning',
      agentName: 'Morning researcher',
      improved: { name: 'Research skill' },
      learning: { at: '2026-08-14T00:00:00.000Z', note: 'Verify publication dates before summarizing.' },
    });
    const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand: jest.fn() }));

    result.current.offerSkillImprovement('agent-1', 'pane-a');

    expect(Alert.alert).not.toHaveBeenCalled();
    expect(mockPostSkillOfferLine).toHaveBeenCalledTimes(1);
    const [key, content] = mockPostSkillOfferLine.mock.calls[0];
    expect(key).toBe('pane-a');
    expect(content).toMatch(/Morning researcher[\s\S]*Verify publication dates before summarizing\.[\s\S]*skill_offer\.improve_reply_hint/);

    // "save skill" does not answer an improvement offer; "apply improvement" does.
    expect(typedReply('pane-a', 'save skill')).toBeNull();
    const offer = typedReply('pane-a', 'apply improvement');
    expect(offer?.kind).toBe('improve');
    await offer!.apply();
    expect(mockPersistSkillImprovement).toHaveBeenCalledTimes(1);
    expect(mockPostSkillOfferLine.mock.calls.at(-1)?.[1]).toBe('skill_offer.improved');
    expect(Alert.alert).not.toHaveBeenCalled();
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
    const cleanAudit = JSON.stringify({
      ts: new Date(runEnd - 10_000).toISOString(),
      kind: 'gate_decision',
      decision: 'accept',
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
      expect(mockPostSkillOfferLine).not.toHaveBeenCalled();
      expect(getPendingSkillOffer('__companion__')).toBeNull();
      unmount();
    });

    it('explains in chat (not an Alert) when the user tapped Save as skill', async () => {
      const runCommand = jest.fn(async () => declinedAudit);
      const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand }));
      await result.current.offerSkillSave({ ...baseParams, explainWhenBlocked: true, userRequested: true });
      expect(Alert.alert).not.toHaveBeenCalled();
      expect(mockPostSkillOfferLine).toHaveBeenCalledWith('__companion__', 'sidebar.skill_save_blocked_body');
      expect(mockWriteSkillRecipe).not.toHaveBeenCalled();
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
      expect(mockPostSkillOfferLine).not.toHaveBeenCalled();
      unmount();
    });

    it('asks in chat after a clean attended run and saves only on a typed "save skill"', async () => {
      const runCommand = jest.fn(async () => cleanAudit);
      const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand }));
      await result.current.offerSkillSave({ ...baseParams, chatKey: 'pane-a' });
      expect(Alert.alert).not.toHaveBeenCalled();
      expect(mockPostSkillOfferLine).toHaveBeenCalledWith('pane-a', 'skill_offer.save_ask');
      expect(mockWriteSkillRecipe).not.toHaveBeenCalled();

      // Not typed by the user / other conversation / other text: stays pending.
      expect(takeSkillOfferForReply({ chatKey: 'pane-a', text: 'save skill', typedByUser: false })).toBeNull();
      expect(takeSkillOfferForReply({ chatKey: 'pane-a', text: 'save skill', typedByUser: true, source: 'monitor-team' })).toBeNull();
      expect(typedReply('pane-b', 'save skill')).toBeNull();
      expect(typedReply('pane-a', 'thanks!')).toBeNull();
      expect(getPendingSkillOffer('pane-a')).not.toBeNull();

      const offer = typedReply('pane-a', 'スキルとして保存');
      expect(offer?.kind).toBe('save');
      await offer!.apply();
      expect(mockWriteSkillRecipe).toHaveBeenCalledTimes(1);
      expect(mockPostSkillOfferLine.mock.calls.at(-1)).toEqual(['pane-a', 'skill_offer.saved']);
      // Consumed: a second reply does nothing.
      expect(typedReply('pane-a', 'save skill')).toBeNull();
      unmount();
    });

    it('falls back to the focused AI pane, and to a logged no-op with no AI pane', async () => {
      const runCommand = jest.fn(async () => cleanAudit);
      const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand }));
      await result.current.offerSkillSave(baseParams);
      expect(mockPostSkillOfferLine).toHaveBeenCalledWith('__companion__', 'skill_offer.save_ask');
      expect(getPendingSkillOffer('__companion__')).not.toBeNull();

      __resetPendingSkillOffersForTests();
      mockPostSkillOfferLine.mockClear();
      mockFindSkillOfferChatKey.mockReturnValue(null);
      await result.current.offerSkillSave(baseParams);
      expect(mockPostSkillOfferLine).toHaveBeenCalledWith(null, 'skill_offer.save_ask');
      expect(getPendingSkillOffer('__companion__')).toBeNull();
      expect(Alert.alert).not.toHaveBeenCalled();
      unmount();
    });

    it('an explicit Save-as-skill tap saves directly and reports in chat', async () => {
      const runCommand = jest.fn(async () => cleanAudit);
      const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand }));
      await result.current.offerSkillSave({ ...baseParams, explainWhenBlocked: true, userRequested: true });
      expect(mockWriteSkillRecipe).toHaveBeenCalledTimes(1);
      expect(mockPostSkillOfferLine).toHaveBeenCalledWith('__companion__', 'skill_offer.saved');
      expect(getPendingSkillOffer('__companion__')).toBeNull();
      expect(Alert.alert).not.toHaveBeenCalled();
      unmount();
    });

    it('posts a save failure in chat instead of an Alert', async () => {
      mockWriteSkillRecipe.mockRejectedValueOnce(new Error('disk full'));
      const runCommand = jest.fn(async () => cleanAudit);
      const { result, unmount } = renderHook(() => useSkillSaveOffer({ runCommand }));
      await result.current.offerSkillSave({ ...baseParams, chatKey: 'pane-a' });
      const offer = typedReply('pane-a', 'save it');
      await offer!.apply();
      expect(mockPostSkillOfferLine.mock.calls.at(-1)).toEqual(['pane-a', 'save failed: disk full']);
      expect(Alert.alert).not.toHaveBeenCalled();
      unmount();
    });
  });
});
