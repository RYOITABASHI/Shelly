#!/usr/bin/env node
/*
 * shelly-capability-broker.js — CAP-001 / SECRET-001 / HTTP-001 runtime broker.
 *
 * Phase 0 「床」of the L1/L2 Capability Catalog
 * (docs/superpowers/specs/2026-07-01-l1-l2-capability-catalog.md). The generated
 * agent .sh funnels every secret-bearing remote request through http_post_json;
 * when SHELLY_CAP_BROKER=1 that function delegates the actual send to this broker
 * instead of building `Authorization: Bearer $KEY` inline. The broker:
 *   - HTTP-001: enforces the egress allowlist; a non-allowlist host is fail-closed
 *     (blocked) unless --approved 1 was passed by an already-approved call site.
 *   - SECRET-001: resolves an opaque --auth-ref to a real header by reading the
 *     .env file ITSELF; the raw value never returns to the shell or rides in argv.
 *     A ref is bound to one host, so a mis-routed URL cannot exfiltrate the key.
 *   - CAP-001: enforces a per-run call/wall-time budget, and appends a REDACTED
 *     audit line per attempt (host/path/ref-name/verdict/status — never the value).
 *
 * The classification constants below MIRROR lib/capability-envelope.ts; the
 * capability-broker-parity test keeps them in lock-step (same pattern as the
 * shelly-agent-driver asset parity guard).
 *
 * Exit codes (distinct from the http_post_json 0/22/23 contract this preserves):
 *   0   success (HTTP <400)
 *   22  permanent HTTP failure (4xx other than 429)
 *   23  transient HTTP failure (429 / 5xx / network / timeout)
 *   40  denied by policy (bad URL / secret bound to another host)
 *   41  non-allowlist host requires approval (fail-closed; not pre-approved)
 *   42  budget exhausted
 *   43  auth_ref could not be resolved (missing/empty secret)
 *   44  usage error
 *   127 internal error
 */

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');

// ---------------------------------------------------------------------------
// Mirror of lib/capability-envelope.ts — keep in sync (parity-tested).
// ---------------------------------------------------------------------------

const AUTH_REFS = {
  perplexity: { envVar: 'PERPLEXITY_API_KEY', header: 'Authorization', scheme: 'Bearer ', host: 'api.perplexity.ai' },
  gemini: { envVar: 'GEMINI_API_KEY', header: 'x-goog-api-key', scheme: '', host: 'generativelanguage.googleapis.com' },
  cerebras: { envVar: 'CEREBRAS_API_KEY', header: 'Authorization', scheme: 'Bearer ', host: 'api.cerebras.ai' },
  groq: { envVar: 'GROQ_API_KEY', header: 'Authorization', scheme: 'Bearer ', host: 'api.groq.com' },
};

const EGRESS_ALLOWLIST = [
  'api.perplexity.ai',
  'generativelanguage.googleapis.com',
  'api.cerebras.ai',
  'api.groq.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'github.com',
  '127.0.0.1',
  'localhost',
];

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost'];

const DEFAULT_BUDGET = { maxCalls: 40, maxWallMs: 10 * 60 * 1000 };

const EXIT = {
  OK: 0,
  HTTP_PERMANENT: 22,
  HTTP_TRANSIENT: 23,
  DENY: 40,
  APPROVAL_REQUIRED: 41,
  BUDGET: 42,
  NO_SECRET: 43,
  USAGE: 44,
  INTERNAL: 127,
};

// Redaction for the free-text `reason`/error fields (defence-in-depth in case an
// upstream error body echoes a token). Mirrors lib/redact-secrets.ts's shape.
const REDACT_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{25,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{20,}\b/g,
  /\bcsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi,
];

function redact(text) {
  let out = String(text == null ? '' : text);
  for (const p of REDACT_PATTERNS) out = out.replace(p, '<redacted>');
  return out;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch (_) {
    return null;
  }
}

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.indexOf(host) !== -1;
}

function isAllowlistedHost(host) {
  return EGRESS_ALLOWLIST.indexOf(host) !== -1;
}

/**
 * The CAP-001 §4.3 structural rule. Returns { decision, reason, signals }.
 *   decision: 'allow' | 'approve' | 'deny'
 *
 * Tainted input plus a live secret, even against an allowlisted and
 * correctly-bound host, also requires approval: host-binding only guards
 * WHERE a secret can go, not WHAT gets said with it — untrusted content could
 * still direct the agent to spend a legitimate secret on an attacker-chosen
 * payload at a legitimate destination (e.g. a poisoned notification tricking
 * the agent into posting attacker text to our own Slack webhook).
 */
function classifyEgress(url, authRef, tainted) {
  const signals = [];
  const host = hostFromUrl(url);
  let scheme = null;
  try {
    scheme = new URL(url).protocol;
  } catch (_) {
    scheme = null;
  }
  if (!host || scheme === null) {
    return { decision: 'deny', reason: 'unparseable URL', signals: ['insecure-scheme'] };
  }
  if (scheme !== 'https:' && !(scheme === 'http:' && isLoopbackHost(host))) {
    return { decision: 'deny', reason: 'insecure scheme ' + scheme + ' for host ' + host, signals: ['insecure-scheme'] };
  }
  if (authRef) {
    signals.push('secret-spend');
    const spec = AUTH_REFS[authRef];
    if (!spec) {
      return { decision: 'deny', reason: 'unknown auth_ref "' + authRef + '"', signals: signals };
    }
    if (host !== spec.host) {
      signals.push('ref-host-mismatch');
      return { decision: 'deny', reason: 'auth_ref "' + authRef + '" is bound to ' + spec.host + ', not ' + host, signals: signals };
    }
  }
  if (tainted) signals.push('tainted');
  if (!isAllowlistedHost(host)) {
    signals.push('non-allowlist-host');
    return { decision: 'approve', reason: 'host ' + host + ' is not on the egress allowlist', signals: signals };
  }
  if (tainted && authRef) {
    signals.push('tainted-secret-spend');
    return { decision: 'approve', reason: 'tainted input plus a live secret "' + authRef + '" to ' + host + ' requires human approval', signals: signals };
  }
  return { decision: 'allow', reason: 'host ' + host + ' is allowlisted', signals: signals };
}

// ---------------------------------------------------------------------------
// .env parsing (secret-by-reference resolution — SECRET-001)
// ---------------------------------------------------------------------------

// The agent .env is written by settings-store as KEY='value' (bash single-quoted,
// with ' escaped as '\''), one per line, NOT exported. So a child node process
// does not inherit these — the broker must read the file itself. That is the
// point: the raw secret never becomes an environment variable a sibling skill can
// read via /proc, and never rides in this process's argv.
function parseEnvFile(filePath) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return out;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    key = key.replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
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

// ---------------------------------------------------------------------------
// Budget accounting (CAP-001)
// ---------------------------------------------------------------------------

function loadBudgetState(budgetFile, nowMs) {
  try {
    const parsed = JSON.parse(fs.readFileSync(budgetFile, 'utf8'));
    if (parsed && typeof parsed.calls === 'number' && typeof parsed.startedAtMs === 'number') {
      return { calls: parsed.calls, startedAtMs: parsed.startedAtMs };
    }
  } catch (_) {
    /* first call / unreadable → fresh envelope */
  }
  return { calls: 0, startedAtMs: nowMs };
}

function saveBudgetState(budgetFile, state) {
  try {
    fs.writeFileSync(budgetFile, JSON.stringify(state));
  } catch (_) {
    /* best-effort; a lost counter fails safe on the next read (fresh, still capped) */
  }
}

function checkBudget(state, budget, nowMs) {
  if (state.calls >= budget.maxCalls) {
    return { ok: false, reason: 'call budget exhausted (' + state.calls + '/' + budget.maxCalls + ')' };
  }
  const elapsed = nowMs - state.startedAtMs;
  if (elapsed >= budget.maxWallMs) {
    return { ok: false, reason: 'wall-time budget exhausted (' + elapsed + 'ms/' + budget.maxWallMs + 'ms)' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Audit (CAP-001 redacted)
// ---------------------------------------------------------------------------

function appendAudit(auditFile, entry) {
  if (!auditFile) return;
  try {
    fs.appendFileSync(auditFile, JSON.stringify(entry) + '\n');
  } catch (_) {
    /* best-effort */
  }
}

function buildAudit(nowIso, method, url, authRef, tainted, verdict, extra) {
  let host = '<unparseable>';
  let path = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    path = u.pathname; // query dropped on purpose (may carry ?key=…)
  } catch (_) {
    /* keep placeholders */
  }
  const entry = {
    ts: nowIso,
    kind: 'http.request',
    method: (method || 'GET').toUpperCase(),
    host: host,
    path: path,
    authRef: authRef || null,
    tainted: tainted === true,
    decision: verdict.decision,
    signals: verdict.signals,
    reason: redact(verdict.reason),
  };
  if (extra) {
    if (typeof extra.status === 'number') entry.status = extra.status;
    if (typeof extra.ok === 'boolean') entry.ok = extra.ok;
    if (extra.reason) entry.reason = redact(extra.reason);
  }
  return entry;
}

// ---------------------------------------------------------------------------
// HTTP send (mirrors the http_post_json node contract in agent-executor.ts)
// ---------------------------------------------------------------------------

function sendRequest(opts, cb) {
  // opts: { method, url, bodyBuf, headers, timeoutSeconds, outFd, errFd }
  let url;
  try {
    url = new URL(opts.url);
  } catch (e) {
    fs.writeSync(opts.errFd, 'invalid URL\n');
    return cb(EXIT.INTERNAL);
  }
  const isHttps = url.protocol === 'https:';
  const client = isHttps ? https : http;
  const headers = Object.assign({}, opts.headers);
  if (opts.bodyBuf) {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(opts.bodyBuf.length);
  }
  const req = client.request(
    {
      method: opts.method,
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      headers: headers,
    },
    (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        try {
          fs.writeSync(opts.outFd, chunk);
        } catch (_) {}
      });
      res.on('end', () => {
        const code = res.statusCode || 0;
        let exit;
        if (code < 400) exit = EXIT.OK;
        else if (code === 429 || code >= 500) exit = EXIT.HTTP_TRANSIENT;
        else exit = EXIT.HTTP_PERMANENT;
        cb(exit, code);
      });
    },
  );
  req.on('error', (err) => {
    try {
      fs.writeSync(opts.errFd, redact(err && err.message ? err.message : String(err)) + '\n');
    } catch (_) {}
    cb(EXIT.HTTP_TRANSIENT, 0);
  });
  const timeoutSeconds = Number(opts.timeoutSeconds || 0);
  if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    req.setTimeout(timeoutSeconds * 1000, () => {
      req.destroy(new Error('request timed out'));
    });
  }
  if (opts.bodyBuf) req.write(opts.bodyBuf);
  req.end();
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.slice(0, 2) === '--') {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.slice(0, 2) === '--') {
        args[key] = '1';
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const method = (args.method || 'POST').toUpperCase();
  const url = args.url || '';
  const authRef = args['auth-ref'] || '';
  const tainted = args.tainted === '1';
  const approved = args.approved === '1';
  const envFile = args['secret-env-file'] || '';
  const auditFile = args['audit-log'] || '';
  const budgetFile = args['budget-file'] || '';
  const outFile = args.out || '';
  const errFile = args.err || '';
  const bodyFile = args['body-file'] || '';
  const timeoutSeconds = args['timeout-seconds'] || '30';

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  if (!url || !outFile || !errFile) {
    process.stderr.write('usage: --url <u> --out <f> --err <f> [--method] [--body-file] [--auth-ref] [--tainted 0|1] [--approved 0|1] [--secret-env-file] [--audit-log] [--budget-file] [--timeout-seconds]\n');
    process.exit(EXIT.USAGE);
  }

  let outFd;
  let errFd;
  try {
    outFd = fs.openSync(outFile, 'w');
    errFd = fs.openSync(errFile, 'w');
  } catch (e) {
    process.stderr.write('cannot open out/err files\n');
    process.exit(EXIT.INTERNAL);
  }

  const finish = (code, verdict, extra) => {
    appendAudit(auditFile, buildAudit(nowIso, method, url, authRef, tainted, verdict, extra));
    try {
      fs.closeSync(outFd);
    } catch (_) {}
    try {
      fs.closeSync(errFd);
    } catch (_) {}
    process.exit(code);
  };

  // 1. Structural classification.
  const verdict = classifyEgress(url, authRef, tainted);
  if (verdict.decision === 'deny') {
    fs.writeSync(errFd, 'capability broker: ' + redact(verdict.reason) + '\n');
    return finish(EXIT.DENY, verdict);
  }
  if (verdict.decision === 'approve' && !approved) {
    // Fail-closed: a non-allowlist host is blocked unless the call site already
    // obtained a human approval (the webhook action path does, and passes
    // --approved 1). Interactive mid-run egress approval is a Phase-0 follow-up.
    fs.writeSync(errFd, 'capability broker: ' + redact(verdict.reason) + ' (egress blocked — not approved)\n');
    return finish(EXIT.APPROVAL_REQUIRED, verdict);
  }

  // 2. Budget (fail-closed).
  const budgetState = loadBudgetState(budgetFile, nowMs);
  const budgetVerdict = checkBudget(budgetState, DEFAULT_BUDGET, nowMs);
  if (!budgetVerdict.ok) {
    fs.writeSync(errFd, 'capability broker: ' + budgetVerdict.reason + '\n');
    return finish(EXIT.BUDGET, verdict, { reason: budgetVerdict.reason });
  }

  // 3. Secret-by-reference resolution (inside the broker only).
  const headers = {};
  if (authRef) {
    const spec = AUTH_REFS[authRef]; // classifyEgress already validated existence + host binding
    const env = envFile ? parseEnvFile(envFile) : {};
    const value = env[spec.envVar];
    if (!value) {
      const reason = 'auth_ref "' + authRef + '" has no configured secret (' + spec.envVar + ')';
      fs.writeSync(errFd, 'capability broker: ' + reason + '\n');
      return finish(EXIT.NO_SECRET, verdict, { reason: reason });
    }
    headers[spec.header] = spec.scheme + value;
  }

  // 4. Body (POST) and send.
  let bodyBuf = null;
  if (method !== 'GET' && bodyFile) {
    try {
      bodyBuf = fs.readFileSync(bodyFile);
    } catch (e) {
      fs.writeSync(errFd, 'capability broker: cannot read body file\n');
      return finish(EXIT.INTERNAL, verdict);
    }
  }

  // Count the call against the budget BEFORE sending (fail-closed: a crash mid-send
  // still consumed the slot). NOTE: http_post_json_retry re-invokes the broker once
  // per transient retry, so each retry counts as a separate egress here — intended,
  // since a retry IS a real outbound request; the budget caps actual egress, not
  // logical calls.
  budgetState.calls += 1;
  saveBudgetState(budgetFile, budgetState);

  try {
    sendRequest(
      {
        method: method,
        url: url,
        bodyBuf: bodyBuf,
        headers: headers,
        timeoutSeconds: timeoutSeconds,
        outFd: outFd,
        errFd: errFd,
      },
      (code, status) => {
        finish(code, verdict, { status: status, ok: code === EXIT.OK });
      },
    );
  } catch (e) {
    const reason = e && e.message ? e.message : String(e);
    try {
      fs.writeSync(errFd, 'capability broker: ' + redact(reason) + '\n');
    } catch (_) {}
    return finish(EXIT.HTTP_TRANSIENT, verdict, { status: 0, ok: false, reason: reason });
  }
}

main();
