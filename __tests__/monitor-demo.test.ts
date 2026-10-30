import { DEMO_AGENTS, DEMO_APPROVAL_AT, DEMO_TEAM, simulateDemo } from '@/lib/monitor-demo';
import { agentProgress, edgeState, summarize } from '@/lib/monitor-source';
import { deriveEdges } from '@/lib/monitor-team';

const states = (t: number, inputs: { at: number; text: string }[] = []) => {
  const s = simulateDemo(t, inputs, '2026-10-30');
  return Object.fromEntries(Object.entries(s.agents).map(([id, a]) => [id, a.state]));
};

describe('monitor demo playback', () => {
  it('starts with the two scouts running in parallel', () => {
    expect(states(0)).toEqual({ ch1: 'RUNNING', ch2: 'RUNNING', ch3: 'STANDBY', ch3a: 'STANDBY', ch4: 'STANDBY' });
    const s = simulateDemo(0, []);
    expect(s.chat[0].message?.key).toBe('monitor.demo.chat.start');
    expect(summarize(DEMO_AGENTS, s).running).toBe(2);
  });

  it('spawns the sub-agent while the editor waits', () => {
    expect(states(15)).toMatchObject({ ch1: 'DONE', ch2: 'DONE', ch3: 'WAITING', ch3a: 'RUNNING' });
    expect(simulateDemo(15, []).agents.ch3.note?.key).toBe('monitor.demo.note.wait_sub');
  });

  it('asks for approval in chat and holds until answered', () => {
    const s = simulateDemo(DEMO_APPROVAL_AT + 30, []);
    expect(s.approvalPending).toBe(true);
    expect(s.approvalAgentId).toBe('ch4');
    expect(s.agents.ch4.state).toBe('APPROVAL');
    expect(s.chat[s.chat.length - 1]).toMatchObject({ ask: true, message: { key: 'monitor.demo.chat.approval_ask' } });
    expect(s.complete).toBe(false);
  });

  it('ok → writes and completes at 100%', () => {
    const inputs = [{ at: 26, text: 'ok' }];
    const mid = simulateDemo(27, inputs);
    expect(mid.approvalPending).toBe(false);
    expect(mid.agents.ch4.state).toBe('RUNNING');
    const end = simulateDemo(40, inputs);
    expect(end.complete).toBe(true);
    expect(end.agents.ch4.state).toBe('DONE');
    expect(summarize(DEMO_AGENTS, end).missionPct).toBe(100);
    expect(end.agents.ch4.lines).toContain('write 2026-10-30-03.md');
  });

  it('no → stops without writing', () => {
    const s = simulateDemo(40, [{ at: 26, text: 'だめ' }]);
    expect(s.agents.ch4.state).toBe('STOPPED');
    expect(s.complete).toBe(false);
    expect(s.chat[s.chat.length - 1].message?.key).toBe('monitor.demo.chat.stopped');
  });

  it('answers other input with a hint', () => {
    const before = simulateDemo(5, [{ at: 4, text: 'hello' }]);
    expect(before.chat.some((c) => c.message?.key === 'monitor.demo.chat.only_ok_no')).toBe(true);
    const during = simulateDemo(30, [{ at: 26, text: 'maybe' }]);
    expect(during.approvalPending).toBe(true);
    expect(during.chat[during.chat.length - 1].message?.key).toBe('monitor.demo.chat.reply_hint');
  });

  it('progress = logs seen / total logs, tokens and usd accumulate', () => {
    const s = simulateDemo(3.3, []);
    const ch1 = s.agents.ch1;
    expect(ch1.logs).toBe(3);
    expect(agentProgress(ch1)).toBeCloseTo(3 / ch1.totalLogs);
    expect(ch1.tokens).toBe(420 + 1900 + 1600);
    expect(ch1.usd).toBeCloseTo(0.0011 + 0.0024 + 0.0021);
    // Mission progress is monotonic over the success path.
    let last = -1;
    for (let t = 0; t <= 40; t += 0.5) {
      const pct = summarize(DEMO_AGENTS, simulateDemo(t, [{ at: 26, text: 'ok' }])).missionPct;
      expect(pct).toBeGreaterThanOrEqual(last);
      last = pct;
    }
  });

  it('derives edge states like the prototype', () => {
    const edges = deriveEdges(DEMO_TEAM);
    const at = (t: number) => {
      const s = simulateDemo(t, []);
      return Object.fromEntries(edges.map((e) => [e.id, edgeState(e, s.agents)]));
    };
    expect(at(1)).toMatchObject({ 'ch1>ch3': 'idle', 'ch4>goal': 'idle' });
    expect(at(8)).toMatchObject({ 'ch1>ch3': 'held' });
    expect(at(10)).toMatchObject({ 'ch1>ch3': 'flow', 'ch2>ch3': 'flow' });
    expect(at(15)).toMatchObject({ 'ch3>ch3a': 'flow' });
    expect(at(24)).toMatchObject({ 'ch3>ch4': 'flow', 'ch4>goal': 'held' });
    expect(at(30)).toMatchObject({ 'ch4>goal': 'pending' });
  });
});
