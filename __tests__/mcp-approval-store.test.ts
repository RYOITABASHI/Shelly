/**
 * store/mcp-approval-store.ts — three-way decision plumbing: settle-once,
 * a tap after timeout is a no-op, denyAll resolves 'deny', 'always' reaches
 * the resolver. The timeout wiring is replicated the way
 * lib/mcp-server-bridge.ts requestApproval does it (settle + respond).
 */
import { useMcpApprovalStore, type McpApprovalDecision } from '@/store/mcp-approval-store';

const reset = () => useMcpApprovalStore.setState({ current: null, queue: [] });
const req = (id: string, resolve: (d: McpApprovalDecision) => void, extra: object = {}) => ({
  id, kind: 'run_command' as const, summary: '', detail: '', resolve, ...extra,
});

beforeEach(reset);
afterEach(() => { jest.useRealTimers(); reset(); });

describe('mcp approval store decisions', () => {
  it.each(['deny', 'once', 'always'] as const)("propagates '%s' to the resolver and advances the queue", (d) => {
    const a = jest.fn();
    const b = jest.fn();
    const s = useMcpApprovalStore.getState();
    s.enqueue(req('a', a, { alwaysAllowable: { op: 'run_agent', targetLabel: 'Agent X' } }));
    s.enqueue(req('b', b));
    useMcpApprovalStore.getState().respond('a', d);
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(d);
    expect(useMcpApprovalStore.getState().current?.id).toBe('b');
    expect(b).not.toHaveBeenCalled();
  });

  it('respond drops ids that are not current without resolving anything', () => {
    const a = jest.fn();
    const b = jest.fn();
    const s = useMcpApprovalStore.getState();
    s.enqueue(req('a', a));
    s.enqueue(req('b', b));
    useMcpApprovalStore.getState().respond('b', 'once');
    expect(b).not.toHaveBeenCalled();
    expect(a).not.toHaveBeenCalled();
    expect(useMcpApprovalStore.getState().current?.id).toBe('a');
    expect(useMcpApprovalStore.getState().queue).toEqual([]);
    useMcpApprovalStore.getState().respond('zzz', 'always');
    expect(useMcpApprovalStore.getState().current?.id).toBe('a');
  });

  it('settle-once: a second respond for the same id does not re-resolve', () => {
    const a = jest.fn();
    useMcpApprovalStore.getState().enqueue(req('a', a));
    useMcpApprovalStore.getState().respond('a', 'once');
    useMcpApprovalStore.getState().respond('a', 'always');
    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith('once');
  });

  it("a tap arriving after the timeout is a no-op (promise stays 'deny')", async () => {
    jest.useFakeTimers();
    let settled = false;
    let result: McpApprovalDecision | null = null;
    const settle = (d: McpApprovalDecision) => { if (settled) return; settled = true; result = d; };
    const timer = setTimeout(() => {
      settle('deny');
      useMcpApprovalStore.getState().respond('t1', 'deny');
    }, 90_000);
    useMcpApprovalStore.getState().enqueue(req('t1', (d) => { clearTimeout(timer); settle(d); }));
    jest.advanceTimersByTime(90_000);
    expect(result).toBe('deny');
    expect(useMcpApprovalStore.getState().current).toBeNull();
    useMcpApprovalStore.getState().respond('t1', 'always'); // late tap
    expect(result).toBe('deny');
    expect(useMcpApprovalStore.getState().current).toBeNull();
  });

  it("denyAll resolves every request 'deny' and keeps going if a resolver throws", () => {
    const a = jest.fn(() => { throw new Error('boom'); });
    const b = jest.fn();
    const s = useMcpApprovalStore.getState();
    s.enqueue(req('a', a));
    s.enqueue(req('b', b));
    useMcpApprovalStore.getState().denyAll();
    expect(a).toHaveBeenCalledWith('deny');
    expect(b).toHaveBeenCalledWith('deny');
    expect(useMcpApprovalStore.getState().current).toBeNull();
    expect(useMcpApprovalStore.getState().queue).toEqual([]);
  });
});
