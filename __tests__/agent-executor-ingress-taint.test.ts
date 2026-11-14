jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

/**
 * MCP ingress taint Inc 5 (script v79): the generated .sh of an agent marked
 * by MCP ingress exports the tainted signals itself (native exports them too),
 * and dispatch_agent_action refuses every action of such a run with an audit
 * line. An unmarked agent's script carries no export (unchanged behaviour).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent } from '@/store/types';

const agent: Agent = {
  id: 't',
  name: 'T',
  description: '',
  prompt: 'summarize my notes',
  schedule: null,
  tool: { type: 'local' },
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
} as Agent;

function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'taint-parse-')), 'run.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}

describe('generateRunScript: MCP ingress taint', () => {
  const marked = generateRunScript(agent, { ingressTainted: true });
  const plain = generateRunScript(agent, {});

  const HEADER = [
    '# MCP ingress taint: this agent came in through MCP; writes and external sends are refused.',
    '[ "${SHELLY_INGRESS_TAINTED:-}" = 1 ] || export SHELLY_INGRESS_TAINTED=1',
    '[ -n "${SHELLY_INGRESS_TAINTED_REASON:-}" ] || export SHELLY_INGRESS_TAINTED_REASON=mcp',
    'readonly SHELLY_INGRESS_TAINTED SHELLY_INGRESS_TAINTED_REASON',
  ];

  it('a marked agent exports SHELLY_INGRESS_TAINTED (+ reason) readonly, never SHELLY_CAP_TAINTED (the broker would stop model calls)', () => {
    for (const line of HEADER) expect(marked).toContain(`\n${line}\n`);
    expect(marked).not.toContain('export SHELLY_CAP_TAINTED=1');
    expect(marked).toContain('SHELLY_AGENT_SCRIPT_VERSION=79');
    bashParses(marked);
  });

  it('the bake survives a later assignment (readonly) and keeps a readonly value native already set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taint-ro-'));
    const file = path.join(dir, 'h.sh');
    fs.writeFileSync(file, [...HEADER, 'SHELLY_INGRESS_TAINTED=0 2>/dev/null || true', 'echo "v=$SHELLY_INGRESS_TAINTED r=$SHELLY_INGRESS_TAINTED_REASON"'].join('\n'));
    expect(execFileSync('bash', [file], { env: { ...process.env } }).toString()).toContain('v=1 r=mcp');
    // Native already exported them readonly (the script is sourced): the guards skip, readonly again is fine.
    const hdr = path.join(dir, 'hdr.sh');
    fs.writeFileSync(hdr, [...HEADER, 'echo "v=$SHELLY_INGRESS_TAINTED r=$SHELLY_INGRESS_TAINTED_REASON"'].join('\n'));
    const nat = path.join(dir, 'n.sh');
    fs.writeFileSync(nat, ['export SHELLY_INGRESS_TAINTED=1 SHELLY_INGRESS_TAINTED_REASON=store-overflow', 'readonly SHELLY_INGRESS_TAINTED SHELLY_INGRESS_TAINTED_REASON', 'set -e', `. '${hdr.replace(/\\/g, '/')}'`].join('\n'));
    expect(execFileSync('bash', [nat]).toString()).toContain('v=1 r=store-overflow');
  });

  it('untainted regression: no export, otherwise the same script', () => {
    expect(plain).not.toContain('export SHELLY_CAP_TAINTED=1');
    expect(plain).not.toContain('|| export SHELLY_INGRESS_TAINTED=1');
    const added = new Set(HEADER);
    expect(marked.split('\n').filter((l) => !added.has(l)).join('\n')).toBe(plain);
  });

  it('both scripts carry the dispatch check and skip the consolidated notification for an ingress-tainted run', () => {
    for (const s of [marked, plain]) {
      expect(s).toContain('  if [ "${SHELLY_INGRESS_TAINTED:-0}" = "1" ]; then\n    ingress_taint_audit "${ACTION_TYPE:-}"');
      expect(s).toContain('"kind":"ingress_tainted_refused"');
    }
    bashParses(plain);
  });

  function runDispatch(actionType: string, env: Record<string, string>) {
    const auditAt = plain.indexOf('ingress_taint_audit() {');
    const at = plain.indexOf('dispatch_agent_action() {');
    const end = plain.indexOf('\n  case "$ACTION_TYPE" in', at);
    const fn = `${plain.slice(auditAt, at)}${plain.slice(at, end)}\n  echo DISPATCHED\n}\n`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taint-run-'));
    const file = path.join(dir, 't.sh');
    fs.writeFileSync(file, [
      'continuous_stop_requested() { return 1; }',
      `LOG_DIR='${dir.replace(/\\/g, '/')}/logs'`,
      "AGENT_ID='t'",
      `ACTION_TYPE='${actionType}'`,
      'export HOME=/nonexistent',
      fn,
      'dispatch_agent_action x y; echo "rc=$? status=${ACTION_DISPATCH_STATUS:-} msg=${ACTION_DISPATCH_MESSAGE:-}"',
    ].join('\n'));
    const out = execFileSync('bash', [file], { env: { ...process.env, ...env } }).toString();
    const auditFile = path.join(dir, 'logs', 'agent-driver-audit.jsonl');
    const audit = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    return { out, audit };
  }

  it('the refusal runs: action skipped, one audit line with the reason, nothing dispatched', () => {
    const { out, audit } = runDispatch('webhook', { SHELLY_INGRESS_TAINTED: '1', SHELLY_INGRESS_TAINTED_REASON: 'mcp' });
    expect(out).toContain('rc=1 status=skipped');
    expect(out).toContain('created or changed through MCP');
    expect(out).not.toContain('DISPATCHED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ kind: 'ingress_tainted_refused', event: 'action', agentId: 't', actionType: 'webhook', reason: 'mcp' });
  });

  it('an unverifiable store gets its own wording', () => {
    const { out, audit } = runDispatch('notify', { SHELLY_INGRESS_TAINTED: '1', SHELLY_INGRESS_TAINTED_REASON: 'store-unreadable' });
    expect(out).toContain('MCP taint record cannot be verified (store-unreadable)');
    expect(audit[0]).toMatchObject({ reason: 'store-unreadable' });
  });

  it('an intermediate (__suppressed__) step saves nothing (the text stays in $RESULT_FILE)', () => {
    const { out, audit } = runDispatch('__suppressed__', { SHELLY_INGRESS_TAINTED: '1' });
    expect(out).toContain('rc=0');
    expect(out).not.toContain('DISPATCHED');
    expect(audit[0]).toMatchObject({ event: 'suppressed_draft', actionType: '__suppressed__' });
  });

  it('untainted: falls through to the dispatch, no audit line', () => {
    const { out, audit } = runDispatch('webhook', { SHELLY_INGRESS_TAINTED: '0' });
    expect(out).toContain('DISPATCHED');
    expect(audit).toHaveLength(0);
  });
});
