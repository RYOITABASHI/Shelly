jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { execFileSync } from 'node:child_process';
import { generateRunScript } from '@/lib/agent-executor';
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
    expect(s).toContain('SHELLY_AGENT_SCRIPT_VERSION=6');
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
});
