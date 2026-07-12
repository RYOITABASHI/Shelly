#!/usr/bin/env node

const { spawn } = require('child_process');
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

function readPrompt(args) {
  if (args.prompt && args.promptFile) {
    throw new Error('use only one of --prompt or --prompt-file');
  }
  if (args.promptFile) return fs.readFileSync(args.promptFile, 'utf8');
  if (args.prompt) return args.prompt;
  throw new Error('missing --prompt or --prompt-file');
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

  const requestedCwd = path.resolve(args.cwd);
  if (!fs.existsSync(requestedCwd)) fs.mkdirSync(requestedCwd, { recursive: true });
  const cwd = fs.realpathSync(requestedCwd);
  const prompt = readPrompt(args);
  const policy = readJsonArg(args);
  // Workspace root is realpathed here; per-argument symlink resolution remains a later hardening gap.
  policy.workspaceRoot = cwd;
  if (!policy.level) policy.level = 'L2';

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

function runtimeCodexTuiPath(home) {
  if (!home || process.env.SHELLY_DISABLE_APP_DATA_CODEX_RUNTIME === '1') return '';
  const current = path.join(home, '.shelly-runtime/codex/current');
  const tuiPath = path.join(current, 'codex_tui');
  if (
    existingPath(path.join(current, '.healthy')) &&
    existingPath(path.join(current, 'manifest.json')) &&
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

function codexChildEnv(input) {
  const env = { ...input };
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

function codexAppServerSpawnSpec(config) {
  const android = androidLauncherContext();
  if (android) {
    const codexTui = resolveAndroidCodexTui(android.libDir);
    const codexDir = path.dirname(codexTui);
    const env = codexChildEnv({
      ...androidBaseEnv(android.libDir),
      // Keep this recipe in sync with HomeInitializer.kt __shelly_codex_run_tui.
      // The shell wrapper's native-crash fallback is not duplicated here; this
      // selector health-gates app-data runtime before bundled codex_tui fallback.
      SHELLY_CODEX_EXEC_PATH: codexTui,
      SHELLY_CODEX_PROC_EXE_SHIM: '1',
      SHELLY_CODEX_PROC_EXE_OPEN_SHIM: '1',
      LD_PRELOAD: path.join(android.libDir, 'libexec_wrapper.so'),
      LD_LIBRARY_PATH: `${codexDir}:${android.libDir}`,
    });
    const args = [codexTui, 'app-server', '--listen', 'stdio://'];
    return {
      mode: 'android-linker64-codex_tui',
      command: ANDROID_LINKER64,
      args,
      env,
      display: [ANDROID_LINKER64, ...args],
      codexBinary: codexTui,
      codexTui,
      libDir: android.libDir,
    };
  }
  const args = ['app-server', '--listen', 'stdio://'];
  return {
    mode: 'host-path',
    command: config.codexBin,
    args,
    env: codexChildEnv(process.env),
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
    const env = {
      ...androidBaseEnv(android.libDir),
      LD_LIBRARY_PATH: android.libDir,
    };
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
    env: process.env,
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

async function runDriver(config) {
  const audit = createAuditWriter(config.auditLog);
  // Load + pin-verify the escalation verifier key BEFORE spawning codex, so a same-uid agent can
  // never overwrite the DER before it is cached in memory. After this the cached key object is used
  // for all verifies regardless of later on-disk tampering.
  ensureEscalationVerifierKey(config, audit);
  const codexSpawn = codexAppServerSpawnSpec(config);
  const gateSpawn = gateSpawnSpec(config);
  const child = spawn(codexSpawn.command, codexSpawn.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: config.cwd,
    env: codexSpawn.env,
  });

  let buffer = '';
  let nextId = 1;
  const pending = new Map();
  const respondedIds = new Set();
  let queue = Promise.resolve();
  let initialized = false;
  let threadId = null;
  let turnStarted = false;
  let completed = false;
  let sawFailure = false;
  let timeout = null;

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
      input: [{ type: 'text', text: config.prompt, text_elements: [] }],
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
    audit('item_started', entry);
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
          const auditPayload = result.outcome && result.outcome.audit ? result.outcome.audit : {};
          const redactedCommand = redact(result.action.command);
          const reqId = gateResults.length === 1
            ? String(message.id)
            : `${message.id}-${result.action.index}`;

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

          const escalation = await waitForEscalation(config, {
            reqId,
            command: auditPayload.command || redactedCommand,
            commandSha256: commandSha256(result.action.command),
            workspaceRoot: config.policy.workspaceRoot,
            cwd: result.action.cwd,
            reason: auditPayload.reason || null,
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

      const protocolDecision = legacy
        ? finalDecision === 'accept' ? 'approved' : 'denied'
        : finalDecision;
      response = { decision: protocolDecision };

      for (const result of gateResults) {
        const auditPayload = result.outcome && result.outcome.audit ? result.outcome.audit : {};
        const verdict = result.outcome && result.outcome.verdict ? result.outcome.verdict : null;
        const escalation = escalationOutcomes.get(result.action.index) || null;
        const actionDecision = result.answer === 'escalate'
          ? escalation && escalation.decision === 'accept' ? 'accept' : 'decline'
          : mapGateToDecision(result.answer);
        const redactedCommand = redact(result.action.command);

        gateLine(config.auditLog, {
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: params.itemId,
          requestId: message.id,
          approvalKind,
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
    if (isClientResponse(message)) {
      handleClientResponse(message);
      return;
    }

    if (isServerRequest(message)) {
      await handleServerRequest(message);
      return;
    }

    if (message.method === 'item/started') {
      auditItemStarted(message.params);
      return;
    }

    if (message.method === 'turn/completed') {
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
      rawLine('S->C', line);
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

  audit('driver_start', {
    cwd: config.cwd,
    gateScript: config.gateScript,
    codexBin: config.codexBin,
    codexLaunchMode: codexSpawn.mode,
    codexSpawn: codexSpawn.display,
    codexBinary: codexSpawn.codexBinary,
    codexTui: codexSpawn.codexTui,
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
  request('initialize', 'initialize', {
    clientInfo: { name: 'shelly-agent-driver', version: '0.1.0' },
    capabilities: {},
  });
}

async function main() {
  try {
    const config = ensureConfig(parseArgs(process.argv));
    if (config.help) {
      usage();
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
  preapprovalGrantSignatureMessage,
  verifyPreapprovalGrantSignature,
  findPreapprovalGrant,
  isReplayDangerousSignals,
  normalizeSha256Hex,
  ensureEscalationVerifierKey,
  verifyGrantUseReceipt,
  grantUseReceiptSignatureMessage,
  commandSha256,
};
