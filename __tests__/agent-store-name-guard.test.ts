import { useAgentStore } from '@/store/agent-store';
import type { Agent } from '@/store/types';

describe('agent store name lookup', () => {
  afterEach(() => {
    useAgentStore.getState().setAgents([]);
  });

  it('skips malformed agents with a missing name', () => {
    const malformedAgent = { id: 'malformed' } as Agent;
    const validAgent = { id: 'valid', name: 'Researcher' } as Agent;

    useAgentStore.getState().setAgents([malformedAgent, validAgent]);

    expect(useAgentStore.getState().getAgentByName('researcher')).toBe(validAgent);
  });
});
