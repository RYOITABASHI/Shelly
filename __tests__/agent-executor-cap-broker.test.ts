jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { generateRunScript } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

/** bash -n the script via a temp FILE (a full script exceeds the Windows argv limit for `-c`). */
function bashParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-parse-')), 'run.sh');
  fs.writeFileSync(file, script);
  execFileSync('bash', ['-n', file]);
}

const agent = (tool: ToolChoice, autonomous?: boolean): Agent => ({
  id: 't',
  name: 'T',
  description: '',
  prompt: 'collect the latest news with sources', // needsWeb, but backend is explicit
  schedule: null,
  tool,
  autonomous,
  outputPath: '~/out',
  outputTemplate: null,
  enabled: true,
  lastRun: null,
  lastResult: null,
  createdAt: 0,
  version: 1,
});

// Phase 0 床: the capability broker is a STRANGLER seam gated behind
// SHELLY_CAP_BROKER=1. These assert the wiring is present AND that the legacy
// (flag-off) path is preserved byte-for-byte where it matters — the regression
// gate the spec §1/§8.2 requires.

describe('capability broker wiring — http_post_json seam (CAP/HTTP/SECRET-001)', () => {
  const s = generateRunScript(agent({ type: 'perplexity' }, false));

  it('http_post_json has a flag-gated broker branch that reads the .env itself', () => {
    expect(s).toContain('if [ "${SHELLY_CAP_BROKER:-0}" = "1" ] && node_usable && [ -f "$HOME/.shelly-capability-broker.js" ]; then');
    expect(s).toContain('"$HOME/.shelly-capability-broker.js"');
    expect(s).toContain('--secret-env-file "$ENV_FILE"');
    expect(s).toContain('--auth-ref "${SHELLY_CAP_AUTH_REF:-}"');
    expect(s).toContain('--budget-file "$TMP_DIR/cap-budget-$AGENT_ID.json"');
    expect(s).toContain('--audit-log "$LOG_DIR/agent-driver-audit.jsonl"');
  });

  it('fails closed when the broker is requested but unavailable (no unbrokered send)', () => {
    // Regression: with flag ON but the broker asset missing, the call site set an
    // auth-ref but no raw header; falling through to the legacy path would send an
    // unauthenticated request. http_post_json must refuse instead.
    expect(s).toContain('if [ "${SHELLY_CAP_BROKER:-0}" = "1" ]; then');
    expect(s).toContain('refusing to send unbrokered');
  });

  it('resets the per-run egress budget at run start', () => {
    expect(s).toContain('rm -f "$TMP_DIR/cap-budget-$AGENT_ID.json"');
  });

  it('bumps the script version in lockstep with the native gate', () => {
    expect(s).toContain('SHELLY_AGENT_SCRIPT_VERSION=26');
  });

  // 2026-07-17 follow-up (docs/superpowers/DEFERRED.md "Capability broker
  // Phase 0" mid-run host approval): the broker needs these to offer a human
  // an Allow/Deny for a non-allowlisted host instead of failing closed
  // immediately. Reuses the SAME ACTION_APPROVAL_DIR/REPLY_DIR/TIMEOUT the
  // action-approval flow already declares (no new bash variables).
  it('passes mid-run host-approval context to the broker (nonce/host/run binding)', () => {
    expect(s).toContain('--approval-dir "$ACTION_APPROVAL_DIR" --approval-reply-dir "$ACTION_APPROVAL_REPLY_DIR"');
    expect(s).toContain('--agent-id "$AGENT_ID" --agent-name "$AGENT_NAME" --run-id "$ACTION_RUN_ID"');
    expect(s).toContain('--approval-timeout-seconds "$ACTION_APPROVAL_TIMEOUT_SECONDS"');
  });
});

describe('capability broker wiring — scoped.fs and workspace.exec seams (FS/EXEC-001)', () => {
  it('draft saving routes through scoped.fs when SHELLY_CAP_FS=1 and fails closed if unavailable', () => {
    const s = generateRunScript(agent({ type: 'local' }, false));
    expect(s).toContain('cap_fs_write_file "$SAVED_FILE" "$result_file"');
    expect(s).toContain('cap_fs_write_file "$OBSIDIAN_DEST" "$SAVED_FILE"');
    expect(s).toContain('if [ "${SHELLY_CAP_FS:-0}" = "1" ] && node_usable && [ -f "$HOME/.shelly-capability-broker.js" ]; then');
    expect(s).toContain('--op fs.write --path "$dest" --input-file "$src"');
    expect(s).toContain('Scoped filesystem broker requested but unavailable; refusing unbrokered write.');
  });

  it('cli actions keep in-app approval but execute through workspace.exec when SHELLY_CAP_EXEC=1', () => {
    const s = generateRunScript({
      ...agent({ type: 'local' }, false),
      action: { type: 'cli', command: 'printf ok' },
    } as Agent);
    expect(s).toContain('request_and_wait_approval "cli" "$preview" "$result_file" || return 1');
    expect(s).toContain('if [ "${SHELLY_CAP_EXEC:-0}" = "1" ] && [ "$ACTION_COMMAND_SAFETY_LEVEL" = "CRITICAL" ]; then');
    expect(s).toContain('cap_workspace_exec "$ACTION_COMMAND" "$CLI_EXEC_CWD" "$cli_output" "$cli_error"');
    expect(s).toContain('--op workspace.exec --command-file "$command_file" --cwd "$cwd"');
    expect(s).toContain('workspace.exec broker requested but unavailable; refusing unbrokered exec.');
  });
});

describe('capability broker wiring — secret-by-reference per backend (SECRET-001)', () => {
  it('perplexity: broker mode uses auth-ref; legacy mode keeps the raw Bearer header', () => {
    const s = generateRunScript(agent({ type: 'perplexity' }, false));
    expect(s).toContain('SHELLY_CAP_AUTH_REF=perplexity HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json_retry "https://api.perplexity.ai/chat/completions"');
    // Legacy path preserved (regression gate).
    expect(s).toContain('HTTP_AUTH_HEADER="Bearer $PERPLEXITY_API_KEY" HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json_retry "https://api.perplexity.ai/chat/completions"');
  });

  it('gemini: broker mode uses auth-ref; legacy mode keeps the x-goog-api-key header', () => {
    const s = generateRunScript(agent({ type: 'gemini-api' }, false));
    expect(s).toContain('SHELLY_CAP_AUTH_REF=gemini HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json_retry "https://generativelanguage.googleapis.com');
    expect(s).toContain('HTTP_EXTRA_HEADERS="x-goog-api-key: $GEMINI_API_KEY"');
  });

  it('cerebras / groq: broker mode uses the matching auth-ref; legacy Bearer preserved', () => {
    const cb = generateRunScript(agent({ type: 'cerebras' }, false));
    expect(cb).toContain('SHELLY_CAP_AUTH_REF=cerebras HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json_retry "https://api.cerebras.ai/v1/chat/completions"');
    expect(cb).toContain('HTTP_AUTH_HEADER="Bearer $CEREBRAS_API_KEY"');

    const gq = generateRunScript(agent({ type: 'groq' }, false));
    expect(gq).toContain('SHELLY_CAP_AUTH_REF=groq HTTP_TIMEOUT_SECONDS="$TIMEOUT" http_post_json_retry "https://api.groq.com/openai/v1/chat/completions"');
    expect(gq).toContain('HTTP_AUTH_HEADER="Bearer $GROQ_API_KEY"');
  });

  it('webhook egress is marked pre-approved (its human approval gate already ran)', () => {
    const s = generateRunScript({ ...agent({ type: 'local' }), action: { type: 'webhook', webhookUrl: 'https://hooks.example.com/x' } } as Agent);
    expect(s).toContain('SHELLY_CAP_APPROVED=1 HTTP_TIMEOUT_SECONDS="${WEBHOOK_TIMEOUT_SECONDS:-30}" http_post_json "$ACTION_WEBHOOK_URL"');
  });
});

describe('capability broker wiring — generated shell stays parseable (bash -n)', () => {
  it('every backend script with the new conditionals parses', () => {
    for (const t of ['perplexity', 'gemini-api', 'cerebras', 'groq', 'local'] as const) {
      const s = generateRunScript(agent({ type: t }, false));
      expect(() => bashParses(s)).not.toThrow();
    }
    // webhook action path too
    const wh = generateRunScript({ ...agent({ type: 'local' }), action: { type: 'webhook', webhookUrl: 'https://hooks.example.com/x' } } as Agent);
    expect(() => bashParses(wh)).not.toThrow();
  });
});
