/**
 * Claude glibc S4: the on-device Claude Code as a first-class agent worker
 * (`ToolChoice { type: 'cli', cli: 'claude' }`) next to Codex.
 *
 *  - routing / NL: tool mentions, chain step pins, draft edits, overrides, MONITOR ids;
 *  - the run script: a Claude step runs the SAME gated driver as Codex with
 *    `--engine claude`; every Codex / local script stays byte-identical;
 *  - the driver's Claude engine: can_use_tool → gate mapping, usage, argv /
 *    settings, and a host E2E against a fake stream-json claude
 *    (__tests__/fixtures/fake-claude-stream.js) with the real gate helper;
 *  - HomeInitializer: one shared shelly-claude-glibc() for .bashrc and the
 *    non-interactive runner ~/.shelly-claude-run.sh (BASHRC_VERSION 283).
 */
import * as childProcess from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('@/lib/home-path', () => ({
  getHomePath: () => '/home/shelly-test',
}));

import { AGENT_CLI_WORKERS, cliIdOf, sameProvider } from '@/lib/agent-cli-workers';
import { matchToolMention, detectExplicitToolUsage } from '@/lib/agent-tool-mentions';
import { detectToolPinnedSteps, stripToolPhrase } from '@/lib/agent-orchestration';
import { toolChoiceToLabel } from '@/lib/agent-tool-router';
import {
  PROVIDER_PICKS,
  providerPickToTool,
  sanitizeOverrideTool,
  toolToProviderPick,
  vetOverrideToolForAgent,
} from '@/lib/agent-provider-overrides';
import { MONITOR_PROVIDERS, MONITOR_PROVIDER_KIND, providerToTool } from '@/lib/monitor-team';
import { resolveEscalationLadder } from '@/lib/agent-escalation-ladder';
import { generateRunScript } from '@/lib/agent-executor';
import { progressProviderForTool } from '@/lib/agent-progress-writer';
import type { Agent, ToolChoice } from '@/store/types';

const root = path.resolve(__dirname, '..');
const CLAUDE: ToolChoice = { type: 'cli', cli: 'claude' };
const CODEX: ToolChoice = { type: 'cli', cli: 'codex' };

function agent(partial: Partial<Agent>): Agent {
  return {
    id: 's4-agent',
    name: 'S4 Agent',
    description: '',
    prompt: 'Say hello in one sentence.',
    schedule: null,
    tool: { type: 'local' },
    outputPath: '~/out/s4.md',
    outputTemplate: null,
    enabled: true,
    lastRun: null,
    lastResult: null,
    createdAt: 0,
    version: 1,
    action: { type: 'draft' },
    ...partial,
  } as Agent;
}

describe('CLI worker table', () => {
  it('labels and identities', () => {
    expect(toolChoiceToLabel(CODEX)).toBe('Codex CLI');
    expect(toolChoiceToLabel(CLAUDE)).toBe('Claude Code');
    expect(AGENT_CLI_WORKERS.claude.driverEngine).toBe('claude');
    expect(cliIdOf(CLAUDE)).toBe('claude');
    expect(cliIdOf({ type: 'local' })).toBeUndefined();
    expect(sameProvider(CLAUDE, CODEX)).toBe(false);
    expect(sameProvider(CLAUDE, { type: 'cli', cli: 'claude' })).toBe(true);
  });
});

describe('NL: naming Claude pins Claude Code', () => {
  it('per-clause mentions (JA / EN), Codex unchanged', () => {
    expect(matchToolMention('Claudeで変更点を3行にまとめて')).toEqual(CLAUDE);
    expect(matchToolMention('クロードコードで失敗の原因を調べて')).toEqual(CLAUDE);
    expect(matchToolMention('summarize the changes with Claude Code')).toEqual(CLAUDE);
    expect(matchToolMention('Codexでテストを実行して')).toEqual(CODEX);
    expect(matchToolMention('claudetteの話')).toBeUndefined();
  });

  it('single-clause explicit usage, but not a topic / comparison', () => {
    expect(detectExplicitToolUsage('Claude CodeでこのリポジトリのREADMEを要約して')).toEqual(CLAUDE);
    expect(detectExplicitToolUsage('use Claude Code to review the diff')).toEqual(CLAUDE);
    expect(detectExplicitToolUsage('Claudeの最新ニュースを集めて')).toBeUndefined();
    expect(detectExplicitToolUsage('ClaudeとCodexを比較して')).toBeUndefined();
  });

  it('a Codex + Claude chain pins each step and strips the instrument phrase', () => {
    const steps = detectToolPinnedSteps('毎朝9時に、Codexでリポジトリのgit logを確認して、Claudeで変更点を3行にまとめて')!;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ instruction: 'リポジトリのgit logを確認して', tool: CODEX });
    expect(steps[1]).toEqual({ instruction: '変更点を3行にまとめて', tool: CLAUDE });
    const en = detectToolPinnedSteps('check the git log with Codex, then summarize the changes with Claude Code')!;
    expect(en.map((s) => s.tool)).toEqual([CODEX, CLAUDE]);
    // A Codex phrase is never stripped from a Claude-pinned step (provider identity, not type).
    expect(stripToolPhrase('Codexでテストを実行して', CLAUDE)).toBe('Codexでテストを実行して');
  });
});

describe('provider overrides / MONITOR', () => {
  it('Claude is a picker option and round-trips', () => {
    expect(PROVIDER_PICKS).toContain('claude');
    expect(providerPickToTool('claude')).toEqual(CLAUDE);
    expect(toolToProviderPick(CLAUDE)).toBe('claude');
    expect(toolToProviderPick(CODEX)).toBe('codex');
    expect(sanitizeOverrideTool({ type: 'cli', cli: 'claude' })).toEqual(CLAUDE);
    expect(sanitizeOverrideTool({ type: 'cli', cli: 'rm -rf' })).toBeNull();
  });

  it('a Claude override never resolves to the agent\'s Codex tool (and vice versa)', () => {
    const a = agent({ tool: CODEX });
    expect(vetOverrideToolForAgent(a, CLAUDE)).toBeUndefined();
    expect(vetOverrideToolForAgent(a, CODEX)).toEqual(CODEX);
    const b = agent({ tool: { type: 'local' }, orchestration: { steps: [{ instruction: 'x', tool: CLAUDE }, 'y'] } });
    expect(vetOverrideToolForAgent(b, CLAUDE)).toEqual(CLAUDE);
  });

  it('MONITOR: Claude Code is a CLI (subscription) provider', () => {
    expect(MONITOR_PROVIDERS).toContain('claude-cli');
    expect(MONITOR_PROVIDER_KIND['claude-cli']).toBe('CLI');
    expect(providerToTool('claude-cli')).toEqual(CLAUDE);
    expect(progressProviderForTool(CLAUDE)).toEqual({ kind: 'CLI', name: 'cli:claude' });
  });
});

describe('escalation ladder', () => {
  const env = { hasCerebrasKey: false, hasGroqKey: false };
  it('attended: a Claude pin runs first, Codex stays the last rung', () => {
    const tools = resolveEscalationLadder(agent({ tool: CLAUDE, prompt: 'READMEを要約して' }), env).tools;
    expect(tools[0]).toEqual(CLAUDE);
    expect(tools[tools.length - 1]).toEqual(CODEX);
  });
  it('autonomous: an explicit Claude pin is honored (then local → Codex)', () => {
    const tools = resolveEscalationLadder(agent({ tool: CLAUDE, autonomous: true, prompt: 'READMEを要約して' }), env).tools;
    expect(tools).toEqual([CLAUDE, { type: 'local' }, CODEX]);
    const codexOnly = resolveEscalationLadder(agent({ tool: CODEX, autonomous: true, prompt: 'READMEを要約して' }), env).tools;
    expect(codexOnly).toEqual([{ type: 'local' }, CODEX]);
  });
});

describe('run script generation', () => {
  it('a Claude agent runs the gated driver with --engine claude and records usage', () => {
    const script = generateRunScript(agent({ tool: CLAUDE }));
    expect(script).toContain('node "$HOME/.shelly-agent-driver.js" \\\n    --engine claude \\\n    --usage-file "$RESULT_FILE.usage.json" \\\n    --cwd "$DRIVER_CWD" \\\n    --approval-policy untrusted \\');
    expect(script).toContain("TOOL_LABEL='Claude Code'");
    expect(script).toContain('$USAGE_FIELDS}');
    expect(script).toContain('USAGE_FIELDS=",\\"usage\\":$USAGE_RAW"');
    // never a raw claude invocation or the prompt in argv
    expect(script).not.toMatch(/shelly-claude-run\.sh|shelly-claude-glibc|claude -p/);
  });

  it('Codex and local scripts carry nothing Claude-specific', () => {
    for (const tool of [CODEX, { type: 'local' } as ToolChoice]) {
      const script = generateRunScript(agent({ tool }));
      expect(script).not.toContain('--engine');
      expect(script).not.toContain('USAGE_FIELDS');
      expect(script).not.toContain('usage.json');
    }
  });

  it('unattended Claude keeps the unattended gate policy', () => {
    const script = generateRunScript(agent({ tool: CLAUDE, autonomous: true }));
    expect(script).toContain('--engine claude');
    expect(script).toMatch(/--policy-json '[^']*"unattended":true/);
  });

  it('a Codex chain gives a Claude-pinned step its own engine arm; a Claude chain the reverse', () => {
    const mixed = generateRunScript(agent({
      tool: CODEX,
      orchestration: { steps: ['git logを確認して', { instruction: 'READMEを直して', tool: CLAUDE }] },
    }));
    expect(mixed).toContain('CODEX_ORCH_TOOL_JSON=\'"Codex CLI"\'');
    expect(mixed).toMatch(/\n {2}1\)\n {2}if node_usable[^]*?--engine claude[^]*?\n {4};;\n {2}\*\)\n/);
    expect(mixed.match(/--engine claude/g)).toHaveLength(1);
    const claudeChain = generateRunScript(agent({
      tool: CLAUDE,
      orchestration: { steps: ['git logを確認して', { instruction: 'テストを走らせて', tool: CODEX }] },
    }));
    expect(claudeChain).toContain('CODEX_ORCH_TOOL_JSON=\'"Claude Code"\'');
    // the default (*) block is Claude, the Codex step's arm has no --engine
    const arm = /\n {2}1\)\n([^]*?)\n {4};;\n {2}\*\)\n/.exec(claudeChain)![1];
    expect(arm).not.toContain('--engine');
    expect(claudeChain).toContain('--engine claude');
  });
});

describe('driver: Claude engine', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const driver = require(path.join(root, 'scripts/shelly-agent-driver.js'));

  it('maps every tool use onto a shell-equivalent gate command, denies the rest', () => {
    const cwd = '/ws';
    expect(driver.claudeToolToActions('Bash', { command: ' git status ' }, cwd).actions[0].command).toBe('git status');
    expect(driver.claudeToolToActions('Bash', { command: 'sleep 9', run_in_background: true }, cwd).deny).toMatch(/background/);
    expect(driver.claudeToolToActions('Read', { file_path: '/etc/passwd' }, cwd).actions[0].command).toBe("cat -- '/etc/passwd'");
    expect(driver.claudeToolToActions('Edit', { file_path: "it's.txt" }, cwd).actions[0].command).toBe(`tee -- '${path.resolve(cwd, "it's.txt").replace(/'/g, `'\\''`)}'`);
    for (const t of ['WebFetch', 'WebSearch', 'Task', 'mcp__x__y', '']) {
      expect(driver.claudeToolToActions(t, {}, cwd).deny).toBeTruthy();
    }
    expect(driver.claudeToolToActions('Read', { file_path: 'a\nb' }, cwd).deny).toBeTruthy();
  });

  it('tokens always, USD only for an API-key-billed run', () => {
    const result = { total_cost_usd: 0.5, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 42 } };
    expect(driver.claudeUsageFromResult(result, 'none')).toEqual({ inputTokens: 115, outputTokens: 42 });
    expect(driver.claudeUsageFromResult(result, 'ANTHROPIC_API_KEY')).toEqual({ inputTokens: 115, outputTokens: 42, usd: 0.5 });
    expect(driver.claudeUsageFromResult({ usage: {} }, null)).toBeNull();
  });

  it('argv never carries the prompt; settings force a permission request for gated tools', () => {
    const args: string[] = driver.claudeAgentArgs();
    expect(args).toEqual(expect.arrayContaining(['-p', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default', '--strict-mcp-config']));
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('bypassPermissions');
    const settings = JSON.parse(driver.claudeAgentSettingsJson());
    expect(settings.permissions.ask).toEqual(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit']);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(['Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task']));
    expect(settings.disableAllHooks).toBe(true);
    const env = driver.claudeChildEnv({ CLAUDE_CODE_SHELL: '/evil', CLAUDE_ENV_FILE: '/evil', SHELLY_AGENT_ESCALATION_DIR: '/x', HOME: '/h' });
    expect(env.CLAUDE_CODE_SHELL).toBeUndefined();
    expect(env.CLAUDE_ENV_FILE).toBeUndefined();
    expect(env.SHELLY_AGENT_ESCALATION_DIR).toBeUndefined();
    expect(env.SHELLY_CLAUDE_SETTINGS_JSON).toBe(driver.claudeAgentSettingsJson());
  });

  it('host E2E: every can_use_tool goes through the real gate; unattended gray is declined', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's4-drv-'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 's4-ws-'));
    try {
      fs.writeFileSync(path.join(tmp, 'prompt.txt'), 'S4-PROMPT-SENTINEL');
      const rec = path.join(tmp, 'rec.json');
      const out = childProcess.execFileSync(process.execPath, [
        path.join(root, 'scripts/shelly-agent-driver.js'),
        '--engine', 'claude',
        '--cwd', ws,
        '--prompt-file', path.join(tmp, 'prompt.txt'),
        '--policy-json', JSON.stringify({ unattended: true }),
        '--gate-script', path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js'),
        '--claude-runner', path.join(root, '__tests__/fixtures/fake-claude-stream.js'),
        '--claude-runner-interpreter', process.execPath,
        '--answer-file', path.join(tmp, 'answer.md'),
        '--usage-file', path.join(tmp, 'usage.json'),
        '--audit-log', path.join(tmp, 'audit.jsonl'),
        '--timeout-ms', '30000',
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: tmp,
          CLAUDE_CODE_SHELL: '/evil',
          FAKE_CLAUDE_RECORD: rec,
          FAKE_CLAUDE_TOOLS: JSON.stringify([
            { tool_name: 'Bash', input: { command: 'ls' } },
            { tool_name: 'Bash', input: { command: 'curl https://example.com' } },
            { tool_name: 'Read', input: { file_path: path.join(ws, 'a.txt') } },
            { tool_name: 'Read', input: { file_path: '/etc/passwd' } },
            { tool_name: 'Write', input: { file_path: path.join(ws, 'b.txt'), content: 'x' } },
            { tool_name: 'WebFetch', input: { url: 'https://x' } },
          ]),
        },
      });
      expect(fs.readFileSync(path.join(tmp, 'answer.md'), 'utf8')).toBe('decisions: allow,deny,allow,deny,allow,deny');
      expect(JSON.parse(fs.readFileSync(path.join(tmp, 'usage.json'), 'utf8'))).toEqual({ inputTokens: 115, outputTokens: 42 });
      const r = JSON.parse(fs.readFileSync(rec, 'utf8'));
      expect(r.prompt).toBe('S4-PROMPT-SENTINEL');
      expect(r.claudeCodeShell).toBeNull();
      expect(r.argv).toEqual(driver.claudeAgentArgs());
      expect(out).not.toContain('S4-PROMPT-SENTINEL');
      const gates = out.split('\n').filter((l) => l.startsWith('GATE '));
      expect(gates).toHaveLength(6);
      expect(out).toContain('escalation_denied_unattended');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 60_000);

  it('a failed claude result writes no answer and exits non-zero', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's4-fail-'));
    try {
      fs.writeFileSync(path.join(tmp, 'prompt.txt'), 'p');
      let status = 0;
      try {
        childProcess.execFileSync(process.execPath, [
          path.join(root, 'scripts/shelly-agent-driver.js'),
          '--engine', 'claude', '--cwd', tmp, '--prompt-file', path.join(tmp, 'prompt.txt'),
          '--claude-runner', path.join(root, '__tests__/fixtures/fake-claude-stream.js'),
          '--claude-runner-interpreter', process.execPath,
          '--answer-file', path.join(tmp, 'answer.md'),
        ], { encoding: 'utf8', env: { ...process.env, HOME: tmp, FAKE_CLAUDE_FAIL: '1', FAKE_CLAUDE_TOOLS: '[]' } });
      } catch (e) {
        status = (e as { status: number }).status;
      }
      expect(status).toBe(1);
      expect(fs.existsSync(path.join(tmp, 'answer.md'))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects an unknown engine', () => {
    const r = childProcess.spawnSync(process.execPath, [path.join(root, 'scripts/shelly-agent-driver.js'), '--engine', 'agy', '--cwd', os.tmpdir(), '--prompt', 'x'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('invalid --engine');
  });

  it('asset copy is byte-identical', () => {
    expect(fs.readFileSync(path.join(root, 'modules/terminal-emulator/android/src/main/assets/shelly-agent-driver.js'), 'utf8'))
      .toBe(fs.readFileSync(path.join(root, 'scripts/shelly-agent-driver.js'), 'utf8'));
  });
});

describe('PlanSpec executor', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const src = fs.readFileSync(path.join(root, 'scripts/shelly-plan-executor.js'), 'utf8');
  it('parses a Claude override like Codex but never dispatches a CLI', () => {
    expect(src).toContain("raw.cli === 'codex' || raw.cli === 'claude' ? { type: 'cli', cli: raw.cli } : null");
    expect(src).toContain("const STEP_TOOL_DISPATCHABLE_TYPES = ['local', 'gemini-api', 'perplexity', 'cerebras', 'groq'];");
  });
});

describe('HomeInitializer: one shelly-claude-glibc() for .bashrc and the agent runner', () => {
  const homeKt = fs.readFileSync(
    path.join(root, 'modules/terminal-emulator/android/src/main/java/expo/modules/terminalemulator/HomeInitializer.kt'),
    'utf8',
  );

  function kotlinLinesOf(fnHeader: string): string[] {
    const lines = homeKt.split(/\r?\n/);
    const start = lines.findIndex((l) => l.includes(fnHeader));
    const out: string[] = [];
    for (let i = start; i < lines.length; i++) {
      out.push(lines[i]);
      if (/^ {4}\}\s*$/.test(lines[i])) break;
    }
    return out;
  }

  it('bumped BASHRC_VERSION to 283', () => {
    expect(homeKt).toMatch(/private const val BASHRC_VERSION = 283\b/);
  });

  it('the function text exists exactly once and both .bashrc and the runner call it', () => {
    expect(homeKt.split('sb.appendLine("shelly-claude-glibc() {")').length - 1).toBe(1);
    expect(homeKt.split('appendClaudeGlibcFunction(sb, libDir)').length - 1).toBe(2);
    const runner = kotlinLinesOf('internal fun claudeRunnerScript(libDir: String): String').join('\n');
    expect(runner).toContain('sb.appendLine("__shelly_paste_tui_begin() { :; }")');
    expect(runner).toContain('sb.appendLine("__shelly_paste_tui_end() { :; }")');
    expect(runner).toContain('sb.appendLine("shelly-claude-glibc \\"\\$@\\"")');
    expect(runner).toContain('export SHELLY_LIB_DIR=');
  });

  it('the runner is written every start, 0700, and only run as `bash <file>`', () => {
    expect(homeKt).toContain('val claudeRunner = File(home, ".shelly-claude-run.sh")');
    expect(homeKt).toContain('tmp.writeText(claudeRunnerScript(libDir))');
    expect(homeKt).toContain('tmp.setExecutable(false, false); tmp.setExecutable(true, true)');
  });

  it('the generated function + runner are valid bash', () => {
    const lines = homeKt.split(/\r?\n/);
    const start = lines.findIndex((l) => l.includes('sb.appendLine("shelly-claude-glibc() {")'));
    const fn: string[] = [];
    for (let i = start; i < lines.length; i++) {
      const m = /^\s*sb\.appendLine\("(.*)"\)\s*$/.exec(lines[i]);
      if (!m) break;
      fn.push(m[1].replace(/\$libDir/g, '/libdir').replace(/\\(.)/g, '$1'));
      if (m[1] === '}') break;
    }
    const script = ['__shelly_paste_tui_begin() { :; }', '__shelly_paste_tui_end() { :; }', ...fn, 'shelly-claude-glibc "$@"'].join('\n');
    const bash = childProcess.spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
    if (bash.error) return; // no bash on this host
    expect(bash.stderr).toBe('');
    expect(bash.status).toBe(0);
  });
});
