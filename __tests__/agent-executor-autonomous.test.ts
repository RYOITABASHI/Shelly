jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateRunScript, selectAutonomousLocalModel, agentUsesStudioContext, computeAgentSlug, sanitizeOutputTemplate } from '@/lib/agent-executor';
import { MAX_RESULT_CARRY_CHARS } from '@/lib/agent-orchestration';
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

  it('autonomous & scheduled NEWS-collection agents stay lean (no studio-context pollution)', () => {
    // Regression: injecting ~30–50KB of content-studio context into a cloud
    // news-collection request blew the model token budget and escalated
    // Gemini→Codex. A collection task must NOT get studio context just because
    // it is autonomous/scheduled.
    expect(agentUsesStudioContext({ ...agent({ type: 'local' }, true), prompt: 'ニュースを集めて' })).toBe(false);
    expect(agentUsesStudioContext({ ...agent({ type: 'local' }), schedule: '0 8 * * 1,5', prompt: '最新ニュースを集めて' })).toBe(false);
    // Content-DRAFTING tasks DO get the context (AI_CONTEXT + recent drafts + dedup).
    expect(agentUsesStudioContext({ ...agent({ type: 'local' }, true), prompt: 'この件で記事を書いて' })).toBe(true);
    expect(agentUsesStudioContext({ ...agent({ type: 'local' }), prompt: 'draft a blog post' })).toBe(true);
  });

  it('a general collection agent uses the global output destination (clean, findable)', () => {
    const s = generateRunScript({ ...agent({ type: 'local' }), prompt: 'ニュースを集めて' });
    // Non-studio → honour the global target with a clean date-folder layout.
    expect(s).toContain('USE_GLOBAL_OUTPUT=1');
    expect(s).toContain('case "${SHELLY_AGENT_OUTPUT_TARGET:-local}" in');
    expect(s).toContain('OUT_BASE="${OBSIDIAN_VAULT_PATH:-/sdcard/Documents/ObsidianVault}"');
    expect(s).toContain('OUT_BASE="${SHELLY_AGENT_CUSTOM_PATH:-$HOME/agent-output}"');
    // Default local lands in a findable folder, NOT the buried ~/.shelly/.../output.md.
    expect(s).toContain('OUT_BASE="$HOME/agent-output"');
    // Filename: {date}_{title}.md (readable slug), under a {date} subfolder.
    expect(s).toContain('SAVED_FILE="$OUT_BASE/$DATE/${DATE}_$SLUG.md"');
    expect(s).toContain('[ -n "${SHELLY_AGENT_TOPIC_FOLDER:-}" ] && OUT_BASE="$OUT_BASE/$SHELLY_AGENT_TOPIC_FOLDER"');
  });

  it('a content-studio agent keeps its explicit path (global output NOT applied)', () => {
    const s = generateRunScript(agent({ type: 'ab-article-eval' }));
    expect(s).toContain('USE_GLOBAL_OUTPUT=0');
    // Studio path: existing template + keyword Obsidian routing remain.
    expect(s).toContain('SAVED_FILE="$OUTPUT_DIR/$REL_NAME"');
    expect(s).toContain('OBSIDIAN_TARGET="90_Log/Agent_Output"');
  });

  it('emits parseable shell with the global-output branch', () => {
    const s = generateRunScript({ ...agent({ type: 'local' }), prompt: 'ニュースを集めて' });
    expect(() => execFileSync('bash', ['-n', '-c', s])).not.toThrow();
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

describe('N2 — autonomous agents auto-approve the draft→vault save', () => {
  it('autonomous agent emits AGENT_AUTONOMOUS=1 and gates the draft approval on it', () => {
    const s = generateRunScript(agent({ type: 'local' }, true));
    expect(s).toContain('AGENT_AUTONOMOUS=1');
    // The approval request/wait for a draft is now behind the non-autonomous gate.
    expect(s).toContain('if [ "${AGENT_AUTONOMOUS:-0}" != "1" ]; then');
    expect(s).toContain('request_and_wait_approval "draft" "$preview" "$result_file" || return 1');
  });

  it('a manual (non-autonomous) agent still requires the draft confirm card', () => {
    const s = generateRunScript(agent({ type: 'local' }));
    expect(s).toContain('AGENT_AUTONOMOUS=0');
  });

  it('the gate skips the approval wait only when autonomous (bash)', () => {
    const run = (autonomous: string) =>
      execFileSync('bash', ['-c', [
        'set -euo pipefail',
        `AGENT_AUTONOMOUS=${autonomous}`,
        'step=autoapprove',
        'if [ "${AGENT_AUTONOMOUS:-0}" != "1" ]; then step=waited; fi',
        'echo "$step"',
      ].join('\n')]).toString().trim();
    expect(run('1')).toBe('autoapprove'); // autonomous → no approval wait
    expect(run('0')).toBe('waited');      // manual → confirm card
  });
});

describe('dated-folder output template (N4)', () => {
  it('computeAgentSlug preserves CJK and falls back to the id when empty', () => {
    // Regression: a pure-Japanese name slugged to "" → "2026-06-24-.md".
    expect(computeAgentSlug('まずニュース 集めて 保存', 'agent-x')).toBe('まずニュース-集めて-保存');
    expect(computeAgentSlug('!!!（）', 'agent-x')).toBe('agent-x');
    expect(computeAgentSlug('My Weekly Report', 'id')).toBe('my-weekly-report');
    expect(computeAgentSlug('', 'agent-fallback')).toBe('agent-fallback');
  });

  it('sanitizeOutputTemplate defaults, keeps date-folders, and blocks traversal', () => {
    expect(sanitizeOutputTemplate(null)).toBe('{date}-{slug}');
    expect(sanitizeOutputTemplate('  ')).toBe('{date}-{slug}');
    expect(sanitizeOutputTemplate('{date}/{slug}.md')).toBe('{date}/{slug}.md');
    // No absolute paths, no parent-dir escape out of the output dir.
    expect(sanitizeOutputTemplate('/abs/{slug}')).toBe('abs/{slug}');
    expect(sanitizeOutputTemplate('../../etc/{slug}')).toBe('etc/{slug}');
  });

  it('the generated save uses the template (placeholder substitution + scoped write)', () => {
    const s = generateRunScript(agent({ type: 'local' }));
    expect(s).toContain('OUTPUT_NAME_TEMPLATE=');
    expect(s).toContain('s|{date}|$DATE|g');
    expect(s).toContain('s|{slug}|$SLUG|g');
    expect(s).toContain('cap_fs_write_file "$SAVED_FILE" "$result_file"');
    // The old hardcoded flat name is gone.
    expect(s).not.toContain('SAVED_FILE="$OUTPUT_DIR/$DATE-$SLUG.md"');
  });

  it('a date-folder template resolves to <date>/<slug>.md at run time (bash)', () => {
    const script = [
      'set -euo pipefail',
      'OUTPUT_NAME_TEMPLATE="{date}/{slug}"',
      'DATE=2026-06-24',
      'TIME=080000',
      'SLUG=news-digest',
      'REL_NAME=$(printf \'%s\' "$OUTPUT_NAME_TEMPLATE" | sed -e "s|{date}|$DATE|g" -e "s|{slug}|$SLUG|g" -e "s|{time}|$TIME|g")',
      'case "$REL_NAME" in *.md|*.markdown|*.txt) ;; *) REL_NAME="$REL_NAME.md" ;; esac',
      'echo "$REL_NAME"',
    ].join('\n');
    expect(execFileSync('bash', ['-c', script]).toString().trim()).toBe('2026-06-24/news-digest.md');
  });
});

describe('generateRunScript — Gemini Google Search grounding for web tasks', () => {
  it('adds google_search grounding ONLY for a web-mandatory general task', () => {
    const web = generateRunScript({ ...agent({ type: 'gemini-api' }), prompt: 'ニュースを集めて' });
    expect(web).toContain('\\"tools\\":[{\\"google_search\\":{}}]');

    const plain = generateRunScript({ ...agent({ type: 'gemini-api' }), prompt: 'say hello' });
    expect(plain).not.toContain('google_search');
  });

  it('gives the Gemini call an 8192 output budget (2.5-flash thinking + grounding needs room)', () => {
    // Regression: maxOutputTokens:4096 let gemini-2.5-flash's thinking exhaust the
    // budget on a grounded query → empty content → BACKEND_ERROR → needless Codex
    // escalation. The standalone probe worked because it used the 8192 default.
    const s = generateRunScript({ ...agent({ type: 'gemini-api' }), prompt: 'ニュースを集めて' });
    expect(s).toContain('\\"maxOutputTokens\\":8192');
    expect(s).not.toContain('\\"maxOutputTokens\\":4096');
  });

  it('migrates a stale gemini-2.0-flash pin (free tier limit:0) to 2.5-flash at runtime', () => {
    const s = generateRunScript(agent({ type: 'gemini-api' }));
    expect(s).toContain('case "$MODEL" in gemini-2.0-flash|gemini-2.0-flash-001|gemini-2.0-flash-exp) MODEL="gemini-2.5-flash" ;; esac');
  });
});

describe('generateRunScript — collection contract + no-source guard (North Star)', () => {
  it('prepends an execute-and-list contract for a web-research task (all backends)', () => {
    const tools: ToolChoice[] = [
      { type: 'perplexity' },
      { type: 'gemini-api' },
      { type: 'local' },
      { type: 'cli', cli: 'codex' },
    ];
    for (const tool of tools) {
      const s = generateRunScript({ ...agent(tool, tool.type === 'cli'), prompt: '最新ニュースを集めて' });
      expect(s).toContain('research-collection agent');
      expect(s).toContain('[title](primary_source_url)');
      expect(s).toContain('do NOT describe, design, or plan a workflow');
    }
  });

  it('(A) forces Japanese output for a Japanese web task, not for an English one', () => {
    const ja = generateRunScript({ ...agent({ type: 'perplexity' }), prompt: 'STEAM×AIの最新論文を集めて' });
    expect(ja).toContain('OUTPUT LANGUAGE (REQUIRED)');
    expect(ja).toContain('日本語');

    const en = generateRunScript({ ...agent({ type: 'perplexity' }), prompt: 'collect the latest STEAM×AI papers' });
    expect(en).not.toContain('OUTPUT LANGUAGE (REQUIRED)');
  });

  it('leaves a non-web task untouched (no contract → no behavioural change)', () => {
    const s = generateRunScript({ ...agent({ type: 'local' }), prompt: 'say hello' });
    expect(s).not.toContain('research-collection agent');
    expect(s).not.toContain('primary_source_url');
  });

  it('marks a sourceless web result as a soft failure so the run escalates', () => {
    const web = generateRunScript({ ...agent({ type: 'perplexity' }), prompt: '最新ニュースを集めて' });
    // The guard fires only for web tasks, keys off a missing URL, and sets the
    // backend-error flag the escalation ladder reads.
    expect(web).toContain("! grep -qE 'https?://' \"$RESULT_CONTENT_FILE\"");
    expect(web).toContain('touch "$BACKEND_ERROR_FILE"');

    const plain = generateRunScript({ ...agent({ type: 'local' }), prompt: 'say hello' });
    expect(plain).not.toContain("! grep -qE 'https?://' \"$RESULT_CONTENT_FILE\"");
  });
});

describe('generateRunScript — readable notification preview (telemetry-stripped)', () => {
  it('strips autonomous driver telemetry from the user-facing preview', () => {
    const s = generateRunScript(agent({ type: 'cli', cli: 'codex' }, true));
    // The notification/draft preview must NOT be the raw head of the result file
    // (which, for the codex driver, begins with `AUDIT {...driver_start...}`).
    expect(s).toContain('clean_result_preview()');
    // Codex-driver steps route the preview through result_preview(), which
    // reads the driver's dedicated $RESULT_FILE.answer (bypassing the
    // telemetry-prefix filter entirely for real answer text) and only falls
    // back to clean_result_preview()'s telemetry-stripping for protocol/
    // runtime failures with no usable answer file — see result_preview()'s
    // own definition, still built on clean_result_preview() below.
    expect(s).toContain('PREVIEW=$(result_preview "$RESULT_FILE")');
    expect(s).toContain('clean_answer_preview() {');
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
    // sed | head -c N SIGPIPEs sed on any result > N bytes (every real answer)
    // → exit 141 under set -euo pipefail. Must filter to a file, then head the file.
    expect(s).toContain('sed -E \'/^(AUDIT|AUDIT_FALLBACK|GATE|C->S|S->C|STDERR|ESCALATE|ESCALATE_RESOLVED) /d\' "$file" 2>/dev/null > "$cleaned"');
    // SECRET-001: redact_secrets_text now runs against the $cleaned FILE (still
    // file-not-pipe, same abort-safety) BEFORE the head, and head reads ITS
    // output file ($redacted) rather than $cleaned directly.
    expect(s).toContain('redact_secrets_text "$cleaned" > "$redacted" 2>/dev/null');
    // 2026-07-15 P1 audit fix: the truncation budget is imported from
    // lib/agent-orchestration.ts's MAX_RESULT_CARRY_CHARS (1500), not a
    // separately-hardcoded 500 — see __tests__/agent-result-preview-carry.test.ts
    // for the dedicated regression coverage of this budget.
    expect(s).toContain(`head -c ${MAX_RESULT_CARRY_CHARS} "$redacted" 2>/dev/null | tr`);
    // The OLD sed-piped-into-head form (the SIGPIPE source) must be gone. (A fixed
    // short error string at line ~255 still pipes into head -c 500 — that is safe
    // because its producer never exceeds 500 bytes, so it is not matched here.)
    expect(s).not.toContain('2>/dev/null \\\n    | head -c 500 | tr');
  });

  it('redact_secrets_text mirrors PlanSpec REDACT_PATTERNS and stays file-based (no stdin-pipe SIGPIPE)', () => {
    const s = generateRunScript(agent({ type: 'local' }));
    expect(s).toContain("redact_secrets_text() {");
    // Takes a file path (process.argv[2]), never stdin — a heredoc already owns
    // fd0 for the node script source itself, so reading real data from stdin
    // too would silently read empty/garbage.
    expect(s).toContain("const file = process.argv[2];");
    expect(s).toContain('try { data = fs.readFileSync(file, \'utf8\'); } catch (_) {}');
    // Same secret classes as scripts/shelly-plan-executor.js's REDACT_PATTERNS.
    expect(s).toContain('/\\bsk-ant-[A-Za-z0-9_-]{20,}\\b/g');
    expect(s).toContain('/\\bAIza[0-9A-Za-z_-]{25,}\\b/g');
    expect(s).toContain('/\\bBearer\\s+[A-Za-z0-9._~+/=-]{16,}\\b/gi');
    // Non-node fallback still redacts (best-effort) instead of silently passing
    // raw secrets through when node is unavailable.
    expect(s).toContain("sed -E \\");
    expect(s).toContain("-e 's/sk-ant-[A-Za-z0-9_-]{20,}/<redacted>/g'");
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
    expect(s).toContain('SHELLY_AGENT_SCRIPT_VERSION=22');
    expect(s).toContain('.shelly-agent-driver.js'); // resolved to cli/codex via the approval driver
    expect(s).toContain('--prompt-file "$PROMPT_FILE"');
    expect(s).toContain('if node_usable && [ -f "$HOME/.shelly-agent-driver.js" ]; then');
    expect(s).toContain('shelly_run_app_binary()');
    expect(s).toContain('shelly_timeout_app_binary()');
    expect(s).toContain('shelly_node()');
    expect(s).toContain('shelly_curl()');
    expect(s).toContain('shelly_timeout_app_binary "$TIMEOUT" node "$HOME/.shelly-agent-driver.js"');
    expect(s).toContain('--answer-file "$RESULT_FILE.answer"');
    expect(s).toContain('RESULT_CONTENT_FILE="$RESULT_FILE.answer"');
    expect(s).toContain('RESULT_CONTENT_IS_DRIVER_ANSWER=1');
    expect(s).toContain('clean_answer_preview "$RESULT_CONTENT_FILE"');
    expect(s).toContain('dispatch_agent_action "$RESULT_CONTENT_FILE" "$PREVIEW"');
    expect(s).toContain('Codex produced no answer text for this step.');
    expect(s).toContain('touch "$BACKEND_ERROR_FILE"');
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

  it('N1: autonomous gemini on a web-mandatory task is allowed WITH consent (grounded)', () => {
    const s = generateRunScript({ ...agent({ type: 'gemini-api' }, true), prompt: 'ニュースを集めて' }, { autonomousCloudConsent: true });
    expect(s).not.toContain('[REFUSED]');
    expect(s).toContain('google_search'); // grounded web call
  });

  it('N1: still refuses autonomous gemini WITHOUT consent (fail-closed)', () => {
    const s = generateRunScript({ ...agent({ type: 'gemini-api' }, true), prompt: 'ニュースを集めて' });
    expect(s).toContain('[REFUSED]');
  });

  it('N1: consent does NOT allow autonomous gemini on a non-web task', () => {
    const s = generateRunScript({ ...agent({ type: 'gemini-api' }, true), prompt: '要約して' }, { autonomousCloudConsent: true });
    expect(s).toContain('[REFUSED]');
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

  it('passes the agent autonomy policy to the B2 driver (configured level is honored, not silently L2)', () => {
    // Regression (control-plane review): buildAgentPolicy existed but the driver
    // launch never received --policy-json, so a configured L1/L3 agent silently
    // ran at the driver's default L2. The policy is passed inline (never a file the
    // agent can read) to preserve the §6 invariant.
    const l1 = generateRunScript({ ...agent({ type: 'cli', cli: 'codex' }, true), autonomyLevel: 'L1' });
    expect(l1).toContain('--policy-json');
    expect(l1).toContain('"level":"L1"');
    const l3 = generateRunScript({ ...agent({ type: 'cli', cli: 'codex' }, true), autonomyLevel: 'L3' });
    expect(l3).toContain('"level":"L3"');
    // Default (no level set) still resolves to L2 via buildAgentPolicy.
    expect(generateRunScript(agent({ type: 'cli', cli: 'codex' }, true))).toContain('"level":"L2"');
  });

  it('wires agent.workspaceRoot through to the B2 driver --cwd (DEFERRED.md #2 残り)', () => {
    // Regression: DRIVER_CWD was hardcoded to $PROJECT_DIR (content-studio default)
    // and never read agent.workspaceRoot, so an agent configured with a separate
    // workspace still ran the driver — and therefore the AutonomyPolicy boundary
    // gate, which re-anchors workspaceRoot to whatever --cwd it receives
    // (scripts/shelly-agent-driver.js: `policy.workspaceRoot = cwd`) — against
    // content-studio instead of its own workspace.
    const withRoot = generateRunScript({
      ...agent({ type: 'cli', cli: 'codex' }, true),
      workspaceRoot: '/home/shelly-test/projects/my-workspace',
    });
    expect(withRoot).toContain("AGENT_WORKSPACE_ROOT='/home/shelly-test/projects/my-workspace'");
    expect(withRoot).toContain('DRIVER_CWD="${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"');
    expect(withRoot).toContain('--cwd "$DRIVER_CWD"');
  });

  it('leaves DRIVER_CWD unchanged (falls through to $PROJECT_DIR) when workspaceRoot is unset (no regression)', () => {
    const withoutRoot = generateRunScript(agent({ type: 'cli', cli: 'codex' }, true));
    expect(withoutRoot).toContain("AGENT_WORKSPACE_ROOT=''");
    expect(withoutRoot).toContain('DRIVER_CWD="${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"');
    // Prove the actual bash semantics: an empty AGENT_WORKSPACE_ROOT falls
    // through to $PROJECT_DIR exactly like an unset one (bash `:-` triggers on
    // empty-or-unset), so today's no-workspace-root behavior is unchanged.
    const resolved = execFileSync('bash', ['-c', [
      'PROJECT_DIR="/content/studio"',
      'AGENT_WORKSPACE_ROOT=""',
      'DRIVER_CWD="${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"',
      'printf %s "$DRIVER_CWD"',
    ].join('\n')]).toString();
    expect(resolved).toBe('/content/studio');
    // And when set, the workspace root wins.
    const resolvedWithRoot = execFileSync('bash', ['-c', [
      'PROJECT_DIR="/content/studio"',
      'AGENT_WORKSPACE_ROOT="/my/workspace"',
      'DRIVER_CWD="${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"',
      'printf %s "$DRIVER_CWD"',
    ].join('\n')]).toString();
    expect(resolvedWithRoot).toBe('/my/workspace');
  });

  it('applies the workspaceRoot → --cwd wiring on every codexDriverCommand call site (primary cli, auto fallback, baked web→Codex ladder)', () => {
    // The `auto` arm (resolves to the driver-fallback path) and the baked
    // web→Codex ladder both route through the SAME codexDriverCommand, so the
    // AGENT_WORKSPACE_ROOT variable (baked once, script-scope) covers them too.
    const auto = generateRunScript({ ...agent({ type: 'auto' }, true), workspaceRoot: '/ws' });
    expect(auto).toContain("AGENT_WORKSPACE_ROOT='/ws'");
    expect(auto).toContain('DRIVER_CWD="${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"');
  });

  it('scopes libexec_wrapper.so LD_PRELOAD to git only, mirroring the interactive git() fix (DEFERRED.md HTTPS git gap)', () => {
    // The interactive PTY's git() (HomeInitializer.kt, commit 0981cd6d5,
    // BASHRC_VERSION 230) preloads libexec_wrapper.so so git's child
    // git-remote-https execve is routed through linker64 instead of hitting the
    // app_data_file exec denial. The autonomous agent runtime had no equivalent —
    // this proves the generated script now defines one and never sets LD_PRELOAD
    // globally (only inside the scoped shelly_git wrapper).
    const s = generateRunScript(agent({ type: 'local' }, true));
    expect(s).toContain('shelly_git() {');
    expect(s).toContain('LD_PRELOAD="$git_lib_dir/libexec_wrapper.so"');
    expect(s).toContain('shelly_git -C "$repo" log --oneline -8 2>/dev/null || true');
    expect(s).toContain('shelly_git -C "$repo" status --short 2>/dev/null || true');
    // Never a bare, unscoped `git` call left for the content-studio context
    // collector (the only baked git invocation site today) — must not match
    // "shelly_git", hence the negative lookbehind rather than a plain
    // .not.toContain (which would false-negative: "shelly_git -C ..." itself
    // contains the substring "git -C ...").
    expect(s).not.toMatch(/(?<!shelly_)git -C "\$repo" log --oneline -8/);
    expect(s).not.toMatch(/(?<!shelly_)git -C "\$repo" status --short/);
    // LD_PRELOAD is only ever set inside shelly_git/the llama-server launchers
    // (which explicitly unset it) — never exported as a bare global assignment
    // that every subsequent command in the script would inherit.
    expect(s).not.toMatch(/^export LD_PRELOAD=/m);
  });

  it('emits syntactically valid shell for the shelly_git wrapper', () => {
    // Full-script `bash -n` on the whole generated script hits a Windows-only
    // execFileSync ENAMETOOLONG limit on this suite already (the pre-existing
    // "emits parseable shell ..." tests) — syntax-check the new function in
    // isolation instead, extracted verbatim from the real generated output so
    // this still catches a real quoting/escaping mistake in shelly_git itself.
    const s = generateRunScript({ ...agent({ type: 'local' }, true), workspaceRoot: '/ws' });
    const match = s.match(/shelly_git\(\) \{[\s\S]*?\n\}\n/);
    expect(match).not.toBeNull();
    expect(() => execFileSync('bash', ['-n', '-c', match![0]])).not.toThrow();
  });

  it('bakes unattended:true into the STORED script and unattended:false only for attended runs (DEFERRED #2)', () => {
    // Install / restore / startup repair / consent re-bake write the script the
    // AlarmManager fire and native one-tap read — no approver present, so the
    // driver must decline a gray verdict immediately (after grant consumption).
    const stored = generateRunScript(agent({ type: 'cli', cli: 'codex' }, true));
    expect(stored).toContain('"unattended":true');
    // The foreground TS ladder (Run now / @agent) is the ONLY caller that may
    // mark a run attended — a human is in-app to answer the escalation.
    const attended = generateRunScript(agent({ type: 'cli', cli: 'codex' }, true), { attended: true });
    expect(attended).toContain('"unattended":false');
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
    // Driver audit is mirrored immediately after the driver process exits —
    // before the codex-driver-answer routing (CODEX_RESULT_ACTIVE / the
    // $RESULT_FILE.answer check) and before the outer if/else's `else`
    // branch (the "driver unavailable" fallback) — so a mid-run kill can
    // never lose the audit trail regardless of which branch runs next.
    expect(s).toContain('mirror_driver_audit_to_app_private || true\n  mirror_driver_audit_to_sdcard || true\n  CODEX_RESULT_ACTIVE=1');
    const driverExitIdx = s.indexOf('mirror_driver_audit_to_app_private || true\n  mirror_driver_audit_to_sdcard || true');
    const elseIdx = s.indexOf('\nelse\n', driverExitIdx);
    expect(driverExitIdx).toBeGreaterThan(-1);
    expect(elseIdx).toBeGreaterThan(driverExitIdx);
    expect(s).toContain('rm -f "$RESULT_FILE" "$RESULT_FILE.answer" "$BACKEND_ERROR_FILE"\nfinish 0');
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
    expect(notify).toContain('request_and_wait_approval "notify" "$preview" "$result_file" || return 1');
    expect(notify).toContain('write_native_notification_request "success" "$preview"');

    const webhook = generateRunScript(webhookAgent);
    expect(webhook).toContain("ACTION_TYPE='webhook'");
    expect(webhook).toContain("ACTION_WEBHOOK_URL='https://example.com/hook'");
    expect(webhook).toContain('Webhook action requires an https URL.');
    expect(webhook).toContain('request_and_wait_approval "webhook" "$preview" "$result_file" "$webhook_host" "$webhook_payload" "$webhook_host_allowlisted" || return 1');
    expect(webhook).toContain('http_post_json "$ACTION_WEBHOOK_URL" "$webhook_payload"');
    expect(webhook).toContain('write_native_notification_request "error" "$ACTION_DISPATCH_MESSAGE" || true');

    const cli = generateRunScript(cliAgent);
    expect(cli).toContain("ACTION_TYPE='cli'");
    expect(cli).toContain("ACTION_COMMAND='rm -rf ~/tmp/example'");
    expect(cli).toContain("ACTION_COMMAND_SAFETY_LEVEL='HIGH'");
    expect(cli).toContain('request_and_wait_approval "cli" "$preview" "$result_file" || return 1');
    expect(cli).toContain('cap_workspace_exec "$ACTION_COMMAND" "$CLI_EXEC_CWD" "$cli_output" "$cli_error"');
    expect(cli).toContain('bash -lc "$command_text" > "$out_file" 2>&1');
    expect(cli).not.toContain('eval "$ACTION_COMMAND"');
  });
});

describe('generateRunScript — transient-failure resilience (P0/P1)', () => {
  const webAgent = (over: Partial<Agent> = {}): Agent => ({
    ...agent({ type: 'gemini-api' }, true),
    prompt: 'ニュースを集めて',
    ...over,
  });

  it('P0-a: HTTP helper splits transient (23) vs permanent (22) exit codes and retries only the transient class', () => {
    const s = generateRunScript(agent({ type: 'perplexity' }, false));
    // Node helper classifies: <400 → 0, 429/5xx → 23, other 4xx → 22, network → 23.
    expect(s).toContain('process.exitCode = 23;');
    expect(s).toContain('process.exitCode = 22;');
    expect(s).toContain('code === 429 || code >= 500');
    // Bounded retry wrapper, used by the keyed web backends.
    expect(s).toContain('http_post_json_retry()');
    expect(s).toContain('if [ "$_hpr_rc" -ne 23 ]; then');
    expect(s).toContain('http_post_json_retry "https://api.perplexity.ai/chat/completions"');
  });

  it('P0-b: a transient failure marks TRANSIENT_ERROR_FILE → STATUS=unavailable, not error', () => {
    const s = generateRunScript(agent({ type: 'perplexity' }, false));
    expect(s).toContain('TRANSIENT_ERROR_FILE="$RESULT_FILE.transient-error"');
    expect(s).toContain('mark_http_failure "$API_EXIT"');
    // mark_http_failure only touches the transient marker on exit 23.
    expect(s).toContain('if [ "${1:-0}" -eq 23 ]; then\n    touch "$TRANSIENT_ERROR_FILE"');
    // STATUS branches on the transient marker.
    expect(s).toContain('if [ -f "$TRANSIENT_ERROR_FILE" ]; then\n    STATUS="unavailable"');
  });

  it('P1: an autonomous web run WITH consent bakes a Gemini→Codex fallback into the on-disk script', () => {
    const s = generateRunScript(webAgent(), { autonomousCloudConsent: true });
    expect(s).not.toContain('[REFUSED]');
    // The baked ladder escalates on a web backend failure.
    expect(s).toContain('if [ -f "$BACKEND_ERROR_FILE" ]; then');
    expect(s).toContain('command -v codex >/dev/null 2>&1');
    // Security fix (Finding 3): the baked P1 fallback must route Codex through
    // the SAME B2 driver + --policy-json gate the primary autonomous `cli`
    // path uses — never bare `codex exec`, which runs danger-full-access on
    // Android (agent-boundary-policy.ts) and bypasses command-safety/
    // workspace-boundary classification for codex's own internal shell calls.
    expect(s).toContain('.shelly-agent-driver.js');
    expect(s).toContain('--approval-policy untrusted');
    expect(s).toContain('--policy-json');
    expect(s).not.toMatch(/timeout "\$TIMEOUT" codex exec/);
    // Codex usage-limit guard: a 429/usage-limit refusal is NOT recorded as success.
    expect(s).toContain('usage limit|rate.?limit|too many requests');
    expect(s).toContain('mark_http_failure 23');
    // Non-zero driver exit is also a hard backend failure (mirrors the old
    // bare-exec CODEX_EXIT check, now against the driver's own exit code).
    expect(s).toContain('if [ "$DRIVER_EXIT" -ne 0 ]; then');
    expect(s).toContain('mark_http_failure "$DRIVER_EXIT"');
  });

  it('P1: the baked Codex fallback passes THIS agent\'s configured autonomy level to the driver (not a hardcoded default)', () => {
    const s = generateRunScript({ ...webAgent(), autonomyLevel: 'L1' }, { autonomousCloudConsent: true });
    expect(s).not.toContain('[REFUSED]');
    expect(s).toContain('"level":"L1"');
  });

  it('P1: consent + STOP-on-exhaustion does NOT bake the Codex fallback (free-tier auto-stop)', () => {
    const s = generateRunScript(webAgent(), { autonomousCloudConsent: true, autonomousCloudStop: true });
    expect(s).not.toContain('[REFUSED]');
    expect(s).not.toContain('command -v codex >/dev/null 2>&1');
  });

  it('P1: the foreground ladder suppresses the in-shell bake (Codex would otherwise run twice)', () => {
    const s = generateRunScript(webAgent(), { autonomousCloudConsent: true, suppressWebCodexBake: true });
    expect(s).not.toContain('command -v codex >/dev/null 2>&1');
  });

  it('emits parseable shell with the baked ladder', () => {
    const s = generateRunScript(webAgent(), { autonomousCloudConsent: true });
    expect(() => execFileSync('bash', ['-n', '-c', s])).not.toThrow();
  });
});

describe('generateRunScript — ab-article-eval routes its Codex side through the B2 driver (DEFERRED.md #3)', () => {
  // Regression guard: ab-article-eval used to shell out to a bare
  // `"$CODEX_CMD" exec "$(cat ...)"`, the exact invariant codexDriverCommand()
  // exists to prevent — Android codex has no working native --sandbox, so an
  // un-driven `codex exec` runs danger-full-access and every internal
  // shell tool-call codex makes bypasses command-safety/workspace-boundary
  // classification. ab-article-eval is autonomous-allowed
  // (agent-credential-policy.ts: credentialClass === 'oauth'), so this was a
  // real unattended exposure, not just a manual/foreground nicety. It must
  // now route through the SAME driver + --policy-json gate as every other
  // codex-resolved tool (the primary `cli` case, the `auto` fallback, and the
  // baked web→Codex ladder all already do this — see the neighboring
  // describe blocks in this file for their equivalent assertions).
  it('routes the Codex comparison leg through .shelly-agent-driver.js, never a bare codex exec', () => {
    const s = generateRunScript(agent({ type: 'ab-article-eval' }, true));
    expect(s).not.toContain('[REFUSED]');
    expect(s).toContain('.shelly-agent-driver.js');
    expect(s).toContain('if node_usable && [ -f "$HOME/.shelly-agent-driver.js" ]; then');
    expect(s).toContain('shelly_timeout_app_binary "$TIMEOUT" node "$HOME/.shelly-agent-driver.js"');
    expect(s).toContain('--approval-policy untrusted');
    expect(s).toContain('--policy-json');
    expect(s).toContain('--codex-bin "$CODEX_CMD"');
    expect(s).toContain('--answer-file "$RUN_DIR/codex.md"');
    expect(s).toContain('--prompt-file "$RUN_DIR/prompt.md"');
    expect(s).toContain('--audit-log "$LOG_DIR/agent-driver-audit.jsonl"');
    // The old danger-full-access shape must never resurface.
    expect(s).not.toMatch(/timeout "\$TIMEOUT" "\$CODEX_CMD" exec/);
    expect(s).not.toMatch(/"\$CODEX_CMD" exec "\$\(cat/);
  });

  it('mirrors the driver audit log to app-private storage on the article-eval leg too', () => {
    const s = generateRunScript(agent({ type: 'ab-article-eval' }, true));
    // Same audit-mirroring calls every other driver invocation makes — proves
    // this call site isn't a special, unaudited one-off.
    const driverBlockStart = s.indexOf('ARTICLE_EVAL_DRIVER_CWD=');
    expect(driverBlockStart).toBeGreaterThan(-1);
    const driverBlock = s.slice(driverBlockStart, driverBlockStart + 1500);
    expect(driverBlock).toContain('mirror_driver_audit_to_app_private || true');
    expect(driverBlock).toContain('mirror_driver_audit_to_sdcard || true');
  });

  it('passes this agent\'s configured autonomy level to the driver (not a hardcoded default)', () => {
    const l1 = generateRunScript({ ...agent({ type: 'ab-article-eval' }, true), autonomyLevel: 'L1' });
    expect(l1).toContain('"level":"L1"');
    const l3 = generateRunScript({ ...agent({ type: 'ab-article-eval' }, true), autonomyLevel: 'L3' });
    expect(l3).toContain('"level":"L3"');
  });

  it('wires agent.workspaceRoot through to the article-eval driver --cwd, falling back to the content-studio $PROJECT_DIR when unset', () => {
    const withRoot = generateRunScript({
      ...agent({ type: 'ab-article-eval' }, true),
      workspaceRoot: '/home/shelly-test/projects/my-workspace',
    });
    expect(withRoot).toContain("AGENT_WORKSPACE_ROOT='/home/shelly-test/projects/my-workspace'");
    expect(withRoot).toContain('ARTICLE_EVAL_DRIVER_CWD="${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"');
    expect(withRoot).toContain('--cwd "$ARTICLE_EVAL_DRIVER_CWD"');

    const withoutRoot = generateRunScript(agent({ type: 'ab-article-eval' }, true));
    expect(withoutRoot).toContain("AGENT_WORKSPACE_ROOT=''");
    expect(withoutRoot).toContain('ARTICLE_EVAL_DRIVER_CWD="${AGENT_WORKSPACE_ROOT:-$PROJECT_DIR}"');
  });

  it('still runs the local-Qwen comparison leg unchanged (only the Codex leg moved behind the driver)', () => {
    const s = generateRunScript(agent({ type: 'ab-article-eval' }, true));
    expect(s).toContain('ensure_local_llm_server "$LOCAL_URL" "$LOCAL_MODEL"');
    expect(s).toContain('local-qwen.md');
    expect(s).toContain('metrics.json');
    expect(s).toContain(UNSET); // oauth+local path → keys scrubbed
  });

  it('emits parseable shell for the driver-routed article-eval script', () => {
    // Written to a temp file and syntax-checked with `bash -n <file>` rather
    // than `bash -n -c <script>` — the driver invocation makes this generated
    // script long enough to hit Windows' ENAMETOOLONG argv limit via -c (a
    // known baseline flake for this project's other `-c`-based parse checks
    // on Windows; see docs/superpowers/DEFERRED.md "ENAMETOOLONG Windows
    // ベースライン"). Reading from a file sidesteps the argv-length limit
    // entirely while checking the exact same thing.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelly-article-eval-parse-'));
    try {
      const s = generateRunScript(agent({ type: 'ab-article-eval' }, true));
      const scriptFile = path.join(tmpDir, 'autonomous.sh');
      fs.writeFileSync(scriptFile, s);
      expect(() => execFileSync('bash', ['-n', scriptFile])).not.toThrow();

      const nonAutonomous = generateRunScript(agent({ type: 'ab-article-eval' }, false));
      const nonAutonomousFile = path.join(tmpDir, 'manual.sh');
      fs.writeFileSync(nonAutonomousFile, nonAutonomous);
      expect(() => execFileSync('bash', ['-n', nonAutonomousFile])).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
