jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as path from 'path';
import { buildAgentPlanSpec } from '@/lib/agent-plan-spec';
import { normalizeSteps, REVIEW_OUTPUT_CONTRACT } from '@/lib/agent-orchestration';
import {
  ARTICLE_ENGINE_TYPES,
  articleDigestConfigError,
  articleOutputFolderError,
  articlePipelineConfigError,
  buildArticlePipeline,
  buildCollectionPipeline,
  isArticlePipelineRequest,
  parseArticlePipelineFile,
  type ArticlePipelineConfig,
  type PipelinePreset,
} from '@/lib/agent-pipeline-presets';
import { articleOutputRoots, loadArticlePipeline, selectArticlePipeline } from '@/lib/agent-article-pipeline-file';
import { touchesProtectedPolicyFiles } from '@/lib/agent-boundary-policy';
import { parseAgentNL } from '@/lib/agent-nl-parser';
import { draftToConfirmedAgentDraft, isAutoRegisterEligibleDraft, shouldUseChatConfirm, summarizeAgentDraftAsText } from '@/lib/agent-plan-summary';
import { nextMissingSlot } from '@/lib/agent-slot-fill';
import { detectRouteSignals } from '@/lib/agent-router-scoring';
import { agentToParsedAgentDraft, applyDraftPatch } from '@/lib/agent-draft-patch';
import type { Agent, AgentOrchestrationStep } from '@/store/types';
import { EXAMPLE_CONFIGS, EXAMPLE_DIGEST, EXAMPLE_FOLDER, exampleDigestPipeline, examplePipeline, type ExampleStream } from './fixtures/article-pipeline-config';

// The article pipeline extension point: a user-supplied config, the file it
// comes from, the plain-text confirm and the plan it produces. Shelly ships no
// series, so everything here runs on the made-up config in fixtures/.

const root = path.resolve(__dirname, '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(path.join(root, 'scripts', 'shelly-plan-executor.js'));

const ALL = Object.keys(EXAMPLE_CONFIGS) as ExampleStream[];
const REQUEST = '@agent 記事パイプライン example-a を作って';
const ROOTS = { vault: '/storage/example/Notes', custom: '/storage/example/Out' };
const config = (over: Record<string, unknown> = {}) => ({ ...EXAMPLE_CONFIGS['example-a'], ...over });
const draftFor = (stream: ExampleStream = 'example-a') => parseAgentNL(REQUEST, [], examplePipeline(stream));

function agentFrom(preset: PipelinePreset): Agent {
  return {
    id: 'agent-article',
    name: preset.name,
    description: '',
    prompt: preset.prompt,
    schedule: preset.schedule,
    tool: preset.tool!,
    outputPath: preset.output!.outputPath,
    outputTemplate: preset.output!.outputTemplate,
    action: preset.action,
    orchestration: preset.orchestration,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 1,
    version: 1,
  };
}

describe('Shelly ships no series', () => {
  const presets = fs.readFileSync(path.join(root, 'lib/agent-pipeline-presets.ts'), 'utf8');

  it('the builders have no default config', () => {
    expect(() => (buildArticlePipeline as unknown as () => void)()).toThrow();
    expect(() => buildArticlePipeline('some-stream' as unknown as ArticlePipelineConfig)).toThrow();
  });

  it('the source has no vault path, cron or engine default for a pipeline', () => {
    const start = presets.indexOf('// ── Article pipelines');
    const code = presets.slice(start, presets.indexOf('/** Hard clamp so a typo'));
    expect(code).not.toMatch(/\/sdcard\/Documents|ObsidianVault|\* \* \*'/);
    expect(code).not.toMatch(/\?\? \{ type:|type: 'gemini-api'|type: 'cerebras'/);
  });

  it.each(['シリーズの記事パイプラインを作って', '記事パイプラインを作って', 'article pipeline for my series'])('without the file, %s is not a preset', (text) => {
    const draft = parseAgentNL(text);
    expect(draft.longform).toBeUndefined();
    expect(draft.presetOutput).toBeUndefined();
    expect(draft.charLimit).toBeUndefined();
  });

  it('REGRESSION: the collection preset and other pipelines are unchanged', () => {
    const named = parseAgentNL('天文学の記事を集めるパイプラインを作って');
    expect(named.autonomous).toBe(true);
    expect(named.longform).toBeUndefined();
    expect(named.orchestrationSteps).toHaveLength(4);
    expect(parseAgentNL('量子コンピュータのパイプライン').name).toContain('量子コンピュータ');
    expect(parseAgentNL('CIのパイプラインを直して').orchestrationSteps).toBeUndefined();
    expect(buildCollectionPipeline({ topic: '天文学' }).orchestration.longform).toBeUndefined();
  });

  it('matches only the article pipeline words', () => {
    expect(isArticlePipelineRequest(REQUEST)).toBe(true);
    expect(isArticlePipelineRequest('article pipeline example-a')).toBe(true);
    expect(isArticlePipelineRequest('記事を書いて')).toBe(false);
    expect(isArticlePipelineRequest('データパイプライン')).toBe(false);
  });
});

describe('buildArticlePipeline', () => {
  const stepsOf = (stream: ExampleStream) => examplePipeline(stream).orchestration.steps as AgentOrchestrationStep[];
  const lead = (stream: ExampleStream) => (EXAMPLE_CONFIGS[stream].queue ? 1 : 0) + (EXAMPLE_CONFIGS[stream].instructions.topics ? 1 : 0);

  it('builds research, write, two review rounds and assemble', () => {
    const steps = stepsOf('example-a');
    expect(steps.map((s) => s.handoff?.kind)).toEqual([undefined, undefined, 'review', 'revise', 'review', 'revise', undefined]);
    expect(steps.map((s) => s.handoff?.of)).toEqual([undefined, undefined, [0, 1], [1, 2], [0, 3], [3, 4], undefined]);
    expect(steps.map((s) => s.handoff?.round)).toEqual([undefined, undefined, 1, 1, 2, 2, undefined]);
    expect(steps[6].local).toMatchObject({ kind: 'assemble', parts: [[1, 3, 5]] });
  });

  it.each(ALL)('%s shifts the loop past its queue steps, and every index points back', (stream) => {
    const steps = stepsOf(stream);
    const k = lead(stream);
    expect(steps).toHaveLength(7 + k);
    expect(steps[k + 2].handoff).toEqual({ kind: 'review', of: [k, k + 1], round: 1 });
    expect(steps[steps.length - 1].local).toMatchObject({ kind: 'assemble', parts: [[k + 1, k + 3, k + 5]] });
    steps.forEach((s, i) => s.handoff?.of.forEach((n) => expect(n).toBeLessThan(i)));
  });

  it('adds queue-pop, and queue-refill only with a topics instruction', () => {
    expect(stepsOf('example-a').some((s) => s.local?.kind === 'queue-pop')).toBe(false);
    expect(stepsOf('example-queue')[0].local).toEqual({ kind: 'queue-pop' });
    expect(stepsOf('example-queue').some((s) => s.local?.kind === 'queue-refill')).toBe(false);
    expect(stepsOf('example-refill').map((s) => s.local?.kind).slice(0, 2)).toEqual(['queue-refill', 'queue-pop']);
    expect(stepsOf('example-refill')[0].instruction).toBe(EXAMPLE_CONFIGS['example-refill'].instructions.topics);
  });

  it('labels the no-model steps in the config language', () => {
    expect(stepsOf('example-queue-en')[0].instruction).toContain('(no model)');
    expect(stepsOf('example-queue')[0].instruction).toContain('モデルは使わない');
  });

  it.each(ALL)('%s takes every engine from the config', (stream) => {
    const { engines } = EXAMPLE_CONFIGS[stream];
    const steps = stepsOf(stream);
    const k = lead(stream);
    expect(steps[k].tool).toEqual(engines.research);
    expect(steps[k + 1].tool).toEqual(engines.write);
    expect(steps[k + 2].tool).toEqual(engines.review);
    expect(steps[k + 3].tool).toEqual(engines.write);
    steps.filter((s) => s.tool).forEach((s) => expect(s.toolPinned).toBe(true));
    expect(examplePipeline(stream).tool).toEqual(engines.agent ?? engines.research);
  });

  it('honours any engine the app supports, with no preference of its own', () => {
    const engines = { research: { type: 'cerebras', model: 'vendor/model-1' }, write: { type: 'groq' }, review: { type: 'perplexity' } };
    const preset = buildArticlePipeline(config({ engines }) as ArticlePipelineConfig);
    const steps = preset.orchestration.steps as AgentOrchestrationStep[];
    expect(steps[0].tool).toEqual(engines.research);
    expect(steps[1].tool).toEqual(engines.write);
    expect(steps[2].tool).toEqual(engines.review);
    expect(preset.tool).toEqual(engines.research);
  });

  it.each(ALL)('%s grants nothing: a draft action, not autonomous, no CLI and no api-call', (stream) => {
    const preset = examplePipeline(stream);
    expect(preset.action).toEqual({ type: 'draft' });
    expect(preset.autonomous).toBe(false);
    expect(preset.memoryOff).toBe(true);
    expect(preset.orchestration.longform).toBe(true);
    (preset.orchestration.steps as AgentOrchestrationStep[]).forEach((s) => {
      expect(s.apiCall).toBeUndefined();
      expect(s.tool?.type).not.toBe('cli');
    });
  });

  it.each(ALL)('%s survives normalization with the review contract whole', (stream) => {
    const steps = stepsOf(stream);
    const normalized = normalizeSteps(examplePipeline(stream).orchestration);
    expect(normalized).toHaveLength(steps.length);
    normalized.forEach((s, i) => expect(s.instruction).toBe(steps[i].instruction));
    expect(normalized.some((s) => s.local?.kind === 'invalid')).toBe(false);
    expect(steps.filter((s) => s.handoff?.kind === 'review').every((s) => s.instruction.endsWith(REVIEW_OUTPUT_CONTRACT))).toBe(true);
  });

  it.each(ALL)('%s saves into its own folder, with its id in the file name', (stream) => {
    expect(examplePipeline(stream).output).toEqual({ outputPath: EXAMPLE_CONFIGS[stream].outputFolder, outputTemplate: `{date}-${stream}.md` });
  });

  it('adds the folder slash when the config leaves it out', () => {
    expect(buildArticlePipeline(config({ outputFolder: '/storage/example/Notes' }) as ArticlePipelineConfig).output?.outputPath).toBe('/storage/example/Notes/');
  });

  it('the example base prompt stays neutral, so the plan prompt is not turned into a link-list task', () => {
    expect(detectRouteSignals(examplePipeline('example-a').prompt).needsWeb).toBe(false);
  });
});

describe('the config is validated strictly', () => {
  const over = (patch: Record<string, unknown>) => articlePipelineConfigError(config(patch));
  const instructions = EXAMPLE_CONFIGS['example-a'].instructions;
  const engines = EXAMPLE_CONFIGS['example-a'].engines;

  it.each(ALL)('accepts %s', (stream) => {
    expect(articlePipelineConfigError(EXAMPLE_CONFIGS[stream])).toBeNull();
  });

  it.each([
    ['id', { id: 'Has Space' }],
    ['id', { id: '../x' }],
    ['name', { name: '' }],
    ['name', { name: 'a\nb' }],
    ['prompt', { prompt: 'x'.repeat(2001) }],
    ['lang', { lang: 'fr' }],
    ['footer', { footer: 'x'.repeat(601) }],
    ['footer', { footer: '   ' }],
    ['lintTerms', { lintTerms: Array(65).fill('t') }],
    ['nameLint', { nameLint: { canonical: 'x' } }],
    ['quality', { quality: { minChars: 0 } }],
    ['quality', { quality: { selfTalk: true } }],
    ['queue', { queue: 'yes' }],
    ['unknown', { autonomous: true }],
    ['unknown', { action: { type: 'publish' } }],
    ['unknown', { steps: [] }],
  ])('refuses a bad %s', (_field, patch) => {
    expect(over(patch)).not.toBeNull();
  });

  it.each(['* * * * *', '0 * * * *', '*/5 8 * * *', 'once', '0 8 * *', '60 8 * * *', '0 24 * * *', '0 8 * * 1; rm'])('refuses the schedule %s', (schedule) => {
    expect(over({ schedule })).toContain('schedule');
  });

  it.each(['0 8 * * *', '30 6,18 * * 1-5', '15 7 1 * *'])('accepts the schedule %s', (schedule) => {
    expect(over({ schedule })).toBeNull();
  });

  it.each(['relative/path', '~/notes', '$HOME/notes', '/a/../b', '/a/.shelly/b', '/a b/c', '/a;b', '/'])('refuses the folder %s', (outputFolder) => {
    expect(over({ outputFolder })).toContain('outputFolder');
  });

  it('holds every step to the 500-character limit, refusing rather than cutting', () => {
    expect(over({ instructions: { ...instructions, research: 'x'.repeat(500) } })).toBeNull();
    expect(over({ instructions: { ...instructions, research: 'x'.repeat(501) } })).toContain('500');
    expect(over({ instructions: { ...instructions, write: 'x'.repeat(501) } })).toContain('500');
    expect(over({ instructions: { ...instructions, revise: 'x'.repeat(501) } })).toContain('500');
    expect(over({ queue: true, instructions: { ...instructions, topics: 'x'.repeat(501) } })).toContain('500');
  });

  it('counts the output contract into the review instruction', () => {
    const room = 500 - REVIEW_OUTPUT_CONTRACT.length - 2;
    const fits = buildArticlePipeline(config({ instructions: { ...instructions, review: 'x'.repeat(room) } }) as ArticlePipelineConfig);
    const review = (fits.orchestration.steps as AgentOrchestrationStep[])[2].instruction;
    expect(review).toHaveLength(500);
    expect(over({ instructions: { ...instructions, review: 'x'.repeat(room + 1) } })).not.toBeNull();
  });

  it('needs all four instructions, and a queue for topics', () => {
    const { revise: _revise, ...missing } = instructions;
    void _revise;
    expect(over({ instructions: missing })).toContain('revise');
    expect(over({ instructions: { ...instructions, topics: '次のテーマ' } })).toContain('queue');
    expect(over({ instructions: { ...instructions, extra: 'x' } })).toContain('extra');
  });

  it.each(['research', 'write', 'review'])('needs a %s engine: there is no default', (key) => {
    const { [key as 'research']: _gone, ...rest } = engines;
    void _gone;
    expect(over({ engines: rest })).toContain(key);
    expect(over({ engines: undefined })).toContain('engines');
  });

  it('allows only the engines the executor can dispatch', () => {
    const src = fs.readFileSync(path.join(root, 'scripts/shelly-plan-executor.js'), 'utf8');
    const dispatchable = /STEP_TOOL_DISPATCHABLE_TYPES = \[([^\]]+)\]/.exec(src)![1];
    ARTICLE_ENGINE_TYPES.forEach((type) => expect(dispatchable).toContain(`'${type}'`));
    expect(over({ engines: { ...engines, write: { type: 'openrouter' } } })).toContain('use one of');
  });

  it('refuses a CLI: the existing rules do not let one run a longform step', () => {
    for (const cli of ['codex', 'claude']) expect(over({ engines: { ...engines, write: { type: 'cli', cli } } })).toContain('CLI');
    expect(executor.longformPlanRefusal({ action: { type: 'draft' }, steps: { longform: true, list: [{ tool: { type: 'cli', cli: 'codex' } }] } })).not.toBe('');
  });

  it('takes a text-only CLI for write and review, and carries it to the steps and the plan', () => {
    const claude = { type: 'cli', cli: 'claude', textOnly: true };
    const codex = { type: 'cli', cli: 'codex', textOnly: true, model: 'gpt-test' };
    expect(over({ engines: { ...engines, write: claude, review: codex } })).toBeNull();
    const config = { ...EXAMPLE_CONFIGS['example-a'], engines: { ...EXAMPLE_CONFIGS['example-a'].engines, write: claude, review: codex } } as unknown as ArticlePipelineConfig;
    const preset = buildArticlePipeline(config);
    const steps = preset.orchestration.steps as AgentOrchestrationStep[];
    expect(steps.filter((s) => s.tool?.type === 'cli')).toHaveLength(5);
    expect(steps[0].tool).toEqual(EXAMPLE_CONFIGS['example-a'].engines.research);
    expect(preset.tool?.type).toBe('gemini-api');
    expect(preset.action).toEqual({ type: 'draft' });
    expect(preset.autonomous).toBe(false);
    const plan = buildAgentPlanSpec(agentFrom(preset));
    expect(plan.cliWorker).toBeDefined();
    expect(executor.textOnlyPlanRefusal(plan)).toBe('');
    expect(executor.longformPlanRefusal(plan)).toBe('');
    expect(plan.steps!.list.map((_s: unknown, i: number) => executor.isTextOnlyCliStep(plan, i))).toEqual([false, true, true, true, true, true, false]);
  });

  it('refuses a CLI anywhere else, without the flag, or with anything extra', () => {
    const claude = { type: 'cli', cli: 'claude', textOnly: true };
    expect(over({ engines: { ...engines, research: claude } })).toContain('a CLI cannot run this step');
    expect(over({ engines: { ...engines, agent: claude } })).toContain('a CLI cannot run this step');
    expect(over({ engines: { ...engines, write: { type: 'cli', cli: 'claude', textOnly: false } } })).toContain('textOnly');
    expect(over({ engines: { ...engines, write: { type: 'cli', cli: 'claude', textOnly: 'true' } } })).toContain('textOnly');
    expect(over({ engines: { ...engines, write: { type: 'cli', cli: 'gemini', textOnly: true } } })).toContain('.cli');
    expect(over({ engines: { ...engines, write: { ...claude, tools: ['Bash'] } } })).toContain('unknown field');
    expect(over({ engines: { ...engines, write: { ...claude, model: 'x; rm -rf' } } })).toContain('bad model');
    expect(articleDigestConfigError({ ...EXAMPLE_DIGEST, engine: claude })).toContain('a CLI cannot run this step');
  });

  it('refuses the local LLM, api-call and unknown engines, and a bad model', () => {
    expect(over({ engines: { ...engines, write: { type: 'local' } } })).toContain('local');
    expect(over({ engines: { ...engines, write: { type: 'ab-article-eval' } } })).not.toBeNull();
    expect(over({ engines: { ...engines, write: { type: 'auto' } } })).not.toBeNull();
    expect(over({ engines: { ...engines, write: { type: 'groq', model: 'a b' } } })).toContain('model');
    expect(over({ engines: { ...engines, write: { type: 'groq', extra: 1 } } })).toContain('extra');
  });
});

describe('the digest', () => {
  const preset = exampleDigestPipeline();

  it('is [list-drafts, assemble] with no model step, and saves to its folder', () => {
    const steps = preset.orchestration.steps as AgentOrchestrationStep[];
    expect(steps.map((s) => s.local?.kind)).toEqual(['list-drafts', 'assemble']);
    expect(steps.every((s) => !s.tool)).toBe(true);
    expect(preset.action).toEqual({ type: 'draft' });
    expect(preset.autonomous).toBe(false);
    expect(preset.tool).toEqual(EXAMPLE_DIGEST.engine);
    expect(preset.output).toEqual({ outputPath: EXAMPLE_DIGEST.outputFolder, outputTemplate: '{date}-digest.md' });
  });

  it('its plan runs, and only it is a digest plan', () => {
    const plan = JSON.parse(JSON.stringify(buildAgentPlanSpec(agentFrom(preset))));
    expect(plan.steps.list).toHaveLength(2);
    plan.steps.list.forEach((s: AgentOrchestrationStep, i: number) => expect(executor.normalizeStepLocal(s.local, i)).toEqual(s.local));
    expect(executor.isDigestPlan(plan)).toBe(true);
    expect(() => executor.validatePlan(plan)).not.toThrow();
    const stream = JSON.parse(JSON.stringify(buildAgentPlanSpec(agentFrom(examplePipeline('example-queue')))));
    expect(executor.isDigestPlan(stream)).toBe(false);
    expect(executor.quietDraftNotification(stream, 'draft')).toBe(true);
  });

  it.each([
    [{ streams: [] }],
    [{ streams: [{ folder: '../x', label: 'x' }] }],
    [{ streams: [{ folder: 'A' }] }],
    [{ engine: undefined }],
    [{ engine: { type: 'cli', cli: 'codex' } }],
    [{ schedule: '* * * * *' }],
    [{ outputFolder: '~/x' }],
    [{ extra: 1 }],
  ])('refuses %j', (patch) => {
    expect(articleDigestConfigError({ ...EXAMPLE_DIGEST, ...patch })).not.toBeNull();
  });
});

describe('the config file', () => {
  const text = (file: unknown) => JSON.stringify(file);
  const good = { version: 1, pipelines: [EXAMPLE_CONFIGS['example-a'], EXAMPLE_CONFIGS['example-queue']], digest: EXAMPLE_DIGEST };
  const reply = (stdout: string, exitCode = 0) => async () => ({ stdout, exitCode });

  it('the example in the public doc is a valid file', () => {
    const doc = fs.readFileSync(path.join(root, 'docs/article-pipeline-config.md'), 'utf8');
    const block = doc.split('```')[1];
    const json = block.slice(block.indexOf('{'));
    const parsed = parseArticlePipelineFile(json);
    expect('error' in parsed ? parsed.error : null).toBeNull();
    expect(selectArticlePipeline(json, '@agent article pipeline garden-notes', articleOutputRoots({}, '/home/x'))).toHaveProperty('preset');
  });

  it('parses a good file', () => {
    expect('file' in parseArticlePipelineFile(text(good))).toBe(true);
  });

  it.each([
    ['broken JSON', '{'],
    ['a list', '[]'],
    ['a wrong version', text({ ...good, version: 2 })],
    ['an unknown field', text({ ...good, extra: 1 })],
    ['no pipelines', text({ version: 1 })],
    ['a bad pipeline', text({ ...good, pipelines: [{ id: 'x' }] })],
    ['a duplicate id', text({ ...good, pipelines: [EXAMPLE_CONFIGS['example-a'], EXAMPLE_CONFIGS['example-a']] })],
    ['the reserved digest id', text({ ...good, pipelines: [{ ...EXAMPLE_CONFIGS['example-a'], id: 'digest' }] })],
    ['too many pipelines', text({ ...good, pipelines: Array.from({ length: 17 }, (_, i) => ({ ...EXAMPLE_CONFIGS['example-a'], id: `p${i}` })) })],
    ['a bad digest', text({ ...good, digest: { name: 'x' } })],
  ])('refuses %s, and says why', (_name, body) => {
    const parsed = parseArticlePipelineFile(body);
    expect('error' in parsed && parsed.error.length).toBeGreaterThan(0);
    expect(selectArticlePipeline(body, REQUEST, ROOTS)).toMatchObject({ refusal: 'invalid' });
  });

  it('picks by id, including the digest', () => {
    expect(selectArticlePipeline(text(good), REQUEST, ROOTS)).toEqual({ preset: examplePipeline('example-a') });
    expect(selectArticlePipeline(text(good), '記事パイプライン EXAMPLE-QUEUE', ROOTS)).toEqual({ preset: examplePipeline('example-queue') });
    expect(selectArticlePipeline(text(good), '記事パイプライン digest', ROOTS)).toEqual({ preset: exampleDigestPipeline() });
  });

  it('asks which one when the name is missing or ambiguous', () => {
    expect(selectArticlePipeline(text(good), '記事パイプラインを作って', ROOTS)).toEqual({ refusal: 'pick', ids: ['example-a', 'example-queue', 'digest'] });
    expect(selectArticlePipeline(text(good), '記事パイプライン example-a example-queue', ROOTS)).toMatchObject({ refusal: 'pick' });
  });

  it('takes the only pipeline without a name, and an unknown name is not it', () => {
    const single = text({ version: 1, pipelines: [EXAMPLE_CONFIGS['example-a']] });
    expect(selectArticlePipeline(single, '記事パイプラインを作って', ROOTS)).toEqual({ preset: examplePipeline('example-a') });
    expect(selectArticlePipeline(text({ version: 1, pipelines: [] }), '記事パイプライン', ROOTS)).toEqual({ refusal: 'pick', ids: [] });
  });

  it('a missing file refuses, and no agent is built', async () => {
    expect(await loadArticlePipeline(REQUEST, reply('', 44), ROOTS)).toEqual({ refusal: 'missing' });
  });

  it('reads the fixed path, skips a symlink, and caps the size', async () => {
    const run = jest.fn(reply(text(good)));
    expect(await loadArticlePipeline(REQUEST, run, ROOTS)).toEqual({ preset: examplePipeline('example-a') });
    const cmd = run.mock.calls[0] as unknown as string[];
    expect(cmd[0]).toContain('$HOME/.shelly/agents/article-pipelines.json');
    expect(cmd[0]).toContain('[ -L "$f" ]');
    expect(cmd[0]).toContain('head -c 262145');
    expect(await loadArticlePipeline(REQUEST, reply('x'.repeat(262145)), ROOTS)).toEqual({ refusal: 'invalid', detail: 'file is too large' });
  });

  it('never throws on a failed read', async () => {
    expect(await loadArticlePipeline(REQUEST, reply('', 1), ROOTS)).toMatchObject({ refusal: 'invalid' });
    expect(await loadArticlePipeline(REQUEST, async () => { throw new Error('boom'); }, ROOTS)).toMatchObject({ refusal: 'invalid' });
  });

  it('refuses a folder outside the vault and the custom root, and says which', () => {
    const outside = { ...EXAMPLE_CONFIGS['example-a'], outputFolder: '/storage/other/Drafts' };
    expect(selectArticlePipeline(text({ version: 1, pipelines: [outside] }), REQUEST, ROOTS)).toEqual({
      refusal: 'invalid',
      detail: expect.stringContaining(ROOTS.vault),
    });
  });

  it('a queue and a digest must be in the vault; a plain pipeline may use the custom root', () => {
    const inCustom = { outputFolder: `${ROOTS.custom}/Drafts/` };
    const plain = text({ version: 1, pipelines: [{ ...EXAMPLE_CONFIGS['example-a'], ...inCustom }] });
    const queued = text({ version: 1, pipelines: [{ ...EXAMPLE_CONFIGS['example-queue'], ...inCustom }] });
    const digest = text({ version: 1, pipelines: [], digest: { ...EXAMPLE_DIGEST, ...inCustom } });
    expect(selectArticlePipeline(plain, REQUEST, ROOTS)).toHaveProperty('preset');
    expect(selectArticlePipeline(queued, REQUEST, ROOTS)).toMatchObject({ refusal: 'invalid' });
    expect(selectArticlePipeline(digest, 'digest', ROOTS)).toMatchObject({ refusal: 'invalid' });
  });

  it('compares folders by path segment, across the names of the same storage', () => {
    const r = { vault: '/sdcard/Vault', custom: '/sdcard/Out' };
    expect(articleOutputFolderError('/sdcard/Vault', r, true)).toBeNull();
    expect(articleOutputFolderError('/sdcard/Vault/a/', r, true)).toBeNull();
    expect(articleOutputFolderError('/storage/emulated/0/Vault/a', r, true)).toBeNull();
    expect(articleOutputFolderError('/sdcard/Vault2/a', r, true)).not.toBeNull();
    expect(articleOutputFolderError('/sdcard/Out/a', r, true)).not.toBeNull();
    expect(articleOutputFolderError('/sdcard/Out/a', r, false)).toBeNull();
  });

  it('takes the roots from the settings, with the same defaults as the agent env', () => {
    expect(articleOutputRoots({}, '/h')).toEqual({ vault: '/sdcard/Documents/ObsidianVault', custom: '/h/agent-output' });
    expect(articleOutputRoots({ agentVaultPath: ' ~/v ', agentCustomPath: '/x' }, '/h')).toEqual({ vault: '/h/v', custom: '/x' });
  });

  it.each([
    ['echo {} > ~/.shelly/agents/article-pipelines.json'],
    ['cd ~/.shelly/agents && echo {} > article-pipelines.json'],
    ['cd ~/.shelly/agents && rm article-pipelines.json'],
    [`cd ~/.shelly/agents && node -e "require('fs').writeFileSync('article-pipelines.json','')"`],
  ])('the gate protects the file from %s', (command) => {
    expect(touchesProtectedPolicyFiles(command)).toBe(true);
  });

  it('the gate does not stop reading the file, or a file of that name elsewhere', () => {
    expect(touchesProtectedPolicyFiles('cat ~/.shelly/agents/article-pipelines.json')).toBe(false);
    expect(touchesProtectedPolicyFiles('echo {} > /tmp/article-pipelines.json')).toBe(false);
  });

  it('the hook reads it only for the user\'s own typing, passes it on, and refuses cleanly', () => {
    const hook = fs.readFileSync(path.join(root, 'hooks/use-ai-pane-dispatch.ts'), 'utf8');
    expect(hook).toContain('if (dispatchOpts?.typedByUser === true && !dispatchOpts?.source && isArticlePipelineRequest(promptText)) {');
    expect(hook).toContain('articleOutputRoots(useSettingsStore.getState().settings, getHomePath())');
    expect(hook).toContain('useSettingsStore.getState().socialConnectors ?? [], articlePreset);');
    expect(hook).toContain("if ('refusal' in lookup) {");
    expect(hook).toContain('draft.autonomous = !draft.longform && (');
  });

  it('has the refusals in both languages', () => {
    for (const file of ['en', 'ja']) {
      const locale = fs.readFileSync(path.join(root, `lib/i18n/locales/${file}.ts`), 'utf8');
      for (const key of ['article_pipeline_no_file', 'article_pipeline_pick', 'article_pipeline_invalid']) expect(locale).toContain(`'agents.${key}'`);
    }
  });
});

describe('the draft from a config', () => {
  it('keeps the steps, a draft action and autonomous:false', () => {
    const d = draftFor();
    expect(d.longform).toBe(true);
    expect(d.autonomous).toBe(false);
    expect(d.action).toEqual({ type: 'draft' });
    expect(d.schedule).toBe('30 5 * * *');
    expect(d.orchestrationSteps).toEqual(normalizeSteps(examplePipeline('example-a').orchestration));
    expect(d.memory).toBeUndefined();
    expect(d.toolExplicit).toBe(true);
  });

  it("takes the user's own schedule from the request", () => {
    expect(parseAgentNL('毎日21時に記事パイプライン example-a', [], examplePipeline('example-a')).schedule).toBe('0 21 * * *');
  });

  it('never picks up memory from the request', () => {
    expect(parseAgentNL('記事パイプライン example-a、これを覚えておいて', [], examplePipeline('example-a')).memory).toBeUndefined();
  });

  it('stays a draft and says so when asked to post', () => {
    const d = parseAgentNL('記事パイプライン example-a をXに投稿して', [], examplePipeline('example-a'));
    expect(d.action.type).toBe('draft');
    expect(d.actionCaveat).toContain('下書き');
  });

  it('is confirmed in plain chat and always needs the typed OK', () => {
    const d = draftFor();
    expect(shouldUseChatConfirm(d)).toBe(true);
    expect(isAutoRegisterEligibleDraft(d)).toBe(false);
    expect(nextMissingSlot(d, {} as any)).toBeNull();
  });

  it('states where it saves and names the engines, without the output contract', () => {
    const text = summarizeAgentDraftAsText(draftFor(), undefined, false, { cloudConsent: false });
    expect(text).toContain(`${EXAMPLE_FOLDER}/SeriesA/`);
    expect(text).toContain('Gemini');
    expect(text).not.toContain('Output contract');
    expect(text).not.toContain('named in your request');
    expect(text).not.toContain('リクエストで指定');
    expect(text).toMatch(/OK|Say the word/);
  });

  it('hands the chain, the flag and the output to registration', () => {
    const confirmed = draftToConfirmedAgentDraft(draftFor());
    expect(confirmed.autonomous).toBe(false);
    expect(confirmed.longform).toBe(true);
    expect(confirmed.presetOutput?.outputTemplate).toBe('{date}-example-a.md');
    expect(confirmed.orchestrationSteps).toHaveLength(7);
  });

  it('a text-only engine survives the chat confirm and is named in it', () => {
    const base = EXAMPLE_CONFIGS['example-a'];
    const claude = { type: 'cli' as const, cli: 'claude' as const, textOnly: true as const };
    const draft = parseAgentNL(REQUEST, [], buildArticlePipeline({ ...base, engines: { ...base.engines, write: claude } }));
    const steps = draftToConfirmedAgentDraft(draft).orchestrationSteps as AgentOrchestrationStep[];
    expect(steps[1].tool).toEqual(claude);
    expect(summarizeAgentDraftAsText(draft, undefined, false, { cloudConsent: false })).toContain('Claude Code');
  });

  it('an edit of a registered agent keeps the longform flag', () => {
    expect(agentToParsedAgentDraft(agentFrom(examplePipeline('example-a'))).longform).toBe(true);
  });

  it('the hook passes the output through', () => {
    const hook = fs.readFileSync(path.join(root, 'hooks/use-ai-pane-dispatch.ts'), 'utf8');
    expect(hook).toContain('outputPath: confirmed.presetOutput?.outputPath ?? `$HOME/.shelly/agents/${safeName}/output.md`');
    expect(hook).toContain('outputTemplate: confirmed.presetOutput.outputTemplate');
    expect(hook).toContain('...(confirmed.longform ? { longform: true } : {})');
  });
});

describe('the plan from a config', () => {
  it.each(ALL)('%s passes the executor\'s own validation', (stream) => {
    const preset = examplePipeline(stream);
    const steps = preset.orchestration.steps as AgentOrchestrationStep[];
    const plan = JSON.parse(JSON.stringify(buildAgentPlanSpec(agentFrom(preset))));
    expect(plan.steps.longform).toBe(true);
    expect(plan.steps.list).toHaveLength(steps.length);
    expect(plan.steps.budget.maxSteps).toBe(steps.length);
    expect(plan.steps.isolation).toBeUndefined();
    expect(plan.agent.autonomous).toBe(false);
    expect(plan.action.type).toBe('draft');
    expect(plan.output.useGlobalOutput).toBe(false);
    expect(plan.output.outputDir).toBe(EXAMPLE_CONFIGS[stream].outputFolder);
    expect(plan.output.outputNameTemplate).toBe(`{date}-${stream}.md`);
    const last = plan.steps.list[steps.length - 1];
    expect(executor.normalizeStepLocal(last.local, steps.length - 1)).toEqual(last.local);
    expect(executor.longformPlanRefusal(plan)).toBe('');
    expect(() => executor.validatePlan(plan)).not.toThrow();
  });

  it('keeps the base prompt out of the research-collection wrapper', () => {
    const plan = JSON.parse(JSON.stringify(buildAgentPlanSpec(agentFrom(examplePipeline('example-a')))));
    expect(plan.prompt).not.toContain('research-collection agent');
    expect(plan.prompt).toContain('サンプル連載');
  });

  it('REGRESSION: a chain without longform has no key', () => {
    const agent = { ...agentFrom(examplePipeline('example-a')), orchestration: { steps: ['collect', 'summarize'] } };
    expect('longform' in buildAgentPlanSpec(agent).steps!).toBe(false);
  });
});

describe('editing a longform draft', () => {
  it.each(['通知して', 'https://example.com/hook にPOSTして', 'bashで実行して'])('%s cannot change its action', (reply) => {
    const patched = applyDraftPatch(draftFor(), reply);
    expect(patched?.patchedDraft.action ?? { type: 'draft' }).toEqual({ type: 'draft' });
  });

  it.each(['全部Codexで', '2番目をCodexで', 'use codex for all steps', '全部Claude Codeで'])('%s cannot pin a CLI', (reply) => {
    expect(applyDraftPatch(draftFor(), reply)).toBeNull();
    expect((draftFor().orchestrationSteps as AgentOrchestrationStep[]).some((s) => s.tool?.type === 'cli')).toBe(false);
  });

  it('a change of cloud engine still applies', () => {
    expect(applyDraftPatch(draftFor(), '2番目をGroqで')).not.toBeNull();
  });

  it('cannot turn it autonomous', () => {
    expect(applyDraftPatch(draftFor(), '承認なしで実行して')?.patchedDraft.autonomous ?? false).toBe(false);
  });

  it('REGRESSION: an ordinary draft can still change its action', () => {
    expect(applyDraftPatch(parseAgentNL('毎朝ニュースをまとめて保存して'), '通知して')?.patchedDraft.action.type).toBe('notify');
  });
});

describe('agent registration is confirmed in plain chat text', () => {
  const pane = fs.readFileSync(path.join(root, 'components/panes/AIPane.tsx'), 'utf8');

  it('renders no Confirm / Cancel row under a chat-native draft', () => {
    expect(pane).not.toContain('AgentChatConfirm');
    const branch = pane.slice(pane.indexOf('if (message.agentChatConfirm) {'), pane.indexOf('<AgentConfirmCard'));
    expect(branch).toContain('{message.content}');
    expect(branch).not.toMatch(/TouchableOpacity|Pressable|onConfirmAgentDraft|onCancelAgentDraft/);
  });

  it('no message sends the user to a button that is gone', () => {
    for (const file of ['en', 'ja']) {
      const locale = fs.readFileSync(path.join(root, `lib/i18n/locales/${file}.ts`), 'utf8');
      const notices = locale.split('\n').filter((l) => l.includes("'agentplan.superseded_notice"));
      expect(notices).toHaveLength(2);
      notices.forEach((l) => expect(l).not.toMatch(/button|ボタン/));
    }
  });

  it('REGRESSION: a tool the user really named still says so', () => {
    const d = { ...parseAgentNL('毎朝パープレでニュースを集めて保存して'), longform: undefined };
    expect(summarizeAgentDraftAsText(d, undefined, false, { cloudConsent: false })).toMatch(/named in your request|リクエストで指定/);
  });
});

describe('run without approval on a pipeline agent', () => {
  it('carries the setting from the request, like any other agent', () => {
    const en = parseAgentNL('@agent article pipeline example-a run without approval', [], examplePipeline('example-a'));
    expect(en.runWithoutApproval).toBe(true);
    expect(en.runWithoutApprovalLevel).toBeUndefined();
    expect(en.longform).toBe(true);
    const ja = parseAgentNL('@agent 記事パイプライン example-a 承認なしで実行', [], examplePipeline('example-a'));
    expect(ja.runWithoutApproval).toBe(true);
  });
  it('stays off without the phrase or when it is negated', () => {
    expect(draftFor().runWithoutApproval).toBeUndefined();
    expect(parseAgentNL("@agent article pipeline example-a, don't run it without approval", [], examplePipeline('example-a')).runWithoutApproval).toBeUndefined();
  });
});
