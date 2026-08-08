// Unit coverage for the Sidebar RUNNING-poll gating condition. Lives in
// lib/agent-running-format.ts (not Sidebar.tsx) for the same reason as
// formatElapsedMs — see __tests__/sidebar-running-elapsed.test.ts's header.
//
// Covers the "zombie RUNNING display" bug (docs/superpowers/DEFERRED.md):
// an ephemeral one-shot agent auto-deletes its store entry (agentCount -> 0)
// while runningAgentCount may still show it as live for one more poll tick.
// Without runningAgentCount in the gate, polling stopped instantly and the
// stale row never got refreshed away.
import { shouldPollRunningAgents } from '@/lib/agent-running-format';

describe('shouldPollRunningAgents (Sidebar RUNNING-section poll gate)', () => {
  it('polls when there are registered agents', () => {
    expect(shouldPollRunningAgents({ agentCount: 1, pendingAgentCount: 0, runningAgentCount: 0 })).toBe(true);
  });

  it('polls when a run is pending (optimistic RUN NOW state)', () => {
    expect(shouldPollRunningAgents({ agentCount: 0, pendingAgentCount: 1, runningAgentCount: 0 })).toBe(true);
  });

  it('polls when a running id is still tracked, even with zero registered agents (zombie-row regression)', () => {
    expect(shouldPollRunningAgents({ agentCount: 0, pendingAgentCount: 0, runningAgentCount: 1 })).toBe(true);
  });

  it('stops polling once agents, pending runs, and running ids are all empty', () => {
    expect(shouldPollRunningAgents({ agentCount: 0, pendingAgentCount: 0, runningAgentCount: 0 })).toBe(false);
  });
});
