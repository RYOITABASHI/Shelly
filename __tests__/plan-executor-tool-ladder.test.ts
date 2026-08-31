jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { PLAN_SPEC_KIND, PLAN_SPEC_SCHEMA_VERSION } from '@/lib/agent-plan-spec';

// DEFERRED.md「PlanSpec executor 経由の無人発火は、品質ゲートでlocalが弾かれても
// エスカレーションラダーへ進まない」: end-to-end proof that
// requestModelContentWithLadder actually retries a failed primary tool
// through plan.toolLadder and succeeds via the retry candidate, using the
// REAL executor + REAL capability broker subprocesses (no mocking of
// modelRequest/brokerHttp/extractModelContent). The primary (gemini-api)
// fails deterministically because GEMINI_API_KEY is absent from .env — a
// real capability-broker rc=43 "no configured secret" failure that never
// touches the network — and the retry candidate (local) points at a
// synthetic HTTP server that returns real content.

const root = path.resolve(__dirname, '..');
const executor = path.join(root, 'scripts', 'shelly-plan-executor.js');
const broker = path.join(root, 'scripts', 'shelly-capability-broker.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executorModule = require(executor) as {
  requestModelContentWithLadder: (paths: any, opts: any, plan: any, config: any, checkQuality: boolean) => any;
  trustedNativeLowRiskAction: (args: any, plan: any, actionType: string) => boolean;
};

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-ladder-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/tmp'), { recursive: true });
  return home;
}

const AGENT_ID = 'agent-ladder-smoke';

function writePlan(
  home: string,
  overrides: { toolLadder?: unknown[]; toolLadderExhaustedNote?: string } = {},
): string {
  const plan: Record<string, unknown> = {
    kind: PLAN_SPEC_KIND,
    schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
    generatedAt: 1,
    agent: { id: AGENT_ID, name: 'Ladder Smoke', autonomous: true, autonomyLevel: 'L2' },
    prompt: 'say hello',
    tool: { type: 'gemini-api', label: 'Gemini API', model: 'gemini-2.5-flash', authRef: 'gemini' },
    ...('toolLadder' in overrides ? { toolLadder: overrides.toolLadder } : {}),
    ...(overrides.toolLadderExhaustedNote ? { toolLadderExhaustedNote: overrides.toolLadderExhaustedNote } : {}),
    action: { type: 'draft' },
    paths: { home },
    output: {
      outputDir: path.join(home, 'agent-output'),
      outputNameTemplate: '{date}-{slug}',
      slug: 'ladder-smoke',
      useGlobalOutput: true,
      suggestedRoots: [],
    },
    limits: { timeoutSeconds: 30, maxConcurrent: 2 },
    policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
    routeDecision: { route: 'cloud', toolType: 'gemini-api', toolLabel: 'Gemini API', guard: 'configured-tool', why: 'test' },
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));
  return planFile;
}

function writeEnv(home: string, localPort: number): void {
  // Deliberately NO GEMINI_API_KEY — the capability broker refuses the
  // primary attempt with a real, deterministic rc=43 before any network call.
  const envFile = path.join(home, '.shelly/agents/.env');
  // Fable5 review 2026-08-25 flipped the default action-approval mode to
  // manual-unless-explicitly-opted-out — without this line the real
  // subprocess these tests spawn waits for an approval reply that never
  // comes; this file is about toolLadder retry mechanics, not the gate.
  fs.writeFileSync(
    envFile,
    `LOCAL_LLM_URL='http://127.0.0.1:${localPort}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n`,
  );
  // The broker's checkSecretFilePermissions() refuses a secrets file wider
  // than 0600 on POSIX (CI/Android; a Windows dev checkout's chmod is a
  // near-no-op, which is why this only surfaced on Linux CI).
  fs.chmodSync(envFile, 0o600);
}

function runExecutor(planFile: string, home: string): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [executor, '--plan-file', planFile, '--home', home, '--agent-id', AGENT_ID, '--broker', broker], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.on('close', (status) => resolve(status));
  });
}

function readSoleRunLog(home: string): any {
  const logDir = path.join(home, `.shelly/agents/logs/${AGENT_ID}`);
  const runLogs = fs.readdirSync(logDir).filter((name) => /^\d+\.json$/.test(name));
  expect(runLogs).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(logDir, runLogs[0]), 'utf8'));
}

describe('shelly-plan-executor — toolLadder retry (real executor + real broker subprocesses)', () => {
  let server: import('http').Server;
  let port = 0;
  let localRequestCount = 0;

  beforeEach((done) => {
    localRequestCount = 0;
    const http = require('http');
    server = http.createServer((req: any, res: any) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        localRequestCount += 1;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'retry candidate succeeded' } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? (address as any).port : 0;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('retries to the toolLadder candidate when the primary tool fails (missing GEMINI_API_KEY), and the run log records the candidate as toolUsed', async () => {
    const home = makeHome();
    writeEnv(home, port);
    const planFile = writePlan(home, {
      toolLadder: [{ type: 'local', label: 'Local LLM', model: 'fixture' }],
    });

    const status = await runExecutor(planFile, home);
    expect(status).toBe(0);

    // The primary (gemini-api) never reached the network — only the retry
    // candidate's synthetic server saw a request.
    expect(localRequestCount).toBe(1);

    const runLog = readSoleRunLog(home);
    expect(runLog.status).toBe('success');
    expect(runLog.toolUsed).toBe('Local LLM');
    expect(runLog.outputPreview).toContain('retry candidate succeeded');

    const draftFiles = fs.readdirSync(path.join(home, 'agent-output'), { recursive: true } as any) as string[];
    expect(draftFiles.some((f) => f.endsWith('.md'))).toBe(true);
  }, 20000);

  it('fails with a Codex-explaining message when the ladder is empty (no HTTP-dispatchable retry candidate exists)', async () => {
    const home = makeHome();
    writeEnv(home, port);
    const planFile = writePlan(home, {
      toolLadder: [],
      toolLadderExhaustedNote: 'Every HTTP-dispatchable backend in the escalation ladder failed. This needs Codex or an attended run.',
    });

    const status = await runExecutor(planFile, home);
    expect(status).toBe(0);
    // The synthetic local server never received a request — there was no
    // retry candidate to try it with.
    expect(localRequestCount).toBe(0);

    const runLog = readSoleRunLog(home);
    expect(runLog.status).toBe('error');
    expect(runLog.errorMessage).toContain('no configured secret');
    expect(runLog.errorMessage).toContain('This needs Codex or an attended run.');
  }, 20000);

  it('does not retry at all when plan.toolLadder is absent — single-shot behavior unchanged for a plan built before this feature', async () => {
    const home = makeHome();
    writeEnv(home, port);
    const planFile = writePlan(home); // no toolLadder key at all

    const status = await runExecutor(planFile, home);
    expect(status).toBe(0);
    expect(localRequestCount).toBe(0);

    const runLog = readSoleRunLog(home);
    expect(runLog.status).toBe('error');
    expect(runLog.toolUsed).toBe('Gemini API');
  }, 20000);

  it('the plan executor and its APK asset mirror are byte-identical (toolLadder addition)', () => {
    const executorSrc = fs.readFileSync(executor, 'utf8');
    const assetSrc = fs.readFileSync(
      path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-plan-executor.js'),
      'utf8',
    );
    expect(assetSrc).toBe(executorSrc);
    expect(executorSrc).toContain('function requestModelContentWithLadder(');
  });
});

describe('shelly-plan-executor — toolLadder retries a LOW-QUALITY primary completion too (2nd-pass Codex review finding)', () => {
  // Both `tool` and the sole `toolLadder` entry are type 'local' here — an
  // unrealistic shape for a REAL buildAgentPlanSpec output (which never
  // offers the same tool type twice), but it lets one synthetic server
  // exercise the actual retry LOOP: request #1 (the primary attempt) returns
  // content isLowQualityCompletion flags as a refusal; request #2 (the
  // toolLadder retry) returns real content. This isolates exactly what the
  // 2nd-pass Codex review caught — checkQuality must be true for the
  // final/single-shot step too, or this second request never happens at all.
  let server: import('http').Server;
  let port = 0;
  let requestCount = 0;

  beforeEach((done) => {
    requestCount = 0;
    const http = require('http');
    server = http.createServer((req: any, res: any) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        requestCount += 1;
        res.setHeader('Content-Type', 'application/json');
        const content = requestCount === 1 ? 'As an AI, I cannot generate that content.' : 'genuinely good content from the retry';
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? (address as any).port : 0;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('retries after a low-quality primary completion and succeeds via the ladder candidate', async () => {
    const home = makeHome();
    const qualityEnvFile = path.join(home, '.shelly/agents/.env');
    fs.writeFileSync(
      qualityEnvFile,
      `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n`,
    );
    fs.chmodSync(qualityEnvFile, 0o600);
    const plan: Record<string, unknown> = {
      kind: PLAN_SPEC_KIND,
      schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
      generatedAt: 1,
      agent: { id: AGENT_ID, name: 'Ladder Quality Smoke', autonomous: true, autonomyLevel: 'L2' },
      prompt: 'say hello',
      tool: { type: 'local', label: 'Local LLM', model: 'primary-fixture' },
      toolLadder: [{ type: 'local', label: 'Local LLM (retry)', model: 'retry-fixture' }],
      action: { type: 'draft' },
      paths: { home },
      output: {
        outputDir: path.join(home, 'agent-output'),
        outputNameTemplate: '{date}-{slug}',
        slug: 'ladder-quality-smoke',
        useGlobalOutput: true,
        suggestedRoots: [],
      },
      limits: { timeoutSeconds: 30, maxConcurrent: 2 },
      policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
      routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    };
    const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const status = await runExecutor(planFile, home);
    expect(status).toBe(0);
    expect(requestCount).toBe(2);

    const runLog = readSoleRunLog(home);
    expect(runLog.status).toBe('success');
    expect(runLog.toolUsed).toBe('Local LLM (retry)');
    expect(runLog.outputPreview).toContain('genuinely good content from the retry');
  }, 20000);
});

describe('shelly-plan-executor — toolLadder retries a STRUCTURAL fabrication shape too, not just prompt-echo/refusal (2026-08-06 Codex review finding)', () => {
  // requestModelContentWithLadder's quality check ran isLowQualityCompletion
  // against previewText(resultText) — which whitespace-collapses ALL
  // newlines (see previewText's own tr-equivalent .replace(/\s+/g, ' ')) —
  // for EVERY completion, not just the prompt-echo/refusal shapes that
  // predate the 2026-08-06 duplicate-detection sync fix. The newly-ported
  // fenced-shell-block / execution-narrative detectors are newline-DEPENDENT
  // (they match a fence's opening/inner/closing lines), so a fenced-shell
  // fabrication that should be caught silently sailed through: by the time
  // isLowQualityCompletion saw it, the fence had no line breaks left to
  // recognize. dispatchActionTrusted's own webhook/api-call gates already
  // avoid this (they OR isLowQualityCompletion(preview) with
  // isLowQualityCompletion(fullResultText(resultText)) — see
  // scripts/shelly-plan-executor.js's webhookResultFull/apiResultFull) —
  // requestModelContentWithLadder must follow the same pattern.
  let server: import('http').Server;
  let port = 0;
  let requestCount = 0;

  beforeEach((done) => {
    requestCount = 0;
    const http = require('http');
    server = http.createServer((req: any, res: any) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        requestCount += 1;
        res.setHeader('Content-Type', 'application/json');
        // Verbatim shape from the fifth fabrication-shape on-device repro
        // (agent-escalation-ladder.test.ts's own fencedRepro): the ENTIRE
        // completion is one fenced shell transcript, no surrounding prose —
        // structurally identical to the fenced-shell fabrication this whole
        // effort exists to catch, but only distinguishable from a real
        // multi-line answer BEFORE newline-collapse.
        const content = requestCount === 1
          ? "```text\ncd /sdcard\necho 'test' > probe_verify.txt\ncat probe_verify.txt\n```"
          : 'genuinely good content from the retry';
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      port = typeof address === 'object' && address ? (address as any).port : 0;
      done();
    });
  });

  afterEach((done) => {
    server.close(done);
  });

  it('retries after a fenced-shell-transcript primary completion and succeeds via the ladder candidate', async () => {
    const home = makeHome();
    const qualityEnvFile = path.join(home, '.shelly/agents/.env');
    fs.writeFileSync(
      qualityEnvFile,
      `LOCAL_LLM_URL='http://127.0.0.1:${port}'\nSHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL='0'\n`,
    );
    fs.chmodSync(qualityEnvFile, 0o600);
    const plan: Record<string, unknown> = {
      kind: PLAN_SPEC_KIND,
      schemaVersion: PLAN_SPEC_SCHEMA_VERSION,
      generatedAt: 1,
      agent: { id: AGENT_ID, name: 'Ladder Structural Smoke', autonomous: true, autonomyLevel: 'L2' },
      prompt: 'say hello',
      tool: { type: 'local', label: 'Local LLM', model: 'primary-fixture' },
      toolLadder: [{ type: 'local', label: 'Local LLM (retry)', model: 'retry-fixture' }],
      // 'notify', not 'draft': draft's writeDraftOutputs goes through the
      // capability broker's fs.write op, a pre-existing Windows-dev-host
      // path-duplication failure mode unrelated to this test (see
      // plan-executor-orchestration-chain.test.ts's writePlan doc comment for
      // the same reasoning) — 'notify' exercises the identical
      // requestModelContentWithLadder + quality-gate path this test targets.
      action: { type: 'notify' },
      paths: { home },
      output: {
        outputDir: path.join(home, 'agent-output'),
        outputNameTemplate: '{date}-{slug}',
        slug: 'ladder-structural-smoke',
        useGlobalOutput: true,
        suggestedRoots: [],
      },
      limits: { timeoutSeconds: 30, maxConcurrent: 2 },
      policy: { level: 'L2', workspaceRoot: home, secretPaths: [], policyPath: '.shelly/agents/policy.json', denyPatterns: [], allowPatterns: [] },
      routeDecision: { route: 'on-device', toolType: 'local', toolLabel: 'Local LLM', guard: 'configured-tool', why: 'test' },
    };
    const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT_ID}.json`);
    fs.writeFileSync(planFile, JSON.stringify(plan, null, 2));

    const status = await runExecutor(planFile, home);
    expect(status).toBe(0);
    expect(requestCount).toBe(2);

    const runLog = readSoleRunLog(home);
    expect(runLog.status).toBe('success');
    expect(runLog.toolUsed).toBe('Local LLM (retry)');
    expect(runLog.outputPreview).toContain('genuinely good content from the retry');
  }, 20000);
});

describe('requestModelContentWithLadder — does NOT retry a TOOL_DENY policy/config refusal (Codex review finding)', () => {
  // modelRequest()'s "local PlanSpec endpoint must be loopback" guard (and its
  // "unsupported PlanSpec tool" sibling) throws a PlanFailure with exitCode
  // TOOL_DENY SYNCHRONOUSLY, before any network I/O — no real HTTP server or
  // broker subprocess is needed to exercise this. Fixed after an adversarial
  // Codex review of the first cut of this feature caught it: without the
  // exitCode check, a misconfigured non-loopback LOCAL_LLM_URL (a deliberate
  // fail-closed guard) would silently escalate to a toolLadder candidate
  // (potentially a real cloud backend) instead of stopping the run — turning
  // a security-relevant refusal into "try something else".
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-ladder-tooldeny-'));
  const paths = {
    tmpDir: home,
    envFile: path.join(home, '.env'),
    resultFile: path.join(home, 'result.md'),
  };
  fs.writeFileSync(paths.envFile, '');
  const opts = { libDir: '', broker: '', tainted: false };
  const config = {};

  function plan(overrides: Record<string, unknown> = {}) {
    return {
      agent: { id: 'a' },
      prompt: 'hi',
      tool: { type: 'local', label: 'Local LLM', model: 'fixture' },
      limits: { timeoutSeconds: 5 },
      ...overrides,
    };
  }

  it('propagates the TOOL_DENY failure immediately, without ever reaching a toolLadder candidate', async () => {
    const badPlan = plan({
      // Non-loopback — modelRequest() refuses this synchronously.
      toolLadder: [{ type: 'cerebras', label: 'Cerebras', model: 'fixture', authRef: 'cerebras' }],
    });
    // config.LOCAL_LLM_URL is absent -> chatEndpoint() defaults to
    // 127.0.0.1:8080, which IS loopback, so force a non-loopback URL the way
    // an on-device misconfiguration would via config directly (mirrors how
    // brokerHttp reads LOCAL_LLM_URL from parsed .env at runtime).
    let threw: any = null;
    try {
      await executorModule.requestModelContentWithLadder(paths, opts, badPlan, { LOCAL_LLM_URL: 'https://not-loopback.example.test' }, false);
    } catch (error) {
      threw = error;
    }
    expect(threw).not.toBeNull();
    expect(threw.message).toContain('loopback');
    // TOOL_DENY = 48 (scripts/shelly-plan-executor.js's own EXIT constant;
    // not exported, asserted by value to keep this test independent of the
    // module's internal export surface).
    expect(threw.exitCode).toBe(48);
  });
});

describe('requestModelContentWithLadder — never mutates its plan argument (3rd-pass Codex review finding)', () => {
  // A successful ladder retry must NOT change what trustedNativeLowRiskAction
  // sees as `plan.tool.type` — that function compares it against native's own
  // `--trusted-tool-type` (fixed at launch time for the ORIGINAL primary tool
  // native already vouched for) to decide whether an unattended draft/notify
  // run may auto-fire without a fresh approval wait. Mutating
  // `plan.tool` to the retry candidate would make a run that succeeded via
  // the ladder silently fail that check — this was the actual bug an earlier
  // cut of this feature shipped (`plan = Object.assign({}, plan, { tool:
  // attempt.usedTool })` in run()'s single-shot branch, and a matching
  // `stepPlan.tool = attempt.usedTool` in runOrchestrationChain).
  //
  // Deliberately network-free: both candidates fail via a broker-level
  // missing-secret check (no GEMINI_API_KEY / PERPLEXITY_API_KEY in config),
  // which happens before any HTTP dial. A live-server variant of this test
  // stays network-free so the assertion remains focused on plan immutability.
  it('leaves plan.tool completely untouched across a full (failed) ladder walk', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-plan-ladder-trust-'));
    const paths = {
      tmpDir: home,
      envFile: path.join(home, '.env'),
      resultFile: path.join(home, 'result.md'),
      brokerAuditFile: path.join(home, 'agent-driver-audit.jsonl'),
    };
    fs.writeFileSync(paths.envFile, '');
    fs.chmodSync(paths.envFile, 0o600);
    const originalToolObject = { type: 'gemini-api', label: 'Gemini API', model: 'primary', authRef: 'gemini' };
    const plan = {
      agent: { id: 'agent-trust-check' },
      prompt: 'hi',
      action: { type: 'notify' },
      tool: originalToolObject,
      toolLadder: [{ type: 'perplexity', label: 'Perplexity', model: 'retry', authRef: 'perplexity' }],
      limits: { timeoutSeconds: 5 },
    };

    let threw: any = null;
    try {
      await executorModule.requestModelContentWithLadder(paths, { libDir: '', broker, tainted: false }, plan, {}, true);
    } catch (error) {
      threw = error;
    }
    expect(threw).not.toBeNull();
    expect(threw.message).toContain('no configured secret');

    // The SAME object reference, completely unchanged — not just
    // structurally equal, the identical object trustedNativeLowRiskAction
    // would inspect.
    expect(plan.tool).toBe(originalToolObject);
    expect(plan.tool.type).toBe('gemini-api');

    const trustedArgs = {
      'trusted-autonomous-agent-id': 'agent-trust-check',
      'trusted-autonomous-action': 'notify',
      'trusted-tool-type': 'gemini-api',
    };
    expect(executorModule.trustedNativeLowRiskAction(trustedArgs, plan, 'notify')).toBe(true);
  });
});
