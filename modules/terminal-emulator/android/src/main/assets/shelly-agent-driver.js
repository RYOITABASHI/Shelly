#!/usr/bin/env node

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_GATE_SCRIPT = path.join(process.env.HOME || process.cwd(), '.shelly-gate-decide.js');
const DEFAULT_ESCALATION_TIMEOUT_MS = 120000;
const DEFAULT_ESCALATION_DIR = path.join(os.tmpdir(), 'shelly-agent-escalations');
const DEFAULT_ESCALATION_REPLY_DIR = path.join(os.tmpdir(), 'shelly-agent-escalation-replies');
const ESCALATION_POLL_MS = 250;

function usage() {
  process.stdout.write(`Usage:
  node scripts/shelly-agent-driver.js --cwd <workspace> --prompt <text> [options]

Options:
  --prompt-file <path>       Read prompt text from a file.
  --policy-json <json>       AutonomyPolicy JSON. Defaults to L2 + workspace cwd.
  --policy-file <path>       Read AutonomyPolicy JSON from a file.
  --gate-script <path>       Gate helper path. Defaults to $HOME/.shelly-gate-decide.js.
  --codex-bin <path>         Codex executable. Defaults to "codex".
  --node-bin <path>          Node executable for the gate helper. Defaults to current node.
  --approval-policy <mode>   Defaults to "untrusted" (B2 Phase A safe config; only untrusted is allowed).
  --audit-log <path>         Append AUDIT/GATE JSON lines to this file.
  --timeout-ms <ms>          Whole turn timeout. Defaults to 300000.
  --gate-timeout-ms <ms>     Gate helper timeout. Defaults to 5000.
  --escalation-dir <path>    Directory for gray escalation request files.
  --escalation-reply-dir <path>
                             Directory for human reply files. Production must be agent-unwritable.
  --escalation-timeout-ms <ms>
                             Gray escalation wait timeout. Defaults to ESCALATION_TIMEOUT_MS or 120000.
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
    escalationTimeoutMs: parsePositiveInt(
      process.env.ESCALATION_TIMEOUT_MS || DEFAULT_ESCALATION_TIMEOUT_MS,
      'ESCALATION_TIMEOUT_MS',
    ),
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
      args.escalationTimeoutMs = parsePositiveInt(next(), '--escalation-timeout-ms');
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
  if (!Number.isFinite(args.escalationTimeoutMs) || args.escalationTimeoutMs <= 0) {
    throw new Error('invalid --escalation-timeout-ms');
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
    // Security: the temp default is host/dev only. Production Part B must pass a reply
    // channel the agent cannot write, such as RN app-private storage or a driver-owned FD.
    escalationReplyDir: path.resolve(args.escalationReplyDir),
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

function writeJsonAtomic(filePath, payload) {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`,
  );
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
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

async function waitForEscalation(config, request, audit) {
  const paths = buildEscalationPaths(config, request.reqId);
  const startedAt = Date.now();
  let wroteRequest = false;

  try {
    fs.mkdirSync(config.escalationDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(config.escalationReplyDir, { recursive: true, mode: 0o700 });
    unlinkIfExists(paths.requestPath);
    unlinkIfExists(paths.replyPath);

    const requestPayload = {
      runId: config.runId,
      agentId: config.agentId,
      reqId: request.reqId,
      command: request.command,
      cwd: request.cwd,
      reason: request.reason,
      signals: request.signals,
      level: request.level,
      ts: new Date().toISOString(),
    };
    writeJsonAtomic(paths.requestPath, requestPayload);
    wroteRequest = true;

    process.stdout.write(
      `ESCALATE human_required command=${JSON.stringify(request.command)} reqId=${JSON.stringify(request.reqId)} requestPath=${JSON.stringify(paths.requestPath)} replyPath=${JSON.stringify(paths.replyPath)} action=wait\n`,
    );
    audit('escalation_requested', {
      ...requestPayload,
      requestPath: paths.requestPath,
      replyPath: paths.replyPath,
      timeoutMs: config.escalationTimeoutMs,
    });
  } catch (error) {
    cleanupEscalationFiles(paths, audit);
    return failClosedEscalation(audit, {
      reqId: request.reqId,
      reason: `escalation request I/O failed: ${error.message}`,
      requestPath: paths.requestPath,
      replyPath: paths.replyPath,
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
            replyPath: paths.replyPath,
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
            replyPath: paths.replyPath,
            elapsedMs: Date.now() - startedAt,
          });
        }

        if (String(reply.reqId) !== String(request.reqId)) {
          return failClosedEscalation(audit, {
            reqId: request.reqId,
            reason: `escalation reply reqId mismatch: ${reply.reqId}`,
            reply,
            requestPath: paths.requestPath,
            replyPath: paths.replyPath,
            elapsedMs: Date.now() - startedAt,
          });
        }
        if (reply.decision !== 'accept' && reply.decision !== 'decline') {
          return failClosedEscalation(audit, {
            reqId: request.reqId,
            reason: `invalid escalation decision: ${reply.decision}`,
            reply,
            requestPath: paths.requestPath,
            replyPath: paths.replyPath,
            elapsedMs: Date.now() - startedAt,
          });
        }

        audit('escalation_resolved', {
          reqId: request.reqId,
          decision: reply.decision,
          requestPath: paths.requestPath,
          replyPath: paths.replyPath,
          elapsedMs: Date.now() - startedAt,
        });
        process.stdout.write(
          `ESCALATE_RESOLVED reqId=${JSON.stringify(request.reqId)} decision=${JSON.stringify(reply.decision)} elapsedMs=${Date.now() - startedAt}\n`,
        );
        return { decision: reply.decision, reason: 'human reply' };
      }

      await sleep(Math.min(ESCALATION_POLL_MS, Math.max(1, deadline - Date.now())));
    }

    audit('escalation_timeout', {
      reqId: request.reqId,
      decision: 'decline',
      requestPath: paths.requestPath,
      replyPath: paths.replyPath,
      timeoutMs: config.escalationTimeoutMs,
      elapsedMs: Date.now() - startedAt,
    });
    return { decision: 'decline', reason: `escalation timeout after ${config.escalationTimeoutMs}ms` };
  } finally {
    if (wroteRequest) cleanupEscalationFiles(paths, audit);
  }
}

async function runDriver(config) {
  const audit = createAuditWriter(config.auditLog);
  const child = spawn(config.codexBin, ['app-server', '--listen', 'stdio://'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: config.cwd,
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

          const escalation = await waitForEscalation(config, {
            reqId,
            command: auditPayload.command || redactedCommand,
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
    nodeBin: config.nodeBin,
    approvalPolicy: config.approvalPolicy,
    runId: config.runId,
    agentId: config.agentId,
    escalationDir: config.escalationDir,
    escalationReplyDir: config.escalationReplyDir,
    escalationTimeoutMs: config.escalationTimeoutMs,
    escalationReplyChannelRequirement: 'production reply channel must be agent-unwritable; temp defaults are host/dev only',
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

main();
