#!/usr/bin/env node
/*
 * shelly-plan-executor.js - Phase 0 PlanSpec executor canary.
 *
 * This intentionally supports a narrow first slice. It runs one PlanSpec without
 * sourcing run-agent-*.sh, but delegates HTTP and filesystem effects to the
 * capability broker so the broker remains the final security boundary.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PLAN_SPEC_SCHEMA_VERSION = 1;
const PLAN_SPEC_KIND = 'shelly.agent.plan';

const EXIT = {
  OK: 0,
  PLAN_DENY: 47,
  TOOL_DENY: 48,
  INTERNAL: 127,
};

const CONFIG_ENV_KEYS = new Set([
  'LOCAL_LLM_URL',
  'LOCAL_LLM_MODEL',
  'GEMINI_MODEL',
  'PERPLEXITY_MODEL',
  'CEREBRAS_MODEL',
  'GROQ_MODEL',
  'SHELLY_AGENT_OUTPUT_TARGET',
  'SHELLY_AGENT_TOPIC_FOLDER',
  'SHELLY_AGENT_CUSTOM_PATH',
  'SHELLY_AGENT_EXEC_CWD',
  'SHELLY_CONTENT_PROJECT',
  'SOURCE_REGISTRY_FILE',
  'OBSIDIAN_VAULT_PATH',
  'SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS',
  'WEBHOOK_TIMEOUT_SECONDS',
]);

const REDACT_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{25,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{20,}\b/g,
  /\bcsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
];

class PlanFailure extends Error {
  constructor(message, options) {
    super(message);
    this.name = 'PlanFailure';
    this.status = options && options.status ? options.status : 'error';
    this.exitCode = options && typeof options.exitCode === 'number' ? options.exitCode : EXIT.PLAN_DENY;
    this.handled = options && options.handled === true;
  }
}

class ActionSkipped extends Error {
  constructor(message) {
    super(message);
    this.name = 'ActionSkipped';
  }
}

function redact(text) {
  let out = String(text == null ? '' : text);
  for (const pattern of REDACT_PATTERNS) out = out.replace(pattern, '<redacted>');
  return out;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith('--')) continue;
    const key = current.slice(2);
    const next = argv[i + 1];
    if (next == null || next.startsWith('--')) {
      args[key] = '1';
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function appendJsonl(file, entry) {
  if (!file) return;
  try {
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch (_) {
    // best-effort audit only
  }
}

function runtimePaths(home, agentId) {
  const shellyDir = path.join(home, '.shelly');
  const agentsDir = path.join(shellyDir, 'agents');
  const tmpDir = path.join(shellyDir, 'tmp');
  const locksDir = path.join(agentsDir, 'locks');
  const logsDir = path.join(agentsDir, 'logs');
  const logDir = path.join(logsDir, agentId);
  return {
    home,
    shellyDir,
    agentsDir,
    tmpDir,
    locksDir,
    logsDir,
    logDir,
    envFile: path.join(agentsDir, '.env'),
    haltSentinel: path.join(agentsDir, '.halted'),
    resultFile: path.join(tmpDir, `agent-result-${agentId}.md`),
    lockFile: path.join(locksDir, `${agentId}.pid`),
    notifyFile: path.join(logDir, 'native-result-notification.json'),
    brokerAuditFile: path.join(logDir, 'agent-driver-audit.jsonl'),
    planAuditFile: path.join(logDir, 'plan-executor-audit.jsonl'),
    actionApprovalDir: path.join(agentsDir, 'action-approvals'),
    actionApprovalReplyDir: path.join(agentsDir, 'action-approval-replies'),
  };
}

function parseConfigEnv(file) {
  const out = {};
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!CONFIG_ENV_KEYS.has(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && val[0] === "'" && val[val.length - 1] === "'") {
      val = val.slice(1, -1).replace(/'\\''/g, "'");
    } else if (val.length >= 2 && val[0] === '"' && val[val.length - 1] === '"') {
      val = val.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    out[key] = val;
  }
  return out;
}

function validatePlan(raw) {
  if (!raw || typeof raw !== 'object') throw new PlanFailure('plan is not an object');
  if (raw.kind !== PLAN_SPEC_KIND) throw new PlanFailure('plan kind mismatch');
  if (raw.schemaVersion !== PLAN_SPEC_SCHEMA_VERSION) throw new PlanFailure('plan schema version mismatch');
  if (!raw.agent || typeof raw.agent.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw.agent.id)) {
    throw new PlanFailure('plan agent id is invalid');
  }
  if (typeof raw.prompt !== 'string') throw new PlanFailure('plan prompt is invalid');
  if (!raw.tool || typeof raw.tool.type !== 'string') throw new PlanFailure('plan tool is invalid');
  if (!raw.action || typeof raw.action.type !== 'string') throw new PlanFailure('plan action is invalid');
  if (raw.tool.type === 'unsupported') throw new PlanFailure(redact(raw.tool.unsupportedReason || 'unsupported tool'), { exitCode: EXIT.TOOL_DENY });
  if (raw.action.type === 'unsupported') throw new PlanFailure(redact(raw.action.unsupportedReason || 'unsupported action'), { exitCode: EXIT.TOOL_DENY });
  return raw;
}

function loadPlan(planFile) {
  if (!planFile) throw new PlanFailure('--plan-file is required');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  } catch (e) {
    throw new PlanFailure(`cannot read plan: ${e && e.message ? e.message : e}`);
  }
  return validatePlan(parsed);
}

function sleepMs(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function previewText(text) {
  return redact(String(text || '')).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function sanitizeRelPath(value) {
  const cleaned = String(value || '')
    .replace(/[^A-Za-z0-9 _./{}-]+/g, '')
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .join('/');
  return cleaned || '{date}-{slug}';
}

function uniqueRoots(roots) {
  const out = [];
  for (const root of roots) {
    const value = String(root || '').trim();
    if (!value || value[0] !== '/') continue;
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

function scopedRoots(paths, config) {
  const obsidianRoot = config.OBSIDIAN_VAULT_PATH || '/sdcard/Documents/ObsidianVault';
  const customRoot = config.SHELLY_AGENT_CUSTOM_PATH || path.join(paths.home, 'agent-output');
  const contentProject = config.SHELLY_CONTENT_PROJECT || path.join(paths.home, 'projects/shelly-content-studio');
  return uniqueRoots([
    paths.tmpDir,
    path.join(paths.home, 'agent-output'),
    path.join(paths.home, 'projects/shelly-content-studio'),
    contentProject,
    obsidianRoot,
    customRoot,
  ]);
}

function writeRootsFile(paths, roots) {
  const rootsFile = path.join(paths.tmpDir, `plan-roots-${process.pid}-${Date.now()}.txt`);
  writeAtomic(rootsFile, roots.join('\n') + '\n');
  return rootsFile;
}

function childEnv(paths, opts) {
  const libDir = opts.libDir || process.env.SHELLY_LIB_DIR || process.env.LD_LIBRARY_PATH || '';
  const env = Object.assign({}, process.env, {
    HOME: paths.home,
    SHELLY_LIB_DIR: libDir,
  });
  if (libDir) {
    env.LD_LIBRARY_PATH = libDir;
    env.PATH = `${libDir}:${libDir}/node_modules/npm/bin:${libDir}/node_modules/.bin:${env.PATH || ''}`;
  }
  // The broker is a leaf bionic-node process: its workspace.exec curates commands
  // in-node (cat/ls/grep/printf/… implemented in JS) and never execs an app-data
  // binary, so it does NOT need the Knox exec-wrapper. Inheriting
  // LD_PRELOAD=libexec_wrapper.so (set globally by shelly-exec.c on the launching
  // shell) BREAKS node's OpenSSL config load on-device — verified on hardware:
  // "BIO_new_file:Bad file descriptor" on openssl.cnf → node aborts → every broker
  // call fails. Drop it here (mirrors the llama-server launcher, which unsets
  // LD_PRELOAD before its own linker64 launch for the same class of reason).
  delete env.LD_PRELOAD;
  return env;
}

function nodeInvocation(script, args, paths, opts) {
  const libDir = opts.libDir || process.env.SHELLY_LIB_DIR || '';
  const androidNode = libDir ? path.join(libDir, 'node') : '';
  if (androidNode && fs.existsSync(androidNode) && fs.existsSync('/system/bin/linker64')) {
    return { file: '/system/bin/linker64', args: [androidNode, script].concat(args) };
  }
  return { file: process.execPath, args: [script].concat(args) };
}

function runBroker(paths, opts, brokerArgs) {
  const broker = opts.broker || path.join(paths.home, '.shelly-capability-broker.js');
  if (!fs.existsSync(broker)) throw new PlanFailure('capability broker is missing', { exitCode: EXIT.TOOL_DENY });
  const invocation = nodeInvocation(broker, brokerArgs, paths, opts);
  const result = spawnSync(invocation.file, invocation.args, {
    env: childEnv(paths, opts),
    encoding: 'utf8',
    timeout: 700000,
  });
  if (result.error) {
    throw new PlanFailure(`capability broker spawn failed: ${redact(result.error.message)}`, { exitCode: EXIT.TOOL_DENY });
  }
  return result.status == null ? EXIT.INTERNAL : result.status;
}

function writeJsonRequest(file, payload) {
  writeAtomic(file, JSON.stringify(payload));
}

function chatEndpoint(base) {
  const url = String(base || '').trim().replace(/\/+$/, '');
  if (!url) return 'http://127.0.0.1:8080/v1/chat/completions';
  if (/\/v1\/chat\/completions$/.test(url)) return url;
  return `${url}/v1/chat/completions`;
}

function isLoopbackUrl(urlText) {
  try {
    const u = new URL(urlText);
    return (u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  } catch (_) {
    return false;
  }
}

function modelRequest(plan, config) {
  const prompt = plan.prompt;
  switch (plan.tool.type) {
    case 'local': {
      const url = chatEndpoint(config.LOCAL_LLM_URL || 'http://127.0.0.1:8080');
      if (!isLoopbackUrl(url)) throw new PlanFailure('local PlanSpec endpoint must be loopback', { exitCode: EXIT.TOOL_DENY });
      return {
        url,
        authRef: '',
        body: {
          model: config.LOCAL_LLM_MODEL || plan.tool.model || 'Qwen3.5-0.8B-Q4_K_M',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 2048,
          chat_template_kwargs: { enable_thinking: false },
        },
      };
    }
    case 'gemini-api': {
      const model = config.GEMINI_MODEL || plan.tool.model || 'gemini-2.5-flash';
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        authRef: 'gemini',
        body: { contents: [{ parts: [{ text: prompt }] }] },
      };
    }
    case 'perplexity':
      return openAiCompatRequest('https://api.perplexity.ai/chat/completions', 'perplexity', config.PERPLEXITY_MODEL || plan.tool.model || 'sonar', prompt);
    case 'cerebras':
      return openAiCompatRequest('https://api.cerebras.ai/v1/chat/completions', 'cerebras', config.CEREBRAS_MODEL || plan.tool.model || 'qwen-3-235b-a22b-instruct-2507', prompt);
    case 'groq':
      return openAiCompatRequest('https://api.groq.com/openai/v1/chat/completions', 'groq', config.GROQ_MODEL || plan.tool.model || 'llama-3.3-70b-versatile', prompt);
    default:
      throw new PlanFailure(`unsupported PlanSpec tool: ${plan.tool.type}`, { exitCode: EXIT.TOOL_DENY });
  }
}

function openAiCompatRequest(url, authRef, model, prompt) {
  return {
    url,
    authRef,
    body: {
      model,
      messages: [{ role: 'user', content: prompt }],
    },
  };
}

function brokerHttp(paths, opts, plan, request) {
  const bodyFile = path.join(paths.tmpDir, `plan-request-${plan.agent.id}-${process.pid}.json`);
  writeJsonRequest(bodyFile, request.body);
  try {
    return brokerHttpBodyFile(paths, opts, plan, {
      url: request.url,
      authRef: request.authRef,
      bodyFile,
      approved: request.approved,
      timeoutSeconds: request.timeoutSeconds,
    });
  } finally {
    try {
      fs.unlinkSync(bodyFile);
    } catch (_) {}
  }
}

function brokerHttpBodyFile(paths, opts, plan, request) {
  const outFile = path.join(paths.tmpDir, `plan-response-${plan.agent.id}-${process.pid}.json`);
  const errFile = path.join(paths.tmpDir, `plan-response-${plan.agent.id}-${process.pid}.err`);
  const args = [
    '--op', 'http.request',
    '--method', 'POST',
    '--url', request.url,
    '--body-file', request.bodyFile,
    '--secret-env-file', paths.envFile,
    '--audit-log', paths.brokerAuditFile,
    '--budget-file', path.join(paths.tmpDir, `cap-budget-${plan.agent.id}.json`),
    '--timeout-seconds', String(request.timeoutSeconds || (plan.limits && plan.limits.timeoutSeconds ? plan.limits.timeoutSeconds : 600)),
    '--out', outFile,
    '--err', errFile,
  ];
  if (request.authRef) args.push('--auth-ref', request.authRef);
  if (request.approved) args.push('--approved', '1');
  const rc = runBroker(paths, opts, args);
  const response = readFile(outFile);
  const errorText = readFile(errFile);
  if (rc !== 0) {
    const status = rc === 23 ? 'unavailable' : 'error';
    throw new PlanFailure(`HTTP broker failed rc=${rc}: ${redact(errorText || response).slice(0, 300)}`, {
      status,
      exitCode: EXIT.OK,
      handled: true,
    });
  }
  return response;
}

function extractModelContent(toolType, raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    const text = String(raw || '').trim();
    if (text) return text;
    throw new PlanFailure('model response was empty', { handled: true });
  }
  if (toolType === 'gemini-api') {
    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const parts = candidates.flatMap((candidate) => {
      const content = candidate && candidate.content;
      return content && Array.isArray(content.parts) ? content.parts : [];
    });
    const text = parts.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('\n').trim();
    if (text) return text;
  } else {
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : null;
    const content = choice && choice.message && typeof choice.message.content === 'string'
      ? choice.message.content
      : choice && typeof choice.text === 'string'
        ? choice.text
        : '';
    if (content.trim()) return content.trim();
  }
  throw new PlanFailure('model response did not contain assistant content', { handled: true });
}

function brokerFsWrite(paths, opts, roots, dest, src) {
  const rootsFile = writeRootsFile(paths, roots);
  const outFile = path.join(paths.tmpDir, `plan-fs-${process.pid}.out`);
  const errFile = path.join(paths.tmpDir, `plan-fs-${process.pid}.err`);
  const rc = runBroker(paths, opts, [
    '--op', 'fs.write',
    '--path', dest,
    '--input-file', src,
    '--roots-file', rootsFile,
    '--audit-log', paths.brokerAuditFile,
    '--out', outFile,
    '--err', errFile,
  ]);
  const err = readFile(errFile);
  try {
    fs.unlinkSync(rootsFile);
  } catch (_) {}
  if (rc !== 0) {
    throw new PlanFailure(`scoped filesystem write denied: ${redact(err).slice(0, 300)}`, {
      exitCode: EXIT.OK,
      handled: true,
    });
  }
}

function readFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return '';
  }
}

function acquireLock(paths) {
  ensureDir(path.dirname(paths.lockFile));
  if (fs.existsSync(paths.lockFile)) {
    const pid = Number(readFile(paths.lockFile).trim());
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (_) {
        // stale
      }
    }
    try {
      fs.unlinkSync(paths.lockFile);
    } catch (_) {}
  }
  writeAtomic(paths.lockFile, `${process.pid}\n`);
  return true;
}

function releaseLock(paths) {
  try {
    if (readFile(paths.lockFile).trim() === String(process.pid)) fs.unlinkSync(paths.lockFile);
  } catch (_) {}
}

function writeNotification(paths, plan, status, preview) {
  writeAtomic(paths.notifyFile, JSON.stringify({
    agentId: plan.agent.id,
    agentName: plan.agent.name,
    toolLabel: plan.tool.label,
    status,
    preview,
    timestamp: Math.floor(Date.now() / 1000),
  }) + '\n');
}

function writeRunLog(paths, plan, status, preview, durationMs, errorMessage) {
  const ts = Date.now();
  const log = {
    agentId: plan.agent.id,
    timestamp: ts,
    status,
    outputPreview: previewText(preview),
    durationMs,
    toolUsed: plan.tool.label,
    errorMessage: errorMessage ? previewText(errorMessage) : '',
    routeDecision: plan.routeDecision,
    executor: 'planspec',
  };
  writeAtomic(path.join(paths.logDir, `${Math.floor(ts / 1000)}.json`), JSON.stringify(log) + '\n');
}

function requestActionApproval(paths, plan, actionType, preview, resultFile, config, details) {
  ensureDir(paths.actionApprovalDir);
  ensureDir(paths.actionApprovalReplyDir);
  const runId = `${plan.agent.id}-${Math.floor(Date.now() / 1000)}-${process.pid}`;
  const requestFile = path.join(paths.actionApprovalDir, `action-${safeFilePart(runId)}.json`);
  const replyFile = path.join(paths.actionApprovalReplyDir, `action-${safeFilePart(runId)}.reply.json`);
  const timeoutSeconds = Number(config.SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS || process.env.SHELLY_AGENT_ACTION_APPROVAL_TIMEOUT_SECONDS || 120);
  const extra = details || {};
  const request = {
    runId,
    agentId: plan.agent.id,
    agentName: plan.agent.name,
    toolLabel: plan.tool.label,
    actionType,
    preview,
    destinationHost: extra.destinationHost || '',
    command: extra.command || '',
    safetyLevel: extra.safetyLevel || '',
    safetyReason: extra.safetyReason || '',
    payloadPath: extra.payloadPath || '',
    resultPath: resultFile,
    ts: new Date().toISOString(),
    expiresAt: Date.now() + Math.max(1, timeoutSeconds) * 1000,
  };
  writeAtomic(requestFile, JSON.stringify(request) + '\n');
  const requestSha256 = sha256File(requestFile);
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;
  while (Date.now() < deadline) {
    if (fs.existsSync(replyFile)) {
      let reply = null;
      try {
        reply = JSON.parse(readFile(replyFile));
      } catch (_) {
        reply = null;
      }
      try {
        fs.unlinkSync(replyFile);
        fs.unlinkSync(requestFile);
      } catch (_) {}
      if (!reply || reply.runId !== runId || reply.requestSha256 !== requestSha256) {
        continue;
      }
      if (reply.decision === 'accept') return;
      throw new ActionSkipped(`${actionType} action declined`);
    }
    sleepMs(500);
  }
  try {
    fs.unlinkSync(requestFile);
  } catch (_) {}
  throw new ActionSkipped(`${actionType} action approval timed out`);
}

function safeFilePart(value) {
  return String(value || '').slice(0, 160).replace(/[^A-Za-z0-9_.=-]/g, '_') || 'request';
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Mirrors the .sh save_draft_result destination logic (lib/agent-executor.ts).
// Returns { dest, rel, useGlobalOutput }: `rel` is the content-studio relative
// filename reused by the Obsidian mirror; it is empty for the global-output path.
function resolveDraftDestination(paths, plan, config) {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19).replace(/:/g, '');
  if (plan.output && plan.output.useGlobalOutput) {
    let base = path.join(paths.home, 'agent-output');
    const target = config.SHELLY_AGENT_OUTPUT_TARGET || 'local';
    if (target === 'obsidian') base = config.OBSIDIAN_VAULT_PATH || '/sdcard/Documents/ObsidianVault';
    if (target === 'custom') base = config.SHELLY_AGENT_CUSTOM_PATH || path.join(paths.home, 'agent-output');
    // The .sh appends SHELLY_AGENT_TOPIC_FOLDER only for obsidian/custom, never local.
    const topic = target === 'obsidian' || target === 'custom' ? sanitizeRelPath(config.SHELLY_AGENT_TOPIC_FOLDER || '') : '';
    const topicPart = topic && topic !== '{date}-{slug}' ? topic : '';
    return { dest: path.join(base, topicPart, date, `${date}_${plan.output.slug}.md`), rel: '', useGlobalOutput: true };
  }
  const template = sanitizeRelPath(plan.output && plan.output.outputNameTemplate);
  let rel = template
    .replace(/\{date\}/g, date)
    .replace(/\{slug\}/g, plan.output && plan.output.slug ? plan.output.slug : plan.agent.id)
    .replace(/\{time\}/g, time);
  if (!/\.(md|markdown|txt)$/i.test(rel)) rel += '.md';
  return { dest: path.join(plan.output.outputDir, rel), rel, useGlobalOutput: false };
}

// Keyword-routed Obsidian subfolder for content-studio agents. Mirrors the
// `case "$OUTPUT_DIR"` map in the .sh save_draft_result (order-sensitive: first
// match wins, matching bash `case`).
function obsidianTargetFor(outputDir) {
  const dir = String(outputDir || '');
  if (dir.includes('drafts/substack')) return '50_Drafts/Substack';
  if (dir.includes('drafts/x')) return '50_Drafts/X';
  if (dir.includes('drafts/articles')) return '50_Drafts/Substack';
  if (dir.includes('sources')) return '20_Literature/Papers';
  if (dir.includes('images/prompts')) return '60_Experiments/Image_Prompts';
  if (dir.includes('evals')) return '90_Log/Agent_Evals';
  return '90_Log/Agent_Output';
}

// The content-studio Obsidian mirror destination, or null when no vault is
// configured/present (the .sh guards on `[ -n "$OBSIDIAN_VAULT_PATH" ] && [ -d ]`
// and silently skips otherwise). The write itself is broker-routed and root-jailed.
function resolveObsidianMirror(plan, config, rel) {
  const vault = String(config.OBSIDIAN_VAULT_PATH || '').trim();
  if (!vault || !rel) return null;
  try {
    if (!fs.statSync(vault).isDirectory()) return null;
  } catch (_) {
    return null;
  }
  return path.join(vault, obsidianTargetFor(plan.output && plan.output.outputDir), rel);
}

// Write the draft to its primary destination and (for content-studio) the Obsidian
// mirror, both through the root-jailed broker fs.write. `bestEffort` mirrors the .sh:
// the terminal `draft` action runs save_draft_result under `set -e` (fatal), while an
// orchestration `__suppressed__` step runs it `2>/dev/null || true` (swallow errors).
function writeDraftOutputs(paths, opts, plan, config, roots, bestEffort) {
  const { dest, rel, useGlobalOutput } = resolveDraftDestination(paths, plan, config);
  const targets = [dest];
  if (!useGlobalOutput) {
    const mirror = resolveObsidianMirror(plan, config, rel);
    if (mirror) targets.push(mirror);
  }
  // In bestEffort mode the whole sequence is swallowed on the FIRST failure, matching
  // the .sh `save_draft_result ... || true` under `set -e` (a failed primary write
  // aborts before the mirror). The terminal draft path lets the failure propagate.
  try {
    for (const target of targets) brokerFsWrite(paths, opts, roots, target, paths.resultFile);
    // save_draft_result appends source URLs to the shared dedup registry AFTER the
    // write, inside set -e — a failed write aborts before it. Keep it inside the try
    // so a swallowed bestEffort write failure also skips the registry (parity).
    registerSourceUrls(paths, config, plan);
  } catch (e) {
    if (!bestEffort) throw e;
  }
}

// Mirror of the .sh register_source_urls: append https URLs found in the draft to a
// shared per-project registry TSV (timestamp, agentId, toolLabel, url), deduped on
// the url column, under a mkdir mutex. Fixed path (no model-controlled path), best
// effort — a registry hiccup must never fail the run. No-op when the sources/ dir is
// absent (parity with the .sh, whose `>>` silently fails without it).
function registerSourceUrls(paths, config, plan) {
  try {
    const contentProject = config.SHELLY_CONTENT_PROJECT || path.join(paths.home, 'projects/shelly-content-studio');
    const registryFile = config.SOURCE_REGISTRY_FILE || path.join(contentProject, 'sources', 'source-registry.tsv');

    let text = '';
    try {
      text = fs.readFileSync(paths.resultFile, 'utf8');
    } catch (_) {
      return;
    }
    const seen = new Set();
    // The .sh uses line-oriented `grep -Eo`, so a match never spans a newline; exclude
    // \t\r\n from the class so adjacent-line URLs don't merge into one bogus entry.
    const matches = text.match(/https?:\/\/[^\][ )<>"'\t\r\n]+/g) || [];
    for (const raw of matches) {
      // Match the .sh: `sed 's/[.,;)]$//'` strips exactly one trailing char.
      const url = raw.replace(/[.,;)]$/, '');
      if (url) seen.add(url);
    }
    // `sort -u` in the .sh: unique + sorted before appending.
    const urls = Array.from(seen).sort();
    if (!urls.length) return;

    // The .sh creates the registry dir/file unconditionally at startup (mkdir -p +
    // touch, lib/agent-executor.ts), so register_source_urls always has a target.
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    const lockDir = `${registryFile}.lock`;
    let locked = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        fs.mkdirSync(lockDir);
        locked = true;
        break;
      } catch (_) {
        sleepMs(1000);
      }
    }
    try {
      let existing = '';
      try {
        existing = fs.readFileSync(registryFile, 'utf8');
      } catch (_) {
        /* first write */
      }
      const known = new Set(existing.split('\n').map((line) => line.split('\t')[3]).filter(Boolean));
      const toolLabel = (plan.tool && plan.tool.label) || '';
      const ts = new Date().toISOString();
      let append = '';
      for (const url of urls) {
        if (!known.has(url)) {
          append += `${ts}\t${plan.agent.id}\t${toolLabel}\t${url}\n`;
          known.add(url);
        }
      }
      if (append) fs.appendFileSync(registryFile, append);
    } finally {
      if (locked) {
        try {
          fs.rmdirSync(lockDir);
        } catch (_) {}
      }
    }
  } catch (_) {
    /* best-effort registry bookkeeping — never fail the run */
  }
}

function webhookDestinationHost(urlText) {
  try {
    const u = new URL(String(urlText || ''));
    if (u.protocol !== 'https:') return '';
    return u.host;
  } catch (_) {
    return '';
  }
}

function writeWebhookPayload(file, plan, status, preview, resultText) {
  writeAtomic(file, JSON.stringify({
    agentId: plan.agent.id,
    status,
    preview,
    toolUsed: plan.tool.label,
    timestamp: Math.floor(Date.now() / 1000),
    result: resultText,
  }) + '\n');
}

const CRITICAL_COMMAND_PATTERNS = [
  {
    pattern: /rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~\/?\s*$|\/\*|~\/\*)/i,
    reason: 'Root or home directory recursive removal is critical.',
  },
  {
    pattern: /rm\s+-rf\s+\/(?:usr|bin|lib|etc|boot|sys|proc|dev|sbin)/i,
    reason: 'System directory removal is critical.',
  },
  {
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/,
    reason: 'Fork bomb command is critical.',
  },
  {
    pattern: /dd\s+if=\/dev\/(?:zero|random|urandom)\s+of=\/dev\/(?:sd[a-z]|nvme|mmcblk)/i,
    reason: 'Direct storage overwrite is critical.',
  },
  {
    pattern: /mkfs\s+.*\/dev\/(?:sd[a-z]|nvme|mmcblk)/i,
    reason: 'Storage device format is critical.',
  },
  {
    pattern: />\s*\/dev\/(?:sd[a-z]|nvme|mmcblk)/i,
    reason: 'Direct storage device write is critical.',
  },
  {
    pattern: /shred\s+.*\/dev\//i,
    reason: 'Device shred command is critical.',
  },
];

function recomputeCliSafety(commandText, declaredSafety) {
  const cleaned = String(commandText || '').replace(/#[^\n]*/g, '').trim();
  for (const { pattern, reason } of CRITICAL_COMMAND_PATTERNS) {
    if (pattern.test(cleaned)) {
      return {
        level: 'CRITICAL',
        reason,
        message: 'Executor-side command safety blocked a critical command.',
        matchedPattern: pattern.source,
      };
    }
  }
  const safety = declaredSafety && typeof declaredSafety === 'object' ? declaredSafety : {};
  return {
    level: safety.level || 'SAFE',
    reason: safety.reason || 'No critical command pattern matched.',
    message: safety.message || '',
    matchedPattern: safety.matchedPattern || '',
  };
}

function resolveCliCwd(paths, plan, config) {
  const wanted =
    config.SHELLY_AGENT_EXEC_CWD ||
    config.SHELLY_CONTENT_PROJECT ||
    path.join(paths.home, 'projects/shelly-content-studio');
  try {
    if (wanted && path.isAbsolute(wanted) && fs.existsSync(wanted) && fs.statSync(wanted).isDirectory()) return wanted;
  } catch (_) {
    // fall through to the known local output directory
  }
  const fallback = path.join(paths.home, 'agent-output');
  ensureDir(fallback);
  return fallback;
}

function brokerWorkspaceExec(paths, opts, roots, plan, commandText, cwd) {
  const commandFile = path.join(paths.tmpDir, `plan-exec-command-${plan.agent.id}-${process.pid}.txt`);
  const rootsFile = writeRootsFile(paths, roots);
  const outFile = path.join(paths.logDir, `cli-action-output-${Date.now()}.txt`);
  const errFile = path.join(paths.logDir, `cli-action-error-${Date.now()}.txt`);
  writeAtomic(commandFile, commandText);
  const rc = runBroker(paths, opts, [
    '--op', 'workspace.exec',
    '--command-file', commandFile,
    '--cwd', cwd,
    '--roots-file', rootsFile,
    '--audit-log', paths.brokerAuditFile,
    '--timeout-seconds', String(plan.limits && plan.limits.timeoutSeconds ? plan.limits.timeoutSeconds : 600),
    '--out', outFile,
    '--err', errFile,
  ]);
  try {
    fs.unlinkSync(commandFile);
  } catch (_) {}
  try {
    fs.unlinkSync(rootsFile);
  } catch (_) {}
  return { rc, outFile, errFile, out: readFile(outFile), err: readFile(errFile) };
}

function appendCliActionReport(resultFile, commandText, cwd, safety, execResult) {
  const errorText = execResult.err ? `\n[stderr]\n${execResult.err}` : '';
  const combined = `${execResult.out || ''}${errorText}`;
  const safetyLevel = safety && safety.level ? safety.level : '';
  const safetyReason = safety && safety.reason ? safety.reason : '';
  fs.appendFileSync(resultFile, [
    '',
    '## CLI action',
    '',
    `Safety: ${safetyLevel} - ${safetyReason}`,
    '',
    `Cwd: ${cwd}`,
    '',
    'Command:',
    '',
    '```sh',
    commandText,
    '```',
    '',
    `Exit code: ${execResult.rc}`,
    '',
    'Output:',
    '',
    '```text',
    redact(combined).slice(0, 4000),
    '```',
    '',
  ].join('\n'));
}

function argTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function trustedNativeLowRiskAction(args, plan, actionType) {
  const trustedAgentId = String(args['trusted-autonomous-agent-id'] || '').trim();
  const trustedAction = String(args['trusted-autonomous-action'] || '').trim();
  const trustedTool = String(args['trusted-tool-type'] || '').trim();
  if (trustedAgentId !== plan.agent.id) return false;
  if (trustedAction !== 'draft' && trustedAction !== 'notify') return false;
  if (trustedAction !== actionType) return false;
  // Native only emits this for deterministic local autonomous agents. This keeps
  // a tampered plan from turning a low-risk file/notify action into key spend.
  return trustedTool === 'local' && plan.tool.type === 'local';
}

function unattendedPreflightFailure(args, plan) {
  if (!argTruthy(args.unattended)) return '';
  const actionType = plan.action.type;
  if (actionType === '__suppressed__') return '';
  if (actionType !== 'draft' && actionType !== 'notify') {
    return `unsupported unattended PlanSpec action: ${actionType}`;
  }
  if (!trustedNativeLowRiskAction(args, plan, actionType)) {
    return `${actionType} action is not trusted for unattended PlanSpec execution`;
  }
  return '';
}

function dispatchActionTrusted(paths, opts, plan, config, roots, resultText, args) {
  const actionType = plan.action.type;
  const preview = previewText(resultText);
  if (actionType === '__suppressed__') {
    // Orchestration non-final step: still save the draft (so the next step can read
    // it) but request no approval and fire no notification. Best-effort, like the .sh.
    writeDraftOutputs(paths, opts, plan, config, roots, true);
    return { status: 'success', preview };
  }
  if (actionType !== 'draft' && actionType !== 'notify' && actionType !== 'webhook' && actionType !== 'cli') {
    throw new PlanFailure(`unsupported PlanSpec action: ${actionType}`, { exitCode: EXIT.TOOL_DENY });
  }
  if (trustedNativeLowRiskAction(args, plan, actionType)) {
    appendJsonl(paths.planAuditFile, {
      ts: new Date().toISOString(),
      kind: 'plan.executor',
      event: 'action_trusted_allow',
      agentId: plan.agent.id,
      actionType,
      toolType: plan.tool.type,
    });
  } else {
    if (actionType === 'webhook') {
      const webhookUrl = String(plan.action.webhookUrl || '').trim();
      const host = webhookDestinationHost(webhookUrl);
      if (!webhookUrl) {
        const message = 'Webhook action is missing an https URL.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (!host) {
        const message = 'Webhook action requires a valid https URL.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const payloadFile = path.join(paths.logDir, `webhook-payload-${Date.now()}.json`);
      writeWebhookPayload(payloadFile, plan, 'success', preview, resultText);
      requestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        destinationHost: host,
        payloadPath: path.basename(payloadFile),
      });
      try {
        brokerHttpBodyFile(paths, opts, plan, {
          url: webhookUrl,
          bodyFile: payloadFile,
          approved: true,
          timeoutSeconds: Number(config.WEBHOOK_TIMEOUT_SECONDS || 30),
        });
      } catch (e) {
        const message = e instanceof PlanFailure ? redact(e.message) : redact(String(e));
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      return { status: 'success', preview };
    }
    if (actionType === 'cli') {
      const commandText = String(plan.action.command || '').trim();
      const safety = recomputeCliSafety(commandText, plan.action.safety || {});
      if (!commandText) {
        const message = 'CLI action is missing a command.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (safety.level === 'CRITICAL') {
        const message = `CLI action was blocked by command safety: ${safety.reason || 'critical command'}`;
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      requestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        command: commandText,
        safetyLevel: safety.level || '',
        safetyReason: safety.reason || '',
      });
      const cwd = resolveCliCwd(paths, plan, config);
      const execResult = brokerWorkspaceExec(paths, opts, roots, plan, commandText, cwd);
      appendCliActionReport(paths.resultFile, commandText, cwd, safety, execResult);
      if (execResult.rc !== 0) {
        const message = `CLI action failed with exit ${execResult.rc}.`;
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      return { status: 'success', preview };
    }
    requestActionApproval(paths, plan, actionType, preview, paths.resultFile, config);
  }
  if (actionType === 'draft') {
    // Terminal draft: primary + (content-studio) Obsidian mirror, fatal on failure
    // (parity with the .sh save_draft_result under `set -euo pipefail`).
    writeDraftOutputs(paths, opts, plan, config, roots, false);
  }
  if (actionType === 'draft' || actionType === 'notify') {
    writeNotification(paths, plan, 'success', preview);
  }
  return { status: 'success', preview };
}

function mirrorBrokerAudit(paths, plan) {
  if (!fs.existsSync(paths.brokerAuditFile)) return;
  try {
    const auditDir = path.join(paths.agentsDir, 'audits');
    ensureDir(auditDir);
    fs.copyFileSync(paths.brokerAuditFile, path.join(auditDir, `${plan.agent.id}-agent-driver-audit.jsonl`));
  } catch (_) {
    // best-effort parity with the shell path
  }
}

// Shared epilogue for the pre-run refuse paths (kill-switch, unattended-not-trusted):
// notify + run log + a `plan_finish status:skipped` audit line, then exit cleanly.
function finishSkipped(paths, plan, startedAt, message) {
  const durationMs = Date.now() - startedAt;
  writeNotification(paths, plan, 'skipped', message);
  writeRunLog(paths, plan, 'skipped', message, durationMs, message);
  appendJsonl(paths.planAuditFile, {
    ts: new Date().toISOString(),
    kind: 'plan.executor',
    event: 'plan_finish',
    status: 'skipped',
    reason: message,
    durationMs,
  });
  return EXIT.OK;
}

function run(args) {
  const plan = loadPlan(args['plan-file']);
  const expectedAgentId = String(args['agent-id'] || '').trim();
  if (expectedAgentId && expectedAgentId !== plan.agent.id) {
    throw new PlanFailure(`plan agent id mismatch: expected ${expectedAgentId}`, { exitCode: EXIT.PLAN_DENY });
  }
  const home = args.home || process.env.HOME;
  if (!home || !path.isAbsolute(home)) {
    throw new PlanFailure('--home or absolute HOME is required', { exitCode: EXIT.PLAN_DENY });
  }
  const paths = runtimePaths(home, plan.agent.id);
  const opts = {
    libDir: args['lib-dir'] || process.env.SHELLY_LIB_DIR || '',
    broker: args.broker || '',
  };
  ensureDir(paths.tmpDir);
  ensureDir(paths.locksDir);
  ensureDir(paths.logDir);

  const config = parseConfigEnv(paths.envFile);
  const roots = scopedRoots(paths, config);
  const startedAt = Date.now();
  appendJsonl(paths.planAuditFile, {
    ts: new Date().toISOString(),
    kind: 'plan.executor',
    event: 'plan_start',
    agentId: plan.agent.id,
    schemaVersion: plan.schemaVersion,
    toolType: plan.tool.type,
    actionType: plan.action.type,
    unattended: argTruthy(args.unattended),
  });

  // Global kill-switch (STOP ALL). haltAllAgents drops a `.halted` sentinel and
  // uninstalls schedules; this is the native/executor-side defense in depth so a
  // still-in-flight alarm or a direct `am` fire is refused before any model IO,
  // not just JS-initiated runs. Fail-closed: refuse (skip), never run.
  if (fs.existsSync(paths.haltSentinel)) {
    return finishSkipped(paths, plan, startedAt, 'All agents are stopped (global kill-switch is on).');
  }

  const unattendedFailure = unattendedPreflightFailure(args, plan);
  if (unattendedFailure) {
    return finishSkipped(paths, plan, startedAt, redact(unattendedFailure));
  }

  if (!acquireLock(paths)) {
    const message = 'previous run still active';
    writeRunLog(paths, plan, 'skipped', message, 0, message);
    appendJsonl(paths.planAuditFile, {
      ts: new Date().toISOString(),
      kind: 'plan.executor',
      event: 'plan_finish',
      status: 'skipped',
      reason: message,
    });
    return EXIT.OK;
  }

  try {
    const request = modelRequest(plan, config);
    const response = brokerHttp(paths, opts, plan, request);
    const resultText = extractModelContent(plan.tool.type, response);
    writeAtomic(paths.resultFile, resultText + (resultText.endsWith('\n') ? '' : '\n'));
    const action = dispatchActionTrusted(paths, opts, plan, config, roots, resultText, args);
    const durationMs = Date.now() - startedAt;
    writeRunLog(paths, plan, action.status, action.preview, durationMs, action.errorMessage || '');
    appendJsonl(paths.planAuditFile, {
      ts: new Date().toISOString(),
      kind: 'plan.executor',
      event: 'plan_finish',
      status: action.status,
      durationMs,
    });
    return EXIT.OK;
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    if (e instanceof ActionSkipped) {
      const message = redact(e.message);
      writeNotification(paths, plan, 'skipped', message);
      writeRunLog(paths, plan, 'skipped', message, durationMs, message);
      appendJsonl(paths.planAuditFile, {
        ts: new Date().toISOString(),
        kind: 'plan.executor',
        event: 'plan_finish',
        status: 'skipped',
        reason: message,
        durationMs,
      });
      return EXIT.OK;
    }
    const status = e instanceof PlanFailure && e.status ? e.status : 'error';
    const message = redact(e && e.message ? e.message : String(e));
    writeAtomic(paths.resultFile, message + '\n');
    writeNotification(paths, plan, status, message);
    writeRunLog(paths, plan, status, message, durationMs, message);
    appendJsonl(paths.planAuditFile, {
      ts: new Date().toISOString(),
      kind: 'plan.executor',
      event: 'plan_finish',
      status,
      reason: message,
      durationMs,
    });
    if (e instanceof PlanFailure && e.handled) return EXIT.OK;
    return e instanceof PlanFailure ? e.exitCode : EXIT.INTERNAL;
  } finally {
    mirrorBrokerAudit(paths, plan);
    releaseLock(paths);
  }
}

function main() {
  try {
    process.exit(run(parseArgs(process.argv.slice(2))));
  } catch (e) {
    process.stderr.write(redact(e && e.stack ? e.stack : e && e.message ? e.message : String(e)) + '\n');
    process.exit(e instanceof PlanFailure ? e.exitCode : EXIT.INTERNAL);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  PLAN_SPEC_SCHEMA_VERSION,
  PLAN_SPEC_KIND,
  validatePlan,
  runtimePaths,
  parseConfigEnv,
  isLoopbackUrl,
};
