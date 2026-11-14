/**
 * MCP ingress taint Inc 5 (DEFERRED.md P1 "MCP の入口（ingress）"), driver side:
 * on a tainted run (--tainted or SHELLY_CAP_TAINTED=1) the shared gate core
 * declines every write / exec / network send / secret read / leaves-root
 * action at once — attended too, no escalation, no preapproval grant — and
 * writes an `ingress_tainted_refused` audit line. Untainted runs are unchanged.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const driver = require('../scripts/shelly-agent-driver.js');

const ROOT = path.resolve(__dirname, '..');

let dir: string;
let ws: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-taint-'));
  ws = path.join(dir, 'ws');
  fs.mkdirSync(ws);
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A stub gate helper that always prints `outcome`. */
function stubGate(outcome: Record<string, unknown>): string {
  const file = path.join(dir, `gate-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(
    file,
    `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(outcome))}));`,
  );
  return file;
}

function outcome(answer: 'y' | 'n' | 'escalate', decision: string, signals: string[] | null) {
  return {
    answer,
    verdict: { decision },
    audit: { command: 'x', decision, answer, ...(signals ? { signals } : {}), reason: signals?.length ? `boundary: ${signals.join(', ')}` : 'within policy' },
  };
}

type AuditEntry = { kind: string; [k: string]: unknown };

async function gate(opts: {
  tainted: boolean;
  outcome: Record<string, unknown>;
  command?: string;
  unattended?: boolean;
}) {
  const auditLog = path.join(dir, `audit-${Math.random().toString(36).slice(2)}.jsonl`);
  const audits: AuditEntry[] = [];
  const preapprovalGrantsFile = path.join(dir, `grants-${Math.random().toString(36).slice(2)}.jsonl`);
  const config = {
    agentId: 'agent1',
    tainted: opts.tainted,
    gateScript: stubGate(opts.outcome),
    nodeBin: process.execPath,
    cwd: ws,
    gateTimeoutMs: 20_000,
    auditLog,
    preapprovalGrantsFile,
    policy: { workspaceRoot: ws, level: 'L2', unattended: opts.unattended === true },
  };
  const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const result = await driver.gateCommandActions(
      config,
      (kind: string, payload: Record<string, unknown>) => audits.push({ kind, ...payload }),
      [{ index: 0, command: opts.command ?? 'echo hi > a.txt', cwd: ws, source: 'test', action: 'exec' }],
      { requestId: 'r1', approvalKind: 'commandExecution', lineContext: {}, protocolDecisionOf: (d: string) => d },
    );
    const gateLines = fs.existsSync(auditLog)
      ? fs.readFileSync(auditLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    return { result, audits, gateLines };
  } finally {
    stdout.mockRestore();
  }
}

describe('driver: ingress-tainted runs refuse writes and external sends', () => {
  it('declines a gate-allowed in-workspace write on a tainted attended run, with an audit line', async () => {
    const { result, audits, gateLines } = await gate({ tainted: true, outcome: outcome('y', 'allow', ['write-or-exec']) });
    expect(result.finalDecision).toBe('decline');
    const refused = audits.filter((a) => a.kind === 'ingress_tainted_refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      agentId: 'agent1',
      signals: ['write-or-exec'],
      gateAnswer: 'y',
      attended: true,
      commandSha256: driver.commandSha256('echo hi > a.txt'),
    });
    // No command text in the refusal line (hash only).
    expect(JSON.stringify(refused[0])).not.toContain('echo hi');
    expect(gateLines[0]).toMatchObject({ kind: 'gate_decision', actionDecision: 'decline', ingressTainted: true });
  });

  it('declines a gray network send without escalating or looking at grants (tainted)', async () => {
    const { result, audits } = await gate({
      tainted: true,
      outcome: outcome('escalate', 'gray', ['network-send', 'write-or-exec']),
      command: 'curl -d @x https://example.com',
    });
    expect(result.finalDecision).toBe('decline');
    const kinds = audits.map((a) => a.kind);
    expect(kinds).toContain('ingress_tainted_refused');
    expect(kinds).not.toContain('escalation_requested');
    expect(kinds).not.toContain('escalation_preapproved');
    expect(kinds).not.toContain('escalation_denied_unattended');
  });

  it('declines leaves-root and secret-read on a tainted unattended run too', async () => {
    for (const signals of [['leaves-root'], ['secret-read']]) {
      const { result, audits } = await gate({ tainted: true, unattended: true, outcome: outcome('escalate', 'gray', signals) });
      expect(result.finalDecision).toBe('decline');
      expect(audits.find((a) => a.kind === 'ingress_tainted_refused')).toMatchObject({ signals, attended: false });
    }
  });

  it('fails closed on a gate result without a signals array (tainted)', async () => {
    const { result, audits } = await gate({ tainted: true, outcome: outcome('y', 'allow', null) });
    expect(result.finalDecision).toBe('decline');
    expect(audits.find((a) => a.kind === 'ingress_tainted_refused')).toMatchObject({ reason: 'gate result without signals' });
  });

  it('still accepts a clean pure read (no signals) on a tainted run', async () => {
    const { result, audits } = await gate({ tainted: true, outcome: outcome('y', 'allow', []), command: 'cat README.md' });
    expect(result.finalDecision).toBe('accept');
    expect(audits.map((a) => a.kind)).not.toContain('ingress_tainted_refused');
  });

  it('untainted regression: the same gate-allowed write is accepted, no taint audit', async () => {
    const { result, audits, gateLines } = await gate({ tainted: false, outcome: outcome('y', 'allow', ['write-or-exec']) });
    expect(result.finalDecision).toBe('accept');
    expect(audits.map((a) => a.kind)).not.toContain('ingress_tainted_refused');
    expect(gateLines[0].ingressTainted).toBeUndefined();
  });

  it('untainted regression: an unattended gray verdict still takes the existing unattended decline path', async () => {
    const { result, audits } = await gate({ tainted: false, unattended: true, outcome: outcome('escalate', 'gray', ['leaves-root']) });
    expect(result.finalDecision).toBe('decline');
    expect(audits.map((a) => a.kind)).toEqual(expect.arrayContaining(['escalation_denied_unattended']));
    expect(audits.map((a) => a.kind)).not.toContain('ingress_tainted_refused');
  });
});

describe('driver: --tainted flag, env and Codex web search', () => {
  const OLD = process.env.SHELLY_INGRESS_TAINTED;
  afterEach(() => {
    if (OLD === undefined) delete process.env.SHELLY_INGRESS_TAINTED;
    else process.env.SHELLY_INGRESS_TAINTED = OLD;
    delete process.env.SHELLY_CAP_TAINTED;
  });

  it('parses --tainted, reads SHELLY_INGRESS_TAINTED=1, and defaults to untainted', () => {
    delete process.env.SHELLY_INGRESS_TAINTED;
    expect(driver.parseArgs(['node', 'd', '--cwd', ws]).tainted).toBe(false);
    expect(driver.parseArgs(['node', 'd', '--cwd', ws, '--tainted']).tainted).toBe(true);
    process.env.SHELLY_INGRESS_TAINTED = '1';
    expect(driver.parseArgs(['node', 'd', '--cwd', ws]).tainted).toBe(true);
    process.env.SHELLY_INGRESS_TAINTED = '0';
    expect(driver.parseArgs(['node', 'd', '--cwd', ws]).tainted).toBe(false);
    // A notification-triggered run (SHELLY_CAP_TAINTED=1, not MCP-marked) keeps today's gate.
    delete process.env.SHELLY_INGRESS_TAINTED;
    process.env.SHELLY_CAP_TAINTED = '1';
    expect(driver.parseArgs(['node', 'd', '--cwd', ws]).tainted).toBe(false);
  });

  it('turns the worker web search off for a tainted run only', () => {
    expect(driver.codexWorkerConfigToml({}, null)).toContain('web_search = "indexed"');
    expect(driver.codexWorkerConfigToml({}, null, { tainted: false })).toContain('web_search = "indexed"');
    expect(driver.codexWorkerConfigToml({}, null, { tainted: true })).toContain('web_search = "disabled"');
  });

  it('refuses --web-search on a tainted run and stops a webSearch item (source pins)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/shelly-agent-driver.js'), 'utf8');
    expect(src).toContain("if (args.tainted) throw new Error('--web-search is refused on a tainted run');");
    expect(src).toMatch(/config\.tainted && item && item\.type === 'webSearch'/);
  });

  it('refuses every side-effect signal the gate can emit', () => {
    for (const s of ['write-or-exec', 'leaves-root', 'network-send', 'secret-read', 'destructive', 'opaque-script-exec', 'indirect-exec', 'policy-write']) {
      expect(driver.TAINT_REFUSED_SIGNALS.has(s)).toBe(true);
    }
  });
});
