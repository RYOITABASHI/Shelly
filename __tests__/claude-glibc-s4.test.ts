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
    // ToS gate: the key and the unattended opt-in reach ONLY the driver call, as an env prefix
    expect(script).toContain('  ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED="${SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED:-1}" shelly_timeout_app_binary "$TIMEOUT" node "$HOME/.shelly-agent-driver.js"');
    expect(script).not.toMatch(/export ANTHROPIC_API_KEY|--api-key/);
  });

  it('Codex and local scripts carry nothing Claude-specific', () => {
    for (const tool of [CODEX, { type: 'local' } as ToolChoice]) {
      const script = generateRunScript(agent({ tool }));
      expect(script).not.toContain('--engine');
      expect(script).not.toContain('USAGE_FIELDS');
      expect(script).not.toContain('usage.json');
      expect(script).not.toContain('ANTHROPIC_API_KEY');
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
    // allowlist: only the gated tools exist for the model at all
    expect(args[args.indexOf('--tools') + 1]).toBe('Bash,Read,Write,Edit');
    const disallowed = args[args.indexOf('--disallowedTools') + 1].split(',');
    for (const t of ['TodoWrite', 'Skill', 'ToolSearch', 'AskUserQuestion', 'SlashCommand', 'ExitPlanMode', 'BashOutput', 'KillShell', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'Grep', 'Glob']) {
      expect(disallowed).toContain(t);
    }
    for (const t of driver.CLAUDE_GATED_TOOLS) expect(disallowed).not.toContain(t);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('bypassPermissions');
    const settings = JSON.parse(driver.claudeAgentSettingsJson());
    expect(settings.permissions.ask).toEqual(['Bash', 'Read', 'Write', 'Edit', 'MultiEdit']);
    // settings deny = the --disallowedTools list (kept in sync, defense in depth)
    expect(settings.permissions.deny).toEqual(driver.CLAUDE_DENIED_TOOLS);
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(driver.CLAUDE_DENIED_TOOLS.join(','));
    expect(settings.disableAllHooks).toBe(true);
    const env = driver.claudeChildEnv({ CLAUDE_CODE_SHELL: '/evil', CLAUDE_ENV_FILE: '/evil', SHELLY_AGENT_ESCALATION_DIR: '/x', HOME: '/h' });
    expect(env.CLAUDE_CODE_SHELL).toBeUndefined();
    expect(env.CLAUDE_ENV_FILE).toBeUndefined();
    expect(env.SHELLY_AGENT_ESCALATION_DIR).toBeUndefined();
    expect(env.SHELLY_CLAUDE_SETTINGS_JSON).toBe(driver.claudeAgentSettingsJson());
  });

  /** Run the real driver against the fake claude; returns stdout, exit status and the fake's record. */
  function runFake(opts: { policy: object; env?: Record<string, string>; tools?: object[] }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's4-drv-'));
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 's4-ws-'));
    fs.writeFileSync(path.join(tmp, 'prompt.txt'), 'S4-PROMPT-SENTINEL');
    const rec = path.join(tmp, 'rec.json');
    const baseEnv: Record<string, string | undefined> = { ...process.env };
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED']) delete baseEnv[k];
    const r = childProcess.spawnSync(process.execPath, [
      path.join(root, 'scripts/shelly-agent-driver.js'),
      '--engine', 'claude',
      '--cwd', ws,
      '--prompt-file', path.join(tmp, 'prompt.txt'),
      '--policy-json', JSON.stringify(opts.policy),
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
        ...baseEnv,
        HOME: tmp,
        CLAUDE_CODE_SHELL: '/evil',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-token',
        FAKE_CLAUDE_RECORD: rec,
        FAKE_CLAUDE_TOOLS: JSON.stringify((opts.tools ?? []).map((t) => (typeof t === 'function' ? (t as (w: string) => object)(ws) : t))),
        ...(opts.env ?? {}),
      } as NodeJS.ProcessEnv,
    });
    const read = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
    const result = {
      out: `${r.stdout}${r.stderr}`,
      status: r.status,
      answer: read(path.join(tmp, 'answer.md')),
      usage: read(path.join(tmp, 'usage.json')),
      rec: read(rec) ? JSON.parse(read(rec)!) : null,
      ws,
    };
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
    return result;
  }

  it('host E2E: every can_use_tool goes through the real gate; unattended gray is declined', () => {
    const tools = [
      { tool_name: 'Bash', input: { command: 'ls' } },
      { tool_name: 'Bash', input: { command: 'curl https://example.com' } },
      (ws: string) => ({ tool_name: 'Read', input: { file_path: path.join(ws, 'a.txt') } }),
      { tool_name: 'Read', input: { file_path: '/etc/passwd' } },
      (ws: string) => ({ tool_name: 'Write', input: { file_path: path.join(ws, 'b.txt'), content: 'x' } }),
      { tool_name: 'WebFetch', input: { url: 'https://x' } },
    ];
    const r = runFake({ policy: { unattended: true }, env: { ANTHROPIC_API_KEY: 'sk-ant-test-key' }, tools });
    expect(r.status).toBe(0);
    expect(r.answer).toBe('decisions: allow,deny,allow,deny,allow,deny');
    // API-key billed → USD is recorded too.
    expect(JSON.parse(r.usage!)).toEqual({ inputTokens: 115, outputTokens: 42, usd: 0.0123 });
    expect(r.rec.prompt).toBe('S4-PROMPT-SENTINEL');
    expect(r.rec.claudeCodeShell).toBeNull();
    expect(r.rec.argv).toEqual(driver.claudeAgentArgs());
    expect(r.out).not.toContain('S4-PROMPT-SENTINEL');
    expect(r.out).not.toContain('sk-ant-test-key');
    expect(r.out.split('\n').filter((l) => l.startsWith('GATE '))).toHaveLength(6);
    expect(r.out).toContain('escalation_denied_unattended');
  }, 60_000);

  describe('credential source (ToS gate)', () => {
    it('plan: API key first; subscription attended, and unattended unless turned off (default on)', () => {
      expect(driver.claudeAuthPlan({ unattended: true }, { ANTHROPIC_API_KEY: 'k' }).source).toBe('api-key');
      expect(driver.claudeAuthPlan({}, { ANTHROPIC_API_KEY: 'k' }).source).toBe('api-key');
      expect(driver.claudeAuthPlan({}, {}).source).toBe('subscription');
      expect(driver.claudeAuthPlan({ unattended: true }, { ANTHROPIC_API_KEY: ' ' }).source).toBe('subscription');
      expect(driver.claudeAuthPlan({ unattended: true }, {}).source).toBe('subscription');
      expect(driver.claudeAuthPlan({ unattended: true }, { SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED: '1' }).source).toBe('subscription');
      expect(driver.claudeAuthPlan({ unattended: true }, { SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED: '0' }).source).toBeNull();
      expect(driver.claudeAuthPlan({ unattended: true }, { SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED: '0' }).refusal).toMatch(/claudeSubscriptionUnattended/);
      // turned off still allows an API key and attended runs
      expect(driver.claudeAuthPlan({ unattended: true }, { SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED: '0', ANTHROPIC_API_KEY: 'k' }).source).toBe('api-key');
      expect(driver.claudeAuthPlan({}, { SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED: '0' }).source).toBe('subscription');
    });

    it('child env carries exactly one credential kind', () => {
      const input = { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_AUTH_TOKEN: 'x', SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED: '1' };
      const keyEnv = driver.claudeChildEnv(input, { source: 'api-key' });
      expect(keyEnv.ANTHROPIC_API_KEY).toBe('k');
      expect(keyEnv.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(keyEnv.SHELLY_CLAUDE_AUTH).toBe('api-key');
      const subEnv = driver.claudeChildEnv(input, { source: 'subscription' });
      expect(subEnv.ANTHROPIC_API_KEY).toBeUndefined();
      expect(subEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('t');
      expect(subEnv.SHELLY_CLAUDE_AUTH).toBe('subscription');
      for (const e of [keyEnv, subEnv]) {
        expect(e.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(e.SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED).toBeUndefined();
      }
    });

    it('unattended, no key, setting turned off: refused before claude starts', () => {
      const r = runFake({ policy: { unattended: true }, env: { SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED: '0' } });
      expect(r.status).toBe(1);
      expect(r.rec).toBeNull();
      expect(r.answer).toBeNull();
      expect(r.out).toContain('CLAUDE_ERROR Claude Code unattended run refused');
    }, 30_000);

    it('unattended by default, or attended: the subscription is used, never a key', () => {
      const optIn = runFake({ policy: { unattended: true } });
      expect(optIn.status).toBe(0);
      expect(optIn.rec.auth).toBe('subscription');
      expect(optIn.rec.apiKey).toBeNull();
      expect(optIn.rec.oauthToken).toBe('oauth-test-token');
      expect(optIn.rec.optIn).toBeNull();
      // subscription: tokens only, no USD
      expect(JSON.parse(optIn.usage!)).toEqual({ inputTokens: 115, outputTokens: 42 });
      const attended = runFake({ policy: {} });
      expect(attended.status).toBe(0);
      expect(attended.rec.auth).toBe('subscription');
    }, 60_000);

    it('API key configured: the key is used and the subscription token withheld', () => {
      const r = runFake({ policy: {}, env: { ANTHROPIC_API_KEY: 'sk-ant-test-key' } });
      expect(r.status).toBe(0);
      expect(r.rec.auth).toBe('api-key');
      expect(r.rec.apiKey).toBe('sk-ant-test-key');
      expect(r.rec.oauthToken).toBeNull();
    }, 30_000);

    it('auth match: strict, both directions, absent report is a mismatch', () => {
      expect(driver.claudeAuthMatchesPlan({ source: 'api-key' }, 'ANTHROPIC_API_KEY')).toBe(true);
      expect(driver.claudeAuthMatchesPlan({ source: 'subscription' }, 'none')).toBe(true);
      expect(driver.claudeAuthMatchesPlan({ source: 'api-key' }, 'none')).toBe(false);
      expect(driver.claudeAuthMatchesPlan({ source: 'subscription' }, 'ANTHROPIC_API_KEY')).toBe(false);
      expect(driver.claudeAuthMatchesPlan({ source: 'subscription' }, null)).toBe(false);
      expect(driver.claudeAuthMatchesPlan({ source: 'api-key' }, undefined)).toBe(false);
    });

    it('any mismatch stops the run, attended or unattended, whatever the setting', () => {
      const cases: Array<{ policy: object; env: Record<string, string> }> = [
        // planned api-key, claude used the subscription — attended, setting on (default)
        { policy: {}, env: { ANTHROPIC_API_KEY: 'sk-ant-test-key', FAKE_CLAUDE_API_KEY_SOURCE: 'none' } },
        // same, unattended with the setting explicitly on
        { policy: { unattended: true }, env: { ANTHROPIC_API_KEY: 'sk-ant-test-key', FAKE_CLAUDE_API_KEY_SOURCE: 'none', SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED: '1' } },
        // planned subscription, claude reported an API key
        { policy: {}, env: { FAKE_CLAUDE_API_KEY_SOURCE: 'ANTHROPIC_API_KEY' } },
        // claude did not report a credential at all
        { policy: {}, env: { FAKE_CLAUDE_OMIT_API_KEY_SOURCE: '1' } },
      ];
      for (const c of cases) {
        const r = runFake({ policy: c.policy, env: c.env, tools: [{ tool_name: 'Bash', input: { command: 'ls' } }] });
        expect(r.status).toBe(1);
        expect(r.answer).toBeNull();
        expect(r.usage).toBeNull();
        expect(r.out).toContain('claude_auth_mismatch');
        expect(r.out).not.toContain('"approvalKind":"claude:Bash"');
      }
    }, 120_000);

    it('a tool use outside the allowlist (permission-free tools skip the gate) stops the run', () => {
      for (const tool of ['TodoWrite', 'Skill', 'mcp__evil__x']) {
        const r = runFake({ policy: {}, env: { FAKE_CLAUDE_ASSISTANT_TOOL: tool } });
        expect(r.status).toBe(1);
        expect(r.answer).toBeNull();
        expect(r.out).toContain('claude_tool_outside_allowlist');
      }
      const ok = runFake({ policy: {}, env: { FAKE_CLAUDE_ASSISTANT_TOOL: 'Bash' } });
      expect(ok.status).toBe(0);
    }, 120_000);

    it('fails closed when claude reports a different credential than planned (unattended, setting off)', () => {
      const r = runFake({ policy: { unattended: true }, env: { ANTHROPIC_API_KEY: 'sk-ant-test-key', FAKE_CLAUDE_API_KEY_SOURCE: 'none', SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED: '0' } });
      expect(r.status).toBe(1);
      expect(r.answer).toBeNull();
      expect(r.out).toContain('claude_auth_mismatch');
    }, 30_000);
  });

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

  it('ToS gate: the function honors the driver-chosen credential and tool shells never see one', () => {
    expect(homeKt).toContain('sb.appendLine("      api-key) unset CLAUDE_CODE_OAUTH_TOKEN ;;")');
    expect(homeKt).toContain('sb.appendLine("      subscription) unset ANTHROPIC_API_KEY ;;")');
    expect(homeKt).toContain('sb.appendLine("    if [ \\"\\${SHELLY_CLAUDE_AUTH:-}\\" != api-key ] && [ -z \\"\\${CLAUDE_CODE_OAUTH_TOKEN:-}\\" ] && [ -f \\"\\$HOME/.claude-token.env\\" ]; then . \\"\\$HOME/.claude-token.env\\"; fi")');
    // first line of the Bash-tool env file (inlined into every -c)
    expect(homeKt).toMatch(/__SHELLY_CLAUDE_ENV'"\)\r?\n\s*sb\.appendLine\("unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN"\)/);
    expect(homeKt).toContain('unset BROWSER DISPLAY WAYLAND_DISPLAY SHELLY_CLAUDE_SETTINGS_JSON SHELLY_CLAUDE_AUTH');
  });

  it('settings: API key in SecureStore + .env, unattended subscription defaults ON and can be turned off', () => {
    const secure = fs.readFileSync(path.join(root, 'lib/secure-store.ts'), 'utf8');
    expect(secure).toContain("'anthropicApiKey',");
    const store = fs.readFileSync(path.join(root, 'store/settings-store.ts'), 'utf8');
    expect(store).toContain("envUpdates.push(['ANTHROPIC_API_KEY', newSettings.anthropicApiKey]);");
    expect(store).toContain("envUpdates.push(['SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED', newSettings.claudeSubscriptionUnattended === false ? '0' : '1']);");
    expect(store).toMatch(/\n  claudeSubscriptionUnattended: true,\r?\n/);
    expect(fs.readFileSync(path.join(root, 'lib/agent-env-sync.ts'), 'utf8')).toContain('claudeSubscriptionUnattended: s.claudeSubscriptionUnattended ?? true,');
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
