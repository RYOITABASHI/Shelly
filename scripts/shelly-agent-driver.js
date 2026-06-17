#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_GATE_SCRIPT = path.resolve(
  __dirname,
  '../modules/terminal-emulator/android/src/main/assets/shelly-gate-decide.js',
);

function usage() {
  process.stdout.write(`Usage:
  node scripts/shelly-agent-driver.js --cwd <workspace> --prompt <text> [options]

Options:
  --prompt-file <path>       Read prompt text from a file.
  --policy-json <json>       AutonomyPolicy JSON. Defaults to L2 + workspace cwd.
  --policy-file <path>       Read AutonomyPolicy JSON from a file.
  --gate-script <path>       Gate helper path. Defaults to bundled asset.
  --codex-bin <path>         Codex executable. Defaults to "codex".
  --node-bin <path>          Node executable for the gate helper. Defaults to current node.
  --approval-policy <mode>   Defaults to "untrusted" (B2 Phase A safe config).
  --audit-log <path>         Append AUDIT/GATE JSON lines to this file.
  --timeout-ms <ms>          Whole turn timeout. Defaults to 300000.
  --gate-timeout-ms <ms>     Gate helper timeout. Defaults to 5000.
  --help                     Show this help.
`);
}

function parseArgs(argv) {
  const args = {
    codexBin: 'codex',
    nodeBin: process.execPath,
    gateScript: DEFAULT_GATE_SCRIPT,
    approvalPolicy: 'untrusted',
    timeoutMs: 300000,
    gateTimeoutMs: 5000,
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
      args.gateTimeoutMs = Number(next());
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
  if (!['untrusted', 'on-failure', 'on-request', 'never'].includes(args.approvalPolicy)) {
    throw new Error('invalid --approval-policy');
  }

  const cwd = path.resolve(args.cwd);
  const prompt = readPrompt(args);
  const policy = readJsonArg(args);
  if (!policy.workspaceRoot) policy.workspaceRoot = cwd;
  if (!policy.level) policy.level = 'L2';

  return {
    ...args,
    cwd,
    prompt,
    policy,
    gateScript: path.resolve(args.gateScript),
  };
}

function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\b([A-Za-z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*=)([^\s'"`]+)/gi, '$1[REDACTED]');
}

function extractCommand(params) {
  const actions = Array.isArray(params && params.commandActions) ? params.commandActions : [];
  const actionCommands = actions
    .map((action) => (action && typeof action.command === 'string' ? action.command.trim() : ''))
    .filter(Boolean);
  if (actionCommands.length === 1) return actionCommands[0];
  if (actionCommands.length > 1) return actionCommands.join(' && ');
  if (params && typeof params.command === 'string') return params.command;
  return '';
}

function rawLine(prefix, line) {
  process.stdout.write(`${prefix} ${line}\n`);
}

function createAuditWriter(auditLog) {
  return (kind, payload) => {
    const entry = {
      ts: new Date().toISOString(),
      kind,
      ...payload,
    };
    const line = JSON.stringify(entry);
    process.stdout.write(`AUDIT ${line}\n`);
    if (auditLog) fs.appendFileSync(auditLog, `${line}\n`);
  };
}

function gateLine(auditLog, payload) {
  const entry = {
    ts: new Date().toISOString(),
    kind: 'gate_decision',
    ...payload,
  };
  const line = JSON.stringify(entry);
  process.stdout.write(`GATE ${line}\n`);
  if (auditLog) fs.appendFileSync(auditLog, `${line}\n`);
}

function runGate(config, command) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(config.nodeBin, [config.gateScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: config.cwd,
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
        child.kill('SIGKILL');
      } catch {}
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

async function runDriver(config) {
  if (!fs.existsSync(config.cwd)) fs.mkdirSync(config.cwd, { recursive: true });
  if (!fs.existsSync(config.gateScript)) throw new Error(`gate helper not found: ${config.gateScript}`);

  const audit = createAuditWriter(config.auditLog);
  const child = spawn(config.codexBin, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: config.cwd,
  });

  let buffer = '';
  let nextId = 1;
  let initialized = false;
  let threadId = null;
  let turnStarted = false;
  let completed = false;
  let sawFailure = false;

  const send = (message) => {
    const line = JSON.stringify(message);
    rawLine('C->S', line);
    child.stdin.write(`${line}\n`);
  };

  const request = (method, params) => {
    const id = nextId++;
    send({ id, method, params });
    return id;
  };

  const finish = (reason, exitCode) => {
    if (completed) return;
    completed = true;
    clearTimeout(timeout);
    audit('driver_finish', { reason, exitCode, threadId });
    try {
      child.kill('SIGTERM');
    } catch {}
    setTimeout(() => process.exit(exitCode), 100);
  };

  const respond = (id, result) => {
    send({ id, result });
  };

  const handleInitialize = () => {
    if (initialized) return;
    initialized = true;
    send({ method: 'initialized' });
    request('thread/start', {
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
    request('turn/start', {
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

  const handleApproval = async (message) => {
    const params = message.params || {};
    const command = extractCommand(params);
    const cwd = typeof params.cwd === 'string' ? params.cwd : config.cwd;
    const redactedCommand = redact(command);

    if (!command) {
      const result = { decision: 'decline' };
      gateLine(config.auditLog, {
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        command: '',
        cwd,
        answer: 'escalate',
        decision: result.decision,
        reason: 'missing command in approval params',
      });
      respond(message.id, result);
      return;
    }

    const gate = await runGate(config, command);
    const decision = mapGateToDecision(gate.answer);
    const auditPayload = gate.outcome && gate.outcome.audit ? gate.outcome.audit : {};
    const verdict = gate.outcome && gate.outcome.verdict ? gate.outcome.verdict : null;

    if (gate.answer === 'escalate') {
      process.stdout.write(`ESCALATE human_required command=${JSON.stringify(redactedCommand)} phase=PhaseA action=decline\n`);
    }

    gateLine(config.auditLog, {
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      requestId: message.id,
      command: auditPayload.command || redactedCommand,
      cwd,
      answer: gate.answer,
      decision,
      verdictDecision: verdict && verdict.decision,
      reason: auditPayload.reason || gate.error || null,
      signals: auditPayload.signals || [],
      level: auditPayload.level || config.policy.level,
      gateElapsedMs: gate.elapsedMs,
      gateError: gate.error || null,
      rawGateStdout: gate.rawStdout ? gate.rawStdout.trim() : '',
      rawGateStderr: gate.rawStderr ? gate.rawStderr.trim() : '',
    });

    respond(message.id, { decision });
  };

  const handleMessage = async (message) => {
    if (message.id === 1 && message.result) {
      handleInitialize();
      return;
    }
    if (message.id === 2 && message.result && message.result.thread) {
      handleThreadStart(message);
      return;
    }
    if (message.id === 3 && message.result && message.result.turn) {
      turnStarted = true;
      audit('turn_started', {
        threadId,
        turnId: message.result.turn.id,
        status: message.result.turn.status,
      });
      return;
    }

    if (message.method === 'item/started') {
      auditItemStarted(message.params);
      return;
    }

    if (message.method === 'item/commandExecution/requestApproval') {
      await handleApproval(message);
      return;
    }

    if (message.method === 'execCommandApproval') {
      const command = Array.isArray(message.params && message.params.command)
        ? message.params.command.join(' ')
        : '';
      const gate = await runGate(config, command);
      const decision = gate.answer === 'y' ? 'approved' : 'denied';
      gateLine(config.auditLog, {
        requestId: message.id,
        command: redact(command),
        cwd: message.params && message.params.cwd,
        answer: gate.answer,
        decision,
        reason: gate.error || (gate.outcome && gate.outcome.audit && gate.outcome.audit.reason) || null,
      });
      respond(message.id, { decision });
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
      Promise.resolve(handleMessage(message)).catch((error) => {
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

  const timeout = setTimeout(() => {
    sawFailure = true;
    finish(`timeout_${config.timeoutMs}ms`, 124);
  }, config.timeoutMs);

  audit('driver_start', {
    cwd: config.cwd,
    gateScript: config.gateScript,
    codexBin: config.codexBin,
    nodeBin: config.nodeBin,
    approvalPolicy: config.approvalPolicy,
    policy: {
      ...config.policy,
      workspaceRoot: config.policy.workspaceRoot,
    },
  });
  request('initialize', {
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

main();
