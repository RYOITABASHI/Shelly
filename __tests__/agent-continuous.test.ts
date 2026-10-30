/**
 * Continuous mode Increment 1 (DEFERRED.md 継続モード): config defaults +
 * Kotlin parity, NL registration (JA/EN, zero new questions), the summary
 * line, the ¥0 provider policy (router / ladder / PlanSpec), the arming of a
 * loop, and the MONITOR checkpoint reader + iteration line.
 */
jest.mock('@/modules/terminal-emulator/src/TerminalEmulatorModule', () => ({
  __esModule: true,
  default: { scheduleAgent: jest.fn(), cancelAgent: jest.fn() },
}));
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));
jest.mock('expo-notifications', () => ({}));
jest.mock('expo-file-system/legacy', () => ({}));

import * as fs from 'fs';
import * as path from 'path';
import TerminalEmulator from '@/modules/terminal-emulator/src/TerminalEmulatorModule';
import {
  CONTINUOUS_CONSECUTIVE_FAILURE_LIMIT,
  CONTINUOUS_DEFAULT_COOLDOWN_MS,
  CONTINUOUS_DEFAULT_MAX_ITERATIONS,
  CONTINUOUS_DEFAULT_MAX_WALL_MS,
  CONTINUOUS_DONE_STREAK_TO_STOP,
  CONTINUOUS_HARD_MAX_ITERATIONS,
  CONTINUOUS_HARD_MAX_WALL_MS,
  CONTINUOUS_MAX_COOLDOWN_MS,
  CONTINUOUS_MAX_DAILY_BUDGET_JPY,
  CONTINUOUS_MIN_COOLDOWN_MS,
  CONTINUOUS_MIN_MAX_WALL_MS,
  PAID_API_TOOL_TYPES,
  mergeContinuousOnEdit,
  applyContinuousProviderPolicy,
  formatContinuousSummary,
  normalizeContinuousConfig,
  parseContinuousCheckpoint,
  parseContinuousIntent,
} from '@/lib/agent-continuous';
import { parseAgentNL, isContinuousDraft, isManualTriggerDraft } from '@/lib/agent-nl-parser';
import { nextMissingSlot } from '@/lib/agent-slot-fill';
import { draftToConfirmedAgentDraft, hasDraftAssumptions, summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { resolveEscalationLadder } from '@/lib/agent-escalation-ladder';
import { resolveAgentRoute } from '@/lib/agent-tool-router';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { continuousFirstTriggerMs, installSchedule } from '@/lib/agent-scheduler';
import { liveLoopText } from '@/lib/monitor-live';
import { applyPollResults, buildPollCommand, createPollMemo, parsePollOutput, selectPollTargets } from '@/lib/monitor-live-poll';
import en from '@/lib/i18n/locales/en';
import ja from '@/lib/i18n/locales/ja';
import type { Agent } from '@/store/types';
import { withContinuousDiskState } from '@/lib/agent-manager';
import { agentToParsedAgentDraft } from '@/lib/agent-draft-patch';
import { useAgentStore } from '@/store/agent-store';

const root = path.resolve(__dirname, '..');
const KOTLIN = path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/ContinuousStopPolicy.kt');

function agentWith(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-loop',
    name: 'Loop',
    description: '',
    prompt: 'ローカルLLMで日本の四季について書いて',
    schedule: null,
    tool: { type: 'auto' },
    outputPath: '$HOME/agent-output/loop.md',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 1,
    version: 1,
    continuous: normalizeContinuousConfig({ cooldownMs: 5 * 60_000, loopStartedAt: 1_000 }),
    ...overrides,
  };
}

describe('constants mirror ContinuousStopPolicy.kt', () => {
  const kt = fs.readFileSync(KOTLIN, 'utf8');
  const kotlinConst = (name: string): number => {
    const m = new RegExp(`const val ${name} = ([^\\n]+)`).exec(kt);
    if (!m) throw new Error(`missing ${name}`);
    // eslint-disable-next-line no-new-func
    return Function(`return (${m[1].replace(/L\b/g, '').replace(/_/g, '')})`)() as number;
  };
  it.each([
    ['DEFAULT_COOLDOWN_MS', CONTINUOUS_DEFAULT_COOLDOWN_MS],
    ['MIN_COOLDOWN_MS', CONTINUOUS_MIN_COOLDOWN_MS],
    ['MAX_COOLDOWN_MS', CONTINUOUS_MAX_COOLDOWN_MS],
    ['DEFAULT_MAX_ITERATIONS', CONTINUOUS_DEFAULT_MAX_ITERATIONS],
    ['HARD_MAX_ITERATIONS', CONTINUOUS_HARD_MAX_ITERATIONS],
    ['DEFAULT_MAX_WALL_MS', CONTINUOUS_DEFAULT_MAX_WALL_MS],
    ['MIN_MAX_WALL_MS', CONTINUOUS_MIN_MAX_WALL_MS],
    ['HARD_MAX_WALL_MS', CONTINUOUS_HARD_MAX_WALL_MS],
    ['MAX_DAILY_BUDGET_JPY', CONTINUOUS_MAX_DAILY_BUDGET_JPY],
    ['CONSECUTIVE_FAILURE_LIMIT', CONTINUOUS_CONSECUTIVE_FAILURE_LIMIT],
    ['DONE_STREAK_TO_STOP', CONTINUOUS_DONE_STREAK_TO_STOP],
  ])('%s', (name, value) => {
    expect(kotlinConst(name)).toBe(value);
  });

  it('paid tool set matches the executor', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const exec = require('../scripts/shelly-plan-executor.js');
    expect([...exec.CONTINUOUS_PAID_TOOL_TYPES].sort()).toEqual([...PAID_API_TOOL_TYPES].sort());
  });
});

describe('normalizeContinuousConfig', () => {
  it('fills the defaults (50 iterations, 24h, ¥0, 5 min)', () => {
    expect(normalizeContinuousConfig({})).toEqual({
      cooldownMs: 5 * 60_000,
      maxIterations: 50,
      maxWallMs: 24 * 3_600_000,
      goalCheck: false,
      dailyBudgetJpy: 0,
    });
  });
  it('clamps (cooldown >= 1 min, hard caps, no negative budget)', () => {
    const c = normalizeContinuousConfig({ cooldownMs: 1000, maxIterations: 99999, maxWallMs: 1e12, dailyBudgetJpy: -3 });
    expect(c.cooldownMs).toBe(60_000);
    expect(c.maxIterations).toBe(1000);
    expect(c.maxWallMs).toBe(7 * 24 * 3_600_000);
    expect(c.dailyBudgetJpy).toBe(0);
  });
});

describe('NL: continuous intent (JA / EN)', () => {
  it.each([
    ['ローカルLLMでブログ記事を改善して、止めるまで続けて', 5 * 60_000, false],
    ['ずっと続けて、ニュースを集めて要約して', 5 * 60_000, false],
    ['1時間ごとに続けて、READMEを改善して', 3_600_000, false],
    ['30分おきに続けて、テストを増やして', 30 * 60_000, false],
    ['ドキュメントの翻訳を完了するまで続けて', 5 * 60_000, true],
    ['この調査が終わるまで', 5 * 60_000, true],
    ['improve the README, keep going until I stop it', 5 * 60_000, false],
    ['every hour, keep going and summarize the logs', 3_600_000, false],
    ['translate the docs until it is done', 5 * 60_000, true],
  ])('%s', (text, cooldownMs, goalCheck) => {
    const intent = parseContinuousIntent(text);
    expect(intent).not.toBeNull();
    expect(intent!.cooldownMs).toBe(cooldownMs);
    expect(intent!.goalCheck).toBe(goalCheck);
  });

  it.each([
    '会議が終わるまでに議事録を要約して',
    '毎朝8時にニュースを要約して',
    '会議が終わるまで待って要約して',
    'summarize the news every morning at 8',
  ])('not a loop: %s', (text) => {
    expect(parseContinuousIntent(text)).toBeNull();
  });
});

describe('NL registration: zero new questions, defaults in the summary line', () => {
  it('「止めるまで続けて」 → continuous loop, no schedule, phrase stripped from the task', () => {
    const draft = parseAgentNL('ローカルLLMでブログ記事の改善案を出して、止めるまで続けて', []);
    expect(draft.continuous).toEqual({ cooldownMs: 5 * 60_000 });
    expect(draft.schedule).toBeNull();
    expect(draft.scheduleConfident).toBe(true);
    expect(isContinuousDraft(draft)).toBe(true);
    expect(isManualTriggerDraft(draft)).toBe(false);
    expect(draft.prompt).not.toContain('止めるまで');
    expect(draft.prompt).toContain('ブログ記事の改善案');
    // No schedule question (the loop IS the trigger); with an output folder
    // configured there is no question at all.
    expect(nextMissingSlot(draft, {})?.field).not.toBe('schedule');
    expect(nextMissingSlot(draft, { agentVaultPath: '/sdcard/Vault' })).toBeNull();
    const summary = summarizeAgentDraftAsText(draft);
    expect(summary).toContain('止めるまで続けます（最大50回・24時間・有料APIなし・5分おき）');
    expect(summary).not.toContain(ja['agentplan.manual_trigger_note']);
    // An unattended loop always gets one human confirm before it registers.
    expect(hasDraftAssumptions(draft)).toBe(true);
  });

  it('「1時間ごとに続けて」 → 1h cooldown, never a cron', () => {
    const draft = parseAgentNL('1時間ごとに続けて、ローカルLLMでREADMEの改善点を挙げて', []);
    expect(draft.continuous).toEqual({ cooldownMs: 3_600_000 });
    expect(draft.schedule).toBeNull();
    expect(draft.prompt).not.toMatch(/1時間ごと|続けて/);
    expect(summarizeAgentDraftAsText(draft)).toContain('1時間おき');
  });

  it('「完了するまで続けて」 → goalCheck', () => {
    const draft = parseAgentNL('ドキュメントの英訳を完了するまで続けて', []);
    expect(draft.continuous).toEqual({ cooldownMs: 5 * 60_000, goalCheck: true });
    expect(summarizeAgentDraftAsText(draft)).toContain('完了するまで続けます（最大50回・24時間・有料APIなし・5分おき）');
  });

  it('EN: "keep going until I stop it" / "every 30 minutes, keep going"', () => {
    const a = parseAgentNL('Improve the README with the local LLM, keep going until I stop it', []);
    expect(a.continuous).toEqual({ cooldownMs: 5 * 60_000 });
    expect(a.prompt).not.toMatch(/keep going|until I stop/i);
    expect(summarizeAgentDraftAsText(a)).toContain('Keeps going until you stop it (max 50 runs · 24 h · no paid API · every 5 min)');
    const b = parseAgentNL('every 30 minutes, keep going and list new test ideas', []);
    expect(b.continuous).toEqual({ cooldownMs: 30 * 60_000 });
    expect(b.schedule).toBeNull();
  });

  it('confirmed draft carries the loop and is never the ephemeral one-shot', () => {
    const draft = parseAgentNL('ローカルLLMでブログ記事の改善案を出して、止めるまで続けて', []);
    const confirmed = draftToConfirmedAgentDraft(draft);
    expect(confirmed.continuous).toEqual({ cooldownMs: 5 * 60_000 });
    expect(confirmed.schedule).toBeNull();
  });

  it('an ordinary utterance is unchanged (no continuous field)', () => {
    const draft = parseAgentNL('毎朝8時にニュースを要約して', []);
    expect(draft.continuous).toBeUndefined();
    expect(draft.schedule).toBe('0 8 * * *');
  });

  it('summary keys exist in both locales', () => {
    for (const key of Object.keys(en).filter((k) => k.startsWith('continuous.') || k.startsWith('monitor.live.loop_'))) {
      expect(ja[key]).toBeTruthy();
    }
    expect(formatContinuousSummary({ cooldownMs: 3_600_000, maxWallMs: 3 * 86_400_000 }, 'en')).toBe(
      'Keeps going until you stop it (max 50 runs · 3 days · no paid API · every 1 h)',
    );
  });
});

describe('provider policy: ¥0 budget → local → Codex, never a paid API', () => {
  const env = { hasCerebrasKey: true, hasGroqKey: true };

  it('attended ladder drops Cerebras / Groq / a paid primary', () => {
    const ladder = resolveEscalationLadder(agentWith({ tool: { type: 'perplexity' } }), env);
    expect(ladder.tools.some((t) => PAID_API_TOOL_TYPES.has(t.type))).toBe(false);
    expect(ladder.tools.length).toBeGreaterThan(0);
    // Without continuous the same agent keeps its paid rungs.
    const plain = resolveEscalationLadder(agentWith({ tool: { type: 'perplexity' }, continuous: undefined }), env);
    expect(plain.tools.some((t) => PAID_API_TOOL_TYPES.has(t.type))).toBe(true);
  });

  it('a configured paid tool routes to local (or Codex for a web-mandatory task)', () => {
    expect(resolveAgentRoute(agentWith({ tool: { type: 'groq' } })).tool.type).toBe('local');
    const web = resolveAgentRoute(agentWith({ tool: { type: 'gemini-api' }, prompt: '最新のAIニュースを集めて' }));
    expect(web.tool.type).toBe('cli');
    expect(web.decision.why).toContain('continuous mode');
  });

  it('an explicit daily budget keeps paid APIs allowed', () => {
    const paid = agentWith({ tool: { type: 'groq' }, continuous: normalizeContinuousConfig({ dailyBudgetJpy: 300 }) });
    expect(resolveAgentRoute(paid).tool.type).toBe('groq');
  });

  it('PlanSpec: continuous block present, no paid tool / ladder rung / step pin', () => {
    const agent = agentWith({
      tool: { type: 'perplexity' },
      orchestration: { steps: [{ instruction: '集めて', tool: { type: 'perplexity' } }, { instruction: '要約して', tool: { type: 'local' } }] },
    });
    const plan = buildAgentPlanSpec(agent, env);
    expect(plan.continuous).toEqual({ goalCheck: false, dailyBudgetJpy: 0, loopStartedAt: 1_000 });
    expect(PAID_API_TOOL_TYPES.has(plan.tool.type)).toBe(false);
    expect((plan.toolLadder ?? []).some((t) => PAID_API_TOOL_TYPES.has(t.type))).toBe(false);
    expect(plan.steps?.list.some((s) => s.tool && PAID_API_TOOL_TYPES.has(s.tool.type))).toBe(false);
    expect(buildAgentPlanSpec(agentWith({ continuous: undefined })).continuous).toBeUndefined();
  });

  it('applyContinuousProviderPolicy is a no-op for ordinary agents', () => {
    const plain = agentWith({ tool: { type: 'perplexity' }, continuous: undefined });
    expect(applyContinuousProviderPolicy(plain)).toBe(plain);
  });
});

describe('arming a loop', () => {
  beforeEach(() => (TerminalEmulator.scheduleAgent as jest.Mock).mockClear());

  it('fresh loop fires in 5s with intervalMs = cooldown and no cron', async () => {
    const now = 10_000_000;
    await installSchedule(agentWith(), now);
    expect(TerminalEmulator.scheduleAgent).toHaveBeenCalledWith('agent-loop', 5 * 60_000, now + 5_000, null);
  });

  it('a repair / resume never shortcuts the cooldown after the last run', () => {
    const now = 10_000_000;
    expect(continuousFirstTriggerMs(agentWith({ lastRun: now - 60_000 }), now)).toBe(now - 60_000 + 5 * 60_000);
    expect(continuousFirstTriggerMs(agentWith({ lastRun: now - 3_600_000 }), now)).toBe(now + 5_000);
  });

  it('a disabled loop is not armed', async () => {
    await installSchedule(agentWith({ enabled: false }));
    expect(TerminalEmulator.scheduleAgent).not.toHaveBeenCalled();
  });
});

describe('native stop is reconciled from disk (never revived by a stale snapshot)', () => {
  beforeEach(() => useAgentStore.getState().setAgents([agentWith()]));

  it('adopts enabled:false from the agent json for the same loop', async () => {
    const runCommand = jest.fn(async () => JSON.stringify({ id: 'agent-loop', enabled: false, continuous: { loopStartedAt: 1_000 } }));
    const result = await withContinuousDiskState(agentWith(), runCommand);
    expect(result.enabled).toBe(false);
    expect(useAgentStore.getState().agents[0].enabled).toBe(false);
  });

  it('race: a user re-enable (new loop) during the disk read is never overwritten', async () => {
    const runCommand = jest.fn(async () => {
      // The user re-enables while the stale disk read is in flight.
      useAgentStore.getState().updateAgent('agent-loop', {
        enabled: true,
        continuous: normalizeContinuousConfig({ cooldownMs: 5 * 60_000, loopStartedAt: 2_000 }),
      });
      return JSON.stringify({ id: 'agent-loop', enabled: false, continuous: { loopStartedAt: 1_000 } });
    });
    const result = await withContinuousDiskState(agentWith(), runCommand);
    expect(result.enabled).toBe(true);
    expect(useAgentStore.getState().agents[0].enabled).toBe(true);
  });

  it('a disk stop without a matching loop id is not adopted', async () => {
    const runCommand = jest.fn(async () => JSON.stringify({ id: 'agent-loop', enabled: false }));
    expect((await withContinuousDiskState(agentWith(), runCommand)).enabled).toBe(true);
  });

  it('keeps an enabled loop when disk agrees / has no file yet; ignores ordinary agents', async () => {
    expect((await withContinuousDiskState(agentWith(), jest.fn(async () => JSON.stringify({ id: 'agent-loop', enabled: true })))).enabled).toBe(true);
    expect((await withContinuousDiskState(agentWith(), jest.fn(async () => ''))).enabled).toBe(true);
    const runCommand = jest.fn(async () => '');
    await withContinuousDiskState(agentWith({ continuous: undefined }), runCommand);
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe('native wiring (source checks; Kotlin has no CI unit-test task)', () => {
  const dir = path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator');
  const service = fs.readFileSync(path.join(dir, 'TerminalSessionService.kt'), 'utf8');
  const runtime = fs.readFileSync(path.join(dir, 'AgentRuntime.kt'), 'utf8');
  const loop = fs.readFileSync(path.join(dir, 'ContinuousLoop.kt'), 'utf8');

  it('a loop that stopped being continuous mid-run is never re-armed as an interval agent', () => {
    const start = service.indexOf('Continuous mode: the same circuit breaker');
    const branch = service.slice(start, service.indexOf('} else if (intervalMs > 0 || !cron.isNullOrBlank())', start));
    const nullCase = branch.slice(branch.indexOf('if (config == null)'), branch.indexOf('} else {', branch.indexOf('if (config == null)')));
    expect(nullCase).not.toContain('scheduleNext');
    expect(nullCase).toContain('cancelRunningNotification');
  });

  it('the Stop marker only silences a run it was written during', () => {
    expect(runtime).toContain('ContinuousStopPolicy.markerApplies(marker.lastModified(), runStartedAtMs)');
    expect(runtime).toContain('stoppedByKillSwitch(homeDir, agentId, exitCode, runStartedAtMs)');
  });

  it('the kill fallback only matches this agent\'s executor; stops are sticky', () => {
    expect(loop).toContain('ContinuousStopPolicy.isOwnExecutorCmdline(cmdline(pid), agentId)');
    expect(loop).not.toMatch(/cmdline\(pid\)\.contains\("shelly-plan-executor"\)/);
    expect(loop).toContain('recordedStop = ContinuousStopPolicy.recordedStop(');
  });
});

describe('editing a loop keeps the SAME loop', () => {
  const existing = normalizeContinuousConfig({
    cooldownMs: 30 * 60_000,
    maxIterations: 10,
    maxWallMs: 3 * 3_600_000,
    dailyBudgetJpy: 200,
    loopStartedAt: 1_000,
  });

  it('a rename / task edit keeps limits, budget and loopStartedAt', () => {
    expect(mergeContinuousOnEdit(existing, { cooldownMs: 30 * 60_000 }, 99_000)).toEqual(existing);
  });

  it('a cooldown change restarts the loop clock but keeps the custom limits', () => {
    const merged = mergeContinuousOnEdit(existing, { cooldownMs: 3_600_000 }, 99_000);
    expect(merged).toMatchObject({ cooldownMs: 3_600_000, maxIterations: 10, maxWallMs: 3 * 3_600_000, dailyBudgetJpy: 200, loopStartedAt: 99_000 });
  });

  it('a new loop starts now with defaults', () => {
    expect(mergeContinuousOnEdit(undefined, { cooldownMs: 5 * 60_000 }, 7_000)).toMatchObject({ maxIterations: 50, loopStartedAt: 7_000 });
  });

  it('the confirm path merges onto the edited agent; the service keeps live loop notifications', () => {
    const dispatch = fs.readFileSync(path.join(root, 'hooks/use-ai-pane-dispatch.ts'), 'utf8');
    expect(dispatch).toContain('mergeContinuousOnEdit(editingAgent?.continuous, confirmed.continuous)');
    const service = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/TerminalSessionService.kt'), 'utf8');
    expect(service).toContain('ContinuousLoop.cancelStaleRunningNotifications(applicationContext)');
    expect(service).not.toContain('cancelAllRunningNotifications');
  });
});

describe('editing a loop keeps it a loop', () => {
  it('agentToParsedAgentDraft preserves continuous (not manual)', () => {
    const draft = agentToParsedAgentDraft(agentWith({ continuous: normalizeContinuousConfig({ cooldownMs: 3_600_000, goalCheck: true }) }));
    expect(draft.continuous).toEqual({ cooldownMs: 3_600_000, goalCheck: true });
    expect(draft.trigger).toBeUndefined();
    expect(isContinuousDraft(draft)).toBe(true);
    expect(agentToParsedAgentDraft(agentWith({ continuous: undefined })).trigger).toBe('manual');
  });
});

describe('MONITOR: checkpoint reader + iteration line', () => {
  const t = (key: string, params?: Record<string, string | number>) => {
    let text = en[key] ?? key;
    for (const [k, v] of Object.entries(params ?? {})) text = text.replace(`{{${k}}}`, String(v));
    return text;
  };

  it('fails closed on anything but a v1 checkpoint', () => {
    expect(parseContinuousCheckpoint('{garbage')).toBeNull();
    expect(parseContinuousCheckpoint('{"v":2,"iteration":3}')).toBeNull();
    expect(parseContinuousCheckpoint('')).toBeNull();
    expect(parseContinuousCheckpoint('{"v":1,"iteration":3,"stoppedReason":"nope"}')).toEqual({ iteration: 3, startedAt: null, nextAction: '' });
  });

  it('shows "iteration N" and the stop reason', () => {
    expect(liveLoopText(parseContinuousCheckpoint('{"v":1,"iteration":4}'), t)).toBe('LOOP · iteration 4');
    expect(liveLoopText(parseContinuousCheckpoint('{"v":1,"iteration":50,"stoppedReason":"max_iterations","stoppedAt":5}'), t)).toBe(
      'LOOP · iteration 50 · Loop stopped: maximum runs reached',
    );
    expect(liveLoopText(null, t)).toBeNull();
  });

  it('polls checkpoint.json only for loop agents, and only reads it when it changed', () => {
    const memo = createPollMemo();
    const state = {
      agents: [
        { id: 'agent-loop', lastRun: 2, continuous: normalizeContinuousConfig({}) },
        { id: 'agent-plain', lastRun: 1 },
      ],
      runningAgentIds: [],
      liveRuns: {},
    };
    const targets = selectPollTargets(state, memo);
    expect(targets.find((x) => x.agentId === 'agent-loop')?.readCheckpoint).toBe(true);
    expect(targets.find((x) => x.agentId === 'agent-plain')?.readCheckpoint).toBeUndefined();
    const cmd = buildPollCommand(targets);
    expect(cmd).toContain('for i in agent-loop; do [ -f "$L/$i/checkpoint.json" ]');
    expect(cmd).toContain('C agent-loop');
    expect(cmd).not.toContain('C agent-plain');

    const loops: Record<string, unknown> = {};
    const store = {
      upsertLiveRuns: jest.fn(),
      setLiveRunSavedPath: jest.fn(),
      getLiveRuns: () => ({}),
      setLiveLoop: jest.fn((id: string, view: unknown) => {
        loops[id] = view;
      }),
    };
    const out =
      '@@SHELLY_MON@@ P agent-loop none data\n\n' +
      '@@SHELLY_MON@@ C agent-loop 170.55 data\n{"v":1,"iteration":7}\n' +
      '@@SHELLY_MON@@ P agent-plain none data\n\n';
    applyPollResults(parsePollOutput(out), targets, memo, store);
    expect(loops['agent-loop']).toMatchObject({ iteration: 7 });
    expect(memo.checkpointSigs?.get('agent-loop')).toBe('170.55');
    // Next poll knows the signature; an unchanged file is not re-read.
    const again = selectPollTargets(state, memo);
    expect(buildPollCommand(again)).toContain('"170.55"');
    store.setLiveLoop.mockClear();
    applyPollResults(parsePollOutput('@@SHELLY_MON@@ C agent-loop 170.55 same\n'), again, memo, store);
    expect(store.setLiveLoop).not.toHaveBeenCalled();
  });
});
