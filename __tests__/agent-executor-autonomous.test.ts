jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import { generateRunScript, selectAutonomousLocalModel, agentUsesStudioContext } from '@/lib/agent-executor';
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

describe('generateRunScript — free-cloud tier backends (Cerebras / Groq, ③b)', () => {
  it('non-autonomous Cerebras/Groq call their OpenAI-compatible endpoints with a Bearer key', () => {
    const cb = generateRunScript(agent({ type: 'cerebras' }, false));
    expect(cb).not.toContain('[REFUSED]');
    expect(cb).toContain('https://api.cerebras.ai/v1/chat/completions');
    expect(cb).toContain('HTTP_AUTH_HEADER="Bearer $CEREBRAS_API_KEY"');
    expect(cb).toContain('MODEL="${CEREBRAS_MODEL:-qwen-3-235b-a22b-instruct-2507}"');
    expect(cb).not.toContain(UNSET); // key-bearing backend keeps its env

    const gq = generateRunScript(agent({ type: 'groq' }, false));
    expect(gq).toContain('https://api.groq.com/openai/v1/chat/completions');
    expect(gq).toContain('HTTP_AUTH_HEADER="Bearer $GROQ_API_KEY"');
    expect(gq).toContain('MODEL="${GROQ_MODEL:-llama-3.3-70b-versatile}"');
  });

  it('refuses autonomous Cerebras/Groq, fail-closed (API-key backend, no key in the autonomous path)', () => {
    for (const t of ['cerebras', 'groq'] as const) {
      const s = generateRunScript(agent({ type: t }, true));
      expect(s).toContain('[REFUSED]');
      expect(s).toContain('SHELLY_AGENT_SCRIPT_VERSION');
      expect(s).not.toContain('api.cerebras.ai');
      expect(s).not.toContain('api.groq.com');
    }
  });

  it('scrubs Cerebras/Groq keys from the env of non-key backends (no cross-backend leak)', () => {
    // A local/oauth run must not carry ANY api key, including the new ones.
    const local = generateRunScript(agent({ type: 'local' }, true));
    expect(local).toContain('unset PERPLEXITY_API_KEY GEMINI_API_KEY CEREBRAS_API_KEY GROQ_API_KEY');
  });

  it('emits parseable shell for the new backends', () => {
    for (const t of ['cerebras', 'groq'] as const) {
      const s = generateRunScript(agent({ type: t }, false));
      expect(() => execFileSync('bash', ['-n', '-c', s])).not.toThrow();
    }
  });
});

describe('generateRunScript — local context window fit (no ctx overflow)', () => {
  it('caps the combined local prompt + injected context and reserves response room', () => {
    const s = generateRunScript(agent({ type: 'local' }));
    // Tier-aware char budget: 8192-window tiers get 16000, the 4096-window 4B/9B
    // tiers get 7000. Small tiers are matched FIRST so "0.8B" (ends in "8B") is
    // not stolen by the *8[bB]* heavy glob.
    expect(s).toContain('*0.8[bB]*|*0-8[bB]*|*1.7[bB]*|*1-7[bB]*|*2[bB]*) LOCAL_PROMPT_MAX_CHARS="${LOCAL_LLM_PROMPT_MAX_CHARS:-16000}"');
    expect(s).toContain('*4[bB]*|*8[bB]*|*9[bB]*) LOCAL_PROMPT_MAX_CHARS="${LOCAL_LLM_PROMPT_MAX_CHARS:-7000}"');
    // Abort-safe truncation: write a regular file then head it (NOT a pipe into
    // head, which would SIGPIPE the producers under pipefail on large context).
    expect(s).toContain('head -c "$LOCAL_PROMPT_MAX_CHARS" "$PROMPT_FILE.full" > "$PROMPT_FILE"');
    expect(s).not.toContain('| head -c "$LOCAL_PROMPT_MAX_CHARS" > "$PROMPT_FILE"');
    // Response reserve lowered so input + output stay inside the window.
    expect(s).toContain('\\"max_tokens\\":2048');
    expect(s).not.toContain('\\"max_tokens\\":4096');
    // Local server starts with a usable context window, not the old tiny default.
    expect(s).toContain("*2b*) printf '8192 4 180");
    expect(s).not.toContain("*2b*) printf '1024 4 180");
  });

  it('the cap construct is abort-safe under pipefail with >64KB context (no SIGPIPE)', () => {
    // Regression for the file-then-truncate fix: piping producers into "head -c"
    // SIGPIPEs them once head closes early (context > ~64KB pipe buffer) → exit
    // 141 → 'set -euo pipefail' aborts the whole run before the fallback. Reading
    // a regular file with head has no producer to signal. Prove the construct
    // survives a 100KB context and yields exactly the capped size.
    const script = [
      'set -euo pipefail',
      "SOURCE_CONTEXT=$(head -c 100000 /dev/zero | tr '\\0' x)",
      'PROMPT_FILE=$(mktemp)',
      'LOCAL_PROMPT_MAX_CHARS=16000',
      `{ printf '%s\\n' 'instruction'; printf '%s\\n' "$SOURCE_CONTEXT"; } > "$PROMPT_FILE.full"`,
      'head -c "$LOCAL_PROMPT_MAX_CHARS" "$PROMPT_FILE.full" > "$PROMPT_FILE"',
      'rm -f "$PROMPT_FILE.full"',
      '[ "$(wc -c < "$PROMPT_FILE")" -eq 16000 ] && echo CAPPED_OK',
      'rm -f "$PROMPT_FILE"',
    ].join('\n');
    expect(execFileSync('bash', ['-c', script]).toString()).toContain('CAPPED_OK');
  });

  it('classifies the local cap by tier without the 0.8B/8B false match', () => {
    const classify = (model: string) =>
      [
        `LOCAL_MODEL='${model}'`,
        'case "$LOCAL_MODEL" in',
        '  *0.8[bB]*|*0-8[bB]*|*1.7[bB]*|*1-7[bB]*|*2[bB]*) echo 16000 ;;',
        '  *4[bB]*|*8[bB]*|*9[bB]*) echo 7000 ;;',
        '  *) echo 16000 ;;',
        'esac',
      ].join('\n');
    const run = (model: string) => execFileSync('bash', ['-c', classify(model)]).toString().trim();
    // Small tiers (8192 window) → 16000. 0.8B must NOT be stolen by *8[bB]*.
    expect(run('Qwen3.5-0.8B-Q4_K_M')).toBe('16000');
    expect(run('Qwen3.5-2B-Q4_K_M')).toBe('16000');
    // Heavy tiers (4096 window) → 7000.
    expect(run('Qwen3.5-4B-Q4_K_M')).toBe('7000');
    expect(run('Qwen3.5-9B-Q4_K_M')).toBe('7000');
  });
});

describe('generateRunScript — studio context only for content-pipeline agents', () => {
  it('agentUsesStudioContext gates on the content pipeline, not general tasks', () => {
    // General ad-hoc @agent task (default output under ~/.shelly/agents) → no studio context.
    expect(agentUsesStudioContext(agent({ type: 'local' }))).toBe(false);
    // The article evaluator is always a content task.
    expect(agentUsesStudioContext({ ...agent({ type: 'ab-article-eval' }), outputPath: '~/out' })).toBe(true);
    // Output landing in the content-studio project / Obsidian vault → content task.
    expect(agentUsesStudioContext({ ...agent({ type: 'local' }), outputPath: '~/projects/shelly-content-studio/drafts/x/foo.md' })).toBe(true);
    expect(agentUsesStudioContext({ ...agent({ type: 'local' }), outputPath: '/sdcard/Documents/ObsidianVault/90_Log/Agent_Output/foo.md' })).toBe(true);
  });

  it('autonomous & scheduled agents keep studio context despite the default outputPath', () => {
    // North Star Mon/Fri agents are autonomous with the default ~/.shelly/agents
    // outputPath (they mirror to Obsidian at save time) — they MUST keep the
    // source-registry dedup context so they avoid duplicate sources.
    expect(agentUsesStudioContext(agent({ type: 'local' }, true))).toBe(true);
    expect(agentUsesStudioContext({ ...agent({ type: 'local' }), schedule: '0 8 * * 1,5' })).toBe(true);
    // But a plain interactive one-shot (schedule:null, not autonomous) stays fast.
    expect(agentUsesStudioContext({ ...agent({ type: 'local' }), schedule: null, autonomous: undefined })).toBe(false);
  });

  it('a general task emits STUDIO_CONTEXT=0 and gates the ~20KB context build', () => {
    const s = generateRunScript(agent({ type: 'local' }));
    expect(s).toContain('STUDIO_CONTEXT=0');
    // The heavy registry/draft/git-log scan must be behind the gate so a trivial
    // "1+1は?" doesn't force the on-device model to prompt-process irrelevant tokens.
    expect(s).toContain('if [ "${STUDIO_CONTEXT:-0}" = "1" ]; then');
    expect(s).toContain('## Local project context');
  });

  it('a content-pipeline task (Obsidian output) emits STUDIO_CONTEXT=1', () => {
    const s = generateRunScript({ ...agent({ type: 'local' }), outputPath: '/sdcard/Documents/ObsidianVault/90_Log/Agent_Output/foo.md' });
    expect(s).toContain('STUDIO_CONTEXT=1');
  });

  it('the gated block is a no-op when STUDIO_CONTEXT=0 (empty SOURCE_CONTEXT, no scan)', () => {
    // Prove the bash gate skips the expensive scan and leaves SOURCE_CONTEXT empty.
    const gatedBlock = [
      'set -euo pipefail',
      'STUDIO_CONTEXT=0',
      'SOURCE_CONTEXT=""',
      'SCANNED=0',
      'if [ "${STUDIO_CONTEXT:-0}" = "1" ]; then',
      '  SCANNED=1',
      '  SOURCE_CONTEXT="heavy context here"',
      'fi',
      'echo "scanned=$SCANNED ctxlen=${#SOURCE_CONTEXT}"',
    ].join('\n');
    expect(execFileSync('bash', ['-c', gatedBlock]).toString().trim()).toBe('scanned=0 ctxlen=0');
  });
});

describe('generateRunScript — readable notification preview (telemetry-stripped)', () => {
  it('strips autonomous driver telemetry from the user-facing preview', () => {
    const s = generateRunScript(agent({ type: 'cli', cli: 'codex' }, true));
    // The notification/draft preview must NOT be the raw head of the result file
    // (which, for the codex driver, begins with `AUDIT {...driver_start...}`).
    expect(s).toContain('clean_result_preview()');
    expect(s).toContain('PREVIEW=$(clean_result_preview "$RESULT_FILE")');
    expect(s).toContain("sed -E '/^(AUDIT|AUDIT_FALLBACK|GATE|C->S|S->C|STDERR|ESCALATE|ESCALATE_RESOLVED) /d'");
  });

  it('threads the friendly agent name into approval + result notifications', () => {
    const named: Agent = { ...agent({ type: 'local' }, true), name: 'Morning Digest' };
    const s = generateRunScript(named, { suppressAction: false });
    expect(s).toContain("AGENT_NAME='Morning Digest'");
    // Both notification payloads carry agentName so the OS card shows a readable
    // name instead of the raw agent id.
    expect(s).toContain('"agentName":"$agent_name_json"');
    // ...and the engine/route label, so the card shows which backend produced
    // the result (route transparency at approval time).
    expect(s).toContain('"toolLabel":"$tool_label_json"');
  });

  it('an approved draft posts ONE completion card (closure) after saving', () => {
    // Standalone draft: approval prompt THEN a success completion after save, so
    // the user gets confirmation instead of a silent finish. (Suppressed steps
    // never reach this branch — ACTION_TYPE routes them to __suppressed__, which
    // returns before any approval/notification; covered by the suppress test.)
    const draft = generateRunScript(agent({ type: 'local' }));
    expect(draft).toMatch(/save_draft_result "\$result_file"\n\s*#[\s\S]*?write_native_notification_request "success" "\$preview" \|\| true/);
  });
});

describe('generateRunScript — local inference quality', () => {
  it('disables Qwen thinking for local runs (direct answer, no token burn / empty content)', () => {
    const s = generateRunScript(agent({ type: 'local' }));
    // A real run had the 2B spend all 2048 tokens in reasoning_content and finish
    // with empty content (finish_reason=length) → no answer + raw-JSON preview.
    expect(s).toContain('\\"chat_template_kwargs\\":{\\"enable_thinking\\":false}');
  });

  it('extract_ai_content falls back to reasoning_content before dumping raw JSON', () => {
    const s = generateRunScript(agent({ type: 'local' }));
    expect(s).toContain('content = data?.choices?.[0]?.message?.reasoning_content;');
    expect(s).toContain('content = data.get("choices", [{}])[0].get("message", {}).get("reasoning_content")');
  });
});

describe('generateRunScript — abort-safe shell (exit 141 root-causes)', () => {
  it('clean_result_preview heads a regular file (no sed|head SIGPIPE abort)', () => {
    const s = generateRunScript(agent({ type: 'local' }));
    // sed | head -c 500 SIGPIPEs sed on any result > 500 bytes (every real answer)
    // → exit 141 under set -euo pipefail. Must filter to a file, then head the file.
    expect(s).toContain('sed -E \'/^(AUDIT|AUDIT_FALLBACK|GATE|C->S|S->C|STDERR|ESCALATE|ESCALATE_RESOLVED) /d\' "$file" 2>/dev/null > "$cleaned"');
    expect(s).toContain('head -c 500 "$cleaned" 2>/dev/null | tr');
    // The OLD sed-piped-into-head form (the SIGPIPE source) must be gone. (A fixed
    // short error string at line ~255 still pipes into head -c 500 — that is safe
    // because its producer never exceeds 500 bytes, so it is not matched here.)
    expect(s).not.toContain('2>/dev/null \\\n    | head -c 500 | tr');
  });

  it('the concurrency check uses find|while, not find -exec sh -c with {} (toybox-safe)', () => {
    const s = generateRunScript(agent({ type: 'local' }));
    expect(s).not.toContain("-exec sh -c 'kill -0 $(cat \"{}\")");
    expect(s).toContain('ACTIVE_COUNT=$({ find "$LOCKS_DIR" -name \'*.pid\' 2>/dev/null || true; } | while IFS= read -r _pidf;');
  });
});

describe('generateRunScript — ③b-2 escalation signalling', () => {
  it('a non-final escalation attempt fails silently (gated error notification)', () => {
    const silent = generateRunScript(agent({ type: 'local' }), { suppressErrorNotification: true });
    expect(silent).toContain('SUPPRESS_ERROR_NOTIFICATION=1');
    expect(silent).toContain('if [ "${SUPPRESS_ERROR_NOTIFICATION:-0}" != "1" ]; then');
    const loud = generateRunScript(agent({ type: 'local' }));
    expect(loud).toContain('SUPPRESS_ERROR_NOTIFICATION=0');
  });

  it('a failed local attempt signals BACKEND_ERROR (so the ladder climbs, no fake-success digest)', () => {
    const s = generateRunScript(agent({ type: 'local' }));
    // Both local failure paths (server cannot start / http error) mark the run as
    // an error via BACKEND_ERROR_FILE so attemptFailed() escalates instead of
    // dispatching the action on a context digest.
    expect(s).toContain('local_context_fallback "local llm start failed: $START_REASON" > "$RESULT_FILE"\n\t\t  touch "$BACKEND_ERROR_FILE"');
    expect(s).toMatch(/local_context_fallback "http exit=[\s\S]*?> "\$RESULT_FILE"\n\t\t    touch "\$BACKEND_ERROR_FILE"/);
  });
});

describe('generateRunScript — orchestration suppressAction (Phase 4)', () => {
  it('non-final steps suppress the action (one notification per chain, not per step)', () => {
    const suppressed = generateRunScript(agent({ type: 'local' }), { suppressAction: true });
    expect(suppressed).toContain('ACTION_TYPE=\'__suppressed__\'');
    expect(suppressed).toContain('__suppressed__)'); // the no-approval/no-notify case
    // a normal run still drafts/notifies.
    const normal = generateRunScript(agent({ type: 'local' }));
    expect(normal).not.toContain("ACTION_TYPE='__suppressed__'");
  });
});

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
