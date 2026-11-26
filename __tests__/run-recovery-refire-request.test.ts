import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

// Search parity item 4: an MCP-requested re-fire (request_pipeline_refire).
// scripts/shelly-run-recovery.js `--op refire-request` records an accepted
// request in the agent's audit; a sweep turns it into the S5 re-fire intent
// (plan_refire_pending) that native dispatches and the existing settling
// confirms. Native checks the web-search opt-in before calling the script.

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-run-recovery.js');
const executorCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const recovery = require(scriptCopy);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(executorCopy);

const AGENT = 'agent-devja01';
const PIPELINE = 'devja';
const MIN = 60_000;
// Local noon: every run below starts and is requested on the same local day.
const NOON = new Date(2026, 10, 25, 12, 0, 0).getTime();
const PRINCIPAL = 'a'.repeat(32);

type Json = Record<string, unknown>;

const deadProcs = { pidAlive: () => false, cmdline: () => null, listPids: () => [] as number[] };
const liveProcs = { pidAlive: () => true, cmdline: () => null, listPids: () => [] as number[] };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-refire-request-'));
  for (const d of ['plans', 'locks', `logs/${AGENT}`]) fs.mkdirSync(path.join(home, '.shelly/agents', d), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.shelly/agents/article-pipelines.json'),
    JSON.stringify({ pipelines: [{ id: PIPELINE, outputFolder: '/sdcard/Vault/devja' }] }),
  );
  const plan = {
    kind: 'shelly.agent.plan',
    schemaVersion: 1,
    agent: { id: AGENT, name: 'Dev JA' },
    prompt: 'Write the article',
    tool: { type: 'gemini-api' },
    action: { type: 'draft' },
    output: { outputDir: '/sdcard/Vault/devja', outputNameTemplate: '{date}_{slug}', slug: 'devja', useGlobalOutput: false },
    steps: {
      longform: true,
      list: [
        { instruction: 'research', tool: { type: 'cli', cli: 'codex', textOnly: true, webSearch: true } },
        { instruction: 'write', tool: { type: 'gemini-api' } },
        { instruction: 'assemble', local: { kind: 'assemble' } },
      ],
    },
  };
  const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan));
  const old = new Date(NOON - 24 * 60 * MIN);
  fs.utimesSync(planFile, old, old);
  return home;
}

const auditFile = (home: string) => path.join(home, `.shelly/agents/logs/${AGENT}/plan-executor-audit.jsonl`);
const launchFile = (home: string) => path.join(home, `.shelly/agents/logs/${AGENT}/run-launches.jsonl`);

function append(file: string, lines: Json[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
}

function readJsonl(file: string): Json[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function recoveryLines(home: string, event: string): Json[] {
  return readJsonl(auditFile(home)).filter((e) => e.kind === 'plan.recovery' && e.event === event);
}

/** A notification-triggered (ad-hoc, tainted) run that landed held, as the executor writes it. */
function heldRun(home: string, startMs: number, reason = 'web-search-refused') {
  append(auditFile(home), [
    { ts: iso(startMs), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true },
    { ts: iso(startMs + 2 * MIN), kind: 'plan.executor', event: 'article_held', agentId: AGENT, reason, stepIndex: 0, draftKept: false },
    { ts: iso(startMs + 2 * MIN + 10), kind: 'plan.executor', event: 'plan_finish', status: 'skipped', durationMs: 120_000 },
  ]);
}

function finishedRun(home: string, startMs: number, status: string, extra: Json[] = []) {
  append(auditFile(home), [
    { ts: iso(startMs), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true },
    ...extra,
    { ts: iso(startMs + MIN), kind: 'plan.executor', event: 'plan_finish', status, durationMs: 60_000 },
  ]);
}

// The definition hash native's opt-in check found on when it accepted the request.
const SHA = 'c'.repeat(64);
const OPT_INS = `${AGENT}=${SHA}`;
const candidatesOn = () => [{ agentId: AGENT, pipelineId: PIPELINE, definitionSha256: SHA, webSearchStep: true }];

function request(home: string, nowMs: number, extra: Json = {}) {
  return recovery.runOp({ home, op: 'refire-request', agentId: AGENT, pipelineId: PIPELINE, principal: PRINCIPAL, definitionSha256: SHA, nowMs, procDeps: deadProcs, executorModule: executor, ...extra });
}

function sweep(home: string, nowMs: number, procDeps = deadProcs, extra: Json = {}) {
  return recovery.runOp({ home, op: 'sweep', nowMs, procDeps, executorModule: executor, optIns: OPT_INS, optInCandidates: candidatesOn, ...extra });
}

describe('refire-request: acceptance (refireRequestDecision)', () => {
  it('accepts a held run of today, records it in the agent audit, and answers a repeat as duplicate', () => {
    const home = makeHome();
    heldRun(home, NOON - 60 * MIN);
    const r = request(home, NOON);
    expect(r).toMatchObject({ ok: true, op: 'refire-request', code: 'accepted', accepted: true, duplicate: false });
    expect(r.requestId).toMatch(/^rq-\d+-[0-9a-f]{8}$/);
    const [line] = recoveryLines(home, 'plan_refire_requested');
    expect(line).toMatchObject({
      agentId: AGENT, pipelineId: PIPELINE, requestId: r.requestId, reason: 'held:web-search-refused',
      principal: PRINCIPAL, via: 'mcp', runStartTs: iso(NOON - 60 * MIN),
    });
    // No free text from the caller anywhere in the record.
    expect(Object.keys(line).sort()).toEqual(['agentId', 'date', 'definitionSha256', 'event', 'kind', 'pipelineId', 'principal', 'reason', 'requestId', 'runId', 'runStartTs', 'ts', 'via']);
    const again = request(home, NOON + MIN);
    expect(again).toMatchObject({ code: 'duplicate', accepted: true, duplicate: true, requestId: r.requestId });
    expect(recoveryLines(home, 'plan_refire_requested')).toHaveLength(1);
  });

  it.each(['web-search-stopped', 'no-web-sources', 'fingerprint-invalid', 'text-lint', 'approval-timeout'])('accepts a run held for %s', (reason) => {
    const home = makeHome();
    heldRun(home, NOON - 30 * MIN, reason);
    expect(request(home, NOON).code).toBe('accepted');
  });

  it('accepts a failed run and a run S5 closed as orphaned without re-firing it', () => {
    const failed = makeHome();
    finishedRun(failed, NOON - 30 * MIN, 'error');
    expect(request(failed, NOON)).toMatchObject({ code: 'accepted' });
    expect(recoveryLines(failed, 'plan_refire_requested')[0].reason).toBe('failed');
    const orphan = makeHome();
    append(auditFile(orphan), [
      { ts: iso(NOON - 30 * MIN), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true },
      { ts: iso(NOON - 10 * MIN), kind: 'plan.recovery', event: 'plan_orphaned', agentId: AGENT, runId: 'x-1', runStartTs: iso(NOON - 30 * MIN), reason: 'orphaned' },
    ]);
    expect(request(orphan, NOON)).toMatchObject({ code: 'accepted' });
    expect(recoveryLines(orphan, 'plan_refire_requested')[0].reason).toBe('orphaned');
  });

  it('refuses with a reason code when there is nothing to recover', () => {
    const none = makeHome();
    expect(request(none, NOON)).toMatchObject({ code: 'no_run_today', accepted: false });
    const yesterday = makeHome();
    heldRun(yesterday, NOON - 24 * 60 * MIN);
    expect(request(yesterday, NOON).code).toBe('no_run_today');
    const ok = makeHome();
    finishedRun(ok, NOON - 30 * MIN, 'success');
    expect(request(ok, NOON).code).toBe('not_recoverable');
    const skipped = makeHome();
    finishedRun(skipped, NOON - 30 * MIN, 'skipped');
    expect(request(skipped, NOON).code).toBe('not_recoverable');
    const delivered = makeHome();
    finishedRun(delivered, NOON - 30 * MIN, 'error', [
      { ts: iso(NOON - 29 * MIN), kind: 'plan.executor', event: 'draft_saved', agentId: AGENT, folder: '/x', file: 'a.md' },
    ]);
    expect(request(delivered, NOON).code).toBe('delivered');
    const active = makeHome();
    append(auditFile(active), [{ ts: iso(NOON - 5 * MIN), kind: 'plan.executor', event: 'plan_start', agentId: AGENT }]);
    expect(request(active, NOON).code).toBe('run_active');
    for (const home of [none, yesterday, ok, skipped, delivered, active]) expect(recoveryLines(home, 'plan_refire_requested')).toEqual([]);
  });

  it('refuses under STOP-ALL before reading anything, and for another pipeline id', () => {
    const home = makeHome();
    heldRun(home, NOON - 30 * MIN);
    fs.writeFileSync(path.join(home, '.shelly/agents/.halted'), '');
    expect(request(home, NOON)).toMatchObject({ code: 'halted', accepted: false });
    fs.unlinkSync(path.join(home, '.shelly/agents/.halted'));
    expect(request(home, NOON, { pipelineId: 'vintage-ja' })).toMatchObject({ code: 'unknown_pipeline' });
    expect(recoveryLines(home, 'plan_refire_requested')).toEqual([]);
  });

  it('rejects malformed arguments outright (no free text reaches the audit)', () => {
    const home = makeHome();
    heldRun(home, NOON - 30 * MIN);
    expect(request(home, NOON, { pipelineId: 'Dev JA; rm -rf' })).toEqual({ ok: false, error: 'pipeline-id' });
    expect(request(home, NOON, { agentId: '../x' })).toEqual({ ok: false, error: 'agent-id' });
    // A principal that is not 32 hex is dropped, never written.
    expect(request(home, NOON, { principal: 'free text' }).code).toBe('accepted');
    expect(recoveryLines(home, 'plan_refire_requested')[0].principal).toBeNull();
  });

  it(`caps accepted requests at ${recovery.REFIRE_REQUEST_DAILY_MAX} per pipeline per day`, () => {
    const home = makeHome();
    heldRun(home, NOON - 120 * MIN);
    expect(request(home, NOON - 100 * MIN).code).toBe('accepted');
    heldRun(home, NOON - 90 * MIN);
    expect(request(home, NOON - 80 * MIN).code).toBe('accepted');
    heldRun(home, NOON - 60 * MIN);
    expect(request(home, NOON).code).toBe('daily_limit');
    expect(recoveryLines(home, 'plan_refire_requested')).toHaveLength(2);
  });
});

describe('refire-request: a sweep turns the request into the S5 re-fire', () => {
  it('consumes it once: the intent carries the requestId, the slot is the run start (ad-hoc run), no feedback line', () => {
    const home = makeHome();
    const start = NOON - 60 * MIN;
    heldRun(home, start);
    const { requestId } = request(home, NOON);
    const s = sweep(home, NOON + MIN);
    expect(s.ok).toBe(true);
    expect(s.refire).toHaveLength(1);
    expect(s.refire[0]).toMatchObject({ agentId: AGENT, scheduledAt: start });
    expect(s.pendingRequests).toBe(0);
    const [intent] = recoveryLines(home, 'plan_refire_pending');
    expect(intent).toMatchObject({ requestId, requested: 'mcp', runStartTs: iso(start), refireRunId: s.refire[0].refireRunId });
    expect(intent.feedback).toBeUndefined();
    // Taken once: the next sweep has nothing to re-fire, and a new request is a duplicate.
    expect(sweep(home, NOON + 2 * MIN).refire).toEqual([]);
    expect(request(home, NOON + 3 * MIN).code).toBe('duplicate');
    expect(fs.existsSync(path.join(home, '.shelly/agents/recovery-feedback.jsonl'))).toBe(false);
  });

  it('keeps a scheduled run on its occurrence (the tied launch\'s scheduledAt)', () => {
    const home = makeHome();
    const slot = NOON - 62 * MIN;
    const start = NOON - 60 * MIN;
    append(launchFile(home), [{ v: 1, launchId: `${AGENT}-${start - 1000}-abc123`, agentId: AGENT, startedAt: start - 1000, scheduledAt: slot, origin: 'schedule', unattended: true, refireOf: null }]);
    heldRun(home, start, 'no-web-sources');
    request(home, NOON);
    const s = sweep(home, NOON + MIN);
    expect(s.refire[0]).toMatchObject({ origRunId: `${AGENT}-${start - 1000}-abc123`, scheduledAt: slot });
  });

  it('waits while an executor of the agent is alive (pendingRequests), then takes it', () => {
    const home = makeHome();
    heldRun(home, NOON - 60 * MIN);
    request(home, NOON);
    fs.writeFileSync(path.join(home, `.shelly/agents/locks/${AGENT}.pid`), '4242');
    const busy = sweep(home, NOON + MIN, liveProcs);
    expect(busy.refire).toEqual([]);
    expect(busy.pendingRequests).toBe(1);
    expect(recoveryLines(home, 'plan_refire_pending')).toEqual([]);
    expect(sweep(home, NOON + 2 * MIN).refire).toHaveLength(1);
  });

  it('expires instead of re-firing: STOP-ALL, the day ended, or a newer run started', () => {
    const halted = makeHome();
    heldRun(halted, NOON - 60 * MIN);
    request(halted, NOON);
    fs.writeFileSync(path.join(halted, '.shelly/agents/.halted'), '');
    expect(sweep(halted, NOON + MIN).refire).toEqual([]);
    expect(recoveryLines(halted, 'plan_refire_request_expired')[0]).toMatchObject({ why: 'halted' });

    const late = makeHome();
    heldRun(late, NOON - 60 * MIN);
    request(late, NOON);
    expect(sweep(late, NOON + 24 * 60 * MIN).refire).toEqual([]);
    expect(recoveryLines(late, 'plan_refire_request_expired')[0]).toMatchObject({ why: 'day-ended' });

    const newer = makeHome();
    heldRun(newer, NOON - 60 * MIN);
    request(newer, NOON - 50 * MIN);
    finishedRun(newer, NOON - 40 * MIN, 'success');
    expect(sweep(newer, NOON).refire).toEqual([]);
    expect(recoveryLines(newer, 'plan_refire_request_expired')[0]).toMatchObject({ why: 'superseded' });
    // An expired request still counts toward the day's maximum, and closes once.
    expect(sweep(newer, NOON + MIN).refire).toEqual([]);
    expect(recoveryLines(newer, 'plan_refire_request_expired')).toHaveLength(1);
  });

  it('outlives a restart: a request recorded by one process is re-fired by the next process\'s sweep (CLI)', () => {
    const home = makeHome();
    heldRun(home, Date.now() - 5 * MIN);
    // Same local day as the run (skip the edge minutes around midnight).
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() < 10) return;
    const cli = (args: string[]) => {
      const r = spawnSync(process.execPath, [scriptCopy, '--home', home, '--executor', executorCopy, ...args], { encoding: 'utf8' });
      return JSON.parse(r.stdout.trim().split('\n').pop() as string);
    };
    // The hash the executor's own op computes for this definition (what native stored at the opt-in).
    const listed = spawnSync(process.execPath, [executorCopy, '--web-search-opt-in-candidates'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
    const sha = JSON.parse(listed.stdout.trim()).pipelines.find((p: Json) => p.agentId === AGENT).definitionSha256;
    const accepted = cli(['--op', 'refire-request', '--agent-id', AGENT, '--pipeline-id', PIPELINE, '--principal', PRINCIPAL, '--definition-sha256', sha]);
    expect(accepted).toMatchObject({ ok: true, code: 'accepted' });
    // Without the opt-in snapshot nothing is re-fired: the request waits.
    expect(cli(['--op', 'sweep'])).toMatchObject({ refire: [], pendingRequests: 1 });
    // The first process is gone; only the audit line carries the request. The
    // next sweep re-checks the consent (native's opt-ins + the executor's hash).
    const swept = cli(['--op', 'sweep', '--opt-ins', `${AGENT}=${sha}`]);
    expect(swept.refire).toHaveLength(1);
    expect(recoveryLines(home, 'plan_refire_pending')[0]).toMatchObject({ requestId: accepted.requestId });
    expect(recoveryLines(home, 'plan_refire_requested')[0]).toMatchObject({ definitionSha256: sha });
  });

  it('re-checks the consent when it takes the request: an opt-in turned off or a changed definition expires it', () => {
    const off = makeHome();
    heldRun(off, NOON - 60 * MIN);
    request(off, NOON);
    expect(sweep(off, NOON + MIN, deadProcs, { optIns: 'none' }).refire).toEqual([]);
    expect(recoveryLines(off, 'plan_refire_request_expired')[0]).toMatchObject({ why: 'opt-in-lapsed' });

    const edited = makeHome();
    heldRun(edited, NOON - 60 * MIN);
    request(edited, NOON);
    // The owner edited the definition after the request: the executor's hash moved on.
    const moved = () => [{ agentId: AGENT, definitionSha256: 'd'.repeat(64), webSearchStep: true }];
    expect(sweep(edited, NOON + MIN, deadProcs, { optInCandidates: moved }).refire).toEqual([]);
    expect(recoveryLines(edited, 'plan_refire_request_expired')[0]).toMatchObject({ why: 'opt-in-lapsed' });

    const reEnabled = makeHome();
    heldRun(reEnabled, NOON - 60 * MIN);
    request(reEnabled, NOON);
    // Turned on again for the new definition: still not the consent the request was accepted under.
    expect(sweep(reEnabled, NOON + MIN, deadProcs, { optIns: `${AGENT}=${'d'.repeat(64)}`, optInCandidates: moved }).refire).toEqual([]);
    expect(recoveryLines(reEnabled, 'plan_refire_request_expired')[0]).toMatchObject({ why: 'opt-in-lapsed' });

    const noSearch = makeHome();
    heldRun(noSearch, NOON - 60 * MIN);
    request(noSearch, NOON);
    expect(sweep(noSearch, NOON + MIN, deadProcs, { optInCandidates: () => [{ agentId: AGENT, definitionSha256: SHA, webSearchStep: false }] }).refire).toEqual([]);
    expect(recoveryLines(noSearch, 'plan_refire_request_expired')[0]).toMatchObject({ why: 'opt-in-lapsed' });
  });

  it('waits (never re-fires) when the consent cannot be checked', () => {
    const home = makeHome();
    heldRun(home, NOON - 60 * MIN);
    request(home, NOON);
    expect(sweep(home, NOON + MIN, deadProcs, { optIns: undefined })).toMatchObject({ refire: [], pendingRequests: 1 });
    expect(sweep(home, NOON + 2 * MIN, deadProcs, { optInCandidates: () => null })).toMatchObject({ refire: [], pendingRequests: 1 });
    expect(sweep(home, NOON + 3 * MIN, deadProcs, { optIns: 'garbage' })).toMatchObject({ refire: [], pendingRequests: 1 });
    expect(recoveryLines(home, 'plan_refire_request_expired')).toEqual([]);
    expect(sweep(home, NOON + 4 * MIN).refire).toHaveLength(1);
  });

  it('refuses a request without the accepted definition hash', () => {
    const home = makeHome();
    heldRun(home, NOON - 60 * MIN);
    expect(request(home, NOON, { definitionSha256: undefined })).toEqual({ ok: false, error: 'definition-sha256' });
    expect(request(home, NOON, { definitionSha256: 'x' })).toEqual({ ok: false, error: 'definition-sha256' });
  });

  it('is settled by the existing S5 path: dispatch outcome, then the re-fire\'s own launch record', () => {
    const home = makeHome();
    const start = NOON - 60 * MIN;
    heldRun(home, start);
    request(home, NOON);
    const [r] = sweep(home, NOON + MIN).refire;
    const res = recovery.runOp({ home, op: 'refire-result', agentId: AGENT, runId: r.origRunId, refireRunId: r.refireRunId, dispatched: '1', nowMs: NOON + MIN, procDeps: deadProcs, executorModule: executor });
    expect(res).toMatchObject({ ok: true, settled: false });
    expect(recoveryLines(home, 'plan_refire_dispatched')).toHaveLength(1);
    // Native starts the re-fire: its launch record names the request's run.
    append(launchFile(home), [{ v: 1, launchId: r.refireRunId, agentId: AGENT, startedAt: NOON + 2 * MIN, scheduledAt: r.scheduledAt, origin: 'schedule', unattended: true, refireOf: r.origRunId }]);
    sweep(home, NOON + 3 * MIN);
    expect(recoveryLines(home, 'plan_refire')[0]).toMatchObject({ confirmedBy: 'launch-record', refireRunId: r.refireRunId, runId: r.origRunId });
    // The re-fired run lands held again: one more request is allowed today, then the cap.
    heldRun(home, NOON + 2 * MIN + 5000);
    expect(request(home, NOON + 10 * MIN).code).toBe('accepted');
    heldRun(home, NOON + 20 * MIN);
    expect(request(home, NOON + 30 * MIN).code).toBe('daily_limit');
  });

  it('a failed dispatch is settled as not re-fired and is not retried', () => {
    const home = makeHome();
    heldRun(home, NOON - 60 * MIN);
    request(home, NOON);
    const [r] = sweep(home, NOON + MIN).refire;
    recovery.runOp({ home, op: 'refire-result', agentId: AGENT, runId: r.origRunId, refireRunId: r.refireRunId, dispatched: '0', nowMs: NOON + MIN, procDeps: deadProcs, executorModule: executor });
    expect(recoveryLines(home, 'plan_refire_failed')[0]).toMatchObject({ why: 'dispatch-failed' });
    expect(sweep(home, NOON + 2 * MIN).refire).toEqual([]);
    expect(request(home, NOON + 3 * MIN).code).toBe('duplicate');
  });
});
