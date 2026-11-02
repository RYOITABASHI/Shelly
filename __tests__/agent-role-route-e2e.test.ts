/**
 * Agent roles WP3 end to end: NL → parsed draft → role routing → confirm
 * summary → confirm boundary → stored agent → PlanSpec → attended route.
 * Modeled on __tests__/agent-nl-inc4-parallel-cli.test.ts.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { parseAgentNL, type ParsedAgentDraft } from '@/lib/agent-nl-parser';
import { mentionsRoleName, mentionsTeamWords, routeDraftToRoles } from '@/lib/agent-role-router';
import { detectRoleIntent } from '@/lib/agent-role-intent';
import { isCapabilityQuestionForAgentFlow } from '@/lib/agent-llm-fallback';
import {
  draftToConfirmedAgentDraft,
  hasDraftAssumptions,
  isAutoRegisterEligibleDraft,
  shouldUseChatConfirm,
  summarizeAgentDraftAsText,
} from '@/lib/agent-plan-summary';
import { resolveConfirmedToolAndRunOn } from '@/lib/agent-tool-router';
import { decideAttendedRoute, storedPlanSpecOpts } from '@/lib/agent-attended-route';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { generateRunScript } from '@/lib/agent-executor';
import type { LadderEnv } from '@/lib/agent-escalation-ladder';
import type { AgentRole, LoadedRoles, RoleLevel } from '@/lib/agent-role-types';
import type { Agent, AgentOrchestrationStep } from '@/store/types';

const ENV: LadderEnv = { hasCerebrasKey: false, hasGroqKey: false, autonomousCloudConsent: false, autonomousCloudStop: false };

const base = { workspace: { mode: 'request' as const }, updatedAt: 1 };
const IMPL: AgentRole = { ...base, id: 'role_impl', name: 'Implementer', instructions: 'Write working code in the workspace and run a syntax check.', engine: { type: 'cli', cli: 'codex' }, handles: ['implement'], createdAt: 1 };
const REV: AgentRole = { ...base, id: 'role_rev', name: 'Reviewer', instructions: 'Review code for bugs and security issues and list them by severity.', engine: { type: 'cli', cli: 'claude' }, handles: ['review'], autoAttach: 'after-implement', createdAt: 2 };
const BUILDER: AgentRole = { ...base, id: 'role_build', name: 'Builder', instructions: 'Write working code with tests.', engine: { type: 'cli', cli: 'claude' }, handles: ['implement'], createdAt: 3 };
const JA_IMPL: AgentRole = { ...base, id: 'role_jaimpl', name: '実装役', instructions: 'ワークスペースの中で動くコードを書いて構文チェックまでする', engine: { type: 'cli', cli: 'codex' }, handles: ['implement'], createdAt: 4 };
const JA_REV: AgentRole = { ...base, id: 'role_jarev', name: 'レビュー役', instructions: 'コードのバグとセキュリティの問題を重大度つきで洗い出す', engine: { type: 'cli', cli: 'claude' }, handles: ['review'], autoAttach: 'after-implement', createdAt: 5 };

const loaded = (...roles: AgentRole[]): LoadedRoles => ({ roles, unavailable: false });
const levels = (m: Record<string, RoleLevel> = {}) => new Map(Object.entries(m));

const objSteps = (steps: Array<string | AgentOrchestrationStep> | undefined) =>
  (steps ?? []).map((s) => (typeof s === 'string' ? { instruction: s } : s));

function nlToRouted(utterance: string, roles: LoadedRoles, lv: Record<string, RoleLevel> = {}): ParsedAgentDraft {
  return routeDraftToRoles(parseAgentNL(utterance), roles, { levels: levels(lv), source: 'chat' }).draft;
}

/** The confirm boundary (hooks/use-ai-pane-dispatch.ts confirmAgentDraftInner)
 *  → the stored agent → its PlanSpec → decideAttendedRoute. */
function install(draft: ParsedAgentDraft) {
  const confirmed = draftToConfirmedAgentDraft(draft);
  const { tool, runOn } = resolveConfirmedToolAndRunOn({
    autonomous: confirmed.autonomous,
    runOn: confirmed.runOn,
    tool: confirmed.tool,
    cloudConsent: false,
    needsWeb: false,
    needsSearch: false,
    toolExplicit: confirmed.toolExplicit,
  });
  const agent = {
    id: 'roles-e2e-agent',
    name: confirmed.name,
    description: '',
    prompt: confirmed.prompt,
    schedule: confirmed.schedule,
    tool,
    runOn,
    toolExplicit: confirmed.toolExplicit,
    outputPath: '~/out',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    action: confirmed.action,
    ...(confirmed.orchestrationSteps && confirmed.orchestrationSteps.length >= 2 ? { orchestration: { steps: confirmed.orchestrationSteps } } : {}),
    ...(confirmed.roleRef ? { roleRef: confirmed.roleRef } : {}),
  } as Agent;
  const plan = buildAgentPlanSpec(agent, storedPlanSpecOpts(agent, ENV));
  return { confirmed, agent, plan, route: decideAttendedRoute({ agent, planText: JSON.stringify(plan), env: ENV }) };
}

describe('compete: "have both implementers … and compare" → executor cli=2', () => {
  const draft = nlToRouted('Right now, have both implementers build a brick breaker game in ~/demo and compare', loaded(IMPL, REV, BUILDER), { role_impl: 'all', role_build: 'standard' });

  it('chat confirm, never auto-registered, typed OK required', () => {
    expect(shouldUseChatConfirm(draft)).toBe(true);
    expect(isAutoRegisterEligibleDraft(draft)).toBe(false);
    expect(hasDraftAssumptions(draft)).toBe(true);
  });

  it('confirm text: role · engine lines on one parallel line, workspace, level, opt-out hint', () => {
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain('Assigned to your roles:');
    const line = text.split('\n').find((l) => /^1\. /.test(l)) ?? '';
    expect(line).toBe('1. In parallel: [Implementer · Codex CLI] build a brick breaker game in ~/demo / [Builder · Claude Code] build a brick breaker game in ~/demo');
    expect(text).toMatch(/^2\. Compare the implementations above/m);
    expect(text).toContain('Workspace: ~/demo');
    expect(text).toContain('Run without approval: standard (the lowest of the roles' settings: Implementer=all, Builder=standard)');
    expect(text).toContain('To set it up without roles, reply "without roles".');
  });

  it('confirm → PlanSpec → attended route: executor with cli=2, roles in the plan', () => {
    const { confirmed, plan, route } = install(draft);
    expect(confirmed.roleLevelRoles?.map((r) => r.id)).toEqual(['role_impl', 'role_build']);
    expect(confirmed.roleRef).toBeUndefined();
    expect((plan as unknown as { tool: { type: string } }).tool.type).toBe('local');
    const list = (plan.steps as { list: Array<{ parallelGroup?: string; role?: { name: string } }> }).list;
    expect(list.map((s) => s.parallelGroup)).toEqual(['r1', 'r1', undefined]);
    expect(list.map((s) => s.role?.name)).toEqual(['Implementer', 'Builder', undefined]);
    expect(route).toMatchObject({ route: 'executor', cliSteps: 2, groupCount: 1 });
    expect(route.reason).toMatch(/cli=2$/);
  });
});

describe('implement + auto-attached review → serial chain', () => {
  it.each([
    ['EN', 'Right now, build a brick breaker game in ~/demo', [IMPL, REV], ['Implementer', 'Reviewer']],
    ['EN named', 'have the implementer build a snake game in ~/demo and the reviewer check it', [IMPL, REV], ['Implementer', 'Reviewer']],
    ['JA', '今すぐ、~/demoにブロック崩しゲームを作って', [JA_IMPL, JA_REV], ['実装役', 'レビュー役']],
  ])('%s', (_l, utterance, roles, names) => {
    const draft = nlToRouted(utterance as string, loaded(...(roles as AgentRole[])));
    const steps = objSteps(draft.orchestrationSteps);
    expect(steps.map((s) => s.role?.name)).toEqual([...(names as string[]), undefined]);
    const { route, agent } = install(draft);
    expect(route.route).toBe('serial');
    expect(route.reason).toBe('no effective parallel group');
    expect(agent.tool).toEqual({ type: 'local' });
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toMatch(/^1\. \[(?:Implementer|実装役) · Codex CLI\] /m);
    expect(text).toMatch(/^2\. \[(?:Reviewer|レビュー役) · Claude Code\] /m);
  });

  it('a routed agent never runs on the .sh codex chain (canRunOrchestrationChain false)', () => {
    const draft = nlToRouted('Right now, build a brick breaker game in ~/demo', loaded(IMPL, REV));
    const { agent } = install(draft);
    // Even with a CLI agent tool, role steps collapse the bash chain.
    const asCli = { ...agent, tool: { type: 'cli', cli: 'codex' } } as Agent;
    expect(generateRunScript(asCli)).toContain('[Shelly] Note: this agent is configured as a 3-step chain');
    const roleless = {
      ...asCli,
      orchestration: { steps: asCli.orchestration!.steps.map((s) => (typeof s === 'string' ? s : (({ role: _r, ...rest }) => rest)(s))) },
    } as Agent;
    expect(generateRunScript(roleless)).not.toContain('[Shelly] Note: this agent is configured as a 3-step chain');
  });
});

describe('single role', () => {
  it('single unit → single-step agent on the role engine with roleRef', () => {
    const draft = nlToRouted('Right now, build a brick breaker game in ~/demo', loaded(IMPL), { role_impl: 'standard' });
    const { confirmed, agent } = install(draft);
    expect(agent.tool).toEqual({ type: 'cli', cli: 'codex' });
    expect(agent.orchestration).toBeUndefined();
    expect(agent.prompt.startsWith('# Your role\nImplementer: ')).toBe(true);
    expect(confirmed.roleRef).toEqual({ id: 'role_impl', name: 'Implementer' });
    const text = summarizeAgentDraftAsText(draft);
    expect(text).toContain('Role: Implementer · Codex CLI');
    expect(text).toContain('Run without approval: standard (the lowest of the roles' settings: Implementer=standard)');
    expect(text).not.toMatch(/^Engine: /m);
  });

  it('a terminal-request draft never carries role levels', () => {
    const d = routeDraftToRoles(parseAgentNL('Right now, build a brick breaker game in ~/demo'), loaded(IMPL), { levels: levels({ role_impl: 'all' }), source: 'terminal-request' }).draft;
    expect(draftToConfirmedAgentDraft(d).roleLevelRoles).toBeUndefined();
    expect(summarizeAgentDraftAsText(d)).toContain('role levels are only applied to agents you set up by typing in this chat');
    const typed = nlToRouted('Right now, build a brick breaker game in ~/demo', loaded(IMPL), { role_impl: 'all' });
    expect(draftToConfirmedAgentDraft({ ...typed, terminalRequestId: 'req-1' }).roleLevelRoles).toBeUndefined();
    expect(draftToConfirmedAgentDraft({ ...typed, monitorTeamToken: 'tok' }).roleLevelRoles).toBeUndefined();
  });

  it('an explicit level phrase in the request wins (the existing line, no role level line)', () => {
    const draft = nlToRouted('Right now, build a brick breaker game in ~/demo and run without approval', loaded(IMPL), { role_impl: 'all' });
    expect(draft.runWithoutApproval).toBe(true);
    const text = summarizeAgentDraftAsText(draft);
    expect(text).not.toContain("the lowest of the roles' settings");
    expect(draftToConfirmedAgentDraft(draft).runWithoutApproval).toBe(true);
  });
});

describe('on-device utterances reach the create branch (not a role edit / question)', () => {
  it.each([
    'Right now, build a brick breaker game in ~/demo',
    'Right now, have both implementers build a brick breaker game in ~/demo and compare',
    'have the implementer build a snake game in ~/demo and the reviewer check it',
    'Right now, build a snake game in ~/demo with my roles',
    '今すぐ、ロールで~/demoにブロック崩しゲームを作って',
    '今すぐ、実装役が~/demoにスネークゲームを作って、レビュー役が確認して',
    'Right now, build a brick breaker game in ~/demo without roles',
  ])('%s', (u) => {
    expect(detectRoleIntent(u)).toBeNull();
    expect(isCapabilityQuestionForAgentFlow(u)).toBe(false);
  });

  it('implicit trigger words', () => {
    expect(mentionsTeamWords('今すぐ、ロールで~/demoにブロック崩しゲームを作って')).toBe(true);
    expect(mentionsTeamWords('Right now, build a snake game in ~/demo with my roles')).toBe(true);
    expect(mentionsRoleName('have the implementer build a snake game in ~/demo and the reviewer check it', [IMPL, REV])).toBe(true);
    expect(mentionsTeamWords('Right now, build a brick breaker game in ~/demo')).toBe(false);
    expect(mentionsRoleName('Right now, build a brick breaker game in ~/demo', [IMPL, REV])).toBe(false);
  });
});

describe('regression: explicit-tool Inc4 request is not routed', () => {
  it('still Codex ∥ Claude Code pinned, executor cli=2, no roles', () => {
    const u = 'Right now, in parallel, using Codex list 3 improvement ideas for ~/demo/src/task.ts, using Claude Code explain how to fix the type errors in ~/demo/user.ts, then combine the two results into one memo';
    const r = routeDraftToRoles(parseAgentNL(u), loaded(IMPL, REV, BUILDER), { levels: levels(), source: 'chat' });
    expect(r.info).toBeNull();
    expect(r.draft.roleRouting).toBeUndefined();
    const { route, plan } = install(r.draft);
    expect(route).toMatchObject({ route: 'executor', cliSteps: 2 });
    const list = (plan.steps as { list: Array<{ role?: unknown }> }).list;
    expect(list.every((s) => s.role === undefined)).toBe(true);
    expect(summarizeAgentDraftAsText(r.draft)).not.toContain('Assigned to your roles');
  });
});
