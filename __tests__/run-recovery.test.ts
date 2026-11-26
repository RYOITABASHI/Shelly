import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

// S5 executor recovery (scripts/shelly-run-recovery.js): closes runs the
// executor could not close itself (plan_start without plan_finish), aborts
// hung runs, writes ~/.shelly/agents/recovery-feedback.jsonl and decides the
// one-time re-fire. Fact sheet + S5-0 supplement (executor-recovery).

const root = path.resolve(__dirname, '..');
const scriptCopy = path.join(root, 'scripts', 'shelly-run-recovery.js');
const assetCopy = path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-run-recovery.js');
const executorCopy = path.join(root, 'scripts', 'shelly-plan-executor.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const recovery = require(scriptCopy);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const executor = require(executorCopy);

const AGENT = 'agent-mwmst017';
const MIN = 60_000;
// 2026-11-24 07:00 JST = 2026-11-23T22:00:00Z
const SCHEDULED = Date.parse('2026-11-23T22:00:00.000Z');

type Json = Record<string, unknown>;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-run-recovery-'));
  fs.mkdirSync(path.join(home, '.shelly/agents/plans'), { recursive: true });
  fs.mkdirSync(path.join(home, '.shelly/agents/locks'), { recursive: true });
  fs.mkdirSync(path.join(home, `.shelly/agents/logs/${AGENT}`), { recursive: true });
  // The article pipeline the test plan's folder belongs to (a re-fire needs one).
  writePipelines(home);
  return home;
}

function logDir(home: string, agentId = AGENT) {
  return path.join(home, `.shelly/agents/logs/${agentId}`);
}

function auditFile(home: string, agentId = AGENT) {
  return path.join(logDir(home, agentId), 'plan-executor-audit.jsonl');
}

function feedbackFile(home: string) {
  return path.join(home, '.shelly/agents/recovery-feedback.jsonl');
}

function writeJsonl(file: string, lines: Json[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
}

function readJsonl(file: string): Json[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function articlePlan(home: string, agentId = AGENT) {
  const outputDir = path.join(home, 'vault/vintage-ja');
  return {
    kind: 'shelly.agent.plan',
    schemaVersion: 1,
    agent: { id: agentId, name: 'Vintage JA' },
    prompt: 'Write the article',
    tool: { type: 'gemini-api' },
    action: { type: 'draft' },
    output: { outputDir, outputNameTemplate: '{date}_{slug}', slug: 'vintage', useGlobalOutput: false },
    steps: {
      longform: true,
      list: [
        { instruction: 'queue', local: { kind: 'queue-pop' } },
        { instruction: 'research', tool: { type: 'gemini-api' } },
        { instruction: 'write', tool: { type: 'cli', cli: 'codex', textOnly: true } },
        { instruction: 'review', handoff: { kind: 'review', of: 2, round: 1 } },
        { instruction: 'assemble', local: { kind: 'assemble' } },
      ],
    },
  };
}

function writePlan(home: string, plan: Json, agentId = AGENT) {
  const file = path.join(home, `.shelly/agents/plans/plan-agent-${agentId}.json`);
  fs.writeFileSync(file, JSON.stringify(plan));
  // Written before the runs these tests seed (recovery checks the plan did not change since plan_start).
  const old = new Date(SCHEDULED - 24 * 60 * MIN);
  fs.utimesSync(file, old, old);
}

/** The re-fire actually started: native wrote its launch record (and its finalize ran). */
function refireStarted(home: string, r: Json, atMs: number) {
  fs.appendFileSync(path.join(logDir(home), 'run-launches.jsonl'), `${JSON.stringify(launch(atMs, { launchId: r.refireRunId, refireOf: r.origRunId }))}\n`);
  return recovery.runOp({ home, op: 'finalize', agentId: AGENT, exitCode: 0, launchStartedAtMs: atMs, launchId: r.refireRunId, nowMs: atMs + MIN, procDeps: deadProcs, executorModule: executor });
}

function writePipelines(home: string) {
  fs.writeFileSync(
    path.join(home, '.shelly/agents/article-pipelines.json'),
    JSON.stringify({ pipelines: [{ id: 'vintage-ja', outputFolder: path.join(home, 'vault/vintage-ja') }] }),
  );
}

function launch(startedAt: number, extra: Json = {}): Json {
  return { v: 1, launchId: `${AGENT}-${startedAt}-abc123`, agentId: AGENT, startedAt, scheduledAt: SCHEDULED, origin: 'schedule', unattended: true, refireOf: null, ...extra };
}

/** The 07:00 silent death: research done, write's CLI branch started, then nothing. */
function seedSilentDeath(home: string, startMs: number, opts: { launchExtra?: Json; noLaunch?: boolean } = {}) {
  writeJsonl(auditFile(home), [
    { ts: iso(startMs - 3600_000), kind: 'plan.executor', event: 'plan_start', agentId: AGENT },
    { ts: iso(startMs - 3500_000), kind: 'plan.executor', event: 'plan_finish', status: 'success', durationMs: 100 },
    { ts: iso(startMs), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true },
    { ts: iso(startMs + 3 * MIN), kind: 'plan.executor', event: 'cli_branch_start', agentId: AGENT, stepIndex: 2, engine: 'codex' },
  ]);
  const runId = `${AGENT}-${startMs}-4242-aaaaaa`;
  const ev = (seq: number, at: number, fields: Json) => ({ v: 1, runId, agentId: AGENT, seq, ts: iso(at), ...fields });
  writeJsonl(path.join(logDir(home), 'progress.jsonl'), [
    ev(1, startMs + 100, { kind: 'run_start', mode: 'SERIAL', stepCount: 5 }),
    ev(2, startMs + 101, { kind: 'branch_state', stepIndex: 0, state: 'STANDBY' }),
    ev(3, startMs + 102, { kind: 'branch_state', stepIndex: 1, state: 'STANDBY' }),
    ev(4, startMs + 103, { kind: 'branch_state', stepIndex: 2, state: 'STANDBY' }),
    ev(5, startMs + 1000, { kind: 'branch_state', stepIndex: 0, state: 'RUNNING' }),
    ev(6, startMs + 2000, { kind: 'branch_state', stepIndex: 0, state: 'DONE' }),
    ev(7, startMs + 3000, { kind: 'branch_state', stepIndex: 1, state: 'RUNNING' }),
    ev(8, startMs + 2 * MIN, { kind: 'branch_state', stepIndex: 1, state: 'DONE' }),
    ev(9, startMs + 3 * MIN, { kind: 'branch_state', stepIndex: 2, state: 'RUNNING' }),
  ]);
  if (!opts.noLaunch) writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [launch(startMs - 2000, opts.launchExtra)]);
  return { runId };
}

const deadProcs = { pidAlive: () => false, cmdline: () => null, listPids: () => [] as number[] };

function run(home: string, opts: Json) {
  // finalize names its launch (native always passes it); default: the id launch() gives.
  const launchId = opts.op === 'finalize' && opts.launchId === undefined && typeof opts.launchStartedAtMs === 'number'
    ? { launchId: `${AGENT}-${opts.launchStartedAtMs}-abc123` }
    : {};
  return recovery.runOp({ home, procDeps: deadProcs, executorModule: executor, ...launchId, ...opts });
}

describe('pairRuns', () => {
  const s = (ms: number, extra: Json = {}) => ({ ts: iso(ms), kind: 'plan.executor', event: 'plan_start', ...extra });
  const f = (ms: number) => ({ ts: iso(ms), kind: 'plan.executor', event: 'plan_finish', status: 'success' });

  it('pairs a lock refusal nested inside a live run', () => {
    const runs = recovery.pairRuns([s(1000), s(2000), f(2001), f(9000)]);
    expect(runs.map((r: Json) => !!r.finish)).toEqual([true, true]);
    expect((runs[1].finish as Json).ts).toBe(iso(2001));
    expect((runs[0].finish as Json).ts).toBe(iso(9000));
  });

  it('leaves a silently dead run open when the next run finishes', () => {
    const runs = recovery.pairRuns([s(1000), s(5000), f(6000)]);
    expect(runs[0].finish).toBeNull();
    expect(runs[1].finish).not.toBeNull();
  });

  it('a recovery close names its run; a late plan_finish still pairs with it', () => {
    const runs = recovery.pairRuns([
      s(1000),
      s(5000),
      { ts: iso(7000), kind: 'plan.recovery', event: 'plan_hung', runStartTs: iso(5000) },
      f(7100),
    ]);
    expect(runs[1].recoveryClose).not.toBeNull();
    expect(runs[1].finish).not.toBeNull();
    expect(runs[0].finish).toBeNull();
  });
});

describe('finalize (driver terminal record) after an executor SIGKILL', () => {
  it('closes the run with plan_exit + plan_orphaned, writes feedback, and re-fires once inside the window', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    writePipelines(home);
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    const before = fs.readFileSync(auditFile(home), 'utf8');
    const now = startMs + 5 * MIN;

    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: now });
    expect(out.ok).toBe(true);
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0]).toMatchObject({ agentId: AGENT, reason: 'orphaned', lastStep: { index: 2, kind: 'write' } });
    expect(out.refire).toEqual([{ agentId: AGENT, origRunId: `${AGENT}-${startMs - 2000}-abc123`, refireRunId: expect.stringMatching(new RegExp(`^${AGENT}-${now}-r[0-9a-f]{6}$`)), scheduledAt: SCHEDULED }]);

    // Append-only: the executor's lines are untouched.
    const after = fs.readFileSync(auditFile(home), 'utf8');
    expect(after.startsWith(before)).toBe(true);
    let added = readJsonl(auditFile(home)).slice(4);
    // Only the intent is recorded before native dispatches: no feedback line yet.
    expect(added.map((l) => l.event)).toEqual(['plan_exit', 'plan_orphaned', 'plan_refire_pending']);
    expect(readJsonl(feedbackFile(home))).toEqual([]);
    // native reports the service took it: only "dispatched", still no feedback line (the service may refuse it).
    const res = run(home, { op: 'refire-result', agentId: AGENT, runId: out.refire[0].origRunId, refireRunId: out.refire[0].refireRunId, dispatched: '1' });
    expect(res).toEqual({ ok: true, op: 'refire-result', settled: false });
    expect(readJsonl(feedbackFile(home))).toEqual([]);
    // The re-fired run starts (its launch record) and its finalize settles the original's intent.
    refireStarted(home, out.refire[0], now + 1000);
    added = readJsonl(auditFile(home)).slice(4);
    expect(added.map((l) => l.event)).toEqual(['plan_exit', 'plan_orphaned', 'plan_refire_pending', 'plan_refire_dispatched', 'plan_refire', 'recovery_feedback', 'recovery_feedback_shared']);
    expect(added.every((l) => l.kind === 'plan.recovery')).toBe(true);
    expect(added[0]).toMatchObject({ exitCode: 137, signal: 'SIGKILL', detectedBy: 'driver', runStartTs: iso(startMs) });
    expect(added[1]).toMatchObject({ reason: 'orphaned', detectedBy: 'driver', lastStep: { index: 2, kind: 'write', startedAt: iso(startMs + 3 * MIN) } });
    expect(added[4]).toMatchObject({ confirmedBy: 'launch-record', refireRunId: out.refire[0].refireRunId });

    const fb = readJsonl(feedbackFile(home));
    expect(fb).toHaveLength(1);
    expect(fb[0]).toEqual({
      runId: `${AGENT}-${startMs - 2000}-abc123`,
      agentId: AGENT,
      pipelineId: 'vintage-ja',
      planId: expect.stringMatching(new RegExp(`^plan-agent-${AGENT}@[0-9a-f]{12}$`)),
      scheduledAt: iso(SCHEDULED),
      startedAt: iso(startMs),
      terminatedAt: iso(now),
      reason: 'orphaned',
      lastStep: { index: 2, kind: 'write', startedAt: iso(startMs + 3 * MIN) },
      artifacts: { draft: false, paths: [] },
      delivery: { delivered: false, channel: 'draft' },
      refire: { eligible: true, refired: true, refireRunId: out.refire[0].refireRunId },
    });
    // Exactly the S5-0 §3 field list: no version field.
    expect(Object.keys(fb[0]).sort()).toEqual(['agentId', 'artifacts', 'delivery', 'lastStep', 'pipelineId', 'planId', 'reason', 'refire', 'runId', 'scheduledAt', 'startedAt', 'terminatedAt']);
    // The driver audit stream carries the same content.
    expect(added[5].feedback).toEqual(fb[0]);
    // A repeated report changes nothing.
    expect(run(home, { op: 'refire-result', agentId: AGENT, runId: out.refire[0].origRunId, refireRunId: out.refire[0].refireRunId, dispatched: '1' }).settled).toBe(false);

    // Idempotent: a second finalize finds nothing open.
    const again = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: now + 1000 });
    expect(again.closed).toEqual([]);
    expect(again.refire).toEqual([]);
    expect(readJsonl(feedbackFile(home))).toHaveLength(1);
  });

  it('does not re-fire when the slot\'s draft already exists (the executor\'s draft_exists guard)', () => {
    const home = makeHome();
    const plan = articlePlan(home);
    writePlan(home, plan);
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    const paths = executor.runtimePaths(home, AGENT);
    const dest = executor.resolveDraftDestination(paths, plan, {}, new Date(SCHEDULED)).dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, '# done\n');

    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: startMs + MIN });
    expect(out.refire).toEqual([]);
    const fb = readJsonl(feedbackFile(home))[0];
    expect(fb.delivery).toEqual({ delivered: true, channel: 'draft' });
    expect(fb.artifacts).toEqual({ draft: true, paths: [dest] });
    expect(fb.refire).toEqual({ eligible: false, refired: false, refireRunId: null });
    const fbAudit = readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback');
    expect(fbAudit!.refireSkipped).toBe('delivered');
    expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_refire')).toBe(false);
  });

  it('does not re-fire outside the 2-hour window, an ad-hoc run, a re-fire, or under STOP-ALL', () => {
    const cases: Array<[string, (home: string, startMs: number) => void, Json, number]> = [
      ['window', (h, s) => seedSilentDeath(h, s), {}, 2 * 60 * MIN + 1],
      ['adhoc', (h, s) => seedSilentDeath(h, s, { launchExtra: { scheduledAt: null, origin: 'user' } }), {}, 5 * MIN],
      ['adhoc', (h, s) => seedSilentDeath(h, s, { noLaunch: true }), {}, 5 * MIN],
      ['already-a-refire', (h, s) => seedSilentDeath(h, s, { launchExtra: { refireOf: `${AGENT}-1-abc123` } }), {}, 5 * MIN],
      ['halted', (h, s) => { seedSilentDeath(h, s); fs.writeFileSync(path.join(h, '.shelly/agents/.halted'), ''); }, {}, 5 * MIN],
    ];
    for (const [why, seed, , age] of cases) {
      const home = makeHome();
      writePlan(home, articlePlan(home));
      const startMs = SCHEDULED + 5_000;
      seed(home, startMs);
      const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: SCHEDULED + age });
      expect(out.closed).toHaveLength(1);
      expect(out.refire).toEqual([]);
      const fbAudit = readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback');
      expect(fbAudit!.refireSkipped).toBe(why);
      expect(readJsonl(feedbackFile(home))[0].refire).toEqual({ eligible: false, refired: false, refireRunId: null });
    }
  });

  it('never re-fires the same slot twice (shared counter in the feedback file)', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    const first = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: startMs + MIN });
    expect(first.refire).toHaveLength(1);
    // A second open run of the same slot (no refireOf: e.g. a duplicate fire) dies too.
    const start2 = startMs + 10 * MIN;
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: iso(start2), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true })}\n`);
    fs.appendFileSync(path.join(logDir(home), 'run-launches.jsonl'), `${JSON.stringify(launch(start2 - 1000, { launchId: `${AGENT}-${start2}-def456` }))}\n`);
    const second = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: start2 - 1000, launchId: `${AGENT}-${start2}-def456`, nowMs: start2 + MIN });
    expect(second.closed).toHaveLength(1);
    expect(second.refire).toEqual([]);
    // The first re-fire is still only an intent (not yet reported): it already counts.
    const fbAudit = readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback');
    expect(fbAudit).toHaveLength(1);
    expect(fbAudit[0].refireSkipped).toBe('already-refired');
  });

  it('a non-article run is closed with feedback but never re-fired (delivery cannot be verified)', () => {
    const home = makeHome();
    writePlan(home, { kind: 'shelly.agent.plan', agent: { id: AGENT }, action: { type: 'social-post' }, tool: { type: 'groq' } });
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: startMs + MIN });
    expect(out.refire).toEqual([]);
    const fb = readJsonl(feedbackFile(home))[0];
    expect(fb.pipelineId).toBeNull();
    expect(fb.delivery).toEqual({ delivered: false, channel: 'social-post' });
    expect(readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')!.refireSkipped).toBe('not-a-draft-pipeline');
  });
});

describe('normal and SIGTERM runs are untouched', () => {
  it.each([
    ['success', { status: 'success', durationMs: 10 }],
    ['SIGTERM / STOP-ALL', { status: 'skipped', reason: 'Run stopped (SIGTERM).', durationMs: 10 }],
  ])('%s: finalize and sweep add nothing', (_label, finish) => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED;
    writeJsonl(auditFile(home), [
      { ts: iso(startMs), kind: 'plan.executor', event: 'plan_start', agentId: AGENT },
      { ts: iso(startMs + MIN), kind: 'plan.executor', event: 'cli_branch_start', stepIndex: 2 },
      { ts: iso(startMs + 2 * MIN), kind: 'plan.executor', event: 'plan_finish', ...finish },
    ]);
    const before = fs.readFileSync(auditFile(home), 'utf8');
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 1, launchStartedAtMs: startMs - 1000, nowMs: startMs + 3 * MIN });
    run(home, { op: 'sweep', nowMs: startMs + 3 * MIN });
    expect(fs.readFileSync(auditFile(home), 'utf8')).toBe(before);
    expect(fs.existsSync(feedbackFile(home))).toBe(false);
  });
});

describe('startup sweep', () => {
  it('closes a dead run (app died with it) as orphaned, detectedBy sweep, no exit code', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    const out = run(home, { op: 'sweep', nowMs: startMs + 40 * MIN });
    expect(out.closed).toHaveLength(1);
    expect(out.refire).toHaveLength(1);
    const added = readJsonl(auditFile(home)).slice(4);
    expect(added.map((l) => l.event)).toEqual(['plan_orphaned', 'plan_refire_pending']);
    expect(added[0]).toMatchObject({ detectedBy: 'sweep', reason: 'orphaned' });
    expect(added[0].exitCode).toBeUndefined();
  });

  it('leaves the run a live executor owns, closes an older dead one', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const t0 = SCHEDULED;
    writeJsonl(auditFile(home), [
      { ts: iso(t0), kind: 'plan.executor', event: 'plan_start', agentId: AGENT },
      { ts: iso(t0 + 20 * MIN), kind: 'plan.executor', event: 'plan_start', agentId: AGENT },
    ]);
    fs.writeFileSync(path.join(home, `.shelly/agents/locks/${AGENT}.pid`), '4242\n');
    const procs = {
      pidAlive: (pid: number) => pid === 4242,
      cmdline: (pid: number) => (pid === 4242 ? ['/system/bin/linker64', '/lib/node', '/home/.shelly-plan-executor.js', '--plan-file', 'p', '--agent-id', AGENT] : null),
      listPids: () => [4242],
    };
    const out = recovery.runOp({ home, op: 'sweep', procDeps: procs, executorModule: executor, nowMs: t0 + 25 * MIN });
    expect(out.closed).toHaveLength(1);
    const closes = readJsonl(auditFile(home)).filter((l) => l.event === 'plan_orphaned');
    expect(closes.map((l) => l.runStartTs)).toEqual([iso(t0)]);
  });

  it('unknown liveness (pid alive, /proc unreadable) counts as alive', () => {
    const home = makeHome();
    writeJsonl(auditFile(home), [{ ts: iso(SCHEDULED), kind: 'plan.executor', event: 'plan_start', agentId: AGENT }]);
    fs.writeFileSync(path.join(home, `.shelly/agents/locks/${AGENT}.pid`), '4242\n');
    const procs = { pidAlive: () => true, cmdline: () => null, listPids: () => [] as number[] };
    const out = recovery.runOp({ home, op: 'sweep', procDeps: procs, executorModule: executor, nowMs: SCHEDULED + 60 * MIN });
    expect(out.closed).toEqual([]);
  });

  it('never closes a run younger than the grace period or older than the lookback', () => {
    const home = makeHome();
    const now = SCHEDULED + 3 * 24 * 60 * MIN;
    writeJsonl(auditFile(home), [
      { ts: iso(now - 25 * 60 * MIN), kind: 'plan.executor', event: 'plan_start', agentId: AGENT },
      { ts: iso(now - 30_000), kind: 'plan.executor', event: 'plan_start', agentId: AGENT },
    ]);
    const out = run(home, { op: 'sweep', nowMs: now });
    expect(out.closed).toEqual([]);
  });
});

describe('hang detection (tier 1 abort / tier 2 record only)', () => {
  function seedLive(home: string, startMs: number, events: Array<[number, Json]>, audit: Json[] = []) {
    writeJsonl(auditFile(home), [{ ts: iso(startMs), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true }, ...audit]);
    const runId = `${AGENT}-${startMs}-1-aaaaaa`;
    writeJsonl(
      path.join(logDir(home), 'progress.jsonl'),
      [[startMs + 50, { kind: 'run_start', stepCount: 5 }] as [number, Json], ...events].map(([at, f], i) => ({ v: 1, runId, agentId: AGENT, seq: i + 1, ts: iso(at), ...f })),
    );
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [launch(startMs - 1000)]);
  }

  it('no worker + no progress for 10 minutes: hung (closed, feedback, re-fire)', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedLive(home, startMs, [
      [startMs + MIN, { kind: 'branch_state', stepIndex: 2, state: 'RUNNING' }],
      // The executor's 10 s heartbeat while a (stuck) driver lives is not progress.
      [startMs + 10 * MIN, { kind: 'heartbeat', stepIndex: 2 }],
    ]);
    const before = fs.readFileSync(auditFile(home), 'utf8');
    const verdict = run(home, { op: 'hang-check', agentId: AGENT, workerAlive: false, launchStartedAtMs: startMs - 1000, nowMs: startMs + 11 * MIN + 1 });
    expect(verdict).toMatchObject({ verdict: 'hung', runStartTs: iso(startMs), progressBytes: fs.statSync(path.join(logDir(home), 'progress.jsonl')).size });
    // The verdict alone writes nothing: native re-checks with the tree frozen first.
    expect(fs.readFileSync(auditFile(home), 'utf8')).toBe(before);
    expect(verdict.refire).toEqual([]);
    // native killed the tree: the close.
    const out = run(home, { op: 'hang-abort', agentId: AGENT, runStartTs: verdict.runStartTs, noProgressMs: verdict.noProgressMs, nowMs: startMs + 11 * MIN + 2 });
    expect(out.closed).toHaveLength(1);
    expect(out.refire).toHaveLength(1);
    const hung = readJsonl(auditFile(home)).find((l) => l.event === 'plan_hung')!;
    expect(hung).toMatchObject({ tier: 1, reason: 'hung', detectedBy: 'watchdog', lastStep: { index: 2, kind: 'write' } });
    run(home, { op: 'refire-result', agentId: AGENT, runId: out.refire[0].origRunId, refireRunId: out.refire[0].refireRunId, dispatched: '1' });
    refireStarted(home, out.refire[0], startMs + 11 * MIN + 5_000);
    expect(readJsonl(feedbackFile(home))[0]).toMatchObject({ reason: 'hung', refire: { eligible: true, refired: true } });
    // The abort's exit then finds the run already closed: no second close.
    const fin = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 1000, nowMs: startMs + 12 * MIN });
    expect(fin.closed).toEqual([]);
    expect(readJsonl(feedbackFile(home))).toHaveLength(1);
    // ... but the exit code the abort produced is added to the watchdog-closed run, once.
    const exits = readJsonl(auditFile(home)).filter((l) => l.event === 'plan_exit');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ exitCode: 137, signal: 'SIGKILL', detectedBy: 'driver', runStartTs: iso(startMs) });
  });

  it.each([
    ['ok: progress 5 minutes ago', false, [[5, { kind: 'branch_state', stepIndex: 1, state: 'RUNNING' }]], 10, 'ok'],
    ['waiting: action approval', false, [[1, { kind: 'branch_state', stepIndex: 4, state: 'WAITING_APPROVAL' }]], 25, 'waiting'],
    ['waiting: CLI slot', false, [[1, { kind: 'tail', stepIndex: 2, tail: 'Waiting for CLI slot: other-agents' }]], 25, 'waiting'],
    ['ok: worker alive, 15 minutes silent', true, [[1, { kind: 'branch_state', stepIndex: 2, state: 'RUNNING' }]], 16, 'ok'],
  ] as Array<[string, boolean, Array<[number, Json]>, number, string]>)('%s', (_label, workerAlive, evs, atMin, verdict) => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED;
    seedLive(home, startMs, evs.map(([m, f]) => [startMs + m * MIN, f]));
    const before = fs.readFileSync(auditFile(home), 'utf8');
    const out = run(home, { op: 'hang-check', agentId: AGENT, workerAlive, launchStartedAtMs: startMs - 1000, nowMs: startMs + atMin * MIN });
    expect(out.verdict).toBe(verdict);
    expect(fs.readFileSync(auditFile(home), 'utf8')).toBe(before);
  });

  it('a capped progress stream proves nothing (unknown, no abort)', () => {
    const home = makeHome();
    const startMs = SCHEDULED;
    seedLive(home, startMs, [[startMs + MIN, { kind: 'branch_state', stepIndex: 1, state: 'RUNNING' }]]);
    fs.appendFileSync(path.join(logDir(home), 'progress.jsonl'), `${JSON.stringify({ kind: 'pad', ts: iso(startMs + MIN), pad: 'x'.repeat(260 * 1024) })}\n`);
    const out = run(home, { op: 'hang-check', agentId: AGENT, workerAlive: false, launchStartedAtMs: startMs - 1000, nowMs: startMs + 20 * MIN });
    expect(out.verdict).toBe('unknown');
  });

  it('worker alive + no progress for 30 minutes: hung-suspect audited once, no feedback line, never closed', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED;
    seedLive(home, startMs, [[startMs + MIN, { kind: 'branch_state', stepIndex: 2, state: 'RUNNING' }]]);
    const out = run(home, { op: 'hang-check', agentId: AGENT, workerAlive: true, launchStartedAtMs: startMs - 1000, nowMs: startMs + 32 * MIN });
    expect(out.verdict).toBe('suspect');
    expect(out.refire).toEqual([]);
    const again = run(home, { op: 'hang-check', agentId: AGENT, workerAlive: true, launchStartedAtMs: startMs - 1000, nowMs: startMs + 33 * MIN });
    expect(again.verdict).toBe('ok');
    const audit = readJsonl(auditFile(home));
    expect(audit.filter((l) => l.event === 'plan_hung_suspect')).toHaveLength(1);
    expect(audit.some((l) => l.event === 'plan_hung' || l.event === 'plan_orphaned')).toBe(false);
    // Tier 2 does not end the run: no §3 feedback line and no recovery_feedback audit mirror.
    expect(readJsonl(feedbackFile(home))).toEqual([]);
    expect(audit.some((l) => l.event === 'recovery_feedback')).toBe(false);
    // Still open: a later real death is closed normally, and only that close gets a feedback line.
    const fin = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 1000, nowMs: startMs + 34 * MIN });
    expect(fin.closed).toHaveLength(1);
    // That close is re-fire eligible: its line is written once native reports the dispatch.
    expect(fin.refire).toHaveLength(1);
    run(home, { op: 'refire-result', agentId: AGENT, runId: fin.refire[0].origRunId, refireRunId: fin.refire[0].refireRunId, dispatched: '1' });
    refireStarted(home, fin.refire[0], startMs + 35 * MIN);
    const fb = readJsonl(feedbackFile(home));
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ reason: 'orphaned' });
    expect(fb[0].terminatedAt).toBe(iso(startMs + 34 * MIN));
  });
});

describe('tier 1 re-check before the kill', () => {
  function seedHung(home: string, startMs: number) {
    writeJsonl(auditFile(home), [{ ts: iso(startMs), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true }]);
    const runId = `${AGENT}-${startMs}-1-aaaaaa`;
    writeJsonl(path.join(logDir(home), 'progress.jsonl'), [
      { v: 1, runId, agentId: AGENT, seq: 1, ts: iso(startMs + 50), kind: 'run_start', stepCount: 5 },
      { v: 1, runId, agentId: AGENT, seq: 2, ts: iso(startMs + MIN), kind: 'branch_state', stepIndex: 2, state: 'RUNNING' },
    ]);
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [launch(startMs - 1000)]);
  }

  it('a cancelled kill is recorded and leaves the run open', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED;
    seedHung(home, startMs);
    const v = run(home, { op: 'hang-check', agentId: AGENT, workerAlive: false, launchStartedAtMs: startMs - 1000, nowMs: startMs + 12 * MIN });
    expect(v.verdict).toBe('hung');
    expect(run(home, { op: 'hang-cancel', agentId: AGENT, runStartTs: v.runStartTs, why: 'worker' })).toEqual({ ok: true, op: 'hang-cancel', recorded: true });
    const audit = readJsonl(auditFile(home));
    expect(audit.find((l) => l.event === 'plan_hung_cancelled')).toMatchObject({ kind: 'plan.recovery', tier: 1, why: 'worker', runStartTs: iso(startMs), detectedBy: 'watchdog' });
    expect(audit.some((l) => l.event === 'plan_hung' || l.event === 'plan_orphaned')).toBe(false);
    expect(readJsonl(feedbackFile(home))).toEqual([]);
    expect(recovery.pairRuns(audit)[0].recoveryClose).toBeNull();
    expect(run(home, { op: 'hang-cancel', agentId: AGENT, runStartTs: v.runStartTs, why: 'nope' })).toEqual({ ok: false, error: 'why' });
  });

  it('hang-abort leaves a run that ended in between alone', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED;
    seedHung(home, startMs);
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: iso(startMs + 12 * MIN), kind: 'plan.executor', event: 'plan_finish', status: 'success' })}\n`);
    const out = run(home, { op: 'hang-abort', agentId: AGENT, runStartTs: iso(startMs), noProgressMs: 11 * MIN, nowMs: startMs + 12 * MIN });
    expect(out.closed).toEqual([]);
    expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_hung')).toBe(false);
  });

  it('a run whose stream was rotated to .prev is never judged hung', () => {
    const home = makeHome();
    const startMs = SCHEDULED;
    seedHung(home, startMs);
    fs.renameSync(path.join(logDir(home), 'progress.jsonl'), path.join(logDir(home), 'progress.prev.jsonl'));
    const v = run(home, { op: 'hang-check', agentId: AGENT, workerAlive: false, launchStartedAtMs: startMs - 1000, nowMs: startMs + 20 * MIN });
    expect(v.verdict).toBe('unknown');
  });

  it('native freezes the tree, re-checks worker and progress, and only then kills', () => {
    const kt = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/RunRecovery.kt'), 'utf8');
    const hung = kt.slice(kt.indexOf('"hung" -> {'));
    // freeze -> re-check -> (kill) -> finally: thaw unless killing, clear the marker -> record.
    const order = ['freezeTree(pid, frozen)', 'recheckBeforeKill(', 'killing = true', 'killTree(pid)', 'signalled = signalAll(frozen, OsConstants.SIGKILL)', '} finally {',
      'if (!killing) signalled = thawTree(frozen)', 'if (signalled) {', 'clearFreezeMarker(homeDir, agentId, freezeStartMs)', 'hangCancel(', 'hangAbort('].map((k) => hung.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(kt).toContain('workerAlive(pid) -> "worker"');
    // A freeze that could not be confirmed from /proc cancels the kill.
    expect(kt).toContain('if (!confirmed) "freeze-failed"');
    expect(kt).toContain("st != 'T' && st != 't'");
    // An unreadable state is not a confirmation; only a missing /proc entry (gone) is.
    expect(kt).toContain('if (!File("/proc/$p").exists()) return@filter false');
    expect(kt).toContain("st == null || (st != 'T'");
    expect(kt).toContain('progressAdvanced(homeDir, agentId, progressBytes) -> "progress"');
  });

  it('native knows and persists each batch of pids before it stops them', () => {
    const kt = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/RunRecovery.kt'), 'utf8');
    const freeze = kt.slice(kt.indexOf('private fun freezeTree('), kt.indexOf('private fun thawTree('));
    const order = ['listOf(root) + descendantsOf(root)', 'stopped.addAll(fresh)', 'if (!persist(startTimes))', 'sendStop(p)'].map((k) => freeze.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A batch that is not on disk is never stopped.
    expect(freeze).toMatch(/if \(!persist\(startTimes\)\) \{[\s\S]*?return false/);
    // The marker records each pid with its start time (the sweep never signals a reused pid).
    expect(kt).toContain('.put("startTime", startTime)');
    // One marker per freeze: a kept marker is never overwritten by the next freeze.
    expect(kt).toContain('locks/freeze-$agentId.$freezeStartMs.json');
  });

  it('native never stops a pid whose start time it could not read (freeze-failed: the kill is cancelled)', () => {
    const kt = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/RunRecovery.kt'), 'utf8');
    const freeze = kt.slice(kt.indexOf('private fun freezeTree('), kt.indexOf('private fun signalAll('));
    // The start time is read for the whole batch before it is added, persisted or stopped.
    const order = ['procStartTime(p) ?: return false', 'stopped.addAll(fresh)', 'if (!persist(startTimes))', 'sendStop(p)'].map((k) => freeze.indexOf(k));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(freeze).toContain('persist: (Map<Int, Long>) -> Boolean');
    // freezeTree false -> "freeze-failed" -> hangCancel (no kill).
    expect(kt).toContain('if (!confirmed) "freeze-failed"');
  });

  it('native removes the freeze marker only when every signal went out', () => {
    const kt = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/RunRecovery.kt'), 'utf8');
    const sig = kt.slice(kt.indexOf('private fun signalAll('), kt.indexOf('private fun thawTree('));
    // A failed kill(2) other than ESRCH (already gone) is a failure.
    expect(sig).toContain('if (e.errno != OsConstants.ESRCH) all = false');
    expect(kt).toContain('private fun thawTree(pids: Collection<Int>): Boolean = signalAll(pids, OsConstants.SIGCONT)');
    const fin = kt.slice(kt.indexOf('} finally {', kt.indexOf('"hung" -> {')));
    expect(fin).toMatch(/if \(signalled\) \{\s*clearFreezeMarker\(homeDir, agentId, freezeStartMs\)\s*\} else \{/);
    // Not cleared unconditionally anywhere.
    expect(kt.match(/clearFreezeMarker\(/g)).toHaveLength(2); // its definition + the guarded call
  });

  describe('a freeze a dead watchdog left behind', () => {
    function marker(home: string, at: number, pids: Json[], agentId = AGENT) {
      fs.writeFileSync(path.join(home, `.shelly/agents/locks/freeze-${agentId}.json`),
        JSON.stringify({ v: 1, agentId, runStartTs: iso(SCHEDULED), at, pids }));
    }
    // startTimes: the /proc start time each pid reads now (absent: unreadable);
    // gone: pids kill(pid, 0) reports ESRCH for.
    function procs(startTimes: Record<number, number>, gone: number[] = []) {
      const resumed: number[] = [];
      return {
        resumed,
        deps: {
          ...deadProcs,
          startTime: (pid: number) => (pid in startTimes ? startTimes[pid] : null),
          pidGone: (pid: number) => gone.includes(pid),
          cont: (pid: number) => { resumed.push(pid); return true; },
        },
      };
    }
    const markerFile = (home: string) => path.join(home, `.shelly/agents/locks/freeze-${AGENT}.json`);

    it('a stale marker: the sweep resumes the pids whose start time still matches, removes it, and records it', () => {
      const home = makeHome();
      const now = SCHEDULED + 30 * MIN;
      marker(home, now - recovery.FREEZE_STALE_MS - 1, [{ pid: 501, startTime: 7000 }, { pid: 502, startTime: 7100 }, { pid: 503, startTime: null }, { pid: 504, startTime: 7200 }]);
      // 502 was reused by another process (different start time); 503 had no
      // start time and is gone; 504 is gone (no /proc entry, ESRCH).
      const p = procs({ 501: 7000, 502: 9999 }, [503, 504]);
      run(home, { op: 'sweep', nowMs: now, procDeps: p.deps });
      expect(p.resumed).toEqual([501]);
      expect(fs.existsSync(markerFile(home))).toBe(false);
      expect(readJsonl(auditFile(home)).find((l) => l.event === 'plan_freeze_released')).toMatchObject({
        kind: 'plan.recovery', agentId: AGENT, runStartTs: iso(SCHEDULED), pids: 4, resumed: 1, detectedBy: 'sweep',
      });
    });

    it('R5-1: an unreadable /proc start time is UNKNOWN, not "another process": the marker stays until it is settled', () => {
      const home = makeHome();
      const now = SCHEDULED + 30 * MIN;
      marker(home, now - 10 * MIN, [{ pid: 501, startTime: 7000 }, { pid: 502, startTime: 7100 }]);
      // 502: /proc/<pid>/stat unreadable, and kill(pid, 0) does not say ESRCH.
      const first = procs({ 501: 7000 });
      run(home, { op: 'sweep', nowMs: now, procDeps: first.deps });
      expect(first.resumed).toEqual([501]);
      expect(fs.existsSync(markerFile(home))).toBe(true);
      expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_freeze_released')).toBe(false);
      // Next sweep: 502 reads again and still matches -> resumed, marker removed.
      const second = procs({ 501: 7000, 502: 7100 });
      run(home, { op: 'sweep', nowMs: now + 60 * MIN, procDeps: second.deps });
      expect(second.resumed).toEqual([501, 502]);
      expect(fs.existsSync(markerFile(home))).toBe(false);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'plan_freeze_released')).toHaveLength(1);
    });

    it('R5-1: no pidGone probe (cannot confirm ESRCH) keeps the marker', () => {
      const home = makeHome();
      const now = SCHEDULED + 30 * MIN;
      marker(home, now - 10 * MIN, [{ pid: 502, startTime: 7100 }]);
      const resumed: number[] = [];
      run(home, { op: 'sweep', nowMs: now, procDeps: { ...deadProcs, startTime: () => null, cont: (pid: number) => { resumed.push(pid); return true; } } });
      expect(resumed).toEqual([]);
      expect(fs.existsSync(markerFile(home))).toBe(true);
    });

    it('R5-1: a legacy marker (startTime null) is removed only when every such pid is confirmed gone, never signalled', () => {
      const home = makeHome();
      const now = SCHEDULED + 30 * MIN;
      marker(home, now - 10 * MIN, [{ pid: 801, startTime: null }, { pid: 802 }]);
      // 801 still exists (its start time even reads): it cannot be told from a reuse.
      const first = procs({ 801: 5 }, [802]);
      run(home, { op: 'sweep', nowMs: now, procDeps: first.deps });
      expect(first.resumed).toEqual([]);
      expect(fs.existsSync(markerFile(home))).toBe(true);
      const second = procs({}, [801, 802]);
      run(home, { op: 'sweep', nowMs: now + 60 * MIN, procDeps: second.deps });
      expect(second.resumed).toEqual([]);
      expect(fs.existsSync(markerFile(home))).toBe(false);
      expect(readJsonl(auditFile(home)).find((l) => l.event === 'plan_freeze_released')).toMatchObject({ pids: 2, resumed: 0 });
    });

    it('R5-1: the default /proc probe reports ESRCH as gone and a live pid as not gone', () => {
      const deps = recovery.defaultProcDeps();
      expect(deps.pidGone(process.pid)).toBe(false);
      // A pid far above pid_max is never alive.
      expect(deps.pidGone(2 ** 30)).toBe(true);
    });

    it('a SIGCONT that fails keeps the marker; the next sweep retries and removes it on success', () => {
      const home = makeHome();
      const now = SCHEDULED + 30 * MIN;
      const name = `freeze-${AGENT}.${now - 10 * MIN}.json`;
      fs.writeFileSync(path.join(home, `.shelly/agents/locks/${name}`),
        JSON.stringify({ v: 1, agentId: AGENT, runStartTs: iso(SCHEDULED), at: now - 10 * MIN, pids: [{ pid: 601, startTime: 8000 }, { pid: 602, startTime: 8100 }] }));
      let failOnce = true;
      const tried: number[] = [];
      const deps = {
        ...deadProcs,
        startTime: (pid: number) => ({ 601: 8000, 602: 8100 } as Record<number, number>)[pid] ?? null,
        cont: (pid: number) => {
          tried.push(pid);
          if (pid === 602 && failOnce) { failOnce = false; return false; }
          return true;
        },
      };
      run(home, { op: 'sweep', nowMs: now, procDeps: deps });
      expect(fs.existsSync(path.join(home, `.shelly/agents/locks/${name}`))).toBe(true);
      expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_freeze_released')).toBe(false);
      run(home, { op: 'sweep', nowMs: now + 60 * MIN, procDeps: deps });
      expect(tried).toEqual([601, 602, 601, 602]);
      expect(fs.existsSync(path.join(home, `.shelly/agents/locks/${name}`))).toBe(false);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'plan_freeze_released')).toEqual([
        expect.objectContaining({ agentId: AGENT, pids: 2, resumed: 2 }),
      ]);
    });

    it('two freezes of one agent keep two markers (a kept one is never overwritten)', () => {
      const home = makeHome();
      const now = SCHEDULED + 30 * MIN;
      marker(home, now - 10 * MIN, [{ pid: 501, startTime: 7000 }]);
      const stamped = `freeze-${AGENT}.${now - 5 * MIN}.json`;
      fs.writeFileSync(path.join(home, `.shelly/agents/locks/${stamped}`),
        JSON.stringify({ v: 1, agentId: AGENT, runStartTs: iso(SCHEDULED), at: now - 5 * MIN, pids: [{ pid: 701, startTime: 9000 }] }));
      const p = procs({ 501: 7000, 701: 9000 });
      run(home, { op: 'sweep', nowMs: now, procDeps: p.deps });
      expect(p.resumed.sort()).toEqual([501, 701]);
      expect(fs.readdirSync(path.join(home, '.shelly/agents/locks')).filter((n) => n.startsWith('freeze-'))).toEqual([]);
    });

    it('a fresh marker (a freeze in progress) is left alone', () => {
      const home = makeHome();
      const now = SCHEDULED + 30 * MIN;
      marker(home, now - 5_000, [{ pid: 501, startTime: 7000 }]);
      const p = procs({ 501: 7000 });
      run(home, { op: 'sweep', nowMs: now, procDeps: p.deps });
      expect(p.resumed).toEqual([]);
      expect(fs.existsSync(path.join(home, `.shelly/agents/locks/freeze-${AGENT}.json`))).toBe(true);
    });

    it('the stale threshold is far above a live freeze and well under the hourly sweep', () => {
      expect(recovery.FREEZE_STALE_MS).toBe(2 * MIN);
    });
  });
});

describe('review round 1 fixes', () => {
  function seedLive(home: string, startMs: number, events: Array<[number, Json]>, audit: Json[] = []) {
    writeJsonl(auditFile(home), [{ ts: iso(startMs), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true }, ...audit]);
    const runId = `${AGENT}-${startMs}-1-aaaaaa`;
    writeJsonl(
      path.join(logDir(home), 'progress.jsonl'),
      [[startMs + 50, { kind: 'run_start', stepCount: 5 }] as [number, Json], ...events].map(([at, f], i) => ({ v: 1, runId, agentId: AGENT, seq: i + 1, ts: iso(at), ...f })),
    );
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [launch(startMs - 1000)]);
  }

  it('a parallel branch waiting for a CLI slot keeps the run alive after its sibling settled', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const t = SCHEDULED;
    seedLive(home, t, [
      [t + MIN, { kind: 'branch_state', stepIndex: 1, state: 'RUNNING' }],
      [t + MIN, { kind: 'branch_state', stepIndex: 2, state: 'RUNNING' }],
      [t + MIN, { kind: 'tail', stepIndex: 2, tail: 'Waiting for CLI slot: another agent is using Claude Code.' }],
      [t + 2 * MIN, { kind: 'branch_state', stepIndex: 1, state: 'DONE' }],
    ], [{ ts: iso(t + MIN), kind: 'plan.executor', event: 'cli_slot_wait', stepIndex: 2, engine: 'claude' }]);
    const out = run(home, { op: 'hang-check', agentId: AGENT, workerAlive: false, launchStartedAtMs: t - 1000, nowMs: t + 20 * MIN });
    expect(out.verdict).toBe('waiting');
  });

  it('a slot wait that ended (cli_branch_start after it) no longer protects a dead branch', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const t = SCHEDULED;
    seedLive(home, t, [
      [t + MIN, { kind: 'branch_state', stepIndex: 2, state: 'RUNNING' }],
      [t + MIN, { kind: 'tail', stepIndex: 2, tail: 'Waiting for CLI slot: busy.' }],
    ], [
      { ts: iso(t + MIN), kind: 'plan.executor', event: 'cli_slot_wait', stepIndex: 2 },
      { ts: iso(t + 2 * MIN), kind: 'plan.executor', event: 'cli_branch_start', stepIndex: 2 },
    ]);
    const out = run(home, { op: 'hang-check', agentId: AGENT, workerAlive: false, launchStartedAtMs: t - 1000, nowMs: t + 20 * MIN });
    expect(out.verdict).toBe('hung');
  });

  it('no progress stream for the run: unknown, never an abort', () => {
    const home = makeHome();
    const t = SCHEDULED;
    seedLive(home, t, []);
    fs.rmSync(path.join(logDir(home), 'progress.jsonl'));
    const out = run(home, { op: 'hang-check', agentId: AGENT, workerAlive: false, launchStartedAtMs: t - 1000, nowMs: t + 30 * MIN });
    expect(out.verdict).toBe('unknown');
  });

  it('a stream just under the byte cap counts as capped', () => {
    const home = makeHome();
    const t = SCHEDULED;
    seedLive(home, t, [[t + MIN, { kind: 'branch_state', stepIndex: 1, state: 'RUNNING' }]]);
    fs.appendFileSync(path.join(logDir(home), 'progress.jsonl'), `${JSON.stringify({ kind: 'pad', ts: iso(t + MIN), pad: 'x'.repeat(250 * 1024) })}\n`);
    const out = run(home, { op: 'hang-check', agentId: AGENT, workerAlive: false, launchStartedAtMs: t - 1000, nowMs: t + 20 * MIN });
    expect(out.verdict).toBe('unknown');
  });

  it('a re-fire needs an unattended schedule launch (the launch record alone is not trusted)', () => {
    for (const [extra, startUnattended] of [[{ origin: 'event' }, true], [{ unattended: false }, true], [{}, false]] as Array<[Json, boolean]>) {
      const home = makeHome();
      writePlan(home, articlePlan(home));
      const startMs = SCHEDULED + 5_000;
      seedSilentDeath(home, startMs, { launchExtra: extra });
      if (!startUnattended) {
        const lines = readJsonl(auditFile(home));
        lines[2].unattended = false;
        writeJsonl(auditFile(home), lines);
      }
      // A launch and a run that disagree on `unattended` are not tied at all
      // (matchLaunches): finalize cannot claim the run, a sweep closes it with no launch.
      const agree = extra.unattended !== false && startUnattended;
      const out = agree
        ? run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: startMs + MIN })
        : run(home, { op: 'sweep', nowMs: startMs + 10 * MIN });
      expect(out.refire).toEqual([]);
      expect(readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')!.refireSkipped).toBe('adhoc');
    }
  });

  it('never re-fires past local midnight (the re-fire would take the next day\'s draft)', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const slot = new Date(2026, 10, 23, 23, 30, 0).getTime();
    const startMs = slot + 5_000;
    seedSilentDeath(home, startMs, { launchExtra: { scheduledAt: slot } });
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: slot + 40 * MIN });
    expect(out.refire).toEqual([]);
    expect(readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')!.refireSkipped).toBe('window');
  });

  it('finalize closes only its own launch\'s run, not one another launch just started', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    const mine = `${AGENT}-${startMs - 2000}-abc123`;
    const t2 = startMs + 10 * MIN;
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: iso(t2), kind: 'plan.executor', event: 'plan_start', agentId: AGENT })}\n`);
    fs.appendFileSync(path.join(logDir(home), 'run-launches.jsonl'), `${JSON.stringify(launch(t2 - 1000, { launchId: `${AGENT}-${t2}-fff000` }))}\n`);
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: mine, nowMs: t2 + 5_000 });
    expect(out.closed.map((c: Json) => c.runId)).toEqual([mine]);
  });

  it('a sweep that closed the run first still gets the driver\'s exit record from finalize', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    const mine = `${AGENT}-${startMs - 2000}-abc123`;
    run(home, { op: 'sweep', nowMs: startMs + 10 * MIN });
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: mine, nowMs: startMs + 11 * MIN });
    const exits = readJsonl(auditFile(home)).filter((l) => l.event === 'plan_exit');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ runId: mine, exitCode: 137, signal: 'SIGKILL', detectedBy: 'driver' });
    expect(readJsonl(auditFile(home)).filter((l) => l.event === 'plan_orphaned')).toHaveLength(1);
    // Once only.
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: mine, nowMs: startMs + 12 * MIN });
    expect(readJsonl(auditFile(home)).filter((l) => l.event === 'plan_exit')).toHaveLength(1);
  });
});

describe('re-fire is recorded by its dispatch outcome', () => {
  function closeEligible(home: string) {
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: startMs + 5 * MIN });
    expect(out.refire).toHaveLength(1);
    return { startMs, r: out.refire[0] };
  }

  it('a failed dispatch is recorded as not re-fired', () => {
    const home = makeHome();
    const { r } = closeEligible(home);
    run(home, { op: 'refire-result', agentId: AGENT, runId: r.origRunId, refireRunId: r.refireRunId, dispatched: '0' });
    const audit = readJsonl(auditFile(home));
    expect(audit.some((l) => l.event === 'plan_refire')).toBe(false);
    expect(audit.find((l) => l.event === 'plan_refire_failed')).toMatchObject({ why: 'dispatch-failed', refireRunId: r.refireRunId });
    expect(audit.find((l) => l.event === 'recovery_feedback')!.refireSkipped).toBe('dispatch-failed');
    const fb = readJsonl(feedbackFile(home));
    expect(fb).toHaveLength(1);
    expect(fb[0].refire).toEqual({ eligible: true, refired: false, refireRunId: null });
  });

  it('a failed dispatch does not use up the slot', () => {
    const home = makeHome();
    const { startMs, r } = closeEligible(home);
    run(home, { op: 'refire-result', agentId: AGENT, runId: r.origRunId, refireRunId: r.refireRunId, dispatched: '0' });
    const start2 = startMs + 10 * MIN;
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: iso(start2), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true })}\n`);
    fs.appendFileSync(path.join(logDir(home), 'run-launches.jsonl'), `${JSON.stringify(launch(start2 - 1000, { launchId: `${AGENT}-${start2}-def456` }))}\n`);
    const second = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: start2 - 1000, launchId: `${AGENT}-${start2}-def456`, nowMs: start2 + MIN });
    expect(second.refire).toHaveLength(1);
  });

  it('an unknown outcome stays pending; a sweep settles it from the re-fire launch record', () => {
    const home = makeHome();
    const { startMs, r } = closeEligible(home);
    expect(run(home, { op: 'refire-result', agentId: AGENT, runId: r.origRunId, refireRunId: r.refireRunId, dispatched: 'unknown' }).settled).toBe(false);
    // Too early: left alone.
    run(home, { op: 'sweep', nowMs: Date.now() + 60_000 });
    expect(readJsonl(feedbackFile(home))).toEqual([]);
    // The re-fired run started (native wrote its launch record under the decided id).
    fs.appendFileSync(path.join(logDir(home), 'run-launches.jsonl'), `${JSON.stringify(launch(startMs + 6 * MIN, { launchId: r.refireRunId, refireOf: r.origRunId }))}\n`);
    run(home, { op: 'sweep', nowMs: Date.now() + recovery.REFIRE_PENDING_SETTLE_MS + 1000 });
    expect(readJsonl(auditFile(home)).find((l) => l.event === 'plan_refire')).toMatchObject({ confirmedBy: 'launch-record' });
    expect(readJsonl(feedbackFile(home))[0].refire).toEqual({ eligible: true, refired: true, refireRunId: r.refireRunId });
  });

  it('an intent with no outcome and no launch (native died before dispatching) is settled as not re-fired', () => {
    const home = makeHome();
    closeEligible(home);
    run(home, { op: 'sweep', nowMs: Date.now() + recovery.REFIRE_PENDING_SETTLE_MS + 1000 });
    expect(readJsonl(auditFile(home)).find((l) => l.event === 'plan_refire_failed')).toMatchObject({ why: 'unconfirmed' });
    expect(readJsonl(feedbackFile(home))[0].refire).toEqual({ eligible: true, refired: false, refireRunId: null });
    expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_refire')).toBe(false);
  });

  it('a dispatch the service took but never started (refused at a gate) is settled as not re-fired', () => {
    const home = makeHome();
    const { r } = closeEligible(home);
    run(home, { op: 'refire-result', agentId: AGENT, runId: r.origRunId, refireRunId: r.refireRunId, dispatched: '1' });
    expect(readJsonl(auditFile(home)).find((l) => l.event === 'plan_refire_dispatched')).toMatchObject({ refireRunId: r.refireRunId });
    run(home, { op: 'sweep', nowMs: Date.now() + recovery.REFIRE_PENDING_SETTLE_MS + 1000 });
    expect(readJsonl(auditFile(home)).find((l) => l.event === 'plan_refire_failed')).toMatchObject({ why: 'not-started' });
    expect(readJsonl(feedbackFile(home))[0].refire).toEqual({ eligible: true, refired: false, refireRunId: null });
  });

  it('a settled re-fire whose feedback line was lost (death in between) gets it from the next sweep, once', () => {
    const home = makeHome();
    const { r } = closeEligible(home);
    const pending = readJsonl(auditFile(home)).find((l) => l.event === 'plan_refire_pending')!;
    // The outcome line made it to disk, the feedback line did not.
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: new Date().toISOString(), kind: 'plan.recovery', event: 'plan_refire', agentId: AGENT, runId: r.origRunId, runStartTs: pending.runStartTs, refireRunId: r.refireRunId, confirmedBy: 'launch-record' })}\n`);
    run(home, { op: 'sweep', nowMs: Date.now() });
    run(home, { op: 'sweep', nowMs: Date.now() + 1000 });
    const fb = readJsonl(feedbackFile(home));
    expect(fb).toHaveLength(1);
    expect(fb[0].refire).toEqual({ eligible: true, refired: true, refireRunId: r.refireRunId });
    expect(readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')).toMatchObject({ backfilled: true });
  });

  it('R6-2: a settled re-fire whose intent and result were pushed out of the 512 KiB audit tail still gets its content, once', () => {
    const home = makeHome();
    const { startMs, r } = closeEligible(home);
    const pending = readJsonl(auditFile(home)).find((l) => l.event === 'plan_refire_pending')!;
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: new Date().toISOString(), kind: 'plan.recovery', event: 'plan_refire', agentId: AGENT, runId: r.origRunId, runStartTs: pending.runStartTs, refireRunId: r.refireRunId, confirmedBy: 'launch-record' })}\n`);
    // Later runs of the executor write ~1 MiB before the next sweep.
    const later = startMs + 60 * MIN;
    const lines = [JSON.stringify({ ts: iso(later), kind: 'plan.executor', event: 'plan_start', agentId: AGENT })];
    for (let i = 0; i < 2000; i += 1) {
      lines.push(JSON.stringify({ ts: iso(later + i), kind: 'plan.executor', event: 'step_note', pad: 'y'.repeat(500) }));
    }
    lines.push(JSON.stringify({ ts: iso(later + 3000), kind: 'plan.executor', event: 'plan_finish', status: 'success', durationMs: 3000 }));
    fs.appendFileSync(auditFile(home), `${lines.join('\n')}\n`);
    expect(fs.statSync(auditFile(home)).size).toBeGreaterThan(1024 * 1024);
    run(home, { op: 'sweep', nowMs: Date.now() });
    run(home, { op: 'sweep', nowMs: Date.now() + 1000 });
    const fb = readJsonl(feedbackFile(home));
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ runId: r.origRunId, refire: { eligible: true, refired: true, refireRunId: r.refireRunId } });
    expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback')).toEqual([expect.objectContaining({ backfilled: true })]);
    expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback_shared')).toHaveLength(1);
  });

  it('a line pushed out of the shared file tail by other agents is never written again (the agent audit is the record)', () => {
    const home = makeHome();
    const { r } = closeEligible(home);
    run(home, { op: 'refire-result', agentId: AGENT, runId: r.origRunId, refireRunId: r.refireRunId, dispatched: '0' });
    expect(readJsonl(feedbackFile(home))).toHaveLength(1);
    // Other agents append more than the tail the script reads.
    const filler = JSON.stringify({ runId: 'other-agent-run', agentId: 'other', reason: 'orphaned', pad: 'x'.repeat(1000) });
    fs.appendFileSync(feedbackFile(home), `${filler}\n`.repeat(700));
    run(home, { op: 'sweep', nowMs: Date.now() + 1000 });
    run(home, { op: 'sweep', nowMs: Date.now() + recovery.REFIRE_PENDING_SETTLE_MS + 1000 });
    const mine = readJsonl(feedbackFile(home)).filter((l) => l.agentId === AGENT);
    expect(mine).toHaveLength(1);
    expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback')).toHaveLength(1);
  });

  it('content first, then the shared line, then the shared marker', () => {
    const src = fs.readFileSync(scriptCopy, 'utf8');
    const write = src.slice(src.indexOf('function writeFeedback('), src.indexOf('function backfillSharedFeedback('));
    expect(write.indexOf("event: 'recovery_feedback'")).toBeLessThan(write.indexOf('shareFeedback('));
    const share = src.slice(src.indexOf('function shareFeedback('), src.indexOf('function writeFeedback('));
    expect(share.indexOf('appendLine(paths.feedbackFile')).toBeGreaterThan(-1);
    expect(share.indexOf('appendLine(paths.feedbackFile')).toBeLessThan(share.indexOf("event: 'recovery_feedback_shared'"));
    // A failed shared append returns before the marker.
    expect(share).toMatch(/appendLine\(paths\.feedbackFile, feedback\);\s*\} catch \(_\) \{\s*return false;/);
  });

  describe('the shared feedback line is never lost and never doubled', () => {
    function closeOne(home: string, startMs: number) {
      writePlan(home, articlePlan(home));
      seedSilentDeath(home, startMs, { noLaunch: true });
      run(home, { op: 'sweep', nowMs: startMs + 10 * MIN });
      return `${AGENT}-${startMs}-4242-aaaaaa`;
    }
    const startMs = SCHEDULED + 5_000;
    const mineIn = (home: string, runId: string) => readJsonl(feedbackFile(home)).filter((l) => l.runId === runId);
    const dropAudit = (home: string, event: string) => writeJsonl(auditFile(home), readJsonl(auditFile(home)).filter((l) => l.event !== event));

    it('a normal close writes content, line and marker once', () => {
      const home = makeHome();
      const runId = closeOne(home, startMs);
      expect(mineIn(home, runId)).toHaveLength(1);
      const audit = readJsonl(auditFile(home));
      expect(audit.filter((l) => l.event === 'recovery_feedback')).toHaveLength(1);
      expect(audit.filter((l) => l.event === 'recovery_feedback_shared')).toEqual([expect.objectContaining({ runId, reason: 'orphaned', agentId: AGENT })]);
    });

    it('a death after the content, before the shared line: the next sweep adds the line from the content, once', () => {
      const home = makeHome();
      const runId = closeOne(home, startMs);
      const content = readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')!;
      fs.writeFileSync(feedbackFile(home), '');
      dropAudit(home, 'recovery_feedback_shared');
      run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
      run(home, { op: 'sweep', nowMs: startMs + 30 * MIN });
      expect(mineIn(home, runId)).toEqual([content.feedback]);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback_shared')).toEqual([
        expect.objectContaining({ runId, backfilled: true }),
      ]);
    });

    it('a failed shared append leaves no marker; the next sweep adds the line', () => {
      const home = makeHome();
      // The shared file cannot be appended to (a directory in its place).
      fs.mkdirSync(feedbackFile(home), { recursive: true });
      const runId = closeOne(home, startMs);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback')).toHaveLength(1);
      expect(readJsonl(auditFile(home)).some((l) => l.event === 'recovery_feedback_shared')).toBe(false);
      fs.rmdirSync(feedbackFile(home));
      run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
      run(home, { op: 'sweep', nowMs: startMs + 30 * MIN });
      expect(mineIn(home, runId)).toHaveLength(1);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback_shared')).toHaveLength(1);
    });

    it('a death after the shared line, before the marker: the line is found (even past any tail), never doubled', () => {
      const home = makeHome();
      const runId = closeOne(home, startMs);
      dropAudit(home, 'recovery_feedback_shared');
      // Other agents pushed it far out of any tail read.
      const filler = JSON.stringify({ runId: 'other-agent-run', agentId: 'other', reason: 'orphaned', pad: 'x'.repeat(1000) });
      fs.appendFileSync(feedbackFile(home), `${filler}\n`.repeat(700));
      run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
      run(home, { op: 'sweep', nowMs: startMs + 30 * MIN });
      expect(mineIn(home, runId)).toHaveLength(1);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback_shared')).toEqual([
        expect.objectContaining({ runId, foundInFile: true, backfilled: true }),
      ]);
    });

    it('R5-4 (i): a line more than 64 MiB from the end of the shared file is still found (full scan), never doubled', () => {
      const home = makeHome();
      const runId = closeOne(home, startMs);
      dropAudit(home, 'recovery_feedback_shared');
      // 66 MiB of other agents' lines after ours (the old tail window was 64 MiB).
      const filler = Buffer.from(`${JSON.stringify({ runId: 'other-agent-run', agentId: 'other', reason: 'orphaned', pad: 'é'.repeat(500) })}\n`);
      const block = Buffer.concat(Array(1024).fill(filler));
      const fd = fs.openSync(feedbackFile(home), 'a');
      try {
        for (let written = 0; written < 66 * 1024 * 1024; written += block.length) fs.writeSync(fd, block);
      } finally {
        fs.closeSync(fd);
      }
      run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
      const mine = fs.readFileSync(feedbackFile(home), 'utf8').split('\n').filter((l) => l.includes(runId));
      expect(mine).toHaveLength(1);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback_shared')).toEqual([
        expect.objectContaining({ runId, foundInFile: true, backfilled: true }),
      ]);
      fs.truncateSync(feedbackFile(home), 0);
    });

    it('R5-4 (ii): a pending content past the 512 KiB audit tail and older than 24 h is still completed, once', () => {
      const home = makeHome();
      const runId = closeOne(home, startMs);
      const content = readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')!;
      fs.writeFileSync(feedbackFile(home), '');
      dropAudit(home, 'recovery_feedback_shared');
      // The executor wrote ~1 MiB of its own lines after the content (later runs, finished).
      const later = SCHEDULED + 2 * 24 * 60 * MIN;
      const lines: string[] = [];
      for (let i = 0; i < 2000; i += 1) {
        lines.push(JSON.stringify({ ts: iso(later + i * 1000), kind: 'plan.executor', event: 'step_note', pad: 'y'.repeat(500) }));
      }
      lines.push(JSON.stringify({ ts: iso(later + 3000 * 1000), kind: 'plan.executor', event: 'plan_start', agentId: AGENT }));
      lines.push(JSON.stringify({ ts: iso(later + 3001 * 1000), kind: 'plan.executor', event: 'plan_finish', status: 'success' }));
      fs.appendFileSync(auditFile(home), `${lines.join('\n')}\n`);
      expect(fs.statSync(auditFile(home)).size).toBeGreaterThan(1024 * 1024);
      // Three days later.
      run(home, { op: 'sweep', nowMs: startMs + 3 * 24 * 60 * MIN });
      run(home, { op: 'sweep', nowMs: startMs + 3 * 24 * 60 * MIN + 10 * MIN });
      expect(mineIn(home, runId)).toEqual([content.feedback]);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback_shared')).toEqual([
        expect.objectContaining({ runId, backfilled: true }),
      ]);
    });

    it('R5-4 (iii): a short write to the shared file is a failure: no marker; the next sweep completes it, once', () => {
      const home = makeHome();
      // The fs module object the script holds (the ES namespace import above is frozen).
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodeFs = require('fs');
      const realWrite = nodeFs.writeSync;
      let shortened = 0;
      nodeFs.writeSync = (fd: number, buf: unknown, ...rest: unknown[]) => {
        // The shared line (it starts with runId); the audit lines start with ts.
        if (Buffer.isBuffer(buf) && buf.toString('utf8', 0, 9) === '{"runId":' && shortened === 0) {
          shortened += 1;
          return realWrite(fd, buf, 0, Math.floor(buf.length / 2));
        }
        return realWrite(fd, buf, ...rest);
      };
      let runId = '';
      try {
        runId = closeOne(home, startMs);
      } finally {
        nodeFs.writeSync = realWrite;
      }
      expect(shortened).toBe(1);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback')).toHaveLength(1);
      expect(readJsonl(auditFile(home)).some((l) => l.event === 'recovery_feedback_shared')).toBe(false);
      // The fragment is one line of its own (ended), not glued to the next append.
      const raw = fs.readFileSync(feedbackFile(home), 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
      run(home, { op: 'sweep', nowMs: startMs + 30 * MIN });
      const parsed = fs.readFileSync(feedbackFile(home), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
        try { return [JSON.parse(l)]; } catch (_) { return []; }
      });
      expect(parsed.filter((l: Json) => l.runId === runId)).toHaveLength(1);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback_shared')).toEqual([
        expect.objectContaining({ runId, backfilled: true }),
      ]);
    });

    const parsedShared = (home: string): Json[] => fs.readFileSync(feedbackFile(home), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l)]; } catch (_) { return []; }
    });

    it('R6-1 (re-gate fault): a fragment whose closing newline also failed: the retry still writes a whole line, marks it once', () => {
      const home = makeHome();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodeFs = require('fs');
      const realWrite = nodeFs.writeSync;
      let shortened = 0;
      let newlineFailed = 0;
      nodeFs.writeSync = (fd: number, buf: unknown, ...rest: unknown[]) => {
        if (Buffer.isBuffer(buf) && buf.toString('utf8', 0, 9) === '{"runId":' && shortened === 0) {
          shortened += 1;
          return realWrite(fd, buf, 0, Math.floor(buf.length / 2));
        }
        // The best-effort newline that would end the fragment fails too.
        if (buf === '\n' && shortened === 1 && newlineFailed === 0) {
          newlineFailed += 1;
          const err: NodeJS.ErrnoException = new Error('ENOSPC: no space left on device');
          err.code = 'ENOSPC';
          throw err;
        }
        return realWrite(fd, buf, ...rest);
      };
      let runId = '';
      try {
        runId = closeOne(home, startMs);
      } finally {
        nodeFs.writeSync = realWrite;
      }
      expect([shortened, newlineFailed]).toEqual([1, 1]);
      // The fragment is left unterminated, and nothing is marked.
      expect(fs.readFileSync(feedbackFile(home), 'utf8').endsWith('\n')).toBe(false);
      expect(readJsonl(auditFile(home)).some((l) => l.event === 'recovery_feedback_shared')).toBe(false);
      // The retry: the missing newline goes in the same write, before the line.
      run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
      run(home, { op: 'sweep', nowMs: startMs + 30 * MIN });
      const raw = fs.readFileSync(feedbackFile(home), 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(() => JSON.parse(lines[0])).toThrow();
      const content = readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')!;
      expect(JSON.parse(lines[1])).toEqual(content.feedback);
      expect(parsedShared(home).filter((l) => l.runId === runId)).toHaveLength(1);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback_shared')).toEqual([
        expect.objectContaining({ runId, backfilled: true }),
      ]);
    });

    it('R6-1: a write whose byte count is full but whose line cannot be read back is no marker; the next sweep completes it', () => {
      const home = makeHome();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const nodeFs = require('fs');
      const realWrite = nodeFs.writeSync;
      let mangled = 0;
      nodeFs.writeSync = (fd: number, buf: unknown, ...rest: unknown[]) => {
        // The shared line (it starts with runId); the audit lines start with ts.
        if (Buffer.isBuffer(buf) && buf.toString('utf8', 0, 9) === '{"runId":' && mangled === 0) {
          mangled += 1;
          // The bytes land, but not as a line that parses (as if glued onto a fragment).
          const bad = Buffer.concat([Buffer.from('{"partial":'), buf]);
          realWrite(fd, bad, 0, bad.length);
          return buf.length;
        }
        return realWrite(fd, buf, ...rest);
      };
      let runId = '';
      try {
        runId = closeOne(home, startMs);
      } finally {
        nodeFs.writeSync = realWrite;
      }
      expect(mangled).toBe(1);
      expect(fs.readFileSync(feedbackFile(home), 'utf8')).toContain(runId);
      expect(parsedShared(home).filter((l) => l.runId === runId)).toHaveLength(0);
      expect(readJsonl(auditFile(home)).some((l) => l.event === 'recovery_feedback_shared')).toBe(false);
      run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
      run(home, { op: 'sweep', nowMs: startMs + 30 * MIN });
      expect(parsedShared(home).filter((l) => l.runId === runId)).toHaveLength(1);
      expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback_shared')).toEqual([
        expect.objectContaining({ runId, backfilled: true }),
      ]);
    });

    it('R6-1: broken lines in the shared file (naming the runs, and an unterminated tail) do not stop any entry', () => {
      const home = makeHome();
      const runId = closeOne(home, startMs);
      const content = readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')!;
      const other = Object.assign({}, content.feedback, { runId: `${AGENT}-other-run-bbbbbb`, reason: 'hung' });
      fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: iso(startMs + 11 * MIN), kind: 'plan.recovery', event: 'recovery_feedback', feedback: other })}\n`);
      dropAudit(home, 'recovery_feedback_shared');
      fs.writeFileSync(feedbackFile(home), [
        `{"runId":"${runId}","reason":"orphaned","agentId":`,
        `{"runId":"${other.runId}"{"runId":"${other.runId}","reason":"hung"}`,
        'not json at all',
        `{"runId":"${runId}","reas`,
      ].join('\n'));
      run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
      run(home, { op: 'sweep', nowMs: startMs + 30 * MIN });
      expect(parsedShared(home).filter((l) => l.runId === runId)).toEqual([content.feedback]);
      expect(parsedShared(home).filter((l) => l.runId === other.runId)).toEqual([other]);
      const markers = readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback_shared');
      expect(markers).toHaveLength(2);
      expect(markers).toEqual(expect.arrayContaining([
        expect.objectContaining({ runId, reason: 'orphaned', backfilled: true }),
        expect.objectContaining({ runId: other.runId, reason: 'hung', backfilled: true }),
      ]));
    });

    it('R6-1: every append ends a fragment first, in the same write', () => {
      const home = makeHome();
      const file = path.join(home, 'x.jsonl');
      fs.writeFileSync(file, '{"frag":');
      recovery.appendLine(file, { a: 1 });
      recovery.appendLine(file, { b: 2 });
      expect(fs.readFileSync(file, 'utf8')).toBe('{"frag":\n{"a":1}\n{"b":2}\n');
      const empty = path.join(home, 'y.jsonl');
      recovery.appendLine(empty, { c: 3 });
      expect(fs.readFileSync(empty, 'utf8')).toBe('{"c":3}\n');
    });

    it('a settled re-fire\'s content is the record: a later write with other values does not change the line', () => {
      const home = makeHome();
      const runId = closeOne(home, startMs);
      const content = readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')!;
      fs.writeFileSync(feedbackFile(home), '');
      dropAudit(home, 'recovery_feedback_shared');
      // Back-filled from the audit content, not re-derived.
      run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
      expect(mineIn(home, runId)[0]).toEqual(content.feedback);
    });
  });

  it('refire-result validates its arguments', () => {
    const home = makeHome();
    expect(run(home, { op: 'refire-result', agentId: AGENT, runId: 'a', refireRunId: 'b', dispatched: 'yes' })).toEqual({ ok: false, error: 'dispatched' });
    expect(run(home, { op: 'refire-result', agentId: AGENT, runId: 'a', refireRunId: 'b', dispatched: '1' })).toEqual({ ok: true, op: 'refire-result', settled: false });
  });

  it('an accepted dispatch is not settled while native may still be in its 30-minute preflight', () => {
    const rt = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt'), 'utf8');
    const preflightMs = Number(/private const val DEFAULT_TIMEOUT_MS = (\d+) \* 60 \* 1000/.exec(rt)![1]) * MIN;
    expect(preflightMs).toBe(30 * MIN);
    expect(recovery.REFIRE_PENDING_SETTLE_MS).toBeGreaterThanOrEqual(35 * MIN);
    expect(recovery.REFIRE_PENDING_SETTLE_MS).toBeGreaterThan(preflightMs);
    const home = makeHome();
    const { r } = closeEligible(home);
    run(home, { op: 'refire-result', agentId: AGENT, runId: r.origRunId, refireRunId: r.refireRunId, dispatched: '1' });
    for (const after of [11 * MIN, 31 * MIN]) {
      run(home, { op: 'sweep', nowMs: Date.now() + after });
      expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_refire_failed')).toBe(false);
      expect(readJsonl(feedbackFile(home))).toEqual([]);
    }
  });

  it('a launch record naming the run as refireOf confirms the re-fire at settle time', () => {
    const home = makeHome();
    const { startMs, r } = closeEligible(home);
    run(home, { op: 'refire-result', agentId: AGENT, runId: r.origRunId, refireRunId: r.refireRunId, dispatched: '1' });
    fs.appendFileSync(path.join(logDir(home), 'run-launches.jsonl'), `${JSON.stringify(launch(startMs + 33 * MIN, { launchId: `${AGENT}-other-0a0b0c`, refireOf: r.origRunId }))}\n`);
    run(home, { op: 'sweep', nowMs: Date.now() + recovery.REFIRE_PENDING_SETTLE_MS + 1000 });
    expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_refire_failed')).toBe(false);
    expect(readJsonl(feedbackFile(home))[0].refire).toEqual({ eligible: true, refired: true, refireRunId: r.refireRunId });
  });

  it('a re-fire that starts after it was settled as failed still uses up the slot, recorded once', () => {
    const home = makeHome();
    const { startMs, r } = closeEligible(home);
    run(home, { op: 'refire-result', agentId: AGENT, runId: r.origRunId, refireRunId: r.refireRunId, dispatched: '1' });
    run(home, { op: 'sweep', nowMs: Date.now() + recovery.REFIRE_PENDING_SETTLE_MS + 1000 });
    expect(readJsonl(auditFile(home)).find((l) => l.event === 'plan_refire_failed')).toMatchObject({ why: 'not-started' });
    // The late launch record of the re-fire.
    fs.appendFileSync(path.join(logDir(home), 'run-launches.jsonl'), `${JSON.stringify(launch(startMs + 50 * MIN, { launchId: r.refireRunId, refireOf: r.origRunId }))}\n`);
    run(home, { op: 'sweep', nowMs: Date.now() + recovery.REFIRE_PENDING_SETTLE_MS + 2000 });
    run(home, { op: 'sweep', nowMs: Date.now() + recovery.REFIRE_PENDING_SETTLE_MS + 3000 });
    const late = readJsonl(auditFile(home)).filter((l) => l.event === 'plan_refire_late_start');
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ runId: r.origRunId, refireRunId: r.refireRunId, launchId: r.refireRunId });
    expect(readJsonl(feedbackFile(home))).toHaveLength(1);
    // Another dead run of the same slot is not re-fired: the launch record is the final fact.
    const start2 = startMs + 10 * MIN;
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: iso(start2), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true })}\n`);
    fs.appendFileSync(path.join(logDir(home), 'run-launches.jsonl'), `${JSON.stringify(launch(start2 - 1000, { launchId: `${AGENT}-${start2}-def456` }))}\n`);
    const second = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: start2 - 1000, launchId: `${AGENT}-${start2}-def456`, nowMs: start2 + MIN });
    expect(second.refire).toEqual([]);
    expect(readJsonl(auditFile(home)).filter((l) => l.event === 'recovery_feedback').pop()).toMatchObject({ refireSkipped: 'already-refired' });
  });

  it('native reports every dispatch outcome back to the script', () => {
    const kt = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/RunRecovery.kt'), 'utf8');
    expect(kt).toContain('"--op", "refire-result"');
    expect(kt).toContain('"--dispatched", outcome.arg');
  });
});

describe('delivery check fails closed', () => {
  function finalizeDead(home: string, plan: Json, nowOffset = 5 * MIN) {
    writePlan(home, plan);
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: startMs + nowOffset });
    const fbAudit = readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')!;
    return { out, fbAudit, fb: readJsonl(feedbackFile(home))[0] };
  }

  it('a {time} draft name cannot be found again: unverified, no re-fire', () => {
    const home = makeHome();
    const plan = articlePlan(home);
    (plan.output as Json).outputNameTemplate = '{date}_{time}_{slug}';
    const { out, fbAudit } = finalizeDead(home, plan);
    expect(out.refire).toEqual([]);
    expect(fbAudit).toMatchObject({ refireSkipped: 'delivery-unverified', deliveryUnverified: 'time-template' });
  });

  it.each(['{ti!me}_{slug}', '{date}/{tiéme}', 'x{t?ime}.md'])('a template that sanitizes to {time} (%s) is time-dependent too: unverified, no re-fire', (tpl) => {
    const home = makeHome();
    const plan = articlePlan(home);
    (plan.output as Json).outputNameTemplate = tpl;
    // The executor itself names different files at different times of one day.
    const p = executor.runtimePaths(home, AGENT);
    expect(executor.resolveDraftDestination(p, plan, {}, new Date(2026, 10, 24, 9)).dest)
      .not.toBe(executor.resolveDraftDestination(p, plan, {}, new Date(2026, 10, 24, 10)).dest);
    const { out, fbAudit } = finalizeDead(home, plan);
    expect(out.refire).toEqual([]);
    expect(fbAudit).toMatchObject({ refireSkipped: 'delivery-unverified', deliveryUnverified: 'time-template' });
  });

  it('a template with no {time} after sanitizing is still checked (no false time-dependence)', () => {
    const home = makeHome();
    const plan = articlePlan(home);
    (plan.output as Json).outputNameTemplate = '{date}_{slug}!';
    const { out } = finalizeDead(home, plan);
    expect(out.refire).toHaveLength(1);
  });

  it('a stat error other than ENOENT is not absence: unverified, no re-fire', () => {
    const home = makeHome();
    const plan = articlePlan(home);
    // The output folder is a file: lstat of the draft fails with ENOTDIR.
    fs.mkdirSync(path.dirname((plan.output as Json).outputDir as string), { recursive: true });
    fs.writeFileSync((plan.output as Json).outputDir as string, 'not a folder');
    const { out, fbAudit } = finalizeDead(home, plan);
    expect(out.refire).toEqual([]);
    expect(fbAudit).toMatchObject({ refireSkipped: 'delivery-unverified', deliveryUnverified: 'stat-error' });
  });

  it('the destination is resolved for the write days, not the scheduled time', () => {
    const home = makeHome();
    const plan = articlePlan(home);
    const startMs = SCHEDULED + 5_000;
    const now = startMs + 5 * MIN;
    // Written under the run's own day (resolveDraftDestination at write time).
    const dest = executor.resolveDraftDestination(executor.runtimePaths(home, AGENT), plan, {}, new Date(startMs + 4 * MIN)).dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, '# saved before the crash\n');
    const { out, fb } = finalizeDead(home, plan);
    expect(out.refire).toEqual([]);
    expect(fb.delivery).toEqual({ delivered: true, channel: 'draft' });
    expect(fb.artifacts).toEqual({ draft: true, paths: [dest] });
    expect(now).toBeGreaterThan(startMs);
  });

  it('writeDays covers every local day from plan_start to now', () => {
    const a = new Date(2026, 10, 23, 23, 50).getTime();
    const b = new Date(2026, 10, 24, 0, 20).getTime();
    const days = recovery.writeDays(a, b).map((d: Date) => d.getDate());
    expect(days).toEqual([23, 24]);
    expect(recovery.writeDays(a, a + MIN)).toHaveLength(1);
  });

  it('a draft saved on the next local day (run crossed midnight) counts as delivered', () => {
    const home = makeHome();
    const plan = articlePlan(home);
    writePlan(home, plan);
    const slot = new Date(2026, 10, 23, 23, 55, 0).getTime();
    const startMs = slot + 5_000;
    seedSilentDeath(home, startMs, { launchExtra: { scheduledAt: slot } });
    const dest = executor.resolveDraftDestination(executor.runtimePaths(home, AGENT), plan, {}, new Date(slot + 10 * MIN)).dest;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, '# after midnight\n');
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: slot + 20 * MIN });
    expect(readJsonl(feedbackFile(home))[0].delivery).toEqual({ delivered: true, channel: 'draft' });
  });

  it('a draft_exists line in the run counts as delivered', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: iso(startMs + 4 * MIN), kind: 'plan.executor', event: 'draft_exists', agentId: AGENT })}\n`);
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: startMs + 5 * MIN });
    expect(out.refire).toEqual([]);
    expect((readJsonl(feedbackFile(home))[0].delivery as Json).delivered).toBe(true);
  });

  it('a plan changed since the run started may name another path: unverified', () => {
    const home = makeHome();
    const plan = articlePlan(home);
    writePlan(home, plan);
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT}.json`);
    fs.utimesSync(planFile, new Date(startMs + MIN), new Date(startMs + MIN));
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: startMs + 5 * MIN });
    expect(out.refire).toEqual([]);
    expect(readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')).toMatchObject({ refireSkipped: 'delivery-unverified', deliveryUnverified: 'plan-changed' });
  });

  const globalPlan = (home: string) => {
    const plan = articlePlan(home);
    (plan.output as Json).useGlobalOutput = true;
    return plan;
  };
  const old = new Date(SCHEDULED - 10 * MIN);

  it('a global-output plan: a missing, unreadable or changed .env is unverified (parseConfigEnv would read it as empty)', () => {
    for (const [setup, why] of [
      [() => {}, 'config-missing'],
      [(env: string) => { fs.mkdirSync(env); fs.utimesSync(env, old, old); }, 'config-unreadable'],
      [(env: string) => fs.writeFileSync(env, 'SHELLY_AGENT_OUTPUT_TARGET=local\n'), 'config-changed'],
    ] as Array<[(env: string) => void, string]>) {
      const home = makeHome();
      setup(path.join(home, '.shelly/agents/.env'));
      const { out, fbAudit } = finalizeDead(home, globalPlan(home));
      expect(out.refire).toEqual([]);
      expect(fbAudit).toMatchObject({ refireSkipped: 'delivery-unverified', deliveryUnverified: why });
    }
  });

  it('a global-output plan with an unchanged readable .env is checked', () => {
    const home = makeHome();
    const env = path.join(home, '.shelly/agents/.env');
    fs.writeFileSync(env, 'SHELLY_AGENT_OUTPUT_TARGET=local\n');
    fs.utimesSync(env, old, old);
    const { out } = finalizeDead(home, globalPlan(home));
    expect(out.refire).toHaveLength(1);
  });

  it('a plan-folder plan does not depend on .env (it names its draft from the plan only)', () => {
    const home = makeHome();
    const { out } = finalizeDead(home, articlePlan(home));
    expect(out.refire).toHaveLength(1);
  });

  it('a plan or .env edited after the launch started but before plan_start is caught', () => {
    const home = makeHome();
    const plan = articlePlan(home);
    writePlan(home, plan);
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    // Between the launch (startMs - 2000) and plan_start: the executor read it then.
    const planFile = path.join(home, `.shelly/agents/plans/plan-agent-${AGENT}.json`);
    fs.utimesSync(planFile, new Date(startMs - 1000), new Date(startMs - 1000));
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: startMs + 5 * MIN });
    expect(out.refire).toEqual([]);
    expect(readJsonl(auditFile(home)).find((l) => l.event === 'recovery_feedback')).toMatchObject({ deliveryUnverified: 'plan-changed' });
  });

  it('a long-form draft plan with no registered pipeline is never re-fired', () => {
    const home = makeHome();
    fs.rmSync(path.join(home, '.shelly/agents/article-pipelines.json'));
    const { out, fbAudit, fb } = finalizeDead(home, articlePlan(home));
    expect(out.refire).toEqual([]);
    expect(fbAudit.refireSkipped).toBe('no-pipeline');
    expect(fb.pipelineId).toBeNull();
  });
});

describe('driver terminal records on every exit', () => {
  it('an exit 0 that left no plan_finish is closed by the driver record', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    writePipelines(home);
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 0, launchStartedAtMs: startMs - 2000, nowMs: startMs + 5 * MIN });
    expect(out.closed).toHaveLength(1);
    const added = readJsonl(auditFile(home)).slice(4);
    expect(added[0]).toMatchObject({ event: 'plan_exit', exitCode: 0, signal: null, detectedBy: 'driver' });
    expect(added[1]).toMatchObject({ event: 'plan_orphaned', detectedBy: 'driver', exitCode: 0 });
  });

  it('an exit 0 with plan_finish adds nothing', () => {
    const home = makeHome();
    writeJsonl(auditFile(home), [
      { ts: iso(SCHEDULED), kind: 'plan.executor', event: 'plan_start', agentId: AGENT },
      { ts: iso(SCHEDULED + MIN), kind: 'plan.executor', event: 'plan_finish', status: 'success' },
    ]);
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [launch(SCHEDULED - 1000)]);
    const before = fs.readFileSync(auditFile(home), 'utf8');
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 0, launchStartedAtMs: SCHEDULED - 1000, nowMs: SCHEDULED + 2 * MIN });
    expect(fs.readFileSync(auditFile(home), 'utf8')).toBe(before);
  });

  it('native finalizes after every exit, not only non-zero ones', () => {
    const rt = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt'), 'utf8');
    expect(rt).not.toContain('if (exitCode != 0 || launch.watchdog.aborted.get())');
    expect(rt).toContain('RunRecovery.finalize(context, homeDir, agentId, exitCode, launch.startedAtMs, launch.launchId, timedOut, launch.watchdog.abortedRunStartTs)');
  });
});

describe('run identity (launch to plan_start, one to one)', () => {
  const run0 = (ms: number) => ({ ts: iso(ms), kind: 'plan.executor', event: 'plan_start' });
  // A schedule-type launch (only those can be tied to a run: isScheduleLaunch).
  const L = (id: string, startedAt: number, endedAt: number | null = null) => ({ launchId: id, startedAt, endedAt, scheduledAt: 500, refireOf: null });

  it('a launch never matches a plan_start before it (no tolerance after plan_start)', () => {
    const runs = recovery.pairRuns([run0(10_000)]);
    const m = recovery.matchLaunches(runs, [L('late', 10_001)]);
    expect(m.get(runs[0])).toBeUndefined();
    expect(recovery.matchLaunches(runs, [L('ok', 10_000)]).get(runs[0]).launchId).toBe('ok');
  });

  it('a launch whose process ended before the plan_start is not its launch', () => {
    const runs = recovery.pairRuns([run0(10_000)]);
    expect(recovery.matchLaunches(runs, [L('ended', 5_000, 9_000)]).get(runs[0])).toBeUndefined();
  });

  it('a lock refusal nested in a live run is resolved by elimination', () => {
    // L1 runs p1 for a long time; L2 starts, its executor writes p2 + finish (refused) and ends.
    const runs = recovery.pairRuns([run0(1_000), run0(60_000), { ts: iso(60_010), kind: 'plan.executor', event: 'plan_finish' }]);
    const m = recovery.matchLaunches(runs, [L('L1', 900), L('L2', 59_000, 61_000)]);
    expect(m.get(runs[0]).launchId).toBe('L1');
    expect(m.get(runs[1]).launchId).toBe('L2');
  });

  it('two plan_starts that can only come from one launch get neither (no borrowed id or slot)', () => {
    const runs = recovery.pairRuns([run0(1_000), run0(2_000)]);
    const m = recovery.matchLaunches(runs, [L('L1', 900)]);
    expect(m.size).toBe(0);
  });

  it('a duplicated launch id is ignored', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    writePipelines(home);
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    fs.appendFileSync(path.join(logDir(home), 'run-launches.jsonl'), `${JSON.stringify(launch(startMs - 1000, { launchId: `${AGENT}-${startMs - 2000}-abc123` }))}\n`);
    const out = run(home, { op: 'sweep', nowMs: startMs + 10 * MIN });
    // Closed, but under the executor's own id and with no slot: never re-fired.
    expect(out.closed[0].runId).toBe(`${AGENT}-${startMs}-4242-aaaaaa`);
    expect(out.refire).toEqual([]);
    expect(readJsonl(feedbackFile(home))[0]).toMatchObject({ runId: `${AGENT}-${startMs}-4242-aaaaaa`, scheduledAt: null });
  });

  it('a later launch never lends its id or slot to an earlier dead run', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    writePipelines(home);
    const startMs = SCHEDULED + 5_000;
    // The dead run has no launch record of its own; a later launch (a Run now) started 500 ms after its plan_start.
    seedSilentDeath(home, startMs, { noLaunch: true });
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [launch(startMs + 500, { launchId: `${AGENT}-later-000111` })]);
    const out = run(home, { op: 'sweep', nowMs: startMs + 10 * MIN });
    expect(out.closed[0].runId).toBe(`${AGENT}-${startMs}-4242-aaaaaa`);
    expect(readJsonl(feedbackFile(home))[0].scheduledAt).toBeNull();
    expect(out.refire).toEqual([]);
  });

  it('an attended Run now is never the launch of a scheduled (unattended) run, and the reverse', () => {
    const sched = recovery.pairRuns([{ ts: iso(10_000), kind: 'plan.executor', event: 'plan_start', unattended: true }]);
    const manual = recovery.pairRuns([{ ts: iso(10_000), kind: 'plan.executor', event: 'plan_start', unattended: false }]);
    const runNow = { launchId: 'runnow', startedAt: 9_000, endedAt: null, unattended: false, scheduledAt: null };
    const alarm = { launchId: 'alarm', startedAt: 9_000, endedAt: null, unattended: true, scheduledAt: 8_000 };
    expect(recovery.matchLaunches(sched, [runNow]).get(sched[0])).toBeUndefined();
    expect(recovery.matchLaunches(manual, [alarm]).get(manual[0])).toBeUndefined();
    // The true scheduled pair still matches; a Run now (no scheduledAt, no refireOf) is tied to nothing, even its own run.
    expect(recovery.matchLaunches(sched, [alarm]).get(sched[0]).launchId).toBe('alarm');
    expect(recovery.matchLaunches(manual, [runNow]).get(manual[0])).toBeUndefined();
  });

  it('only a schedule-type launch (scheduledAt or refireOf) can lend its identity', () => {
    expect(recovery.isScheduleLaunch({ scheduledAt: 8_000, refireOf: null })).toBe(true);
    expect(recovery.isScheduleLaunch({ scheduledAt: null, refireOf: 'orig-run' })).toBe(true);
    expect(recovery.isScheduleLaunch({ scheduledAt: null, refireOf: null })).toBe(false);
    const runs = recovery.pairRuns([{ ts: iso(10_000), kind: 'plan.executor', event: 'plan_start', unattended: true }]);
    const widget = { launchId: 'widget', startedAt: 9_000, endedAt: null, unattended: true, scheduledAt: null, refireOf: null };
    const refire = { launchId: 'refire', startedAt: 9_000, endedAt: null, unattended: true, scheduledAt: null, refireOf: 'orig-run' };
    // A widget tap's own run: unmatched (no identity to inherit from an ad-hoc launch).
    expect(recovery.matchLaunches(runs, [widget]).get(runs[0])).toBeUndefined();
    // A re-fire launch carrying refireOf only is still schedule-type.
    expect(recovery.matchLaunches(runs, [refire]).get(runs[0]).launchId).toBe('refire');
  });

  it('an unattended widget run never inherits an overlapping dead scheduled launch (no slot, no re-fire)', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    // The run is the widget's (unattended); the scheduled launch 2 s earlier died before its plan_start.
    seedSilentDeath(home, startMs, { noLaunch: true });
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [
      launch(startMs - 2000),
      launch(startMs - 1000, { launchId: `${AGENT}-widget-000777`, origin: 'widget', scheduledAt: null }),
    ]);
    const runs = recovery.pairRuns(readJsonl(auditFile(home)));
    const m = recovery.matchLaunches(runs, [
      { ...launch(startMs - 2000), endedAt: null },
      { ...launch(startMs - 1000, { launchId: `${AGENT}-widget-000777`, origin: 'widget', scheduledAt: null }), endedAt: null },
    ]);
    expect(m.get(runs[runs.length - 1])).toBeUndefined();
    const out = run(home, { op: 'sweep', nowMs: startMs + 10 * MIN });
    expect(out.closed[0].runId).toBe(`${AGENT}-${startMs}-4242-aaaaaa`);
    expect(readJsonl(feedbackFile(home))[0]).toMatchObject({ scheduledAt: null, refire: { eligible: false } });
    expect(out.refire).toEqual([]);
  });

  it('R5-2: a run any ad-hoc launch could have started is never tied (an ad-hoc launch explains nothing)', () => {
    // r1 can only be the widget's; r2 could be the widget's or the alarm's.
    // The widget is not "used up" by r1: r2 has an ad-hoc candidate, so it stays unmatched too.
    const runs = recovery.pairRuns([
      { ts: iso(10_000), kind: 'plan.executor', event: 'plan_start', unattended: true },
      { ts: iso(10_500), kind: 'plan.executor', event: 'plan_start', unattended: true },
      { ts: iso(10_600), kind: 'plan.executor', event: 'plan_finish' },
    ]);
    const widget = { launchId: 'widget', startedAt: 9_000, endedAt: null, unattended: true, scheduledAt: null, refireOf: null };
    const alarm = { launchId: 'alarm', startedAt: 10_200, endedAt: 10_700, unattended: true, scheduledAt: 8_000, refireOf: null };
    const m = recovery.matchLaunches(runs, [widget, alarm]);
    expect(m.get(runs[0])).toBeUndefined();
    expect(m.get(runs[1])).toBeUndefined();
    expect(m.size).toBe(0);
  });

  it('R5-2 (re-gate counterexample): candidate sets {widget}, {widget}, {widget, dead schedule} tie nothing', () => {
    // Three unattended runs inside one open widget launch; a scheduled launch that
    // died before its plan_start overlaps the third. Elimination must not consume
    // the widget and hand the third run the dead launch (its slot, a re-fire).
    const runs = recovery.pairRuns([
      { ts: iso(10_000), kind: 'plan.executor', event: 'plan_start', unattended: true },
      { ts: iso(10_100), kind: 'plan.executor', event: 'plan_finish' },
      { ts: iso(11_000), kind: 'plan.executor', event: 'plan_start', unattended: true },
      { ts: iso(11_100), kind: 'plan.executor', event: 'plan_finish' },
      { ts: iso(12_000), kind: 'plan.executor', event: 'plan_start', unattended: true },
    ]);
    const widget = { launchId: 'widget', startedAt: 9_000, endedAt: null, unattended: true, scheduledAt: null, refireOf: null };
    const deadSched = { launchId: 'dead', startedAt: 11_500, endedAt: null, unattended: true, scheduledAt: 11_000, refireOf: null };
    const m = recovery.matchLaunches(runs, [widget, deadSched]);
    expect(m.size).toBe(0);
    expect(m.get(runs[2])).toBeUndefined();
  });

  it('R5-2: the counterexample end to end: the third run closes under its own id, no slot, no re-fire', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    // Seed the silent death as the third run, with two earlier finished runs inside the same widget launch.
    seedSilentDeath(home, startMs, { noLaunch: true });
    const audit = readJsonl(auditFile(home));
    writeJsonl(auditFile(home), [
      { ts: iso(startMs - 40_000), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true },
      { ts: iso(startMs - 39_000), kind: 'plan.executor', event: 'plan_finish', status: 'success', durationMs: 100 },
      { ts: iso(startMs - 20_000), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true },
      { ts: iso(startMs - 19_000), kind: 'plan.executor', event: 'plan_finish', status: 'success', durationMs: 100 },
      ...audit.slice(2),
    ]);
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [
      launch(startMs - 60_000, { launchId: `${AGENT}-widget-000777`, origin: 'widget', scheduledAt: null }),
      launch(startMs - 2000),
    ]);
    const out = run(home, { op: 'sweep', nowMs: startMs + 10 * MIN });
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].runId).toBe(`${AGENT}-${startMs}-4242-aaaaaa`);
    expect(readJsonl(feedbackFile(home))[0]).toMatchObject({ scheduledAt: null, refire: { eligible: false } });
    expect(out.refire).toEqual([]);
  });

  it('R5-2: elimination among schedule-type launches still works when no ad-hoc launch overlaps', () => {
    // r1 {A}, r2 {A, B}: r1 takes A, then B is r2's only one left.
    const runs = recovery.pairRuns([
      { ts: iso(10_000), kind: 'plan.executor', event: 'plan_start', unattended: true },
      { ts: iso(10_500), kind: 'plan.executor', event: 'plan_start', unattended: true },
      { ts: iso(10_600), kind: 'plan.executor', event: 'plan_finish' },
    ]);
    const a = { launchId: 'A', startedAt: 9_000, endedAt: null, unattended: true, scheduledAt: 8_000, refireOf: null };
    const b = { launchId: 'B', startedAt: 10_200, endedAt: 10_700, unattended: true, scheduledAt: 10_000, refireOf: null };
    const m = recovery.matchLaunches(runs, [a, b]);
    expect(m.get(runs[0]).launchId).toBe('A');
    expect(m.get(runs[1]).launchId).toBe('B');
  });

  it('a scheduled run whose own launch record is missing never takes an overlapping Run now launch', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    // A Run now (attended) launched 2 s before and still open: the only launch in the window.
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [launch(startMs - 2000, { launchId: `${AGENT}-runnow-000333`, origin: 'user', unattended: false, scheduledAt: null })]);
    const out = run(home, { op: 'sweep', nowMs: startMs + 10 * MIN });
    expect(out.closed[0].runId).toBe(`${AGENT}-${startMs}-4242-aaaaaa`);
    expect(out.refire).toEqual([]);
  });

  it('a Run now whose launch record is missing never takes a dead scheduled launch\'s slot', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    // The run is attended; the only launch in the window is the alarm's, which died before writing plan_start.
    const audit = readJsonl(auditFile(home)).map((l) => (l.ts === iso(startMs) ? { ...l, unattended: false } : l));
    writeJsonl(auditFile(home), audit);
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [launch(startMs - 2000)]);
    const out = run(home, { op: 'sweep', nowMs: startMs + 10 * MIN });
    expect(out.closed[0].runId).toBe(`${AGENT}-${startMs}-4242-aaaaaa`);
    expect(readJsonl(feedbackFile(home))[0].scheduledAt).toBeNull();
    expect(out.refire).toEqual([]);
  });

  it('finalize needs its launch id', () => {
    const home = makeHome();
    expect(recovery.runOp({ home, op: 'finalize', agentId: AGENT, exitCode: 1, launchStartedAtMs: 1, procDeps: deadProcs, executorModule: executor })).toEqual({ ok: false, error: 'launch-id' });
  });

  /** Native's end record of a launch (written before finalize, even when the start record failed). */
  const endOf = (home: string, launchId: string, endedAt: number) =>
    fs.appendFileSync(path.join(logDir(home), 'run-launches.jsonl'), `${JSON.stringify({ v: 1, event: 'end', launchId, agentId: AGENT, endedAt })}\n`);
  const MINE = `${AGENT}-mine-000555`;

  it('finalize leaves a run another launch could also have started to the liveness check', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    // Another unattended launch, still open, could also have started the run: ambiguous.
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [launch(startMs - 3000, { launchId: `${AGENT}-other-000444`, scheduledAt: null, origin: 'widget' })]);
    endOf(home, MINE, startMs + 50_000);
    // Within the sweep grace: not closed by this finalize (it is not provably this launch's run).
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: `${AGENT}-mine-000555`, nowMs: startMs + MIN });
    expect(out.closed).toEqual([]);
    expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_exit')).toBe(false);
  });

  it('finalize with no launch record of its own and no declaration records no exit (spec: the run is closed as orphaned, exit unknown)', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    // Even with its own end record bounding a window that holds exactly one
    // plan_start: time is never proof of ownership (no window inference).
    endOf(home, MINE, startMs + 50_000);
    expect(run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: MINE, nowMs: startMs + MIN }).closed).toEqual([]);
    expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_exit')).toBe(false);
    // Past the grace period the liveness check closes it (no executor alive): orphaned, detectedBy sweep, no exit code.
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: MINE, nowMs: startMs + 10 * MIN });
    const progressId = `${AGENT}-${startMs}-4242-aaaaaa`;
    expect(out.closed).toEqual([expect.objectContaining({ runId: progressId })]);
    expect(out.refire).toEqual([]);
    const audit = readJsonl(auditFile(home));
    expect(audit.some((l) => l.event === 'plan_exit')).toBe(false);
    const orphaned = audit.find((l) => l.event === 'plan_orphaned')!;
    expect(orphaned).toMatchObject({ runId: progressId, detectedBy: 'sweep' });
    expect(orphaned.exitCode).toBeUndefined();
    expect(readJsonl(feedbackFile(home))[0]).toMatchObject({ runId: progressId, scheduledAt: null, refire: { eligible: false, refired: false, refireRunId: null } });
  });

  it('an exit is never attributed by time: a launch that died before its plan_start does not hand its exit to an overlapping run', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    // The only plan_start in MINE's start..end is another launch's (whose record is missing).
    seedSilentDeath(home, startMs, { noLaunch: true });
    endOf(home, MINE, startMs + 20_000);
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 1, launchStartedAtMs: startMs - 2000, launchId: MINE, nowMs: startMs + 10 * MIN });
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 1, launchStartedAtMs: startMs - 2000, launchId: MINE, nowMs: startMs + 11 * MIN });
    expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_exit')).toBe(false);
  });

  it('ownRunOf has no time-window rule', () => {
    const src = fs.readFileSync(scriptCopy, 'utf8');
    const body = src.slice(src.indexOf('function ownRunOf('), src.indexOf('function reconcileAgent('));
    expect(body).not.toMatch(/myEndedAt|inWindow|launchCouldStartRun/);
    expect(src).not.toContain('readLaunchEnds(');
  });

  it('a run with no tied launch is not closed while an executor of the agent is alive', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    endOf(home, MINE, startMs + 50_000);
    fs.writeFileSync(path.join(home, `.shelly/agents/locks/${AGENT}.pid`), '4321\n');
    const alive = { pidAlive: () => true, cmdline: () => ['node', '/h/.shelly-plan-executor.js', '--agent-id', AGENT], listPids: () => [4321] };
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: MINE, nowMs: startMs + MIN, procDeps: alive });
    expect(out.closed).toEqual([]);
    expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_exit' || l.event === 'plan_orphaned')).toBe(false);
  });

  it('two unexplained plan_starts in the launch window: neither gets the exit', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: iso(startMs + 30_000), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true })}\n`);
    endOf(home, MINE, startMs + 50_000);
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: `${AGENT}-mine-000555`, nowMs: startMs + MIN });
    expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_exit')).toBe(false);
  });

  it('a run a sweep closed (no launch record, no declaration) gets no exit from a later finalize', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    run(home, { op: 'sweep', nowMs: startMs + 10 * MIN });
    endOf(home, MINE, startMs + 10 * MIN + 30_000);
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 9, launchStartedAtMs: startMs - 2000, launchId: `${AGENT}-mine-000555`, nowMs: startMs + 11 * MIN });
    expect(readJsonl(auditFile(home)).filter((l) => l.event === 'plan_exit')).toHaveLength(0);
  });

  it('the run native declared (its watchdog aborted it) gets the exit even when its launch is ambiguous', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    const mine = `${AGENT}-mine-000555`;
    // Two launches could have started it: matchLaunches ties it to neither.
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [
      launch(startMs - 2000, { launchId: mine }),
      launch(startMs - 3000, { launchId: `${AGENT}-other-000444`, scheduledAt: null, origin: 'widget' }),
    ]);
    const closed = run(home, { op: 'hang-abort', agentId: AGENT, runStartTs: iso(startMs), noProgressMs: 11 * MIN, nowMs: startMs + 12 * MIN });
    expect(closed.closed).toHaveLength(1);
    // Undeclared: ambiguous, no exit.
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: mine, nowMs: startMs + 12 * MIN });
    expect(readJsonl(auditFile(home)).some((l) => l.event === 'plan_exit')).toBe(false);
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: mine, runStartTs: iso(startMs), nowMs: startMs + 12 * MIN });
    const exits = readJsonl(auditFile(home)).filter((l) => l.event === 'plan_exit');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ runId: closed.closed[0].runId, exitCode: 137, runStartTs: iso(startMs) });
    expect(readJsonl(feedbackFile(home))[0]).toMatchObject({ scheduledAt: null });
  });

  /** R2 (declared, the seeded silent death at startMs) and R1 (startMs + 30 s); L_m tied to R1, L_o to R2 by elimination. */
  function seedDisputed(home: string, startMs: number) {
    seedSilentDeath(home, startMs, { noLaunch: true });
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: iso(startMs + 30_000), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true })}\n`);
    const other = `${AGENT}-other-000444`;
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [
      launch(startMs - 2000, { launchId: MINE }),
      launch(startMs - 1000, { launchId: other }),
      { v: 1, event: 'end', launchId: other, agentId: AGENT, endedAt: startMs + 10_000 },
    ]);
    const runs = recovery.pairRuns(readJsonl(auditFile(home)));
    const ls = [
      { ...launch(startMs - 2000, { launchId: MINE }), endedAt: null },
      { ...launch(startMs - 1000, { launchId: other }), endedAt: startMs + 10_000 },
    ];
    const m = recovery.matchLaunches(runs, ls);
    // The inference this test contradicts: R1 is MINE's, R2 is the other launch's.
    expect(m.get(runs.find((r: Json) => r.startTs === iso(startMs + 30_000))).launchId).toBe(MINE);
    expect(m.get(runs.find((r: Json) => r.startTs === iso(startMs))).launchId).toBe(other);
    return { other };
  }

  it('native\'s declaration beats the launch matching: the exit goes to the declared run, the disagreement is audited', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    const { other } = seedDisputed(home, startMs);
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: MINE, runStartTs: iso(startMs), nowMs: startMs + 10 * MIN });
    const audit = readJsonl(auditFile(home));
    const conflicts = audit.filter((l) => l.event === 'plan_exit_attribution_conflict');
    expect(conflicts).toEqual([expect.objectContaining({
      kind: 'plan.recovery', runStartTs: iso(startMs), launchId: MINE, inferredRunStartTs: iso(startMs + 30_000), declaredRunLaunchId: other, resolution: 'declared',
    })]);
    const exits = audit.filter((l) => l.event === 'plan_exit');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ runStartTs: iso(startMs), exitCode: 137, detectedBy: 'driver' });
    // Neither disputed run lends a launch identity: no launch id, no slot, no re-fire.
    const closes = audit.filter((l) => l.event === 'plan_orphaned');
    expect(closes.map((l) => l.runId)).not.toContain(MINE);
    expect(closes.map((l) => l.runId)).not.toContain(other);
    expect(readJsonl(feedbackFile(home)).every((f) => f.scheduledAt === null)).toBe(true);
    // A second finalize records nothing more.
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: MINE, runStartTs: iso(startMs), nowMs: startMs + 11 * MIN });
    const again = readJsonl(auditFile(home));
    expect(again.filter((l) => l.event === 'plan_exit_attribution_conflict')).toHaveLength(1);
    expect(again.filter((l) => l.event === 'plan_exit')).toHaveLength(1);
  });

  it('the watchdog\'s hang-abort is a declaration too: a run the matching ties to another launch closes with no borrowed identity', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    const { other } = seedDisputed(home, startMs);
    const out = run(home, { op: 'hang-abort', agentId: AGENT, runStartTs: iso(startMs), noProgressMs: 11 * MIN, launchId: MINE, launchStartedAtMs: startMs - 2000, nowMs: startMs + 12 * MIN });
    expect(out.closed).toHaveLength(1);
    expect(out.closed[0].runId).not.toBe(other);
    expect(out.refire).toEqual([]);
    expect(readJsonl(auditFile(home)).find((l) => l.event === 'plan_exit_attribution_conflict')).toMatchObject({ runStartTs: iso(startMs), declaredRunLaunchId: other });
    expect(readJsonl(feedbackFile(home))[0]).toMatchObject({ scheduledAt: null });
    const kt = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/RunRecovery.kt'), 'utf8');
    expect(kt).toContain('hangAbort(context, homeDir, agentId, runStartTs, r.noProgressMs, launchId, launchStartedAtMs)');
  });

  it('a declared run that cannot be closed now keeps the observed exit; the later close records it', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    fs.writeFileSync(path.join(home, `.shelly/agents/locks/${AGENT}.pid`), '4321\n');
    const alive = { pidAlive: () => true, cmdline: () => ['node', '/h/.shelly-plan-executor.js', '--agent-id', AGENT], listPids: () => [4321] };
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: MINE, runStartTs: iso(startMs), nowMs: startMs + 10 * MIN, procDeps: alive });
    let audit = readJsonl(auditFile(home));
    expect(audit.some((l) => l.event === 'plan_exit' || l.event === 'plan_orphaned')).toBe(false);
    const kept = audit.filter((l) => l.event === 'plan_exit_observed');
    expect(kept).toEqual([expect.objectContaining({ kind: 'plan.recovery', runStartTs: iso(startMs), launchId: MINE, exitCode: 137, signal: 'SIGKILL', detectedBy: 'driver' })]);
    // The executor is gone: the sweep closes the run and attaches the kept exit.
    run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
    audit = readJsonl(auditFile(home));
    expect(audit.filter((l) => l.event === 'plan_exit')).toEqual([expect.objectContaining({
      runStartTs: iso(startMs), exitCode: 137, signal: 'SIGKILL', detectedBy: 'driver', retainedFrom: kept[0].ts,
    })]);
    expect(audit.find((l) => l.event === 'plan_orphaned')).toMatchObject({ runStartTs: iso(startMs), detectedBy: 'sweep', exitCode: 137, signal: 'SIGKILL' });
  });

  it('R5-3: a kept exit is recorded even when the executor itself closes the run with plan_finish', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    fs.writeFileSync(path.join(home, `.shelly/agents/locks/${AGENT}.pid`), '4321\n');
    const alive = { pidAlive: () => true, cmdline: () => ['node', '/h/.shelly-plan-executor.js', '--agent-id', AGENT], listPids: () => [4321] };
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: MINE, runStartTs: iso(startMs), nowMs: startMs + 10 * MIN, procDeps: alive });
    const kept = readJsonl(auditFile(home)).filter((l) => l.event === 'plan_exit_observed');
    expect(kept).toHaveLength(1);
    // The live executor writes plan_finish for the run before any sweep closes it.
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: iso(startMs + 12 * MIN), kind: 'plan.executor', event: 'plan_finish', status: 'failed', durationMs: 1 })}\n`);
    run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
    let audit = readJsonl(auditFile(home));
    expect(audit.some((l) => l.event === 'plan_orphaned')).toBe(false);
    expect(audit.filter((l) => l.event === 'plan_exit')).toEqual([expect.objectContaining({
      kind: 'plan.recovery', runStartTs: iso(startMs), runId: `${AGENT}-${startMs}-4242-aaaaaa`,
      exitCode: 137, signal: 'SIGKILL', detectedBy: 'driver', retainedFrom: kept[0].ts, closedBy: 'plan_finish',
    })]);
    // Once: later sweeps and finalizes add nothing.
    run(home, { op: 'sweep', nowMs: startMs + 80 * MIN });
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 0, launchStartedAtMs: startMs + 70 * MIN, launchId: `${AGENT}-later-000999`, nowMs: startMs + 81 * MIN });
    audit = readJsonl(auditFile(home));
    expect(audit.filter((l) => l.event === 'plan_exit')).toHaveLength(1);
  });

  it('R5-3: a finalize also records a kept exit whose run plan_finish closed', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    fs.appendFileSync(auditFile(home), [
      { ts: iso(startMs + 9 * MIN), kind: 'plan.recovery', event: 'plan_exit_observed', agentId: AGENT, runStartTs: iso(startMs), launchId: MINE, exitCode: 143, signal: 'SIGTERM', timedOut: false, detectedBy: 'driver' },
      { ts: iso(startMs + 12 * MIN), kind: 'plan.executor', event: 'plan_finish', status: 'failed', durationMs: 1 },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 0, launchStartedAtMs: startMs + 30 * MIN, launchId: `${AGENT}-later-000999`, nowMs: startMs + 31 * MIN });
    const exits = readJsonl(auditFile(home)).filter((l) => l.event === 'plan_exit');
    expect(exits).toEqual([expect.objectContaining({ runStartTs: iso(startMs), exitCode: 143, signal: 'SIGTERM', closedBy: 'plan_finish' })]);
  });

  it('R6-2: a kept exit pushed out of the 512 KiB audit tail before any reconcile is still recorded, once', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    fs.appendFileSync(auditFile(home), [
      { ts: iso(startMs + 9 * MIN), kind: 'plan.recovery', event: 'plan_exit_observed', agentId: AGENT, runStartTs: iso(startMs), launchId: MINE, exitCode: 143, signal: 'SIGTERM', timedOut: false, detectedBy: 'driver' },
      { ts: iso(startMs + 12 * MIN), kind: 'plan.executor', event: 'plan_finish', status: 'failed', durationMs: 1 },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
    // A later run of the executor writes ~1 MiB before the next reconcile.
    const later = startMs + 60 * MIN;
    const lines = [JSON.stringify({ ts: iso(later), kind: 'plan.executor', event: 'plan_start', agentId: AGENT })];
    for (let i = 0; i < 2000; i += 1) {
      lines.push(JSON.stringify({ ts: iso(later + i), kind: 'plan.executor', event: 'step_note', pad: 'y'.repeat(500) }));
    }
    lines.push(JSON.stringify({ ts: iso(later + 3000), kind: 'plan.executor', event: 'plan_finish', status: 'success', durationMs: 3000 }));
    fs.appendFileSync(auditFile(home), `${lines.join('\n')}\n`);
    expect(fs.statSync(auditFile(home)).size).toBeGreaterThan(1024 * 1024);
    run(home, { op: 'sweep', nowMs: later + 10 * MIN });
    run(home, { op: 'sweep', nowMs: later + 70 * MIN });
    const exits = readJsonl(auditFile(home)).filter((l) => l.event === 'plan_exit');
    expect(exits).toEqual([expect.objectContaining({ runStartTs: iso(startMs), exitCode: 143, signal: 'SIGTERM', closedBy: 'plan_finish' })]);
  });

  it('R6-2: both completion paths read the whole audit (no tail window)', () => {
    const src = fs.readFileSync(scriptCopy, 'utf8');
    const reconcile = src.slice(src.indexOf('function reconcileAgent('), src.indexOf('function listAgentIds('));
    expect(reconcile).toMatch(/const all = readAllAuditRuns\(paths, \{ withEvents: true \}\);\s*const runs = all\.ok \? all\.runs : \[\];\s*promoteRetainedExits\(paths, agentId, runs\);/);
    const settle = src.slice(src.indexOf('function settlePendingRefires('), src.indexOf('function openRunAt('));
    expect(settle).toMatch(/const all = readAllAuditRuns\(paths\);\s*for \(const r of all\.ok \? all\.runs : \[\]\)/);
    const reader = src.slice(src.indexOf('function readAllAuditRuns('), src.indexOf('// ── launch records'));
    expect(reader).toContain('scanLines(paths.auditFile');
    expect(reader).not.toContain('readTail');
  });

  it('R7-1: a plan_finish written while a reconcile reads the audit gives one plan_exit and no plan_orphaned', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    fs.writeFileSync(path.join(home, `.shelly/agents/locks/${AGENT}.pid`), '4321\n');
    const alive = { pidAlive: () => true, cmdline: () => ['node', '/h/.shelly-plan-executor.js', '--agent-id', AGENT], listPids: () => [4321] };
    run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, launchId: MINE, runStartTs: iso(startMs), nowMs: startMs + 10 * MIN, procDeps: alive });
    const kept = readJsonl(auditFile(home)).filter((l) => l.event === 'plan_exit_observed');
    expect(kept).toHaveLength(1);
    // The race: the executor appends plan_finish (and exits) after any earlier
    // read of the audit in this reconcile and right before its whole-audit
    // read that promotes kept exits. Before the fix the close was chosen from
    // an earlier tail read that still saw the run open.
    const file = auditFile(home);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeFs = require('fs');
    const realOpen = nodeFs.openSync;
    let injected = false;
    nodeFs.openSync = (p: unknown, ...rest: unknown[]) => {
      const stack = new Error().stack || '';
      if (!injected && String(p) === file && stack.includes('readAllAuditRuns') && stack.includes('reconcileAgent')) {
        injected = true;
        nodeFs.appendFileSync(file, `${JSON.stringify({ ts: iso(startMs + 19 * MIN), kind: 'plan.executor', event: 'plan_finish', status: 'failed', durationMs: 1 })}\n`);
      }
      return realOpen(p, ...rest);
    };
    try {
      run(home, { op: 'sweep', nowMs: startMs + 20 * MIN });
    } finally {
      nodeFs.openSync = realOpen;
    }
    expect(injected).toBe(true);
    const audit = readJsonl(file);
    expect(audit.some((l) => l.event === 'plan_orphaned')).toBe(false);
    expect(audit.filter((l) => l.event === 'plan_exit')).toEqual([expect.objectContaining({
      runStartTs: iso(startMs), exitCode: 137, signal: 'SIGKILL', retainedFrom: kept[0].ts, closedBy: 'plan_finish',
    })]);
  });

  it('R7-1: a reconcile takes one audit snapshot (no tail read) and its runs keep what a close reads', () => {
    const src = fs.readFileSync(scriptCopy, 'utf8');
    const reconcile = src.slice(src.indexOf('function reconcileAgent('), src.indexOf('function listAgentIds('));
    expect(reconcile).not.toContain('readAuditRuns(');
    expect(reconcile.match(/readAllAuditRuns\(/g)).toHaveLength(1);
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    fs.appendFileSync(auditFile(home), `${JSON.stringify({ ts: iso(startMs + 4 * MIN), kind: 'plan.executor', event: 'draft_saved', folder: '/v', file: 'a.md' })}\n`);
    const paths = { auditFile: auditFile(home) };
    const withEvents = recovery.readAllAuditRuns(paths, { withEvents: true });
    expect(withEvents.ok).toBe(true);
    const last = withEvents.runs[withEvents.runs.length - 1];
    expect(last.events.map((e: Json) => e.event)).toEqual(['cli_branch_start', 'draft_saved']);
    const bare = recovery.readAllAuditRuns(paths);
    expect(bare.runs[bare.runs.length - 1].events).toEqual([]);
  });

  it('native declares the aborted run to finalize', () => {
    const kt = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/RunRecovery.kt'), 'utf8');
    expect(kt).toContain('w.abortedRunStartTs = runStartTs');
    expect(kt).toContain('args.add("--run-start-ts")');
  });

  it('native writes an end record per launch, read back by the script', () => {
    const kt = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/RunRecovery.kt'), 'utf8');
    expect(kt).toContain('fun endLaunch(');
    expect(kt).toContain('.put("event", "end")');
    const rt = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/AgentRuntime.kt'), 'utf8');
    expect(rt).toContain('RunRecovery.endLaunch(homeDir, agentId, launch.launchId, System.currentTimeMillis())');
  });

  it('an end record bounds its launch: a later run is not tied to an ended launch', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    writePipelines(home);
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs, { noLaunch: true });
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [
      launch(startMs - 60_000, { launchId: `${AGENT}-early-000222` }),
      { v: 1, event: 'end', launchId: `${AGENT}-early-000222`, agentId: AGENT, endedAt: startMs - 30_000 },
    ]);
    const out = run(home, { op: 'sweep', nowMs: startMs + 10 * MIN });
    expect(out.closed[0].runId).toBe(`${AGENT}-${startMs}-4242-aaaaaa`);
    expect(out.refire).toEqual([]);
  });
});

describe('last step and helpers', () => {
  it('falls back to the audit when progress.jsonl belongs to another run', () => {
    const home = makeHome();
    writePlan(home, articlePlan(home));
    const startMs = SCHEDULED + 5_000;
    seedSilentDeath(home, startMs);
    fs.rmSync(path.join(logDir(home), 'progress.jsonl'));
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 137, launchStartedAtMs: startMs - 2000, nowMs: startMs + MIN });
    expect(out.closed[0].lastStep).toEqual({ index: 2, kind: 'write', startedAt: iso(startMs + 3 * MIN) });
  });

  it('lastStep is null when nothing was reached', () => {
    const home = makeHome();
    // unattended: true like the (scheduled) launch it came from.
    writeJsonl(auditFile(home), [{ ts: iso(SCHEDULED), kind: 'plan.executor', event: 'plan_start', agentId: AGENT, unattended: true }]);
    writeJsonl(path.join(logDir(home), 'run-launches.jsonl'), [launch(SCHEDULED - 1000)]);
    const out = run(home, { op: 'finalize', agentId: AGENT, exitCode: 134, launchStartedAtMs: SCHEDULED - 1000, nowMs: SCHEDULED + MIN });
    expect(out.closed[0].lastStep).toBeNull();
    expect(readJsonl(feedbackFile(home))[0].lastStep).toBeNull();
    expect(readJsonl(auditFile(home))[1]).toMatchObject({ event: 'plan_exit', exitCode: 134, signal: 'SIGABRT' });
  });

  it('signalOf maps 128+n', () => {
    expect(recovery.signalOf(137)).toBe('SIGKILL');
    expect(recovery.signalOf(143)).toBe('SIGTERM');
    expect(recovery.signalOf(1)).toBeNull();
    expect(recovery.signalOf(-1)).toBeNull();
  });

  it('articleFolderKey is the executor\'s own function', () => {
    const src = fs.readFileSync(executorCopy, 'utf8');
    const body = /function articleFolderKey\(folder\) \{[\s\S]*?\n\}/.exec(src)![0];
    expect(fs.readFileSync(scriptCopy, 'utf8')).toContain(body);
  });

  it('the S5-0 constants', () => {
    expect(recovery.REFIRE_WINDOW_MS).toBe(2 * 60 * MIN);
    expect(recovery.HANG_ABORT_NO_PROGRESS_MS).toBe(10 * MIN);
    expect(recovery.HANG_SUSPECT_NO_PROGRESS_MS).toBe(30 * MIN);
    expect(recovery.FEEDBACK_FILE_REL).toBe('.shelly/agents/recovery-feedback.jsonl');
  });
});

describe('CLI and packaging', () => {
  it('runs as a CLI and prints one JSON line', () => {
    const home = makeHome();
    const r = spawnSync(process.execPath, [scriptCopy, '--op', 'sweep', '--home', home, '--executor', executorCopy], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ ok: true, op: 'sweep', closed: [], refire: [], pendingRequests: 0 });
    const bad = spawnSync(process.execPath, [scriptCopy, '--op', 'nope', '--home', home], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout.trim())).toEqual({ ok: false, error: 'op' });
  });

  it('scripts/ copy and the APK asset are byte-identical, and HomeInitializer extracts it', () => {
    expect(fs.readFileSync(assetCopy, 'utf8')).toBe(fs.readFileSync(scriptCopy, 'utf8'));
    const home = fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt'), 'utf8');
    expect(home).toContain('context.assets.open("shelly-run-recovery.js")');
    expect(home).toContain('".shelly-run-recovery.js"');
  });
});
