jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { normalizeSteps } from '@/lib/agent-orchestration';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';
import { buildArticlePipeline, type ArticlePipelineConfig } from '@/lib/agent-pipeline-presets';
import { EXAMPLE_CONFIGS } from './fixtures/article-pipeline-config';

// Executor v63: run-start hot reload of the article tunables from
// ~/.shelly/agents/article-pipelines.json (articleConfigOverlay). Only engines
// per phase, editor.minScore and a lower reviewRounds may change; everything
// else in the plan stays as stored. Every name, file and fact here is made up.

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const assetCopy = path.join(root, 'modules', 'terminal-emulator', 'android', 'src', 'main', 'assets', 'shelly-plan-executor.js');
const fixtureBroker = path.join(root, '__tests__', 'fixtures', 'fs-write-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const FOLDER = '/storage/example/Notes/Drafts/SeriesA/';
const example = (over: Record<string, unknown> = {}): ArticlePipelineConfig =>
  ({ ...EXAMPLE_CONFIGS['example-a'], outputFolder: FOLDER, editor: { type: 'groq', rubric: 'Concrete examples.' }, ...over }) as ArticlePipelineConfig;

/** A plan as buildAgentPlanSpec would store it for `config` (the parts the overlay reads). */
function planFor(config: ArticlePipelineConfig, extra: Record<string, unknown> = {}): any {
  const preset = buildArticlePipeline(config);
  return {
    agent: { id: 'agent-x', name: preset.name, autonomous: false },
    prompt: preset.prompt,
    tool: preset.tool,
    action: { type: 'draft' },
    output: { outputDir: config.outputFolder, outputNameTemplate: '{date}-x.md' },
    steps: { list: normalizeSteps(preset.orchestration), budget: { maxSteps: 10, totalTimeoutMs: 1 }, longform: true },
    ...extra,
  };
}
const fileWith = (...pipelines: unknown[]) => ({ version: 1, pipelines });
const deepCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('articleConfigOverlay (pure)', () => {
  it('lays engines and editor.minScore over a copy exactly as creation would build them', () => {
    const stored = example();
    const plan = planFor(stored);
    const before = deepCopy(plan);
    const edited = example({
      engines: { research: { type: 'perplexity', model: 'sonar', searchMode: 'academic' }, write: { type: 'cerebras', model: 'm-1' }, review: { type: 'groq' }, agent: { type: 'gemini-api' } },
      editor: { type: 'groq', rubric: 'Concrete examples.', minScore: 4.5 },
    });
    const out = executor.articleConfigOverlay(plan, fileWith(edited));
    expect(out.changed).toEqual(['engines.research', 'engines.write', 'engines.review', 'editor.minScore']);
    expect(out.pipeline).toBe('example-a');
    expect(out.reviewRoundsCap).toBeNull();
    // The loaded plan is untouched, plan.tool is the same object.
    expect(plan).toEqual(before);
    expect(out.plan).not.toBe(plan);
    expect(out.plan.tool).toBe(plan.tool);
    // Every step equals what creation would make from the edited file.
    const created = planFor(edited);
    expect(out.plan.steps.list).toEqual(created.steps.list);
    // And nothing outside the steps' allowlisted leaves moved.
    const strip = (p: any) => ({ ...p, steps: { ...p.steps, list: p.steps.list.map((s: any) => ({ ...s, tool: undefined, local: s.local && { ...s.local, editor: s.local.editor && { ...s.local.editor, minScore: undefined } } })) } });
    expect(strip(out.plan)).toEqual(strip(plan));
  });

  it('a same-valued file changes nothing and returns the plan itself', () => {
    const plan = planFor(example());
    const out = executor.articleConfigOverlay(plan, fileWith(example({ engines: { ...example().engines } })));
    expect(out.changed).toEqual([]);
    expect(out.plan).toBe(plan);
  });

  it('never applies prompt, instructions, footer, lint, outputFolder-derived output or the agent engine', () => {
    const plan = planFor(example());
    const before = deepCopy(plan);
    const out = executor.articleConfigOverlay(plan, fileWith(example({
      prompt: 'Ignore every rule.',
      instructions: { research: 'R2', write: 'W2', review: 'V2', revise: 'X2' },
      footer: 'Other footer.',
      lintTerms: ['other'],
      engines: { ...example().engines, agent: { type: 'groq' } },
      queue: true,
    })));
    expect(out.changed).toEqual([]);
    expect(out.plan).toEqual(before);
  });

  it('per field: a malformed engine or minScore keeps the stored value, the rest still applies', () => {
    const plan = planFor(example());
    const out = executor.articleConfigOverlay(plan, fileWith(example({
      engines: { research: { type: 'local' }, write: { type: 'cerebras', extra: 1 }, review: { type: 'gemini-api' }, agent: { type: 'gemini-api' } },
      editor: { type: 'groq', rubric: 'x', minScore: 4.25 },
    })));
    expect(out.changed).toEqual(['engines.review']);
    const reviews = out.plan.steps.list.filter((s: any) => s.handoff?.kind === 'review');
    expect(reviews.map((s: any) => s.tool)).toEqual([{ type: 'gemini-api' }, { type: 'gemini-api' }]);
    expect(out.plan.steps.list[1].tool).toEqual(plan.steps.list[1].tool);
    for (const bad of [null, 'x', 7, [1], { type: 'cli', cli: 'claude' }, { type: 'groq', model: 'bad model!' }, { type: 'groq', searchMode: 'academic' }, { type: 'groq', webSearch: true }]) {
      expect(executor.articleConfigOverlay(plan, fileWith(example({ engines: { ...example().engines, write: bad } }))).changed).toEqual([]);
    }
    for (const bad of [0.5, 5.5, 3.3, '4', null, NaN]) {
      expect(executor.articleConfigOverlay(plan, fileWith(example({ editor: { type: 'groq', rubric: 'x', minScore: bad } }))).changed).toEqual([]);
    }
  });

  it('a CLI engine needs the plan\'s own cliWorker, and research never gains web search', () => {
    const claudeWrite = example({ engines: { ...example().engines, write: { type: 'cli', cli: 'claude', textOnly: true } } });
    expect(executor.articleConfigOverlay(planFor(example()), fileWith(claudeWrite)).changed).toEqual([]);
    const withWorker = planFor(example(), { cliWorker: { cwd: '/x', policy: {} } });
    const out = executor.articleConfigOverlay(withWorker, fileWith(claudeWrite));
    expect(out.changed).toEqual(['engines.write']);
    expect(out.plan.cliWorker).toBe(withWorker.cliWorker);
    expect(executor.textOnlyPlanRefusal(out.plan)).toBe('');
    const webSearch = example({ engines: { ...example().engines, research: { type: 'cli', cli: 'codex', textOnly: true, webSearch: true } } });
    expect(executor.articleConfigOverlay(withWorker, fileWith(webSearch)).changed).toEqual([]);
    // A plan that already researches on the web-search CLI may change its model, or move to HTTP.
    const stored = planFor(webSearch, { cliWorker: { cwd: '/x', policy: {} } });
    const model = example({ engines: { ...webSearch.engines, research: { type: 'cli', cli: 'codex', textOnly: true, webSearch: true, model: 'gpt-x' } } });
    expect(executor.articleConfigOverlay(stored, fileWith(model)).plan.steps.list[0].tool).toEqual({ type: 'cli', cli: 'codex', textOnly: true, webSearch: true, model: 'gpt-x' });
    expect(executor.articleConfigOverlay(stored, fileWith(example())).plan.steps.list[0].tool).toEqual({ type: 'perplexity', model: 'sonar-pro' });
  });

  it('reviewRounds only lowers the bound; the steps stay', () => {
    const three = planFor(example({ reviewRounds: 3 }));
    const out = executor.articleConfigOverlay(three, fileWith(example({ reviewRounds: 2 })));
    expect(out.changed).toEqual(['reviewRounds']);
    expect(out.reviewRoundsCap).toBe(2);
    expect(out.plan.steps.list).toBe(three.steps.list);
    expect([6, 7].map((i) => executor.reviewRoundCapped(out.plan.steps.list, i, 2))).toEqual([true, true]);
    expect([2, 3, 4, 5, 8].some((i) => executor.reviewRoundCapped(out.plan.steps.list, i, 2))).toBe(false);
    // More rounds than the plan has steps for, or absent: nothing.
    expect(executor.articleConfigOverlay(planFor(example()), fileWith(example({ reviewRounds: 3 }))).changed).toEqual([]);
    expect(executor.articleConfigOverlay(three, fileWith(example())).changed).toEqual([]);
  });

  it('matches on the normalized output folder, exactly once', () => {
    const plan = planFor(example());
    const switched = { engines: { ...example().engines, write: { type: 'cerebras' } } };
    const aliased = example({ ...switched, outputFolder: '/storage/example/Notes/Drafts/./SeriesA' });
    expect(executor.articleConfigOverlay(plan, fileWith(aliased)).changed).toEqual(['engines.write']);
    const emulated = planFor(example({ outputFolder: '/sdcard/Notes/A/' }));
    expect(executor.articleConfigOverlay(emulated, fileWith(example({ ...switched, outputFolder: '/storage/emulated/0/Notes/A' }))).changed).toEqual(['engines.write']);
    // Two pipelines on the folder, or none: no overlay.
    expect(executor.articleConfigOverlay(plan, fileWith(example(switched), example({ ...switched, id: 'other' }))).changed).toEqual([]);
    expect(executor.articleConfigOverlay(plan, fileWith(example({ ...switched, outputFolder: '/storage/example/Other/' }))).changed).toEqual([]);
  });

  it('never throws, and leaves digests and odd plans alone', () => {
    const plan = planFor(example());
    for (const parsed of [null, undefined, 7, 'x', {}, { pipelines: 'x' }, { pipelines: [null, 7, { outputFolder: { toString: null } }] }]) {
      expect(executor.articleConfigOverlay(plan, parsed).plan).toBe(plan);
    }
    expect(executor.articleConfigOverlay(null, fileWith(example())).changed).toEqual([]);
    const digest = { ...plan, steps: { longform: true, list: [{ local: { kind: 'list-drafts', streams: [] } }, { local: { kind: 'assemble' } }] } };
    expect(executor.articleConfigOverlay(digest, fileWith(example())).plan).toBe(digest);
    const autonomous = { ...plan, agent: { ...plan.agent, autonomous: true } };
    expect(executor.articleConfigOverlay(autonomous, fileWith(example({ engines: { ...example().engines, write: { type: 'cerebras' } } }))).changed).toEqual([]);
  });

  it('both executor copies stay byte-identical', () => {
    expect(fs.readFileSync(assetCopy, 'utf8')).toBe(fs.readFileSync(scriptCopy, 'utf8'));
  });
});

describe('a run with the config file reloaded', () => {
  const LOCAL_URL = '127.0.0.1';
  const GROQ = 'api.groq.com';
  const CEREBRAS = 'api.cerebras.ai';
  const SOURCE_URL = 'https://example.org/paper-a';
  const AGENT_ID = 'agent-hotreload';
  const STREAM = 'reload-example';
  const LOCAL = { type: 'local', label: 'Local LLM', model: 'fixture' };
  const RESEARCH = '1. Paper A: a figure. https://example.org/paper-a';
  const FIRST = '# A title\n\nThe first version says the cache keeps 3 entries [1].';
  const SECOND = '# A title\n\nThe answer first: 3 entries. The second version explains why [1].';
  const THIRD = '# A title\n\nThe answer first: 3 entries. The third version adds the limits [1].';
  const WRITE_INSTRUCTION = 'Write a post. The first line is a "# " heading.';
  const answer = (score = 5) => JSON.stringify(Object.fromEntries(executor.EDITOR_KEYS.map((k: string) => [k, { score, reason: 'Fine.' }])));
  const openAi = (text: string) => ({ body: { choices: [{ message: { content: text }, finish_reason: 'stop' }], citations: [SOURCE_URL] } });

  function config(over: Partial<ArticlePipelineConfig> = {}): ArticlePipelineConfig {
    return {
      id: STREAM,
      name: 'Reload example draft',
      prompt: 'An example series for general readers.',
      lang: 'en',
      schedule: '30 5 * * *',
      outputFolder: '/storage/example/Notes/Drafts/Reload',
      footer: 'Configured footer.',
      instructions: {
        research: 'Search the web for the one topic and write notes.',
        write: WRITE_INSTRUCTION,
        review: 'The notes are the only evidence.',
        revise: 'Apply every finding.',
      },
      engines: { research: { type: 'gemini-api' }, write: { type: 'groq' }, review: { type: 'cerebras' } },
      ...over,
    };
  }

  interface Setup { home: string; planFile: string; http: string; outputDir: string }

  /** The stored plan: research and review on the plan's LOCAL tool, write and
   *  revise pinned to Groq (`pinWrite`), an optional Groq editor. */
  function setup(opts: { replies: Record<string, unknown[]>; rounds?: 2 | 3; editor?: boolean; file?: (outputDir: string) => unknown; pinWrite?: boolean }): Setup {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-hotreload-'));
    fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
    fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
    const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-hotreload-vault-')));
    const outputDir = path.join(vault, 'Drafts', 'Reload');
    fs.mkdirSync(outputDir, { recursive: true });
    const http = path.join(home, 'fake-http.json');
    fs.writeFileSync(http, JSON.stringify(opts.replies));
    const built = buildArticlePipeline(config({ reviewRounds: opts.rounds ?? 2, ...(opts.editor ? { editor: { type: 'groq', rubric: 'Readers are developers.', minScore: 3.5 } } : {}) }));
    const list = normalizeSteps(built.orchestration).map((step: any, i: number) => {
      const writeSide = i === 1 || step.handoff?.kind === 'revise';
      if (writeSide && opts.pinWrite !== false) return step;
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
    if (opts.file) {
      const body = opts.file(outputDir);
      fs.writeFileSync(path.join(home, '.shelly/agents/article-pipelines.json'), typeof body === 'string' ? body : JSON.stringify(body));
    }
    return { home, planFile, http, outputDir };
  }

  function run(s: Setup, env: Record<string, string> = {}): Promise<number | null> {
    return new Promise((resolve) => {
      const args = [scriptCopy, '--plan-file', s.planFile, '--home', s.home, '--agent-id', AGENT_ID, '--broker', fixtureBroker, '--unattended', '1'];
      const childEnv: Record<string, string | undefined> = { ...process.env, HOME: s.home, SHELLY_TEST_LONGFORM_RETRY_WAIT_MS: '10', SHELLY_TEST_FAKE_HTTP: s.http, ...env };
      delete childEnv.SHELLY_RUN_ORIGIN;
      if (!env.SHELLY_CAP_TAINTED) delete childEnv.SHELLY_CAP_TAINTED;
      delete childEnv.SHELLY_INGRESS_TAINTED;
      const child = spawn(process.execPath, args, { env: childEnv as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      child.on('close', (status) => resolve(status));
    });
  }

  const logDir = (home: string) => path.join(home, `.shelly/agents/logs/${AGENT_ID}`);
  const readRunLog = (home: string): any => {
    const files = fs.readdirSync(logDir(home)).filter((n) => /^\d+\.json$/.test(n)).sort();
    return JSON.parse(fs.readFileSync(path.join(logDir(home), files[files.length - 1]), 'utf8'));
  };
  const allEvents = (home: string): any[] => {
    try {
      return fs.readFileSync(path.join(logDir(home), 'plan-executor-audit.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  const events = (home: string, event: string): any[] => allEvents(home).filter((e) => e.event === event);
  const readResult = (home: string) => fs.readFileSync(path.join(home, `.shelly/tmp/agent-result-${AGENT_ID}.md`), 'utf8');
  const calls = (s: Setup): string[] => (fs.existsSync(`${s.http}.calls`) ? fs.readFileSync(`${s.http}.calls`, 'utf8').trim().split('\n').filter(Boolean) : []);
  const prompts = (s: Setup, host: string): string[] => {
    const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
    const bodies = read(`${s.http}.bodies`).map((b) => JSON.parse(b));
    return calls(s).map((c, i) => (c === host ? JSON.parse(bodies[i]).messages[0].content : null)).filter((p): p is string => p !== null);
  };
  const frontmatter = (text: string) => text.slice(0, text.indexOf('\n---\n', 4));
  // The file the owner edits: this agent's pipeline with the given changes.
  const pipelineFile = (over: Partial<ArticlePipelineConfig>, extra: unknown[] = []) => (outputDir: string) => ({
    version: 1,
    pipelines: [config({ ...over, outputFolder: outputDir }), ...extra],
  });
  // A write -> revise -> PASS chain where every write-side call answers on `host`.
  const passReplies = (writeHost: string) => ({
    [LOCAL_URL]: [RESEARCH, 'VERDICT: REVISE\n1. Fix the marker.', 'VERDICT: PASS'].map(openAi),
    [writeHost]: [FIRST, SECOND].map(openAi),
  });

  it('(1) an engine switch in the file is used by the run, with one audit line', async () => {
    const s = setup({ replies: passReplies(CEREBRAS), file: pipelineFile({ engines: { research: { type: 'gemini-api' }, write: { type: 'cerebras' }, review: { type: 'cerebras' } } }) });
    expect(await run(s)).toBe(0);
    expect(readRunLog(s.home).status).toBe('success');
    expect(calls(s)).toEqual([LOCAL_URL, CEREBRAS, LOCAL_URL, CEREBRAS, LOCAL_URL]);
    const reloaded = events(s.home, 'article_config_reloaded');
    expect(reloaded).toEqual([{ ts: expect.any(String), kind: 'plan.executor', event: 'article_config_reloaded', agentId: AGENT_ID, pipeline: STREAM, fields: ['engines.write'] }]);
    expect(JSON.stringify(reloaded)).not.toContain(s.outputDir);
    // The plan file on disk is untouched.
    expect(JSON.parse(fs.readFileSync(s.planFile, 'utf8')).steps.list[1].tool).toEqual({ type: 'groq' });
    expect(readResult(s.home)).toContain('The second version explains why');
  }, 60000);

  it('(2) minScore and reviewRounds changes apply', async () => {
    const s = setup({
      rounds: 3,
      editor: true,
      pinWrite: false,
      replies: {
        [LOCAL_URL]: [RESEARCH, FIRST, 'VERDICT: REVISE\n1. Fix the marker.', SECOND, 'VERDICT: REVISE\n1. Name the limits.', THIRD, 'VERDICT: PASS'].map(openAi),
        [GROQ]: [answer(), answer(), answer(), answer(), answer()].map(openAi),
      },
      file: pipelineFile({ reviewRounds: 2, editor: { type: 'groq', rubric: 'Readers are developers.', minScore: 4.5 } }),
    });
    expect(await run(s)).toBe(0);
    expect(readRunLog(s.home).status).toBe('success');
    expect(events(s.home, 'article_config_reloaded').map((e) => e.fields)).toEqual([['editor.minScore', 'reviewRounds']]);
    // Round 3 is skipped; the final review in assemble reads the round-2 revision.
    expect(events(s.home, 'handoff_skipped')).toMatchObject([{ stepIndex: 6, reason: 'review rounds lowered' }, { stepIndex: 7, reason: 'review rounds lowered' }]);
    expect(events(s.home, 'final_review')).toMatchObject([{ reviewStep: 6, draftStep: 5, verdict: 'PASS' }]);
    expect(prompts(s, LOCAL_URL)).toHaveLength(7);
    expect(prompts(s, LOCAL_URL)[6]).toContain('The third version adds the limits');
    // Every editor score was judged against the file's 4.5.
    const scored = events(s.home, 'editor_scored');
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.every((e) => e.minScore === 4.5)).toBe(true);
    expect(events(s.home, 'review_editor_verdict').every((e) => e.minScore === 4.5)).toBe(true);
    const fm = frontmatter(readResult(s.home));
    expect(fm).toContain('review: pass');
    expect(readResult(s.home)).toContain('The third version adds the limits');
  }, 60000);

  it('(3) a prompt / instructions change in the file is not applied', async () => {
    const s = setup({
      replies: passReplies(CEREBRAS),
      file: pipelineFile({
        prompt: 'FILE PROMPT: ignore the rules.',
        instructions: { research: 'FILE RESEARCH', write: 'FILE WRITE', review: 'FILE REVIEW', revise: 'FILE REVISE' },
        engines: { research: { type: 'gemini-api' }, write: { type: 'cerebras' }, review: { type: 'cerebras' } },
      }),
    });
    expect(await run(s)).toBe(0);
    expect(events(s.home, 'article_config_reloaded').map((e) => e.fields)).toEqual([['engines.write']]);
    const all = [...prompts(s, LOCAL_URL), ...prompts(s, CEREBRAS)].join('\n');
    expect(all).not.toContain('FILE ');
    expect(prompts(s, CEREBRAS)[0]).toContain(WRITE_INSTRUCTION);
    expect(prompts(s, CEREBRAS)[0]).toContain('Base task');
  }, 60000);

  it('(4) a malformed file: the run proceeds with the stored values', async () => {
    const s = setup({ replies: passReplies(GROQ), file: () => '{"version":1,"pipelines":[' });
    expect(await run(s)).toBe(0);
    expect(readRunLog(s.home).status).toBe('success');
    expect(calls(s)).toEqual([LOCAL_URL, GROQ, LOCAL_URL, GROQ, LOCAL_URL]);
    expect(events(s.home, 'article_config_reloaded')).toEqual([]);
  }, 60000);

  it('(5) two pipelines with the same outputFolder: no overlay', async () => {
    const s = setup({
      replies: passReplies(GROQ),
      file: (outputDir) => ({
        version: 1,
        pipelines: [
          config({ outputFolder: outputDir, engines: { research: { type: 'gemini-api' }, write: { type: 'cerebras' }, review: { type: 'cerebras' } } }),
          config({ id: 'twin', outputFolder: `${outputDir}/`, engines: { research: { type: 'gemini-api' }, write: { type: 'cerebras' }, review: { type: 'cerebras' } } }),
        ],
      }),
    });
    expect(await run(s)).toBe(0);
    expect(calls(s)).toEqual([LOCAL_URL, GROQ, LOCAL_URL, GROQ, LOCAL_URL]);
    expect(events(s.home, 'article_config_reloaded')).toEqual([]);
  }, 60000);

  it('(6) a tainted run: no overlay', async () => {
    const s = setup({ replies: passReplies(GROQ), file: pipelineFile({ engines: { research: { type: 'gemini-api' }, write: { type: 'cerebras' }, review: { type: 'cerebras' } } }) });
    await run(s, { SHELLY_CAP_TAINTED: '1' });
    expect(calls(s)).not.toContain(CEREBRAS);
    expect(calls(s)).toContain(GROQ);
    expect(events(s.home, 'article_config_reloaded')).toEqual([]);
  }, 60000);

  it('(7) no matching pipeline: no overlay, no audit noise', async () => {
    const s = setup({
      replies: passReplies(GROQ),
      file: () => ({ version: 1, pipelines: [config({ outputFolder: '/storage/example/Notes/Drafts/Elsewhere', engines: { research: { type: 'gemini-api' }, write: { type: 'cerebras' }, review: { type: 'cerebras' } } })] }),
    });
    expect(await run(s)).toBe(0);
    expect(calls(s)).toEqual([LOCAL_URL, GROQ, LOCAL_URL, GROQ, LOCAL_URL]);
    expect(events(s.home, 'article_config_reloaded')).toEqual([]);
  }, 60000);
});
