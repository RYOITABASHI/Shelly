import {
  addNode,
  deriveEdges,
  makeParallel,
  moveNode,
  parseTeamFile,
  removeNode,
  resolveDropTarget,
  serializeTeamFile,
  shiftNode,
  toOrchestrationSteps,
  updateNode,
  validate,
  type MonitorTeam,
  type MonitorTeamNode,
} from '@/lib/monitor-team';
import {
  HARD_MAX_STEPS,
  MAX_PARALLEL_BRANCHES,
  normalizeSteps,
  planParallelGroups,
} from '@/lib/agent-orchestration';
import { DEMO_TEAM } from '@/lib/monitor-demo';

const n = (id: string, extra: Partial<MonitorTeamNode> = {}): MonitorTeamNode => ({
  id,
  role: `role ${id}`,
  provider: 'auto',
  askBeforeWrite: false,
  ...extra,
});

const team = (cols: string[][]): MonitorTeam => ({
  title: 't',
  columns: cols.map((c) => c.map((id) => n(id))),
  subAgents: [],
});

const shape = (t: MonitorTeam) => t.columns.map((c) => c.map((x) => x.id));
const codes = (t: MonitorTeam) => validate(t).map((e) => e.code);

describe('validate', () => {
  it('accepts the demo team', () => {
    expect(validate(DEMO_TEAM)).toEqual([]);
  });
  it('rejects an empty team and empty columns', () => {
    expect(codes(team([]))).toEqual(['empty_team']);
    expect(codes(team([['a'], [], ['b']]))).toContain('empty_column');
  });
  it('caps a column at MAX_PARALLEL_BRANCHES', () => {
    expect(MAX_PARALLEL_BRANCHES).toBe(3);
    expect(codes(team([['a', 'b', 'c'], ['d']]))).toEqual([]);
    expect(codes(team([['a', 'b', 'c', 'x'], ['d']]))).toContain('column_full');
  });
  it('requires the final column to hold exactly one node', () => {
    expect(codes(team([['a'], ['b', 'c']]))).toContain('final_parallel');
  });
  it('rejects empty roles, duplicate ids, orphan sub-agents, too many steps', () => {
    const t = team([['a'], ['b']]);
    t.columns[0][0].role = '   ';
    expect(codes(t)).toContain('empty_role');
    expect(codes(team([['a'], ['a']]))).toContain('duplicate_id');
    const orphan: MonitorTeam = { ...team([['a']]), subAgents: [{ ...n('s'), parentId: 'zz' }] };
    expect(codes(orphan)).toContain('orphan_sub');
    const big = team(Array.from({ length: HARD_MAX_STEPS + 1 }, (_, i) => [`x${i}`]));
    expect(codes(big)).toContain('too_many_steps');
  });
});

describe('moveNode / shiftNode / makeParallel', () => {
  const base = team([['a', 'b'], ['c'], ['d']]);

  it('joins another column (parallel)', () => {
    const r = moveNode(base, 'c', { kind: 'column', index: 0 });
    expect(r.ok && shape(r.team)).toEqual([['a', 'b', 'c'], ['d']]);
  });
  it('splits into a new column and drops the emptied column', () => {
    const r = moveNode(base, 'b', { kind: 'newColumn', index: 1 });
    expect(r.ok && shape(r.team)).toEqual([['a'], ['b'], ['c'], ['d']]);
    const r2 = moveNode(base, 'c', { kind: 'newColumn', index: 0 });
    expect(r2.ok && shape(r2.team)).toEqual([['c'], ['a', 'b'], ['d']]);
  });
  it('refuses a fourth node in a column', () => {
    const full = team([['a', 'b', 'c'], ['d'], ['e']]);
    const r = moveNode(full, 'd', { kind: 'column', index: 0 });
    expect(r.ok).toBe(false);
    expect('error' in r && r.error.code).toBe('column_full');
  });
  it('refuses to make the final step parallel', () => {
    const r = moveNode(base, 'c', { kind: 'column', index: 2 });
    expect(r.ok).toBe(false);
    expect('error' in r && r.error.code).toBe('final_parallel');
    // Moving the final node into an earlier column leaves a parallel final column.
    const r2 = moveNode(team([['a'], ['b', 'c'], ['d']]), 'd', { kind: 'column', index: 0 });
    expect(r2.ok).toBe(false);
  });
  it('does not mutate the input', () => {
    const before = JSON.stringify(base);
    moveNode(base, 'c', { kind: 'column', index: 0 });
    expect(JSON.stringify(base)).toBe(before);
  });
  it('shifts left/right as a serial step', () => {
    const l = shiftNode(base, 'b', -1);
    expect(l.ok && shape(l.team)).toEqual([['b'], ['a'], ['c'], ['d']]);
    const lr = shiftNode(base, 'b', 1);
    expect(lr.ok && shape(lr.team)).toEqual([['a'], ['b'], ['c'], ['d']]);
    const r = shiftNode(base, 'c', -1);
    expect(r.ok && shape(r.team)).toEqual([['c'], ['a', 'b'], ['d']]);
    const r2 = shiftNode(base, 'c', 1);
    expect(r2.ok && shape(r2.team)).toEqual([['a', 'b'], ['d'], ['c']]);
  });
  it('makes a node parallel with another', () => {
    const r = makeParallel(base, 'c', 'a');
    expect(r.ok && shape(r.team)).toEqual([['a', 'b', 'c'], ['d']]);
  });
});

describe('addNode / updateNode / removeNode', () => {
  it('adds before the final step by default', () => {
    const r = addNode(team([['a'], ['b']]), { role: 'new\n  role ' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(shape(r.team)).toEqual([['a'], [r.id], ['b']]);
      expect(r.team.columns[1][0].role).toBe('new role');
    }
  });
  it('refuses an empty role and a full column', () => {
    expect(addNode(team([['a']]), { role: '  ' }).ok).toBe(false);
    const r = addNode(team([['a', 'b', 'c'], ['d']]), { role: 'x' }, { kind: 'column', index: 0 });
    expect(r.ok).toBe(false);
  });
  it('refuses beyond HARD_MAX_STEPS', () => {
    const big = team(Array.from({ length: HARD_MAX_STEPS }, (_, i) => [`x${i}`]));
    expect(addNode(big, { role: 'one more' }).ok).toBe(false);
  });
  it('updates role/provider/ask toggle', () => {
    const r = updateNode(team([['a'], ['b']]), 'b', { provider: 'groq', askBeforeWrite: true });
    expect(r.ok && r.team.columns[1][0]).toMatchObject({ provider: 'groq', askBeforeWrite: true });
    expect(updateNode(team([['a']]), 'a', { role: '' }).ok).toBe(false);
  });
  it('removes nodes but never the last one', () => {
    const r = removeNode(team([['a', 'b'], ['c']]), 'a');
    expect(r.ok && shape(r.team)).toEqual([['b'], ['c']]);
    expect(removeNode(team([['a']]), 'a').ok).toBe(false);
  });
});

describe('deriveEdges / resolveDropTarget', () => {
  it('connects every node of column k to every node of column k+1', () => {
    const edges = deriveEdges(DEMO_TEAM).map((e) => `${e.from}>${e.to}${e.sub ? ':sub' : ''}`);
    expect(edges).toEqual(['ch1>ch3', 'ch2>ch3', 'ch3>ch4', 'ch3>ch3a:sub', 'ch4>goal']);
  });
  it('maps x to join / insert targets', () => {
    // colW 100, gap 20 → column 0 is [0,100), column 1 is [120,220)
    expect(resolveDropTarget(50, 2, 100, 20)).toEqual({ kind: 'column', index: 0 });
    expect(resolveDropTarget(5, 2, 100, 20)).toEqual({ kind: 'newColumn', index: 0 });
    expect(resolveDropTarget(110, 2, 100, 20)).toEqual({ kind: 'newColumn', index: 1 });
    expect(resolveDropTarget(170, 2, 100, 20)).toEqual({ kind: 'column', index: 1 });
    expect(resolveDropTarget(900, 2, 100, 20)).toEqual({ kind: 'newColumn', index: 2 });
    expect(resolveDropTarget(-10, 2, 100, 20)).toEqual({ kind: 'newColumn', index: 0 });
  });
});

describe('toOrchestrationSteps', () => {
  it('emits parallelGroup ids that planParallelGroups really groups', () => {
    const steps = toOrchestrationSteps(DEMO_TEAM);
    expect(steps.map((s) => s.instruction)).toEqual([
      'collect new papers from arXiv',
      'collect new papers from Hugging Face',
      'pick 3 and summarize',
      'save to Obsidian AI_Papers/',
    ]);
    expect(steps[0].tool).toEqual({ type: 'perplexity' });
    expect(steps[3].tool).toEqual({ type: 'cli', cli: 'codex' });
    const plan = planParallelGroups(normalizeSteps({ steps }));
    expect(plan.group).toEqual(['p1', 'p1', undefined, undefined]);
    expect(plan.contextBase).toEqual([0, 0, 2, 3]);
  });
  it('keeps separate parallel columns as separate groups', () => {
    const t = team([['a', 'b', 'c'], ['d'], ['e', 'f'], ['g']]);
    const steps = toOrchestrationSteps(t);
    const plan = planParallelGroups(normalizeSteps({ steps }));
    expect(plan.group).toEqual(['p1', 'p1', 'p1', undefined, 'p3', 'p3', undefined]);
    expect(steps.every((s) => s.tool === undefined)).toBe(true);
  });
  it('produces no group for an all-serial team', () => {
    const plan = planParallelGroups(normalizeSteps({ steps: toOrchestrationSteps(team([['a'], ['b']])) }));
    expect(plan.group).toEqual([undefined, undefined]);
  });
});

describe('team file parse / serialize', () => {
  const SAMPLE = [
    '# Morning AI paper digest   daily 7:00 / cap ¥20',
    '- 同時に:',
    '  - collect new papers from arXiv',
    '  - collect new papers from Hugging Face',
    '- pick 3 and summarize',
    '- save to Obsidian AI_Papers/ (ask before writing)',
    '',
  ].join('\n');

  it('parses the documented example', () => {
    const r = parseTeamFile(SAMPLE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.team.title).toBe('Morning AI paper digest');
    expect(r.team.meta).toBe('daily 7:00 / cap ¥20');
    expect(r.team.columns.map((c) => c.map((x) => x.role))).toEqual([
      ['collect new papers from arXiv', 'collect new papers from Hugging Face'],
      ['pick 3 and summarize'],
      ['save to Obsidian AI_Papers/'],
    ]);
    expect(r.team.columns[2][0].askBeforeWrite).toBe(true);
  });

  it('accepts "in parallel:", providers and sub-agents', () => {
    const r = parseTeamFile(
      '# T\n- in parallel:\n  - a [Perplexity]\n  - b [groq]\n- c [Local LLM]\n  - sub: check c\n- d\n',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.team.columns[0].map((x) => x.provider)).toEqual(['perplexity', 'groq']);
    expect(r.team.columns[1][0].provider).toBe('local');
    expect(r.team.subAgents).toHaveLength(1);
    expect(r.team.subAgents[0].parentId).toBe(r.team.columns[1][0].id);
  });

  it('rejects invalid shapes and stray indentation', () => {
    expect(parseTeamFile('# T\n- a\n- in parallel:\n  - b\n  - c\n').ok).toBe(false); // final parallel
    expect(parseTeamFile('# T\n- in parallel:\n  - a\n  - b\n  - c\n  - d\n- e\n').ok).toBe(false);
    expect(parseTeamFile('# T\n  - orphan\n- a\n').ok).toBe(false);
    expect(parseTeamFile('# T\nnot a list line\n').ok).toBe(false);
  });

  it('round-trips', () => {
    const first = parseTeamFile(SAMPLE);
    if (!first.ok) throw new Error('parse failed');
    const text = serializeTeamFile(first.team);
    const second = parseTeamFile(text);
    expect(second.ok && second.team).toEqual(first.team);
    expect(serializeTeamFile(DEMO_TEAM)).toBe(
      [
        '# Daily AI paper digest → Obsidian   daily 7:00 / cap ¥20',
        '- in parallel:',
        '  - collect new papers from arXiv [Perplexity]',
        '  - collect new papers from Hugging Face [Gemini API]',
        '- pick 3 and summarize [Local LLM]',
        '  - sub: check every claim has a source [Perplexity]',
        '- save to Obsidian AI_Papers/ [Codex CLI] (ask before writing)',
        '',
      ].join('\n'),
    );
    const demo = parseTeamFile(serializeTeamFile(DEMO_TEAM));
    expect(demo.ok && serializeTeamFile(demo.team)).toBe(serializeTeamFile(DEMO_TEAM));
  });
});
