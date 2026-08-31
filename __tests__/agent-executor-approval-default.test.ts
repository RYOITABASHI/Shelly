jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

// Superseded 2026-08-25 (Fable5 review): the 2026-07-14 project-owner
// directive this file used to cite ("デフォは承認なしな" — default is
// no-approval) meant an unset/misconfigured device got zero human approval
// on real-side-effect actions by default — the wrong failure mode for a
// security gate. Reversed: default is now require-approval (manual); only
// an explicit opt-out restores the old auto-approve behavior. Covers the
// three things the task asked for — (1) default-ON behavior, (2) explicit
// opt-out restores auto, and (3) the hard safety floor (command-safety
// CRITICAL / secret-scan / workspace-root) is untouched by the
// approval-frequency default.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

const agent = (overrides: Partial<Agent> = {}): Agent => ({
  id: 't',
  name: 'T',
  description: '',
  prompt: 'hi',
  schedule: null,
  tool: { type: 'local' } as ToolChoice,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
  action: { type: 'draft' },
  ...overrides,
});

describe('runtime approval default (reversed 2026-08-25, Fable5 review)', () => {
  it('bakes ACTION_APPROVAL_MODE_OVERRIDE empty and an "auto" compile-time placeholder (overwritten by the live .env resolution below) when no per-agent override is set', () => {
    const s = generateRunScript(agent());
    expect(s).toContain("ACTION_APPROVAL_MODE_OVERRIDE=''");
    expect(s).toContain('ACTION_APPROVAL_MODE="auto"');
  });

  it('a per-agent requireActionApproval:true bakes the manual override', () => {
    const s = generateRunScript(agent({ requireActionApproval: true }));
    expect(s).toContain("ACTION_APPROVAL_MODE_OVERRIDE='manual'");
  });

  it('a per-agent requireActionApproval:false bakes the auto override (opts OUT of the global default even if it is manual)', () => {
    const s = generateRunScript(agent({ requireActionApproval: false }));
    expect(s).toContain("ACTION_APPROVAL_MODE_OVERRIDE='auto'");
  });

  it('resolves the global default LIVE from the sourced .env, not baked at generation time, so toggling it needs no re-save', () => {
    const s = generateRunScript(agent());
    const runtimeBlock = s.slice(
      s.indexOf('[ -f "$ENV_FILE" ] && source "$ENV_FILE"'),
      s.indexOf('PROJECT_DIR='),
    );
    expect(runtimeBlock).toContain('if [ -n "$ACTION_APPROVAL_MODE_OVERRIDE" ]; then');
    expect(runtimeBlock).toContain('ACTION_APPROVAL_MODE="$ACTION_APPROVAL_MODE_OVERRIDE"');
    // Fable5 review 2026-08-25: flipped from "manual only on explicit '1'"
    // to "auto only on explicit '0'" — unset/anything-else now resolves to
    // manual, not auto. See the block's own comment for why.
    expect(runtimeBlock).toContain('elif [ "${SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL:-1}" = "0" ]; then');
    expect(runtimeBlock).toContain('ACTION_APPROVAL_MODE="auto"');
    expect(runtimeBlock).toContain('ACTION_APPROVAL_MODE="manual"');
  });

  it('an unset/absent SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL resolves to manual, not auto (bash proof of the new fail-closed default)', () => {
    const s = generateRunScript(agent());
    // Isolate just the resolution if/elif/else, skipping the `.env` source
    // line (irrelevant here — nothing sets SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL).
    const resolutionBlock = s.slice(
      s.indexOf('if [ -n "$ACTION_APPROVAL_MODE_OVERRIDE" ]; then'),
      s.indexOf('PROJECT_DIR='),
    );
    const script = `set -euo pipefail\nACTION_APPROVAL_MODE_OVERRIDE=''\n${resolutionBlock}\necho "$ACTION_APPROVAL_MODE"`;
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
    expect(out).toBe('manual');
  });

  it('draft/notify/webhook/cli skip the approval round trip ENTIRELY in auto mode; intent/dm-reply always request (bash proof of request_and_wait_approval)', () => {
    // Bash-level proof of the exact skip/always-request contract
    // request_and_wait_approval implements — mirrors the existing
    // "the gate skips the approval wait only when autonomous (bash)" test
    // style in agent-executor-autonomous.test.ts.
    const script = [
      'set -euo pipefail',
      'LOG=""',
      'write_action_approval_request() { LOG="${LOG}WROTE:$1;"; }',
      'wait_action_approval() { LOG="${LOG}WAITED:$1;"; return 0; }',
      'request_and_wait_approval() {',
      '  approval_type="$1"',
      '  if [ "$ACTION_APPROVAL_MODE" != "manual" ]; then',
      '    case "$approval_type" in',
      '      intent|dm-reply) ;;',
      '      *) return 0 ;;',
      '    esac',
      '  fi',
      '  write_action_approval_request "$approval_type" x x',
      '  wait_action_approval "$approval_type"',
      '}',
      'ACTION_APPROVAL_MODE="auto"',
      'for t in draft notify webhook cli intent dm-reply; do',
      '  request_and_wait_approval "$t"',
      'done',
      'echo "$LOG"',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
    // auto mode: draft/notify/webhook/cli never write/wait; intent/dm-reply always do.
    expect(out).toBe('WROTE:intent;WAITED:intent;WROTE:dm-reply;WAITED:dm-reply;');
  });

  it('opt-in ON (manual mode) restores the full write+wait round trip for every action type (bash proof)', () => {
    const script = [
      'set -euo pipefail',
      'LOG=""',
      'write_action_approval_request() { LOG="${LOG}WROTE:$1;"; }',
      'wait_action_approval() { LOG="${LOG}WAITED:$1;"; return 0; }',
      'request_and_wait_approval() {',
      '  approval_type="$1"',
      '  if [ "$ACTION_APPROVAL_MODE" != "manual" ]; then',
      '    case "$approval_type" in',
      '      intent|dm-reply) ;;',
      '      *) return 0 ;;',
      '    esac',
      '  fi',
      '  write_action_approval_request "$approval_type" x x',
      '  wait_action_approval "$approval_type"',
      '}',
      'ACTION_APPROVAL_MODE="manual"',
      'for t in draft notify webhook cli; do',
      '  request_and_wait_approval "$t"',
      'done',
      'echo "$LOG"',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
    expect(out).toBe('WROTE:draft;WAITED:draft;WROTE:notify;WAITED:notify;WROTE:webhook;WAITED:webhook;WROTE:cli;WAITED:cli;');
  });
});

describe('hard safety floor is untouched by the approval-frequency default (project owner directive point 4)', () => {
  it('CRITICAL command safety still hard-blocks a cli action BEFORE request_and_wait_approval is ever reached, in both auto and manual mode', () => {
    const s = generateRunScript(agent({ action: { type: 'cli', command: 'rm -rf /' } }));
    const criticalCheckIdx = s.indexOf('[ "$ACTION_COMMAND_SAFETY_LEVEL" = "CRITICAL" ]');
    const requestIdx = s.indexOf('request_and_wait_approval "cli"');
    expect(criticalCheckIdx).toBeGreaterThan(-1);
    expect(requestIdx).toBeGreaterThan(-1);
    // The CRITICAL check (and its `return 1` refusal) is textually BEFORE the
    // approval call, and is not gated on $ACTION_APPROVAL_MODE at all — it
    // fires (and refuses) regardless of the approval-frequency default.
    expect(criticalCheckIdx).toBeLessThan(requestIdx);
    const criticalGate = s.slice(criticalCheckIdx - 80, criticalCheckIdx + 200);
    expect(criticalGate).not.toContain('ACTION_APPROVAL_MODE');
  });

  it('a CRITICAL command is blocked with CRITICAL-level command-safety text regardless of ACTION_APPROVAL_MODE (bash proof)', () => {
    // Mirrors evaluateAgentActionCommand's CRITICAL classification for an
    // unambiguous destructive command, then proves in bash that the refusal
    // fires identically whether ACTION_APPROVAL_MODE is auto or manual.
    const s = generateRunScript(agent({ action: { type: 'cli', command: 'rm -rf ~' } }));
    expect(s).toContain("ACTION_COMMAND_SAFETY_LEVEL='CRITICAL'");
    const cliCase = s.slice(s.indexOf('\n    cli)'), s.indexOf('\n    intent)'));
    expect(cliCase).toContain('CLI action was blocked by command safety');
    // 2026-07-28 P0 regression guard: the CRITICAL hard-block used to be
    // gated behind `${SHELLY_CAP_EXEC:-0} = 1`, which was NEVER set on this
    // legacy generated-script path (SHELLY_CAP_EXEC is only exported by
    // AgentRuntime.kt for the newer shelly-plan-executor.js route), so the
    // block was dead code for every single-step / CLI-backend agent. The
    // check must now be unconditional on the safety level alone.
    expect(cliCase).toContain('if [ "$ACTION_COMMAND_SAFETY_LEVEL" = "CRITICAL" ]; then');
    expect(cliCase).not.toContain('if [ "${SHELLY_CAP_EXEC:-0}" = "1" ] && [ "$ACTION_COMMAND_SAFETY_LEVEL" = "CRITICAL" ]; then');
  });

  /**
   * 2026-07-28 P0 fix regression test: extracts the REAL emitted "cli)" case
   * block from dispatch_agent_action (not a hand-copied re-implementation)
   * and executes it with real bash, stubbing only the functions it calls out
   * to. Proves the actual compiled behavior — a CRITICAL cli command must be
   * refused, and must NEVER reach cap_workspace_exec (the function that would
   * actually run the command), even with SHELLY_CAP_EXEC completely unset —
   * i.e. the exact legacy-path/single-step-agent scenario the bug report
   * described, where AgentRuntime.kt never exports SHELLY_CAP_EXEC=1 at all.
   */
  function extractCliCase(script: string): string {
    const fnMarker = 'dispatch_agent_action() {';
    const fnStart = script.indexOf(fnMarker);
    if (fnStart === -1) throw new Error('dispatch_agent_action function not found in generated script');
    const marker = '\n    cli)';
    const start = script.indexOf(marker, fnStart);
    if (start === -1) throw new Error('cli) case block not found in dispatch_agent_action');
    const bodyStart = start + marker.length;
    const end = script.indexOf('\n      ;;', bodyStart);
    if (end === -1) throw new Error('closing ";;" for cli) case block not found');
    return script.slice(bodyStart, end);
  }

  function runRealCliCase(opts: { safetyLevel: string; capExec?: '1' }): {
    exitCode: number;
    dispatchStatus: string;
    dispatchMessage: string;
    execCalled: boolean;
    approvalCalled: boolean;
  } {
    const s = generateRunScript(agent({ action: { type: 'draft' } }));
    const cliCase = extractCliCase(s);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-cli-critical-'));
    const markerFile = path.join(dir, 'markers.txt');
    const dispatchStatusFile = path.join(dir, 'dispatch-status.txt');
    const wrapperPath = path.join(dir, 'wrapper.sh');
    const wrapper = `set -uo pipefail
LOG_DIR=${JSON.stringify(dir)}
PROJECT_DIR=${JSON.stringify(dir)}
HOME=${JSON.stringify(dir)}
preview="preview text"
result_file=${JSON.stringify(path.join(dir, 'result.md'))}
ACTION_COMMAND="rm -rf ~"
ACTION_COMMAND_SAFETY_LEVEL=${JSON.stringify(opts.safetyLevel)}
ACTION_COMMAND_SAFETY_REASON="destructive recursive delete"
${opts.capExec ? `SHELLY_CAP_EXEC=${opts.capExec}` : '# SHELLY_CAP_EXEC intentionally left UNSET, matching the legacy-path bug'}
ACTION_DISPATCH_STATUS=""
ACTION_DISPATCH_MESSAGE=""
write_native_notification_request() { return 0; }
request_and_wait_approval() { echo "APPROVAL_CALLED" >> ${JSON.stringify(markerFile)}; return 0; }
cap_workspace_exec() { echo "EXEC_CALLED" >> ${JSON.stringify(markerFile)}; : > "$3"; : > "$4"; return 0; }
run_cli_case() {
${cliCase}
}
run_cli_case
rc=$?
{
  printf '%s\\n' "$ACTION_DISPATCH_STATUS"
  printf '%s\\n' "$ACTION_DISPATCH_MESSAGE"
} > ${JSON.stringify(dispatchStatusFile)}
exit $rc
`;
    fs.writeFileSync(wrapperPath, wrapper, 'utf8');
    let exitCode = 0;
    try {
      execFileSync('bash', [wrapperPath], { stdio: 'pipe' });
    } catch (e: any) {
      exitCode = typeof e.status === 'number' ? e.status : -1;
    }
    const markers = fs.existsSync(markerFile) ? fs.readFileSync(markerFile, 'utf8') : '';
    const [dispatchStatus, dispatchMessage] = fs.existsSync(dispatchStatusFile)
      ? fs.readFileSync(dispatchStatusFile, 'utf8').split('\n')
      : ['', ''];
    return {
      exitCode,
      dispatchStatus: dispatchStatus ?? '',
      dispatchMessage: dispatchMessage ?? '',
      execCalled: markers.includes('EXEC_CALLED'),
      approvalCalled: markers.includes('APPROVAL_CALLED'),
    };
  }

  it('[real-script proof] a CRITICAL cli command is refused and NEVER reaches cap_workspace_exec, even with SHELLY_CAP_EXEC completely unset (the legacy-path bug scenario)', () => {
    const result = runRealCliCase({ safetyLevel: 'CRITICAL' });
    expect(result.exitCode).toBe(1);
    expect(result.dispatchStatus).toBe('error');
    expect(result.dispatchMessage).toContain('CLI action was blocked by command safety');
    expect(result.execCalled).toBe(false);
    expect(result.approvalCalled).toBe(false);
  });

  it('[real-script proof] a CRITICAL cli command is refused even when SHELLY_CAP_EXEC=1 IS set (the newer plan-executor route), matching behavior across both paths', () => {
    const result = runRealCliCase({ safetyLevel: 'CRITICAL', capExec: '1' });
    expect(result.exitCode).toBe(1);
    expect(result.dispatchStatus).toBe('error');
    expect(result.execCalled).toBe(false);
  });

  it('[real-script proof] a non-CRITICAL (e.g. MEDIUM) cli command is UNAFFECTED by the fix and still proceeds to cap_workspace_exec', () => {
    const result = runRealCliCase({ safetyLevel: 'MEDIUM' });
    expect(result.dispatchStatus).not.toBe('error');
    expect(result.execCalled).toBe(true);
  });

  /**
   * Item (b): even under ACTION_APPROVAL_MODE=auto, a cli action whose command
   * is independently classified CRITICAL must still force the write+wait
   * approval round trip instead of being silently auto-skipped. Extracts the
   * REAL request_and_wait_approval() function (not a hand-copied mirror) and
   * runs it with real bash.
   */
  function extractRequestAndWaitApproval(script: string): string {
    const fnMarker = 'request_and_wait_approval() {';
    const fnStart = script.indexOf(fnMarker);
    if (fnStart === -1) throw new Error('request_and_wait_approval function not found in generated script');
    const fnEnd = script.indexOf('\n}', fnStart);
    if (fnEnd === -1) throw new Error('closing brace for request_and_wait_approval not found');
    return script.slice(fnStart, fnEnd + 2);
  }

  function runRequestAndWaitApproval(opts: { approvalMode: 'auto' | 'manual'; approvalType: string; safetyLevel?: string }): string {
    const s = generateRunScript(agent({ action: { type: 'draft' } }));
    const fn = extractRequestAndWaitApproval(s);
    const script = `set -euo pipefail
LOG=""
write_action_approval_request() { LOG="\${LOG}WROTE:$1;"; }
wait_action_approval() { LOG="\${LOG}WAITED:$1;"; return 0; }
${fn}
ACTION_APPROVAL_MODE=${JSON.stringify(opts.approvalMode)}
ACTION_COMMAND_SAFETY_LEVEL=${JSON.stringify(opts.safetyLevel ?? '')}
request_and_wait_approval ${JSON.stringify(opts.approvalType)} x x
echo "$LOG"
`;
    return execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
  }

  it('[real-function proof] auto mode still SKIPS the round trip for an ordinary (non-CRITICAL) cli command', () => {
    expect(runRequestAndWaitApproval({ approvalMode: 'auto', approvalType: 'cli', safetyLevel: 'MEDIUM' })).toBe('');
    expect(runRequestAndWaitApproval({ approvalMode: 'auto', approvalType: 'cli' })).toBe('');
  });

  it('[real-function proof] auto mode FORCES the write+wait round trip for a CRITICAL cli command (new carve-out)', () => {
    expect(runRequestAndWaitApproval({ approvalMode: 'auto', approvalType: 'cli', safetyLevel: 'CRITICAL' })).toBe(
      'WROTE:cli;WAITED:cli;',
    );
  });

  it('[real-function proof] the CRITICAL carve-out is specific to "cli" — draft/notify/webhook are still skipped in auto mode regardless of ACTION_COMMAND_SAFETY_LEVEL (which they never set anyway)', () => {
    for (const t of ['draft', 'notify', 'webhook']) {
      expect(runRequestAndWaitApproval({ approvalMode: 'auto', approvalType: t, safetyLevel: 'CRITICAL' })).toBe('');
    }
  });

  it('[real-function proof] manual mode always writes+waits for cli regardless of safety level (unchanged)', () => {
    expect(runRequestAndWaitApproval({ approvalMode: 'manual', approvalType: 'cli', safetyLevel: 'MEDIUM' })).toBe(
      'WROTE:cli;WAITED:cli;',
    );
  });
});
