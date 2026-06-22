jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import { generateRunScript, selectAutonomousLocalModel } from '@/lib/agent-executor';
import { Agent, ToolChoice } from '@/store/types';

const agent = (tool: ToolChoice, autonomous?: boolean): Agent => ({
  id: 't',
  name: 'T',
  description: '',
  prompt: 'hi',
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

const UNSET = 'unset PERPLEXITY_API_KEY GEMINI_API_KEY';

describe('generateRunScript — autonomous tool resolution (Spec A §4/§5)', () => {
  it('resolves autonomous auto → codex (OAuth), key-free env', () => {
    const s = generateRunScript(agent({ type: 'auto' }, true));
    expect(s).toContain('SHELLY_AGENT_SCRIPT_VERSION=8');
    expect(s).toContain('.shelly-agent-driver.js'); // resolved to cli/codex via the approval driver
    expect(s).toContain('--prompt-file "$PROMPT_FILE"');
    expect(s).toContain('if node_usable && [ -f "$HOME/.shelly-agent-driver.js" ]; then');
    expect(s).toContain('shelly_run_app_binary()');
    expect(s).toContain('shelly_timeout_app_binary()');
    expect(s).toContain('shelly_node()');
    expect(s).toContain('shelly_curl()');
    expect(s).toContain('shelly_timeout_app_binary "$TIMEOUT" node "$HOME/.shelly-agent-driver.js"');
    expect(s).toContain('/system/bin/linker64 "$binary" "$@"');
    expect(s).not.toContain('timeout "$TIMEOUT" node');
    expect(s).not.toContain('command -v node >/dev/null');
    expect(s).toContain(UNSET); // codex path → keys scrubbed
    expect(s).not.toContain('[REFUSED]');
  });

  it('does not depend on python3 for JSON helper escaping before the driver path', () => {
    const s = generateRunScript(agent({ type: 'auto' }, true));
    expect(s).toContain('node_usable()');
    expect(s).toContain('json_escape_text()');
    expect(s).toContain('json_string_file()');
    expect(s).not.toContain("python3 -c 'import json");
    expect(s).not.toContain('python3 -c "import json');
    expect(s).not.toContain("sed 's/\\\\/\\\\\\\\/g; s/\"/\\\\\"/g'");
  });

  it('routes generated node helpers through Shelly linker64 wrappers', () => {
    const s = generateRunScript(agent({ type: 'local' }, true));
    expect(s).toContain('shelly_node - "$url" "$body_file"');
    expect(s).toContain('HTTP_TIMEOUT_SECONDS="$timeout_seconds" shelly_node - "$url"');
    expect(s).toContain('shelly_node - "$url" "$out_file"');
    expect(s).toContain('shelly_node - > "$TMP_DIR/llama-server-url-$AGENT_ID.txt"');
    expect(s).toContain('if shelly_node - "$file"');
    expect(s).toContain('local_llm_start_idle_watcher');
    expect(s).toContain('SHELLY_AGENT_LOCAL_MODEL:-Qwen3.5-0.8B-Q4_K_M');
    expect(s).toContain('if ! ensure_local_llm_server "$LOCAL_URL" "$LOCAL_MODEL"; then');
    expect(s).toContain('local_llm_start_activity_heartbeat 10');
    expect(s).toContain('local_llm_stop_activity_heartbeat');
    expect(s).toContain('llama-server.active');
    expect(s).toContain('active_count="$(find "$active_dir" -type f -name');
    expect(s).toContain('id === expected');
    expect(s).not.toContain('id.includes(expected)');
    expect(s).not.toContain('expected.includes(id)');
    expect(s).toContain('--alias "$alias_name"');
    expect(s).not.toContain('ensure_local_llm_server "$LOCAL_URL" "$LOCAL_MODEL" || true');
    expect(s).not.toContain('HEARTBEAT_PID="$(local_llm_start_activity_heartbeat 10)"');
    expect(s).toContain('exec /system/bin/linker64 "$installed_binary" "\\$@"');
    expect(s).toContain('exec "$installed_binary" "\\$@"');
    expect(s).not.toContain('exec /system/bin/linker64 "$installed_binary" "$@"');
    expect(s).not.toContain('LOCAL_LLM_MODEL:-Qwen3.5-0.8B-Q4_K_M');
    expect(s).not.toContain(' node - "$url"');
    expect(s).not.toContain(' node - "$file"');
    expect(s).not.toContain(' command -v node');
  });

  it('emits shell that parses after wrapper and fallback changes', () => {
    for (const s of [
      generateRunScript(agent({ type: 'auto' }, true)),
      generateRunScript(agent({ type: 'local' }, true)),
      generateRunScript(agent({ type: 'perplexity' }, true)),
    ]) {
      expect(() => execFileSync('bash', ['-n', '-c', s])).not.toThrow();
    }
  });

  it('refuses an autonomous api-key backend (perplexity), fail-closed', () => {
    const s = generateRunScript(agent({ type: 'perplexity' }, true));
    expect(s).toContain('[REFUSED]');
    expect(s).toContain('exit 1');
    expect(s).not.toContain('api.perplexity.ai'); // never builds the perplexity call
    // The refusal MUST carry the script-version line, or AgentRuntime rejects it
    // as "stale" (exit 126) and the [REFUSED] body never runs / never records.
    expect(s).toContain('SHELLY_AGENT_SCRIPT_VERSION');
  });

  it('refuses an autonomous gemini backend', () => {
    expect(generateRunScript(agent({ type: 'gemini-api' }, true))).toContain('[REFUSED]');
  });

  it('allows autonomous cli/local/ab-article-eval (oauth/local, no key) normally', () => {
    const cli = generateRunScript(agent({ type: 'cli', cli: 'codex' }, true));
    expect(cli).not.toContain('[REFUSED]');
    expect(cli).toContain('.shelly-agent-driver.js');
    expect(cli).toContain(UNSET); // oauth path → keys scrubbed
    expect(generateRunScript(agent({ type: 'local' }, true))).not.toContain('[REFUSED]');
    expect(generateRunScript(agent({ type: 'ab-article-eval' }, true))).not.toContain('[REFUSED]');
  });

  it('selects a light local model for simple autonomous local work and 2B for heavier text work', () => {
    expect(selectAutonomousLocalModel('short classify this')).toBe('Qwen3.5-0.8B-Q4_K_M');
    expect(selectAutonomousLocalModel('この記事を比較して下書きにして')).toBe('Qwen3.5-2B-Q4_K_M');
    expect(selectAutonomousLocalModel('高品質に推敲して')).toBe('Qwen3.5-4B-Q4_K_M');
  });

  it('leaves NON-autonomous agents unchanged (perplexity still runs, keys kept)', () => {
    const s = generateRunScript(agent({ type: 'perplexity' }, false));
    expect(s).not.toContain('[REFUSED]');
    expect(s).not.toContain(UNSET); // key-bearing backend keeps its env
    const sDefault = generateRunScript(agent({ type: 'perplexity' })); // autonomous undefined
    expect(sDefault).not.toContain('[REFUSED]');
  });

  it('gates /sdcard audit mirroring behind an explicit env flag for autonomous cli runs', () => {
    const s = generateRunScript(agent({ type: 'auto' }, true));
    expect(s).toContain('AUDIT_MIRROR_SDCARD_ELIGIBLE=1');
    expect(s).toContain('SHELLY_AGENT_AUDIT_MIRROR_SDCARD');
    expect(s).toContain('case "${SHELLY_AGENT_AUDIT_MIRROR_SDCARD:-}" in');
    expect(s).toContain('cp "$audit_file" "/sdcard/b2-autonomous-audit-$AGENT_ID.jsonl" 2>/dev/null || true');

    const nonAutonomousCli = generateRunScript(agent({ type: 'cli', cli: 'codex' }, false));
    expect(nonAutonomousCli).toContain('AUDIT_MIRROR_SDCARD_ELIGIBLE=0');
  });

  it('persists driver audit before one-shot cleanup can remove the log dir', () => {
    const s = generateRunScript(agent({ type: 'auto' }, true));
    expect(s).toContain('FINISH_RAN=0');
    expect(s).toContain('code="${1:-$?}"');
    expect(s).toContain('trap - EXIT');
    expect(s).toContain('--audit-log "$LOG_DIR/agent-driver-audit.jsonl"');
    expect(s).toContain('mirror_driver_audit_to_app_private || true\n  mirror_driver_audit_to_sdcard || true\nelse');
    expect(s).toContain('rm -f "$RESULT_FILE" "$BACKEND_ERROR_FILE"\nfinish 0');
  });

  it('dispatches saved results by action without auto-running cli actions', () => {
    const notifyAgent: Agent = { ...agent({ type: 'local' }, true), action: { type: 'notify' } };
    const webhookAgent: Agent = {
      ...agent({ type: 'local' }, true),
      action: { type: 'webhook', webhookUrl: 'https://example.com/hook' },
    };
    const cliAgent: Agent = {
      ...agent({ type: 'local' }, true),
      action: { type: 'cli', command: 'rm -rf ~/tmp/example' },
    };

    const notify = generateRunScript(notifyAgent);
    expect(notify).toContain("ACTION_TYPE='notify'");
    expect(notify).toContain('native-result-notification.json');
    expect(notify).toContain('write_action_approval_request "notify" "$preview" "$result_file"');
    expect(notify).toContain('wait_action_approval "notify" || return 1');
    expect(notify).toContain('write_native_notification_request "success" "$preview"');

    const webhook = generateRunScript(webhookAgent);
    expect(webhook).toContain("ACTION_TYPE='webhook'");
    expect(webhook).toContain("ACTION_WEBHOOK_URL='https://example.com/hook'");
    expect(webhook).toContain('Webhook action requires an https URL.');
    expect(webhook).toContain('write_action_approval_request "webhook" "$preview" "$result_file" "$webhook_host" "$webhook_payload"');
    expect(webhook).toContain('wait_action_approval "webhook" || return 1');
    expect(webhook).toContain('http_post_json "$ACTION_WEBHOOK_URL" "$webhook_payload"');
    expect(webhook).toContain('write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true');

    const cli = generateRunScript(cliAgent);
    expect(cli).toContain("ACTION_TYPE='cli'");
    expect(cli).toContain("ACTION_COMMAND='rm -rf ~/tmp/example'");
    expect(cli).toContain("ACTION_COMMAND_SAFETY_LEVEL='HIGH'");
    expect(cli).toContain('write_action_approval_request "cli" "$preview" "$result_file"');
    expect(cli).toContain('wait_action_approval "cli" || return 1');
    expect(cli).toContain('bash -lc "$ACTION_COMMAND" > "$cli_output" 2>&1');
    expect(cli).not.toContain('eval "$ACTION_COMMAND"');
  });
});
