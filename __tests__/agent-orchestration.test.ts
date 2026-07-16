import {
  apiCallLabel,
  buildStepPrompt,
  combineFinalPreview,
  DEFAULT_MAX_STEPS,
  detectToolPinnedSteps,
  HARD_MAX_STEPS,
  HARD_TOTAL_TIMEOUT_MS,
  isOrchestrated,
  nextStepGate,
  normalizeStep,
  normalizeSteps,
  parseStepsFromText,
  reduceStatus,
  resolveApiCallTemplate,
  resolveBudget,
} from '@/lib/agent-orchestration';
import { classifyProposedCommand } from '@/lib/agent-boundary-policy';
import type { AgentApiCallConfig, AgentOrchestrationConfig, AgentRunStep } from '@/store/types';

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

describe('normalizeStep — single-entry normalization (Phase 5 tool pin)', () => {
  it('a plain string becomes {instruction} with no tool — byte-identical to legacy behavior', () => {
    expect(normalizeStep('  do the thing  ')).toEqual({ instruction: 'do the thing' });
  });
  it('an object with no tool becomes {instruction} — same as a plain string', () => {
    expect(normalizeStep({ instruction: '  do the thing  ' })).toEqual({ instruction: 'do the thing' });
  });
  it('an object with a tool pin keeps it — this is the auto-routing skip', () => {
    expect(normalizeStep({ instruction: 'draft a summary', tool: { type: 'perplexity', model: 'sonar-deep-research' } }))
      .toEqual({ instruction: 'draft a summary', tool: { type: 'perplexity', model: 'sonar-deep-research' } });
  });
  it('truncates a long instruction the same way for both shapes', () => {
    const long = 'x'.repeat(900);
    expect(normalizeStep(long).instruction.length).toBeLessThanOrEqual(500);
    expect(normalizeStep({ instruction: long, tool: { type: 'local' } }).instruction.length).toBeLessThanOrEqual(500);
  });

  // api-call (v1)
  const apiCall: AgentApiCallConfig = { host: 'api.perplexity.ai', method: 'GET', path: '/v1/search' };
  it('an object with an apiCall passes it through, with a real instruction untouched', () => {
    expect(normalizeStep({ instruction: 'search for sources', apiCall })).toEqual({
      instruction: 'search for sources',
      apiCall,
    });
  });
  it('synthesizes a label from apiCallLabel when instruction is blank, so the step is not dropped by normalizeSteps\' filter', () => {
    expect(normalizeStep({ instruction: '', apiCall })).toEqual({
      instruction: apiCallLabel(apiCall),
      apiCall,
    });
    expect(normalizeStep({ instruction: '   ', apiCall }).instruction).toBe(apiCallLabel(apiCall));
  });
  it('apiCall wins over tool when (invalidly) both are present on the raw input — mutually exclusive per the type contract', () => {
    // normalizeStep does not itself enforce mutual exclusivity (the UI does,
    // per AgentOrchestrationStep's doc comment) but must still produce a
    // single unambiguous shape rather than silently carrying both.
    const step = normalizeStep({ instruction: 'x', apiCall, tool: { type: 'local' } } as any);
    expect(step.apiCall).toEqual(apiCall);
    expect(step.tool).toBeUndefined();
  });
});

describe('apiCallLabel — display-only, never sent to a model', () => {
  it('formats METHOD host+path', () => {
    expect(apiCallLabel({ host: 'api.perplexity.ai', method: 'GET', path: '/v1/search?q=x' })).toBe(
      'GET api.perplexity.ai/v1/search?q=x',
    );
  });
  it('truncates to the same 500-char instruction budget as normalizeStep', () => {
    const long = apiCallLabel({ host: 'api.perplexity.ai', method: 'POST', path: '/' + 'x'.repeat(900) });
    expect(long.length).toBeLessThanOrEqual(500);
  });
});

describe('resolveApiCallTemplate — plain string-replace, no template engine', () => {
  it('replaces the literal {{result}} placeholder', () => {
    expect(resolveApiCallTemplate('/v1/search?q={{result}}', 'hello world')).toBe('/v1/search?q=hello world');
  });
  it('replaces every occurrence', () => {
    expect(resolveApiCallTemplate('{{result}}-{{result}}', 'x')).toBe('x-x');
  });
  it('is a no-op when the placeholder is absent', () => {
    expect(resolveApiCallTemplate('/v1/fixed-path', 'anything')).toBe('/v1/fixed-path');
  });
  it('returns an empty string for an absent template, regardless of lastResult', () => {
    expect(resolveApiCallTemplate(undefined, 'anything')).toBe('');
    expect(resolveApiCallTemplate('', 'anything')).toBe('');
  });
  it('handles an empty lastResult (first step in a chain) by removing the placeholder', () => {
    expect(resolveApiCallTemplate('/v1/search?q={{result}}', '')).toBe('/v1/search?q=');
  });
});

describe('normalizeSteps / isOrchestrated', () => {
  it('regression: plain-string-only steps normalize to {instruction} with no tool (unchanged auto-routing shape)', () => {
    expect(normalizeSteps(cfg({ steps: ['  x ', '', '  ', 'y'] }))).toEqual([
      { instruction: 'x' },
      { instruction: 'y' },
    ]);
    expect(normalizeSteps(cfg({ steps: Array(50).fill('s') })).length).toBe(HARD_MAX_STEPS);
  });
  it('a pinned-tool step surfaces its tool; an unpinned step in the SAME array does not', () => {
    const steps = normalizeSteps(cfg({
      steps: [
        'collect the news',
        { instruction: 'draft the digest', tool: { type: 'local', model: 'Qwen3.5-0.8B-Q4_K_M' } },
      ],
    }));
    expect(steps).toEqual([
      { instruction: 'collect the news' },
      { instruction: 'draft the digest', tool: { type: 'local', model: 'Qwen3.5-0.8B-Q4_K_M' } },
    ]);
  });
  it('mixed array: plain strings and pinned objects interleave correctly, empties still dropped', () => {
    const steps = normalizeSteps(cfg({
      steps: [
        'step one',
        { instruction: '' }, // empty instruction — dropped like an empty string
        { instruction: 'step three', tool: { type: 'cli', cli: 'codex' } },
        'step four',
      ],
    }));
    expect(steps.map((s) => s.instruction)).toEqual(['step one', 'step three', 'step four']);
    expect(steps.map((s) => s.tool)).toEqual([undefined, { type: 'cli', cli: 'codex' }, undefined]);
  });
  it('is orchestrated only with >= 2 steps', () => {
    expect(isOrchestrated(cfg({ steps: ['only one'] }))).toBe(false);
    expect(isOrchestrated(cfg({ steps: ['a', 'b'] }))).toBe(true);
    expect(isOrchestrated(cfg({ steps: ['a', { instruction: 'b', tool: { type: 'groq' } }] }))).toBe(true);
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
  it('a transient step (no hard error) reduces to unavailable, NOT error (breaker exclusion)', () => {
    // P0-b invariant must hold for multi-step agents too: a transient web outage
    // must not be folded into an 'error' that trips the circuit breaker.
    expect(reduceStatus([step({ status: 'success' }), step({ status: 'unavailable' })])).toBe('unavailable');
    // A hard error still wins over a transient.
    expect(reduceStatus([step({ status: 'unavailable' }), step({ status: 'error' })])).toBe('error');
  });
  it('preview reports a transient step as temporarily unavailable, not failed', () => {
    const out = combineFinalPreview([
      step({ index: 0, status: 'success', outputPreview: 'ok' }),
      step({ index: 1, status: 'unavailable', outputPreview: 'Gemini 503' }),
    ]);
    expect(out).toMatch(/Step 2.*unavailable.*Gemini 503/);
    expect(out).not.toMatch(/failed/);
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

  it('bug #152 on-device repro: an interval schedule clause ("5分ごとに") before the first まず marker is dropped, not kept as a spurious content-free step 1', () => {
    const steps = parseStepsFromText(
      '5分ごとに、まず『自律エージェントの安全性』について観点を3つ箇条書きで挙げて、次にそれぞれを1行で言い換えて、最後にMarkdownドラフトとして保存して',
    );
    expect(steps.length).toBe(3);
    expect(steps.some((s) => s === '5分ごとに' || s.includes('5分ごとに'))).toBe(false);
    expect(steps[0]).toContain('観点');
    expect(steps[1]).toContain('言い換えて');
    expect(steps[2]).toContain('Markdown');
  });

  it('EN equivalent: an interval schedule clause ("every 5 minutes") before the first "first" marker is dropped', () => {
    // EN_SEQUENCE_SPLIT only anchors on ^ / "." / "\n" (unlike JP_SEQUENCE_SPLIT,
    // which also anchors on 、) -- so the schedule preamble must end the
    // sentence with a period for "First" to be recognised as a marker at all.
    const steps = parseStepsFromText(
      'Every 5 minutes. First gather sources. Then summarize. Finally email it.',
    );
    expect(steps.length).toBe(3);
    expect(steps.some((s) => s.toLowerCase().includes('every 5 minutes'))).toBe(false);
    expect(steps[0].toLowerCase()).toContain('gather');
  });

  it('a plain まず/次に/最後に chain with NO leading preamble is unaffected (no regression)', () => {
    const steps = parseStepsFromText('まずニュースを集めて、次に要約して、最後に保存して');
    expect(steps.length).toBe(3);
    expect(steps[0]).toContain('ニュース');
    expect(steps[1]).toContain('要約');
    expect(steps[2]).toContain('保存');
  });

  it('a plain numbered list with NO leading preamble is unaffected (no regression)', () => {
    const steps = parseStepsFromText('1. collect data\n2. analyze it\n3. report');
    expect(steps).toEqual(['collect data', 'analyze it', 'report']);
  });
});

describe('detectToolPinnedSteps — Phase 6 tool-mention chain detection', () => {
  it('pins パープレ/ローカルLLM per clause on a plain て-form/、-delimited chain, leaves the last clause unpinned', () => {
    const steps = detectToolPinnedSteps(
      'パープレでSTEAM教育×AIの最新論文を集めて、ローカルLLMで日本語要約と自分の見解とリンクを付けて、Xに自動投稿して',
    );
    expect(steps).not.toBeNull();
    expect(steps!.length).toBe(3);
    expect(steps![0].tool).toEqual({ type: 'perplexity', model: 'sonar-deep-research' });
    expect(steps![0].instruction).toContain('パープレ');
    expect(steps![1].tool).toEqual({ type: 'local' });
    expect(steps![2].tool).toBeUndefined();
    expect(steps![2].instruction).toContain('X');
  });

  it('pins Codex and Gemini mentions to their ToolChoice shapes', () => {
    const steps = detectToolPinnedSteps('Codexでコードを直して、Geminiでレビューコメントを書いて');
    expect(steps).not.toBeNull();
    expect(steps![0].tool).toEqual({ type: 'cli', cli: 'codex' });
    expect(steps![1].tool).toEqual({ type: 'gemini-api' });
  });

  it('recognizes an EN comma-delimited chain with tool mentions', () => {
    const steps = detectToolPinnedSteps(
      'Collect the latest STEAM x AI papers with Perplexity, summarize them in Japanese with the local LLM and add my take with links, then post to X automatically.',
    );
    expect(steps).not.toBeNull();
    expect(steps!.length).toBe(3);
    expect(steps![0].tool).toEqual({ type: 'perplexity', model: 'sonar-deep-research' });
    expect(steps![1].tool).toEqual({ type: 'local' });
    expect(steps![2].tool).toBeUndefined();
  });

  it('returns null for a single clause (no boundary at all)', () => {
    expect(detectToolPinnedSteps('パープレで論文を集めて')).toBeNull();
  });

  it('REGRESSION: returns null for ordinary て、-containing prose with no tool mention (does not widen the generic splitter)', () => {
    expect(detectToolPinnedSteps('毎朝ニュースをまとめて、保存して')).toBeNull();
    expect(detectToolPinnedSteps('資料を確認して、問題なければ承認して、担当者に共有して')).toBeNull();
  });

  it('returns null for fewer than 2 usable clauses even with a tool mention', () => {
    expect(detectToolPinnedSteps('ローカルLLMで要約')).toBeNull();
  });

  it('on-device regression 2026-07-15: a leading weekday-only schedule clause (no time yet, from a slot-fill-pending utterance) is dropped, not kept as a bogus untooled step 1', () => {
    // derivePrompt's own schedule-clause strip only runs when
    // parseSchedule() judged the schedule confident, which requires a TIME
    // alongside the days -- "毎週月曜と金曜に" alone (before the slot-fill
    // follow-up supplies "9時") is exactly the case where confidence is
    // false, so at initial-parse time the clause reaches this splitter
    // unstripped.
    const steps = detectToolPinnedSteps(
      '毎週月曜と金曜に、パープレでSTEAM教育×AIに関する最新の論文やニュースを検索して、ローカルLLMで一次ソースと要約をObsidianの日付フォルダに保存してから、X用に文字数内で再要約してXに投稿して',
    );
    expect(steps).not.toBeNull();
    expect(steps!.length).toBe(3);
    expect(steps!.some((s) => s.instruction.includes('毎週月曜と金曜に'))).toBe(false);
    expect(steps![0].tool).toEqual({ type: 'perplexity', model: 'sonar-deep-research' });
    expect(steps![0].instruction).toContain('パープレ');
    expect(steps![1].tool).toEqual({ type: 'local' });
    expect(steps![2].instruction).toContain('X');
  });

  it('does NOT drop a real leading clause that merely mentions a day/time as content, not as the whole clause', () => {
    // isScheduleOnlyClause is fully anchored (^...$) -- a clause that names a
    // tool or has other real content alongside a day/time token must survive.
    const steps = detectToolPinnedSteps(
      '月曜のニュースをパープレで集めて、ローカルLLMで要約して',
    );
    expect(steps).not.toBeNull();
    expect(steps![0].instruction).toContain('月曜');
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
