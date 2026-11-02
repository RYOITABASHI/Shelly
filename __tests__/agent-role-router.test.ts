/**
 * Agent roles WP3: lib/agent-role-router.ts (design §3).
 */
jest.mock('@/lib/home-path', () => ({ getHomePath: () => '/home/shelly-test' }));

import { parseAgentNL, type ParsedAgentDraft } from '@/lib/agent-nl-parser';
import {
  detectRoleOptOut,
  dropStepAssignments,
  effectiveRoutedLevel,
  findRoleMentions,
  mentionsTeamWords,
  resolveRoutedRoleLevel,
  revertRoleRouting,
  roleRoutingConflict,
  routeDraftToRoles,
  type RoleRouteSource,
} from '@/lib/agent-role-router';
import { applyDraftPatch } from '@/lib/agent-draft-patch';
import { roleDefinitionHash } from '@/lib/agent-role-store';
import type { AgentRole, LoadedRoles, RoleLevel } from '@/lib/agent-role-types';
import type { AgentOrchestrationStep } from '@/store/types';

function role(p: Partial<AgentRole> & Pick<AgentRole, 'id' | 'name' | 'engine' | 'handles'>): AgentRole {
  return {
    instructions: `${p.name} instructions`,
    workspace: { mode: 'request' },
    createdAt: 1,
    updatedAt: 1,
    ...p,
  };
}

const IMPL = role({ id: 'role_impl', name: 'Implementer', engine: { type: 'cli', cli: 'codex' }, handles: ['implement'], instructions: 'Write working code in the workspace and run a syntax check.', createdAt: 1 });
const REV = role({ id: 'role_rev', name: 'Reviewer', engine: { type: 'cli', cli: 'claude' }, handles: ['review'], autoAttach: 'after-implement', instructions: 'Review code for bugs and security issues, by severity.', createdAt: 2 });
const BUILDER = role({ id: 'role_build', name: 'Builder', engine: { type: 'cli', cli: 'claude' }, handles: ['implement'], createdAt: 3 });
const SUMM = role({ id: 'role_sum', name: 'Summarizer', engine: { type: 'local' }, handles: ['summarize'], createdAt: 4 });
const RESEARCHER = role({ id: 'role_res', name: 'Researcher', engine: { type: 'perplexity' }, handles: ['research'], createdAt: 5 });
const JA_IMPL = role({ id: 'role_jaimpl', name: '実装役', engine: { type: 'cli', cli: 'codex' }, handles: ['implement'], createdAt: 6 });
const JA_REV = role({ id: 'role_jarev', name: 'レビュー役', engine: { type: 'cli', cli: 'claude' }, handles: ['review'], createdAt: 7 });

const loaded = (...roles: AgentRole[]): LoadedRoles => ({ roles, unavailable: false });
const ctx = (levels: Record<string, RoleLevel> = {}, source: RoleRouteSource = 'chat') => ({ levels: new Map(Object.entries(levels)), source });
const objSteps = (steps: Array<string | AgentOrchestrationStep> | undefined) =>
  (steps ?? []).map((s) => (typeof s === 'string' ? { instruction: s } : s));

describe('single unit → single-step agent on the role engine', () => {
  it('implement request with only an implementer role', () => {
    const d = parseAgentNL('Right now, build a brick breaker game in ~/demo');
    const { draft, info } = routeDraftToRoles(d, loaded(IMPL), ctx());
    expect(info?.assignments).toEqual([expect.objectContaining({ stepIndex: 0, roleId: 'role_impl', roleName: 'Implementer', kind: 'implement' })]);
    expect(draft.tool).toEqual({ type: 'cli', cli: 'codex' });
    expect(draft.toolExplicit).toBe(true);
    expect(draft.orchestrationSteps).toBeUndefined();
    expect(draft.prompt).toBe('# Your role\nImplementer: Write working code in the workspace and run a syntax check.\n\n# Task\nbuild a brick breaker game in ~/demo');
    expect(draft.autonomous).toBe(false);
    expect(draft.workspaceRoot).toBe('~/demo');
    expect(draft.roleRouting?.original.prompt).toBe('build a brick breaker game in ~/demo');
  });

  it('a local summarize role is used for a scheduled agent (no CLI)', () => {
    const d = parseAgentNL('Every morning at 8, summarize the latest AI news in 3 lines');
    const { draft, info } = routeDraftToRoles(d, loaded(IMPL, SUMM), ctx());
    expect(info?.assignments.map((a) => a.roleName)).toEqual(['Summarizer']);
    expect(draft.tool).toEqual({ type: 'local' });
    expect(draft.schedule).toBe('0 8 * * *');
  });
});

describe('implement + auto-attached reviewer → serial chain with a final summary', () => {
  it('EN', () => {
    const d = parseAgentNL('Right now, build a brick breaker game in ~/demo');
    const { draft, info } = routeDraftToRoles(d, loaded(IMPL, REV), ctx());
    const steps = objSteps(draft.orchestrationSteps);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({ instruction: 'build a brick breaker game in ~/demo', tool: { type: 'cli', cli: 'codex' }, toolPinned: true, role: { id: 'role_impl', name: 'Implementer' } });
    expect(steps[1]).toMatchObject({ tool: { type: 'cli', cli: 'claude' }, toolPinned: true, role: { id: 'role_rev', name: 'Reviewer' } });
    expect(steps[1].instruction).toMatch(/^Review the implementation/);
    expect(steps[2]).toEqual({ instruction: 'Summarize the results of the steps above for me.' });
    expect(steps.some((s) => s.parallelGroup)).toBe(false);
    expect(draft.tool).toEqual({ type: 'local' });
    expect(draft.toolExplicit).toBe(true);
    expect(info?.assignments.map((a) => [a.stepIndex, a.roleName])).toEqual([[0, 'Implementer'], [1, 'Reviewer']]);
    expect(steps[0].role?.roleHash).toBe(roleDefinitionHash(IMPL));
  });

  it('no reviewer added when the request already has a review unit after it', () => {
    const d = parseAgentNL('have the implementer build a snake game in ~/demo and the reviewer check it');
    const { draft } = routeDraftToRoles(d, loaded(IMPL, REV), ctx());
    const steps = objSteps(draft.orchestrationSteps);
    expect(steps.map((s) => s.instruction)).toEqual(['build a snake game in ~/demo', 'check it', 'Summarize the results of the steps above for me.']);
    expect(steps.map((s) => s.role?.name)).toEqual(['Implementer', 'Reviewer', undefined]);
  });

  it('JA: a unit naming two roles is split at the second', () => {
    const d = parseAgentNL('今すぐ、実装役が~/demoにスネークゲームを作って、レビュー役が確認して');
    const { draft, info } = routeDraftToRoles(d, loaded(JA_IMPL, JA_REV), ctx());
    const steps = objSteps(draft.orchestrationSteps);
    expect(steps.map((s) => s.instruction)).toEqual(['~/demoにスネークゲームを作って', '確認して', '上のステップの結果をまとめて報告して']);
    expect(info?.assignments.map((a) => a.roleName)).toEqual(['実装役', 'レビュー役']);
  });
});

describe('compete', () => {
  it('"both implementers … and compare" → 2 branches on different engines + compare step, no auto reviewer', () => {
    const d = parseAgentNL('Right now, have both implementers build a brick breaker game in ~/demo and compare');
    const { draft, info } = routeDraftToRoles(d, loaded(IMPL, REV, BUILDER), ctx());
    const steps = objSteps(draft.orchestrationSteps);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toMatchObject({ instruction: 'build a brick breaker game in ~/demo', tool: { cli: 'codex' }, parallelGroup: 'r1', role: { name: 'Implementer' } });
    expect(steps[1]).toMatchObject({ instruction: 'build a brick breaker game in ~/demo', tool: { cli: 'claude' }, parallelGroup: 'r1', role: { name: 'Builder' } });
    expect(steps[2]).toEqual({ instruction: 'Compare the implementations above and say which is better and why.' });
    expect(info?.notes).toContain('The competing implementations are compared in the last step; the reviewer is not added automatically.');
  });

  it('JA 「競わせて」', () => {
    const d = parseAgentNL('今すぐ、~/demoにブロック崩しゲームを作って競わせて');
    const { draft } = routeDraftToRoles(d, loaded(JA_IMPL, BUILDER), ctx());
    const steps = objSteps(draft.orchestrationSteps);
    expect(steps.map((s) => s.parallelGroup)).toEqual(['r1', 'r1', undefined]);
    expect(steps[0].instruction).not.toMatch(/競わせ/);
    expect(steps[2].instruction).toBe('上の実装を比べて、どちらが良いかと理由を説明して');
  });

  it('only one implementer → runs once, with a note', () => {
    const d = parseAgentNL('Right now, have both implementers build a brick breaker game in ~/demo and compare');
    const { draft, info } = routeDraftToRoles(d, loaded(IMPL), ctx());
    expect(draft.orchestrationSteps).toBeUndefined();
    expect(info?.notes?.[0]).toMatch(/at least two roles that implement/);
  });

  it('same-engine branches are allowed with a note (they take turns)', () => {
    const second = role({ id: 'role_impl2', name: 'Coder', engine: { type: 'cli', cli: 'codex' }, handles: ['implement'], createdAt: 9 });
    const d = parseAgentNL('Right now, have both implementers build a brick breaker game in ~/demo and compare');
    const { draft, info } = routeDraftToRoles(d, loaded(IMPL, second), ctx());
    expect(objSteps(draft.orchestrationSteps).map((s) => s.role?.name)).toEqual(['Implementer', 'Coder', undefined]);
    expect(info?.notes?.some((n) => /take turns/.test(n))).toBe(true);
  });
});

describe('parallel groups from the request → different roles', () => {
  it('two parallel implement units get two different implementer roles', () => {
    const base = parseAgentNL('Right now, build a timer app in ~/demo');
    const d: ParsedAgentDraft = {
      ...base,
      orchestrationSteps: [
        { instruction: 'build a timer app in ~/demo/a', parallelGroup: 'p1' },
        { instruction: 'build a clock app in ~/demo/b', parallelGroup: 'p1' },
        'summarize the two results into one memo',
      ],
    };
    const { draft } = routeDraftToRoles(d, loaded(IMPL, BUILDER, SUMM), ctx());
    const steps = objSteps(draft.orchestrationSteps);
    expect(steps.map((s) => s.role?.name)).toEqual(['Implementer', 'Builder', 'Summarizer']);
    expect(steps.map((s) => s.parallelGroup)).toEqual(['p1', 'p1', undefined]);
    // The last unit is a local role, so no extra summary step.
    expect(steps).toHaveLength(3);
  });
});

describe('exclusions', () => {
  const ROLES = loaded(IMPL, REV, BUILDER, SUMM);

  it('a fireable schedule / continuous / notification trigger → no CLI roles', () => {
    for (const d of [
      parseAgentNL('Every morning at 8, build a brick breaker game in ~/demo'),
      { ...parseAgentNL('Right now, build a brick breaker game in ~/demo'), schedule: null, continuous: { cooldownMs: 60000 } },
      { ...parseAgentNL('Right now, build a brick breaker game in ~/demo'), schedule: null, notificationTrigger: { packageNames: ['com.x'] } },
    ] as ParsedAgentDraft[]) {
      const r = routeDraftToRoles(d, ROLES, ctx());
      expect(r.info).toBeNull();
      expect(r.skipped).toBe('no-match');
      expect(r.draft).toBe(d);
    }
  });

  it('no CLI role after a research unit (taint)', () => {
    const base = parseAgentNL('Right now, build a page in ~/demo');
    const d: ParsedAgentDraft = { ...base, orchestrationSteps: ['research the latest AI news', 'build a page in ~/demo that lists them'] };
    const { draft, info } = routeDraftToRoles(d, loaded(RESEARCHER, IMPL), ctx());
    const steps = objSteps(draft.orchestrationSteps);
    expect(steps[0].role?.name).toBe('Researcher');
    expect(steps[1].role).toBeUndefined();
    expect(steps[1].tool).toBeUndefined();
    expect(steps).toHaveLength(2);
    expect(info?.notes?.some((n) => /after a web research step/.test(n))).toBe(true);
  });

  it('a one-sentence research + build request (parser chose Perplexity) gets no CLI role', () => {
    const d = parseAgentNL('Right now, research the latest AI news, then build a page in ~/demo that lists them');
    expect(d.tool.type).toBe('perplexity');
    expect(routeDraftToRoles(d, loaded(IMPL), ctx()).info).toBeNull();
  });

  it.each([
    ['explicit tool', 'Right now, using Codex, build a brick breaker game in ~/demo', 'tool-explicit'],
    ['Inc4 pinned steps', 'Right now, in parallel, using Codex list 3 improvement ideas for ~/demo/src/task.ts, using Claude Code explain how to fix the type errors in ~/demo/user.ts, then combine the two results into one memo', 'tool-explicit'],
    ['Antigravity', 'Right now, build a brick breaker game in ~/demo using Antigravity', 'antigravity'],
  ])('%s → not routed', (_l, u, skipped) => {
    const d = parseAgentNL(u);
    const r = routeDraftToRoles(d, ROLES, ctx());
    expect(r.info).toBeNull();
    expect(r.skipped).toBe(skipped);
    expect(r.draft).toBe(d);
  });

  it('a pinned step (without toolExplicit) → not routed', () => {
    const d: ParsedAgentDraft = { ...parseAgentNL('Right now, build x in ~/demo'), orchestrationSteps: [{ instruction: 'build x', tool: { type: 'cli', cli: 'codex' } }, 'summarize'] };
    expect(routeDraftToRoles(d, ROLES, ctx()).skipped).toBe('tool-pinned');
  });

  it('"without roles" / 「ロールなしで」 → not routed, phrase stripped', () => {
    for (const u of ['Right now, build a brick breaker game in ~/demo without roles', '今すぐ、ロールなしで~/demoにブロック崩しゲームを作って']) {
      const r = routeDraftToRoles(parseAgentNL(u), ROLES, ctx());
      expect(r.skipped).toBe('opt-out');
      expect(r.info).toBeNull();
      expect(r.draft.prompt).not.toMatch(/without roles|ロールなし/);
    }
    expect(detectRoleOptOut("don't use my roles")).toBe(true);
    expect(detectRoleOptOut('build the roles page')).toBe(false);
  });

  it('api-call step, ClosePaw / social-post / browser-pane action, executable skill plan, autonomous, MONITOR team', () => {
    const base = parseAgentNL('Right now, build a brick breaker game in ~/demo');
    const cases: Array<[ParsedAgentDraft, string, RoleRouteSource?]> = [
      [{ ...base, orchestrationSteps: [{ instruction: '', apiCall: { method: 'GET', host: 'api.example.com', path: '/x', authRef: 'perplexity' } } as unknown as AgentOrchestrationStep, 'summarize'] }, 'api-call'],
      [{ ...base, action: { type: 'intent', intentMode: 'closepaw', intentShareText: 'send it' } as ParsedAgentDraft['action'] }, 'action'],
      [{ ...base, closePawRouting: { clause: 'open LINE', app: 'LINE', routed: true } }, 'action'],
      [{ ...base, action: { type: 'social-post', socialPost: { platform: 'bluesky', connectorId: 'bsky' } } as unknown as ParsedAgentDraft['action'] }, 'action'],
      [{ ...base, action: { type: 'browser-pane' } as ParsedAgentDraft['action'] }, 'action'],
      [{ ...base, matchedSkill: { id: 's', name: 'S', successCount: 1, executablePlan: true } }, 'skill-plan'],
      [{ ...base, autonomous: true }, 'autonomous'],
      [base, 'monitor-team', 'monitor-team'],
    ];
    for (const [d, skipped, source] of cases) {
      const r = routeDraftToRoles(d, ROLES, ctx({}, source ?? 'chat'));
      expect([r.skipped, r.info]).toEqual([skipped, null]);
    }
  });

  it('roles unavailable → not routed, the confirm text says so', () => {
    const r = routeDraftToRoles(parseAgentNL('Right now, build a game in ~/demo'), { roles: [], unavailable: true, reason: 'unsealed' }, ctx());
    expect(r.skipped).toBe('unavailable');
    expect(r.draft.roleRoutingNotice).toBe('unavailable');
  });

  it('no roles / no matching kind → unchanged', () => {
    const d = parseAgentNL('Right now, build a game in ~/demo');
    expect(routeDraftToRoles(d, loaded(), ctx()).skipped).toBe('no-roles');
    expect(routeDraftToRoles(d, loaded(SUMM), ctx()).skipped).toBe('no-match');
  });
});

describe('workspace', () => {
  const FIXED = { ...IMPL, workspace: { mode: 'fixed' as const, path: '~/work' } };

  it('request path wins over a fixed role path, with a conflict note', () => {
    const { draft, info } = routeDraftToRoles(parseAgentNL('Right now, build a game in ~/demo'), loaded(FIXED), ctx());
    expect(draft.workspaceRoot).toBe('~/demo');
    expect(info?.workspaceRoot).toBe('~/demo');
    expect(info?.notes?.[0]).toMatch(/own workspace ~\/work, but this agent runs in ~\/demo/);
  });

  it('no request path → the first fixed role path', () => {
    const { draft } = routeDraftToRoles(parseAgentNL('Right now, build a brick breaker game'), loaded(FIXED), ctx());
    expect(draft.workspaceRoot).toBe('~/work');
  });
});

describe('levels', () => {
  it('minimum of the assigned roles; only the typed chat may apply it', () => {
    const d = parseAgentNL('Right now, build a brick breaker game in ~/demo');
    const chat = routeDraftToRoles(d, loaded(IMPL, REV), ctx({ role_impl: 'all', role_rev: 'standard' }));
    expect(chat.info?.minLevel).toBe('standard');
    expect(chat.info?.levelEligible).toBe(true);
    expect(effectiveRoutedLevel(chat.draft)).toEqual({ level: 'standard', degraded: false });
    const term = routeDraftToRoles(d, loaded(IMPL, REV), ctx({ role_impl: 'all', role_rev: 'all' }, 'terminal-request'));
    expect(term.info?.levelEligible).toBe(false);
    expect(effectiveRoutedLevel(term.draft).level).toBe('off');
    expect(routeDraftToRoles(d, loaded(IMPL, REV), ctx({ role_impl: 'all' })).info?.minLevel).toBe('off');
  });

  it('"all" for an agent reading web input degrades to standard', () => {
    const d = parseAgentNL('Right now, summarize https://example.com/news in 3 lines');
    const r = routeDraftToRoles(d, loaded(SUMM), ctx({ role_sum: 'all' }));
    expect(r.info?.minLevel).toBe('all');
    expect(effectiveRoutedLevel(r.draft)).toEqual({ level: 'standard', degraded: true });
  });

  it('resolveRoutedRoleLevel re-verifies the definition hash', async () => {
    const refs = [{ id: IMPL.id, roleHash: roleDefinitionHash(IMPL) }, { id: REV.id, roleHash: roleDefinitionHash(REV) }];
    const get = async (r: AgentRole): Promise<RoleLevel> => (r.id === IMPL.id ? 'all' : 'all');
    expect(await resolveRoutedRoleLevel(refs, loaded(IMPL, REV), get)).toBe('all');
    const edited = { ...REV, instructions: 'something else' };
    expect(await resolveRoutedRoleLevel(refs, loaded(IMPL, edited), get)).toBe('off');
    expect(await resolveRoutedRoleLevel(refs, loaded(IMPL), get)).toBe('off');
    expect(await resolveRoutedRoleLevel(refs, { roles: [IMPL, REV], unavailable: true }, get)).toBe('off');
  });
});

describe('revert / patches', () => {
  const routed = () => routeDraftToRoles(parseAgentNL('Right now, build a brick breaker game in ~/demo'), loaded(IMPL, REV), ctx()).draft;

  it('revertRoleRouting restores the unrouted draft', () => {
    const d = routed();
    const back = revertRoleRouting(d);
    expect(back.roleRouting).toBeUndefined();
    expect(back.orchestrationSteps).toBeUndefined();
    expect(back.prompt).toBe('build a brick breaker game in ~/demo');
    expect(back.tool).toEqual(d.roleRouting!.original.tool);
    expect(back.toolExplicit).toBeUndefined();
  });

  it('"without roles" / 「ロールなしで」 reply on a pending routed draft reverts', () => {
    for (const reply of ['without roles', 'ロールなしで']) {
      const r = applyDraftPatch(routed(), reply)!;
      expect(r.changedFields).toEqual(['roleRouting']);
      expect(r.patchedDraft.roleRouting).toBeUndefined();
      expect(r.patchedDraft.orchestrationSteps).toBeUndefined();
    }
  });

  it('overriding a role step engine drops that step role', () => {
    const r = applyDraftPatch(routed(), '2番目をローカルで')!;
    expect(r.changedFields).toEqual(['step:1']);
    const steps = objSteps(r.patchedDraft.orchestrationSteps);
    expect(steps[1].role).toBeUndefined();
    expect(steps[1].tool).toEqual({ type: 'local' });
    expect(steps[0].role?.name).toBe('Implementer');
    expect(r.patchedDraft.roleRouting?.assignments.map((a) => a.roleName)).toEqual(['Implementer']);
    expect(dropStepAssignments(r.patchedDraft, [0]).roleRouting).toBeUndefined();
  });

  it('a schedule patch that makes CLI roles unattended reverts the routing', () => {
    const r = applyDraftPatch(routed(), '毎朝8時にして')!;
    expect(r.changedFields).toContain('roleRouting');
    expect(r.patchedDraft.roleRouting).toBeUndefined();
    expect(r.patchedDraft.schedule).toBe('0 8 * * *');
    expect(roleRoutingConflict({ ...routed(), autonomous: true })).toBe('autonomous');
  });
});

describe('mentions / team words', () => {
  it('finds role names (plural, case-insensitive), not substrings of other words', () => {
    expect(findRoleMentions('have both Implementers build it', [IMPL]).map((m) => m.role.id)).toEqual(['role_impl']);
    expect(findRoleMentions('the reimplementer', [IMPL])).toEqual([]);
    expect(findRoleMentions('実装役とレビュー役で', [JA_IMPL, JA_REV]).map((m) => m.role.name)).toEqual(['実装役', 'レビュー役']);
  });

  it('team words', () => {
    for (const t of ['ロールで~/demoに作って', '役割分担して作って', 'チームで任せて', 'build it with my roles', 'have the team build it']) {
      expect(mentionsTeamWords(t)).toBe(true);
    }
    for (const t of ['コントロールで操作して', 'build a team page', 'roll the dice']) expect(mentionsTeamWords(t)).toBe(false);
  });

  it('team words are stripped from the routed instruction', () => {
    const { draft } = routeDraftToRoles(parseAgentNL('今すぐ、ロールで~/demoにブロック崩しゲームを作って'), loaded(JA_IMPL), ctx());
    expect(draft.prompt.endsWith('# Task\n~/demoにブロック崩しゲームを作って')).toBe(true);
  });
});
