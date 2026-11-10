jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { HARD_MAX_STEPS, normalizeStepHandoff, normalizeSteps, shouldSkipHandoffStep, carriedStepContext } from '@/lib/agent-orchestration';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';
import { articlePipelineConfigError, articlePipelineStepCount, buildArticlePipeline, parseArticlePipelineFile, type ArticlePipelineConfig } from '@/lib/agent-pipeline-presets';
import type { AgentOrchestrationStep } from '@/store/types';
import { EXAMPLE_CONFIGS } from './fixtures/article-pipeline-config';

// `reviewRounds: 3` (executor v53): a third review -> revise round. The
// validator, the chain it builds, the skip / carry rules on both sides, and
// runs through the real executor with scripted HTTP engines (the fixture
// broker). Every name, file and fact here is made up.

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const fixtureBroker = path.join(root, '__tests__', 'fixtures', 'fs-write-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const VOICE = {
  profile: 'Drafts/_voice-profile.md',
  profileSha256: 'a'.repeat(64),
  author: 'Example Author',
  review: { type: 'cerebras' },
};
const example = (name: keyof typeof EXAMPLE_CONFIGS, over: Record<string, unknown> = {}) => ({ ...EXAMPLE_CONFIGS[name], ...over });
const stepsOf = (config: unknown) => buildArticlePipeline(config as ArticlePipelineConfig).orchestration.steps as AgentOrchestrationStep[];

describe('reviewRounds in the config', () => {
  it('accepts 2 and 3, and nothing else', () => {
    expect(articlePipelineConfigError(example('example-a', { reviewRounds: 2 }))).toBeNull();
    expect(articlePipelineConfigError(example('example-a', { reviewRounds: 3 }))).toBeNull();
    for (const bad of [1, 4, 0, 2.5, '3', true, null, [3], { rounds: 3 }]) {
      expect(articlePipelineConfigError(example('example-a', { reviewRounds: bad }))).toBe('pipeline.reviewRounds: use 2 or 3');
    }
  });

  it('counts the queue, refill and voice steps against the step limit', () => {
    expect(HARD_MAX_STEPS).toBe(10);
    // No queue: 9, and 10 with the voice step.
    expect(articlePipelineStepCount(example('example-a', { reviewRounds: 3 }))).toBe(9);
    expect(articlePipelineConfigError(example('example-a', { reviewRounds: 3, voice: VOICE }))).toBeNull();
    // A queue: 10.
    expect(articlePipelineConfigError(example('example-queue', { reviewRounds: 3 }))).toBeNull();
    expect(articlePipelineConfigError(example('example-queue', { reviewRounds: 3, voice: VOICE }))).toBe('pipeline.reviewRounds: 3 needs 11 steps; at most 10');
    // A queue with a refill: 11.
    expect(articlePipelineConfigError(example('example-refill', { reviewRounds: 3 }))).toBe('pipeline.reviewRounds: 3 needs 11 steps; at most 10');
    expect(articlePipelineConfigError(example('example-refill', { reviewRounds: 3, voice: VOICE }))).toBe('pipeline.reviewRounds: 3 needs 12 steps; at most 10');
    // Two rounds always fit, with everything on.
    expect(articlePipelineConfigError(example('example-refill', { voice: VOICE }))).toBeNull();
    expect(articlePipelineStepCount(example('example-refill', { voice: VOICE }))).toBe(10);
    expect(() => buildArticlePipeline(example('example-refill', { reviewRounds: 3 }) as ArticlePipelineConfig)).toThrow('needs 11 steps');
    // The file parser reports the pipeline it refused.
    const file = parseArticlePipelineFile(JSON.stringify({ version: 1, pipelines: [example('example-refill', { reviewRounds: 3 })] }));
    expect(file).toEqual({ error: 'pipelines[0].reviewRounds: 3 needs 11 steps; at most 10' });
  });

  it('builds the counted number of steps for every accepted config', () => {
    for (const name of ['example-a', 'example-queue', 'example-refill'] as const) {
      for (const over of [{}, { reviewRounds: 2 }, { reviewRounds: 3 }, { voice: VOICE }, { reviewRounds: 3, voice: VOICE }]) {
        const config = example(name, over);
        if (articlePipelineConfigError(config)) continue;
        expect(stepsOf(config)).toHaveLength(articlePipelineStepCount(config));
        expect(stepsOf(config).length).toBeLessThanOrEqual(HARD_MAX_STEPS);
      }
    }
  });
});

describe('the chain with three rounds', () => {
  it('adds review3 and revise3 after revise2, in the pattern of rounds 1 and 2', () => {
    const steps = stepsOf(example('example-a', { reviewRounds: 3 }));
    expect(steps.map((s) => s.handoff?.kind)).toEqual([undefined, undefined, 'review', 'revise', 'review', 'revise', 'review', 'revise', undefined]);
    expect(steps.map((s) => s.handoff?.of)).toEqual([undefined, undefined, [0, 1], [1, 2], [0, 3], [3, 4], [0, 5], [5, 6], undefined]);
    expect(steps.map((s) => s.handoff?.round)).toEqual([undefined, undefined, 1, 1, 2, 2, 3, 3, undefined]);
    expect(steps[8].local).toMatchObject({ kind: 'assemble', parts: [[1, 3, 5, 7]] });
    expect(steps[6].instruction).toBe(steps[4].instruction);
    expect(steps[7].instruction).toBe(steps[5].instruction);
    expect(steps[6].tool).toEqual(steps[4].tool);
    expect(steps[7].tool).toEqual(steps[5].tool);
  });

  it('shifts past a queue and gives the voice step every version', () => {
    const steps = stepsOf(example('example-a', { reviewRounds: 3, voice: VOICE }));
    expect(steps).toHaveLength(10);
    expect(steps[8].local).toMatchObject({ kind: 'voice', of: [1, 3, 5, 7] });
    expect(steps[9].local).toMatchObject({ kind: 'assemble', parts: [[1, 3, 5, 7]] });
    const queued = stepsOf(example('example-queue', { reviewRounds: 3 }));
    expect(queued.map((s) => s.handoff?.of)).toEqual([undefined, undefined, undefined, [1, 2], [2, 3], [1, 4], [4, 5], [1, 6], [6, 7], undefined]);
    expect(queued[9].local).toMatchObject({ kind: 'assemble', parts: [[2, 4, 6, 8]] });
  });

  it('survives normalizeSteps (round 3 markers are kept)', () => {
    const steps = normalizeSteps(buildArticlePipeline(example('example-a', { reviewRounds: 3 }) as ArticlePipelineConfig).orchestration);
    expect(steps.map((s) => s.handoff?.round)).toEqual([undefined, undefined, 1, 1, 2, 2, 3, 3, undefined]);
  });

  it('a 2-round plan is unchanged, with or without the field', () => {
    const before = buildArticlePipeline(example('example-refill', { voice: VOICE }) as ArticlePipelineConfig);
    expect(buildArticlePipeline(example('example-refill', { voice: VOICE, reviewRounds: 2 }) as ArticlePipelineConfig)).toEqual(before);
    const steps = before.orchestration.steps as AgentOrchestrationStep[];
    expect(steps.map((s) => s.handoff?.of)).toEqual([undefined, undefined, undefined, undefined, [2, 3], [3, 4], [2, 5], [5, 6], undefined, undefined]);
    expect(steps.map((s) => s.handoff?.round)).toEqual([undefined, undefined, undefined, undefined, 1, 1, 2, 2, undefined, undefined]);
    expect(steps[8].local).toMatchObject({ kind: 'voice', of: [3, 5, 7] });
    expect(steps[9].local).toMatchObject({ kind: 'assemble', parts: [[3, 5, 7]] });
  });
});

describe('round 3 in the shared hand-off rules (TS and executor)', () => {
  const both = (fn: (impl: { normalize: (r: unknown) => unknown; skip: typeof shouldSkipHandoffStep; carry: typeof carriedStepContext }) => void) => {
    fn({ normalize: (r) => normalizeStepHandoff(r), skip: shouldSkipHandoffStep, carry: carriedStepContext });
    fn({ normalize: (r) => executor.normalizeStepHandoff(r), skip: executor.shouldSkipHandoffStep, carry: executor.carriedStepContext });
  };

  it('accepts round 3 for review and revise only', () => {
    both(({ normalize }) => {
      expect(normalize({ kind: 'review', of: [0, 5], round: 3 })).toEqual({ kind: 'review', of: [0, 5], round: 3 });
      expect(normalize({ kind: 'revise', of: [5, 6], round: 3 })).toEqual({ kind: 'revise', of: [5, 6], round: 3 });
      expect(normalize({ kind: 'judge', of: [0, 1], round: 3 })).toBeUndefined();
      expect(normalize({ kind: 'review', of: [0, 1], round: 4 })).toBeUndefined();
      expect(normalize({ kind: 'review', of: [0, 1], round: '3' })).toBeUndefined();
    });
  });

  const steps = normalizeSteps(buildArticlePipeline(example('example-a', { reviewRounds: 3 }) as ArticlePipelineConfig).orchestration);

  it('a PASS at review 2 skips round 3; a REVISE runs it', () => {
    both(({ skip }) => {
      const results = ['r', 'w', 'VERDICT: REVISE', 'v1', 'VERDICT: PASS'];
      const skipped: boolean[] = [];
      expect(skip(steps, 5, results, skipped)).toBe(true);
      skipped[5] = true;
      expect(skip(steps, 6, results, skipped)).toBe(true);
      skipped[6] = true;
      expect(skip(steps, 7, results, skipped)).toBe(true);
      const go = ['r', 'w', 'VERDICT: REVISE', 'v1', 'VERDICT: REVISE', 'v2'];
      expect(skip(steps, 6, go, [])).toBe(false);
      expect(skip(steps, 7, go.concat(['VERDICT: REVISE']), [])).toBe(false);
      expect(skip(steps, 7, go.concat(['VERDICT: PASS']), [])).toBe(true);
    });
  });

  it('a step after the loop carries only the last round of each kind', () => {
    both(({ carry }) => {
      const results = ['r', 'w', 'R1', 'v1', 'R2', 'v2', 'R3', 'v3'];
      expect(carry(steps, 8, results, 8).indexes).toEqual([0, 1, 6, 7]);
    });
  });
});

describe('a run with three review rounds', () => {
  const LOCAL_URL = '127.0.0.1';
  const GROQ = 'api.groq.com';
  const SOURCE_URL = 'https://example.org/paper-a';
  const AGENT_ID = 'agent-review-rounds';
  const STREAM = 'rounds-example';
  const LOCAL = { type: 'local', label: 'Local LLM', model: 'fixture' };
  const RESEARCH = '1. Paper A: a figure. https://example.org/paper-a';
  const FIRST = '# A title\n\nThe first version says the cache keeps 3 entries [1].';
  const SECOND = '# A title\n\nThe answer first: 3 entries. The second version explains why [1].';
  const THIRD = '# A title\n\nThe answer first: 3 entries. The third version adds the limits [1].';
  const FOURTH = '# A title\n\nThe answer first: 3 entries. The fourth version gives an example [1].';
  const EDITOR_REASON = 'The opening does not give an example.';
  const answer = (scores: Partial<Record<string, number>> = {}, reason = 'Fine.') =>
    JSON.stringify(Object.fromEntries(executor.EDITOR_KEYS.map((k: string) => [k, { score: scores[k] ?? 4, reason }])));
  const openAi = (text: string) => ({ body: { choices: [{ message: { content: text }, finish_reason: 'stop' }], citations: [SOURCE_URL] } });

  function config(over: Partial<ArticlePipelineConfig> = {}): ArticlePipelineConfig {
    return {
      id: STREAM,
      name: 'Rounds example draft',
      prompt: 'An example series for general readers.',
      lang: 'en',
      schedule: '30 5 * * *',
      outputFolder: '/storage/example/Notes/Drafts/Rounds',
      footer: 'Configured footer.',
      instructions: {
        research: 'Search the web for the one topic and write notes.',
        write: 'Write a post. The first line is a "# " heading.',
        review: 'The notes are the only evidence.',
        revise: 'Apply every finding.',
      },
      engines: { research: { type: 'gemini-api' }, write: { type: 'gemini-api' }, review: { type: 'cerebras' } },
      editor: { type: 'groq', rubric: 'Readers are developers. Every claim needs a concrete example.' },
      reviewRounds: 3,
      ...over,
    };
  }

  interface Setup { home: string; planFile: string; http: string }

  function setup(opts: { local: string[]; editor: string[]; rounds?: 2 | 3 }): Setup {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-review-rounds-'));
    fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
    fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
    const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-review-rounds-vault-')));
    const outputDir = path.join(vault, 'Drafts', 'Rounds');
    fs.mkdirSync(outputDir, { recursive: true });
    const http = path.join(home, 'fake-http.json');
    fs.writeFileSync(http, JSON.stringify({ [LOCAL_URL]: opts.local.map(openAi), [GROQ]: opts.editor.map(openAi) }));
    const list = normalizeSteps(buildArticlePipeline(config({ reviewRounds: opts.rounds ?? 3 })).orchestration).map((step: any) => {
      const { tool: _tool, toolPinned: _pinned, ...rest } = step;
      void _tool;
      void _pinned;
      return rest;
    });
    const policy = { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [], unattended: true };
    const plan = {
      kind: PLAN_SPEC_KIND,
      schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
      generatedAt: 1,
      agent: { id: AGENT_ID, name: 'Fallback title', autonomous: false, autonomyLevel: 'L2' },
      prompt: 'Base task',
      tool: LOCAL,
      action: { type: 'draft' },
      paths: { home },
      output: { outputDir, outputNameTemplate: `{date}-${STREAM}.md`, slug: STREAM, useGlobalOutput: false, suggestedRoots: [] },
      limits: { timeoutSeconds: 30, maxConcurrent: 2 },
      policy,
      routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
      steps: { list, budget: { maxSteps: 10, totalTimeoutMs: 30 * 60_000 }, longform: true },
    };
    const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
    fs.writeFileSync(
      path.join(home, '.shelly/agents/.env'),
      `LOCAL_LLM_URL='http://${LOCAL_URL}:9'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\nOBSIDIAN_VAULT_PATH='${vault}'\n`,
    );
    return { home, planFile, http };
  }

  function run(s: Setup): Promise<number | null> {
    return new Promise((resolve) => {
      const args = [scriptCopy, '--plan-file', s.planFile, '--home', s.home, '--agent-id', AGENT_ID, '--broker', fixtureBroker, '--unattended', '1'];
      const childEnv: Record<string, string | undefined> = { ...process.env, HOME: s.home, SHELLY_TEST_LONGFORM_RETRY_WAIT_MS: '10', SHELLY_TEST_FAKE_HTTP: s.http };
      delete childEnv.SHELLY_RUN_ORIGIN;
      const child = spawn(process.execPath, args, { env: childEnv as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('close', (status) => resolve(status));
    });
  }

  const logDir = (home: string) => path.join(home, `.shelly/agents/logs/${AGENT_ID}`);
  const readRunLog = (home: string): any => {
    const files = fs.readdirSync(logDir(home)).filter((n) => /^\d+\.json$/.test(n)).sort();
    return JSON.parse(fs.readFileSync(path.join(logDir(home), files[files.length - 1]), 'utf8'));
  };
  const events = (home: string, event: string): any[] =>
    fs.readFileSync(path.join(logDir(home), 'plan-executor-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.event === event);
  const readResult = (home: string) => fs.readFileSync(path.join(home, `.shelly/tmp/agent-result-${AGENT_ID}.md`), 'utf8');
  const prompts = (s: Setup, host: string): string[] => {
    const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
    const calls = read(`${s.http}.calls`);
    const bodies = read(`${s.http}.bodies`).map((b) => JSON.parse(b));
    return calls.map((c, i) => (c === host ? JSON.parse(bodies[i]).messages[0].content : null)).filter((p): p is string => p !== null);
  };
  const frontmatter = (text: string) => text.slice(0, text.indexOf('\n---\n', 4));

  it('review 3 PASSing the third version gives review: pass', async () => {
    const s = setup({
      local: [RESEARCH, FIRST, 'VERDICT: REVISE\n1. Fix the marker.', SECOND, 'VERDICT: REVISE\n1. Name the limits.', THIRD, 'VERDICT: PASS'],
      editor: [answer(), answer(), answer()],
    });
    expect(await run(s)).toBe(0);
    expect(readRunLog(s.home).status).toBe('success');
    const local = prompts(s, LOCAL_URL);
    // research, write, three reviews, two revisions; revise 3 is skipped and
    // assemble needs no final review (review 3 passed the adopted version).
    expect(local).toHaveLength(7);
    expect(local[6]).toContain('The third version adds the limits');
    expect(local[6]).not.toContain('The second version explains why');
    const fm = frontmatter(readResult(s.home));
    expect(fm).toContain('review: pass');
    expect(fm).not.toContain('review_note');
    expect(readResult(s.home)).toContain('The third version adds the limits');
    expect(events(s.home, 'handoff_skipped')).toMatchObject([{ stepIndex: 7, reason: 'review passed' }]);
    expect(events(s.home, 'handoff_verdict').map((e) => [e.stepIndex, e.verdict])).toEqual([[2, 'REVISE'], [4, 'REVISE'], [6, 'PASS']]);
    expect(events(s.home, 'final_review')).toHaveLength(0);
    expect(events(s.home, 'review_editor_verdict').map((e) => e.stepIndex)).toEqual([2, 4, 6]);
  }, 60000);

  it('a PASS at review 2 skips round 3', async () => {
    const s = setup({
      local: [RESEARCH, FIRST, 'VERDICT: REVISE\n1. Fix the marker.', SECOND, 'VERDICT: PASS'],
      editor: [answer(), answer()],
    });
    expect(await run(s)).toBe(0);
    expect(readRunLog(s.home).status).toBe('success');
    expect(prompts(s, LOCAL_URL)).toHaveLength(5);
    expect(events(s.home, 'handoff_skipped').map((e) => e.stepIndex)).toEqual([5, 6, 7]);
    const fm = frontmatter(readResult(s.home));
    expect(fm).toContain('review: pass');
    expect(readResult(s.home)).toContain('The second version explains why');
  }, 60000);

  it('the editor notes of review 3 reach revise 3, and the final review reads the fourth version', async () => {
    const s = setup({
      local: [RESEARCH, FIRST, 'VERDICT: REVISE\n1. Fix the marker.', SECOND, 'VERDICT: REVISE\n1. Name the limits.', THIRD, 'VERDICT: PASS', FOURTH, 'VERDICT: PASS'],
      editor: [answer(), answer(), answer({ structure: 2, title: 2, overall: 2 }, EDITOR_REASON), answer()],
    });
    expect(await run(s)).toBe(0);
    expect(readRunLog(s.home).status).toBe('success');
    const local = prompts(s, LOCAL_URL);
    expect(local).toHaveLength(9);
    const revise3 = local[7];
    expect(revise3).toContain('The third version adds the limits');
    expect(revise3).toContain('VERDICT: REVISE');
    expect(revise3).toContain(executor.EDITOR_NOTES_HEADING);
    expect(revise3).toContain(`- structure 2/5: ${EDITOR_REASON}`);
    expect(revise3).toContain(executor.LONGFORM_EDITOR_NOTES_RULE);
    // The final review in assemble reads the last revision.
    expect(local[8]).toContain('The fourth version gives an example');
    expect(events(s.home, 'review_editor_verdict')).toMatchObject([
      { stepIndex: 2 },
      { stepIndex: 4 },
      { stepIndex: 6, reviewer: 'PASS', editorPass: false, verdict: 'REVISE' },
    ]);
    expect(events(s.home, 'final_review')).toMatchObject([{ reviewStep: 6, draftStep: 7, verdict: 'PASS' }]);
    const fm = frontmatter(readResult(s.home));
    expect(fm).toContain('review: pass');
    expect(readResult(s.home)).toContain('The fourth version gives an example');
  }, 60000);

  it('a 2-round plan runs as before: review 2, revise 2, then the final review', async () => {
    const s = setup({
      rounds: 2,
      local: [RESEARCH, FIRST, 'VERDICT: REVISE\n1. Fix the marker.', SECOND, 'VERDICT: REVISE\n1. Name the limits.', THIRD, 'VERDICT: PASS'],
      editor: [answer(), answer(), answer()],
    });
    expect(await run(s)).toBe(0);
    const local = prompts(s, LOCAL_URL);
    expect(local).toHaveLength(7);
    expect(events(s.home, 'final_review')).toMatchObject([{ reviewStep: 4, draftStep: 5, verdict: 'PASS' }]);
    expect(frontmatter(readResult(s.home))).toContain('review: pass');
  }, 60000);
});
