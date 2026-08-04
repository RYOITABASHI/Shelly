/**
 * components/panes/AgentUndoButton.tsx — the "元に戻す" (Undo) affordance for
 * a rollback-eligible attended run's completion bubble.
 *
 * The safety property under test: the button must be impossible to show once
 * the underlying handle is gone (already consumed, invalidated by a newer
 * run, or lost to an app restart), and a tap must never claim success unless
 * lib/agent-manager.ts's rollbackAgentRun() itself actually reports one. The
 * component is deliberately re-checking peekAgentRollbackHandle() live
 * rather than trusting that being mounted at all (i.e. the caller having set
 * ChatMessage.agentRollbackOffer) means the handle is still there — this
 * suite pins that live re-check, independent of __tests__/agent-rollback-
 * offer-eligibility.test.ts's coverage of the upstream classification logic.
 */
import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';

const mockPeek = jest.fn();
const mockRollback = jest.fn();

jest.mock('@/lib/agent-manager', () => ({
  peekAgentRollbackHandle: (...args: unknown[]) => mockPeek(...args),
  rollbackAgentRun: (...args: unknown[]) => mockRollback(...args),
}));

jest.mock('@/hooks/use-native-exec', () => ({
  execCommand: jest.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));

jest.mock('@/lib/i18n', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { AgentUndoButton } from '@/components/panes/AgentUndoButton';

const AGENT_ID = 'undo-button-agent';

describe('AgentUndoButton', () => {
  beforeEach(() => {
    mockPeek.mockReset();
    mockRollback.mockReset();
  });

  it('renders nothing when no live handle exists — never an "always available" affordance', () => {
    mockPeek.mockReturnValue(null);
    const { queryByText } = render(<AgentUndoButton agentId={AGENT_ID} />);
    expect(queryByText('agents.undo_run_button')).toBeNull();
  });

  it('renders the Undo button when a live handle exists', () => {
    mockPeek.mockReturnValue({ agentId: AGENT_ID, commitHash: 'abc1234' });
    const { getByText } = render(<AgentUndoButton agentId={AGENT_ID} />);
    expect(getByText('agents.undo_run_button')).toBeTruthy();
  });

  it('tapping Undo calls rollbackAgentRun and shows success on true', async () => {
    mockPeek.mockReturnValue({ agentId: AGENT_ID, commitHash: 'abc1234' });
    mockRollback.mockResolvedValue(true);
    const { getByText, queryByText } = render(<AgentUndoButton agentId={AGENT_ID} />);

    fireEvent.press(getByText('agents.undo_run_button'));

    await waitFor(() => expect(queryByText('agents.undo_run_success')).toBeTruthy());
    expect(mockRollback).toHaveBeenCalledTimes(1);
    expect(mockRollback.mock.calls[0][0]).toBe(AGENT_ID);
    // The button itself is gone once resolved — no double-tap surface left.
    expect(queryByText('agents.undo_run_button')).toBeNull();
  });

  it('tapping Undo shows "unavailable" honestly when rollbackAgentRun reports nothing to undo', async () => {
    mockPeek.mockReturnValue({ agentId: AGENT_ID, commitHash: 'abc1234' });
    mockRollback.mockResolvedValue(false);
    const { getByText, queryByText } = render(<AgentUndoButton agentId={AGENT_ID} />);

    fireEvent.press(getByText('agents.undo_run_button'));

    await waitFor(() => expect(queryByText('agents.undo_run_unavailable')).toBeTruthy());
  });

  it('a tap skips rollbackAgentRun entirely when the LIVE re-check finds the handle already gone', async () => {
    // Mounted while a handle existed (so the button rendered), but the
    // handle was consumed/invalidated by something else BEFORE the tap
    // lands — the exact race the render-time check alone cannot catch.
    let live = true;
    mockPeek.mockImplementation(() => (live ? { agentId: AGENT_ID, commitHash: 'abc1234' } : null));
    const { getByText, queryByText } = render(<AgentUndoButton agentId={AGENT_ID} />);
    live = false;

    fireEvent.press(getByText('agents.undo_run_button'));

    await waitFor(() => expect(queryByText('agents.undo_run_unavailable')).toBeTruthy());
    expect(mockRollback).not.toHaveBeenCalled();
  });

  it('shows a failure message (not success) when rollbackAgentRun throws', async () => {
    mockPeek.mockReturnValue({ agentId: AGENT_ID, commitHash: 'abc1234' });
    mockRollback.mockRejectedValue(new Error('native bridge error'));
    const { getByText, queryByText } = render(<AgentUndoButton agentId={AGENT_ID} />);

    fireEvent.press(getByText('agents.undo_run_button'));

    await waitFor(() => expect(queryByText('agents.undo_run_failed')).toBeTruthy());
    expect(queryByText('agents.undo_run_success')).toBeNull();
  });
});
