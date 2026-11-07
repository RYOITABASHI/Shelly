#!/usr/bin/env node

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_GATE_SCRIPT = path.join(process.env.HOME || process.cwd(), '.shelly-gate-decide.js');
const DEFAULT_ESCALATION_TIMEOUT_MS = 120000;
const DEFAULT_ESCALATION_DIR = defaultEscalationDir();
const DEFAULT_ESCALATION_REPLY_DIR = defaultEscalationReplyDir();
const DEFAULT_ESCALATION_PUBLIC_KEY = defaultEscalationPublicKey();
const DEFAULT_PREAPPROVAL_GRANTS_FILE = defaultPreapprovalGrantsFile();
const ESCALATION_POLL_MS = 250;
const ANDROID_LINKER64 = '/system/bin/linker64';
// A signal here is *eligible* for a grant; it does NOT mean "grantable as expiry-only".
// network-send (and leaves-root WRITES) are Tier-1-ONLY — they stay in this set so a future
// keystore-maxuse (hardware-counted) grant can cover them, but isReplayDangerousSignals() is the
// enforcement point that blocks them from expiry-only (Tier-2). Don't drop network-send here, or
// the Tier-1 path loses it too.
const GRANTABLE_BOUNDARY_SIGNALS = new Set(['leaves-root', 'network-send']);
const UNGRANTABLE_BOUNDARY_SIGNALS = new Set(['secret-read', 'destructive', 'policy-write']);

function defaultEscalationDir() {
  return process.env.HOME
    ? path.join(process.env.HOME, '.shelly/agents/escalations')
    : path.join(os.tmpdir(), 'shelly-agent-escalations');
}

function defaultEscalationReplyDir() {
  const home = process.env.HOME || '';
  const androidHomeSuffix = `${path.sep}files${path.sep}home`;
  if (home.endsWith(androidHomeSuffix)) {
    return path.join(home.slice(0, -androidHomeSuffix.length), 'no_backup', 'shelly-agent-escalation-replies');
  }
  return path.join(os.tmpdir(), 'shelly-agent-escalation-replies');
}

function defaultEscalationPublicKey() {
  const home = process.env.HOME || '';
  const androidHomeSuffix = `${path.sep}files${path.sep}home`;
  if (home.endsWith(androidHomeSuffix)) {
    return path.join(home.slice(0, -androidHomeSuffix.length), 'no_backup', 'shelly-agent-escalation-public.der');
  }
  return path.join(os.tmpdir(), 'shelly-agent-escalation-public.der');
}

function defaultPreapprovalGrantsFile() {
  const home = process.env.HOME || '';
  const androidHomeSuffix = `${path.sep}files${path.sep}home`;
  if (home.endsWith(androidHomeSuffix)) {
    return path.join(home.slice(0, -androidHomeSuffix.length), 'no_backup', 'shelly-agent-preapproval-grants.jsonl');
  }
  return path.join(os.tmpdir(), 'shelly-agent-preapproval-grants.jsonl');
}

function usage() {
  process.stdout.write(`Usage:
  node scripts/shelly-agent-driver.js --cwd <workspace> --prompt <text> [options]

Options:
  --prompt-file <path>       Read prompt text from a file.
  --policy-json <json>       AutonomyPolicy JSON. Defaults to L2 + workspace cwd.
  --policy-file <path>       Read AutonomyPolicy JSON from a file.
  --gate-script <path>       Gate helper path. Defaults to $HOME/.shelly-gate-decide.js.
  --codex-bin <path>         Codex executable on host. Android app-server uses codex_tui. Defaults to "codex".
  --node-bin <path>          Node executable for the gate helper. Defaults to current node.
  --approval-policy <mode>   Defaults to "untrusted" (B2 Phase A safe config; only untrusted is allowed).
  --audit-log <path>         Append AUDIT/GATE JSON lines to this file.
  --answer-file <path>       Write completed Codex agentMessage text to this file.
  --timeout-ms <ms>          Whole turn timeout. Defaults to 300000.
  --gate-timeout-ms <ms>     Gate helper timeout. Defaults to 5000.
  --escalation-dir <path>    Directory for gray escalation request files.
  --escalation-reply-dir <path>
                             Directory for signed human reply files.
  --escalation-timeout-ms <ms>
                             Gray escalation wait timeout. Defaults to ESCALATION_TIMEOUT_MS or 120000.
  --escalation-timeout-action <decline|queue>
                             On timeout, decline immediately or keep a durable queued request for later grant/resume.
                             Defaults to decline.
  --escalation-public-key <path>
                             X.509/SPKI public key used to verify human reply signatures.
  --escalation-public-key-sha256 <hex>
                             SHA-256 (hex) the public-key DER file MUST hash to. Injected by the
                             native launcher (the agent cannot alter the driver's argv) to pin the
                             trust anchor. If set and the on-disk key mismatches, the verifier key is
                             rejected and every escalation/grant fails closed (decline). Omit only for
                             host/dev runs (see --allow-unpinned-verifier-key).
  --allow-unpinned-verifier-key
                             Permit running WITHOUT a pin (host/dev only). Without this flag and
                             without --escalation-public-key-sha256, the verifier key is refused and
                             every escalation/grant fails closed — so a launcher that forgets the pin
                             degrades safely instead of silently trusting a swappable key.
  --preapproval-grants-file <path>
                             Signed human preapproval grant JSONL. Defaults to native no_backup storage on Android.
  --run-id <id>              Override generated run id.
  --agent-id <id>            Agent id for escalation requests.
  --engine <codex|claude>    Which CLI runs the turn. Defaults to "codex". "claude" runs the
                             on-device Claude Code (glibc) headless through
                             $HOME/.shelly-claude-run.sh, answering its can_use_tool requests with
                             the SAME gate / grant / escalation path Codex approvals use.
  --usage-file <path>        Write {"inputTokens","outputTokens"[,"usd"]} for the turn: claude from
                             the stream-json result, codex from the app-server token usage
                             notifications (tokens only, never usd).
  --claude-runner <path>     (claude) Runner script. Defaults to $HOME/.shelly-claude-run.sh.
  --claude-runner-interpreter <path>
                             (claude, host only) Interpreter for the runner. Defaults to "bash";
                             on Android the runner always goes through linker64 + shelly_shell.
  --help                     Show this help.
`);
}

function parsePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`invalid ${label}`);
  return number;
}

function parseNonNegativeInt(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`invalid ${label}`);
  return number;
}

function parseArgs(argv) {
  const args = {
    codexBin: 'codex',
    nodeBin: process.execPath,
    gateScript: DEFAULT_GATE_SCRIPT,
    approvalPolicy: 'untrusted',
    timeoutMs: 300000,
    gateTimeoutMs: 5000,
    escalationDir: process.env.SHELLY_AGENT_ESCALATION_DIR || DEFAULT_ESCALATION_DIR,
    escalationReplyDir: process.env.SHELLY_AGENT_ESCALATION_REPLY_DIR || DEFAULT_ESCALATION_REPLY_DIR,
    escalationPublicKey: process.env.SHELLY_AGENT_ESCALATION_PUBLIC_KEY || DEFAULT_ESCALATION_PUBLIC_KEY,
    escalationPublicKeySha256: process.env.SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256 || null,
    allowUnpinnedVerifierKey: process.env.SHELLY_AGENT_ALLOW_UNPINNED_VERIFIER_KEY === '1',
    preapprovalGrantsFile: process.env.SHELLY_AGENT_PREAPPROVAL_GRANTS_FILE || DEFAULT_PREAPPROVAL_GRANTS_FILE,
    escalationTimeoutMs: parseNonNegativeInt(
      process.env.ESCALATION_TIMEOUT_MS || DEFAULT_ESCALATION_TIMEOUT_MS,
      'ESCALATION_TIMEOUT_MS',
    ),
    escalationTimeoutAction: process.env.SHELLY_AGENT_ESCALATION_TIMEOUT_ACTION || 'decline',
    runId: process.env.SHELLY_AGENT_RUN_ID || crypto.randomUUID(),
    agentId: process.env.SHELLY_AGENT_ID || 'host',
    engine: 'codex',
    usageFile: null,
    claudeRunner: path.join(process.env.HOME || process.cwd(), '.shelly-claude-run.sh'),
    claudeRunnerInterpreter: 'bash',
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[++i];
    };

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--cwd') {
      args.cwd = next();
    } else if (arg === '--prompt') {
      args.prompt = next();
    } else if (arg === '--prompt-file') {
      args.promptFile = next();
    } else if (arg === '--policy-json') {
      args.policyJson = next();
    } else if (arg === '--policy-file') {
      args.policyFile = next();
    } else if (arg === '--gate-script') {
      args.gateScript = next();
    } else if (arg === '--codex-bin') {
      args.codexBin = next();
    } else if (arg === '--node-bin') {
      args.nodeBin = next();
    } else if (arg === '--approval-policy') {
      args.approvalPolicy = next();
    } else if (arg === '--audit-log') {
      args.auditLog = next();
    } else if (arg === '--answer-file') {
      args.answerFile = next();
    } else if (arg === '--timeout-ms') {
      args.timeoutMs = Number(next());
    } else if (arg === '--gate-timeout-ms') {
      args.gateTimeoutMs = parsePositiveInt(next(), '--gate-timeout-ms');
    } else if (arg === '--escalation-dir') {
      args.escalationDir = next();
    } else if (arg === '--escalation-reply-dir') {
      args.escalationReplyDir = next();
    } else if (arg === '--escalation-timeout-ms') {
      args.escalationTimeoutMs = parseNonNegativeInt(next(), '--escalation-timeout-ms');
    } else if (arg === '--escalation-timeout-action') {
      args.escalationTimeoutAction = next();
    } else if (arg === '--escalation-public-key') {
      args.escalationPublicKey = next();
    } else if (arg === '--escalation-public-key-sha256') {
      args.escalationPublicKeySha256 = next();
    } else if (arg === '--allow-unpinned-verifier-key') {
      args.allowUnpinnedVerifierKey = true;
    } else if (arg === '--preapproval-grants-file') {
      args.preapprovalGrantsFile = next();
    } else if (arg === '--run-id') {
      args.runId = next();
    } else if (arg === '--agent-id') {
      args.agentId = next();
    } else if (arg === '--engine') {
      args.engine = next();
    } else if (arg === '--usage-file') {
      args.usageFile = next();
    } else if (arg === '--claude-runner') {
      args.claudeRunner = next();
    } else if (arg === '--claude-runner-interpreter') {
      args.claudeRunnerInterpreter = next();
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function readJsonArg(args) {
  if (args.policyJson && args.policyFile) {
    throw new Error('use only one of --policy-json or --policy-file');
  }
  if (args.policyJson) return JSON.parse(args.policyJson);
  if (args.policyFile) return JSON.parse(fs.readFileSync(args.policyFile, 'utf8'));
  return {};
}

// POLICY-001 (lib/agent-action-policy.ts): flag-gated OFF via
// SHELLY_AGENT_POLICY=1 (exported by the generated .sh from .env). Returns
// null when off. Fail-closed: a policy.json that exists but cannot be read or
// parsed sets rulesUnavailable, which the gate turns into "escalate every
// side effect"; only a genuinely missing file means "no user rules".
// SHELLY_RUN_ORIGIN comes from native (AgentRuntime.kt); missing ⇒ the gate
// treats the run as proactive.
// Mirror of lib/agent-user-policy-store.ts isSealedPolicyState. `bytes` null
// ⇒ the file does not exist. An empty seal accepts only a missing/empty file.
function policySealAccepts(sealRaw, bytes, everSealed) {
  const raw = String(sealRaw || '').trim();
  const seal = raw ? raw.split(',') : [];
  if (seal.some((h) => !/^[0-9a-f]{64}$/.test(h))) return false;
  // Re-review M1: once native says a seal was EVER written (Keystore marker),
  // an empty seal means it was deleted, not "first run".
  if (seal.length === 0) return String(everSealed || '') !== '1' && (bytes === null || !bytes.toString('utf8').trim());
  if (bytes === null) return false;
  return seal.includes(crypto.createHash('sha256').update(bytes).digest('hex'));
}

function buildActionPolicyInput(env, home) {
  if (!env || env.SHELLY_AGENT_POLICY !== '1') return null;
  const out = { enabled: true, origin: String(env.SHELLY_RUN_ORIGIN || ''), rules: [], homeDir: home || '', rulesUnavailable: false };
  if (!home) {
    out.rulesUnavailable = true;
    return out;
  }
  let bytes = null;
  try {
    bytes = fs.readFileSync(path.join(home, '.shelly/agents/policy.json'));
  } catch (e) {
    if (!e || e.code !== 'ENOENT') out.rulesUnavailable = true;
  }
  const text = bytes === null ? null : bytes.toString('utf8');
  // Security review M1: the file must match the seal native exported
  // (SHELLY_AGENT_POLICY_SEAL, written by RN with every policy write). A
  // deleted / edited / unsealed file means the user's rules can't be trusted.
  if (!policySealAccepts(env.SHELLY_AGENT_POLICY_SEAL, bytes, env.SHELLY_AGENT_POLICY_EVER_SEALED)) out.rulesUnavailable = true;
  if (text !== null && text.trim()) {
    try {
      const parsed = JSON.parse(text);
      const rules = parsed && parsed.userPolicy && parsed.userPolicy.rules;
      if (Array.isArray(rules)) out.rules = rules;
      else out.rulesUnavailable = true;
    } catch (_) {
      out.rulesUnavailable = true;
    }
  }
  return out;
}

function readPrompt(args) {
  if (args.prompt && args.promptFile) {
    throw new Error('use only one of --prompt or --prompt-file');
  }
  if (args.promptFile) return fs.readFileSync(args.promptFile, 'utf8');
  if (args.prompt) return args.prompt;
  throw new Error('missing --prompt or --prompt-file');
}

// 2026-11-02 (build 2790): workers verified their output with `node -e
// '…new Function(…)'`, which runs code and therefore always asks a human —
// even under "承認なしで実行（すべて）". `node --check <file>` on a file in the
// workspace or $TMPDIR is a read-only syntax check that level answers. The
// hint only steers the worker; the gate decides exactly as before.
const WORKER_PROMPT_HINT = 'To check syntax, run `node --check <file>` (for an inline <script> in HTML, first copy the script into a .js file in the workspace or $TMPDIR); do not use `node -e`, `python -c`, or git for checks. Keep scratch files in the workspace or $TMPDIR.';

function workerPrompt(prompt) {
  return `${String(prompt)}\n\n${WORKER_PROMPT_HINT}`;
}

function ensureConfig(args) {
  if (args.help) return args;
  if (!args.cwd) throw new Error('missing --cwd');
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('invalid --timeout-ms');
  if (!Number.isFinite(args.gateTimeoutMs) || args.gateTimeoutMs <= 0) {
    throw new Error('invalid --gate-timeout-ms');
  }
  if (!Number.isFinite(args.escalationTimeoutMs) || args.escalationTimeoutMs < 0) {
    throw new Error('invalid --escalation-timeout-ms');
  }
  if (!['decline', 'queue'].includes(args.escalationTimeoutAction)) {
    throw new Error('invalid --escalation-timeout-action: expected "decline" or "queue"');
  }
  if (args.approvalPolicy !== 'untrusted') {
    throw new Error('invalid --approval-policy: autonomous driver only allows "untrusted"');
  }
  if (!['codex', 'claude'].includes(args.engine)) {
    throw new Error('invalid --engine: expected "codex" or "claude"');
  }

  const requestedCwd = path.resolve(args.cwd);
  if (!fs.existsSync(requestedCwd)) fs.mkdirSync(requestedCwd, { recursive: true });
  const cwd = fs.realpathSync(requestedCwd);
  const prompt = readPrompt(args);
  const policy = readJsonArg(args);
  // Workspace root is realpathed here; per-argument symlink resolution remains a later hardening gap.
  policy.workspaceRoot = cwd;
  if (!policy.level) policy.level = 'L2';
  // POLICY-001: the action-policy input is ALWAYS derived here from the live
  // environment + policy.json, never trusted from the (baked) --policy-json —
  // a stale or tampered script must not be able to smuggle its own rules in.
  delete policy.actionPolicy;
  const actionPolicy = buildActionPolicyInput(process.env, process.env.HOME || '');
  if (actionPolicy) policy.actionPolicy = actionPolicy;

  return {
    ...args,
    cwd,
    prompt,
    policy,
    gateScript: path.resolve(args.gateScript),
    escalationDir: path.resolve(args.escalationDir),
    // Security: production replies must verify against the native
    // Android-Keystore-backed signature before accept is honored.
    escalationReplyDir: path.resolve(args.escalationReplyDir),
    escalationPublicKey: path.resolve(args.escalationPublicKey),
    // Pin (SHA-256 hex of the DER) injected out-of-band by the native launcher so a same-uid
    // agent that overwrites the key file cannot substitute its own key. Normalized to lowercase hex.
    escalationPublicKeySha256: normalizeSha256Hex(args.escalationPublicKeySha256),
    preapprovalGrantsFile: path.resolve(args.preapprovalGrantsFile),
    answerFile: args.answerFile ? path.resolve(args.answerFile) : null,
    usageFile: args.usageFile ? path.resolve(args.usageFile) : null,
    claudeRunner: path.resolve(args.claudeRunner),
  };
}

function normalizeSha256Hex(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().toLowerCase();
  if (!hex) return null;
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('invalid --escalation-public-key-sha256: expected 64 hex chars');
  }
  return hex;
}

function existingPath(candidate) {
  return Boolean(candidate && fs.existsSync(candidate));
}

function isLinkerPath(candidate) {
  return path.basename(candidate || '') === 'linker64';
}

function resolveShellyLibDir() {
  const candidates = [];
  if (process.env.SHELLY_LIB_DIR) candidates.push(process.env.SHELLY_LIB_DIR);
  if (process.env.SHELLY_LD_LIBRARY_PATH) {
    candidates.push(...process.env.SHELLY_LD_LIBRARY_PATH.split(':').filter(Boolean));
  }
  if (process.env.HOME) candidates.push(path.resolve(process.env.HOME, '../termux-libs'));

  for (const candidate of candidates) {
    if (existingPath(path.join(candidate, 'node'))) {
      return candidate;
    }
  }
  return '';
}

function androidLauncherContext() {
  const libDir = resolveShellyLibDir();
  if (!existingPath(ANDROID_LINKER64) || !libDir) return null;
  return { libDir };
}

// The worker follows `agent-current`, never `current`. `current` is the newest
// Codex that passed the device probes, for the TUI; the worker's safety rests on
// protocol details a probe does not look at (approval requests, item types,
// features, MCP), so no update may move it on its own (plan 6.2). Nothing creates
// `agent-current` until the CI contract tests exist (Inc 4/5), so today the worker
// runs the codex_tui bundled in this APK. That version changes only by a reviewed
// edit of .ci-versions/codex-termux-deb.json. No automated test has run it against
// this driver yet; that review is the whole check.
//
// Resolve the link to its real versioned directory once, before anything else
// reads it, and run from there. Codex finds codex-code-mode-host next to its own
// path (SHELLY_CODEX_EXEC_PATH via the /proc/self/exe shim), and that host speaks
// a version-pinned protocol: launched through the symlink, a running worker
// would start the NEW host after an update switched the link. Only the
// directory is resolved, never the file, so the siblings stay beside codex_tui.
// Same recipe as HomeInitializer.kt __shelly_codex_runtime_tui.
function runtimeCodexTuiPath(home) {
  if (!home || process.env.SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME === '1') return '';
  let runtimeDir;
  try {
    runtimeDir = fs.realpathSync(path.join(home, '.shelly-runtime/codex/agent-current'));
  } catch {
    return '';
  }
  const tuiPath = path.join(runtimeDir, 'codex_tui');
  if (
    existingPath(path.join(runtimeDir, '.healthy')) &&
    existingPath(path.join(runtimeDir, 'manifest.json')) &&
    existingPath(tuiPath)
  ) {
    return tuiPath;
  }
  return '';
}

function resolveAndroidCodexTui(libDir) {
  if (process.env.SHELLY_CODEX_TUI_PATH && existingPath(process.env.SHELLY_CODEX_TUI_PATH)) {
    return process.env.SHELLY_CODEX_TUI_PATH;
  }
  return runtimeCodexTuiPath(process.env.HOME) || path.join(libDir, 'codex_tui');
}

function resolveAndroidNode(config, libDir) {
  if (
    config.nodeBin &&
    path.isAbsolute(config.nodeBin) &&
    existingPath(config.nodeBin) &&
    !isLinkerPath(config.nodeBin)
  ) {
    return config.nodeBin;
  }
  return path.join(libDir, 'node');
}

function androidPathEnv(libDir) {
  const entries = [];
  if (process.env.HOME) entries.push(path.join(process.env.HOME, 'bin'));
  entries.push(libDir);
  if (process.env.PATH) entries.push(process.env.PATH);
  entries.push('/system/bin', '/vendor/bin');
  return Array.from(new Set(entries.filter(Boolean).flatMap((entry) => entry.split(':').filter(Boolean)))).join(':');
}

function androidBaseEnv(libDir) {
  return {
    ...process.env,
    SHELLY_LIB_DIR: libDir,
    PATH: androidPathEnv(libDir),
    TMPDIR: process.env.TMPDIR || (process.env.HOME ? path.join(process.env.HOME, 'tmp') : os.tmpdir()),
  };
}

// Codex runs tool commands through its own shell, so the interactive bash
// python3() wrapper (which sets PYTHONHOME/PYTHONPATH) is bypassed. Exec'd via
// libexec_wrapper.so -> linker64, CPython can't derive its prefix from
// /proc/self/exe and dies with "Failed to import encodings module". Mirror
// HomeInitializer.kt __shelly_python_stdlib (BASHRC_VERSION 248): find the
// stdlib by its encodings/__init__.py landmark (bundled, then dev-tools pack —
// on device the PATH python3 is $libDir/python3 while the stdlib may only exist
// under packs/dev-tools/python3.13); never override a caller-provided
// PYTHONHOME. Also carry the device time zone (persist.sys.timezone) as TZ
// when unset, so Codex's clock isn't UTC.
function resolvePythonStdlib(libDir) {
  for (const dir of [path.join(libDir, 'python3.13'), path.join(libDir, 'packs/dev-tools/python3.13')]) {
    if (existingPath(path.join(dir, 'encodings/__init__.py'))) return dir;
  }
  return '';
}

function androidToolEnv(libDir, input = process.env, readTimezone = readAndroidTimezone) {
  const extra = {};
  if (!input.PYTHONHOME) {
    const stdlib = resolvePythonStdlib(libDir);
    if (stdlib) {
      const dynload = path.join(stdlib, 'lib-dynload');
      const entries = existingPath(dynload) ? `${stdlib}:${dynload}` : stdlib;
      extra.PYTHONHOME = stdlib;
      extra.PYTHONPATH = input.PYTHONPATH ? `${entries}:${input.PYTHONPATH}` : entries;
    }
  }
  if (!input.TZ) {
    const tz = readTimezone();
    if (tz) extra.TZ = tz;
  }
  // chrono (Codex's clock) finds Android tzdata only via these (BASHRC_VERSION 247).
  if (!input.ANDROID_ROOT) extra.ANDROID_ROOT = '/system';
  if (!input.ANDROID_DATA) extra.ANDROID_DATA = '/data';
  return extra;
}

const CODEX_POLICY_ENV_KEYS = ['PYTHONHOME', 'PYTHONPATH', 'TZ', 'ANDROID_ROOT', 'ANDROID_DATA'];

// Codex builds tool-command env from its shell_environment_policy (and a
// login-shell snapshot); `set` entries are applied last, so pass these
// explicitly as `-c shell_environment_policy.set.<VAR>="<value>"`. Values that
// would need TOML escaping (`"`, `\`, control chars) are skipped.
function codexPolicyEnvArgs(env) {
  const args = [];
  for (const key of CODEX_POLICY_ENV_KEYS) {
    const value = env[key];
    if (!value || /["\\\u0000-\u001f\u007f]/.test(value)) continue;
    args.push('-c', `shell_environment_policy.set.${key}="${value}"`);
  }
  // Codex's shell snapshot (features.shell_snapshot, default on) does not work
  // under the linker64/libexec_wrapper exec chain on Android and drops the
  // policy env from tool commands (HomeInitializer.kt BASHRC_VERSION 249).
  if (env.SHELLY_CODEX_SHELL_SNAPSHOT !== '1') args.push('-c', 'features.shell_snapshot=false');
  return args;
}

function readAndroidTimezone() {
  try {
    const tz = execFileSync('/system/bin/getprop', ['persist.sys.timezone'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[A-Za-z0-9_+\-/]+$/.test(tz) ? tz : '';
  } catch (_) {
    return '';
  }
}

// 2026-11-02 review: variables that make an otherwise read-only command run
// code: NODE_OPTIONS (`--require` for `node --check`), BASH_ENV (sourced by a
// non-interactive bash, incl. `bash -n`), ENV (sh), PROMPT_COMMAND, and
// CDPATH (changes where `cd rel` lands — the "all" level follows cwd
// lexically). The "all" level's syntax-check / cd allowances depend on the
// worker (and the gate) never inheriting them. NODE_PATH is kept: it only
// changes module lookup for `require`, which `node --check` never runs.
const WORKER_ENV_DROP = ['NODE_OPTIONS', 'BASH_ENV', 'ENV', 'CDPATH', 'PROMPT_COMMAND'];

function sanitizeWorkerEnv(input) {
  const env = { ...input };
  for (const key of WORKER_ENV_DROP) delete env[key];
  return env;
}

function codexChildEnv(input) {
  const env = sanitizeWorkerEnv(input);
  delete env.SHELLY_AGENT_ESCALATION_DIR;
  delete env.SHELLY_AGENT_ESCALATION_REPLY_DIR;
  delete env.SHELLY_AGENT_RUN_ID;
  delete env.SHELLY_AGENT_ID;
  delete env.SHELLY_AGENT_ESCALATION_PUBLIC_KEY;
  delete env.SHELLY_AGENT_ESCALATION_PUBLIC_KEY_SHA256;
  delete env.SHELLY_AGENT_ALLOW_UNPINNED_VERIFIER_KEY;
  delete env.ESCALATION_TIMEOUT_MS;
  return env;
}

// 2026-11-04 review: the isolated CODEX_HOME only helps if nothing in the
// environment reroutes Codex around the generated config. CODEX_* (profile /
// config / home / CA selectors) and OPENAI_* (OPENAI_BASE_URL, ORG, PROJECT,
// API keys) are therefore removed from the Codex worker's children (preflight
// and app-server); the only CODEX_* var they get is the CODEX_HOME the driver
// sets. API keys are dropped too: the worker authenticates with the ChatGPT
// login in auth.json (lib/agent-credential-policy.ts: codex = OAuth, "NO API
// key in env"), and nothing in Shelly sets OPENAI_API_KEY / CODEX_API_KEY for
// it. Proxy vars (HTTPS_PROXY & co.) are kept: Shelly sets them only for the
// Claude runner, a host user may need one, and TLS still has to verify (the CA
// override CODEX_CA_CERTIFICATE is dropped by the prefix rule). Only the NAMES
// of dropped vars are audited (driver_start.codexEnvDropped), never values.
const CODEX_WORKER_ENV_ROUTING = /^(CODEX_|OPENAI_)/i;
// Credentials in the environment reach every tool command the worker runs, and
// from there a search query. Nothing the worker needs is named this way: Codex
// signs in through auth.json, the launch recipe (SHELLY_*, LD_*, PYTHON*, SSL_*)
// has no such name, and the gate gets its own env (gateSpawnSpec). So there is
// no exception list. A tool command that needs GH_TOKEN and the like loses it.
const CODEX_WORKER_ENV_SECRET = /KEY|TOKEN|SECRET/i;

/** → {env, dropped: [names]}; CODEX_HOME is set only from `codexHome`. */
function codexWorkerEnv(input, codexHome) {
  const env = { ...input };
  const dropped = [];
  for (const key of Object.keys(env)) {
    if (CODEX_WORKER_ENV_ROUTING.test(key) || CODEX_WORKER_ENV_SECRET.test(key)) {
      delete env[key];
      if (key !== 'CODEX_HOME') dropped.push(key);
    }
  }
  if (codexHome) env.CODEX_HOME = codexHome;
  return { env, dropped: dropped.sort() };
}

// ─── MCP servers / ChatGPT apps are off for the Codex worker ──────────────
// MCP and app (connector) tool calls run inside Codex: app-server sends no
// approval request for them that this driver could gate (only command and
// file-change approvals), so they would reach the network outside Shelly's
// gate. The worker therefore never loads them (the Claude worker does the
// same with --strict-mcp-config). Verified against codex-cli 0.144.4 on the
// dev PC (2026-11-04): `-c mcp_servers={}` does NOT clear the table (config
// layers merge), so every configured server is disabled by name with
// `mcp_servers.<name>.enabled=false` (documented key); `features.plugins=false`
// drops plugin-bundled servers; `features.apps=false` + `apps._default.enabled
// =false` turn ChatGPT apps off (documented keys). `-c features.<unknown>=false`
// is ignored, while `--disable <unknown>` is a hard error, so features are
// passed with -c (they differ between Codex versions). The server names come
// from `codex mcp list --json`, and a second listing must show every server
// disabled, or the worker does not start (codexMcpPreflight).
const CODEX_WORKER_DISABLED_FEATURES = [
  'apps',
  'plugins',
  'enable_mcp_apps',
  'skill_mcp_dependency_install',
  'tool_suggest',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'remote_plugin',
  // Lifecycle hooks run commands outside the gate (codex-cli 0.144.4 lists
  // the feature as `hooks`; older builds called it `codex_hooks`).
  'hooks',
  'codex_hooks',
  // Default-on in 0.163 (codex-rs/features/src/lib.rs). Their items are not in
  // CODEX_HARMLESS_ITEM_TYPES, so an enabled tool would only get the run
  // stopped: sub-agents (collabAgentToolCall / subAgentActivity) and view_image
  // (imageView reads a local file with no approval request). Turned off so the
  // model is never offered them; the item check stays as the backstop.
  'multi_agent',
  'multi_agent_v2',
  'view_image',
];

// ─── Codex thread items: an allowlist, not a list of known-bad types ──────
// The counterpart of Claude's tool_use check (layer 4 below). Only command and
// file-change items carry an approval request this driver can gate, so any
// other type that does something would run past the gate, and a new Codex
// version can add one at any time. Checked against the ThreadItem enum in
// codex-rs/app-server-protocol/src/protocol/v2/item.rs at rust-v0.163.0 (the
// fork we ship, v0.163.0-termux.3, has the same 19 variants) and rust-v0.167.0
// (same list).
//
// Gated: commandExecution, fileChange (approval requests, gateCommandActions).
// Stopped by the MCP check: mcpToolCall.
// Stopped here because they are in neither set below:
//   hookPrompt            a hook ran (hooks are off for the worker)
//   functionCallOutput    the result of a named tool; turn/start sends text only
//   dynamicToolCall       client-defined tool; this driver registers none
//   collabAgentToolCall   spawns / drives a sub-agent
//   subAgentActivity      a sub-agent was started or used
//   imageView             view_image read a local file with no gate
//   anything else, or an item with no type.
// Harmless = conversation records and markers, plus the two tools OpenAI hosts:
//   webSearch             runs on OpenAI's side, nothing on the device. No
//                         approval, owner decision (DEFERRED.md). Mode indexed;
//                         every completed search leaves a codex_web_search audit
//                         line, and one carrying a secret stops the run
//   imageGeneration       same; the file lands in the per-run CODEX_HOME
//   sleep                 display item of the interruptible clock.sleep tool
//   enteredReviewMode / exitedReviewMode  markers (this driver never starts one)
const CODEX_GATED_ITEM_TYPES = new Set(['commandExecution', 'fileChange']);
const CODEX_HARMLESS_ITEM_TYPES = new Set([
  'userMessage',
  'agentMessage',
  'plan',
  'reasoning',
  'contextCompaction',
  'sleep',
  'webSearch',
  'imageGeneration',
  'enteredReviewMode',
  'exitedReviewMode',
]);

// ─── Web search: allowed with no prompt, but not a way to send a secret ────
// Mode: "cached" does not hold, because under danger-full-access upstream's
// resolve_web_search_mode_for_turn turns it into live. "indexed" is honoured
// (rust-v0.163.0, rust-v0.167.0 and the fork tag have the same code).
const CODEX_WORKER_WEB_SEARCH_MODE = 'indexed';
const CODEX_WEB_SEARCH_AUDIT_MAX = 120;
const CODEX_LEAK_SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD/i;
const CODEX_LEAK_MIN_LENGTH = 16;

// A header.payload.signature run. Scanned by segment, not with one regex: a
// failed match from every "eyJ" in a long line is quadratic (152 s on 300 KB of
// worker output would stall the event loop that answers approvals).
function hasJwtShape(text) {
  for (const run of text.split(/[^A-Za-z0-9_.-]+/)) {
    const parts = run.split('.');
    for (let i = 0; i + 2 < parts.length; i += 1) {
      if (parts[i + 1].length >= 11 && parts[i + 1].startsWith('eyJ') && parts[i + 2].length >= 8
        && /(?:^|[^A-Za-z0-9_])eyJ[A-Za-z0-9_-]{8}/.test(parts[i])) return true;
    }
  }
  return false;
}

// Shapes only: length or randomness alone never stops a run (git SHAs, UUIDs).
// The sk- body must be mixed case with a digit, so sk-learn-style words pass.
const CODEX_LEAK_FORMATS = [
  ['sk_key', /\bsk-[A-Za-z0-9_-]{20,}/g, (m) => /[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m)],
  ['github_token', /\bgh[pousr]_[A-Za-z0-9]{36,}/g],
  ['groq_key', /\bgsk_[A-Za-z0-9]{20,}/g],
  ['google_key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['jwt', hasJwtShape],
  ['pem_private_key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{16,}/g],
];

function codexLeakForms(value) {
  const base64 = Buffer.from(value, 'utf8').toString('base64');
  const unpadded = base64.replace(/=+$/, '');
  return [...new Set([value, encodeURIComponent(value), base64, unpadded, unpadded.replace(/\+/g, '-').replace(/\//g, '_')])];
}

/**
 * Known values, read once before Codex starts: the login tokens in the real
 * auth.json and secret-named env entries of 16+ characters. Public keys and
 * paths are named like secrets but are not. A token refreshed during the run is
 * not here; the JWT format still catches the access token.
 */
function codexLeakSecrets(env, authJsonText) {
  const secrets = [];
  const add = (detector, value) => {
    if (typeof value === 'string' && value.length >= CODEX_LEAK_MIN_LENGTH) {
      secrets.push({ detector, forms: codexLeakForms(value) });
    }
  };
  for (const [name, value] of Object.entries(env || {})) {
    if (!CODEX_LEAK_SECRET_NAME.test(name) || /PUBLIC/i.test(name)) continue;
    if (typeof value === 'string' && value.startsWith('/')) continue;
    add('env_value', value);
  }
  try {
    const auth = JSON.parse(authJsonText);
    add('auth_token', auth && auth.OPENAI_API_KEY);
    const tokens = auth && auth.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
    for (const [name, value] of Object.entries(tokens)) {
      if (/token/i.test(name)) add('auth_token', value);
    }
  } catch {}
  return secrets;
}

function codexLeakVariants(text) {
  const spaced = text.replace(/\+/g, ' ');
  try {
    return [text, decodeURIComponent(text), decodeURIComponent(spaced)];
  } catch {
    return [text, spaced];
  }
}

/** The detector name for the first hit, or null. Never returns the value. */
function codexLeakDetect(text, secrets) {
  if (typeof text !== 'string' || text === '') return null;
  for (const variant of codexLeakVariants(text)) {
    for (const secret of secrets || []) {
      if (secret.forms.some((form) => variant.includes(form))) return secret.detector;
    }
    for (const [detector, pattern, accept] of CODEX_LEAK_FORMATS) {
      if (typeof pattern === 'function') {
        if (pattern(variant)) return detector;
        continue;
      }
      for (const match of variant.matchAll(pattern)) {
        if (!accept || accept(match[0])) return detector;
      }
    }
  }
  return null;
}

/**
 * The fields of a completed search that left the device. Not item.query: after
 * the first query it is cut with " ...", so a value there can be incomplete.
 */
function codexWebSearchActionTexts(item) {
  const action = item && item.action && typeof item.action === 'object' ? item.action : {};
  const queries = Array.isArray(action.queries) ? action.queries : [];
  return [...queries, action.query, action.url, action.pattern].filter((value) => typeof value === 'string' && value !== '');
}

/** → null, or {detector, itemId}. */
function codexWebSearchLeakCheck(item, secrets) {
  for (const text of codexWebSearchActionTexts(item)) {
    const detector = codexLeakDetect(text, secrets);
    if (detector) {
      return { detector, itemId: item && typeof item.id === 'string' ? item.id.slice(0, 120) : null };
    }
  }
  return null;
}

/**
 * The record of one webSearch item. Text is checked whole, then redacted, then
 * cut; a value redact() would miss is withheld, not logged. Used on item/completed
 * because the query is empty on item/started.
 */
function codexWebSearchAudit(item, secrets) {
  const action = item && item.action && typeof item.action === 'object' ? item.action : {};
  const text = [...codexWebSearchActionTexts(item), item && item.query]
    .find((value) => typeof value === 'string' && value !== '');
  const withheld = codexLeakDetect(text, secrets) || codexLeakDetect(item && item.query, secrets);
  const entry = {
    itemId: item && typeof item.id === 'string' ? item.id.slice(0, 120) : null,
    action: typeof action.type === 'string' ? action.type.slice(0, 40) : null,
    query: text && !withheld ? redact(text).slice(0, CODEX_WEB_SEARCH_AUDIT_MAX) : '',
  };
  return withheld ? { ...entry, withheld } : entry;
}

/**
 * The wire log echoes every server line; a search carrying a secret is not
 * echoed. Checked on the parsed strings: in the raw line a secret holding " or \
 * or a newline is in its escaped form and would not match.
 */
function codexWireLineForLog(line, secrets) {
  if (!/webSearch|web_search/.test(line)) return line;
  let pending;
  try {
    pending = [JSON.parse(line)];
  } catch {
    pending = [line];
  }
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') {
      const detector = codexLeakDetect(value, secrets);
      if (detector) return JSON.stringify({ withheld: detector });
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) pending.push(child);
    }
  }
  return line;
}

/** 'gated' | 'harmless' | 'mcp' | 'blocked' (fails closed on a missing type). */
function codexItemDisposition(item) {
  const type = item && typeof item === 'object' ? item.type : undefined;
  if (typeof type !== 'string') return 'blocked';
  if (type === 'mcpToolCall') return 'mcp';
  if (CODEX_GATED_ITEM_TYPES.has(type)) return 'gated';
  return CODEX_HARMLESS_ITEM_TYPES.has(type) ? 'harmless' : 'blocked';
}

// Codex itself only accepts these characters in an MCP server name; anything
// else could not be addressed safely as a dotted -c key, so it fails closed.
const CODEX_MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// mcpServer/startupStatus/updated statuses (lowercased, letters only) that
// mean the server is not running. Anything else — starting, ready, connecting,
// running, an unknown or missing value — is treated as running and blocks.
const MCP_STARTUP_NOT_RUNNING = new Set([
  'disabled',
  'notstarted',
  'failed',
  'cancelled',
  'canceled',
  'stopped',
]);

// The status is a plain string, or an object keyed by the state name
// (e.g. { failed: { error } }); only the state name is kept, never details.
function mcpStartupStatusName(status) {
  if (typeof status === 'string') return status.slice(0, 40);
  if (status && typeof status === 'object' && !Array.isArray(status)) {
    if (typeof status.state === 'string') return status.state.slice(0, 40);
    if (typeof status.status === 'string') return status.status.slice(0, 40);
    const keys = Object.keys(status);
    if (keys.length === 1) return keys[0].slice(0, 40);
  }
  return null;
}

function codexMcpDisableArgs(serverNames = []) {
  const args = [];
  for (const feature of CODEX_WORKER_DISABLED_FEATURES) args.push('-c', `features.${feature}=false`);
  args.push('-c', 'apps._default.enabled=false');
  for (const name of serverNames) {
    if (!CODEX_MCP_SERVER_NAME.test(name)) throw new Error(`unsafe MCP server name: ${String(name).slice(0, 80)}`);
    args.push('-c', `mcp_servers.${name}.enabled=false`);
  }
  return args;
}

/** `codex mcp list --json` → {servers: [{name, enabled}]} or {error}. */
function parseCodexMcpList(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || '').trim());
  } catch (error) {
    return { error: `mcp list output is not JSON: ${error.message}` };
  }
  if (!Array.isArray(parsed)) return { error: 'mcp list output is not an array' };
  const servers = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string') {
      return { error: 'mcp list entry without a name' };
    }
    if (!CODEX_MCP_SERVER_NAME.test(entry.name)) {
      return { error: `unsafe MCP server name: ${entry.name.slice(0, 80)}` };
    }
    servers.push({ name: entry.name, enabled: entry.enabled !== false });
  }
  return { servers };
}

function defaultCodexMcpListRunner(spec, args, cwd) {
  return execFileSync(spec.command, args, {
    cwd,
    env: spec.env,
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Lists the MCP servers this Codex would load for the worker, disables each by
// name, and lists again: the worker starts only when every listed server is
// disabled. Any failure (no listing, unsafe name, a server still enabled) is
// {ok:false} and the driver refuses to start Codex.
function codexMcpPreflight(config, runner = defaultCodexMcpListRunner) {
  const list = (names) => {
    const spec = codexAppServerSpawnSpec(config, names);
    const args = [...spec.prefixArgs, 'mcp', 'list', ...codexMcpDisableArgs(names), '--json'];
    let stdout;
    try {
      stdout = runner(spec, args, config.cwd);
    } catch (error) {
      return { error: `mcp list failed: ${String(error && error.message ? error.message : error).slice(0, 300)}` };
    }
    return parseCodexMcpList(stdout);
  };
  const first = list([]);
  if (first.error) return { ok: false, reason: first.error, names: [] };
  const names = [...new Set(first.servers.map((s) => s.name))].sort();
  if (names.length === 0) return { ok: true, names, configuredCount: 0 };
  const second = list(names);
  if (second.error) return { ok: false, reason: second.error, names };
  const stillEnabled = second.servers.filter((s) => s.enabled || !names.includes(s.name)).map((s) => s.name);
  if (stillEnabled.length > 0) {
    return { ok: false, reason: 'MCP servers still enabled after disabling them by name', names, stillEnabled };
  }
  return { ok: true, names, configuredCount: names.length };
}

// ─── Isolated CODEX_HOME for the Codex worker (prevention) ────────────────
// The -c overrides, the preflight and the notification blocks above only
// react to what Codex reports: an MCP server's startup command (or a hook /
// `notify` command) can run before the driver sees anything, and a server
// missing from `mcp list`, config drift between the preflight and app-server,
// or another profile / config layer bypasses them. So the worker (and its
// preflight) never reads the user's Codex home at all: each run gets a fresh
// CODEX_HOME under $TMPDIR/shelly-codex-homes (mode 0700, removed when the
// driver exits; see ensureCodexIsolatedHomesParent) holding only a marker file
// and
//   - config.toml written here (codexWorkerConfigToml): no [mcp_servers],
//     [profiles], [projects] trust entries, hooks or notify;
//   - auth.json: a symlink to the real $CODEX_HOME/auth.json (default
//     ~/.codex/auth.json), so the ChatGPT login works and a token refresh
//     writes the real file (a refresh that replaces the link is copied back
//     at exit: persistIsolatedCodexAuth). If the link cannot be made the run
//     fails closed.
// Apart from the carried settings below, nothing else is copied: Codex recreates what it needs (installation_id,
// models cache, log/, sessions/ — threads are ephemeral anyway). Without a
// [projects] trust entry Codex does not load the workspace's project layer
// (`.codex/config.toml`, hooks): checked against codex-cli 0.144.4 on the dev
// PC (2026-11-04) — an untrusted project's `.codex/config.toml` MCP server is
// not listed, the same project with a trust entry is. Also seen there: Codex
// skips its PATH helper aliases (`<CODEX_HOME>/tmp/path`, e.g. `apply_patch`
// as a shell command) when CODEX_HOME is under the system temp dir, with a
// warning; patches still arrive as fileChange approvals. The interactive
// `codex` and ~/.codex are unchanged.
// Two things are carried over from the real home so the worker behaves like
// the user's Codex:
//   - model settings: only the allowlisted top-level string keys in
//     CODEX_WORKER_CARRIED_CONFIG_KEYS (model_provider only when it names a
//     built-in provider), read by readCarriedCodexConfig from the lines before
//     the first [table]; values must match CODEX_CARRIED_VALUE. Tables
//     ([model_providers.*], [mcp_servers.*], [profiles.*], …), base_url,
//     env_key, notify, hooks, shell env, sandbox / approval keys and anything
//     unparseable are never copied.
//   - AGENTS.md (Shelly's guide, e.g. ClosePaw usage): copied (not linked)
//     when it is a regular file, not a symlink, of at most 64 KiB.
const CODEX_ISOLATED_HOME_PREFIX = 'shelly-codex-home-';
const CODEX_WORKER_CARRIED_CONFIG_KEYS = Object.freeze([
  'model',
  'model_reasoning_effort',
  'model_reasoning_summary',
  'model_verbosity',
  'model_provider',
]);
const CODEX_BUILTIN_MODEL_PROVIDERS = Object.freeze(['openai']);
const CODEX_CARRIED_VALUE = /^[A-Za-z0-9._:-]{1,64}$/;
const CODEX_REAL_CONFIG_MAX_BYTES = 1024 * 1024;
const CODEX_AGENTS_MD_MAX_BYTES = 64 * 1024;
// Leftovers of a driver that was SIGKILLed (no exit handler ran). Runs are
// capped far below this, so a live run's home is never swept.
const CODEX_ISOLATED_HOME_STALE_MS = 24 * 60 * 60 * 1000;

function realCodexHome(env = process.env) {
  if (env.CODEX_HOME) return path.resolve(env.CODEX_HOME);
  return path.join(env.HOME || os.homedir(), '.codex');
}

function codexIsolatedHomeParent(env = process.env) {
  if (env.TMPDIR) return env.TMPDIR;
  if (androidLauncherContext() && env.HOME) return path.join(env.HOME, 'tmp');
  return os.tmpdir();
}

/**
 * Allowlisted model settings from the real config.toml text →
 * {values: {key: value}, keys: [...]}. Only `key = "value"` / `key = 'value'`
 * lines before the first table header count; a duplicated key is dropped, as
 * is anything inside a multi-line string. Never throws.
 */
function parseCarriedCodexConfig(text) {
  const found = new Map();
  const dropped = new Set();
  if (typeof text !== 'string') return { values: {}, keys: [] };
  let inMultiline = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (inMultiline) {
      if (line.split(inMultiline).length % 2 === 0) inMultiline = null;
      continue;
    }
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) break;
    for (const delim of ['"""', "'''"]) {
      if (line.split(delim).length % 2 === 0) { inMultiline = delim; break; }
    }
    if (inMultiline) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const value = m[2] !== undefined ? m[2] : m[3];
    if (!CODEX_WORKER_CARRIED_CONFIG_KEYS.includes(key)) continue;
    if (found.has(key) || dropped.has(key)) {
      found.delete(key);
      dropped.add(key);
      continue;
    }
    if (!CODEX_CARRIED_VALUE.test(value)) { dropped.add(key); continue; }
    if (key === 'model_provider' && !CODEX_BUILTIN_MODEL_PROVIDERS.includes(value)) { dropped.add(key); continue; }
    found.set(key, value);
  }
  const keys = CODEX_WORKER_CARRIED_CONFIG_KEYS.filter((key) => found.has(key));
  const values = {};
  for (const key of keys) values[key] = found.get(key);
  return { values, keys };
}

/** Reads the real $CODEX_HOME/config.toml (≤ 1 MiB); missing / unreadable → nothing carried. */
function readCarriedCodexConfig(realHome, fsImpl = fs) {
  try {
    const file = path.join(realHome, 'config.toml');
    const st = fsImpl.statSync(file);
    if (!st.isFile() || st.size > CODEX_REAL_CONFIG_MAX_BYTES) return { values: {}, keys: [] };
    return parseCarriedCodexConfig(fsImpl.readFileSync(file, 'utf8'));
  } catch (_) {
    return { values: {}, keys: [] };
  }
}

/**
 * Copies the real AGENTS.md into the isolated home when it is a regular file
 * (not a symlink) of at most 64 KiB → 'copied' | 'absent' | 'skipped_*'.
 * Never throws; a failed copy leaves no partial file.
 */
function copyCodexAgentsMd(realHome, dir, fsImpl = fs) {
  const src = path.join(realHome, 'AGENTS.md');
  const dest = path.join(dir, 'AGENTS.md');
  let st;
  try {
    st = fsImpl.lstatSync(src);
  } catch (_) {
    return 'absent';
  }
  if (st.isSymbolicLink()) return 'skipped_symlink';
  if (!st.isFile()) return 'skipped_not_file';
  if (st.size > CODEX_AGENTS_MD_MAX_BYTES) return 'skipped_too_large';
  let fd = null;
  try {
    const noFollow = fs.constants && fs.constants.O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0;
    fd = fsImpl.openSync(src, fs.constants.O_RDONLY | noFollow);
    const fst = fsImpl.fstatSync(fd);
    if (!fst.isFile()) return 'skipped_not_file';
    if (fst.size > CODEX_AGENTS_MD_MAX_BYTES) return 'skipped_too_large';
    const buf = Buffer.alloc(CODEX_AGENTS_MD_MAX_BYTES + 1);
    let total = 0;
    for (;;) {
      const n = fsImpl.readSync(fd, buf, total, buf.length - total, null);
      if (n <= 0) break;
      total += n;
      if (total > CODEX_AGENTS_MD_MAX_BYTES) return 'skipped_too_large';
    }
    fsImpl.writeFileSync(dest, buf.subarray(0, total), { mode: 0o600 });
    return 'copied';
  } catch (error) {
    try { fsImpl.rmSync(dest, { force: true }); } catch (_) {}
    return error && error.code === 'ELOOP' ? 'skipped_symlink' : 'skipped_error';
  } finally {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch (_) {} }
  }
}

function codexWorkerConfigToml(carried = {}) {
  const carriedLines = [];
  for (const key of CODEX_WORKER_CARRIED_CONFIG_KEYS) {
    const value = carried ? carried[key] : undefined;
    if (typeof value !== 'string' || !CODEX_CARRIED_VALUE.test(value)) continue;
    if (key === 'model_provider' && !CODEX_BUILTIN_MODEL_PROVIDERS.includes(value)) continue;
    carriedLines.push(`${key} = ${JSON.stringify(value)}`);
  }
  const lines = [
    '# Generated by shelly-agent-driver for one Codex worker run; removed when the run ends.',
    '# Deliberately no [mcp_servers], [profiles], [projects] (trust), hooks or notify.',
    ...(carriedLines.length ? ['# Model settings carried over from the real config.toml (allowlist only).', ...carriedLines] : []),
    'check_for_update_on_startup = false',
    'cli_auth_credentials_store = "file"',
    `web_search = "${CODEX_WORKER_WEB_SEARCH_MODE}"`,
    '',
    '[features]',
    ...CODEX_WORKER_DISABLED_FEATURES.map((feature) => `${feature} = false`),
    '',
    '[apps._default]',
    'enabled = false',
    '',
  ];
  return lines.join('\n');
}

// 2026-11-04 review: TMPDIR may be chosen (or symlinked) by someone else, so
// the per-run homes never live directly in it and the stale sweep never reads
// it. They live in one fixed parent, <tmp>/shelly-codex-homes (inside the
// temp dir; no new persistent directory), which must be a real directory (not
// a symlink) owned by this uid and not group/other-writable — otherwise the
// run fails closed (codex_home_isolation_failed). Each home holds a marker
// file (CODEX_ISOLATED_HOME_MARKER, a random 128-bit token, regular file,
// owned by this uid); the sweep only removes direct children of the verified
// parent that are real directories with that marker, owned by this uid, older
// than a day. fs.rmSync({recursive}) lstat()s every entry and unlinks a
// symlink instead of descending into it (Node's rimraf), so the auth.json
// link and anything Codex left there are removed without touching their
// targets. Owner / mode checks need POSIX uids (process.getuid); on Windows
// (dev PC tests only) just the symlink / directory / marker checks apply.
const CODEX_ISOLATED_HOMES_PARENT = 'shelly-codex-homes';
const CODEX_ISOLATED_HOME_MARKER = '.shelly-codex-home';

function processUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Throws unless `st` is a real directory owned by `uid` and not group/other-writable. */
function assertPrivateDir(st, label, uid = processUid()) {
  if (st.isSymbolicLink()) throw new Error(`${label} is a symlink`);
  if (!st.isDirectory()) throw new Error(`${label} is not a directory`);
  if (uid !== null) {
    if (st.uid !== uid) throw new Error(`${label} is not owned by this user`);
    if ((st.mode & 0o022) !== 0) throw new Error(`${label} is group/other-writable`);
  }
}

/** Creates / verifies <tmp>/shelly-codex-homes → its real path; throws on anything unsafe. */
function ensureCodexIsolatedHomesParent(env = process.env, fsImpl = fs) {
  const parent = path.join(codexIsolatedHomeParent(env), CODEX_ISOLATED_HOMES_PARENT);
  fsImpl.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertPrivateDir(fsImpl.lstatSync(parent), 'isolated home parent');
  const real = fsImpl.realpathSync(parent);
  assertPrivateDir(fsImpl.lstatSync(real), 'isolated home parent');
  return real;
}

function isMarkedCodexIsolatedHome(dir, fsImpl = fs, uid = processUid()) {
  try {
    const st = fsImpl.lstatSync(path.join(dir, CODEX_ISOLATED_HOME_MARKER));
    if (st.isSymbolicLink() || !st.isFile()) return false;
    return uid === null || st.uid === uid;
  } catch (_) {
    return false;
  }
}

/** `parent` must come from ensureCodexIsolatedHomesParent. → names removed. */
function sweepStaleCodexIsolatedHomes(parent, fsImpl = fs, now = Date.now(), uid = processUid()) {
  const removed = [];
  let names = [];
  try {
    names = fsImpl.readdirSync(parent);
  } catch (_) {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(CODEX_ISOLATED_HOME_PREFIX)) continue;
    const dir = path.join(parent, name);
    try {
      const st = fsImpl.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      if (uid !== null && st.uid !== uid) continue;
      if (now - st.mtimeMs <= CODEX_ISOLATED_HOME_STALE_MS) continue;
      if (!isMarkedCodexIsolatedHome(dir, fsImpl, uid)) continue;
      fsImpl.rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (_) {}
  }
  return removed;
}

function removeCodexIsolatedHome(dir, fsImpl = fs) {
  if (!dir) return;
  try {
    // rmSync does not follow the auth.json symlink: the real file stays.
    fsImpl.rmSync(dir, { recursive: true, force: true });
  } catch (_) {}
}

// ─── Persisting a token refresh that replaced the auth.json link ──────────
// Codex may refresh the ChatGPT token by writing a temp file and renaming it
// over auth.json; in the isolated home that replaces the symlink with a
// regular file, so the refreshed (and possibly rotated) token would be lost
// with the home. At exit the driver copies such a file back to the real
// auth.json: ≤ 64 KiB, a JSON object, and only when the real auth.json is
// still a regular file (not a symlink); written as a 0600 temp file in the
// real home, fsync'd and renamed over it. Failure does not change the run's
// result (the work is done, and failing it would not restore the token) but
// is audited (codex_isolated_auth_persist_failed) and printed on stderr — the
// user may have to sign in to Codex again.
const CODEX_AUTH_MAX_BYTES = 64 * 1024;

function readRegularFileCapped(file, maxBytes, fsImpl = fs) {
  const noFollow = fs.constants && fs.constants.O_NOFOLLOW ? fs.constants.O_NOFOLLOW : 0;
  const fd = fsImpl.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > maxBytes) throw new Error('too large');
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const n = fsImpl.readSync(fd, buf, total, buf.length - total, null);
      if (n <= 0) break;
      total += n;
      if (total > maxBytes) throw new Error('too large');
    }
    return buf.subarray(0, total);
  } finally {
    try { fsImpl.closeSync(fd); } catch (_) {}
  }
}

/**
 * → {status: 'linked' | 'persisted' | 'failed', reason?, bytes?}. Never throws.
 * 'linked': auth.json is still the symlink (refreshes went to the real file).
 */
function persistIsolatedCodexAuth(isolatedDir, realHome, fsImpl = fs) {
  const isolated = path.join(isolatedDir, 'auth.json');
  let st;
  try {
    st = fsImpl.lstatSync(isolated);
  } catch (error) {
    return { status: 'failed', reason: `isolated auth.json missing (${error && error.code ? error.code : 'error'})` };
  }
  if (st.isSymbolicLink()) return { status: 'linked' };
  if (!st.isFile()) return { status: 'failed', reason: 'isolated auth.json is not a regular file' };
  let data;
  try {
    data = readRegularFileCapped(isolated, CODEX_AUTH_MAX_BYTES, fsImpl);
  } catch (error) {
    return { status: 'failed', reason: `isolated auth.json unreadable: ${String(error && error.message ? error.message : error).slice(0, 80)}` };
  }
  try {
    const parsed = JSON.parse(data.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  } catch (_) {
    return { status: 'failed', reason: 'isolated auth.json is not a JSON object' };
  }
  const real = path.join(realHome, 'auth.json');
  try {
    const rst = fsImpl.lstatSync(real);
    if (rst.isSymbolicLink() || !rst.isFile()) return { status: 'failed', reason: 'real auth.json is not a regular file' };
  } catch (_) {
    return { status: 'failed', reason: 'real auth.json is missing' };
  }
  const tmp = path.join(realHome, `.auth.json.shelly-${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fsImpl.openSync(tmp, 'wx', 0o600);
    fsImpl.writeSync(fd, data, 0, data.length, 0);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    fsImpl.renameSync(tmp, real);
    return { status: 'persisted', bytes: data.length };
  } catch (error) {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch (_) {} }
    try { fsImpl.rmSync(tmp, { force: true }); } catch (_) {}
    return { status: 'failed', reason: `write failed: ${String(error && error.code ? error.code : error && error.message ? error.message : error).slice(0, 80)}` };
  }
}

/**
 * → {ok:true, dir, realHome, carried: [keys], agentsMd: status} or
 * {ok:false, reason}; never leaves a half-made home.
 */
function createCodexIsolatedHome(env = process.env, fsImpl = fs) {
  const realHome = realCodexHome(env);
  const carried = readCarriedCodexConfig(realHome, fsImpl);
  let dir = null;
  let swept = [];
  try {
    const parent = ensureCodexIsolatedHomesParent(env, fsImpl);
    swept = sweepStaleCodexIsolatedHomes(parent, fsImpl);
    dir = fsImpl.mkdtempSync(path.join(parent, CODEX_ISOLATED_HOME_PREFIX));
    fsImpl.chmodSync(dir, 0o700);
    assertPrivateDir(fsImpl.lstatSync(dir), 'isolated home');
    if (path.resolve(dir) === realHome) throw new Error('isolated home equals the real Codex home');
    fsImpl.writeFileSync(path.join(dir, CODEX_ISOLATED_HOME_MARKER), `${crypto.randomBytes(16).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    fsImpl.writeFileSync(path.join(dir, 'config.toml'), codexWorkerConfigToml(carried.values), { mode: 0o600 });
  } catch (error) {
    removeCodexIsolatedHome(dir, fsImpl);
    return { ok: false, reason: `isolated CODEX_HOME could not be created: ${String(error && error.message ? error.message : error).slice(0, 200)}` };
  }
  try {
    fsImpl.symlinkSync(path.join(realHome, 'auth.json'), path.join(dir, 'auth.json'), 'file');
    if (!fsImpl.lstatSync(path.join(dir, 'auth.json')).isSymbolicLink()) throw new Error('auth.json is not a symlink');
  } catch (error) {
    removeCodexIsolatedHome(dir, fsImpl);
    return { ok: false, reason: `auth.json symlink failed: ${String(error && error.code ? error.code : error && error.message ? error.message : error).slice(0, 200)}` };
  }
  const agentsMd = copyCodexAgentsMd(realHome, dir, fsImpl);
  return { ok: true, dir, realHome, carried: carried.keys, agentsMd, swept: swept.length };
}

function codexAppServerSpawnSpec(config, mcpServerNames = []) {
  const mcpArgs = codexMcpDisableArgs(mcpServerNames);
  const android = androidLauncherContext();
  if (android) {
    const codexTui = resolveAndroidCodexTui(android.libDir);
    const codexDir = path.dirname(codexTui);
    const { env, dropped } = codexWorkerEnv(codexChildEnv({
      ...androidBaseEnv(android.libDir),
      ...androidToolEnv(android.libDir),
      // Keep this recipe in sync with HomeInitializer.kt __shelly_codex_run_tui.
      // The shell wrapper's native-crash fallback is not duplicated here; this
      // selector health-gates app-data runtime before bundled codex_tui fallback.
      SHELLY_CODEX_EXEC_PATH: codexTui,
      SHELLY_CODEX_PROC_EXE_SHIM: '1',
      SHELLY_CODEX_PROC_EXE_OPEN_SHIM: '1',
      LD_PRELOAD: path.join(android.libDir, 'libexec_wrapper.so'),
      LD_LIBRARY_PATH: `${codexDir}:${android.libDir}`,
    }), config && config.codexHome);
    const prefixArgs = [codexTui, ...codexPolicyEnvArgs(env)];
    const args = [...prefixArgs, 'app-server', ...mcpArgs, '--listen', 'stdio://'];
    return {
      mode: 'android-linker64-codex_tui',
      command: ANDROID_LINKER64,
      prefixArgs,
      args,
      env,
      droppedEnv: dropped,
      display: [ANDROID_LINKER64, ...args],
      codexBinary: codexTui,
      codexTui,
      libDir: android.libDir,
    };
  }
  const args = ['app-server', ...mcpArgs, '--listen', 'stdio://'];
  const { env, dropped } = codexWorkerEnv(codexChildEnv(process.env), config && config.codexHome);
  return {
    mode: 'host-path',
    command: config.codexBin,
    prefixArgs: [],
    args,
    env,
    droppedEnv: dropped,
    display: [config.codexBin, ...args],
    codexBinary: null,
    codexTui: null,
    libDir: null,
  };
}

function gateSpawnSpec(config) {
  const android = androidLauncherContext();
  if (android) {
    const nodePath = resolveAndroidNode(config, android.libDir);
    const env = sanitizeWorkerEnv({
      ...androidBaseEnv(android.libDir),
      LD_LIBRARY_PATH: android.libDir,
    });
    delete env.LD_PRELOAD;
    const args = [nodePath, config.gateScript];
    return {
      mode: 'android-linker64-node',
      command: ANDROID_LINKER64,
      args,
      env,
      display: [ANDROID_LINKER64, ...args],
      nodePath,
      libDir: android.libDir,
    };
  }
  const args = [config.gateScript];
  return {
    mode: 'host-path',
    command: config.nodeBin,
    args,
    env: sanitizeWorkerEnv(process.env),
    display: [config.nodeBin, ...args],
    nodePath: config.nodeBin,
    libDir: null,
  };
}

function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b([A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*=)([^\s'"`]+)/gi, '$1[REDACTED]');
}

function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]));
  }
  return value;
}

function extractCommandActions(params, fallbackCwd) {
  const actions = Array.isArray(params && params.commandActions) ? params.commandActions : [];
  if (actions.length > 0) {
    return actions.map((action, index) => ({
      index,
      source: 'commandActions',
      command: action && typeof action.command === 'string' ? action.command.trim() : '',
      cwd: action && typeof action.cwd === 'string' ? action.cwd : fallbackCwd,
      action: redactDeep(action || {}),
    }));
  }
  if (params && typeof params.command === 'string') {
    return [{
      index: 0,
      source: 'command',
      command: params.command.trim(),
      cwd: fallbackCwd,
      action: null,
    }];
  }
  return [{
    index: 0,
    source: 'missing',
    command: '',
    cwd: fallbackCwd,
    action: null,
  }];
}

function extractLegacyCommandActions(params, fallbackCwd) {
  const rawCommand = params && params.command;
  const command = Array.isArray(rawCommand)
    ? rawCommand.map((part) => String(part)).join(' ').trim()
    : typeof rawCommand === 'string'
      ? rawCommand.trim()
      : '';
  return [{
    index: 0,
    source: 'execCommandApproval',
    command,
    cwd: params && typeof params.cwd === 'string' ? params.cwd : fallbackCwd,
    action: null,
  }];
}

function combineGateAnswers(results) {
  if (results.some((result) => result.answer === 'n')) {
    return { answer: 'n', decision: 'decline' };
  }
  if (results.some((result) => result.answer === 'escalate')) {
    return { answer: 'escalate', decision: 'decline' };
  }
  return { answer: 'y', decision: 'accept' };
}

function safeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9_.=-]/g, '_').slice(0, 160);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rawLine(prefix, line) {
  process.stdout.write(`${prefix} ${line}\n`);
}

function createAuditWriter(auditLog) {
  return (kind, payload) => {
    const entry = {
      ts: new Date().toISOString(),
      kind,
      ...redactDeep(payload),
    };
    const line = JSON.stringify(entry);
    process.stdout.write(`AUDIT ${line}\n`);
    appendAuditLine(auditLog, line);
  };
}

function gateLine(auditLog, payload) {
  const entry = {
    ts: new Date().toISOString(),
    kind: 'gate_decision',
    ...redactDeep(payload),
  };
  const line = JSON.stringify(entry);
  process.stdout.write(`GATE ${line}\n`);
  appendAuditLine(auditLog, line);
}

function appendAuditLine(auditLog, line) {
  if (!auditLog) return;
  try {
    fs.appendFileSync(auditLog, `${line}\n`);
  } catch (error) {
    const fallback = {
      ts: new Date().toISOString(),
      kind: 'audit_append_failed',
      auditLog,
      error: error.message,
      line,
    };
    process.stdout.write(`AUDIT_FALLBACK ${JSON.stringify(redactDeep(fallback))}\n`);
  }
}

function runGate(config, command) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const gateSpawn = gateSpawnSpec(config);
    const child = spawn(gateSpawn.command, gateSpawn.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: config.cwd,
      env: gateSpawn.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        elapsedMs: Date.now() - startedAt,
        ...result,
      });
    };

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      }, 250).unref();
      finish({
        answer: 'escalate',
        error: `gate timeout after ${config.gateTimeoutMs}ms`,
        rawStdout: stdout,
        rawStderr: stderr,
      });
    }, config.gateTimeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      finish({
        answer: 'escalate',
        error: `gate spawn failed: ${error.message}`,
        rawStdout: stdout,
        rawStderr: stderr,
      });
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        finish({
          answer: 'escalate',
          error: `gate exited code=${code} signal=${signal}`,
          rawStdout: stdout,
          rawStderr: stderr,
        });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim() || '{}');
        const answer = parsed.answer === 'y' || parsed.answer === 'n' || parsed.answer === 'escalate'
          ? parsed.answer
          : 'escalate';
        finish({
          answer,
          outcome: parsed,
          rawStdout: stdout,
          rawStderr: stderr,
        });
      } catch (error) {
        finish({
          answer: 'escalate',
          error: `gate output parse failed: ${error.message}`,
          rawStdout: stdout,
          rawStderr: stderr,
        });
      }
    });

    child.stdin.end(JSON.stringify({ command, policy: config.policy }));
  });
}

function mapGateToDecision(answer) {
  if (answer === 'y') return 'accept';
  if (answer === 'n') return 'decline';
  return 'decline';
}

function isHumanEscalation(result) {
  const verdict = result.outcome && result.outcome.verdict ? result.outcome.verdict : null;
  return result.answer === 'escalate' && !result.error && verdict && verdict.decision === 'gray';
}

// Strict `=== true`: a malformed/absent flag never opts a run INTO the
// unattended fast-decline — it falls back to the attended escalation wait
// (today's semantics). The TS side (buildAgentPolicy/generateRunScript) bakes
// unattended:true into every STORED script (alarm/native fires) and
// unattended:false only for foreground-ladder attempts.
function isUnattendedPolicy(policy) {
  return !!policy && policy.unattended === true;
}

function buildEscalationPaths(config, reqId) {
  const base = `req-${safeFilePart(config.runId)}-${safeFilePart(reqId)}`;
  return {
    requestPath: path.join(config.escalationDir, `${base}.json`),
    replyPath: path.join(config.escalationReplyDir, `${base}.reply.json`),
  };
}

function buildGrantSpendPaths(config, grantId, reqId) {
  const base = `grant-spend-${safeFilePart(grantId)}-${safeFilePart(reqId)}`;
  const requestDir = config.escalationDir || path.dirname(config.preapprovalGrantsFile);
  const replyDir = config.escalationReplyDir || path.dirname(config.preapprovalGrantsFile);
  return {
    requestPath: path.join(requestDir, `${base}.json`),
    replyPath: path.join(replyDir, `${base}.reply.json`),
  };
}

function writeJsonAtomic(filePath, payload) {
  const content = `${JSON.stringify(payload)}\n`;
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  return content;
}

function completedAgentMessageText(params) {
  const item = params && params.item;
  if (!item || item.type !== 'agentMessage' || typeof item.text !== 'string') return null;
  return item.text;
}

function appendCompletedAgentMessage(answerText, params) {
  const text = completedAgentMessageText(params);
  if (text === null || text.length === 0) return answerText;
  return answerText ? `${answerText}\n${text}` : text;
}

function writeAnswerFile(answerFile, answerText) {
  if (!answerFile || typeof answerText !== 'string' || !answerText.trim()) return false;
  fs.mkdirSync(path.dirname(answerFile), { recursive: true, mode: 0o700 });
  const tmpPath = path.join(
    path.dirname(answerFile),
    `.${path.basename(answerFile)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  fs.writeFileSync(tmpPath, answerText, { mode: 0o600 });
  fs.renameSync(tmpPath, answerFile);
  return true;
}

function unlinkIfExists(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }
}

function cleanupEscalationFiles(paths, audit) {
  for (const filePath of [paths.requestPath, paths.replyPath]) {
    try {
      unlinkIfExists(filePath);
    } catch (error) {
      audit('escalation_cleanup_error', { path: filePath, error: error.message });
    }
  }
}

function failClosedEscalation(audit, payload) {
  audit('escalation_fail_closed', {
    decision: 'decline',
    ...payload,
  });
  return { decision: 'decline', reason: payload.reason || null };
}

function markEscalationQueued(paths, requestPayload, timeoutMs, audit) {
  const { _sha256, ...basePayload } = requestPayload;
  const queuedPayload = {
    ...basePayload,
    state: 'queued',
    queuedAt: new Date().toISOString(),
    queueReason: `escalation timeout after ${timeoutMs}ms`,
  };
  const requestContent = writeJsonAtomic(paths.requestPath, queuedPayload);
  queuedPayload._sha256 = sha256Hex(requestContent);
  audit('escalation_queued', {
    runId: queuedPayload.runId,
    agentId: queuedPayload.agentId,
    reqId: queuedPayload.reqId,
    command: queuedPayload.command,
    cwd: queuedPayload.cwd,
    reason: queuedPayload.reason,
    signals: queuedPayload.signals,
    level: queuedPayload.level,
    requestPath: paths.requestPath,
    timeoutMs,
  });
  return queuedPayload;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function escalationSignatureMessage(request, decision, requestSha256) {
  return [
    String(request.runId),
    String(request.reqId),
    String(decision),
    String(request.ts || ''),
    String(requestSha256),
  ].join('\n');
}

function commandSha256(command) {
  return sha256Hex(String(command || ''));
}

function grantSignals(signals) {
  return Array.isArray(signals)
    ? signals.map((item) => String(item || '').trim()).filter(Boolean).sort()
    : [];
}

function boundarySignals(signals) {
  return grantSignals(signals).filter((signal) => signal !== 'write-or-exec');
}

// v2 binds grantKeyMode + the per-grant key identity (sha256 of its SPKI) into the human
// signature so a same-uid agent can neither downgrade keystore-maxuse→expiry-only nor swap the
// per-grant key. (See 2026-06-17-B2-grant-consumption-contract.md.)
function preapprovalGrantSignatureMessage(grant) {
  return [
    'shelly-agent-preapproval-grant-v2',
    String(grant.id || ''),
    String(grant.agentId || ''),
    String(grant.workspaceRoot || ''),
    String(grant.commandSha256 || ''),
    grantSignals(grant.signals).join(','),
    String(grant.expiresAt || ''),
    String(grant.createdAt || ''),
    String(grant.requestSha256 || ''),
    String(grant.requestTs || ''),
    String(grant.usesRemaining || 1),
    String(grant.grantKeyMode || ''),
    grant.grantKeySpki ? sha256Hex(String(grant.grantKeySpki)) : '',
  ].join('\n');
}

// Replay-dangerous (non-idempotent / exfiltration-capable) ops may NOT be honored as expiry-only
// (Tier 2) — they require Tier-1 hardware count enforcement or a fresh human tap each time.
// Computed from the ORIGINAL request signals (write-or-exec distinguishes a leaves-root write
// from a read; boundarySignals() strips it, so check the raw signals here).
function isReplayDangerousSignals(originalSignals) {
  const set = new Set(grantSignals(originalSignals));
  if (set.has('network-send')) return true;
  if (set.has('leaves-root') && set.has('write-or-exec')) return true;
  return false;
}

function verifyEscalationReplySignature(config, requestPayload, requestSha256, reply) {
  if (reply.by !== 'human') return { ok: false, reason: `invalid escalation reply author: ${reply.by}` };
  if (reply.sigAlg !== 'SHA256withRSA') {
    return { ok: false, reason: `invalid escalation reply signature algorithm: ${reply.sigAlg}` };
  }
  if (reply.requestSha256 !== requestSha256) {
    return { ok: false, reason: 'escalation reply request hash mismatch' };
  }
  if (reply.requestTs !== requestPayload.ts) {
    return { ok: false, reason: 'escalation reply request timestamp mismatch' };
  }
  if (typeof reply.signature !== 'string' || reply.signature.length < 32) {
    return { ok: false, reason: 'missing escalation reply signature' };
  }
  const publicKey = config.escalationVerifierPublicKey;
  if (!publicKey) return { ok: false, reason: 'escalation verifier public key unavailable' };
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(escalationSignatureMessage(requestPayload, reply.decision, requestSha256), 'utf8');
    verifier.end();
    const signature = Buffer.from(reply.signature, 'base64');
    if (!verifier.verify(publicKey, signature)) {
      return { ok: false, reason: 'escalation reply signature verification failed' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `escalation reply signature verification error: ${error.message}` };
  }
}

function verifyPreapprovalGrantSignature(config, grant) {
  if (grant.by !== 'human') return { ok: false, reason: `invalid grant author: ${grant.by}` };
  if (grant.sigAlg !== 'SHA256withRSA') {
    return { ok: false, reason: `invalid grant signature algorithm: ${grant.sigAlg}` };
  }
  if (typeof grant.signature !== 'string' || grant.signature.length < 32) {
    return { ok: false, reason: 'missing grant signature' };
  }
  const publicKey = config.escalationVerifierPublicKey;
  if (!publicKey) return { ok: false, reason: 'grant verifier public key unavailable' };
  try {
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(preapprovalGrantSignatureMessage(grant), 'utf8');
    verifier.end();
    if (!verifier.verify(publicKey, Buffer.from(grant.signature, 'base64'))) {
      return { ok: false, reason: 'grant signature verification failed' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `grant signature verification error: ${error.message}` };
  }
}

function grantUseReceiptSignatureMessage(receipt) {
  return [
    String(receipt.grantId || ''),
    String(receipt.reqId || ''),
    String(receipt.requestSha256 || ''),
    String(receipt.ts || ''),
  ].join('\n');
}

function verifyGrantUseReceipt(config, grant, request, receipt) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, reason: 'missing grant use receipt' };
  if (receipt.type !== 'grant_use_receipt') return { ok: false, reason: `invalid grant receipt type: ${receipt.type}` };
  if (receipt.grantId !== grant.id) return { ok: false, reason: 'grant receipt id mismatch' };
  if (receipt.reqId !== request.reqId) return { ok: false, reason: 'grant receipt reqId mismatch' };
  if (receipt.requestSha256 !== request.requestSha256) return { ok: false, reason: 'grant receipt request hash mismatch' };
  if (receipt.sigAlg !== 'SHA256withRSA') return { ok: false, reason: `invalid grant receipt signature algorithm: ${receipt.sigAlg}` };
  if (typeof receipt.signature !== 'string' || receipt.signature.length < 32) {
    return { ok: false, reason: 'missing grant receipt signature' };
  }
  if (!grant.grantKeySpki) return { ok: false, reason: 'grant receipt verifier key missing' };
  config.acceptedGrantSpendReqIds ||= new Set();
  if (config.acceptedGrantSpendReqIds.has(receipt.reqId)) {
    return { ok: false, reason: 'grant receipt reqId replay' };
  }
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(String(grant.grantKeySpki), 'base64'),
      format: 'der',
      type: 'spki',
    });
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(grantUseReceiptSignatureMessage(receipt), 'utf8');
    verifier.end();
    if (!verifier.verify(publicKey, Buffer.from(receipt.signature, 'base64'))) {
      return { ok: false, reason: 'grant receipt signature verification failed' };
    }
    config.acceptedGrantSpendReqIds.add(receipt.reqId);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `grant receipt signature verification error: ${error.message}` };
  }
}

// Load the verifier public key at most once and cache the in-memory key object so a later
// same-uid overwrite of the DER file cannot swap the trust anchor mid-run. When a pin
// (--escalation-public-key-sha256) is configured, the on-disk DER MUST hash to it or the key is
// rejected and left null, so every subsequent verify fails closed (decline). Idempotent: callers
// invoke it eagerly before spawning codex AND lazily at each escalation/grant check.
function ensureEscalationVerifierKey(config, audit) {
  if (config.escalationVerifierLoaded) return;
  config.escalationVerifierLoaded = true;
  let der;
  try {
    der = fs.readFileSync(config.escalationPublicKey);
  } catch (error) {
    config.escalationVerifierPublicKey = null;
    audit('escalation_verifier_key_unavailable', {
      path: config.escalationPublicKey,
      error: error.message,
    });
    return;
  }
  const actualSha256 = crypto.createHash('sha256').update(der).digest('hex');
  if (config.escalationPublicKeySha256) {
    if (actualSha256 !== config.escalationPublicKeySha256) {
      config.escalationVerifierPublicKey = null;
      audit('escalation_verifier_key_untrusted', {
        path: config.escalationPublicKey,
        expectedSha256: config.escalationPublicKeySha256,
        actualSha256,
      });
      return;
    }
  } else if (config.allowUnpinnedVerifierKey) {
    audit('escalation_verifier_key_unpinned', {
      path: config.escalationPublicKey,
      actualSha256,
      note: 'host/dev only (--allow-unpinned-verifier-key): a same-uid agent could swap this key',
    });
  } else {
    // Production default: no pin AND not explicitly allowed → refuse the key so a launcher that
    // forgot to inject the pin fails closed instead of silently trusting a swappable key.
    config.escalationVerifierPublicKey = null;
    audit('escalation_verifier_key_unpinned_refused', {
      path: config.escalationPublicKey,
      actualSha256,
      note: 'no --escalation-public-key-sha256 pin and --allow-unpinned-verifier-key not set; key refused, escalations/grants fail closed',
    });
    return;
  }
  try {
    config.escalationVerifierPublicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch (error) {
    config.escalationVerifierPublicKey = null;
    audit('escalation_verifier_key_parse_error', {
      path: config.escalationPublicKey,
      error: error.message,
    });
  }
}

function parseGrantExpiryMs(grant) {
  if (typeof grant.expiresAt === 'number') return grant.expiresAt;
  if (typeof grant.expiresAt === 'string' && /^\d+$/.test(grant.expiresAt.trim())) {
    return Number(grant.expiresAt.trim());
  }
  if (typeof grant.expiresAt === 'string') {
    const parsed = Date.parse(grant.expiresAt);
    return Number.isFinite(parsed) ? parsed : NaN;
  }
  return NaN;
}

function loadPreapprovalGrantRecords(config, audit) {
  let text = '';
  try {
    text = fs.readFileSync(config.preapprovalGrantsFile, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    audit('preapproval_grants_read_error', {
      path: config.preapprovalGrantsFile,
      error: error.message,
    });
    return [];
  }

  const records = [];
  const lines = text.split(/\n/).filter((line) => line.trim());
  for (let i = 0; i < lines.length; i++) {
    try {
      const record = JSON.parse(lines[i]);
      if (record && typeof record === 'object') records.push(record);
    } catch (error) {
      audit('preapproval_grant_parse_error', {
        path: config.preapprovalGrantsFile,
        line: i + 1,
        error: error.message,
      });
    }
  }
  return records;
}

function appendGrantUse(config, grant, request) {
  const use = {
    type: 'used',
    grantId: grant.id,
    runId: config.runId,
    reqId: request.reqId,
    commandSha256: request.commandSha256,
    ts: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(config.preapprovalGrantsFile), { recursive: true, mode: 0o700 });
  fs.appendFileSync(config.preapprovalGrantsFile, `${JSON.stringify(use)}\n`, { mode: 0o600 });
}

async function withPreapprovalGrantLock(config, audit, fn) {
  const lockPath = `${config.preapprovalGrantsFile}.lock`;
  const deadline = Date.now() + 5000;
  fs.mkdirSync(path.dirname(config.preapprovalGrantsFile), { recursive: true, mode: 0o700 });

  while (true) {
    let fd = null;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
      fs.closeSync(fd);
      fd = null;
      try {
        return await fn();
      } finally {
        unlinkIfExists(lockPath);
      }
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
      if (!error || error.code !== 'EEXIST') {
        audit('preapproval_grant_lock_error', { path: lockPath, error: error.message });
        return null;
      }
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > 30000) unlinkIfExists(lockPath);
      } catch {}
      if (Date.now() >= deadline) {
        audit('preapproval_grant_lock_timeout', { path: lockPath });
        return null;
      }
      await sleep(50);
    }
  }
}

async function consumePreapprovalGrant(config, request, audit) {
  return withPreapprovalGrantLock(config, audit, async () => {
    const preapproval = await findPreapprovalGrant(config, request, audit);
    if (!preapproval) return null;
    appendGrantUse(config, preapproval, {
      reqId: request.reqId,
      commandSha256: preapproval.commandSha256,
    });
    return preapproval;
  });
}

function grantSpendRequestSha256(config, request, requestCommandSha256, signals) {
  return sha256Hex([
    'shelly-agent-grant-spend-request-v1',
    String(config.runId),
    String(config.agentId),
    String(request.reqId),
    String(requestCommandSha256),
    String(config.policy.workspaceRoot),
    grantSignals(signals).join(','),
  ].join('\n'));
}

async function waitForGrantSpend(config, grant, request, requestCommandSha256, signals, audit) {
  const spendReqId = crypto.randomUUID();
  const requestSha256 = grantSpendRequestSha256(config, request, requestCommandSha256, signals);
  const paths = buildGrantSpendPaths(config, grant.id, spendReqId);
  const timeoutMs = config.grantSpendTimeoutMs ?? 10000;
  const startedAt = Date.now();
  const requestPayload = {
    type: 'grant_spend_request',
    grantId: grant.id,
    reqId: spendReqId,
    requestSha256,
    ts: new Date().toISOString(),
  };

  try {
    fs.mkdirSync(config.escalationDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config.escalationReplyDir, { recursive: true, mode: 0o700 });
    unlinkIfExists(paths.requestPath);
    unlinkIfExists(paths.replyPath);
    writeJsonAtomic(paths.requestPath, requestPayload);
    audit('grant_spend_requested', {
      grantId: grant.id,
      reqId: spendReqId,
      requestSha256,
      requestPath: paths.requestPath,
      timeoutMs,
    });

    while (Date.now() - startedAt < timeoutMs) {
      if (fs.existsSync(paths.replyPath)) {
        let reply;
        try {
          reply = JSON.parse(fs.readFileSync(paths.replyPath, 'utf8'));
        } catch (error) {
          audit('grant_spend_reply_parse_error', { grantId: grant.id, reqId: spendReqId, error: error.message });
          return null;
        }
        if (reply.type === 'grant_spend_denied') {
          audit('grant_spend_denied', {
            grantId: grant.id,
            reqId: spendReqId,
            reason: reply.reason || 'unknown',
          });
          return null;
        }
        const verification = verifyGrantUseReceipt(config, grant, requestPayload, reply);
        if (!verification.ok) {
          audit('grant_spend_receipt_rejected', {
            grantId: grant.id,
            reqId: spendReqId,
            reason: verification.reason,
          });
          return null;
        }
        audit('grant_spend_receipt_accepted', { grantId: grant.id, reqId: spendReqId });
        return { reqId: spendReqId, requestSha256 };
      }
      await sleep(100);
    }
    audit('grant_spend_timeout', { grantId: grant.id, reqId: spendReqId, timeoutMs });
    return null;
  } catch (error) {
    audit('grant_spend_error', { grantId: grant.id, reqId: spendReqId, error: error.message });
    return null;
  } finally {
    cleanupEscalationFiles(paths, audit);
  }
}

async function findPreapprovalGrant(config, request, audit) {
  const signals = boundarySignals(request.signals);
  if (signals.length === 0) return null;
  if (signals.some((signal) => UNGRANTABLE_BOUNDARY_SIGNALS.has(signal))) {
    return null;
  }
  if (signals.some((signal) => !GRANTABLE_BOUNDARY_SIGNALS.has(signal))) {
    return null;
  }

  ensureEscalationVerifierKey(config, audit);
  if (!config.escalationVerifierPublicKey) {
    // Untrusted/missing verifier key → no grant can be honored (fail closed).
    audit('preapproval_grant_unavailable', {
      reason: 'grant verifier public key unavailable or untrusted',
      path: config.escalationPublicKey,
    });
    return null;
  }

  const records = loadPreapprovalGrantRecords(config, audit);
  if (records.length === 0) return null;

  // NOTE: consumption is NOT gated on the file `used`-count anymore (#2). A same-uid agent can
  // delete those lines, so counting them was security theater. The bound is now expiry (Tier 2)
  // or a Keystore hardware count via the native spend round-trip (Tier 1, keystore-maxuse).
  const now = Date.now();
  const requestCommandSha256 = request.commandSha256 || commandSha256(request.command);
  for (const record of records) {
    if (record.type && record.type !== 'grant') continue;
    const grant = record;
    const grantId = String(grant.id || '');
    if (!grantId) continue;
    const expiresAtMs = parseGrantExpiryMs(grant);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) continue;
    if (grant.agentId !== config.agentId) continue;
    if (grant.workspaceRoot !== config.policy.workspaceRoot) continue;
    if (grant.commandSha256 !== requestCommandSha256) continue;
    const allowedSignals = new Set(grantSignals(grant.signals));
    if (signals.some((signal) => !allowedSignals.has(signal))) continue;

    const signature = verifyPreapprovalGrantSignature(config, grant);
    if (!signature.ok) {
      audit('preapproval_grant_rejected', {
        grantId,
        reason: signature.reason,
        commandSha256: requestCommandSha256,
      });
      continue;
    }

    const mode = String(grant.grantKeyMode || '');
    if (mode === 'expiry-only') {
      // Tier 2: honored within the signed window for the exact command. Replay-dangerous ops are
      // NOT eligible — they require Tier-1 hardware count or a fresh human tap.
      if (isReplayDangerousSignals(request.signals)) {
        audit('preapproval_grant_rejected', {
          grantId,
          reason: 'replay-dangerous signal not grantable as expiry-only (tier-1 only)',
          commandSha256: requestCommandSha256,
        });
        continue;
      }
      return { id: grantId, grantKeyMode: mode, expiresAt: grant.expiresAt, signals, commandSha256: requestCommandSha256 };
    }
    if (mode === 'keystore-maxuse') {
      const spend = await waitForGrantSpend(config, grant, request, requestCommandSha256, signals, audit);
      if (!spend) {
        audit('preapproval_grant_rejected', {
          grantId,
          reason: 'keystore-maxuse spend failed',
          commandSha256: requestCommandSha256,
        });
        continue;
      }
      return {
        id: grantId,
        grantKeyMode: mode,
        expiresAt: grant.expiresAt,
        signals,
        commandSha256: requestCommandSha256,
        spendReqId: spend.reqId,
      };
    }
    audit('preapproval_grant_rejected', {
      grantId,
      reason: `unknown or missing grantKeyMode: ${mode || '(none)'}`,
      commandSha256: requestCommandSha256,
    });
  }
  return null;
}

async function waitForEscalation(config, request, audit) {
  const paths = buildEscalationPaths(config, request.reqId);
  const replyPathForAudit = process.env.SHELLY_AGENT_DEBUG_REPLY_PATH === '1'
    ? paths.replyPath
    : '[native-reply-channel]';
  const startedAt = Date.now();
  let wroteRequest = false;
  let requestPayload = null;
  let preserveRequest = false;

  ensureEscalationVerifierKey(config, audit);
  if (!config.escalationVerifierPublicKey) {
    // Untrusted/missing verifier key → cannot trust any human reply (fail closed).
    return failClosedEscalation(audit, {
      reqId: request.reqId,
      reason: 'escalation verifier public key unavailable or untrusted',
      requestPath: paths.requestPath,
      replyPath: replyPathForAudit,
      elapsedMs: Date.now() - startedAt,
    });
  }

  try {
    fs.mkdirSync(config.escalationDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config.escalationReplyDir, { recursive: true, mode: 0o700 });
    unlinkIfExists(paths.requestPath);
    unlinkIfExists(paths.replyPath);

    requestPayload = {
      runId: config.runId,
      agentId: config.agentId,
      reqId: request.reqId,
      command: request.command,
      commandSha256: request.commandSha256 || commandSha256(request.command),
      workspaceRoot: config.policy.workspaceRoot,
      cwd: request.cwd,
      reason: request.reason,
      signals: request.signals,
      level: request.level,
      ts: new Date().toISOString(),
    };
    const requestContent = writeJsonAtomic(paths.requestPath, requestPayload);
    requestPayload._sha256 = sha256Hex(requestContent);
    wroteRequest = true;

    process.stdout.write(
      `ESCALATE human_required command=${JSON.stringify(request.command)} reqId=${JSON.stringify(request.reqId)} requestPath=${JSON.stringify(paths.requestPath)} replyChannel="native" action=wait\n`,
    );
    audit('escalation_requested', {
      ...requestPayload,
      requestPath: paths.requestPath,
      replyPath: replyPathForAudit,
      timeoutMs: config.escalationTimeoutMs,
    });
  } catch (error) {
    cleanupEscalationFiles(paths, audit);
    return failClosedEscalation(audit, {
      reqId: request.reqId,
      reason: `escalation request I/O failed: ${error.message}`,
      requestPath: paths.requestPath,
      replyPath: replyPathForAudit,
      elapsedMs: Date.now() - startedAt,
    });
  }

  const deadline = startedAt + config.escalationTimeoutMs;
  try {
    while (Date.now() < deadline) {
      let replyText = null;
      try {
        replyText = fs.readFileSync(paths.replyPath, 'utf8');
      } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          return failClosedEscalation(audit, {
            reqId: request.reqId,
            reason: `escalation reply read failed: ${error.message}`,
            requestPath: paths.requestPath,
            replyPath: replyPathForAudit,
            elapsedMs: Date.now() - startedAt,
          });
        }
      }

      if (replyText !== null) {
        let reply;
        try {
          reply = JSON.parse(replyText);
        } catch (error) {
          return failClosedEscalation(audit, {
            reqId: request.reqId,
            reason: `escalation reply parse failed: ${error.message}`,
            rawReply: replyText,
            requestPath: paths.requestPath,
            replyPath: replyPathForAudit,
            elapsedMs: Date.now() - startedAt,
          });
        }

        if (String(reply.reqId) !== String(request.reqId)) {
          return failClosedEscalation(audit, {
            reqId: request.reqId,
            reason: `escalation reply reqId mismatch: ${reply.reqId}`,
            reply,
            requestPath: paths.requestPath,
            replyPath: replyPathForAudit,
            elapsedMs: Date.now() - startedAt,
          });
        }
        if (reply.decision !== 'accept' && reply.decision !== 'decline') {
          return failClosedEscalation(audit, {
            reqId: request.reqId,
            reason: `invalid escalation decision: ${reply.decision}`,
            reply,
            requestPath: paths.requestPath,
            replyPath: replyPathForAudit,
            elapsedMs: Date.now() - startedAt,
          });
        }
        const signature = verifyEscalationReplySignature(config, requestPayload, requestPayload._sha256, reply);
        if (!signature.ok) {
          return failClosedEscalation(audit, {
            reqId: request.reqId,
            reason: signature.reason,
            reply: {
              ...reply,
              signature: typeof reply.signature === 'string' ? '[present]' : reply.signature,
            },
            requestPath: paths.requestPath,
            replyPath: replyPathForAudit,
            elapsedMs: Date.now() - startedAt,
          });
        }

        audit('escalation_resolved', {
          reqId: request.reqId,
          decision: reply.decision,
          requestPath: paths.requestPath,
          replyPath: replyPathForAudit,
          elapsedMs: Date.now() - startedAt,
        });
        process.stdout.write(
          `ESCALATE_RESOLVED reqId=${JSON.stringify(request.reqId)} decision=${JSON.stringify(reply.decision)} elapsedMs=${Date.now() - startedAt}\n`,
        );
        return { decision: reply.decision, reason: 'human reply' };
      }

      await sleep(Math.min(ESCALATION_POLL_MS, Math.max(1, deadline - Date.now())));
    }

    if (config.escalationTimeoutAction === 'queue' && requestPayload) {
      preserveRequest = true;
      markEscalationQueued(paths, requestPayload, config.escalationTimeoutMs, audit);
    }
    audit('escalation_timeout', {
      reqId: request.reqId,
      decision: 'decline',
      requestPath: paths.requestPath,
      replyPath: replyPathForAudit,
      timeoutMs: config.escalationTimeoutMs,
      elapsedMs: Date.now() - startedAt,
    });
    return { decision: 'decline', reason: `escalation timeout after ${config.escalationTimeoutMs}ms` };
  } finally {
    if (wroteRequest && !preserveRequest) cleanupEscalationFiles(paths, audit);
  }
}

// Shared gate core for every engine (Codex app-server approvals and Claude
// Code can_use_tool requests): each shell-equivalent command runs through the
// same gate helper, then gray verdicts go through signed preapproval grants,
// the unattended fail-closed decline, or the signed human escalation wait.
// Emits one GATE line per action. ctx = { requestId, approvalKind,
// lineContext, protocolDecisionOf(finalDecision) }.
async function gateCommandActions(config, audit, actions, ctx) {
  const gateResults = [];
  for (const action of actions) {
    if (!action.command) {
      gateResults.push({
        action,
        answer: 'escalate',
        error: 'missing command in approval params',
        elapsedMs: 0,
        outcome: null,
        rawStdout: '',
        rawStderr: '',
      });
      continue;
    }
    const gate = await runGate(config, action.command);
    gateResults.push({ action, ...gate });
  }

  const composite = combineGateAnswers(gateResults);
  const escalationOutcomes = new Map();
  let finalDecision = 'accept';

  if (gateResults.some((result) => result.answer === 'n')) {
    finalDecision = 'decline';
  } else {
    for (const result of gateResults.filter((item) => item.answer === 'escalate')) {
      // File changes: one declined path declines the whole patch, so the
      // remaining paths are not put in front of the human.
      if (ctx.stopAtFirstDecline && finalDecision === 'decline') break;
      const auditPayload = result.outcome && result.outcome.audit ? result.outcome.audit : {};
      const redactedCommand = redact(result.action.command);
      const reqId = gateResults.length === 1
        ? String(ctx.requestId)
        : `${ctx.requestId}-${result.action.index}`;

      if (!isHumanEscalation(result)) {
        finalDecision = 'decline';
        escalationOutcomes.set(result.action.index, {
          reqId,
          decision: 'decline',
          reason: result.error || auditPayload.reason || 'non-gray escalation fail-closed',
        });
        continue;
      }

      const preapproval = await consumePreapprovalGrant(config, {
        reqId,
        command: result.action.command,
        commandSha256: commandSha256(result.action.command),
        signals: auditPayload.signals || [],
      }, audit);
      if (preapproval) {
        audit('escalation_preapproved', {
          reqId,
          grantId: preapproval.id,
          command: auditPayload.command || redactedCommand,
          commandSha256: preapproval.commandSha256,
          cwd: result.action.cwd,
          signals: preapproval.signals,
          level: auditPayload.level || config.policy.level,
          expiresAt: preapproval.expiresAt,
        });
        escalationOutcomes.set(result.action.index, {
          reqId,
          decision: 'accept',
          reason: `preapproval grant ${preapproval.id}`,
        });
        continue;
      }

      // DEFERRED #2 boundary invariant: an UNATTENDED run (scheduled/alarm
      // fire or native one-tap of the stored script — no approver present)
      // never waits on a human for a gray verdict. Decline IMMEDIATELY
      // instead of leaning on the escalation timeout expiring unanswered —
      // the old safety was the mere confluence of "nobody answers" + "the
      // wait times out", which a future convenience change (gray default-
      // approve / longer timeout) could silently break. Signed pre-approval
      // grants were consumed ABOVE, so the attended escalate→approve→grant→
      // scheduled-run loop still works. No pending escalation request is
      // filed: a request whose run has already declined and moved on would
      // be a stale-approval hazard.
      if (isUnattendedPolicy(config.policy)) {
        const declined = {
          decision: 'decline',
          reason: 'unattended fail-closed: no approver present (approve once in an attended run to grant)',
        };
        audit('escalation_denied_unattended', {
          reqId,
          command: auditPayload.command || redactedCommand,
          commandSha256: commandSha256(result.action.command),
          workspaceRoot: config.policy.workspaceRoot,
          cwd: result.action.cwd,
          signals: auditPayload.signals || [],
          level: auditPayload.level || config.policy.level,
          reason: declined.reason,
        });
        escalationOutcomes.set(result.action.index, { reqId, ...declined });
        finalDecision = 'decline';
        continue;
      }

      const escalation = await waitForEscalation(config, {
        reqId,
        command: auditPayload.command || redactedCommand,
        commandSha256: commandSha256(result.action.command),
        workspaceRoot: config.policy.workspaceRoot,
        cwd: result.action.cwd,
        // Multi-file patches say which file this is ("(file k/N)"); the
        // `boundary: ` prefix the RN auto-approval checks is kept.
        reason: auditPayload.reason
          ? `${auditPayload.reason}${ctx.escalationLabelOf ? ctx.escalationLabelOf(result.action.index, gateResults.length) : ''}`
          : null,
        signals: auditPayload.signals || [],
        level: auditPayload.level || config.policy.level,
      }, audit);
      escalationOutcomes.set(result.action.index, {
        reqId,
        ...escalation,
      });
      if (escalation.decision === 'decline') {
        finalDecision = 'decline';
      }
    }
  }

  const protocolDecision = ctx.protocolDecisionOf(finalDecision);

  for (const result of gateResults) {
    const auditPayload = result.outcome && result.outcome.audit ? result.outcome.audit : {};
    const verdict = result.outcome && result.outcome.verdict ? result.outcome.verdict : null;
    const escalation = escalationOutcomes.get(result.action.index) || null;
    const actionDecision = result.answer === 'escalate'
      ? escalation && escalation.decision === 'accept' ? 'accept' : 'decline'
      : mapGateToDecision(result.answer);
    const redactedCommand = redact(result.action.command);

    gateLine(config.auditLog, {
      ...ctx.lineContext,
      requestId: ctx.requestId,
      approvalKind: ctx.approvalKind,
      actionIndex: result.action.index,
      actionCount: gateResults.length,
      actionSource: result.action.source,
      action: result.action.action,
      command: auditPayload.command || redactedCommand,
      cwd: result.action.cwd,
      answer: result.answer,
      actionDecision,
      compositeAnswer: composite.answer,
      decision: protocolDecision,
      escalationReqId: escalation && escalation.reqId,
      escalationDecision: escalation && escalation.decision,
      escalationReason: escalation && escalation.reason,
      verdictDecision: verdict && verdict.decision,
      reason: auditPayload.reason || result.error || null,
      signals: auditPayload.signals || [],
      level: auditPayload.level || config.policy.level,
      gateElapsedMs: result.elapsedMs,
      gateError: result.error || null,
      rawGateStdout: result.rawStdout ? redact(result.rawStdout.trim()) : '',
      rawGateStderr: result.rawStderr ? redact(result.rawStderr.trim()) : '',
    });
  }
  return { finalDecision, protocolDecision, gateResults, escalationOutcomes };
}

async function runDriver(config) {
  const audit = createAuditWriter(config.auditLog);
  // Load + pin-verify the escalation verifier key BEFORE spawning codex, so a same-uid agent can
  // never overwrite the DER before it is cached in memory. After this the cached key object is used
  // for all verifies regardless of later on-disk tampering.
  ensureEscalationVerifierKey(config, audit);
  if (config.answerFile) unlinkIfExists(config.answerFile);
  if (config.usageFile) unlinkIfExists(config.usageFile);
  // Prevention first: the preflight and the worker only ever see a fresh
  // CODEX_HOME with no MCP servers / apps / plugins / hooks / notify /
  // profiles / project trust. No isolated home → Codex never starts.
  const isolatedHome = createCodexIsolatedHome(process.env);
  if (!isolatedHome.ok) {
    audit('driver_start', {
      cwd: config.cwd,
      codexBin: config.codexBin,
      codexHome: 'isolation_failed',
      runId: config.runId,
      agentId: config.agentId,
    });
    audit('codex_home_isolation_failed', { reason: isolatedHome.reason });
    audit('driver_finish', { reason: 'codex_home_isolation_failed', exitCode: 1, threadId: null });
    setTimeout(() => process.exit(1), 50);
    return;
  }
  // Every exit path ends in process.exit (or a signal handled below). A token
  // refresh that replaced the auth.json link is copied back first (the run's
  // result is kept either way; a failure is audited and printed on stderr).
  process.once('exit', () => {
    const persisted = persistIsolatedCodexAuth(isolatedHome.dir, isolatedHome.realHome);
    if (persisted.status === 'persisted') {
      audit('codex_isolated_auth_persisted', { bytes: persisted.bytes });
    } else if (persisted.status === 'failed') {
      audit('codex_isolated_auth_persist_failed', { reason: persisted.reason });
      try {
        process.stderr.write(`shelly-agent-driver: warning: the Codex login refreshed during this run could not be saved (${persisted.reason}); you may need to sign in to Codex again.\n`);
      } catch {}
    }
    removeCodexIsolatedHome(isolatedHome.dir);
  });
  config = { ...config, codexHome: isolatedHome.dir };
  let authJsonText = '';
  try {
    authJsonText = readRegularFileCapped(path.join(isolatedHome.realHome, 'auth.json'), CODEX_AUTH_MAX_BYTES).toString('utf8');
  } catch {
    // No login file: the format detectors and env values still apply.
  }
  const leakSecrets = codexLeakSecrets(process.env, authJsonText);
  authJsonText = '';
  const mcpPreflight = codexMcpPreflight(config);
  const codexSpawn = codexAppServerSpawnSpec(config, mcpPreflight.ok ? mcpPreflight.names : []);
  const gateSpawn = gateSpawnSpec(config);
  const driverStartRecord = () => ({
    cwd: config.cwd,
    gateScript: config.gateScript,
    codexBin: config.codexBin,
    codexLaunchMode: codexSpawn.mode,
    codexSpawn: codexSpawn.display,
    codexBinary: codexSpawn.codexBinary,
    codexTui: codexSpawn.codexTui,
    codexHome: 'isolated',
    codexHomeCarried: isolatedHome.carried,
    codexHomeAgentsMd: isolatedHome.agentsMd,
    codexHomeSwept: isolatedHome.swept,
    codexEnvDropped: codexSpawn.droppedEnv,
    codexWebSearchMode: CODEX_WORKER_WEB_SEARCH_MODE,
    codexLeakKnownValues: leakSecrets.length,
    codexMcp: {
      ok: mcpPreflight.ok,
      disabledServers: mcpPreflight.names,
      disabledFeatures: CODEX_WORKER_DISABLED_FEATURES,
      reason: mcpPreflight.reason || null,
    },
    nodeBin: config.nodeBin,
    gateLaunchMode: gateSpawn.mode,
    gateSpawn: gateSpawn.display,
    gateNode: gateSpawn.nodePath,
    approvalPolicy: config.approvalPolicy,
    runId: config.runId,
    agentId: config.agentId,
    escalationDir: config.escalationDir,
    escalationReplyDir: process.env.SHELLY_AGENT_DEBUG_REPLY_PATH === '1'
      ? config.escalationReplyDir
      : '[native-reply-channel]',
    escalationPublicKey: config.escalationPublicKey,
    escalationKeyPinned: Boolean(config.escalationPublicKeySha256),
    escalationKeyTrusted: Boolean(config.escalationVerifierPublicKey),
    escalationTimeoutMs: config.escalationTimeoutMs,
    escalationTimeoutAction: config.escalationTimeoutAction,
    preapprovalGrantsFile: process.env.SHELLY_AGENT_DEBUG_GRANTS_PATH === '1'
      ? config.preapprovalGrantsFile
      : '[native-grant-channel]',
    escalationReplyChannelRequirement: 'reply files must carry an Android-Keystore-backed SHA256withRSA human signature; unsigned or invalid replies fail closed',
    preapprovalGrantRequirement: 'grant JSONL records must be Android-Keystore-signed, exact-command-hash scoped, unexpired, and one-shot by default',
    policy: {
      ...config.policy,
      workspaceRoot: config.policy.workspaceRoot,
    },
  });
  if (!mcpPreflight.ok) {
    // Fail closed: without proof that no MCP server / app loads, Codex never starts.
    audit('driver_start', driverStartRecord());
    audit('codex_mcp_preflight_failed', {
      reason: mcpPreflight.reason,
      servers: mcpPreflight.names,
      stillEnabled: mcpPreflight.stillEnabled || [],
    });
    audit('driver_finish', { reason: 'codex_mcp_preflight_failed', exitCode: 1, threadId: null });
    setTimeout(() => process.exit(1), 50);
    return;
  }
  const child = spawn(codexSpawn.command, codexSpawn.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: config.cwd,
    env: codexSpawn.env,
  });
  // SIGTERM / SIGINT would otherwise end node without the exit handler that
  // removes the isolated home.
  const onSignal = (signal) => {
    audit('driver_signal', { signal });
    try {
      child.kill('SIGKILL');
    } catch {}
    process.exit(143);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  const respondedIds = new Set();
  let queue = Promise.resolve();
  let initialized = false;
  let threadId = null;
  let turnStarted = false;
  let activeTurnId = null;
  let completed = false;
  let sawFailure = false;
  let answerText = '';
  let timeout = null;
  const codexUsage = createCodexUsageAccumulator();

  const send = (message) => {
    const line = JSON.stringify(message);
    rawLine('C->S', line);
    try {
      child.stdin.write(`${line}\n`);
    } catch (error) {
      sawFailure = true;
      audit('send_error', { error: error.message, message });
    }
  };

  const request = (kind, method, params) => {
    const id = nextId++;
    pending.set(String(id), kind);
    send({ id, method, params });
    return id;
  };

  const finish = (reason, exitCode) => {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    audit('driver_finish', { reason, exitCode, threadId });
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {}
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          audit('codex_sigkill_fallback', { reason });
          try {
            child.kill('SIGKILL');
          } catch {}
        }
      }, 1500).unref();
      setTimeout(() => process.exit(exitCode), 1800);
    } else {
      setTimeout(() => process.exit(exitCode), 50);
    }
  };

  const respond = (id, result) => {
    if (id === undefined || id === null) {
      audit('response_without_id', { result });
      return;
    }
    const key = String(id);
    if (respondedIds.has(key)) {
      audit('duplicate_response_blocked', { requestId: id, result });
      return;
    }
    respondedIds.add(key);
    send({ id, result });
  };

  const respondError = (id, code, message, data) => {
    if (id === undefined || id === null) {
      audit('error_response_without_id', { code, message, data });
      return;
    }
    const key = String(id);
    if (respondedIds.has(key)) {
      audit('duplicate_error_response_blocked', { requestId: id, code, message, data });
      return;
    }
    respondedIds.add(key);
    send({ id, error: { code, message, data: redactDeep(data || null) } });
  };

  // Stop the turn and fail the run for activity no gate can see. Only names are
  // recorded, never arguments.
  const stopUngatedActivity = (kind, details, reason) => {
    if (completed) return;
    sawFailure = true;
    const turnId = details && typeof details.turnId === 'string' ? details.turnId : null;
    audit(kind, details);
    gateLine(config.auditLog, {
      threadId: details && details.threadId,
      turnId,
      itemId: details && details.itemId,
      approvalKind: kind,
      command: '',
      cwd: config.cwd,
      answer: 'n',
      decision: 'abort',
      reason,
    });
    if (threadId && turnId) {
      try {
        request('turnInterrupt', 'turn/interrupt', { threadId, turnId });
      } catch {}
    }
    finish(kind, 1);
  };

  // Defense in depth for the MCP/app preflight: MCP and app tool calls run
  // inside Codex with no approval request to gate, so any sign of one stops
  // the turn and fails the run.
  const blockMcpActivity = (kind, details) => stopUngatedActivity(
    kind,
    details,
    'MCP / app tool calls are disabled for the Codex worker (no Shelly gate)',
  );

  const safeName = (value) => (typeof value === 'string' ? value.slice(0, 120) : null);

  const mcpToolCallDetails = (params) => {
    const item = params && params.item ? params.item : {};
    return {
      threadId: params && params.threadId,
      turnId: params && params.turnId,
      itemId: safeName(item.id),
      server: safeName(item.server),
      tool: safeName(item.tool),
      pluginId: safeName(item.pluginId),
      status: safeName(item.status),
    };
  };

  // Shared by item/started and item/completed: an item seen on only one of them
  // is still checked. Returns true when the run was stopped.
  const blockUngatedItem = (phase, params) => {
    const item = params && params.item;
    const disposition = codexItemDisposition(item);
    if (disposition === 'mcp') {
      blockMcpActivity('mcp_tool_call_blocked', { phase, ...mcpToolCallDetails(params) });
      return true;
    }
    if (disposition !== 'blocked') return false;
    const itemType = safeName(item && item.type);
    process.stdout.write(`CODEX_ERROR Codex reported an item Shelly cannot gate (${itemType || 'no type'}); stopped.\n`);
    stopUngatedActivity('codex_item_type_blocked', {
      phase,
      threadId: params && params.threadId,
      turnId: params && typeof params.turnId === 'string' ? params.turnId : activeTurnId,
      itemId: safeName(item && item.id),
      itemType,
      tool: safeName(item && item.tool),
      name: safeName(item && item.name),
    }, 'Codex item type is outside the Shelly allowlist (no approval request to gate)');
    return true;
  };

  const handleInitialize = () => {
    if (initialized) return;
    initialized = true;
    send({ method: 'initialized' });
    request('threadStart', 'thread/start', {
      cwd: config.cwd,
      approvalPolicy: config.approvalPolicy,
      approvalsReviewer: 'user',
      sandbox: 'danger-full-access',
      ephemeral: true,
      threadSource: 'user',
      developerInstructions: [
        'You are running under Shelly autonomous policy gate Phase A.',
        'Use shell commands exactly as requested by the user.',
        'When the user asks for multiple shell commands, issue separate shell tool calls in order.',
        'Do not combine independent shell commands unless the user explicitly asks you to.',
      ].join(' '),
    });
  };

  const handleThreadStart = (message) => {
    threadId = message.result.thread.id;
    audit('thread_started', {
      threadId,
      cwd: config.cwd,
      approvalPolicy: config.approvalPolicy,
      sandbox: 'danger-full-access',
    });
    request('turnStart', 'turn/start', {
      threadId,
      approvalPolicy: config.approvalPolicy,
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
      input: [{ type: 'text', text: workerPrompt(config.prompt), text_elements: [] }],
    });
  };

  const auditItemStarted = (params) => {
    const item = params && params.item ? params.item : {};
    const entry = {
      threadId: params && params.threadId,
      turnId: params && params.turnId,
      itemId: item.id,
      itemType: item.type,
    };
    if (item.type === 'commandExecution') {
      entry.command = redact(item.command || '');
      entry.cwd = item.cwd || null;
      entry.status = item.status || null;
      entry.source = item.source || null;
      entry.commandActions = Array.isArray(item.commandActions)
        ? item.commandActions.map((action) => ({
            ...action,
            command: redact(action && action.command ? action.command : ''),
          }))
        : [];
    }
    if (item.type === 'fileChange') {
      trackFileChangeItem(item.id, item.changes);
      entry.status = item.status || null;
      entry.changes = normalizeFileChanges(item.changes);
    }
    audit('item_started', entry);
  };

  const captureItemCompleted = (params) => {
    const text = completedAgentMessageText(params);
    if (text === null) return;
    answerText = appendCompletedAgentMessage(answerText, params);
    audit('agent_message_completed', {
      threadId: params && params.threadId,
      turnId: params && params.turnId,
      itemId: params && params.item && params.item.id,
      textLength: text.length,
      accumulatedTextLength: answerText.length,
    });
  };

  const handleApproval = async (message, approvalKind) => {
    const legacy = approvalKind === 'execCommandApproval';
    let response = { decision: legacy ? 'denied' : 'decline' };

    try {
      const params = message.params || {};
      const fallbackCwd = typeof params.cwd === 'string' ? params.cwd : config.cwd;
      const actions = legacy
        ? extractLegacyCommandActions(params, fallbackCwd)
        : extractCommandActions(params, fallbackCwd);

      const lineContext = { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId };
      const gated = await gateCommandActions(config, audit, actions, {
        requestId: message.id,
        approvalKind,
        lineContext,
        protocolDecisionOf: (finalDecision) => (legacy
          ? finalDecision === 'accept' ? 'approved' : 'denied'
          : finalDecision),
      });
      response = { decision: gated.protocolDecision };
    } catch (error) {
      sawFailure = true;
      gateLine(config.auditLog, {
        requestId: message.id,
        approvalKind,
        command: '',
        cwd: config.cwd,
        answer: 'escalate',
        decision: response.decision,
        reason: `approval handler failed: ${error.message}`,
        stack: error.stack,
      });
    } finally {
      respond(message.id, response);
    }
  };

  // v2 fileChange items by id: the approval request names only the item, so
  // the changed paths are taken from item/started and the latest
  // item/fileChange/patchUpdated (messages are handled in protocol order).
  const fileChangeItems = new Map();
  // itemId → resolved paths the gate accepted for it (v2), checked against
  // the item's final changes on item/completed.
  const approvedFileChangePaths = new Map();

  // applied ≠ approved: a completed fileChange item that touched a path the
  // gate never accepted fails the step. A declined item applied nothing.
  const checkCompletedFileChange = (params) => {
    const item = params && params.item ? params.item : null;
    if (!item || item.type !== 'fileChange') return;
    if (item.status === 'declined') return;
    const approved = approvedFileChangePaths.get(item.id) || new Set();
    const unapproved = [];
    for (const change of normalizeFileChanges(item.changes)) {
      for (const raw of [change.path, change.movePath]) {
        if (raw === null || raw === undefined) continue;
        const resolved = resolveFileChangePath(raw, config.cwd);
        if (!resolved || !approved.has(resolved)) unapproved.push(String(raw).slice(0, 300));
      }
    }
    if (unapproved.length === 0) return;
    sawFailure = true;
    audit('file_change_unapproved_path', {
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: item.id,
      status: item.status || null,
      unapproved,
      approvedCount: approved.size,
    });
  };

  const trackFileChangeItem = (itemId, changes) => {
    if (typeof itemId !== 'string' || !itemId || !Array.isArray(changes)) return;
    fileChangeItems.set(itemId, changes);
  };

  // A declined file change is a normal decision (like a declined command):
  // it never sets sawFailure. Only a handler crash does.
  const handleFileChangeApproval = async (message, approvalKind) => {
    const legacy = approvalKind === 'applyPatchApproval';
    const protocolDecisionOf = (finalDecision) => (legacy
      ? finalDecision === 'accept' ? 'approved' : 'denied'
      : finalDecision === 'accept' ? 'accept' : 'decline');
    let response = { decision: protocolDecisionOf('decline') };

    try {
      const params = message.params || {};
      const itemId = legacy ? params.callId : params.itemId;
      const itemKnown = legacy ? true : fileChangeItems.has(params.itemId);
      const changes = legacy ? params.fileChanges : fileChangeItems.get(params.itemId);
      let mapped = fileChangeToActions(changes, config.cwd, approvalKind);
      if (!itemKnown) {
        mapped = { deny: 'file change approval for an item never announced', protocolMismatch: true };
      }
      if (mapped.protocolMismatch) {
        // Protocol drift: still a decline, but visible — the step fails.
        sawFailure = true;
        audit('file_change_protocol_mismatch', {
          requestId: message.id,
          method: approvalKind,
          itemId: itemId === undefined ? null : itemId,
          itemKnown,
          paramKeys: Object.keys(params).sort(),
          changeKeys: legacy && changes && typeof changes === 'object'
            ? Object.values(changes).map((c) => (c && typeof c === 'object' ? Object.keys(c).sort() : typeof c))
            : Array.isArray(changes)
              ? changes.map((c) => (c && typeof c === 'object' ? Object.keys(c).sort() : typeof c))
              : null,
          reason: mapped.deny,
        });
      }
      const lineContext = legacy
        ? { threadId: params.conversationId, callId: params.callId }
        : { threadId: params.threadId, turnId: params.turnId, itemId: params.itemId };
      audit('file_change_approval_requested', {
        requestId: message.id,
        approvalKind,
        ...lineContext,
        itemKnown: legacy ? true : fileChangeItems.has(params.itemId),
        reason: typeof params.reason === 'string' ? params.reason : null,
        grantRoot: typeof params.grantRoot === 'string' ? params.grantRoot : null,
        paths: mapped.actions ? mapped.actions.map((a) => a.action) : [],
      });
      if (mapped.deny) {
        gateLine(config.auditLog, {
          ...lineContext,
          requestId: message.id,
          approvalKind,
          command: '',
          cwd: config.cwd,
          answer: 'n',
          decision: response.decision,
          reason: mapped.deny,
        });
        audit('file_change_declined', { requestId: message.id, approvalKind, itemId, reason: mapped.deny });
        return;
      }
      const gated = await gateCommandActions(config, audit, mapped.actions, {
        requestId: message.id,
        approvalKind,
        lineContext,
        protocolDecisionOf,
        stopAtFirstDecline: true,
        escalationLabelOf: (index, total) => (total > 1 ? ` (file ${index + 1}/${total})` : ''),
      });
      response = { decision: gated.protocolDecision };
      if (gated.finalDecision === 'accept' && !legacy && typeof itemId === 'string') {
        const approved = approvedFileChangePaths.get(itemId) || new Set();
        for (const action of mapped.actions) {
          approved.add(action.action.path);
          if (action.action.movePath) approved.add(resolveFileChangePath(action.action.movePath, config.cwd));
        }
        approvedFileChangePaths.set(itemId, approved);
      }
      audit(gated.finalDecision === 'accept' ? 'file_change_accepted' : 'file_change_declined', {
        requestId: message.id,
        approvalKind,
        itemId,
        decision: gated.protocolDecision,
        pathCount: mapped.actions.length,
      });
    } catch (error) {
      sawFailure = true;
      gateLine(config.auditLog, {
        requestId: message.id,
        approvalKind,
        command: '',
        cwd: config.cwd,
        answer: 'escalate',
        decision: response.decision,
        reason: `file change approval handler failed: ${error.message}`,
        stack: error.stack,
      });
    } finally {
      respond(message.id, response);
    }
  };

  const handleClientResponse = (message) => {
    const key = String(message.id);
    const kind = pending.get(key);
    if (!kind) {
      audit('unexpected_client_response', { requestId: message.id, message });
      return;
    }
    pending.delete(key);

    if (message.error) {
      sawFailure = true;
      audit('client_request_error', { requestId: message.id, kind, error: message.error });
      finish(`client_request_error_${kind}`, 1);
      return;
    }

    if (kind === 'initialize') {
      handleInitialize();
      return;
    }
    if (kind === 'threadStart') {
      if (!message.result || !message.result.thread || !message.result.thread.id) {
        sawFailure = true;
        audit('thread_start_malformed', { requestId: message.id, result: message.result || null });
        finish('thread_start_malformed', 1);
        return;
      }
      handleThreadStart(message);
      return;
    }
    if (kind === 'turnStart') {
      if (!message.result || !message.result.turn || !message.result.turn.id) {
        sawFailure = true;
        audit('turn_start_malformed', { requestId: message.id, result: message.result || null });
        finish('turn_start_malformed', 1);
        return;
      }
      turnStarted = true;
      activeTurnId = typeof message.result.turn.id === 'string' ? message.result.turn.id : null;
      audit('turn_started', {
        threadId,
        turnId: message.result.turn.id,
        status: message.result.turn.status,
      });
      return;
    }

    audit('unknown_pending_response_kind', { requestId: message.id, kind, message });
  };

  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  const isClientResponse = (message) => (
    message
    && hasOwn(message, 'id')
    && (hasOwn(message, 'result') || hasOwn(message, 'error'))
  );

  const isServerRequest = (message) => (
    message
    && hasOwn(message, 'id')
    && typeof message.method === 'string'
  );

  const handleServerRequest = async (message) => {
    if (message.method === 'item/commandExecution/requestApproval') {
      await handleApproval(message, 'item/commandExecution/requestApproval');
      return;
    }
    if (message.method === 'execCommandApproval') {
      await handleApproval(message, 'execCommandApproval');
      return;
    }
    if (message.method === 'item/fileChange/requestApproval') {
      await handleFileChangeApproval(message, 'item/fileChange/requestApproval');
      return;
    }
    if (message.method === 'applyPatchApproval') {
      await handleFileChangeApproval(message, 'applyPatchApproval');
      return;
    }
    if (message.method === 'mcpServer/elicitation/request') {
      const params = message.params || {};
      respond(message.id, { action: 'decline', content: null });
      blockMcpActivity('mcp_elicitation_blocked', {
        requestId: message.id,
        method: message.method,
        threadId: params.threadId,
        turnId: params.turnId,
        server: safeName(params.serverName),
        mode: safeName(params.mode),
      });
      return;
    }
    if (/^mcp/i.test(message.method)) {
      respondError(message.id, -32000, `MCP requests are disabled for the Shelly agent worker: ${message.method}`, { method: message.method });
      const params = message.params || {};
      blockMcpActivity('mcp_request_blocked', {
        requestId: message.id,
        method: message.method,
        threadId: params.threadId,
        turnId: params.turnId,
        server: safeName(params.serverName),
      });
      return;
    }
    sawFailure = true;
    audit('unknown_server_request', {
      requestId: message.id,
      method: message.method,
      params: message.params || null,
    });
    respondError(
      message.id,
      -32000,
      `unsupported server request: ${message.method}`,
      { method: message.method },
    );
  };

  const handleMessage = async (message) => {
    // After finish() (e.g. a blocked MCP call) nothing more is answered or
    // written — in particular no answer file from a late turn/completed.
    if (completed) return;
    if (isClientResponse(message)) {
      handleClientResponse(message);
      return;
    }

    if (isServerRequest(message)) {
      await handleServerRequest(message);
      return;
    }

    if (message.method === 'item/started') {
      if (blockUngatedItem('started', message.params)) return;
      auditItemStarted(message.params);
      return;
    }

    if (message.method === 'item/mcpToolCall/progress') {
      const params = message.params || {};
      blockMcpActivity('mcp_tool_call_blocked', {
        phase: 'progress',
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: safeName(params.itemId),
      });
      return;
    }

    if (message.method === 'mcpServer/startupStatus/updated') {
      // The preflight should leave nothing to start. A server that is starting
      // or running anyway (e.g. ChatGPT apps `codex_apps`, which `mcp list`
      // never shows, or a feature key the on-device fork ignores) fails the run
      // before any tool call. Only a status that clearly means "not running"
      // is recorded without failing; an unknown or missing status blocks.
      // Only the server name and status are recorded.
      const params = message.params || {};
      const status = mcpStartupStatusName(params.status);
      const details = {
        server: safeName(params.name),
        status,
        threadId: params.threadId || threadId || null,
        turnId: typeof params.turnId === 'string' ? params.turnId : activeTurnId,
      };
      if (status && MCP_STARTUP_NOT_RUNNING.has(status.toLowerCase().replace(/[^a-z]/g, ''))) {
        audit('mcp_server_startup_observed', details);
        return;
      }
      blockMcpActivity('mcp_server_startup_blocked', details);
      return;
    }

    if (message.method === 'item/fileChange/patchUpdated') {
      const params = message.params || {};
      trackFileChangeItem(params.itemId, params.changes);
      audit('file_change_patch_updated', {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        changes: normalizeFileChanges(params.changes),
      });
      return;
    }

    if (message.method === 'item/completed') {
      if (blockUngatedItem('completed', message.params)) return;
      if (message.params.item.type === 'webSearch') {
        const leak = codexWebSearchLeakCheck(message.params.item, leakSecrets);
        if (leak) {
          process.stdout.write(`CODEX_ERROR A web search carried a secret (${leak.detector}); stopped.\n`);
          stopUngatedActivity('codex_web_search_leak_blocked', {
            threadId: message.params.threadId,
            turnId: typeof message.params.turnId === 'string' ? message.params.turnId : activeTurnId,
            itemId: leak.itemId,
            detector: leak.detector,
          }, 'web search carried a known secret value or secret format');
          return;
        }
        audit('codex_web_search', {
          threadId: message.params.threadId,
          turnId: message.params.turnId,
          ...codexWebSearchAudit(message.params.item, leakSecrets),
        });
      }
      checkCompletedFileChange(message.params);
      captureItemCompleted(message.params);
      return;
    }

    if (codexUsage.observe(message)) return;

    if (message.method === 'turn/completed') {
      const usageValue = codexUsage.value();
      try {
        const wroteUsage = writeUsageFile(config.usageFile, usageValue);
        audit('usage_recorded', { usageFile: config.usageFile, wroteUsage, usage: usageValue });
      } catch (error) {
        audit('usage_write_error', { usageFile: config.usageFile, error: error.message });
      }
      try {
        const wroteAnswer = writeAnswerFile(config.answerFile, answerText);
        audit('answer_file_written', {
          answerFile: config.answerFile,
          wroteAnswer,
          textLength: answerText.length,
        });
      } catch (error) {
        sawFailure = true;
        audit('answer_file_write_error', {
          answerFile: config.answerFile,
          error: error.message,
        });
      }
      audit('turn_completed', {
        threadId: message.params && message.params.threadId,
        turn: message.params && message.params.turn,
      });
      finish('turn_completed', sawFailure ? 1 : 0);
      return;
    }

    if (message.method === 'error') {
      sawFailure = true;
      audit('server_error', { params: message.params || null });
    }
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (!line) continue;
      rawLine('S->C', codexWireLineForLog(line, leakSecrets));
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        sawFailure = true;
        audit('parse_error', { error: error.message, line });
        continue;
      }
      queue = queue.then(() => handleMessage(message)).catch((error) => {
        sawFailure = true;
        audit('handler_error', { error: error.message, stack: error.stack });
      });
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().replace(/\n$/, '');
    process.stdout.write(`STDERR ${text}\n`);
  });

  child.on('error', (error) => {
    sawFailure = true;
    audit('codex_spawn_error', { error: error.message });
    finish('codex_spawn_error', 1);
  });

  child.on('exit', (code, signal) => {
    if (completed) return;
    const exitCode = turnStarted && code === 0 ? 0 : 1;
    audit('codex_exit', { code, signal, turnStarted });
    finish('codex_exit', exitCode);
  });

  timeout = setTimeout(() => {
    sawFailure = true;
    finish(`timeout_${config.timeoutMs}ms`, 124);
  }, config.timeoutMs);

  audit('driver_start', driverStartRecord());
  request('initialize', 'initialize', {
    clientInfo: { name: 'shelly-agent-driver', version: '0.1.0' },
    capabilities: {},
  });
}

// ─── Claude Code engine (Claude glibc S4) ─────────────────────────────────
//
// Claude Code has no app-server, but its headless stream-json mode with
// `--permission-prompt-tool stdio` (the Agent SDK's control protocol) asks the
// parent over stdout before every tool use that needs permission
// (`control_request` / `can_use_tool`) and waits for our `control_response`.
// That is the same shape as Codex's app-server approval requests, so every
// tool use is turned into a shell-equivalent command and decided by the SAME
// gateCommandActions() core: gate helper (command-safety + boundary +
// POLICY-001 action policy), signed preapproval grants, unattended
// fail-closed decline, signed human escalation. Nothing is auto-approved here.
//
//  - Bash             → the command itself (background runs are refused).
//  - Read             → `cat -- '<file_path>'` (leaves-root / secret reads gate like Codex's cat).
//  - Write/Edit/MultiEdit → `tee -- '<file_path>'` (write-or-exec, in-workspace only unattended).
//  - anything else    → denied. WebFetch / WebSearch / Task / Grep / Glob /
//    NotebookEdit are also disallowed up front, so they never reach the model's
//    tool list. (Grep/Glob: claude's bundled rg cannot be exec'd on Android
//    anyway; web access stays with the explicit web backends.)
//
// The settings below force a permission request even for tools Claude would
// auto-allow (read-only Bash commands, in-cwd Reads): `ask` rules are checked
// before any `allow` rule a user's own settings might carry, `--setting-sources ""`
// keeps user/project/local settings (and a cloned repo's .claude/settings.json)
// out entirely, `disableAllHooks` drops hooks, `--strict-mcp-config` with no
// config loads no MCP servers, and `--permission-mode default` overrides any
// defaultMode. The prompt goes in over stdin (never argv).
//
// Tool surface = an ALLOWLIST (Codex review M, 2026-10-31). Tools Claude treats
// as permission-free (TodoWrite, Skill, ToolSearch, AskUserQuestion,
// SlashCommand, ExitPlanMode, BashOutput/KillShell, any future built-in) never
// produce a can_use_tool request, so an ask/deny list alone cannot gate them.
// Five layers, so one unsupported flag or renamed tool cannot open it:
//  1. `--tools Bash,Read,Write,Edit` — the built-in tool set claude exposes to
//     the model at all (the Agent SDK's `tools` option). An unknown flag makes
//     claude exit with a usage error = fail closed.
//  2. `--disallowedTools` with every other built-in name we know of.
//  3. the same names as settings `permissions.deny` (defense in depth).
//  4. at runtime: an assistant tool_use for anything outside the allowlist
//     (built-in we did not know, MCP, …) stops the run immediately.
//  5. at start: the `tools` list in system/init is checked before any tool can
//     run (claudeInitToolCheck). Observed on the PC build 2.1.220 (dummy key,
//     unreachable API): these exact flags give ["Bash","Edit","Read","Write"]
//     and mcp_servers []; deny rules remove a tool from the list; without
//     --tools fifteen tools appear, some of them on no list here. So a name
//     outside the allowlist means `--tools` stopped working or an MCP server
//     loaded. A name in CLAUDE_DENIED_TOOLS is still accepted: listed but
//     denied by both --disallowedTools and settings is not enabled, and layer 4
//     still stops it, so a build that keeps it listed must not fail every run.
// MultiEdit is not in --tools (absent from recent builds; Edit covers it) but
// stays gated (ask + tee mapping) in case a build exposes it anyway.
const CLAUDE_ALLOWED_TOOLS = ['Bash', 'Read', 'Write', 'Edit'];
const CLAUDE_GATED_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit'];
const CLAUDE_DENIED_TOOLS = [
  'Agent', 'Task', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch',
  'NotebookEdit', 'NotebookRead', 'TodoWrite', 'TodoRead', 'Skill',
  'SlashCommand', 'ToolSearch', 'AskUserQuestion', 'ExitPlanMode',
  'EnterPlanMode', 'BashOutput', 'KillShell', 'KillBash', 'Monitor',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'SendMessage', 'TaskStop',
  'TaskOutput', 'EnterWorktree', 'ExitWorktree', 'Workflow', 'CronCreate',
];
const CLAUDE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
const CLAUDE_CHILD_ENV_DROP = [
  'CLAUDE_CODE_SHELL',
  'CLAUDE_ENV_FILE',
  'CLAUDE_CODE_SHELL_PREFIX',
  'CLAUDE_CONFIG_DIR',
  'SHELLY_CLAUDE_SETTINGS_JSON',
  'ANTHROPIC_BASE_URL',
];
const CLAUDE_INIT_REQUEST_ID = 'shelly-init';

// The one Claude Code build agents may run. `current` is the newest build that
// passed a device probe, for the person at the terminal; a worker rests on flags
// and stream-json details that probe does not look at, so no update may move it.
// Changed only by a reviewed commit, in lockstep with REVIEWED_CLAUDE in
// shelly-cli-update.js (a test holds them equal). The size here catches a swapped
// file without hashing 300 MB before every step; the installer checks the hash.
const CLAUDE_AGENT_REVIEWED = {
  version: '2.1.314',
  sha256: 'a66c0a8f5d0c87a439953d797985192bbcbaefbce2e0d7b2eaa8df30ef0f3ef2',
  size: 297067016,
};

/**
 * Layer 5. `unexpected` = enabled tools outside the allowlist; `denied` =
 * listed but denied (not a stop). A missing list cannot be verified, so it
 * fails closed. MCP tools (mcp__server__tool) are on no list, so they are
 * unexpected; --strict-mcp-config loads none.
 */
function claudeInitToolCheck(tools) {
  if (!Array.isArray(tools)) return { ok: false, unexpected: [], denied: [], reason: 'no tools list in system/init' };
  const unexpected = [];
  const denied = [];
  for (const tool of tools) {
    if (CLAUDE_GATED_TOOLS.includes(tool)) continue;
    if (CLAUDE_DENIED_TOOLS.includes(tool)) denied.push(tool);
    else unexpected.push(String(tool).slice(0, 80));
  }
  return { ok: unexpected.length === 0, unexpected, denied, reason: unexpected.length ? 'tool outside the allowlist' : null };
}

function claudeAgentSettingsJson() {
  return JSON.stringify({
    permissions: {
      deny: CLAUDE_DENIED_TOOLS,
      ask: CLAUDE_GATED_TOOLS,
      defaultMode: 'default',
    },
    disableAllHooks: true,
  });
}

function claudeAgentArgs() {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'default',
    '--permission-prompt-tool', 'stdio',
    '--setting-sources', '',
    '--strict-mcp-config',
    '--tools', CLAUDE_ALLOWED_TOOLS.join(','),
    '--disallowedTools', CLAUDE_DENIED_TOOLS.join(','),
  ];
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell-equivalent command(s) the gate decides for one can_use_tool
 * request, or { deny } when the tool is never allowed for an agent.
 */
function claudeToolToActions(toolName, input, cwd) {
  const params = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (toolName === 'Bash') {
    if (params.run_in_background === true) {
      return { deny: 'background shell commands are not allowed for Shelly agents' };
    }
    const command = typeof params.command === 'string' ? params.command.trim() : '';
    return { actions: [{ index: 0, source: 'claude:Bash', command, cwd, action: null }] };
  }
  if (toolName === 'Read' || CLAUDE_WRITE_TOOLS.has(toolName)) {
    const raw = typeof params.file_path === 'string' ? params.file_path : '';
    if (!raw || /[\u0000-\u001f]/.test(raw)) return { deny: `${toolName} needs a plain file_path` };
    const filePath = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
    const verb = toolName === 'Read' ? 'cat' : 'tee';
    return {
      actions: [{ index: 0, source: `claude:${toolName}`, command: `${verb} -- ${shellSingleQuote(filePath)}`, cwd, action: null }],
    };
  }
  return { deny: `tool ${String(toolName || '(none)').slice(0, 60)} is not allowed for Shelly agents` };
}

// ─── Codex file-change approvals ──────────────────────────────────────────
//
// Codex edits files natively (apply_patch) and asks before each patch, the
// same way it asks before a shell command. Protocol (codex app-server
// generate-ts, codex-cli 0.144.4):
//   v2:     item/fileChange/requestApproval {threadId, turnId, itemId,
//           startedAtMs, reason?, grantRoot?} → {decision: 'accept' |
//           'acceptForSession' | 'decline' | 'cancel'}. The paths are NOT in
//           the request: they come from the `fileChange` ThreadItem
//           (item/started, item/fileChange/patchUpdated) with
//           changes: [{path, kind: {type: 'add'|'delete'|'update',
//           move_path?}, diff}].
//   legacy: applyPatchApproval {conversationId, callId, fileChanges:
//           {[path]: {type: 'add'|'delete'|'update', move_path?, …}},
//           reason, grantRoot} → {decision: 'approved' | 'denied' | …}.
// Every changed path becomes the shell-equivalent command the gate already
// knows (same mapping as Claude's Write/Edit): add/update → `tee -- <path>`,
// delete → `rm -- <path>`, update with move_path → `mv -- <path> <dest>`.
// All of them are decided as ONE composite by gateCommandActions (any deny
// declines the patch; gray ones go through grants / unattended decline /
// signed human escalation). acceptForSession is never sent.

/** [{path, type, movePath}] from a v2 changes array or a legacy fileChanges map. */
function normalizeFileChanges(raw) {
  if (Array.isArray(raw)) {
    return raw.map((change) => {
      const kind = change && change.kind && typeof change.kind === 'object' ? change.kind : {};
      return {
        path: change && typeof change.path === 'string' ? change.path : '',
        type: typeof kind.type === 'string' ? kind.type : '',
        movePath: typeof kind.move_path === 'string' && kind.move_path ? kind.move_path : null,
      };
    });
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([filePath, change]) => {
      const c = change && typeof change === 'object' ? change : {};
      return {
        path: filePath,
        type: typeof c.type === 'string' ? c.type : '',
        movePath: typeof c.move_path === 'string' && c.move_path ? c.move_path : null,
      };
    });
  }
  return [];
}

// Control characters (C0, DEL, C1) and every non-ASCII whitespace / line or
// paragraph separator: a path carrying one is not shown to anyone as-is.
const FILE_CHANGE_UNSAFE_PATH_RE = /[\u0000-\u001f\u007f-\u009f\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u3000\ufeff]/;

function resolveFileChangePath(raw, cwd) {
  if (!raw || FILE_CHANGE_UNSAFE_PATH_RE.test(raw)) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

/**
 * The gate commands for one file-change approval, or { deny } when the
 * change cannot be placed. `protocolMismatch: true` marks a request whose
 * shape we do not understand (no changes / no path / unknown kind) — still a
 * decline, but the caller also fails the step so protocol drift is visible.
 * A path with unsafe characters is a plain decline. Relative paths resolve
 * against the turn cwd.
 */
function fileChangeToActions(changes, cwd, source) {
  const list = normalizeFileChanges(changes);
  if (list.length === 0) return { deny: 'file change approval without any known changed path', protocolMismatch: true };
  const resolvePath = (raw) => resolveFileChangePath(raw, cwd);
  const actions = [];
  for (const change of list) {
    if (!change.path) return { deny: 'file change without a path', protocolMismatch: true };
    const filePath = resolvePath(change.path);
    if (!filePath) return { deny: 'file change needs plain paths' };
    let command;
    if (change.type === 'add' || (change.type === 'update' && !change.movePath)) {
      command = `tee -- ${shellSingleQuote(filePath)}`;
    } else if (change.type === 'delete') {
      command = `rm -- ${shellSingleQuote(filePath)}`;
    } else if (change.type === 'update' && change.movePath) {
      const dest = resolvePath(change.movePath);
      if (!dest) return { deny: 'file change needs plain paths' };
      command = `mv -- ${shellSingleQuote(filePath)} ${shellSingleQuote(dest)}`;
    } else {
      return { deny: `unknown file change kind ${String(change.type || '(none)').slice(0, 40)}`, protocolMismatch: true };
    }
    actions.push({
      index: actions.length,
      source,
      command,
      cwd,
      action: { path: filePath, kind: change.type, movePath: change.movePath },
    });
  }
  return { actions };
}

function nonNegativeFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Usage from Claude's `result` message: tokens always (prompt = input +
 * cache-creation + cache-read, completion = output); USD only when Claude
 * says the run was billed to an API key (`apiKeySource` other than "none") —
 * a subscription (claude.ai Max / setup-token) run reports an API-equivalent
 * estimate in total_cost_usd that nobody pays, so it is not recorded as spend.
 */
function claudeUsageFromResult(result, apiKeySource) {
  if (!result || typeof result !== 'object') return null;
  const u = result.usage && typeof result.usage === 'object' ? result.usage : {};
  const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(nonNegativeFinite);
  const out = {};
  if (parts.some((n) => n !== null)) out.inputTokens = parts.reduce((sum, n) => sum + (n || 0), 0);
  const output = nonNegativeFinite(u.output_tokens);
  if (output !== null) out.outputTokens = output;
  const usd = nonNegativeFinite(result.total_cost_usd);
  const billed = typeof apiKeySource === 'string' && apiKeySource && apiKeySource !== 'none';
  if (usd !== null && billed) out.usd = usd;
  return Object.keys(out).length ? out : null;
}

// ─── Codex token usage (MONITOR) ───────────────────────────────────────────
//
// The Codex app-server reports token usage as notifications, not on
// turn/completed. Two shapes are accepted (no Codex protocol sources are
// vendored in this repo, so parsing is deliberately tolerant):
//   v2:     {"method":"thread/tokenUsage/updated","params":{"threadId","turnId",
//            "tokenUsage":{"total":{inputTokens,cachedInputTokens,outputTokens,
//            reasoningOutputTokens,totalTokens},"last":{…},"modelContextWindow"}}}
//   legacy: {"method":"codex/event/token_count","params":{"msg":{"type":"token_count",
//            "info":{"total_token_usage":{input_tokens,…},"last_token_usage":{…}}}}}
// (the same token_count info the Codex session JSONL carries — see
// scouter/JsonlSessionParser.kt). `total` is cumulative for the thread, and
// the driver runs one fresh thread per turn, so the latest total is the
// turn's usage; `last` (one model response) is summed only when no total
// was ever seen. Codex input_tokens already includes the cached part, and
// output_tokens includes reasoning, so neither is added again.

function codexTokenBreakdown(value) {
  if (!value || typeof value !== 'object') return null;
  const pick = (...keys) => {
    for (const key of keys) {
      const n = nonNegativeFinite(value[key]);
      if (n !== null) return n;
    }
    return null;
  };
  const input = pick('inputTokens', 'input_tokens');
  const output = pick('outputTokens', 'output_tokens');
  if (input === null && output === null) return null;
  const out = {};
  if (input !== null) out.inputTokens = input;
  if (output !== null) out.outputTokens = output;
  return out;
}

/** {total, last} breakdowns from one app-server message, or null when the
 *  message is not a token usage notification. */
function codexTokenUsageFromNotification(message) {
  if (!message || typeof message !== 'object' || typeof message.method !== 'string') return null;
  const params = message.params && typeof message.params === 'object' ? message.params : null;
  if (!params) return null;
  let info = null;
  if (message.method === 'thread/tokenUsage/updated') {
    info = params.tokenUsage || params.token_usage || params.usage || null;
  } else if (message.method === 'codex/event/token_count' || (params.msg && params.msg.type === 'token_count')) {
    info = params.msg && typeof params.msg === 'object' ? params.msg.info : params.info;
  } else {
    return null;
  }
  if (!info || typeof info !== 'object') return null;
  const total = codexTokenBreakdown(info.total || info.totalTokenUsage || info.total_token_usage);
  const last = codexTokenBreakdown(info.last || info.lastTokenUsage || info.last_token_usage);
  if (!total && !last) return null;
  return { total, last };
}

/** Folds token usage notifications into the turn's usage-file value. */
function createCodexUsageAccumulator() {
  let total = null;
  const lastSum = {};
  let sawLast = false;
  return {
    /** True when the message was a token usage notification. */
    observe(message) {
      const usage = codexTokenUsageFromNotification(message);
      if (!usage) return false;
      if (usage.total) total = usage.total;
      if (usage.last) {
        sawLast = true;
        for (const key of ['inputTokens', 'outputTokens']) {
          if (usage.last[key] !== undefined) lastSum[key] = (lastSum[key] || 0) + usage.last[key];
        }
      }
      return true;
    },
    value() {
      if (total) return Object.assign({}, total);
      return sawLast && Object.keys(lastSum).length ? Object.assign({}, lastSum) : null;
    },
  };
}

function writeUsageFile(usageFile, usageValue) {
  if (!usageFile || !usageValue) return false;
  fs.mkdirSync(path.dirname(usageFile), { recursive: true, mode: 0o700 });
  const tmpPath = `${usageFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(usageValue), { mode: 0o600 });
  fs.renameSync(tmpPath, usageFile);
  return true;
}

// ─── Claude credential source (ToS gate) ────────────────────────────────────
//
// Which credential a Claude Code agent run may use is decided HERE, before
// claude starts, and re-checked against claude's own report (system/init
// apiKeySource):
//
//  - ANTHROPIC_API_KEY configured (Shelly Settings → .shelly/agents/.env,
//    handed to this process by the run script for this one call) → the run
//    uses the API key, attended or not. The subscription token is withheld.
//  - No API key, ATTENDED run (a person pressed Run now; policy.unattended is
//    not true) → the logged-in claude.ai subscription (/login credentials or
//    ~/.claude-token.env) may be used: the user is present.
//  - No API key, UNATTENDED run (scheduled / alarm / native one-tap of the
//    stored script) → the subscription (the owner's own /login or
//    setup-token, which Anthropic provides for non-interactive use) unless the
//    owner turned the setting `claudeSubscriptionUnattended` OFF (synced as
//    SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED=0). Default ON (owner decision
//    2026-10-31); only an explicit "0" refuses.
//
// The key reaches claude only through the child environment (never argv, never
// a log line) and the bashrc function's env file unsets it for every Bash-tool
// command claude runs.
const CLAUDE_SUBSCRIPTION_UNATTENDED_ENV = 'SHELLY_CLAUDE_SUBSCRIPTION_UNATTENDED';
const CLAUDE_UNATTENDED_REFUSAL =
  'Claude Code unattended run refused: no Anthropic API key is configured, and using the claude.ai subscription for unattended (scheduled) runs is turned off. Add an Anthropic API key in Settings, turn "Claude subscription for unattended runs" (claudeSubscriptionUnattended) back on, or run this agent with Run now.';

function claudeAuthPlan(policy, env) {
  const apiKey = typeof env.ANTHROPIC_API_KEY === 'string' && env.ANTHROPIC_API_KEY.trim() !== '';
  const unattended = isUnattendedPolicy(policy);
  // Default ON: absent / empty / anything but an explicit "0" allows it.
  const subscriptionUnattendedAllowed = String(env[CLAUDE_SUBSCRIPTION_UNATTENDED_ENV] ?? '').trim() !== '0';
  if (apiKey) return { source: 'api-key', unattended };
  if (!unattended) return { source: 'subscription', unattended, reason: 'attended run' };
  if (subscriptionUnattendedAllowed) return { source: 'subscription', unattended, reason: 'unattended subscription allowed (claudeSubscriptionUnattended)' };
  return { source: null, unattended, refusal: CLAUDE_UNATTENDED_REFUSAL };
}

/** Does claude's own report (system/init apiKeySource) match the plan? */
function claudeAuthMatchesPlan(plan, apiKeySource) {
  if (!plan || !plan.source) return false;
  // An absent report is not a match either: claude must say what it used.
  if (typeof apiKeySource !== 'string' || apiKeySource === '') return false;
  const billedToKey = typeof apiKeySource === 'string' && apiKeySource !== '' && apiKeySource !== 'none';
  return plan.source === 'api-key' ? billedToKey : !billedToKey;
}

function claudeChildEnv(input, plan = { source: 'subscription' }) {
  const env = codexChildEnv(input);
  for (const key of CLAUDE_CHILD_ENV_DROP) delete env[key];
  delete env[CLAUDE_SUBSCRIPTION_UNATTENDED_ENV];
  delete env.ANTHROPIC_AUTH_TOKEN;
  if (plan.source === 'api-key') {
    env.ANTHROPIC_API_KEY = String(input.ANTHROPIC_API_KEY || '').trim();
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    env.SHELLY_CLAUDE_AUTH = 'api-key';
  } else {
    delete env.ANTHROPIC_API_KEY;
    env.SHELLY_CLAUDE_AUTH = 'subscription';
  }
  env.SHELLY_CLAUDE_SETTINGS_JSON = claudeAgentSettingsJson();
  return env;
}

/**
 * The real directory of the reviewed build, from agent-current. Nothing moves
 * that link but `claude-install --agent`, and this still does not take its word
 * for it: a link left by an older pin, or pointing outside versions/, is refused.
 * Claude Code is not bundled, so there may be no such build at all, and then
 * the only honest answer is to say what to run.
 */
function resolveClaudeAgentRuntime(home, reviewed = CLAUDE_AGENT_REVIEWED) {
  const fix = 'Run claude-install --agent in a terminal, or use "Enable for agents" in the Builds screen.';
  const refuse = (found) => ({
    ok: false,
    refusal: `Claude Code agent worker refused: agents run only the reviewed Claude Code ${reviewed.version}, and ${found}. ${fix}`,
  });
  const root = path.join(home, '.shelly-runtime/claude-glibc');
  let dir;
  let versions;
  try {
    dir = fs.realpathSync(path.join(root, 'agent-current'));
    versions = fs.realpathSync(path.join(root, 'versions'));
  } catch {
    return refuse('none is installed for agents');
  }
  if (path.dirname(dir) !== versions) return refuse('agent-current points outside the runtime');
  let version = null;
  try {
    ({ version } = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')));
  } catch {
    return refuse('the installed copy has no version record');
  }
  if (version !== reviewed.version) return refuse(`the installed copy is ${String(version).slice(0, 40)}`);
  let size = -1;
  try {
    ({ size } = fs.statSync(path.join(dir, 'claude')));
  } catch {
    // Reported as a damaged copy below.
  }
  if (!existingPath(path.join(dir, '.healthy')) || size !== reviewed.size) {
    return refuse('the installed copy is damaged');
  }
  return { ok: true, dir, version };
}

function claudeRunnerSpawnSpec(config, plan, agentDir = '') {
  const claudeArgs = claudeAgentArgs();
  const android = androidLauncherContext();
  if (android) {
    // bash through linker64 + shelly_shell (the same launcher the Bash tool's
    // env file uses): the runner is an app_data_file script, which Knox will
    // not exec by shebang. shelly_shell re-adds the bionic exec wrapper.
    const env = claudeChildEnv({
      ...androidBaseEnv(android.libDir),
      ...androidToolEnv(android.libDir),
      LD_LIBRARY_PATH: android.libDir,
    }, plan);
    delete env.LD_PRELOAD;
    // The runner refuses to start unless this is the directory agent-current names.
    env.SHELLY_CLAUDE_AGENT_DIR = agentDir;
    const args = [path.join(android.libDir, 'shelly_shell'), config.claudeRunner, ...claudeArgs];
    return { mode: 'android-linker64-shelly_shell', command: ANDROID_LINKER64, args, env, display: [ANDROID_LINKER64, ...args] };
  }
  const args = [config.claudeRunner, ...claudeArgs];
  return {
    mode: 'host-path',
    command: config.claudeRunnerInterpreter,
    args,
    env: claudeChildEnv(process.env, plan),
    display: [config.claudeRunnerInterpreter, ...args],
  };
}

/** Every live descendant of `rootPid` (Linux /proc walk); [] elsewhere. */
function listDescendantPids(rootPid) {
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  const children = new Map();
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue;
    }
    // pid (comm) state ppid … — comm may contain spaces/parens; split after the last ')'.
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    const ppid = Number(fields[1]);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(Number(name));
  }
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    for (const child of children.get(pid) || []) {
      if (out.includes(child)) continue;
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * Signal the runner AND everything under it (subshell, private proxy, claude,
 * its tool shells). Killing only the direct child would leave claude running:
 * bash does not forward SIGTERM to a foreground child. STOP-ALL still works
 * without this (it kills the whole process group, which nothing here leaves).
 */
function signalProcessTree(child, signal) {
  if (!child || !child.pid) return;
  const pids = listDescendantPids(child.pid);
  for (const pid of [child.pid, ...pids]) {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function runClaudeDriver(config) {
  const audit = createAuditWriter(config.auditLog);
  // Same ordering as runDriver: pin-verify the escalation key before the
  // child (which can run agent-chosen commands) exists.
  ensureEscalationVerifierKey(config, audit);
  if (config.answerFile) unlinkIfExists(config.answerFile);
  if (config.usageFile) unlinkIfExists(config.usageFile);
  const authPlan = claudeAuthPlan(config.policy, process.env);
  audit('claude_auth_plan', {
    source: authPlan.source,
    unattended: authPlan.unattended,
    reason: authPlan.reason || authPlan.refusal || null,
  });
  if (!authPlan.source) {
    process.stdout.write(`CLAUDE_ERROR ${authPlan.refusal}\n`);
    audit('driver_finish', { reason: 'claude_auth_refused', exitCode: 1, engine: 'claude' });
    process.exit(1);
    return;
  }
  // Android only: the host mode exists for tests, with a fake claude as the runner.
  let agentDir = '';
  if (androidLauncherContext()) {
    const runtime = resolveClaudeAgentRuntime(process.env.HOME || '');
    audit('claude_agent_runtime', { ok: runtime.ok, version: runtime.version || null, reason: runtime.refusal || null });
    if (!runtime.ok) {
      process.stdout.write(`CLAUDE_ERROR ${runtime.refusal}\n`);
      audit('driver_finish', { reason: 'claude_agent_runtime_refused', exitCode: 1, engine: 'claude' });
      process.exit(1);
      return;
    }
    agentDir = runtime.dir;
  }
  const claudeSpawn = claudeRunnerSpawnSpec(config, authPlan, agentDir);
  const gateSpawn = gateSpawnSpec(config);
  const child = spawn(claudeSpawn.command, claudeSpawn.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: config.cwd,
    env: claudeSpawn.env,
  });

  let buffer = '';
  let queue = Promise.resolve();
  let completed = false;
  let sawFailure = false;
  let sawResult = false;
  let apiKeySource = null;
  let timeout = null;
  const respondedIds = new Set();

  const send = (message) => {
    const line = JSON.stringify(message);
    // The user message carries the prompt; never echo it into the run output.
    rawLine('C->S', message && message.type === 'user' ? '{"type":"user","message":"[prompt]"}' : line);
    try {
      child.stdin.write(`${line}\n`);
    } catch (error) {
      sawFailure = true;
      audit('send_error', { error: error.message, type: message && message.type });
    }
  };

  const respondControl = (requestId, response) => {
    const key = String(requestId);
    if (respondedIds.has(key)) {
      audit('duplicate_response_blocked', { requestId });
      return;
    }
    respondedIds.add(key);
    send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
  };

  const respondControlError = (requestId, error) => {
    const key = String(requestId);
    if (respondedIds.has(key)) return;
    respondedIds.add(key);
    send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } });
  };

  const finish = (reason, exitCode) => {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    audit('driver_finish', { reason, exitCode, engine: 'claude' });
    try {
      child.stdin.end();
    } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      // Give claude a moment to exit on stdin EOF, then take the tree down.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) signalProcessTree(child, 'SIGTERM');
      }, 300).unref();
      setTimeout(() => {
        audit('claude_sigkill_fallback', { reason });
        signalProcessTree(child, 'SIGKILL');
      }, 1500).unref();
      setTimeout(() => process.exit(exitCode), 1800);
    } else {
      signalProcessTree(child, 'SIGKILL');
      setTimeout(() => process.exit(exitCode), 50);
    }
  };

  const handleCanUseTool = async (requestId, request) => {
    const toolName = request && typeof request.tool_name === 'string' ? request.tool_name : '';
    const input = request && request.input && typeof request.input === 'object' ? request.input : {};
    let response = { behavior: 'deny', message: 'Shelly agent gate: denied' };
    try {
      const mapped = claudeToolToActions(toolName, input, config.cwd);
      if (mapped.deny) {
        response = { behavior: 'deny', message: `Shelly agent gate: ${mapped.deny}` };
        gateLine(config.auditLog, {
          requestId,
          approvalKind: 'claude:can_use_tool',
          tool: toolName,
          command: '',
          cwd: config.cwd,
          answer: 'n',
          decision: 'deny',
          reason: mapped.deny,
        });
        return;
      }
      const gated = await gateCommandActions(config, audit, mapped.actions, {
        requestId,
        approvalKind: `claude:${toolName}`,
        lineContext: { toolUseId: request && request.tool_use_id },
        protocolDecisionOf: (finalDecision) => (finalDecision === 'accept' ? 'allow' : 'deny'),
      });
      response = gated.protocolDecision === 'allow'
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: 'Shelly agent gate declined this action (see the agent audit log).' };
    } catch (error) {
      sawFailure = true;
      gateLine(config.auditLog, {
        requestId,
        approvalKind: `claude:${toolName}`,
        command: '',
        cwd: config.cwd,
        answer: 'escalate',
        decision: 'deny',
        reason: `approval handler failed: ${error.message}`,
        stack: error.stack,
      });
    } finally {
      respondControl(requestId, response);
    }
  };

  const handleResult = (message) => {
    sawResult = true;
    const ok = message.subtype === 'success' && message.is_error !== true;
    const text = typeof message.result === 'string' ? message.result : '';
    try {
      const wroteAnswer = ok ? writeAnswerFile(config.answerFile, text) : false;
      audit('answer_file_written', { answerFile: config.answerFile, wroteAnswer, textLength: text.length });
    } catch (error) {
      sawFailure = true;
      audit('answer_file_write_error', { answerFile: config.answerFile, error: error.message });
    }
    const usageValue = claudeUsageFromResult(message, apiKeySource);
    try {
      const wroteUsage = writeUsageFile(config.usageFile, usageValue);
      audit('usage_recorded', { usageFile: config.usageFile, wroteUsage, usage: usageValue });
    } catch (error) {
      audit('usage_write_error', { usageFile: config.usageFile, error: error.message });
    }
    audit('turn_completed', {
      engine: 'claude',
      subtype: message.subtype,
      isError: message.is_error === true,
      numTurns: message.num_turns,
      durationMs: message.duration_ms,
      permissionDenials: Array.isArray(message.permission_denials) ? message.permission_denials.length : 0,
    });
    if (!ok && text) process.stdout.write(`CLAUDE_ERROR ${redact(text.slice(0, 2000))}\n`);
    finish('turn_completed', ok && !sawFailure ? 0 : 1);
  };

  const handleMessage = async (message) => {
    if (!message || typeof message !== 'object') return;
    // After finish() (auth mismatch, timeout, …) nothing claude says counts:
    // no answer file, no usage, no further tool approvals.
    if (completed) return;
    if (message.type === 'control_request') {
      const requestId = message.request_id;
      const request = message.request || {};
      if (request.subtype === 'can_use_tool') {
        await handleCanUseTool(requestId, request);
        return;
      }
      audit('unknown_control_request', { requestId, subtype: request.subtype || null });
      respondControlError(requestId, `unsupported control request: ${request.subtype || '(none)'}`);
      return;
    }
    if (message.type === 'control_response') {
      const resp = message.response || {};
      if (resp.request_id === CLAUDE_INIT_REQUEST_ID) {
        audit('claude_initialized', { subtype: resp.subtype || null, error: resp.error || null });
      }
      return;
    }
    if (message.type === 'control_cancel_request') {
      audit('control_cancel_request', { requestId: message.request_id || null });
      return;
    }
    if (message.type === 'system' && message.subtype === 'init') {
      apiKeySource = typeof message.apiKeySource === 'string' ? message.apiKeySource : null;
      // Fail closed on ANY difference between the planned credential and the one
      // claude reports, in both directions, attended or not (Codex review H,
      // 2026-10-31). The settings only choose the plan before launch; nothing
      // excuses a mismatch after launch.
      if (!claudeAuthMatchesPlan(authPlan, apiKeySource)) {
        sawFailure = true;
        audit('claude_auth_mismatch', { planned: authPlan.source, apiKeySource });
        process.stdout.write(`CLAUDE_ERROR Claude Code authenticated with ${apiKeySource || 'an unknown credential'} instead of the planned ${authPlan.source}; stopped.\n`);
        finish('claude_auth_mismatch', 1);
        return;
      }
      const toolCheck = claudeInitToolCheck(message.tools);
      if (!toolCheck.ok) {
        sawFailure = true;
        audit('claude_init_tools_blocked', { reason: toolCheck.reason, unexpected: toolCheck.unexpected.slice(0, 40) });
        process.stdout.write(`CLAUDE_ERROR Claude Code started with tools outside the Shelly agent allowlist (${toolCheck.unexpected.slice(0, 5).join(', ') || toolCheck.reason}); stopped.\n`);
        finish('claude_init_tools_blocked', 1);
        return;
      }
      if (toolCheck.denied.length) audit('claude_init_denied_tools_listed', { denied: toolCheck.denied.slice(0, 40) });
      audit('thread_started', {
        engine: 'claude',
        cwd: message.cwd || config.cwd,
        model: message.model || null,
        permissionMode: message.permissionMode || null,
        apiKeySource,
        tools: Array.isArray(message.tools) ? message.tools.slice(0, 60) : null,
        mcpServers: Array.isArray(message.mcp_servers) ? message.mcp_servers.length : null,
      });
      return;
    }
    if (message.type === 'assistant') {
      const content = message.message && Array.isArray(message.message.content) ? message.message.content : [];
      for (const block of content) {
        if (block && block.type === 'tool_use') {
          audit('item_started', { itemType: 'tool_use', tool: block.name, itemId: block.id });
          if (!CLAUDE_GATED_TOOLS.includes(block.name)) {
            // Layer 4: a tool outside the allowlist never reaches the gate
            // (permission-free tools skip can_use_tool) — stop the run.
            sawFailure = true;
            audit('claude_tool_outside_allowlist', { tool: String(block.name || '').slice(0, 80), itemId: block.id });
            process.stdout.write(`CLAUDE_ERROR Claude Code used a tool outside the Shelly agent allowlist (${String(block.name || '').slice(0, 80)}); stopped.\n`);
            finish('claude_tool_outside_allowlist', 1);
            return;
          }
        }
      }
      return;
    }
    if (message.type === 'result') {
      handleResult(message);
    }
  };

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // The runner's own diagnostics (missing runtime, proxy failure) are plain text.
        rawLine('STDOUT', redact(line));
        continue;
      }
      if (message && message.type !== 'assistant' && message.type !== 'user' && message.type !== 'stream_event') {
        rawLine('S->C', redact(line.slice(0, 4000)));
      }
      queue = queue.then(() => handleMessage(message)).catch((error) => {
        sawFailure = true;
        audit('handler_error', { error: error.message, stack: error.stack });
      });
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().replace(/\n$/, '');
    process.stdout.write(`STDERR ${redact(text)}\n`);
  });

  child.stdin.on('error', (error) => {
    audit('stdin_error', { error: error.message });
  });

  child.on('error', (error) => {
    sawFailure = true;
    audit('claude_spawn_error', { error: error.message });
    finish('claude_spawn_error', 1);
  });

  child.on('exit', (code, signal) => {
    if (completed) return;
    // Let queued stdout handlers (the result message) settle first.
    queue.then(() => {
      if (completed) return;
      audit('claude_exit', { code, signal, sawResult });
      finish('claude_exit', 1);
    });
  });

  const onSignal = (signal) => {
    audit('driver_signal', { signal });
    signalProcessTree(child, 'SIGKILL');
    process.exit(143);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  timeout = setTimeout(() => {
    sawFailure = true;
    finish(`timeout_${config.timeoutMs}ms`, 124);
  }, config.timeoutMs);

  audit('driver_start', {
    engine: 'claude',
    cwd: config.cwd,
    gateScript: config.gateScript,
    claudeRunner: config.claudeRunner,
    claudeLaunchMode: claudeSpawn.mode,
    claudeSpawn: claudeSpawn.display,
    claudeSettings: claudeAgentSettingsJson(),
    claudeAuthSource: authPlan.source,
    gateLaunchMode: gateSpawn.mode,
    gateSpawn: gateSpawn.display,
    gateNode: gateSpawn.nodePath,
    approvalPolicy: config.approvalPolicy,
    runId: config.runId,
    agentId: config.agentId,
    escalationDir: config.escalationDir,
    escalationKeyPinned: Boolean(config.escalationPublicKeySha256),
    escalationKeyTrusted: Boolean(config.escalationVerifierPublicKey),
    escalationTimeoutMs: config.escalationTimeoutMs,
    escalationTimeoutAction: config.escalationTimeoutAction,
    policy: { ...config.policy, workspaceRoot: config.policy.workspaceRoot },
  });
  send({ type: 'control_request', request_id: CLAUDE_INIT_REQUEST_ID, request: { subtype: 'initialize', hooks: null } });
  send({
    type: 'user',
    session_id: '',
    message: { role: 'user', content: [{ type: 'text', text: workerPrompt(config.prompt) }] },
    parent_tool_use_id: null,
  });
}

async function main() {
  try {
    const config = ensureConfig(parseArgs(process.argv));
    if (config.help) {
      usage();
      return;
    }
    if (config.engine === 'claude') {
      await runClaudeDriver(config);
      return;
    }
    await runDriver(config);
  } catch (error) {
    process.stderr.write(`shelly-agent-driver: ${error.message}\n`);
    process.exit(1);
  }
}

// Run as a CLI (incl. on Android via `node .shelly-agent-driver.js`); require() in tests instead.
if (require.main === module) {
  main();
}

// Exported for unit tests only (no behavior change to the CLI path).
module.exports = {
  WORKER_PROMPT_HINT,
  workerPrompt,
  WORKER_ENV_DROP,
  sanitizeWorkerEnv,
  codexChildEnv,
  codexAppServerSpawnSpec,
  CODEX_WORKER_DISABLED_FEATURES,
  CODEX_GATED_ITEM_TYPES,
  CODEX_HARMLESS_ITEM_TYPES,
  codexItemDisposition,
  codexWebSearchAudit,
  codexWebSearchLeakCheck,
  codexLeakSecrets,
  codexWireLineForLog,
  runtimeCodexTuiPath,
  claudeInitToolCheck,
  codexMcpDisableArgs,
  parseCodexMcpList,
  codexMcpPreflight,
  CODEX_ISOLATED_HOME_PREFIX,
  realCodexHome,
  codexWorkerConfigToml,
  CODEX_WORKER_CARRIED_CONFIG_KEYS,
  parseCarriedCodexConfig,
  readCarriedCodexConfig,
  copyCodexAgentsMd,
  createCodexIsolatedHome,
  removeCodexIsolatedHome,
  codexWorkerEnv,
  CODEX_ISOLATED_HOMES_PARENT,
  CODEX_ISOLATED_HOME_MARKER,
  assertPrivateDir,
  ensureCodexIsolatedHomesParent,
  sweepStaleCodexIsolatedHomes,
  persistIsolatedCodexAuth,
  claudeRunnerSpawnSpec,
  resolveClaudeAgentRuntime,
  CLAUDE_AGENT_REVIEWED,
  gateSpawnSpec,
  isUnattendedPolicy,
  preapprovalGrantSignatureMessage,
  verifyPreapprovalGrantSignature,
  findPreapprovalGrant,
  isReplayDangerousSignals,
  normalizeSha256Hex,
  ensureEscalationVerifierKey,
  verifyGrantUseReceipt,
  grantUseReceiptSignatureMessage,
  commandSha256,
  completedAgentMessageText,
  appendCompletedAgentMessage,
  writeAnswerFile,
  buildActionPolicyInput,
  policySealAccepts,
  androidToolEnv,
  codexPolicyEnvArgs,
  claudeToolToActions,
  normalizeFileChanges,
  fileChangeToActions,
  claudeUsageFromResult,
  codexTokenUsageFromNotification,
  createCodexUsageAccumulator,
  writeUsageFile,
  claudeAgentArgs,
  claudeAgentSettingsJson,
  claudeChildEnv,
  claudeAuthPlan,
  claudeAuthMatchesPlan,
  CLAUDE_DENIED_TOOLS,
  CLAUDE_GATED_TOOLS,
  CLAUDE_ALLOWED_TOOLS,
};
