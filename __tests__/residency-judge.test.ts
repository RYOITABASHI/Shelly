/**
 * scripts/residency-judge.js: the PC-side judgement over a read_residency
 * result (slots covered / missing, process continuity across gaps, pid /
 * startTicks / bootId changes, health failures, one VERDICT line, exit 0).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const judgeMod = require('../scripts/residency-judge.js');

const T0 = Date.parse('2026-11-28T00:00:00Z');
const MIN = 60_000;
const BOOT = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';

type E = { seq: number; at: number; pid: number | null; startTicks: number | null; bootId: string | null; alive: boolean; reason: string; code: string | null; health: { ok: boolean; ms: number } | null };

function entry(seq: number, at: number, over: Partial<E> = {}): E {
  return { seq, at, pid: 100, startTicks: 5000, bootId: BOOT, alive: true, reason: 'tick', code: null, health: null, ...over };
}

/** Ticks every 10 min over [0, n) slots, skipping [skip]. */
function ticks(n: number, skip: number[] = [], over: (i: number) => Partial<E> = () => ({})): E[] {
  const out: E[] = [];
  let seq = 1;
  for (let i = 0; i < n; i++) {
    if (skip.includes(i)) continue;
    out.push(entry(seq++, T0 + i * 10 * MIN + 30_000, over(i)));
  }
  return out;
}

const opts = (slots: number) => ({ from: T0, to: T0 + slots * 10 * MIN, slotMs: 10 * MIN });

describe('residency-judge', () => {
  it('parses its arguments', () => {
    const a = judgeMod.parseArgs(['in.json', '--from', '2026-11-28T00:00:00Z', '--to', '2026-11-29T00:00:00Z', '--slot', '5m']);
    expect(a).toMatchObject({ file: 'in.json', from: T0, to: T0 + 24 * 60 * MIN, slotMs: 5 * MIN, errors: [] });
    expect(judgeMod.parseArgs(['--slot', 'ten']).errors).toHaveLength(1);
    expect(judgeMod.parseArgs(['--from', 'nope']).errors).toHaveLength(1);
    expect(judgeMod.parseSlot('1h')).toBe(60 * MIN);
  });

  it('full coverage with one process is RESIDENT', () => {
    const r = judgeMod.judge(ticks(6), opts(6));
    expect(r).toMatchObject({ samples: 6, slotCount: 6, coveredCount: 6 });
    expect(r.gaps).toEqual([]);
    expect(r.changes).toEqual([]);
    expect(judgeMod.verdictOf(r, { chainOk: true })).toMatch(/^VERDICT: RESIDENT — coverage 6\/6 slots \(100\.0%\)/);
  });

  it('a gap with the same pid + startTicks + bootId on both sides is process-continuous', () => {
    const r = judgeMod.judge(ticks(8, [3, 4]), opts(8));
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({ from: T0 + 30 * MIN, to: T0 + 50 * MIN, slots: 2, continuous: true });
    expect(judgeMod.verdictOf(r, { chainOk: true })).toMatch(/^VERDICT: RESIDENT .*1 gap\(s\) of which 1 process-continuous/);
  });

  it('a restart across a gap (new startTicks) is not continuous and counts as a change', () => {
    const r = judgeMod.judge(ticks(8, [3], (i) => (i >= 4 ? { pid: 101, startTicks: 9000 } : {})), opts(8));
    expect(r.gaps[0].continuous).toBe(false);
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0].what).toEqual(['pid', 'startTicks']);
    expect(judgeMod.verdictOf(r, { chainOk: true })).toMatch(/^VERDICT: NOT PROVEN/);
  });

  it('a reboot (bootId change) is reported even with the same pid number', () => {
    const r = judgeMod.judge(ticks(4, [], (i) => (i >= 2 ? { bootId: '11111111-2222-3333-4444-555555555555' } : {})), opts(4));
    expect(r.changes[0].what).toEqual(['bootId']);
  });

  it('counts not-alive samples and health failures', () => {
    const r = judgeMod.judge(ticks(4, [], (i) => (i === 1 ? { alive: false, pid: null, startTicks: null } : i === 2 ? { health: { ok: false, ms: 1500 } } : {})), opts(4));
    expect(r.notAlive).toHaveLength(1);
    expect(r.healthFailures).toHaveLength(1);
  });

  it('no samples in the window is NO DATA', () => {
    const r = judgeMod.judge([], opts(4));
    expect(judgeMod.verdictOf(r, null)).toBe('VERDICT: NO DATA (no samples in the window)');
  });

  it('accepts the tool result, the data object, or an MCP content wrapper', () => {
    const data = { serviceId: 'council-facade', entries: ticks(2), verification: { chainOk: true } };
    expect(judgeMod.extractPayload(data).entries).toHaveLength(2);
    expect(judgeMod.extractPayload({ ok: true, data }).entries).toHaveLength(2);
    expect(judgeMod.extractPayload({ result: { content: [{ type: 'text', text: JSON.stringify(data) }] } }).entries).toHaveLength(2);
    expect(judgeMod.extractPayload({ nope: 1 })).toBeNull();
  });

  it('main prints a table and one VERDICT line, and always returns 0', () => {
    const out: string[] = [];
    const data = { serviceId: 'council-facade', entries: ticks(6, [2]), verification: { lines: 5, firstSeq: 1, lastSeq: 5, chainOk: true, brokenAtSeq: null, unparsed: 0, mac: 'unverified' } };
    const code = judgeMod.main(['x.json', '--from', '2026-11-28T00:00:00Z', '--to', '2026-11-28T01:00:00Z'], () => JSON.stringify({ ok: true, data }), (t: string) => out.push(t));
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('slots          5 covered / 1 missing / 6 total');
    expect(text).toContain('process continuous across gap');
    expect(text.trim().split('\n').pop()).toMatch(/^VERDICT: RESIDENT/);
    expect(judgeMod.main(['x.json'], () => 'not json', () => {})).toBe(0);
    expect(judgeMod.main(['--bogus'], () => '{}', () => {})).toBe(0);
  });
});
