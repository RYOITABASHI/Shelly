jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import * as ts from 'typescript';
import * as TS from '@/lib/agent-sources';
import { buildStepPrompt as tsBuildStepPrompt } from '@/lib/agent-orchestration';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';
import { DEMO_UTTERANCE, PERPLEXITY_RESPONSE } from './fixtures/sourced-briefing';

// Sourced briefings (2026-10-09): the unattended PlanSpec executor carries a
// generated JS port of lib/agent-sources.ts. These tests pin (1) that the
// port is exactly the transpiled TS (no hand drift), (2) behavioural parity
// on the shared fixtures, (3) the request-shaping (model choice / recency /
// grounding / cooler synthesis), and (4) the full 3-step chain end to end
// against the real executor + broker, offline.

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(scriptCopy);

const PORT_BEGIN = '// ── Sourced briefings (2026-10-09) ──';
const PORT_END = '// ── end sourced briefings port ──';

function normalizeCode(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

describe('generated port of lib/agent-sources.ts', () => {
  it('the executor block is exactly the transpiled TS module (types stripped)', () => {
    const src = fs.readFileSync(path.join(root, 'lib/agent-sources.ts'), 'utf8');
    const transpiled = ts
      .transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext } })
      .outputText.replace(/^export /gm, '');
    const exec = fs.readFileSync(scriptCopy, 'utf8');
    const begin = exec.indexOf(PORT_BEGIN);
    const end = exec.indexOf(PORT_END);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    expect(normalizeCode(exec.slice(begin, end))).toBe(normalizeCode(transpiled));
  });
});

describe('behavioural parity TS <-> JS', () => {
  const llmFinal = [
    '# On-device AI Briefing',
    '',
    "1. **Apple Unveils 'Apple Neural LLM' on iPhone 17** — Apple launched a new neural LLM. [1]",
    '2. **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** — Faster NPU. [4]',
    '3. **Qualcomm Launches Snapdragon AI Engine 3.0** — no citation.',
    '4. **Google releases Gemma 3n for on-device AI** — 2GB phones. [1]',
  ].join('\n');

  function bothEvidence() {
    const tsEv = TS.createChainEvidence();
    const jsEv = executor.createChainEvidence();
    const content = PERPLEXITY_RESPONSE.choices[0].message.content;
    const tsCarry = TS.absorbResearchStep(tsEv, content, TS.parseResearchSources(JSON.stringify(PERPLEXITY_RESPONSE)));
    const jsCarry = executor.absorbResearchStep(jsEv, content, executor.parseResearchSources(JSON.stringify(PERPLEXITY_RESPONSE)));
    return { tsEv, jsEv, tsCarry, jsCarry };
  }

  it('parses sources identically (citations+search_results, search_results-only, text block)', () => {
    expect(executor.parseResearchSources(PERPLEXITY_RESPONSE)).toEqual(TS.parseResearchSources(PERPLEXITY_RESPONSE));
    const { citations, ...rest } = PERPLEXITY_RESPONSE;
    void citations;
    expect(executor.parseResearchSources(rest)).toEqual(TS.parseResearchSources(rest));
    const text = 'x [1]\n\n## Sources\n[1] A — https://a.example/1\n[2] B — https://b.example/2';
    expect(executor.extractSourcesFromText(text)).toEqual(TS.extractSourcesFromText(text));
  });

  it('absorbs research, renders evidence, post-processes identically', () => {
    const { tsEv, jsEv, tsCarry, jsCarry } = bothEvidence();
    expect(jsCarry).toBe(tsCarry);
    expect(jsEv).toEqual(tsEv);
    const ev = { mode: 'synthesis' as const, sources: tsEv.sources, items: tsEv.items, count: 3 };
    expect(executor.renderStepEvidence(ev)).toBe(TS.renderStepEvidence(ev));
    const research = { mode: 'research' as const, today: '2026-10-09', recency: 'month' as const, count: 3 };
    expect(executor.buildStepPrompt(DEMO_UTTERANCE, 'search', [], research)).toBe(tsBuildStepPrompt(DEMO_UTTERANCE, 'search', [], research));
    expect(executor.buildStepPrompt(DEMO_UTTERANCE, 'summarize', [tsCarry], ev)).toBe(tsBuildStepPrompt(DEMO_UTTERANCE, 'summarize', [tsCarry], ev));
    const opts = { finalize: true, maxItems: 3 };
    expect(executor.postProcessSourcedOutput(llmFinal, jsEv, opts)).toEqual(TS.postProcessSourcedOutput(llmFinal, tsEv, opts));
    expect(executor.postProcessSourcedOutput('uncited essay text here', jsEv, opts)).toEqual(
      TS.postProcessSourcedOutput('uncited essay text here', tsEv, opts),
    );
    expect(executor.enforceSourcedIntermediate('essay', jsEv, 3)).toBe(TS.enforceSourcedIntermediate('essay', tsEv, 3));
  });

  it('intent helpers agree', () => {
    for (const s of [DEMO_UTTERANCE, 'Base task', '最新のAIニュースを5件集めて', "today's headlines", 'deep research report']) {
      expect(executor.requiresWebFacts(s)).toBe(TS.requiresWebFacts(s));
      expect(executor.detectRecency(s)).toBe(TS.detectRecency(s));
      expect(executor.requestedItemCount(s)).toBe(TS.requestedItemCount(s));
      expect(executor.choosePerplexityModel('sonar-deep-research', s)).toBe(TS.choosePerplexityModel('sonar-deep-research', s));
    }
    expect(executor.NO_SOURCES_MESSAGE).toBe(TS.NO_SOURCES_MESSAGE);
  });
});

describe('request shaping (applySourcingRequestOptions)', () => {
  const basePlan = (tool: any, sourcing?: any) => ({ prompt: 'p', tool, ...(sourcing ? { sourcing } : {}) });
  const research = { mode: 'research', recency: 'month', requestText: DEMO_UTTERANCE };

  it('no sourcing = byte-identical request body', () => {
    const req = executor.modelRequest(basePlan({ type: 'perplexity', model: 'sonar-deep-research' }), {});
    expect(req.body).toEqual({ model: 'sonar-deep-research', messages: [{ role: 'user', content: 'p' }] });
  });

  it('research on Perplexity: sonar-pro for a top-N news list + search_recency_filter', () => {
    const req = executor.modelRequest(basePlan({ type: 'perplexity', model: 'sonar-deep-research' }, research), {});
    expect(req.body.model).toBe('sonar-pro');
    expect(req.body.search_recency_filter).toBe('month');
  });

  it('keeps sonar-deep-research when explicitly asked, and honours a user PERPLEXITY_MODEL pin', () => {
    const deep = { ...research, requestText: 'Do a deep research report on on-device AI news' };
    expect(executor.modelRequest(basePlan({ type: 'perplexity', model: 'sonar-deep-research' }, deep), {}).body.model).toBe('sonar-deep-research');
    expect(
      executor.modelRequest(basePlan({ type: 'perplexity', model: 'sonar-deep-research' }, research), { PERPLEXITY_MODEL: 'sonar-reasoning-pro' }).body.model,
    ).toBe('sonar-reasoning-pro');
  });

  it('research on Gemini enables Google Search grounding', () => {
    const req = executor.modelRequest(basePlan({ type: 'gemini-api' }, research), {});
    expect(req.body.tools).toEqual([{ google_search: {} }]);
  });

  it('synthesis on the local LLM runs cooler and shorter', () => {
    const req = executor.modelRequest(basePlan({ type: 'local', model: 'Qwen3.5-2B-Q4_K_M' }, { mode: 'synthesis' }), {});
    expect(req.body.temperature).toBe(0.2);
    expect(req.body.max_tokens).toBe(1024);
    const plain = executor.modelRequest(basePlan({ type: 'local', model: 'Qwen3.5-2B-Q4_K_M' }), {});
    expect(plain.body.temperature).toBeUndefined();
    expect(plain.body.max_tokens).toBe(2048);
  });
});

// ─── End-to-end against the real executor + broker ──────────────────────────

const AGENT_ID = 'agent-sourced-briefing';

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-sourced-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

const STEPS = [
  { instruction: 'search the web with Perplexity for the top 3 on-device AI news stories.' },
  { instruction: 'summarize them with the local LLM.' },
  { instruction: 'write a markdown briefing.' },
];

function writePlan(home: string, port: number, actionType = 'notify') {
  const plan = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Sourced Briefing', autonomous: false, autonomyLevel: 'L2' },
    prompt: DEMO_UTTERANCE,
    tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
    action: { type: actionType },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'sourced-briefing',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    steps: { list: STEPS, budget: { maxSteps: 6, totalTimeoutMs: 30 * 60_000 } },
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  fs.writeFileSync(
    path.join(home, '.shelly/agents/.env'),
    `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n`,
  );
  return planFile;
}

function runExecutor(planFile: string, home: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptCopy, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('close', (status) => resolve(status));
  });
}

function readRunLog(home: string): any {
  const logDir = path.join(home, `.shelly/agents/logs/${AGENT_ID}`);
  const files = fs.readdirSync(logDir).filter((n) => /^\d+\.json$/.test(n)).sort();
  return JSON.parse(fs.readFileSync(path.join(logDir, files[files.length - 1]), 'utf8'));
}

function readNotification(home: string): any {
  return JSON.parse(fs.readFileSync(path.join(home, `.shelly/agents/logs/${AGENT_ID}/native-result-notification.json`), 'utf8'));
}

function readResultFile(home: string): string {
  return fs.readFileSync(path.join(home, `.shelly/tmp/agent-result-${AGENT_ID}.md`), 'utf8');
}

const FABRICATED_FINAL = [
  '# On-device AI Briefing',
  '',
  'The on-device AI space moved fast this month.',
  '',
  "1. **Apple Unveils 'Apple Neural LLM' on iPhone 17** — Apple launched a neural LLM. [1]",
  '2. **Google releases Gemma 3n for on-device AI** — Runs on phones with 2GB of RAM. [1]',
  '3. **Qualcomm Launches Snapdragon AI Engine 3.0** — Faster AI engine.',
  '4. **Google releases Gemma 3n for on-device AI** — Duplicate. [1]',
  '5. **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** — Faster Hexagon NPU. [4]',
].join('\n');

describe('shelly-plan-executor.js — sourced 3-step briefing chain', () => {
  let server: http.Server;
  let port = 0;
  let requests: any[];
  let handler: (body: any, n: number) => { status?: number; json: any };

  beforeEach((done) => {
    requests = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body);
        requests.push(parsed);
        const out = handler(parsed, requests.length);
        res.statusCode = out.status || 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(out.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  const content = (text: string) => ({ choices: [{ message: { content: text } }] });

  it('carries sources across 3 steps, enforces the contract, and saves a sourced briefing', async () => {
    handler = (_body, n) => {
      if (n === 1) return { json: PERPLEXITY_RESPONSE };
      if (n === 2) return { json: content('On-device AI is booming, with many companies shipping exciting new things this month.') };
      return { json: content(FABRICATED_FINAL) };
    };
    const home = makeHome();
    const rc = await runExecutor(writePlan(home, port), home);
    expect(rc).toBe(0);
    expect(requests).toHaveLength(3);

    // Step 1: research directive with today's date + recency + structured list.
    const p1 = requests[0].messages[0].content;
    expect(p1).toContain(TS.RESEARCH_REQUIREMENTS_MARKER);
    expect(p1).toMatch(/Today's date is \d{4}-\d{2}-\d{2}\. Only include items published in the last 30 days\./);
    expect(p1).toContain('up to 3 items');
    expect(requests[0].temperature).toBeUndefined();

    // Step 2: structured Sources (not subject to the text carry) + contract, cooler sampling.
    const p2 = requests[1].messages[0].content;
    expect(p2).toContain('[1] Announcing Gemma 3n — https://blog.google/technology/developers/gemma-3n/ (2026-09-30)');
    expect(p2).toContain('[4] Snapdragon 8 Elite Gen 5 — https://www.qualcomm.com/news/releases/2026/09/snapdragon-8-elite-gen-5 (2026-09-24)');
    expect(p2).toContain(TS.SOURCING_CONTRACT_MARKER);
    expect(p2.endsWith('# This step\nsummarize them with the local LLM.')).toBe(true);
    expect(requests[1].temperature).toBe(0.2);
    expect(requests[1].max_tokens).toBe(1024);

    // Step 3: step 2's uncited essay was replaced by the deterministic
    // research-item template before being carried forward.
    const p3 = requests[2].messages[0].content;
    expect(p3).not.toContain('booming');
    expect(p3).toContain('Google releases Gemma 3n for on-device AI');
    expect(p3).toContain(TS.SOURCING_CONTRACT_MARKER);

    // Final output: fabricated / uncited / duplicate items gone, renumbered,
    // programmatic Sources section with real links.
    const saved = readResultFile(home);
    expect(saved).not.toMatch(/Neural LLM/);
    expect(saved).not.toMatch(/AI Engine 3\.0/);
    expect(saved).not.toMatch(/moved fast/);
    expect(saved.match(/Gemma 3n for on-device AI\*\*/g)).toHaveLength(1);
    expect(saved).toContain('1. **Google releases Gemma 3n for on-device AI** — Runs on phones with 2GB of RAM. [1]');
    expect(saved).toContain('2. **Qualcomm unveils Snapdragon 8 Elite Gen 5 NPU** — Faster Hexagon NPU. [2]');
    expect(saved).toContain('## Sources');
    expect(saved).toContain('- [1] [Announcing Gemma 3n](https://blog.google/technology/developers/gemma-3n/) — 2026-09-30');
    expect(saved).toContain('- [2] [Snapdragon 8 Elite Gen 5](https://www.qualcomm.com/news/releases/2026/09/snapdragon-8-elite-gen-5) — 2026-09-24');

    const log = readRunLog(home);
    expect(log.status).toBe('success');
    expect(log.steps).toHaveLength(3);
    expect(readNotification(home).status).toBe('success');
    const audit = fs.readFileSync(path.join(home, `.shelly/agents/logs/${AGENT_ID}/plan-executor-audit.jsonl`), 'utf8');
    expect(audit).toContain('"event":"sourcing_research"');
    expect(audit).toContain('"event":"sourcing_postprocess"');
  }, 30000);

  it('falls back to the deterministic template when the final model call fails outright', async () => {
    handler = (_body, n) => {
      if (n === 1) return { json: PERPLEXITY_RESPONSE };
      if (n === 2) return { json: content('- **Apple expands Foundation Models framework** — opened to developers. [2]') };
      return { status: 500, json: { error: 'model crashed' } };
    };
    const home = makeHome();
    const rc = await runExecutor(writePlan(home, port), home);
    expect(rc).toBe(0);
    const saved = readResultFile(home);
    expect(saved).toMatch(/^# Briefing — \d{4}-\d{2}-\d{2}/);
    expect(saved).toContain('**Google releases Gemma 3n for on-device AI**');
    expect(saved).toContain('## Sources');
    expect(readRunLog(home).status).toBe('success');
  }, 30000);

  it('zero sources from the research step -> run fails with a clear message, nothing is written', async () => {
    handler = (_body, n) => {
      if (n === 1) return { json: content('1. **Apple Neural LLM** — Apple did a thing.\n2. **Qualcomm AI Engine 3.0** — Qualcomm did a thing.') };
      return { json: content('should never be requested') };
    };
    const home = makeHome();
    const rc = await runExecutor(writePlan(home, port, 'draft'), home);
    expect(rc).toBe(0);
    expect(requests).toHaveLength(1);
    const log = readRunLog(home);
    expect(log.status).toBe('error');
    expect(log.steps).toHaveLength(2);
    expect(log.steps[1].outputPreview).toBe(TS.NO_SOURCES_MESSAGE);
    expect(log.errorMessage).toContain('No verifiable sources');
    expect(log.savedPath).toBeUndefined();
    expect(fs.existsSync(path.join(home, 'agent-output'))).toBe(false);
    expect(readNotification(home).status).toBe('error');
  }, 30000);

  it('non-web chains are untouched (no evidence block, preview carry, default sampling)', async () => {
    handler = (_body, n) => ({ json: content(`RESULT#${n}`) });
    const home = makeHome();
    const planFile = writePlan(home, port);
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    plan.prompt = 'Base task';
    plan.steps.list = [{ instruction: 'gather sources' }, { instruction: 'draft the body' }, { instruction: 'polish and finalize' }];
    fs.writeFileSync(planFile, JSON.stringify(plan));
    const rc = await runExecutor(planFile, home);
    expect(rc).toBe(0);
    expect(requests[0].messages[0].content).toBe('Base task\n\n# This step\ngather sources');
    expect(requests[1].messages[0].content).not.toContain('# Sources');
    expect(requests[1].temperature).toBeUndefined();
    expect(readRunLog(home).status).toBe('success');
  }, 30000);
});
