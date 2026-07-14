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

// 署名付き承認 (SIGNED-APPROVAL) — Migration step 2 (lib/signed-approval/wiring.ts).
// Master dormancy switch for the EXECUTOR half. Mirrors, byte-for-byte in intent,
// lib/signed-approval/wiring.ts's SIGNED_APPROVAL_ENABLED (a separate TS constant
// because this file is plain CommonJS and cannot import .ts at runtime). The two
// constants MUST be flipped together at the flag-ON cutover described there
// (step 2: "the PlanSpec executor's requestActionApproval accept-path calls
// verifyApprovalReply instead of the current runId + requestSha256 equality
// check"). While false, requestActionApproval's accept-path runs the exact
// naive-equality check that shipped before this file existed — byte-identical
// live behavior is the load-bearing invariant here, not the new verifier code
// (which is fully implemented below but never invoked).
const SIGNED_APPROVAL_ENABLED = false;

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
  'SHELLY_WEBHOOK_HOST_ALLOWLIST',
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

// app-act (Phase 4): resolves the literal "{{result}}" placeholder in every
// value of `params` against `preview` (already redact()-ed by previewText),
// then redact()s the resolved values a SECOND time as defense-in-depth --
// mirrors lib/agent-executor.ts's resolve_app_act_params exactly. This is the
// first agent action type that can publish content externally (a public X
// post), so it gets an extra redaction pass beyond relying solely on preview
// already being clean.
function resolveAppActParams(params, preview) {
  const out = {};
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    for (const [k, v] of Object.entries(params)) {
      out[k] = typeof v === 'string' ? redact(v.split('{{result}}').join(preview)) : '';
    }
  }
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
    dmPairingsFile: path.join(agentsDir, 'dm-pairings.json'),
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
  if (
    raw.limits &&
    raw.limits.charLimit !== undefined &&
    (typeof raw.limits.charLimit !== 'number' || !Number.isFinite(raw.limits.charLimit))
  ) {
    throw new PlanFailure('plan char limit is invalid');
  }
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

function resolveCharLimit(plan) {
  const raw = plan && plan.limits ? plan.limits.charLimit : undefined;
  if (raw === undefined || raw === null) return 0;
  const limit = Number(raw);
  if (!Number.isFinite(limit)) return 0;
  return Math.min(Math.max(Math.floor(limit), 40), 4000);
}

function enforcePlanCharLimit(plan, text) {
  const limit = resolveCharLimit(plan);
  if (!limit) return String(text || '');
  const chars = Array.from(String(text || ''));
  if (chars.length <= limit) return chars.join('');
  const ellipsis = '…';
  const budget = Math.max(limit - 1, 1);
  const head = chars.slice(0, budget);
  const terminators = new Set(['。', '．', '.', '!', '?', '！', '？', '\n']);
  let cut = -1;
  for (let i = head.length - 1; i >= 0; i -= 1) {
    if (terminators.has(head[i])) {
      cut = i;
      break;
    }
  }
  if (cut >= Math.floor(budget * 0.6)) {
    return head.slice(0, cut + 1).join('').trimEnd();
  }
  return head.join('').trimEnd() + ellipsis;
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
  if (opts.tainted) args.push('--tainted', '1');
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

// ─── 署名付き承認 (SIGNED-APPROVAL) — Migration step 2 executor-side verifier ───
//
// Dormant while SIGNED_APPROVAL_ENABLED is false (see the constant's comment up
// top). Everything in this section is a faithful plain-JS port of
// lib/signed-approval/{canonical,verify,nonce-store}.ts — the source of truth —
// plus a DER-key loader mirroring shelly-agent-driver.js's
// ensureEscalationVerifierKey (~line 907 there). Ported, not reinvented, so the
// host-tested TS policy and this executor implementation cannot silently drift:
// same field order, same version tags, same check order, same fail-closed shape.

// Mirrors lib/signed-approval/canonical.ts encodeFields: JSON.stringify of a
// fixed-order array. Deterministic and injective (JSON escapes embedded
// newlines/quotes so no field can shift content across a boundary to forge a
// colliding hash) — see that file's header comment for the full rationale.
function signedApprovalEncodeFields(fields) {
  return JSON.stringify(fields);
}

// Verbatim port of lib/signed-approval/canonical.ts canonicalRequest. Same
// version tag, same field order (fixed order, not JSON key order) as the source.
function canonicalApprovalRequest(request) {
  return signedApprovalEncodeFields([
    'shelly-agent-action-approval-request-v2',
    String(request.runId),
    String(request.agentId),
    String(request.agentName),
    String(request.toolLabel),
    String(request.actionType),
    String(request.preview),
    String(request.destinationHost || ''),
    String(request.command || ''),
    String(request.safetyLevel || ''),
    String(request.safetyReason || ''),
    String(request.payloadPath || ''),
    String(request.intentMode || ''),
    String(request.intentTarget || ''),
    String(request.intentShareText || ''),
    String(request.dmPairingId || ''),
    String(request.dmPairingLabel || ''),
    String(request.dmReplyText || ''),
    String(request.resultPath || ''),
    String(request.ts),
    String(request.expiresAt),
    String(request.nonce),
  ]);
}

// Verbatim port of lib/signed-approval/canonical.ts approvalReplySignatureMessage.
// Same version tag, same field order as the source.
function approvalReplySignatureMessage(fields) {
  return signedApprovalEncodeFields([
    'shelly-agent-action-approval-v2',
    String(fields.runId),
    String(fields.actionType),
    String(fields.decision),
    String(fields.ts || ''),
    String(fields.requestSha256),
    String(fields.nonce),
  ]);
}

// Per-call, in-memory single-use nonce tracker (mirrors
// lib/signed-approval/nonce-store.ts InMemoryNonceStore's semantics exactly:
// true the first time a nonce is seen, false on replay). A durable
// cross-process ledger (like AgentEscalationBridge.registerActionNonce on the
// native/driver side) is NOT needed here: one requestActionApproval call is one
// approval request/reply cycle within a SINGLE executor process invocation (the
// executor requests approval once per action, polls for the one reply file, and
// the process exits shortly after) — there is no second call in this process to
// replay a nonce against, so a Set scoped to the call is sufficient. A future
// reader should not read the lack of durability here as an oversight; it's a
// different lifetime than Tier A's long-lived driver process.
function makeSignedApprovalNonceStore() {
  const used = new Set();
  return {
    consume(nonce) {
      if (!nonce || used.has(nonce)) return false;
      used.add(nonce);
      return true;
    },
  };
}

// DER-key loader for the signed-approval verifier key. Mirrors
// shelly-agent-driver.js's ensureEscalationVerifierKey fail-closed shape
// EXACTLY, but is a SEPARATE cache/key from config.escalationVerifierPublicKey
// (that field is the UNRELATED Tier A codex-escalation mechanism's key; this one
// is Tier B action-approval's own key, config.signedApprovalVerifierPublicKey).
// Loads at most once per config object and caches the parsed key so a later
// same-uid overwrite of the DER file cannot swap the trust anchor mid-run.
// Fails closed (leaves the cached key null, so every verify call fails closed)
// if: the file can't be read, OR a configured pin doesn't match the actual
// hash, OR no pin is configured and unpinned keys aren't explicitly allowed.
function ensureSignedApprovalVerifierKey(config, audit) {
  if (config.signedApprovalVerifierLoaded) return;
  config.signedApprovalVerifierLoaded = true;
  let der;
  try {
    der = fs.readFileSync(config.signedApprovalPublicKeyPath);
  } catch (error) {
    config.signedApprovalVerifierPublicKey = null;
    audit('signed_approval_verifier_key_unavailable', {
      path: config.signedApprovalPublicKeyPath,
      error: error.message,
    });
    return;
  }
  const actualSha256 = sha256Hex(der);
  if (config.signedApprovalPublicKeySha256) {
    if (actualSha256 !== config.signedApprovalPublicKeySha256) {
      config.signedApprovalVerifierPublicKey = null;
      audit('signed_approval_verifier_key_untrusted', {
        path: config.signedApprovalPublicKeyPath,
        expectedSha256: config.signedApprovalPublicKeySha256,
        actualSha256,
      });
      return;
    }
  } else if (config.allowUnpinnedSignedApprovalVerifierKey) {
    audit('signed_approval_verifier_key_unpinned', {
      path: config.signedApprovalPublicKeyPath,
      actualSha256,
      note: 'host/dev only: a same-uid agent could swap this key',
    });
  } else {
    // Production default: no pin AND not explicitly allowed → refuse the key so
    // a launcher that forgot to inject the pin fails closed instead of silently
    // trusting a swappable key. (SIGNED_APPROVAL_ENABLED is false today, so this
    // branch cannot yet be reached from a live run — native doesn't pass
    // --signed-approval-public-key-sha256 until Migration step 1 lands.)
    config.signedApprovalVerifierPublicKey = null;
    audit('signed_approval_verifier_key_unpinned_refused', {
      path: config.signedApprovalPublicKeyPath,
      actualSha256,
      note: 'no --signed-approval-public-key-sha256 pin and unpinned keys not allowed; key refused, replies fail closed',
    });
    return;
  }
  try {
    config.signedApprovalVerifierPublicKey = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch (error) {
    config.signedApprovalVerifierPublicKey = null;
    audit('signed_approval_verifier_key_parse_error', {
      path: config.signedApprovalPublicKeyPath,
      error: error.message,
    });
  }
}

// Allowlist pinned BEFORE the signature is verified (algorithm-confusion
// defense — mirrors lib/signed-approval/verify.ts's allowedSigAlgs check, which
// itself mirrors Tier A hardcoding RSA-SHA256). NOTE: this is the reply's OWN
// sigAlg string, i.e. the Android Keystore/Java-side algorithm name
// ('SHA256withRSA'), NOT node:crypto's createVerify algorithm name
// ('RSA-SHA256') used below — the two strings name the same scheme from two
// different APIs and must not be swapped.
const SIGNED_APPROVAL_ALLOWED_SIG_ALGS = ['SHA256withRSA'];

// Verbatim port of lib/signed-approval/verify.ts verifyApprovalReply's exact
// check order: decision validity -> author -> sigAlg allowlist (BEFORE the
// signature is verified) -> runId -> actionType -> request hash recomputed from
// canonicalApprovalRequest AND compared against BOTH request.requestSha256 and
// reply.requestSha256 -> expiry -> nonce match -> key pin (fail closed on an
// empty pin) -> signature verify (node:crypto RSA-SHA256, mirroring
// shelly-agent-driver.js verifyEscalationReplySignature's shape) -> nonce
// CONSUMED LAST, only after the signature verifies, so a forged reply can never
// burn a valid nonce.
function verifySignedApprovalReply(request, reply, deps) {
  const fail = (reason) => ({ ok: false, reason });
  const VALID_DECISIONS = new Set(['accept', 'decline']);

  if (!reply || !VALID_DECISIONS.has(reply.decision)) return fail('bad-decision');
  if (reply.by !== (deps.expectedBy || 'human')) return fail('bad-author');
  if (!deps.allowedSigAlgs.includes(reply.sigAlg)) return fail('bad-sig-alg');
  if (reply.runId !== request.runId) return fail('runid-mismatch');
  if (reply.actionType !== request.actionType) return fail('action-mismatch');

  const expectedRequestSha = sha256Hex(canonicalApprovalRequest(request));
  if (request.requestSha256 !== expectedRequestSha) return fail('request-sha-mismatch');
  if (reply.requestSha256 !== expectedRequestSha) return fail('request-sha-mismatch');

  if (Date.now() > request.expiresAt) return fail('expired');
  if (reply.nonce !== request.nonce) return fail('nonce-mismatch');

  // Fail closed if the pin itself is empty/unset (a vacuous pin is no pin). The
  // trusted verifier key is the load-bearing side; reply.keySha256 is
  // attacker-controlled and ANDed in, so it can only ever reject, never bypass.
  const publicKey = deps.publicKey;
  if (!deps.expectedKeySha256 || !publicKey || deps.publicKeySha256 !== deps.expectedKeySha256 || reply.keySha256 !== deps.expectedKeySha256) {
    return fail('key-pin-mismatch');
  }

  try {
    const message = approvalReplySignatureMessage(reply);
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(message, 'utf8');
    verifier.end();
    if (!verifier.verify(publicKey, Buffer.from(reply.signature || '', 'base64'))) {
      return fail('bad-signature');
    }
  } catch (_) {
    return fail('bad-signature');
  }

  // Single-use LAST: only a fully-valid reply consumes the nonce; a replay of an
  // already-consumed nonce fails here instead of at nonce-mismatch.
  if (!deps.nonceStore.consume(reply.nonce)) return fail('nonce-replay');

  return { ok: true, reason: 'ok' };
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
    destinationHostAllowlisted: extra.destinationHostAllowlisted === true,
    command: extra.command || '',
    safetyLevel: extra.safetyLevel || '',
    safetyReason: extra.safetyReason || '',
    payloadPath: extra.payloadPath || '',
    intentMode: extra.intentMode || '',
    intentTarget: extra.intentTarget || '',
    intentShareText: extra.intentShareText || '',
    dmPairingId: extra.dmPairingId || '',
    dmPairingLabel: extra.dmPairingLabel || '',
    dmReplyText: extra.dmReplyText || '',
    appActRecipeId: extra.appActRecipeId || '',
    appActParamsResolved: extra.appActParamsResolved || '',
    // Project owner directive 2026-07-14 (see requireActionApprovalTap /
    // trustedNativeLowRiskAction above): real JSON booleans, not the "1"/"0"
    // strings the rest of this legacy string-map uses, so Kotlin's
    // JSONObject.optBoolean parses both this and the .sh executor's request
    // identically. Not covered by canonicalApprovalRequest's fixed field list
    // (dormant SIGNED_APPROVAL_ENABLED path) — acceptable, these are
    // executor-computed trust hints, not human-reviewable content.
    autoAccept: extra.autoAccept === true,
    autoFireTrusted: extra.autoFireTrusted === true,
    resultPath: resultFile,
    ts: new Date().toISOString(),
    expiresAt: Date.now() + Math.max(1, timeoutSeconds) * 1000,
    // Per-request single-use nonce (Tier A parity, lib/signed-approval/types.ts
    // ApprovalRequest.nonce). Written into the request regardless of
    // SIGNED_APPROVAL_ENABLED so a future signed reply can bind to it; the naive
    // equality path below ignores it entirely, so this is not a behavior change.
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  // 署名付き承認 (SIGNED-APPROVAL): request.requestSha256 is the sha256 of the
  // CANONICAL field encoding (canonicalApprovalRequest, the fixed-order tagged
  // array from lib/signed-approval/canonical.ts) -- NOT of the raw JSON file
  // bytes below. These are two DIFFERENT hashes of the same data for two
  // DIFFERENT consumers: this canonical hash is what a real signer would read
  // from the on-disk request and echo into SignedApprovalReply.requestSha256
  // (lib/signed-approval/types.ts: "sha256 hex of the canonical request, bound
  // into the reply"), and what verifySignedApprovalReply recomputes to check
  // self-consistency + reply-binding. Set BEFORE writeAtomic so a real signer's
  // on-disk view includes it; canonicalApprovalRequest() does not read this
  // field, so setting it here does not change what gets hashed. An earlier
  // version of this fix set request.requestSha256 to sha256File(requestFile)
  // (the FILE-BYTES hash used below by the unrelated naive-equality path) --
  // a structurally different value that would have made the signed-approval
  // accept-path self-DoS on every reply, valid or not. Found and corrected
  // before the flag was ever enabled -- see docs/superpowers/DEFERRED.md.
  request.requestSha256 = sha256Hex(canonicalApprovalRequest(request));
  writeAtomic(requestFile, JSON.stringify(request) + '\n');
  // Unrelated to the above: sha256 of the ACTUAL on-disk file bytes, used ONLY
  // by today's naive equality check a few lines down (`reply.requestSha256 !==
  // requestSha256`) -- untouched, byte-identical to pre-signed-approval
  // behavior. Native's reply-writer independently hashes whatever bytes it
  // reads back from this same file, so adding a field to the request object
  // before writing does not break that comparison (both sides hash the real
  // file, not a fixed shape).
  const requestSha256 = sha256File(requestFile);
  const nonceStore = SIGNED_APPROVAL_ENABLED ? makeSignedApprovalNonceStore() : null;
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

      if (SIGNED_APPROVAL_ENABLED) {
        // Migration step 2 (lib/signed-approval/wiring.ts): once enabled, EVERY
        // reply must carry a valid signature -- fail closed on any reply
        // missing sigAlg/signature/keySha256/nonce rather than falling through
        // to the naive equality check below. Without this explicit rejection,
        // an unsigned (or malformed-signature) reply would silently satisfy
        // the naive runId+requestSha256 check, completely defeating signed
        // approval the moment it's enabled. Dormant: SIGNED_APPROVAL_ENABLED is
        // false today, so this branch never executes in production.
        if (!reply || !reply.sigAlg || !reply.signature || !reply.keySha256 || !reply.nonce) {
          throw new ActionSkipped(`${actionType} action declined`);
        }
        ensureSignedApprovalVerifierKey(config, (event, fields) => appendJsonl(paths.planAuditFile, {
          ts: new Date().toISOString(),
          kind: 'plan.executor',
          event,
          agentId: plan.agent.id,
          ...fields,
        }));
        const result = verifySignedApprovalReply(request, reply, {
          publicKey: config.signedApprovalVerifierPublicKey,
          publicKeySha256: config.signedApprovalVerifierPublicKey ? config.signedApprovalPublicKeySha256 : '',
          expectedKeySha256: config.signedApprovalPublicKeySha256 || '',
          allowedSigAlgs: SIGNED_APPROVAL_ALLOWED_SIG_ALGS,
          nonceStore,
        });
        if (result.ok && reply.decision === 'accept') return;
        throw new ActionSkipped(`${actionType} action declined`);
      }

      // Naive equality check — reached ONLY when SIGNED_APPROVAL_ENABLED is
      // false (the signed branch above always returns/throws and never falls
      // through). Byte-identical to pre-signed-approval behavior.
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

// Project owner directive 2026-07-14: wraps requestActionApproval so
// draft/notify/webhook/cli can skip the round trip ENTIRELY when the
// resolved approval-mode is 'auto' (requireActionApprovalTap === false) — no
// request file is ever written, mirroring lib/agent-executor.ts's
// request_and_wait_approval (.sh executor) exactly, for the same reason: an
// unattended scheduled run must not depend on JS/native being alive to reply.
// intent/dm-reply/app-act are excluded from the skip — they only ever fire
// via RN/native (see each case's own comment in dispatchActionTrusted) — and
// always go through the full requestActionApproval; their own
// autoAccept/autoFireTrusted request fields (set by the caller via `details`)
// drive RN/native's auto-resolution instead.
function maybeRequestActionApproval(paths, plan, actionType, preview, resultFile, config, details) {
  if (actionType !== 'intent' && actionType !== 'dm-reply' && actionType !== 'app-act' && !requireActionApprovalTap(plan, config)) {
    return;
  }
  requestActionApproval(paths, plan, actionType, preview, resultFile, config, details);
}

function safeFilePart(value) {
  return String(value || '').slice(0, 160).replace(/[^A-Za-z0-9_.=-]/g, '_') || 'request';
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// Used by the signed-approval verifier (canonicalApprovalRequest hashing, DER
// key-pin hashing) below; sha256File above hashes file bytes, this hashes an
// already-in-memory string/Buffer.
function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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
    return u.hostname.toLowerCase();
  } catch (_) {
    return '';
  }
}

function webhookHostIsAllowlisted(host, config) {
  const candidate = String(host || '').trim().toLowerCase();
  return String(config.SHELLY_WEBHOOK_HOST_ALLOWLIST || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .includes(candidate);
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
  // app-act (2026-07-14, docs/superpowers/DEFERRED.md's "app-act Tier-B"
  // entry, resolved): the SAME registration-time consent draft/notify's
  // native fast-path already required (the Autonomous toggle itself) now
  // ALSO covers app-act, with one extra check below: the recipe id native
  // read from the freshly re-read persisted agent.json (--trusted-app-act-
  // recipe-id) must still match what THIS plan carries — defense-in-depth
  // against the plan diverging from the registered/consented recipe between
  // native's read and this executor's own read moments later.
  if (trustedAction !== 'draft' && trustedAction !== 'notify' && trustedAction !== 'app-act') return false;
  if (trustedAction !== actionType) return false;
  if (actionType === 'app-act') {
    const trustedRecipeId = String(args['trusted-app-act-recipe-id'] || '').trim();
    const planRecipeId = String((plan.action && plan.action.appActRecipeId) || '').trim();
    if (!trustedRecipeId || trustedRecipeId !== planRecipeId) return false;
  }
  // Widened 2026-07-14 (round 2) per project owner directive: chat-confirmed
  // agent.autonomous consent is the trust boundary, not the tool backend —
  // "たとえパープレだろうとCodexだろうと" (even Perplexity or Codex). Native
  // no longer restricts trustedTool to 'local' (see AgentRuntime.kt's
  // trustedPlanLaunch); a cloud tool still can't reach this point at all
  // unless autonomousCloudConsent was separately granted at script-generation
  // time (Spec A §4, lib/agent-executor.ts). We still require trustedTool to
  // agree with what THIS plan actually carries — defense-in-depth against the
  // plan's tool diverging from what native read moments earlier.
  return trustedTool !== '' && trustedTool === plan.tool.type;
}

function unattendedPreflightFailure(args, plan) {
  if (!argTruthy(args.unattended)) return '';
  const actionType = plan.action.type;
  if (actionType === '__suppressed__') return '';
  if (actionType !== 'draft' && actionType !== 'notify' && actionType !== 'app-act') {
    return `unsupported unattended PlanSpec action: ${actionType}`;
  }
  if (!trustedNativeLowRiskAction(args, plan, actionType)) {
    return `${actionType} action is not trusted for unattended PlanSpec execution`;
  }
  return '';
}

// Project owner directive 2026-07-14: resolves whether the mandatory
// "Runtime Review" approval TAP defaults on or off for THIS plan/action —
// independent of trustedNativeLowRiskAction (which governs whether the
// action may run unattended at all, and for app-act specifically whether it
// may auto-fire with no reply-waiter at all). plan.agent.requireActionApproval
// is the per-agent override baked at plan-build time (lib/agent-plan-spec.ts);
// config.SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL is the global default, read
// live from .env (settings-store.ts syncs it on every change) so toggling it
// applies to already-generated plans without needing an agent re-save.
function requireActionApprovalTap(plan, config) {
  if (typeof plan.agent.requireActionApproval === 'boolean') return plan.agent.requireActionApproval;
  return argTruthy(config.SHELLY_DEFAULT_REQUIRE_ACTION_APPROVAL);
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
  if (actionType !== 'draft' && actionType !== 'notify' && actionType !== 'webhook' && actionType !== 'cli' && actionType !== 'intent' && actionType !== 'dm-reply' && actionType !== 'app-act') {
    throw new PlanFailure(`unsupported PlanSpec action: ${actionType}`, { exitCode: EXIT.TOOL_DENY });
  }
  // app-act is deliberately EXCLUDED from this trust shortcut (unlike
  // draft/notify): its own case below always runs so it can still validate +
  // write an approval request carrying the resolved post content — trust
  // there only ever skips the human/JS WAIT (via autoFireTrusted, resolved by
  // native), never the request itself, because native still needs the
  // resolved params to actually fire the recipe. Trusting the shortcut here
  // the same way draft/notify do would silently report "success" without the
  // recipe ever having been dispatched.
  if (actionType !== 'app-act' && trustedNativeLowRiskAction(args, plan, actionType)) {
    appendJsonl(paths.planAuditFile, {
      ts: new Date().toISOString(),
      kind: 'plan.executor',
      event: 'action_trusted_allow',
      agentId: plan.agent.id,
      actionType,
      toolType: plan.tool.type,
    });
  } else {
    // Project owner directive 2026-07-14: draft/notify/webhook/cli skip the
    // approval request ENTIRELY when the resolved approval-mode is 'auto' —
    // no dependency on JS/native being alive to reply (unattended scheduled
    // runs must not block on that). intent/dm-reply always request (they can
    // only ever fire via RN) but pass autoAccept so RN resolves them without
    // a human tap. app-act always requests too, with its own narrower
    // autoFireTrusted flag (NOT governed by requireActionApprovalTap — see
    // that function's doc comment). maybeRequestActionApproval below
    // encapsulates the skip decision so every case's validation code is
    // unchanged either way.
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
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        destinationHost: host,
        destinationHostAllowlisted: webhookHostIsAllowlisted(host, config),
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
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
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
    if (actionType === 'intent') {
      const intentMode = String(plan.action.intentMode || '').trim();
      const intentTarget = String(plan.action.intentTarget || '').trim();
      if (intentMode !== 'launch' && intentMode !== 'share') {
        const message = 'Intent action has an invalid mode.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (intentMode === 'launch' && !intentTarget) {
        const message = 'Intent action is missing a launch target.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const resolvedShareText = String(plan.action.intentShareText || '').split('{{result}}').join(preview);
      if (intentMode === 'share' && !resolvedShareText.trim()) {
        const message = 'Intent action is missing share text.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        intentMode, intentTarget, intentShareText: resolvedShareText,
        // Attended-only (see unattendedPreflightFailure — intent is never
        // reached here when unattended). RN is always alive by construction,
        // so autoAccept just decides whether it shows the UI card or
        // resolves silently.
        autoAccept: !requireActionApprovalTap(plan, config),
      });
      // Side effect already happened in RN before the accept reply appeared —
      // no broker/native call here, unlike webhook/cli.
      return { status: 'success', preview };
    }
    if (actionType === 'dm-reply') {
      const dmPairingId = String(plan.action.dmPairingId || '').trim();
      if (!dmPairingId) {
        const message = 'DM-reply action is missing a paired conversation.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      let pairings;
      try { pairings = JSON.parse(readFile(paths.dmPairingsFile)); } catch (_) { pairings = null; }
      if (!Array.isArray(pairings)) {
        const message = 'Could not verify the DM-reply pairing.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const pairing = pairings.find((p) => p && typeof p === 'object' && p.id === dmPairingId);
      if (!pairing) {
        const message = 'DM-reply target is no longer paired.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (typeof pairing.revoked !== 'boolean' || typeof pairing.label !== 'string') {
        const message = 'Could not verify the DM-reply pairing.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      if (pairing.revoked) {
        const message = 'DM-reply target is no longer paired.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const dmReplyText = String(plan.action.dmReplyText || '').split('{{result}}').join(preview);
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        dmPairingId,
        dmPairingLabel: pairing.label,
        dmReplyText,
        // Attended-only, same reasoning as intent above.
        autoAccept: !requireActionApprovalTap(plan, config),
      });
      return { status: 'success', preview };
    }
    if (actionType === 'app-act') {
      // Unattended dispatch is refused upstream by unattendedPreflightFailure()
      // unless trustedNativeLowRiskAction(args, plan, 'app-act') passes (see
      // that function) -- this case still ALWAYS runs (app-act is excluded
      // from the outer trust shortcut above) so it can validate + write the
      // approval request carrying the resolved post content; autoFireTrusted
      // below tells native it may fire+reply itself with no human/JS wait.
      // Deliberately NOT governed by requireActionApprovalTap — see that
      // function's doc comment for why a blanket "skip the tap" default must
      // never alone unlock an external post.
      const recipeId = String(plan.action.appActRecipeId || '').trim();
      if (!recipeId) {
        const message = 'App-action is missing a recipe.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      const resolvedParams = resolveAppActParams(plan.action.appActParams, preview);
      if (Object.keys(resolvedParams).length === 0) {
        const message = 'App-action is missing its recipe parameters.';
        writeNotification(paths, plan, 'error', message);
        return { status: 'error', preview: message, errorMessage: message };
      }
      maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config, {
        appActRecipeId: recipeId,
        appActParamsResolved: JSON.stringify(resolvedParams),
        autoFireTrusted: trustedNativeLowRiskAction(args, plan, 'app-act'),
      });
      // Side effect already happened in RN before the accept reply appeared —
      // no broker/native call here, unlike webhook/cli (mirrors intent/dm-reply).
      return { status: 'success', preview };
    }
    maybeRequestActionApproval(paths, plan, actionType, preview, paths.resultFile, config);
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
    // Mirrors the legacy .sh executor's http_post_json, which always forwards
    // "${SHELLY_CAP_TAINTED:-0}" to the broker's --tainted flag. Native sets
    // this env var for notification-triggered (tainted) runs (see
    // AgentRuntime.kt's runPlanAgent) so classifyEgress's tainted-secret-spend
    // gate applies on the PlanSpec path too, not just the legacy .sh path.
    tainted: process.env.SHELLY_CAP_TAINTED === '1',
  };
  ensureDir(paths.tmpDir);
  ensureDir(paths.locksDir);
  ensureDir(paths.logDir);

  const config = parseConfigEnv(paths.envFile);
  // 署名付き承認 (SIGNED-APPROVAL) — Migration step 2 dormant wiring. Native does
  // not pass these flags yet (Migration step 1, AgentActionApprovalBridge signing,
  // is explicitly deferred), so these default to empty/unavailable. Harmless
  // while SIGNED_APPROVAL_ENABLED is false: ensureSignedApprovalVerifierKey /
  // verifySignedApprovalReply are only ever reached from that dormant branch.
  config.signedApprovalPublicKeyPath = args['signed-approval-public-key'] || '';
  config.signedApprovalPublicKeySha256 = args['signed-approval-public-key-sha256'] || '';
  config.allowUnpinnedSignedApprovalVerifierKey = argTruthy(args['allow-unpinned-signed-approval-verifier-key']);
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

  // Each run opens a fresh CAP-001 egress budget envelope. The broker's budget file
  // (cap-budget-<agentId>.json) is keyed per-agent and persists across runs; without
  // this reset the wall-time budget is measured from the first-ever run, so every run
  // spuriously fails rc=42 "wall-time budget exhausted" ~10 min after the first
  // (found in device-verify). The .sh path already rm's it at run start; mirror it.
  try {
    fs.rmSync(path.join(paths.tmpDir, `cap-budget-${plan.agent.id}.json`), { force: true });
  } catch (_) {}

  try {
    const request = modelRequest(plan, config);
    const response = brokerHttp(paths, opts, plan, request);
    let resultText = extractModelContent(plan.tool.type, response);
    // G6: hard-clamp to the PlanSpec's char budget (if any) before it lands in
    // either the agent-result sidecar or a dispatched draft — the confirm
    // card's "final output hard limit" promise must hold on-device, not just
    // as a soft instruction baked into the model prompt.
    resultText = enforcePlanCharLimit(plan, resultText);
    writeAtomic(paths.resultFile, resultText + (resultText.endsWith('\n') || resolveCharLimit(plan) ? '' : '\n'));
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
  // 署名付き承認 (SIGNED-APPROVAL) Migration step 2 — exported for host unit tests
  // only (see __tests__/plan-executor-signed-approval.test.ts). Not part of the
  // executor's CLI surface; SIGNED_APPROVAL_ENABLED gates all production use.
  SIGNED_APPROVAL_ENABLED,
  SIGNED_APPROVAL_ALLOWED_SIG_ALGS,
  canonicalApprovalRequest,
  approvalReplySignatureMessage,
  verifySignedApprovalReply,
  makeSignedApprovalNonceStore,
  ensureSignedApprovalVerifierKey,
  // Project owner directive 2026-07-14 (runtime approval default-off) —
  // exported for host unit tests only (see
  // __tests__/plan-executor-approval-default.test.ts), same convention as
  // the signed-approval exports above. Not part of the executor's CLI surface.
  trustedNativeLowRiskAction,
  unattendedPreflightFailure,
  requireActionApprovalTap,
};
