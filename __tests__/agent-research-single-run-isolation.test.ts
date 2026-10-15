/**
 * P1 decision (2026-10-15): the research-intent consent extension does not
 * widen exposure.
 *  - A notification-triggered autonomous agent never gets it (attacker-
 *    controlled input): pre-branch rule (needsWeb by route only), otherwise
 *    the existing refusal.
 *  - An autonomous research-intent single run (covered only by the
 *    extension) sends task text + language directive only: no
 *    NOTIFICATION_CONTEXT, no memory recall; device status only when the task
 *    asks for it.
 */
jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { generateRunScript } from '@/lib/agent-executor';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { resolveEscalationLadder } from '@/lib/agent-escalation-ladder';
import { consentSignalsFor } from '@/lib/agent-credential-policy';
import { describeDraftTool, resolveAutonomousFinalTool } from '@/lib/agent-tool-router';
import type { Agent, ToolChoice } from '@/store/types';

const PPLX: ToolChoice = { type: 'perplexity', model: 'sonar-deep-research' };
const MEMORY = '# Memory\n- private note: my bank is X';
const TASK = 'パープレで量子計算について調べて';

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'p1',
  name: 'p1',
  description: '',
  prompt: `${MEMORY}\n\n---\n\n${TASK}`,
  schedule: '0 8 * * *',
  tool: PPLX,
  autonomous: true,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  ...over,
});
const TRIGGER = { notificationTrigger: { packageNames: ['com.google.android.gm'] } };

describe('notification-triggered agents keep the pre-branch consent rule', () => {
  it('consentSignalsFor drops the research extension only for notification triggers', () => {
    const sig = { needsWeb: false, needsSearch: true, collects: true };
    expect(consentSignalsFor({}, sig)).toEqual(sig);
    expect(consentSignalsFor(TRIGGER, sig)).toEqual({ needsWeb: false });
  });

  it('.sh refuses (existing refusal) a research-only Perplexity agent with a notification trigger', () => {
    const s = generateRunScript(agent(TRIGGER), { autonomousCloudConsent: true });
    expect(s).toContain('[REFUSED]');
    expect(s).not.toContain('https://api.perplexity.ai/chat/completions');
  });

  it('a web-mandatory notification-triggered task still uses Perplexity (pre-branch behaviour)', () => {
    const s = generateRunScript(agent({ ...TRIGGER, prompt: 'パープレで最新のAIニュースを集めて' }), { autonomousCloudConsent: true });
    expect(s).not.toContain('[REFUSED]');
  });

  it('ladder, PlanSpec and the confirm resolver agree', () => {
    const l = resolveEscalationLadder(agent(TRIGGER), { hasCerebrasKey: true, hasGroqKey: true, autonomousCloudConsent: true });
    expect(l.tools.map((t) => t.type)).toEqual(['cli']);
    expect(buildAgentPlanSpec(agent(TRIGGER), { autonomousCloudConsent: true }).tool.type).toBe('unsupported');
    expect(resolveAutonomousFinalTool(true, PPLX, true, false, false)).toEqual({ type: 'cli', cli: 'codex' });
    expect(describeDraftTool({ tool: PPLX, toolExplicit: true, autonomous: true, prompt: TASK, ...TRIGGER }, true).substitution?.reason).toBe('scope');
  });
});

describe('post-merge review M1/M2: which runs are isolated', () => {
  it('M1: an attended single "Run now" stays isolated; only an attended per-step materialize is exempt', () => {
    const attendedSingle = generateRunScript(agent(), { autonomousCloudConsent: true, attended: true });
    expect(attendedSingle).toContain('ISOLATE_RESEARCH_PROMPT=1');
    expect(attendedSingle).not.toContain('private note');
    const attendedStep = generateRunScript(agent(), { autonomousCloudConsent: true, attended: true, isOrchestratedStep: true });
    expect(attendedStep).toContain('ISOLATE_RESEARCH_PROMPT=0');
  });

  it('M2: the collapse-to-single .sh fallback of an orchestrated agent is isolated too', () => {
    const s = generateRunScript(
      agent({ orchestration: { steps: ['パープレで量子計算の論文を集めて', 'まとめて'] } }),
      { autonomousCloudConsent: true },
    );
    expect(s).toContain('ISOLATE_RESEARCH_PROMPT=1');
    expect(s).not.toContain('private note');
  });
});

describe('research-intent single runs send an isolated prompt', () => {
  const s = generateRunScript(agent(), { autonomousCloudConsent: true });

  it('task text + directive only: no memory, notification context cleared', () => {
    expect(s).not.toContain('[REFUSED]');
    expect(s).toContain('https://api.perplexity.ai/chat/completions');
    expect(s).toContain(TASK);
    expect(s).not.toContain('private note');
    expect(s).toContain('ISOLATE_RESEARCH_PROMPT=1');
    expect(s).toMatch(/if \[ "\$\{ISOLATE_RESEARCH_PROMPT:-0\}" = "1" \]; then\n {2}NOTIFICATION_CONTEXT=""\nfi/);
    expect(s).toContain('DEVICE_STATUS_RELEVANT=0');
  });

  it('device status only when the task itself asks for it (not because memory mentions it)', () => {
    const memBattery = generateRunScript(agent({ prompt: `# Memory\n- battery was low\n\n---\n\n${TASK}` }), { autonomousCloudConsent: true });
    expect(memBattery).toContain('DEVICE_STATUS_RELEVANT=0');
    const taskBattery = generateRunScript(agent({ prompt: 'パープレでバッテリー技術の論文を調べて' }), { autonomousCloudConsent: true });
    expect(taskBattery).toContain('DEVICE_STATUS_RELEVANT=1');
  });

  it('web-mandatory runs and non-autonomous runs are unchanged', () => {
    const web = generateRunScript(agent({ prompt: `${MEMORY}\n\n---\nパープレで最新のAIニュースを集めて` }), { autonomousCloudConsent: true });
    expect(web).toContain('ISOLATE_RESEARCH_PROMPT=0');
    const attended = generateRunScript(agent({ autonomous: false }));
    expect(attended).toContain('ISOLATE_RESEARCH_PROMPT=0');
    expect(attended).toContain('private note');
  });
});
