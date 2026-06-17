/**
 * Entry for the bundled `shelly-gate-decide.js` node helper (Spec A2 §3).
 *
 * Reads `{ "command": string, "policy": AutonomyPolicy }` JSON on stdin and
 * prints the `GateOutcome` JSON (`decideAutoAnswer`) on stdout. This lets the
 * Kotlin approval bridge get a single-source gate decision via a bundled `node`
 * call — RN-independent (survives a background FGS) and fail-closed.
 *
 * FAIL-CLOSED: any missing field / parse error / exception → `{answer:'escalate'}`.
 * The caller MUST treat a non-`y`/`n` answer (or any nonzero exit / unparseable
 * output) as escalate, never as allow.
 *
 * Do NOT hand-edit the bundle — regenerate with `pnpm build:gate`
 * (scripts/build-gate-decide.mjs), which esbuilds this file from the TS sources.
 */
import { decideAutoAnswer, parseAutonomyPolicy } from '@/lib/agent-policy';

function escalate(reason: string): never {
  process.stdout.write(JSON.stringify({ answer: 'escalate', reason: `gate-decide: ${reason}` }));
  process.exit(0);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('error', (e) => escalate(String(e)));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw || '{}');
    const command = typeof input.command === 'string' ? input.command : null;
    if (command === null) return escalate('missing command');
    const rawPolicy = input.policy && typeof input.policy === 'object' ? input.policy : {};
    const root = typeof rawPolicy.workspaceRoot === 'string' ? rawPolicy.workspaceRoot : '';
    if (!root) return escalate('missing workspaceRoot');
    const policy = parseAutonomyPolicy(rawPolicy, root);
    process.stdout.write(JSON.stringify(decideAutoAnswer(command, policy)));
  } catch (e) {
    escalate((e as Error)?.message ?? String(e));
  }
});
