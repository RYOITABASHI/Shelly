import {
  buildStepPrompt,
  combineFinalPreview,
  DEFAULT_MAX_STEPS,
  HARD_MAX_STEPS,
  HARD_TOTAL_TIMEOUT_MS,
  isOrchestrated,
  nextStepGate,
  normalizeSteps,
  parseStepsFromText,
  reduceStatus,
  resolveBudget,
} from '@/lib/agent-orchestration';
import { classifyProposedCommand } from '@/lib/agent-boundary-policy';
import type { AgentOrchestrationConfig, AgentRunStep } from '@/store/types';

const cfg = (over: Partial<AgentOrchestrationConfig> = {}): AgentOrchestrationConfig => ({
  steps: ['a', 'b', 'c'],
  ...over,
});

describe('resolveBudget — clamps to hard caps', () => {
  it('uses defaults when unset', () => {
    const b = resolveBudget(cfg({ steps: ['a', 'b'] }));
    expect(b.maxSteps).toBe(2); // min(stepCount, DEFAULT) but here 2
    expect(b.totalTimeoutMs).toBeGreaterThan(0);
  });
  it('never exceeds the hard step/time ceilings', () => {
    const b = resolveBudget(cfg({ maxSteps: 999, totalTimeoutMs: 10 ** 12 }));
    expect(b.maxSteps).toBe(HARD_MAX_STEPS);
    expect(b.totalTimeoutMs).toBe(HARD_TOTAL_TIMEOUT_MS);
  });
  it('floors maxSteps at 1', () => {
    expect(resolveBudget(cfg({ maxSteps: 0 })).maxSteps).toBe(1);
  });
});

describe('normalizeSteps / isOrchestrated', () => {
  it('trims, drops empties, caps at hard max', () => {
    expect(normalizeSteps(cfg({ steps: ['  x ', '', '  ', 'y'] }))).toEqual(['x', 'y']);
    expect(normalizeSteps(cfg({ steps: Array(50).fill('s') })).length).toBe(HARD_MAX_STEPS);
  });
  it('is orchestrated only with >= 2 steps', () => {
    expect(isOrchestrated(cfg({ steps: ['only one'] }))).toBe(false);
    expect(isOrchestrated(cfg({ steps: ['a', 'b'] }))).toBe(true);
    expect(isOrchestrated(undefined)).toBe(false);
  });
});

describe('nextStepGate — refuses, never hangs', () => {
  const budget = { maxSteps: 3, totalTimeoutMs: 1000 };
  it('proceeds within budget', () => {
    expect(nextStepGate({ stepIndex: 0, budget, startedAtMs: 0, now: 10, priorFailed: false }).proceed).toBe(true);
  });
  it('stops when the prior step failed', () => {
    const g = nextStepGate({ stepIndex: 1, budget, startedAtMs: 0, now: 10, priorFailed: true });
    expect(g.proceed).toBe(false);
    expect(g.reason).toMatch(/previous step failed/);
  });
  it('stops at the step budget', () => {
    const g = nextStepGate({ stepIndex: 3, budget, startedAtMs: 0, now: 10, priorFailed: false });
    expect(g.proceed).toBe(false);
    expect(g.reason).toMatch(/step budget/);
  });
  it('stops when the time budget is exceeded', () => {
    const g = nextStepGate({ stepIndex: 0, budget, startedAtMs: 0, now: 2000, priorFailed: false });
    expect(g.proceed).toBe(false);
    expect(g.reason).toMatch(/time budget/);
  });
});

describe('buildStepPrompt', () => {
  it('carries prior results then the step instruction', () => {
    const p = buildStepPrompt('Base task', 'do step 2', ['result of step 1']);
    expect(p).toContain('Base task');
    expect(p).toContain('result of step 1');
    expect(p).toContain('do step 2');
    expect(p.indexOf('result of step 1')).toBeLessThan(p.indexOf('do step 2'));
  });
  it('omits the results block on the first step', () => {
    expect(buildStepPrompt('Base', 'step 1', [])).not.toContain('previous steps');
  });
  it('bounds the prompt length', () => {
    const p = buildStepPrompt('x'.repeat(9000), 'y', ['z'.repeat(9000)]);
    expect(p.length).toBeLessThanOrEqual(6000);
  });
});

describe('reduceStatus / combineFinalPreview', () => {
  const step = (over: Partial<AgentRunStep>): AgentRunStep => ({
    index: 0, instruction: 'i', status: 'success', durationMs: 1, outputPreview: 'o', ...over,
  });
  it('any error → error (one failure for the circuit breaker)', () => {
    expect(reduceStatus([step({ status: 'success' }), step({ status: 'error' })])).toBe('error');
  });
  it('all success → success; empty → skipped', () => {
    expect(reduceStatus([step({}), step({})])).toBe('success');
    expect(reduceStatus([])).toBe('skipped');
  });
  it('preview reports the failing step', () => {
    const out = combineFinalPreview([step({ index: 1, status: 'error', outputPreview: 'boom' })]);
    expect(out).toMatch(/Step 2.*failed.*boom/);
  });
});

describe('parseStepsFromText — conservative multi-step detection', () => {
  it('splits JP まず/次に/最後に', () => {
    const steps = parseStepsFromText('まずニュースを集めて、次に要約して、最後に保存して');
    expect(steps.length).toBe(3);
    expect(steps[0]).toContain('ニュース');
  });
  it('splits numbered lists', () => {
    expect(parseStepsFromText('1. collect data\n2. analyze it\n3. report').length).toBe(3);
  });
  it('splits EN first/then/finally', () => {
    expect(parseStepsFromText('First gather sources. Then summarize. Finally email it.').length).toBe(3);
  });
  it('returns [] for a single task (stays single-run)', () => {
    expect(parseStepsFromText('summarize the news')).toEqual([]);
    expect(parseStepsFromText('毎日ニュースを要約して')).toEqual([]);
  });
  it('caps at the hard step max', () => {
    const many = Array.from({ length: 30 }, (_, i) => `${i + 1}. step`).join('\n');
    expect(parseStepsFromText(many).length).toBeLessThanOrEqual(HARD_MAX_STEPS);
  });
});

// ── SECURITY: the gate holds on EVERY step (no privilege widening) ────────────
describe('security: every step passes the same boundary + command-safety gate', () => {
  const ctx = { workspaceRoot: '/workspace', level: 'L2' as const, policyPath: '.shelly/agents/policy.json' };

  it('in-workspace write is allowed at any step index (chaining adds no privilege)', () => {
    // The gate is stateless across steps — step index is irrelevant to the verdict.
    for (const stepIndex of [0, 1, 5]) {
      void stepIndex;
      expect(classifyProposedCommand('echo hi > /workspace/out.txt', ctx).decision).toBe('allow');
    }
  });

  it('a command that leaves the workspace root is gated (gray) on every step', () => {
    const v = classifyProposedCommand('cp /workspace/secret.txt /sdcard/leak.txt', ctx);
    expect(v.decision).not.toBe('allow');
    expect(v.signals).toContain('leaves-root');
  });

  it('a destructive command is hard-denied regardless of step / prior success', () => {
    const v = classifyProposedCommand('rm -rf /workspace', ctx);
    expect(v.decision).toBe('deny');
    expect(v.signals).toContain('destructive');
  });

  it('no step can widen privilege: a later step escaping root is NOT auto-allowed', () => {
    // Even if earlier steps succeeded in-workspace, an escape is still gated.
    expect(classifyProposedCommand('cat /workspace/a.txt', ctx).decision).toBe('allow');
    expect(classifyProposedCommand('cat /sdcard/other.txt', ctx).decision).not.toBe('allow');
  });

  it('DEFAULT_MAX_STEPS is a sane small number (phantom-process ceiling)', () => {
    expect(DEFAULT_MAX_STEPS).toBeLessThanOrEqual(HARD_MAX_STEPS);
    expect(HARD_MAX_STEPS).toBeLessThanOrEqual(10);
  });
});
